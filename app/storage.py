from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path

from .models import Plan

_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


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
