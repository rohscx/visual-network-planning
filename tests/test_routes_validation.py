"""Route-level guards: payload size caps on commit_carve and import.

The validation logic itself is covered by test_planning.py and
test_infoblox.py; this file just asserts the routes reject obviously-too-
large inputs before the validation loop runs. First test file to hit the
Flask test client — keep these patterns reusable for future route tests.
"""

from __future__ import annotations

import io
import json

import pytest

from app import create_app, routes
from app.models import Allocation, Plan
from app import storage


@pytest.fixture
def client(tmp_path):
    """Flask test client with an isolated plans/ directory per test."""
    app = create_app(plans_dir=tmp_path)
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def seeded_plan(tmp_path):
    """Plan with one supernet big enough to host many carves."""
    plan = Plan(
        name="cap_test",
        supernets=[Allocation(cidr="10.0.0.0/8", name="big")],
    )
    storage.save_plan(tmp_path, plan)
    return plan


def _post_json(client, url, payload):
    return client.post(
        url,
        data=json.dumps(payload),
        content_type="application/json",
    )


# ---- commit_carve --------------------------------------------------------

def test_commit_carve_rejects_oversized_payload(client, seeded_plan):
    """Above _MAX_COMMIT_ALLOCS → 400 with a clear message; nothing saved."""
    allocations = [
        {"cidr": f"10.0.{i // 256}.{i % 256}/32", "name": f"n{i}"}
        for i in range(routes._MAX_COMMIT_ALLOCS + 1)
    ]
    r = _post_json(client, "/plans/cap_test/commit_carve", {"allocations": allocations})
    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False
    assert "cap" in body["error"]


def test_commit_carve_accepts_at_cap(client, seeded_plan):
    """Exactly _MAX_COMMIT_ALLOCS → not the cap's fault if any one fails."""
    # Use unique, valid /32 CIDRs that don't overlap each other.
    allocations = [
        {"cidr": f"10.0.{i // 256}.{i % 256}/32", "name": f"n{i}"}
        for i in range(routes._MAX_COMMIT_ALLOCS)
    ]
    r = _post_json(client, "/plans/cap_test/commit_carve", {"allocations": allocations})
    # At the cap the request is *accepted* — whether each entry passes
    # validation is a separate concern.
    assert r.status_code == 200


def test_commit_carve_rejects_empty_array(client, seeded_plan):
    r = _post_json(client, "/plans/cap_test/commit_carve", {"allocations": []})
    assert r.status_code == 400


# ---- import_infoblox ---------------------------------------------------

def _csv_with_n_rows(n: int) -> bytes:
    """Build an Infoblox-shaped CSV with N synthetic /32 network rows."""
    header = "header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS\n"
    rows = "\n".join(
        # 10.x.x.x/32 covers up to ~16M unique CIDRs before wrapping.
        f"network,10.{(i >> 16) & 0xff}.{(i >> 8) & 0xff}.{i & 0xff},255.255.255.255,,n{i},"
        for i in range(n)
    )
    return (header + rows + "\n").encode("utf-8")


def test_import_rejects_too_many_rows(client, seeded_plan):
    """Above _MAX_IMPORT_ROWS → 400 with a clear message."""
    csv = _csv_with_n_rows(routes._MAX_IMPORT_ROWS + 1)
    r = client.post(
        "/plans/cap_test/import_infoblox",
        data={"file": (io.BytesIO(csv), "huge.csv")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False
    assert "cap" in body["error"]


def test_import_accepts_modest_payload(client, seeded_plan):
    """Way under the cap should pass through. (Each row may or may not
    successfully add — we just assert the cap doesn't trip.)"""
    csv = _csv_with_n_rows(100)
    r = client.post(
        "/plans/cap_test/import_infoblox",
        data={"file": (io.BytesIO(csv), "ok.csv")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
