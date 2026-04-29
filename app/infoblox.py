"""Parse Infoblox network/networkcontainer CSV exports.

Format reference (observed from real exports):
- A line starting with "header-<type>" defines column names for subsequent
  rows of that type. The first column header is literally "header-<type>";
  the remaining columns are field names. Required fields end in "*"
  (e.g. "address*", "netmask*") — we strip the marker.
- Data rows start with the bare type tag ("network" or "networkcontainer")
  and have values aligned to the most recent header of that type.
- Multiple "header-*" lines for the same type may appear; the most recent
  applies to subsequent rows.
- "netmask*" can be either a dotted-quad ("255.255.255.240") or a prefix
  integer ("23"). Both go through `ipaddress.IPv4Network`.

Mapping into the planning model:

    networkcontainer  -> Plan.supernets
    network           -> Plan.allocations
    address + netmask -> Allocation.cidr
    "EA-Network Name" -> Allocation.name        (fallback: comment)
    comment           -> Allocation.description
    "EA-TAGS"         -> Allocation.tags        (split on ",")

Pure module: no Flask, no I/O. Returns plain dicts/lists for the route layer
to validate and persist.
"""

from __future__ import annotations

import csv
import ipaddress
from io import StringIO

from .models import Allocation

SUPPORTED_TYPES = {"network", "networkcontainer"}


def _strip_required_marker(name: str) -> str:
    return name.rstrip("*").strip()


def _coerce_cidr(address: str, netmask: str) -> str:
    address = address.strip()
    netmask = netmask.strip()
    if not address or not netmask:
        raise ValueError(
            f"Missing address or netmask (address={address!r}, netmask={netmask!r})"
        )
    # IPv4Network accepts both "10.0.0.0/24" and "10.0.0.0/255.255.255.0".
    spec = f"{address}/{netmask}"
    return str(ipaddress.IPv4Network(spec, strict=False))


def parse_infoblox_csv(text: str) -> dict:
    """Parse Infoblox CSV text.

    Returns:
        {
            "supernets":   list[Allocation],   # from networkcontainer rows
            "allocations": list[Allocation],   # from network rows
            "errors":      list[str],          # human-readable, with row #s
        }
    """
    headers: dict[str, list[str]] = {}
    supernets: list[Allocation] = []
    allocations: list[Allocation] = []
    errors: list[str] = []

    reader = csv.reader(StringIO(text))
    for lineno, row in enumerate(reader, start=1):
        if not row or all(not c.strip() for c in row):
            continue
        first = row[0].strip()

        if first.startswith("header-"):
            t = first[len("header-"):].strip()
            if t in SUPPORTED_TYPES:
                # row[0] is the literal "header-<type>" tag; field names
                # align with data rows starting at column 1, so strip it.
                headers[t] = [_strip_required_marker(c) for c in row[1:]]
            continue

        if first not in SUPPORTED_TYPES:
            continue

        cols = headers.get(first)
        if cols is None:
            errors.append(f"Row {lineno}: '{first}' row before any header-{first}")
            continue

        values = row[1:]
        record = {
            cols[i]: values[i] if i < len(values) else ""
            for i in range(len(cols))
        }

        try:
            cidr = _coerce_cidr(record.get("address", ""), record.get("netmask", ""))
        except ValueError as e:
            errors.append(f"Row {lineno}: {e}")
            continue

        ea_name = record.get("EA-Network Name", "").strip()
        comment = record.get("comment", "").strip()
        ea_tags = record.get("EA-TAGS", "").strip()
        tags = [t.strip() for t in ea_tags.split(",") if t.strip()] if ea_tags else []
        name = ea_name or comment

        alloc = Allocation(cidr=cidr, name=name, description=comment, tags=tags)
        if first == "networkcontainer":
            supernets.append(alloc)
        else:
            allocations.append(alloc)

    return {"supernets": supernets, "allocations": allocations, "errors": errors}
