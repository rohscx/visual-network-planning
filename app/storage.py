from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path

from .models import Allocation, Plan

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

KINDS = ("supernet", "allocation", "reservation")


def safe_name(name: str) -> str:
    if not _SAFE_NAME.match(name):
        raise ValueError(
            "Plan name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} "
            "(letters, digits, dot, underscore, hyphen; up to 64 chars)."
        )
    return name


def plan_path(plans_dir: Path, name: str) -> Path:
    return plans_dir / f"{safe_name(name)}.json"


def list_plans(plans_dir: Path) -> list[str]:
    if not plans_dir.exists():
        return []
    return sorted(p.stem for p in plans_dir.glob("*.json"))


def load_plan(plans_dir: Path, name: str) -> Plan:
    path = plan_path(plans_dir, name)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return Plan.from_dict(data)


def save_plan(plans_dir: Path, plan: Plan) -> None:
    path = plan_path(plans_dir, plan.name)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(plan.to_dict(), f, indent=2, sort_keys=False)
        f.write("\n")
    tmp.replace(path)


def create_plan(plans_dir: Path, name: str) -> Plan:
    path = plan_path(plans_dir, name)
    if path.exists():
        raise FileExistsError(f"Plan '{name}' already exists")
    plan = Plan(name=name)
    save_plan(plans_dir, plan)
    return plan


def plan_modified(plans_dir: Path, name: str) -> str:
    """ISO-8601 mtime of a plan file (UTC, second-precision)."""
    path = plan_path(plans_dir, name)
    if not path.exists():
        return ""
    ts = _dt.datetime.fromtimestamp(path.stat().st_mtime, _dt.timezone.utc)
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def copy_plan(plans_dir: Path, src_name: str, dst_name: str) -> Plan:
    """Duplicate a plan under a new name.

    Loads `src_name`, rewrites the `name` field to `dst_name` so the JSON's
    self-identifier stays in sync with the file on disk, and saves the
    result. Raises FileNotFoundError if the source doesn't exist,
    FileExistsError if the target already does, ValueError on bad names.
    """
    safe_name(dst_name)
    if src_name == dst_name:
        raise ValueError("source and destination names are the same")
    dst_path = plan_path(plans_dir, dst_name)
    if dst_path.exists():
        raise FileExistsError(f"Plan '{dst_name}' already exists")
    plan = load_plan(plans_dir, src_name)
    plan.name = dst_name
    save_plan(plans_dir, plan)
    return plan


def _bucket(plan: Plan, kind: str) -> list[Allocation]:
    """Return the list inside `plan` that holds records of the given kind."""
    if kind == "supernet":
        return plan.supernets
    if kind == "allocation":
        return plan.allocations
    if kind == "reservation":
        return plan.reservations
    raise ValueError(f"unknown kind: {kind!r}")


def find_record_kind(plan: Plan, cidr: str) -> str | None:
    """Return the kind of the record with `cidr` in `plan`, or None.

    Searches supernets, allocations, then reservations — the same order the
    /edit route uses. Doesn't validate that `cidr` only appears in one
    bucket (find_conflicts handles that case as a duplicate).
    """
    for kind in KINDS:
        if any(r.cidr == cidr for r in _bucket(plan, kind)):
            return kind
    return None


def reclassify_record(plan: Plan, cidr: str, new_kind: str) -> Plan:
    """Move the record with `cidr` from its current bucket into `new_kind`.

    Same Allocation object — metadata (name, description, tags) is
    preserved. Only the list membership changes. Caller persists with
    save_plan() afterward.

    Raises:
      ValueError  — unknown `new_kind` or same-kind move (no-op).
      KeyError    — `cidr` isn't present in any bucket.

    Reclassification preserves the plan's CIDR set, so no overlap or
    duplicate validation is needed: any conflict detectable afterward
    was pre-existing.
    """
    if new_kind not in KINDS:
        raise ValueError(f"unknown kind: {new_kind!r}")
    current = find_record_kind(plan, cidr)
    if current is None:
        raise KeyError(f"{cidr} not in plan")
    if current == new_kind:
        raise ValueError(f"{cidr} is already a {new_kind}")
    src = _bucket(plan, current)
    rec = next(r for r in src if r.cidr == cidr)
    src.remove(rec)
    _bucket(plan, new_kind).append(rec)
    return plan


def rename_plan(plans_dir: Path, src_name: str, dst_name: str) -> Plan:
    """Rename a plan in place.

    Equivalent to copy_plan(src → dst) followed by removing the src file.
    The save-then-delete order means a crash in the middle leaves both
    files behind rather than losing data; the user can sort it out.
    """
    safe_name(dst_name)
    if src_name == dst_name:
        raise ValueError("source and destination names are the same")
    src_path = plan_path(plans_dir, src_name)
    dst_path = plan_path(plans_dir, dst_name)
    if not src_path.exists():
        raise FileNotFoundError(f"Plan '{src_name}' not found")
    if dst_path.exists():
        raise FileExistsError(f"Plan '{dst_name}' already exists")
    plan = load_plan(plans_dir, src_name)
    plan.name = dst_name
    save_plan(plans_dir, plan)
    src_path.unlink()
    return plan
