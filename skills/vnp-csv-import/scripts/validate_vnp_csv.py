#!/usr/bin/env python3
"""Validate an Infoblox-format CSV against vnp's import rules.

Replays the importer's parsing logic exactly, then reports both what the file
will produce and the problems the importer would accept silently. Standard
library only — runs anywhere, no vnp checkout needed.

    python3 validate_vnp_csv.py networks.csv
    python3 validate_vnp_csv.py networks.csv --quiet   # findings only

Exit codes: 0 clean (warnings allowed), 1 errors found, 2 bad usage.
"""

from __future__ import annotations

import argparse
import csv
import ipaddress
import sys
from io import StringIO

SUPPORTED_TYPES = {"network", "networkcontainer"}
KIND_LABEL = {"networkcontainer": "supernet", "network": "allocation"}


def coerce_cidr(address: str, netmask: str) -> str:
    """Mirror of the importer's address+netmask -> CIDR coercion."""
    address, netmask = address.strip(), netmask.strip()
    if not address or not netmask:
        raise ValueError(
            f"missing address or netmask (address={address!r}, netmask={netmask!r})"
        )
    return str(ipaddress.IPv4Network(f"{address}/{netmask}", strict=False))


def parse(text: str) -> dict:
    """Parse CSV text the way vnp's importer does.

    Returns records with the source line and the raw address/netmask kept, so
    the linter can spot values that parsed successfully but were altered.
    """
    headers: dict[str, list[str]] = {}
    records: list[dict] = []
    errors: list[str] = []

    for lineno, row in enumerate(csv.reader(StringIO(text)), start=1):
        if not row or all(not c.strip() for c in row):
            continue
        tag = row[0].strip()

        if tag.startswith("header-"):
            kind = tag[len("header-"):].strip()
            if kind in SUPPORTED_TYPES:
                # Column 0 is the tag itself; field names start at column 1.
                headers[kind] = [c.rstrip("*").strip() for c in row[1:]]
            continue

        if tag not in SUPPORTED_TYPES:
            continue  # ipv6network, hostrecord, ... silently skipped

        cols = headers.get(tag)
        if cols is None:
            errors.append(f"line {lineno}: '{tag}' row before any header-{tag}")
            continue

        values = row[1:]
        rec = {cols[i]: (values[i] if i < len(values) else "") for i in range(len(cols))}

        raw_addr = rec.get("address", "").strip()
        raw_mask = rec.get("netmask", "").strip()
        try:
            cidr = coerce_cidr(raw_addr, raw_mask)
        except ValueError as e:
            errors.append(f"line {lineno}: {e}")
            continue

        comment = rec.get("comment", "").strip()
        ea_name = rec.get("EA-Network Name", "").strip()
        ea_tags = rec.get("EA-TAGS", "").strip()

        records.append({
            "line": lineno,
            "kind": tag,
            "cidr": cidr,
            "raw_addr": raw_addr,
            "raw_mask": raw_mask,
            "name": ea_name or comment,
            "description": comment,
            "tags": [t.strip() for t in ea_tags.split(",") if t.strip()],
            "width_declared": len(cols),
            "width_actual": len(values),
        })

    return {"records": records, "errors": errors}


def lint(records: list[dict]) -> list[str]:
    """Flag things that parse cleanly but are probably mistakes."""
    warnings: list[str] = []

    for r in records:
        # Host bits cleared. The importer does this silently, so a typo'd
        # boundary becomes a valid-but-wrong network with no signal.
        try:
            exact = ipaddress.ip_network(f"{r['raw_addr']}/{r['raw_mask']}", strict=True)
            del exact
        except ValueError:
            warnings.append(
                f"line {r['line']}: {r['raw_addr']}/{r['raw_mask']} has host bits set "
                f"— imports as {r['cidr']}. Confirm that's the network you meant."
            )
        except Exception:
            pass

        if r["width_actual"] < r["width_declared"]:
            warnings.append(
                f"line {r['line']}: row has {r['width_actual']} values but the header "
                f"declares {r['width_declared']} — trailing fields import as empty."
            )
        elif r["width_actual"] > r["width_declared"]:
            warnings.append(
                f"line {r['line']}: row has {r['width_actual']} values, "
                f"{r['width_actual'] - r['width_declared']} past the header's width "
                f"— the extras are dropped. Check for an unquoted comma in EA-TAGS."
            )

        if not r["name"]:
            warnings.append(
                f"line {r['line']}: {r['cidr']} has no name (set EA-Network Name "
                f"or comment) — it'll show as unnamed in the tree."
            )

    # Duplicate CIDRs inside the file. The importer skips these as duplicates,
    # so the second occurrence's name/tags are silently discarded.
    seen: dict[str, int] = {}
    for r in records:
        if r["cidr"] in seen:
            warnings.append(
                f"line {r['line']}: {r['cidr']} already appeared on line "
                f"{seen[r['cidr']]} — the importer keeps the first and skips this one."
            )
        else:
            seen[r["cidr"]] = r["line"]

    # Allocations with no containing supernet in this file become orphans.
    # This is only a hint — the target plan may already hold a covering
    # supernet, which is the normal case when topping up an existing plan.
    containers = [ipaddress.ip_network(r["cidr"])
                  for r in records if r["kind"] == "networkcontainer"]
    allocs = [r for r in records if r["kind"] == "network"]
    uncovered = [r for r in allocs
                 if not any(ipaddress.ip_network(r["cidr"]).subnet_of(c)
                            for c in containers)]

    if uncovered:
        if not containers:
            # Whole file is allocations — one note beats N identical warnings.
            warnings.append(
                f"no networkcontainer rows in this file, so all {len(allocs)} "
                f"allocation(s) import as orphans unless the target plan already "
                f"has supernets covering them. That's fine when topping up an "
                f"existing plan; add container rows if it isn't."
            )
        else:
            for r in uncovered:
                warnings.append(
                    f"line {r['line']}: {r['cidr']} isn't inside any networkcontainer "
                    f"in this file — it imports as an orphan unless the plan already "
                    f"has a supernet covering it."
                )

    return warnings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_file")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress the record listing; show findings only")
    args = ap.parse_args()

    try:
        with open(args.csv_file, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        print(f"cannot read {args.csv_file}: {e}", file=sys.stderr)
        return 2

    result = parse(text)
    records, errors = result["records"], result["errors"]
    supers = [r for r in records if r["kind"] == "networkcontainer"]
    allocs = [r for r in records if r["kind"] == "network"]
    warnings = lint(records)

    print(f"{args.csv_file}: {len(supers)} supernet(s), {len(allocs)} allocation(s), "
          f"{len(errors)} error(s), {len(warnings)} warning(s)")

    if not args.quiet and records:
        print("\nWill import as:")
        for r in sorted(records, key=lambda r: (
                int(ipaddress.ip_network(r["cidr"]).network_address),
                ipaddress.ip_network(r["cidr"]).prefixlen)):
            tags = ",".join(r["tags"])
            print(f"  {KIND_LABEL[r['kind']]:11s} {r['cidr']:<20s} "
                  f"{r['name'] or '(unnamed)':<24s} {'[' + tags + ']' if tags else ''}")

    if errors:
        print("\nErrors (these rows are dropped):")
        for e in errors:
            print(f"  ✗ {e}")

    if warnings:
        print("\nWarnings (these import, but check them):")
        for w in warnings:
            print(f"  ! {w}")

    if not records and not errors:
        print("\nNo importable rows found. The most likely cause is a missing "
              "'header-network' or 'header-networkcontainer' row — data rows are "
              "ignored until a header of their type appears.")

    if errors:
        return 1
    if not records:
        return 1
    print("\nOK — file is importable." if not warnings
          else "\nImportable, but review the warnings above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
