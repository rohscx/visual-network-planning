"""Pure IPv4 planning logic built on stdlib `ipaddress`.

All functions here are side-effect-free and take/return plain data. The Flask
layer is a thin wrapper that loads a Plan, calls these, and saves it back.
"""

from __future__ import annotations

import ipaddress
from functools import lru_cache
from typing import Iterable

from .models import Allocation, Plan

IPv4Net = ipaddress.IPv4Network


@lru_cache(maxsize=65536)
def parse(cidr: str) -> IPv4Net:
    """Parse a CIDR, normalizing host bits (strict=False).

    Cached: the same few hundred plan CIDRs get re-parsed by every
    build_tree / find_conflicts / validate_new_allocation call, and
    IPv4Network construction is the single hottest operation in profile.
    IPv4Network is immutable, so sharing instances across callers is safe.
    """
    return ipaddress.IPv4Network(cidr, strict=False)


def parse_strict(cidr: str) -> IPv4Net:
    """Parse user input; reject misaligned CIDRs (host bits set)."""
    return ipaddress.IPv4Network(cidr, strict=True)


def _free_space(parent: IPv4Net, used: list[IPv4Net]) -> list[IPv4Net]:
    """Compute free ranges inside `parent` given any set of used blocks.

    Pre-filters `used` to the topmost blocks (drops any that are strict
    sub-networks of another used block and anything outside `parent`), so the
    caller can pass the full allocation list without curating it first.
    """
    inside = [u for u in used if u.subnet_of(parent)]
    if any(u == parent for u in inside):
        return []
    topmost: list[IPv4Net] = []
    for u in inside:
        if any(u != v and u.subnet_of(v) for v in inside):
            continue
        topmost.append(u)

    ranges: list[IPv4Net] = [parent]
    for u in topmost:
        new_ranges: list[IPv4Net] = []
        for r in ranges:
            if u == r:
                continue
            if u.subnet_of(r):
                new_ranges.extend(list(r.address_exclude(u)))
            else:
                new_ranges.append(r)
        ranges = new_ranges
    ranges.sort(key=lambda n: (int(n.network_address), n.prefixlen))
    return ranges


def free_space(parent_cidr: str, used_cidrs: Iterable[str]) -> list[str]:
    parent = parse(parent_cidr)
    used = [parse(c) for c in used_cidrs]
    return [str(n) for n in _free_space(parent, used)]


def build_tree(plan: Plan) -> dict:
    """Compute the nested tree from a flat Plan.

    Returns:
        {
            "roots": [node, ...],      # one per supernet (top-level)
            "orphans": [dict, ...],    # allocations not contained in any supernet
        }

    Each node:
        {
            "cidr", "name", "description", "tags",
            "kind": "supernet" | "allocation" | "reservation",
            "is_supernet": bool,        # legacy alias for kind == "supernet"
            "is_reservation": bool,     # convenience alias for kind == "reservation"
            "children": [node, ...],
            "free": [cidr_str, ...],   # free ranges directly under this node
            "total_addresses": int,
            "used_addresses": int,     # sum of direct children (incl. reservations)
            "free_addresses": int,     # carve-eligible free space across the subtree
        }
    used_addresses measures coverage by declared direct children, not utilization.
    free_addresses sums direct gaps and descendant free space, excluding leaf
    allocations and entire reservation subtrees; utilization is total minus free.
    """
    supernets = [(s, parse(s.cidr), "supernet") for s in plan.supernets]
    allocs = [(a, parse(a.cidr), "allocation") for a in plan.allocations]
    reservs = [(r, parse(r.cidr), "reservation") for r in plan.reservations]
    all_nodes = supernets + allocs + reservs

    # Parent assignment via a sorted containment sweep — O(N log N) rather
    # than the naive all-pairs subnet_of scan (O(N²), ~460k calls at 700
    # nodes, which dominated every plan.json fetch).
    #
    # Aligned CIDRs form a laminar family: sorted by (network address,
    # prefixlen), a block's deepest container is always on a stack of
    # currently-open enclosing blocks. Identical nets (duplicates) sort
    # adjacent; neither may parent the other, so the parent walk skips
    # stack entries with the same extent.
    starts = [int(net.network_address) for _, net, _ in all_nodes]
    ends = [int(net.broadcast_address) for _, net, _ in all_nodes]
    order = sorted(range(len(all_nodes)), key=lambda i: (starts[i], all_nodes[i][1].prefixlen))

    parent_of: list[int | None] = [None] * len(all_nodes)
    stack: list[int] = []  # indices of open blocks, outermost → innermost
    for i in order:
        while stack and ends[i] > ends[stack[-1]]:
            stack.pop()
        # Deepest strict container: skip equal-extent entries (duplicates).
        parent = None
        for k in range(len(stack) - 1, -1, -1):
            j = stack[k]
            if starts[j] == starts[i] and ends[j] == ends[i]:
                continue
            parent = j
            break
        parent_of[i] = parent
        stack.append(i)

    # Children accumulate in sweep order, which IS (address, prefixlen)
    # order — no per-node re-sort (the old code re-parsed every child's
    # CIDR string twice inside the sort key).
    children_of: list[list[int]] = [[] for _ in all_nodes]
    for i in order:
        p = parent_of[i]
        if p is not None:
            children_of[p].append(i)

    def make_node(i: int) -> dict:
        rec, net, kind = all_nodes[i]
        direct_nets = [all_nodes[c][1] for c in children_of[i]]
        children = [make_node(c) for c in children_of[i]]
        free = _free_space(net, direct_nets)
        used_addresses = sum(c.num_addresses for c in direct_nets)
        free_addresses = 0
        if kind != "reservation" and (kind == "supernet" or children):
            free_addresses = (sum(f.num_addresses for f in free)
                              + sum(c["free_addresses"] for c in children))
        return {
            "cidr": str(net),
            "name": rec.name,
            "description": rec.description,
            "tags": list(rec.tags),
            "kind": kind,
            "is_supernet": kind == "supernet",
            "is_reservation": kind == "reservation",
            "children": children,
            "free": [str(f) for f in free],
            "total_addresses": net.num_addresses,
            "used_addresses": used_addresses,
            "free_addresses": free_addresses,
        }

    # Iterating `order` keeps roots in (address, prefixlen) order for free.
    roots = [
        make_node(i)
        for i in order
        if all_nodes[i][2] == "supernet" and parent_of[i] is None
    ]

    # Orphans keep original plan-file order (allocations then reservations).
    orphans = [
        all_nodes[i][0].to_dict()
        for i, (_, _, kind) in enumerate(all_nodes)
        if kind != "supernet" and parent_of[i] is None
    ]
    return {"roots": roots, "orphans": orphans}


def _all_owned_pairs(plan: Plan):
    """All (cidr, parsed) pairs the plan tracks, regardless of kind."""
    return ([(s.cidr, parse(s.cidr)) for s in plan.supernets]
            + [(a.cidr, parse(a.cidr)) for a in plan.allocations]
            + [(r.cidr, parse(r.cidr)) for r in plan.reservations])


def find_conflicts(plan: Plan) -> list[tuple[str, str]]:
    """Pairs of CIDRs that resolve to the same network (exact duplicates).

    Partial overlaps cannot occur here: parse() normalizes every CIDR to
    an aligned network (host bits cleared), and two aligned networks are
    always either disjoint or nested — so after normalization the only
    reachable conflict is two entries resolving to the same network
    (e.g. the same CIDR present in two buckets, or "10.0.0.0/24" and a
    hand-edited "10.0.0.1/24" that normalizes to it). Grouping by parsed
    network finds those in O(N) instead of the old O(N²) pairwise scan.
    """
    by_net: dict[IPv4Net, list[str]] = {}
    for cidr, net in _all_owned_pairs(plan):
        by_net.setdefault(net, []).append(cidr)
    out: list[tuple[str, str]] = []
    for group in by_net.values():
        if len(group) > 1:
            out.extend(
                (group[i], group[j])
                for i in range(len(group))
                for j in range(i + 1, len(group))
            )
    return out


def find_orphans(plan: Plan) -> list[str]:
    """Allocations or reservations not contained in any supernet."""
    supers = [parse(s.cidr) for s in plan.supernets]
    out: list[str] = []
    for rec in (*plan.allocations, *plan.reservations):
        net = parse(rec.cidr)
        if not any(net.subnet_of(s) for s in supers):
            out.append(rec.cidr)
    return out


def carve(
    parent_cidr: str,
    existing_cidrs: Iterable[str],
    *,
    prefix_length: int | None = None,
    host_count: int | None = None,
    count: int | None = None,
) -> list[str]:
    """Suggest CIDR(s) to carve from `parent_cidr`'s free space.

    Exactly one mode:
      * prefix_length — first free slot of that prefix
      * host_count    — smallest prefix that fits `host_count` usable hosts
                        (allowing network+broadcast), then first free slot
      * count         — split parent into `count` equal subnets (power of 2,
                        parent must be entirely free)
    """
    supplied = sum(x is not None for x in (prefix_length, host_count, count))
    if supplied != 1:
        raise ValueError("Provide exactly one of prefix_length, host_count, count")

    parent = parse(parent_cidr)
    # Callers typically pass *all* plan CIDRs including the parent itself
    # (which represents existence, not consumption); filter it out.
    used_nets = [net for net in map(parse, existing_cidrs) if net != parent]
    free = _free_space(parent, used_nets)

    if count is not None:
        if len(free) != 1 or free[0] != parent:
            return []
        if count < 1:
            return []
        bits = (count - 1).bit_length()
        if (1 << bits) != count:
            return []
        new_prefix = parent.prefixlen + bits
        if new_prefix > 32:
            return []
        return [str(s) for s in parent.subnets(new_prefix=new_prefix)]

    if host_count is not None:
        if host_count < 1:
            return []
        need = host_count + 2
        p = 32
        while p >= 0 and (1 << (32 - p)) < need:
            p -= 1
        if p < 0:
            return []
        prefix_length = p

    if prefix_length is None or prefix_length < parent.prefixlen or prefix_length > 32:
        return []
    for f in free:
        if f.prefixlen <= prefix_length:
            first = next(f.subnets(new_prefix=prefix_length))
            return [str(first)]
    return []


def validate_new_allocation(plan: Plan, new_cidr: str) -> tuple[bool, str]:
    """Reject partial overlaps and exact duplicates; allow strict containment.

    Checks against supernets, allocations, AND reservations — a new entry that
    duplicates or partially overlaps any existing entry of any kind is
    rejected.
    """
    try:
        new_net = parse(new_cidr)
    except ValueError as e:
        return False, f"Invalid CIDR: {e}"
    for s in plan.supernets:
        sn = parse(s.cidr)
        if new_net == sn:
            return False, f"Duplicate of existing supernet {s.cidr}"
        if new_net.overlaps(sn) and not new_net.subnet_of(sn) and not sn.subnet_of(new_net):
            return False, f"Partial overlap with supernet {s.cidr}"
    for a in plan.allocations:
        an = parse(a.cidr)
        if an == new_net:
            return False, f"Duplicate of existing allocation {a.cidr}"
        if new_net.overlaps(an) and not new_net.subnet_of(an) and not an.subnet_of(new_net):
            return False, f"Partial overlap with allocation {a.cidr}"
    for r in plan.reservations:
        rn = parse(r.cidr)
        if rn == new_net:
            return False, f"Duplicate of existing reservation {r.cidr}"
        if new_net.overlaps(rn) and not new_net.subnet_of(rn) and not rn.subnet_of(new_net):
            return False, f"Partial overlap with reservation {r.cidr}"
    return True, ""


def _request_records(plan: Plan) -> list[tuple[Allocation, IPv4Net, str]]:
    records = [(record, kind) for kind, bucket in (
        ('supernet', plan.supernets), ('allocation', plan.allocations),
        ('reservation', plan.reservations)) for record in bucket]
    return [(record, net, kind) for (record, kind), (_, net)
            in zip(records, _all_owned_pairs(plan))]


def _request_parent(records, parent):
    matches = [(r, n, k) for r, n, k in records if n == parent]
    reserved = [(r, n, k) for r, n, k in records
                if k == 'reservation' and parent.subnet_of(n)]
    if reserved:
        return 'parent_is_reservation', 'reserved_parent', 'Parent is a reservation or inside one', reserved
    if not matches:
        return 'parent_not_found', 'missing_parent', 'Parent does not exist in this snapshot', []
    if len(matches) > 1:
        return 'conflicts_existing', 'conflict', 'Multiple records resolve to this parent', matches
    _, _, kind = matches[0]
    if kind == 'allocation' and (
        not any(parent != n and parent.subnet_of(n) and k == 'supernet' for _, n, k in records)
        or not any(n != parent and n.subnet_of(parent) for _, n, _ in records)
    ):
        return 'will_not_fit', 'capacity', 'Parent is an occupied leaf or orphan allocation', matches
    return None


def request_parent_inventory(plan: Plan) -> tuple[list[dict], list[dict]]:
    records = _request_records(plan)
    parents, warnings, seen = [], [], set()
    for rec, net, kind in records:
        if net in seen:
            continue
        seen.add(net)
        issue = _request_parent(records, net)
        if issue:
            warnings.append(dict(code=issue[1], cidr=str(net), message=issue[2]))
            continue
        free = _free_space(net, [n for _, n, _ in records if n != net])
        if free:
            parents.append(dict(cidr=str(net), name=rec.name, kind=kind,
                                direct_free_cidrs=list(map(str, free)),
                                direct_free_addresses=sum(n.num_addresses for n in free),
                                largest_free_cidr=str(max(free, key=lambda n: n.num_addresses))))
    return parents, warnings


def simulate_carve_request(plan: Plan, document: dict, max_allocations: int) -> dict:
    """Simulate a normalized, bounded request without mutating any input record."""
    import re

    expansion = sum(len(i['parents']) * i['repeat'] * i.get('count', 1) for i in document['items'])
    if expansion > max_allocations:
        raise ValueError('Request expansion exceeds allocation cap')
    working = Plan.from_dict(plan.to_dict())
    original = _request_records(plan)
    counters, results = {}, []
    for item in document['items']:
        mode = next(k for k in ('prefix_length', 'host_count', 'count') if k in item)
        for parent_index, cidr in enumerate(item['parents']):
            parent = parse(cidr)
            issue = _request_parent(original, parent)
            for iteration in range(item['repeat']):
                result = dict(item_id=item['id'], parent=cidr, iteration=iteration + 1,
                              status='will_succeed', reason_code=None, message='', conflicts=[], proposals=[])
                failure = issue
                if not failure:
                    used = [n for _, n in _all_owned_pairs(working) if n != parent]
                    free = _free_space(parent, used)
                    proposed = carve(cidr, [c for c, _ in _all_owned_pairs(working)], **{mode: item[mode]})
                    if not proposed:
                        message = 'No aligned free slot of the requested size fits (capacity or fragmentation)'
                        if mode == 'count':
                            message = 'Equal split requires an entirely empty parent and enough addresses'
                        elif mode == 'prefix_length' and item[mode] < parent.prefixlen:
                            message = 'Requested prefix is larger than the parent'
                        failure = ('will_not_fit', 'capacity', message, [])
                    else:
                        trial = Plan.from_dict(working.to_dict())
                        parent_record = next(r for r, n, _ in original if n == parent)
                        for child_index, child in enumerate(proposed):
                            ok, message = validate_new_allocation(trial, child)
                            if not ok:
                                conflicts = [(r, n, k) for r, n, k in _request_records(trial) if n == parse(child)]
                                failure = ('conflicts_existing', 'conflict', message, conflicts)
                                break
                            if not any(parse(child).subnet_of(f) for f in free):
                                failure = ('will_not_fit', 'capacity', 'Proposal is outside direct free space', [])
                                break
                            number = counters.get(cidr, 0) + child_index + 1
                            label = re.sub(r'\{(parent|n)\}', lambda m: (parent_record.name or cidr)
                                           if m[1] == 'parent' else str(number), item['name_template'])
                            proposal = dict(id=f"{item['id']}:{parent_index}:{iteration}:{child_index}",
                                            parent=cidr, cidr=child, name=label,
                                            tags=list(item['tags']), description=item['description'])
                            result['proposals'].append(proposal)
                            trial.allocations.append(Allocation(child, label, item['description'], list(item['tags'])))
                        if not failure:
                            working = trial
                            counters[cidr] = counters.get(cidr, 0) + len(proposed)
                            noun = 'subnet' if len(proposed) == 1 else 'subnets'
                            result['message'] = f'{len(proposed)} {noun} fit'
                if failure:
                    result.update(status=failure[0], reason_code=failure[1], message=failure[2], proposals=[],
                                  conflicts=[dict(kind=k, cidr=str(n), name=r.name) for r, n, k in failure[3]])
                results.append(result)
    successes = sum(r['status'] == 'will_succeed' for r in results)
    return dict(results=results, summary=dict(attempts=len(results), successful_attempts=successes,
                failed_attempts=len(results) - successes,
                proposed_allocations=sum(len(r['proposals']) for r in results), all_fit=successes == len(results)))
