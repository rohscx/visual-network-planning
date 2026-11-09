from __future__ import annotations

import pytest

from app.models import Allocation, Plan  # noqa: F401
from app.planning import (
    build_tree, carve, find_conflicts, find_orphans, free_space,
    parse_strict, validate_new_allocation,
)


def _plan(supernets=(), allocations=(), reservations=()):
    return Plan(
        name="t",
        supernets=[Allocation(cidr=c, name=n) for c, n in supernets],
        allocations=[Allocation(cidr=c, name=n) for c, n in allocations],
        reservations=[Allocation(cidr=c, name=n) for c, n in reservations],
    )


# --- free_space --------------------------------------------------------------

def test_free_space_empty_parent():
    assert free_space("10.0.0.0/24", []) == ["10.0.0.0/24"]


def test_free_space_exact_consumed():
    assert free_space("10.0.0.0/24", ["10.0.0.0/24"]) == []


def test_free_space_single_child_leaves_three_ranges():
    # Carving 10.0.1.0/24 out of /16 leaves three free blocks.
    free = free_space("10.0.0.0/16", ["10.0.1.0/24"])
    assert "10.0.0.0/24" in free
    assert "10.0.1.0/24" not in free
    assert len(free) >= 2


def test_free_space_ignores_nested_children():
    # Passing both parent-child and sub-child shouldn't double-subtract.
    free_a = free_space("10.0.0.0/16", ["10.0.1.0/24"])
    free_b = free_space("10.0.0.0/16", ["10.0.1.0/24", "10.0.1.128/25"])
    assert free_a == free_b


def test_free_space_ignores_outside_parent():
    free = free_space("10.0.0.0/16", ["192.168.0.0/24"])
    assert free == ["10.0.0.0/16"]


def test_carve_with_parent_in_existing_list():
    # The route passes all plan CIDRs (including the parent supernet itself)
    # as `existing_cidrs`; carve must filter it out, not treat parent as
    # "fully consumed".
    got = carve("10.0.0.0/16", ["10.0.0.0/16", "10.0.1.0/24"], prefix_length=24)
    assert got == ["10.0.0.0/24"]


# --- build_tree --------------------------------------------------------------

def test_build_tree_nests_child_under_supernet():
    plan = _plan(
        supernets=[("10.0.0.0/16", "top")],
        allocations=[("10.0.1.0/24", "prod")],
    )
    tree = build_tree(plan)
    assert len(tree["roots"]) == 1
    root = tree["roots"][0]
    assert root["cidr"] == "10.0.0.0/16"
    assert len(root["children"]) == 1
    assert root["children"][0]["cidr"] == "10.0.1.0/24"
    assert root["used_addresses"] == 256
    assert root["total_addresses"] == 65536


def test_build_tree_nests_grandchild_under_child():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", ""), ("10.0.1.0/25", "")],
    )
    tree = build_tree(plan)
    child = tree["roots"][0]["children"][0]
    assert child["cidr"] == "10.0.1.0/24"
    assert len(child["children"]) == 1
    assert child["children"][0]["cidr"] == "10.0.1.0/25"


def test_build_tree_subtree_free_with_leaf_allocation():
    root = build_tree(_plan(
        supernets=[("192.0.2.0/24", "")],
        allocations=[("192.0.2.0/26", "")],
    ))["roots"][0]
    assert root["free_addresses"] == 192
    assert root["children"][0]["free_addresses"] == 0


def test_build_tree_subtree_free_with_nested_container():
    root = build_tree(_plan(
        supernets=[("192.0.2.0/24", "")],
        allocations=[("192.0.2.0/25", ""), ("192.0.2.0/26", "")],
    ))["roots"][0]
    assert root["used_addresses"] == 128
    assert root["free_addresses"] == 192
    assert root["children"][0]["free_addresses"] == 64


@pytest.mark.parametrize("nested", [False, True])
def test_build_tree_subtree_free_stops_at_reservation(nested):
    root = build_tree(_plan(
        supernets=[("192.0.2.0/24", "")],
        reservations=[("192.0.2.0/25", "")],
        allocations=[("192.0.2.0/26", ""), ("192.0.2.0/27", "")] if nested else [],
    ))["roots"][0]
    assert root["free_addresses"] == 128
    assert root["children"][0]["free_addresses"] == 0


def test_build_tree_identifies_orphans():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("192.168.0.0/24", "")],
    )
    tree = build_tree(plan)
    assert len(tree["roots"]) == 1
    assert tree["roots"][0]["children"] == []
    assert [o["cidr"] for o in tree["orphans"]] == ["192.168.0.0/24"]


# --- conflicts / orphans -----------------------------------------------------

def test_find_conflicts_detects_duplicate_across_buckets():
    # Same CIDR present as an allocation AND a reservation — the realistic
    # duplicate case now that reclassify exists (a crash mid-reclassify or
    # a hand-edit could leave both).
    plan = Plan(
        name="t",
        supernets=[Allocation(cidr="10.0.0.0/16", name="")],
        allocations=[Allocation(cidr="10.0.1.0/24", name="a")],
        reservations=[Allocation(cidr="10.0.1.0/24", name="r")],
    )
    assert ("10.0.1.0/24", "10.0.1.0/24") in find_conflicts(plan)


def test_find_conflicts_detects_normalized_duplicate():
    # "10.0.1.1/24" (host bits set, e.g. hand-edited JSON) normalizes to
    # 10.0.1.0/24 on parse — must be flagged as a duplicate of the aligned
    # entry even though the strings differ.
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", "a"), ("10.0.1.1/24", "b")],
    )
    assert len(find_conflicts(plan)) == 1


def test_build_tree_children_sorted_by_address():
    # Children must come back ordered by network address regardless of
    # insertion order in the plan file.
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.3.0/24", "c"), ("10.0.1.0/24", "a"), ("10.0.2.0/24", "b")],
    )
    tree = build_tree(plan)
    childs = [c["cidr"] for c in tree["roots"][0]["children"]]
    assert childs == ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]


def test_build_tree_duplicate_nets_are_siblings():
    # Two entries with the same CIDR: neither may become the other's
    # parent — both hang off the enclosing supernet.
    plan = Plan(
        name="t",
        supernets=[Allocation(cidr="10.0.0.0/16", name="")],
        allocations=[Allocation(cidr="10.0.1.0/24", name="a")],
        reservations=[Allocation(cidr="10.0.1.0/24", name="r")],
    )
    tree = build_tree(plan)
    root = tree["roots"][0]
    assert len(root["children"]) == 2
    assert all(c["cidr"] == "10.0.1.0/24" for c in root["children"])
    assert all(c["children"] == [] for c in root["children"])
    assert tree["orphans"] == []


def test_build_tree_deep_nesting_chain():
    # /8 ⊃ /16 ⊃ /24 ⊃ /28 — each level must parent to its immediate
    # container, not skip levels.
    plan = _plan(
        supernets=[("10.0.0.0/8", "")],
        allocations=[("10.1.0.0/16", ""), ("10.1.2.0/24", ""), ("10.1.2.16/28", "")],
    )
    tree = build_tree(plan)
    lvl = tree["roots"][0]
    for expected in ("10.1.0.0/16", "10.1.2.0/24", "10.1.2.16/28"):
        assert len(lvl["children"]) == 1
        lvl = lvl["children"][0]
        assert lvl["cidr"] == expected
    assert lvl["children"] == []


def test_build_tree_adjacent_supernets_stay_separate_roots():
    # 10.0.0.0/16 and 10.1.0.0/16 are adjacent (contiguous address space)
    # but neither contains the other — the sweep must not chain them.
    plan = _plan(
        supernets=[("10.1.0.0/16", "b"), ("10.0.0.0/16", "a")],
        allocations=[("10.1.5.0/24", "in-b")],
    )
    tree = build_tree(plan)
    roots = [r["cidr"] for r in tree["roots"]]
    assert roots == ["10.0.0.0/16", "10.1.0.0/16"]
    assert [c["cidr"] for c in tree["roots"][1]["children"]] == ["10.1.5.0/24"]
    assert tree["roots"][0]["children"] == []


def test_find_conflicts_detects_duplicate():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", "a"), ("10.0.1.0/24", "b")],
    )
    assert len(find_conflicts(plan)) >= 1


def test_find_conflicts_allows_containment():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", ""), ("10.0.1.128/25", "")],
    )
    assert find_conflicts(plan) == []


def test_find_orphans():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", ""), ("172.16.0.0/24", "")],
    )
    assert find_orphans(plan) == ["172.16.0.0/24"]


# --- validate_new_allocation -------------------------------------------------

def test_validate_accepts_clean_addition():
    plan = _plan(supernets=[("10.0.0.0/16", "")])
    ok, _ = validate_new_allocation(plan, "10.0.1.0/24")
    assert ok


def test_parse_strict_rejects_misaligned_cidr():
    # Host bits set — must be rejected, not silently normalized.
    with pytest.raises(ValueError):
        parse_strict("10.0.0.128/23")


def test_parse_strict_accepts_aligned_cidr():
    assert str(parse_strict("10.0.0.0/23")) == "10.0.0.0/23"


def test_validate_allows_strict_containment():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", "")],
    )
    ok, _ = validate_new_allocation(plan, "10.0.1.128/25")
    assert ok


def test_validate_rejects_duplicate():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.1.0/24", "")],
    )
    ok, reason = validate_new_allocation(plan, "10.0.1.0/24")
    assert not ok
    assert "duplicate" in reason.lower()


# --- carve -------------------------------------------------------------------

def test_carve_by_prefix_returns_first_free_slot():
    assert carve("10.0.0.0/16", [], prefix_length=24) == ["10.0.0.0/24"]


def test_carve_by_prefix_skips_used():
    got = carve("10.0.0.0/16", ["10.0.0.0/24"], prefix_length=24)
    assert got == ["10.0.1.0/24"]


def test_carve_by_prefix_returns_empty_when_too_large():
    assert carve("10.0.0.0/24", [], prefix_length=16) == []


def test_carve_by_host_count_rounds_up():
    # 500 hosts → need 502 addrs → /23 (512 addrs, 510 usable).
    got = carve("10.0.0.0/16", [], host_count=500)
    assert got == ["10.0.0.0/23"]


def test_carve_by_host_count_small():
    # 1 host → need 3 addrs → /30 (4 addrs, 2 usable).
    got = carve("10.0.0.0/24", [], host_count=1)
    assert got == ["10.0.0.0/30"]


def test_carve_equal_split_power_of_two():
    got = carve("10.0.0.0/24", [], count=4)
    assert got == ["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"]


def test_carve_equal_split_rejects_non_power_of_two():
    assert carve("10.0.0.0/24", [], count=3) == []


def test_carve_equal_split_rejects_when_not_empty():
    # Cannot split a parent that already has allocations.
    assert carve("10.0.0.0/24", ["10.0.0.0/26"], count=4) == []


def test_carve_requires_exactly_one_mode():
    with pytest.raises(ValueError):
        carve("10.0.0.0/16", [], prefix_length=24, host_count=500)
    with pytest.raises(ValueError):
        carve("10.0.0.0/16", [])


# --- reservations ------------------------------------------------------------

def test_reservation_blocks_carve_into_its_range():
    # Reserved 10.0.0.0/24 inside the supernet -> first /24 carve must skip it.
    existing = ["10.0.0.0/16", "10.0.0.0/24"]  # /24 is reserved
    got = carve("10.0.0.0/16", existing, prefix_length=24)
    assert got == ["10.0.1.0/24"]


def test_reservation_appears_in_tree_with_kind():
    plan = _plan(
        supernets=[("10.0.0.0/16", "top")],
        reservations=[("10.0.0.0/24", "gateway-pool")],
    )
    tree = build_tree(plan)
    root = tree["roots"][0]
    assert len(root["children"]) == 1
    child = root["children"][0]
    assert child["cidr"] == "10.0.0.0/24"
    assert child["kind"] == "reservation"
    assert child["is_reservation"] is True
    assert child["is_supernet"] is False


def test_reservation_subtracts_from_parent_free_space():
    plan = _plan(
        supernets=[("10.0.0.0/24", "top")],
        reservations=[("10.0.0.0/25", "pool")],
    )
    tree = build_tree(plan)
    free = tree["roots"][0]["free"]
    assert "10.0.0.128/25" in free
    assert "10.0.0.0/25" not in free


def test_reservation_overlapping_allocation_is_a_conflict():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        allocations=[("10.0.0.0/24", "alloc")],
        reservations=[("10.0.0.0/24", "resv")],   # exact same CIDR — conflict
    )
    conflicts = find_conflicts(plan)
    assert len(conflicts) >= 1


def test_validate_rejects_duplicate_reservation():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        reservations=[("10.0.0.0/24", "resv")],
    )
    ok, reason = validate_new_allocation(plan, "10.0.0.0/24")
    assert not ok
    assert "reservation" in reason.lower() or "duplicate" in reason.lower()


def test_validate_blocks_allocation_overlapping_reservation():
    # Allocation that exactly equals a reservation should be rejected as dup.
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        reservations=[("10.0.0.0/24", "")],
    )
    ok, _ = validate_new_allocation(plan, "10.0.0.0/24")
    assert not ok


def test_orphan_detection_includes_reservations():
    plan = _plan(
        supernets=[("10.0.0.0/16", "")],
        reservations=[("192.168.0.0/24", "stray-reservation")],
    )
    assert "192.168.0.0/24" in find_orphans(plan)


def test_plan_round_trip_preserves_reservations():
    plan = _plan(
        supernets=[("10.0.0.0/16", "top")],
        allocations=[("10.0.1.0/24", "prod")],
        reservations=[("10.0.0.0/24", "gateway")],
    )
    restored = Plan.from_dict(plan.to_dict())
    assert len(restored.reservations) == 1
    assert restored.reservations[0].cidr == "10.0.0.0/24"
    assert restored.reservations[0].name == "gateway"


def test_legacy_plan_without_reservations_field_still_loads():
    # A plan file written before reservations existed must still deserialize.
    legacy = {
        "name": "old",
        "supernets":   [{"cidr": "10.0.0.0/16", "name": ""}],
        "allocations": [{"cidr": "10.0.1.0/24", "name": ""}],
        # no "reservations" key
    }
    plan = Plan.from_dict(legacy)
    assert plan.reservations == []


# Request simulation remains pure even when attempts fail after earlier successes.
def test_request_order_names_and_immutability():
    import json
    from app.carve_request import normalize
    from app.planning import simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', 'east{n}')])
    before = json.dumps(plan.to_dict(), sort_keys=True)
    doc = normalize({'version': 1, 'items': [
        dict(id='a', parents=['192.0.2.0/24'], prefix_length=26, repeat=2, name_template='{parent}-{n}'),
        dict(id='b', parents=['192.0.2.0/24'], prefix_length=26, repeat=3, name_template='{n}')
    ]}, 256)
    result = simulate_carve_request(plan, doc, 256)
    assert [p['name'] for r in result['results'] for p in r['proposals']] == ['east{n}-1', 'east{n}-2', '3', '4']
    assert [r['status'] for r in result['results']] == ['will_succeed'] * 4 + ['will_not_fit']
    assert json.dumps(plan.to_dict(), sort_keys=True) == before
    assert result == simulate_carve_request(plan, doc, 256)


def test_request_parent_policy_and_inventory():
    from app.carve_request import normalize
    from app.planning import request_parent_inventory, simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', 'root')], allocations=[
        Allocation('192.0.2.0/26', 'container'), Allocation('192.0.2.0/28', 'leaf'),
        Allocation('192.0.2.128/27', 'reserved child'), Allocation('198.51.100.0/24', 'orphan'),
        Allocation('198.51.100.0/28', 'orphan child')], reservations=[Allocation('192.0.2.128/26', 'held')])
    parents, warnings = request_parent_inventory(plan)
    assert {p['cidr'] for p in parents} == {'192.0.2.0/24', '192.0.2.0/26'}
    root = parents[0]
    assert root['direct_free_addresses'] == 128
    assert root['largest_free_cidr'] == '192.0.2.64/26'
    assert warnings
    requested = ['192.0.2.0/28', '192.0.2.128/27', '192.0.2.128/26', '198.51.100.0/24', '203.0.113.0/24']
    doc = normalize(dict(version=1, items=[dict(id='a', parents=requested, prefix_length=30, repeat=2)]), 256)
    results = simulate_carve_request(plan, doc, 256)['results']
    assert [r['status'] for r in results[::2]] == ['will_not_fit', 'parent_is_reservation', 'parent_is_reservation', 'will_not_fit', 'parent_not_found']
    assert all(not r['proposals'] for r in results)


def test_request_split_duplicate_and_repeated_split():
    from app.carve_request import normalize
    from app.planning import simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', '')])
    for count, statuses, proposed in [(1, ['conflicts_existing'] * 2, 0), (4, ['will_succeed', 'will_not_fit'], 4)]:
        doc = normalize(dict(version=1, items=[dict(id='a', parents=['192.0.2.0/24'], count=count, repeat=2)]), 256)
        result = simulate_carve_request(plan, doc, 256)
        assert [r['status'] for r in result['results']] == statuses
        assert result['summary']['proposed_allocations'] == proposed
        assert not plan.allocations


def test_request_nested_capacity_duplicates_and_all_modes():
    from app.carve_request import normalize
    from app.planning import request_parent_inventory, simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', 'root')], allocations=[
        Allocation('192.0.2.0/25', ''), Allocation('192.0.2.128/25', ''), Allocation('192.0.2.0/28', '')])
    parents, _ = request_parent_inventory(plan)
    assert [p['cidr'] for p in parents] == ['192.0.2.0/25']
    doc = normalize(dict(version=1, items=[dict(id='a', parents=['192.0.2.0/24', '192.0.2.0/25'], host_count=30)]), 256)
    result = simulate_carve_request(plan, doc, 256)
    assert result['results'][0]['status'] == 'will_not_fit'
    assert result['results'][1]['proposals'][0]['cidr'] == '192.0.2.32/27'
    plan.allocations.append(Allocation('192.0.2.1/24', 'duplicate'))
    assert simulate_carve_request(plan, doc, 256)['results'][0]['status'] == 'conflicts_existing'
    for prefix in [0, 31, 32]:
        plan = Plan('request', supernets=[Allocation('0.0.0.0/0', '')])
        doc = normalize(dict(version=1, items=[dict(id='a', parents=['0.0.0.0/0'], prefix_length=prefix)]), 256)
        result = simulate_carve_request(plan, doc, 256)['results'][0]
        assert result['status'] == ('conflicts_existing' if prefix == 0 else 'will_succeed')


def test_request_fragmentation_and_maximum_hosts_leave_plan_unchanged():
    import json
    from app.carve_request import normalize
    from app.planning import simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', '')], allocations=[
        Allocation('192.0.2.0/26', ''), Allocation('192.0.2.128/26', '')])
    before = json.dumps(plan.to_dict())
    doc = normalize(dict(version=1, items=[dict(id='a', parents=['192.0.2.0/24'], prefix_length=25)]), 256)
    assert simulate_carve_request(plan, doc, 256)['results'][0]['reason_code'] == 'capacity'
    assert json.dumps(plan.to_dict()) == before
    plan = Plan('request', supernets=[Allocation('0.0.0.0/0', '')])
    doc = normalize(dict(version=1, items=[dict(id='a', parents=['0.0.0.0/0'], host_count=4294967294)]), 256)
    assert simulate_carve_request(plan, doc, 256)['results'][0]['status'] == 'conflicts_existing'


def test_request_reservation_priority_and_selected_parents_interact():
    import json
    from app.carve_request import normalize
    from app.planning import simulate_carve_request
    plan = Plan('request', supernets=[Allocation('192.0.2.0/24', '')],
                allocations=[Allocation('192.0.2.0/25', ''), Allocation('192.0.2.0/28', '')],
                reservations=[Allocation('192.0.2.128/25', '')])
    before = json.dumps(plan.to_dict())
    doc = normalize(dict(version=1, items=[dict(id='a', parents=['192.0.2.0/24', '192.0.2.0/25'], prefix_length=26)]), 256)
    results = simulate_carve_request(plan, doc, 256)['results']
    assert results[0]['status'] == 'will_not_fit'
    assert results[1]['proposals'][0]['cidr'] == '192.0.2.64/26'
    assert json.dumps(plan.to_dict()) == before
    plan.reservations.append(Allocation('192.0.2.0/24', ''))
    assert simulate_carve_request(plan, doc, 256)['results'][0]['status'] == 'parent_is_reservation'
