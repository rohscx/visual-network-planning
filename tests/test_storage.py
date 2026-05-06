"""Tests for plan storage helpers — copy, rename, and the safe_name guard."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import storage
from app.models import Allocation, Plan


def _seed(plans_dir: Path, name: str) -> Plan:
    """Create a small plan on disk to exercise copy / rename against."""
    plan = Plan(
        name=name,
        supernets=[Allocation(cidr="10.0.0.0/16", name="top", tags=["env-a"])],
        allocations=[Allocation(cidr="10.0.1.0/24", name="prod-web")],
        reservations=[Allocation(cidr="10.0.0.0/24", name="gateway-pool")],
    )
    storage.save_plan(plans_dir, plan)
    return plan


# ---- copy --------------------------------------------------------------

def test_copy_writes_new_file_with_updated_name(tmp_path):
    _seed(tmp_path, "original")
    storage.copy_plan(tmp_path, "original", "duplicate")

    # Both files exist
    assert (tmp_path / "original.json").exists()
    assert (tmp_path / "duplicate.json").exists()

    # Inside the new file, the name field tracks the filename — no stale
    # "original" left in the JSON.
    with (tmp_path / "duplicate.json").open() as f:
        data = json.load(f)
    assert data["name"] == "duplicate"

    # Source's name field stays "original" (not mutated by the copy).
    with (tmp_path / "original.json").open() as f:
        src = json.load(f)
    assert src["name"] == "original"


def test_copy_preserves_supernets_allocations_reservations(tmp_path):
    _seed(tmp_path, "src")
    storage.copy_plan(tmp_path, "src", "dst")
    dst = storage.load_plan(tmp_path, "dst")
    assert [s.cidr for s in dst.supernets]    == ["10.0.0.0/16"]
    assert [a.cidr for a in dst.allocations]  == ["10.0.1.0/24"]
    assert [r.cidr for r in dst.reservations] == ["10.0.0.0/24"]


def test_copy_rejects_existing_destination(tmp_path):
    _seed(tmp_path, "src")
    _seed(tmp_path, "dst")     # already there
    with pytest.raises(FileExistsError):
        storage.copy_plan(tmp_path, "src", "dst")


def test_copy_rejects_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        storage.copy_plan(tmp_path, "no-such-plan", "anything")


def test_copy_rejects_invalid_destination_name(tmp_path):
    _seed(tmp_path, "src")
    with pytest.raises(ValueError):
        storage.copy_plan(tmp_path, "src", "bad/slash")


def test_copy_rejects_same_name(tmp_path):
    _seed(tmp_path, "src")
    with pytest.raises(ValueError):
        storage.copy_plan(tmp_path, "src", "src")


# ---- rename ------------------------------------------------------------

def test_rename_replaces_old_with_new(tmp_path):
    _seed(tmp_path, "before")
    storage.rename_plan(tmp_path, "before", "after")
    assert not (tmp_path / "before.json").exists()
    assert     (tmp_path / "after.json").exists()


def test_rename_updates_name_key_in_json(tmp_path):
    _seed(tmp_path, "before")
    storage.rename_plan(tmp_path, "before", "after")
    with (tmp_path / "after.json").open() as f:
        data = json.load(f)
    assert data["name"] == "after"


def test_rename_preserves_data(tmp_path):
    _seed(tmp_path, "before")
    storage.rename_plan(tmp_path, "before", "after")
    plan = storage.load_plan(tmp_path, "after")
    assert plan.name == "after"
    assert len(plan.supernets) == 1
    assert len(plan.allocations) == 1
    assert len(plan.reservations) == 1


def test_rename_rejects_existing_destination(tmp_path):
    _seed(tmp_path, "src")
    _seed(tmp_path, "dst")
    with pytest.raises(FileExistsError):
        storage.rename_plan(tmp_path, "src", "dst")
    # Source must remain — no half-state on rejection
    assert (tmp_path / "src.json").exists()


def test_rename_rejects_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        storage.rename_plan(tmp_path, "missing", "anything")


def test_rename_rejects_invalid_destination_name(tmp_path):
    _seed(tmp_path, "src")
    with pytest.raises(ValueError):
        storage.rename_plan(tmp_path, "src", "")


def test_rename_rejects_same_name(tmp_path):
    _seed(tmp_path, "src")
    with pytest.raises(ValueError):
        storage.rename_plan(tmp_path, "src", "src")
