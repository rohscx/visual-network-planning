from __future__ import annotations

from pathlib import Path
from functools import wraps
import hashlib
import json

from flask import (
    Blueprint, abort, current_app, flash, jsonify, redirect,
    render_template, request, url_for,
)

from . import carve_request, infoblox, planning, storage
from .models import Allocation, Plan

bp = Blueprint("main", __name__)


# Generous request-size caps so a malformed client can't lock the request
# thread in a validation loop. Both are well above any normal workload.
_MAX_COMMIT_ALLOCS = 256        # multi-parent carve × repeat
_MAX_IMPORT_ROWS   = 10_000     # Infoblox CSV row count after parse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _plans_dir() -> Path:
    return current_app.config["PLANS_DIR"]


def _load_or_404(name: str):
    try:
        return storage.load_plan(_plans_dir(), name)
    except FileNotFoundError:
        abort(404, description=f"Plan '{name}' not found")
    except ValueError as e:
        abort(400, description=str(e))


def _params() -> dict:
    """Read params from JSON body or form, whichever the client sent."""
    if request.is_json:
        return request.get_json(silent=True) or {}
    return {k: v for k, v in request.form.items()}


def _split_tags(value) -> list[str]:
    """Accept either a comma-separated string or a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(t).strip() for t in value if str(t).strip()]
    return [t.strip() for t in str(value).split(",") if t.strip()]


# ---------------------------------------------------------------------------
# Plans index
# ---------------------------------------------------------------------------

def _plan_metadata(name: str) -> dict:
    """Compact stats for the index table."""
    try:
        plan = storage.load_plan(_plans_dir(), name)
    except (FileNotFoundError, ValueError):
        return {"name": name, "error": True}

    tree = planning.build_tree(plan)
    conflicts = planning.find_conflicts(plan)
    orphans = planning.find_orphans(plan)

    total_addresses = 0
    free_addresses = 0
    for root in tree["roots"]:
        total_addresses += root["total_addresses"]
        free_addresses += root["free_addresses"]
    pct = round(100 * (total_addresses - free_addresses) / total_addresses, 1) if total_addresses else 0.0

    if plan.supernets:
        scope = ", ".join(s.cidr for s in plan.supernets[:2])
        if len(plan.supernets) > 2:
            scope += f" +{len(plan.supernets) - 2}"
    else:
        scope = "—"

    if conflicts:
        status = ("err", f"{len(conflicts)} conflict{'s' if len(conflicts) != 1 else ''}")
    elif orphans:
        status = ("warn", f"{len(orphans)} orphan{'s' if len(orphans) != 1 else ''}")
    else:
        status = ("ok", "healthy")

    return {
        "name": name,
        "scope": scope,
        "supernets": len(plan.supernets),
        "allocations": len(plan.allocations),
        "utilization_pct": pct,
        "modified": storage.plan_modified(_plans_dir(), name),
        "status_kind": status[0],
        "status_label": status[1],
    }


@bp.get("/")
def index():
    names = storage.list_plans(_plans_dir())
    plans = [_plan_metadata(n) for n in names]
    return render_template("index.html", plans=plans)


@bp.post("/plans")
def create_plan():
    name = (request.form.get("name") or "").strip()
    try:
        storage.create_plan(_plans_dir(), name)
    except (ValueError, FileExistsError) as e:
        flash(str(e), "error")
        return redirect(url_for("main.index"))
    return redirect(url_for("main.view_plan", name=name))


@bp.post("/plans/<name>/delete_plan")
def delete_plan(name: str):
    path = storage.plan_path(_plans_dir(), name)
    if path.exists():
        path.unlink()
    return redirect(url_for("main.index"))


@bp.post("/plans/<name>/copy")
def copy_plan(name: str):
    new_name = (request.form.get("new_name") or "").strip()
    try:
        storage.copy_plan(_plans_dir(), name, new_name)
    except (ValueError, FileExistsError, FileNotFoundError) as e:
        flash(str(e), "error")
        return redirect(url_for("main.index"))
    return redirect(url_for("main.view_plan", name=new_name))


@bp.post("/plans/<name>/rename")
def rename_plan(name: str):
    new_name = (request.form.get("new_name") or "").strip()
    try:
        storage.rename_plan(_plans_dir(), name, new_name)
    except (ValueError, FileExistsError, FileNotFoundError) as e:
        flash(str(e), "error")
        return redirect(url_for("main.index"))
    return redirect(url_for("main.view_plan", name=new_name))


# ---------------------------------------------------------------------------
# Plan view (SPA shell)
# ---------------------------------------------------------------------------

@bp.get("/plans/<name>")
def view_plan(name: str):
    # Existence check; the JS fetches data via /plan.json.
    _load_or_404(name)
    return render_template("plan.html", plan_name=name)


@bp.get("/plans/<name>/plan.json")
def plan_json(name: str):
    """Single source of truth for the plan view: raw plan + computed tree +
    conflicts + orphans."""
    plan = _load_or_404(name)
    tree = planning.build_tree(plan)
    conflicts = planning.find_conflicts(plan)
    orphans = planning.find_orphans(plan)
    resp = jsonify({
        "name": plan.name,
        "supernets": [s.to_dict() for s in plan.supernets],
        "allocations": [a.to_dict() for a in plan.allocations],
        "reservations": [r.to_dict() for r in plan.reservations],
        "tree": tree,
        "conflicts": [list(p) for p in conflicts],
        "orphans": orphans,
    })
    # The plan view re-fetches this after every mutation; never let a cache
    # serve a stale snapshot.
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


@bp.get("/plans/<name>/tree.json")
def tree_json(name: str):
    """Kept for backward compatibility / external integrations."""
    plan = _load_or_404(name)
    return jsonify(planning.build_tree(plan))


# ---------------------------------------------------------------------------
# Mutating routes (JSON-friendly; some still take form data)
# ---------------------------------------------------------------------------

def _add_one(plan, *, kind: str, cidr: str, name: str, description: str, tags: list[str]):
    """Validate + append to plan in-memory. Returns (ok, reason)."""
    try:
        planning.parse_strict(cidr)
    except ValueError as e:
        return False, f"Invalid CIDR: {e}"
    ok, reason = planning.validate_new_allocation(plan, cidr)
    if not ok:
        return False, reason
    canonical = str(planning.parse(cidr))
    rec = Allocation(cidr=canonical, name=name, description=description, tags=tags)
    if kind == "supernet":
        plan.supernets.append(rec)
    elif kind == "reservation":
        plan.reservations.append(rec)
    else:
        plan.allocations.append(rec)
    return True, ""


@bp.post("/plans/<name>/add")
def add_record(name: str):
    """Unified add endpoint. Body: kind=supernet|allocation, cidr, name,
    description, tags (comma-separated string OR list)."""
    p = _params()
    kind = (p.get("kind") or "supernet").strip()
    if kind not in ("supernet", "allocation", "reservation"):
        return jsonify(ok=False, error=f"unknown kind: {kind}"), 400
    return _add_kind(name, kind)


def _add_kind(name: str, kind: str):
    plan = _load_or_404(name)
    p = _params()
    cidr = (p.get("cidr") or "").strip()
    label = (p.get("name") or "").strip()
    description = (p.get("description") or "").strip()
    tags = _split_tags(p.get("tags"))
    ok, reason = _add_one(plan, kind=kind, cidr=cidr, name=label,
                          description=description, tags=tags)
    if not ok:
        return jsonify(ok=False, error=reason), 400
    storage.save_plan(_plans_dir(), plan)
    return jsonify(ok=True)


# Backward-compatible aliases used by older clients / direct curl tests.
@bp.post("/plans/<name>/supernet")
def add_supernet(name: str):
    return _add_kind(name, "supernet")


@bp.post("/plans/<name>/allocate")
def add_allocation(name: str):
    return _add_kind(name, "allocation")


@bp.post("/plans/<name>/edit")
def edit_record(name: str):
    """Update name/description/tags on an existing supernet, allocation, or
    reservation."""
    plan = _load_or_404(name)
    p = _params()
    cidr = (p.get("cidr") or "").strip()
    rec = (next((s for s in plan.supernets    if s.cidr == cidr), None)
        or next((a for a in plan.allocations  if a.cidr == cidr), None)
        or next((r for r in plan.reservations if r.cidr == cidr), None))
    if rec is None:
        return jsonify(ok=False, error=f"{cidr} not found"), 404
    rec.name = (p.get("name") or "").strip()
    rec.description = (p.get("description") or "").strip()
    rec.tags = _split_tags(p.get("tags"))
    storage.save_plan(_plans_dir(), plan)
    return jsonify(ok=True)


@bp.post("/plans/<name>/reclassify")
def reclassify_record(name: str):
    """Move an existing record between supernet / allocation / reservation
    buckets. Sibling to /edit so each route handles one concern."""
    plan = _load_or_404(name)
    p = _params()
    cidr = (p.get("cidr") or "").strip()
    new_kind = (p.get("new_kind") or "").strip()
    try:
        storage.reclassify_record(plan, cidr, new_kind)
    except KeyError as e:
        # str(KeyError("msg")) wraps in quotes; .args[0] gets the raw message.
        return jsonify(ok=False, error=e.args[0]), 400
    except ValueError as e:
        return jsonify(ok=False, error=str(e)), 400
    storage.save_plan(_plans_dir(), plan)
    return jsonify(ok=True)


@bp.post("/plans/<name>/delete")
def delete_record(name: str):
    plan = _load_or_404(name)
    p = _params()
    cidr = (p.get("cidr") or "").strip()
    kind = p.get("kind", "allocation")
    before = (len(plan.supernets), len(plan.allocations), len(plan.reservations))
    if kind == "supernet":
        plan.supernets = [s for s in plan.supernets if s.cidr != cidr]
    elif kind == "reservation":
        plan.reservations = [r for r in plan.reservations if r.cidr != cidr]
    else:
        plan.allocations = [a for a in plan.allocations if a.cidr != cidr]
    after = (len(plan.supernets), len(plan.allocations), len(plan.reservations))
    if before == after:
        return jsonify(ok=False, error=f"{cidr} not found"), 404
    storage.save_plan(_plans_dir(), plan)
    return jsonify(ok=True)


def _commit_legacy(name: str, p: dict):
    """Apply pre-computed allocations, saving accepted entries even if others fail.

    Body (JSON): {
        "allocations": [
            {"cidr": "...", "name": "...", "description": "...", "tags": [...]},
            ...
        ]
    }

    Each entry is validated through validate_new_allocation against the plan
    *as it grows*, so two same-CIDR proposals would reject the second.
    """
    plan = _request_plan(name)
    items = p.get("allocations") or []
    if not isinstance(items, list) or not items:
        return jsonify(ok=False, error="no allocations to commit"), 400
    # Bound the request so a malformed client (or a bored DevTools user)
    # can't push thousands of validation passes through a single request.
    # Normal carve sessions never approach this — the user's biggest
    # multi-parent carve so far was 49 parents × 1 repeat.
    if len(items) > _MAX_COMMIT_ALLOCS:
        return jsonify(
            ok=False,
            error=f"too many allocations ({len(items)}); cap is {_MAX_COMMIT_ALLOCS}",
        ), 400

    if any(not isinstance(entry, dict)
           or any(not isinstance(entry.get(k, ''), str) for k in ('cidr', 'name', 'description'))
           or not isinstance(entry.get('tags', []), (list, str))
           for entry in items):
        return jsonify(ok=False, error="invalid allocation fields"), 400
    committed = []
    rejected = []
    for entry in items:
        cidr = (entry.get("cidr") or "").strip()
        try:
            planning.parse_strict(cidr)
        except ValueError as e:
            rejected.append({"cidr": cidr, "error": f"invalid CIDR: {e}"})
            continue
        ok, reason = planning.validate_new_allocation(plan, cidr)
        if not ok:
            rejected.append({"cidr": cidr, "error": reason})
            continue
        plan.allocations.append(Allocation(
            cidr=str(planning.parse(cidr)),
            name=(entry.get("name") or "").strip(),
            description=(entry.get("description") or "").strip(),
            tags=[t for t in (entry.get("tags") or []) if isinstance(t, str)],
        ))
        committed.append(cidr)

    if committed:
        storage.save_plan(_plans_dir(), plan)
    return jsonify(ok=bool(committed), committed=committed, rejected=rejected)


# ---------------------------------------------------------------------------
# Infoblox CSV import (multipart-form upload, returns JSON)
# ---------------------------------------------------------------------------

@bp.post("/plans/<name>/import_infoblox")
def import_infoblox(name: str):
    plan = _load_or_404(name)
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify(ok=False, error="no file uploaded"), 400
    try:
        text = file.read().decode("utf-8", errors="replace")
    except Exception as e:
        return jsonify(ok=False, error=f"could not read upload: {e}"), 400

    result = infoblox.parse_infoblox_csv(text)

    # Bound the import. A 16 MB cap on the upload size already lives in
    # app/__init__.py, but a small file can still expand into a huge row
    # count if it's pure data with short fields. This guards the
    # downstream validation loop.
    total_rows = len(result["supernets"]) + len(result["allocations"])
    if total_rows > _MAX_IMPORT_ROWS:
        return jsonify(
            ok=False,
            error=(f"import has {total_rows} rows; cap is {_MAX_IMPORT_ROWS}. "
                   "Split the file or raise _MAX_IMPORT_ROWS in app/routes.py."),
        ), 400

    added_super = added_alloc = skipped_dup = 0
    rejected: list[dict] = []

    for s in result["supernets"]:
        ok, reason = planning.validate_new_allocation(plan, s.cidr)
        if not ok:
            if "duplicate" in reason.lower():
                skipped_dup += 1
            else:
                rejected.append({"cidr": s.cidr, "error": reason})
            continue
        plan.supernets.append(s)
        added_super += 1

    for a in result["allocations"]:
        ok, reason = planning.validate_new_allocation(plan, a.cidr)
        if not ok:
            if "duplicate" in reason.lower():
                skipped_dup += 1
            else:
                rejected.append({"cidr": a.cidr, "error": reason})
            continue
        plan.allocations.append(a)
        added_alloc += 1

    if added_super or added_alloc:
        storage.save_plan(_plans_dir(), plan)
    return jsonify(
        ok=True,
        added_supernets=added_super,
        added_allocations=added_alloc,
        skipped_duplicates=skipped_dup,
        rejected=rejected,
        parse_errors=result["errors"],
    )


def _request_response(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            result = fn(*args, **kwargs)
        except carve_request.RequestError as exc:
            result = (jsonify(ok=False, valid=False, code=exc.code, error=str(exc), errors=exc.errors), exc.status)
        except Exception:
            current_app.logger.exception('Carve request failed')
            result = (jsonify(ok=False, code='request_failed', error='Could not process or save request'), 500)
        response = current_app.make_response(result)
        response.headers['Cache-Control'] = 'no-store'
        return response
    return wrapped


def _request_plan(name):
    try:
        storage.safe_name(name)
    except ValueError as exc:
        raise carve_request.RequestError('invalid_plan_name', 'Invalid plan name', 400) from exc
    try:
        return storage.load_plan(_plans_dir(), name)
    except FileNotFoundError as exc:
        raise carve_request.RequestError('plan_not_found', 'Plan not found', 404) from exc


def _plan_revision(plan):
    raw = json.dumps(plan.to_dict(), sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _request_json():
    if not request.is_json:
        raise carve_request.RequestError('unsupported_media_type', 'Expected application/json', 415)
    if request.content_length and request.content_length > carve_request.MAX_REQUEST_BYTES:
        raise carve_request.RequestError('request_too_large', 'Request exceeds 1 MiB', 413)
    return carve_request.decode(request.stream.read(carve_request.MAX_REQUEST_BYTES + 1))


@bp.get('/plans/<name>/carve_prompt')
@_request_response
def carve_prompt(name: str):
    plan = _request_plan(name)
    revision = _plan_revision(plan)
    parents, warnings = planning.request_parent_inventory(plan)
    return jsonify(ok=True, version=1, plan_revision=revision, parents=parents, warnings=warnings,
                   limits=dict(max_allocations=_MAX_COMMIT_ALLOCS, max_repeat=64,
                               max_request_bytes=carve_request.MAX_REQUEST_BYTES),
                   prompt=carve_request.format_prompt(name, revision, parents, warnings, _MAX_COMMIT_ALLOCS))


@bp.post('/plans/<name>/carve_request/preview')
@_request_response
def preview_carve_request(name: str):
    document = carve_request.normalize(_request_json(), _MAX_COMMIT_ALLOCS)
    plan = _request_plan(name)
    return jsonify(ok=True, valid=True, plan_revision=_plan_revision(plan),
                   **planning.simulate_carve_request(plan, document, _MAX_COMMIT_ALLOCS))


@bp.post('/plans/<name>/commit_carve')
@_request_response
def commit_carve(name: str):
    payload = _request_json()
    if not isinstance(payload, dict):
        raise carve_request.RequestError('invalid_schema', 'Expected an object')
    if 'allocations' in payload and 'carve_request' not in payload:
        return _commit_legacy(name, payload)
    allowed = {'carve_request', 'plan_revision', 'selection', 'selected_proposal_ids'}
    if set(payload) != allowed or not isinstance(payload.get('plan_revision'), str):
        raise carve_request.RequestError('invalid_schema', 'Expected request, revision, selection and proposal IDs only')
    document = carve_request.normalize(payload['carve_request'], _MAX_COMMIT_ALLOCS)
    ids = payload['selected_proposal_ids']
    selection = payload['selection']
    if (selection not in ('all', 'fitting') or not isinstance(ids, list) or not ids
            or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids)):
        raise carve_request.RequestError('invalid_selection', 'Select a nonempty unique list of successful proposal IDs')
    plan = _request_plan(name)
    if payload['plan_revision'] != _plan_revision(plan):
        return jsonify(ok=False, code='stale_plan', error='Plan changed; preview again', committed=[], rejected=[]), 409
    simulated = planning.simulate_carve_request(plan, document, _MAX_COMMIT_ALLOCS)
    proposals = [p for r in simulated['results'] for p in r['proposals']]
    available = {p['id'] for p in proposals}
    selected = set(ids)
    if not selected <= available or (selection == 'all' and (
            not simulated['summary']['all_fit'] or selected != available)):
        raise carve_request.RequestError('invalid_selection', 'Selection does not match successful preview proposals')
    trial = Plan.from_dict(plan.to_dict())
    committed = []
    for proposal in proposals:
        if proposal['id'] not in selected:
            continue
        ok, reason = planning.validate_new_allocation(trial, proposal['cidr'])
        if not ok:
            return jsonify(ok=False, code='allocation_conflict', error=reason, committed=[], rejected=[]), 409
        trial.allocations.append(Allocation(proposal['cidr'], proposal['name'],
                                            proposal['description'], list(proposal['tags'])))
        committed.append(proposal['cidr'])
    storage.save_plan(_plans_dir(), trial)
    return jsonify(ok=True, committed=committed, rejected=[])


@bp.post("/plans/<name>/calculate")
def calculate(name: str):
    def response(body, status=200):
        result = jsonify(body)
        result.status_code = status
        result.headers["Cache-Control"] = "no-store"
        return result

    def error(code, message, status):
        return response(dict(ok=False, code=code, error=message), status)

    if request.mimetype != "application/json":
        return error("unsupported_media_type", "Expected application/json", 415)
    if request.content_length and request.content_length > 4096:
        return error("request_too_large", "Request exceeds 4 KiB", 413)
    raw = request.stream.read(4097)
    if len(raw) > 4096:
        return error("request_too_large", "Request exceeds 4 KiB", 413)
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        return error("invalid_json", "Malformed JSON", 400)
    try:
        if request.args or not isinstance(body, dict) or set(body) != {"input"}:
            raise planning.CalcInputError("invalid_input", 'Send exactly {"input": "..."} without query parameters.')
        planning.parse_calculator_input(body["input"])
    except planning.CalcInputError as exc:
        return response(dict(ok=False, code=exc.code, error=exc.message,
                             field="input", suggested_cidr=exc.suggested_cidr), 422)
    try:
        storage.safe_name(name)
    except ValueError:
        return error("invalid_plan_name", "Invalid plan name", 400)
    try:
        plan = storage.load_plan(_plans_dir(), name)
        result = planning.calculate_network(body["input"], plan)
    except FileNotFoundError:
        return error("plan_not_found", "Plan not found", 404)
    # CalcInputError subclasses ValueError, so it must be caught ahead of the
    # plan-data net below or a 422 would be reported as a 500.
    except planning.CalcInputError as exc:
        return response(dict(ok=False, code=exc.code, error=exc.message,
                             field="input", suggested_cidr=exc.suggested_cidr), 422)
    except (ValueError, TypeError, KeyError, AttributeError):
        return error("invalid_plan_data", "Plan contains invalid data", 500)
    return response(result)
