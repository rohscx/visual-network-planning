from __future__ import annotations

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
