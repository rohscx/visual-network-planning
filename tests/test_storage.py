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


# ---- reclassify -------------------------------------------------------

def _seed_reclassify(tmp_path: Path) -> Plan:
    """Plan with one record in each bucket — used by every reclassify test."""
    plan = Plan(
        name="rc",
        supernets=[Allocation(cidr="10.0.0.0/16", name="super",
                              description="d-super", tags=["s"])],
        allocations=[Allocation(cidr="10.0.1.0/24", name="alloc",
                                description="d-alloc", tags=["a"])],
        reservations=[Allocation(cidr="10.0.2.0/24", name="resv",
                                 description="d-resv", tags=["r"])],
    )
    storage.save_plan(tmp_path, plan)
    return plan


def test_reclassify_supernet_to_allocation_preserves_metadata(tmp_path):
    plan = _seed_reclassify(tmp_path)
    before = plan.supernets[0]
    storage.reclassify_record(plan, "10.0.0.0/16", "allocation")
    assert len(plan.supernets) == 0
    assert len(plan.allocations) == 2
    moved = next(a for a in plan.allocations if a.cidr == "10.0.0.0/16")
    # Same Python object — metadata identity preserved, no field-by-field
    # copy that could drop a future-added attribute on the floor.
    assert moved is before
    assert moved.name == "super"
    assert moved.tags == ["s"]


def test_reclassify_allocation_to_reservation(tmp_path):
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.1.0/24", "reservation")
    assert len(plan.allocations) == 0
    assert len(plan.reservations) == 2
    assert any(r.cidr == "10.0.1.0/24" for r in plan.reservations)


def test_reclassify_reservation_to_supernet(tmp_path):
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.2.0/24", "supernet")
    assert len(plan.reservations) == 0
    assert any(s.cidr == "10.0.2.0/24" for s in plan.supernets)


def test_reclassify_allocation_to_supernet(tmp_path):
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.1.0/24", "supernet")
    assert any(s.cidr == "10.0.1.0/24" for s in plan.supernets)
    assert all(a.cidr != "10.0.1.0/24" for a in plan.allocations)


def test_reclassify_reservation_to_allocation(tmp_path):
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.2.0/24", "allocation")
    assert any(a.cidr == "10.0.2.0/24" for a in plan.allocations)


def test_reclassify_supernet_to_reservation(tmp_path):
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.0.0/16", "reservation")
    assert any(r.cidr == "10.0.0.0/16" for r in plan.reservations)


def test_reclassify_rejects_unknown_cidr(tmp_path):
    plan = _seed_reclassify(tmp_path)
    with pytest.raises(KeyError):
        storage.reclassify_record(plan, "192.0.2.0/24", "allocation")


def test_reclassify_rejects_same_kind(tmp_path):
    plan = _seed_reclassify(tmp_path)
    with pytest.raises(ValueError):
        storage.reclassify_record(plan, "10.0.1.0/24", "allocation")


def test_reclassify_rejects_unknown_kind(tmp_path):
    plan = _seed_reclassify(tmp_path)
    with pytest.raises(ValueError):
        storage.reclassify_record(plan, "10.0.1.0/24", "bogus")


def test_reclassify_round_trips_through_disk(tmp_path):
    """Reclassify in memory, save, reload — the record must come back in
    the new bucket. Catches any to_dict / from_dict drift."""
    plan = _seed_reclassify(tmp_path)
    storage.reclassify_record(plan, "10.0.1.0/24", "supernet")
    storage.save_plan(tmp_path, plan)
    reloaded = storage.load_plan(tmp_path, "rc")
    assert any(s.cidr == "10.0.1.0/24" for s in reloaded.supernets)
    assert all(a.cidr != "10.0.1.0/24" for a in reloaded.allocations)


def test_find_record_kind(tmp_path):
    plan = _seed_reclassify(tmp_path)
    assert storage.find_record_kind(plan, "10.0.0.0/16") == "supernet"
    assert storage.find_record_kind(plan, "10.0.1.0/24") == "allocation"
    assert storage.find_record_kind(plan, "10.0.2.0/24") == "reservation"
    assert storage.find_record_kind(plan, "192.0.2.0/24") is None
