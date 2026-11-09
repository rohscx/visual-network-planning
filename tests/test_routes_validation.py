"""Route-level guards: payload size caps on commit_carve and import.

The validation logic itself is covered by test_planning.py and
test_infoblox.py; this file just asserts the routes reject obviously-too-
large inputs before the validation loop runs. First test file to hit the
Flask test client — keep these patterns reusable for future route tests.
"""

from __future__ import annotations

from copy import deepcopy
import io
import json

import pytest

from app import create_app, planning, routes
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


@pytest.fixture
def request_plan(monkeypatch, client):
    """In-memory storage isolates request contracts from filesystem behavior."""
    import copy
    state = {'plan': Plan('request', supernets=[Allocation('192.0.2.0/24', 'east')]), 'saves': 0}
    def load(*args):
        return copy.deepcopy(state['plan'])
    def save(directory, plan):
        state['saves'] += 1
        state['plan'] = copy.deepcopy(plan)
    monkeypatch.setattr(storage, 'load_plan', load)
    monkeypatch.setattr(storage, 'save_plan', save)
    return state


def request_doc(**changes):
    return dict(version=1, items=[dict(id='a', parents=['192.0.2.0/24'], prefix_length=26,
                                     name_template='{parent}-{n}', **changes)])


def envelope(client, doc, **changes):
    preview = client.post('/plans/request/carve_request/preview', json=doc).get_json()
    result = dict(carve_request=doc, plan_revision=preview['plan_revision'], selection='fitting',
                  selected_proposal_ids=[p['id'] for r in preview['results'] for p in r['proposals']])
    result.update(changes)
    return result


def test_request_prompt_preview_and_partial_commit(client, request_plan):
    prompt = client.get('/plans/request/carve_prompt')
    assert prompt.headers['Cache-Control'] == 'no-store'
    assert prompt.json['parents'][0]['direct_free_addresses'] == 256
    assert 'BEGIN PLAN DATA' in prompt.json['prompt']
    assert 'host_count' in prompt.json['prompt']
    doc = request_doc(repeat=5)
    payload = envelope(client, doc, selected_proposal_ids=['a:0:2:0'])
    assert request_plan['saves'] == 0
    response = client.post('/plans/request/commit_carve', json=payload)
    assert response.status_code == 200
    assert response.json['committed'] == ['192.0.2.128/26']
    assert request_plan['plan'].allocations[0].name == 'east-3'
    assert request_plan['saves'] == 1
    stale = client.post('/plans/request/commit_carve', json=payload)
    assert stale.status_code == 409 and stale.json['code'] == 'stale_plan'
    assert request_plan['saves'] == 1


@pytest.mark.parametrize('change', [dict(selection='all'), dict(selected_proposal_ids=[]),
    dict(selected_proposal_ids=['bogus']), dict(selected_proposal_ids=['a:0:0:0'] * 2),
    dict(selection='other'), dict(allocations=[]), dict(cidr='192.0.2.0/25')])
def test_request_rejects_selection_and_forged_fields(client, request_plan, change):
    payload = envelope(client, request_doc(repeat=5), **change)
    assert client.post('/plans/request/commit_carve', json=payload).status_code == 422
    assert request_plan['saves'] == 0


def test_request_all_split_subset_and_save_failure(client, request_plan, monkeypatch):
    doc = dict(version=1, items=[dict(id='s', parents=['192.0.2.0/24'], count=4)])
    payload = envelope(client, doc, selection='all')
    assert client.post('/plans/request/commit_carve', json=payload).status_code == 200
    assert len(request_plan['plan'].allocations) == 4
    request_plan['plan'].allocations.clear()
    payload = envelope(client, doc, selected_proposal_ids=['s:0:0:2'])
    def fail(*args):
        raise OSError('secret path')
    monkeypatch.setattr(storage, 'save_plan', fail)
    response = client.post('/plans/request/commit_carve', json=payload)
    assert response.status_code == 500
    assert 'secret path' not in response.get_data(as_text=True)
    assert request_plan['plan'].allocations == []


@pytest.mark.parametrize('raw,status,code', [('{', 400, 'invalid_json'), ('[]', 422, 'invalid_schema'),
    ('{"version":1,"version":1,"items":[]}', 400, 'invalid_json'),
    ('{"version":2,"items":[]}', 422, 'invalid_schema'), (' ' * 1048577, 413, 'request_too_large')])
def test_request_validation_never_simulates(client, request_plan, monkeypatch, raw, status, code):
    monkeypatch.setattr(routes.planning, 'simulate_carve_request', lambda *args: pytest.fail('simulation reached'))
    response = client.post('/plans/request/carve_request/preview', data=raw, content_type='application/json')
    assert response.status_code == status and response.json['code'] == code
    assert response.json['valid'] is False
    assert 'results' not in response.json
    assert request_plan['saves'] == 0
    assert response.headers['Cache-Control'] == 'no-store'


def test_request_media_missing_invalid_plan_and_revision(client, request_plan, monkeypatch):
    assert client.post('/plans/request/carve_request/preview', data='{}').status_code == 415
    payload = envelope(client, request_doc())
    request_plan['plan'].supernets[0].name = 'renamed'
    assert client.post('/plans/request/commit_carve', json=payload).status_code == 409
    assert client.get('/plans/!bad/carve_prompt').status_code == 400
    def missing(*args):
        raise FileNotFoundError()
    monkeypatch.setattr(storage, 'load_plan', missing)
    response = client.get('/plans/missing/carve_prompt')
    assert response.status_code == 404 and response.is_json


def test_legacy_keeps_partial_save(client, request_plan):
    response = client.post('/plans/request/commit_carve', json={'allocations': [
        dict(cidr='192.0.2.0/26', name='accepted'), dict(cidr='192.0.2.0/24', name='duplicate')]})
    assert response.status_code == 200 and response.json['ok']
    assert response.json['committed'] == ['192.0.2.0/26']
    assert len(response.json['rejected']) == 1
    assert request_plan['saves'] == 1


def test_split_partial_selection_preserves_metadata(client, request_plan):
    doc = dict(version=1, items=[dict(id='s', parents=['192.0.2.0/24'], count=4,
                                    name_template='{parent}-{n}', tags=['prod', 'prod'], description='keep me')])
    payload = envelope(client, doc, selected_proposal_ids=['s:0:0:3'])
    response = client.post('/plans/request/commit_carve', json=payload)
    assert response.json['committed'] == ['192.0.2.192/26']
    assert request_plan['plan'].allocations[0].to_dict() == dict(
        cidr='192.0.2.192/26', name='east-4', tags=['prod', 'prod'], description='keep me')


def test_empty_inventory_and_no_fit_are_successful_responses(client, request_plan):
    request_plan['plan'].supernets.clear()
    prompt = client.get('/plans/request/carve_prompt')
    assert prompt.status_code == 200 and prompt.json['parents'] == []
    preview = client.post('/plans/request/carve_request/preview', json=request_doc(repeat=3))
    assert preview.status_code == 200 and preview.json['valid']
    assert preview.json['summary']['failed_attempts'] == 3
    assert all(r['status'] == 'parent_not_found' for r in preview.json['results'])
    assert request_plan['saves'] == 0


# --- read-only calculator ---------------------------------------------------

@pytest.fixture
def calculator_plan(monkeypatch):
    plan = Plan('calc', supernets=[Allocation('192.0.2.0/24', 'root')])
    monkeypatch.setattr(storage, 'load_plan', lambda *args: plan)
    def forbidden(*args, **kwargs):
        pytest.fail('Calculator must never save a plan')
    monkeypatch.setattr(storage, 'save_plan', forbidden)
    return plan


def test_calculator_route_success_and_failure_are_read_only(client, calculator_plan):
    before = deepcopy(calculator_plan)
    for value, status in [('192.0.2.0/24', 200), ('192.0.2.37/24', 422),
                          ('192.0.2.0 255.255.255.0', 200), ('192.0.2.37', 200)]:
        r = client.post('/plans/calc/calculate', json={'input': value})
        assert r.status_code == status
        assert r.headers['Cache-Control'] == 'no-store'
        assert calculator_plan == before
        body = r.get_json()
        if status == 422:
            assert body['code'] == 'host_bits_set'
            assert body['suggested_cidr'] == '192.0.2.0/24'
            assert body['field'] == 'input'
        else:
            assert body['ok'] is True
            assert body['containing_supernet']['cidr'] == '192.0.2.0/24'


@pytest.mark.parametrize('payload', [None, [], 'text', 3, {}, {'input': None}, {'input': []},
    {'input': {}}, {'input': True}, {'input': 24}, {'input': ''}, {'input': 'x' * 129},
    {'input': '192.0.2.0/24', 'extra': 1}])
def test_calculator_route_invalid_body(client, calculator_plan, payload):
    r = _post_json(client, '/plans/calc/calculate', payload)
    assert r.status_code == 422
    assert r.get_json()['code'] == 'invalid_input'
    assert r.get_json()['field'] == 'input'
    assert r.get_json()['suggested_cidr'] is None
    assert r.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('data,content_type,status,code', [
    ('{', 'application/json', 400, 'invalid_json'),
    ('\xff', 'application/json', 400, 'invalid_json'),
    ('{}', 'text/plain', 415, 'unsupported_media_type'),
    (' ' * 4097, 'application/json', 413, 'request_too_large'),
])
def test_calculator_transport(client, calculator_plan, data, content_type, status, code):
    r = client.post('/plans/calc/calculate', data=data, content_type=content_type)
    assert r.status_code == status
    assert r.get_json()['code'] == code
    assert r.headers['Cache-Control'] == 'no-store'


def test_calculator_request_limits_and_query(client, calculator_plan):
    body = json.dumps({'input': '192.0.2.0/24'})
    r = client.post('/plans/calc/calculate', data=body.ljust(4096), content_type='application/json')
    assert r.status_code == 200
    r = client.post('/plans/calc/calculate?input=192.0.2.0/24', json={'input': '192.0.2.0/24'})
    assert r.status_code == 422
    assert r.get_json()['code'] == 'invalid_input'


@pytest.mark.parametrize('failure,status,code', [
    (FileNotFoundError(), 404, 'plan_not_found'),
    (ValueError('bad JSON'), 500, 'invalid_plan_data'),
    (KeyError('cidr'), 500, 'invalid_plan_data'),
])
def test_calculator_load_errors(client, calculator_plan, monkeypatch, failure, status, code):
    def fail(*args):
        raise failure
    monkeypatch.setattr(storage, 'load_plan', fail)
    r = client.post('/plans/calc/calculate', json={'input': '192.0.2.0/24'})
    assert r.status_code == status
    assert r.get_json()['code'] == code
    assert r.headers['Cache-Control'] == 'no-store'


def test_calculator_invalid_plan_cidr_and_name(client, calculator_plan):
    calculator_plan.reservations.append(Allocation('malformed', 'bad'))
    before = deepcopy(calculator_plan)
    r = client.post('/plans/calc/calculate', json={'input': '192.0.2.0/24'})
    assert r.status_code == 500
    assert r.get_json()['code'] == 'invalid_plan_data'
    assert calculator_plan == before
    r = client.post('/plans/bad%20name/calculate', json={'input': '192.0.2.0/24'})
    assert r.status_code == 400
    assert r.get_json()['code'] == 'invalid_plan_name'
    assert r.headers['Cache-Control'] == 'no-store'



def test_calculator_empty_plan_and_strict_boundary(client, calculator_plan, monkeypatch):
    calculator_plan.supernets.clear()
    original = routes.planning.parse_strict
    calls = []
    def strict(cidr):
        calls.append(cidr)
        return original(cidr)
    monkeypatch.setattr(routes.planning, 'parse_strict', strict)
    r = client.post('/plans/calc/calculate', json={'input': '192.0.2.0/31'})
    assert r.status_code == 200
    assert calls and all(cidr == '192.0.2.0/31' for cidr in calls)
    body = r.get_json()
    assert body['containing_supernet'] is None
    assert body['containing_supernets'] == []
    assert body['records_inside'] == []
    assert body['broadcast_address'] is None
    assert body['range_end'] == '192.0.2.1'
    assert body['next_prefix_subnets'] == ['192.0.2.0/32', '192.0.2.1/32']


def test_calculator_input_error_from_calculation_is_422(client, calculator_plan, monkeypatch):
    """CalcInputError subclasses ValueError; it must not fall into the 500 net."""
    def raise_input_error(*args, **kwargs):
        raise planning.CalcInputError('host_bits_set', 'Host bits are set', '192.0.2.0/24')
    monkeypatch.setattr(planning, 'calculate_network', raise_input_error)
    r = client.post('/plans/calc/calculate', json={'input': '192.0.2.0/24'})
    assert r.status_code == 422
    body = r.get_json()
    assert body['code'] == 'host_bits_set'
    assert body['field'] == 'input'
    assert body['suggested_cidr'] == '192.0.2.0/24'
    assert r.headers['Cache-Control'] == 'no-store'
