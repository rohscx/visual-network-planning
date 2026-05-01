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
