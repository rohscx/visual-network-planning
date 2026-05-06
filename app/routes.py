from __future__ import annotations

from pathlib import Path

from flask import (
    Blueprint, abort, current_app, flash, jsonify, redirect,
    render_template, request, url_for,
)

from . import infoblox, planning, storage
from .models import Allocation

bp = Blueprint("main", __name__)


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
    used_addresses = 0
    for root in tree["roots"]:
        total_addresses += root["total_addresses"]
        used_addresses += root["used_addresses"]
    pct = round(100 * used_addresses / total_addresses, 1) if total_addresses else 0.0

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


@bp.post("/plans/<name>/commit_carve")
def commit_carve(name: str):
    """Apply a list of pre-computed carved allocations atomically.

    Body (JSON): {
        "allocations": [
            {"cidr": "...", "name": "...", "description": "...", "tags": [...]},
            ...
        ]
    }

    Each entry is validated through validate_new_allocation against the plan
    *as it grows*, so two same-CIDR proposals would reject the second.
    """
    plan = _load_or_404(name)
    p = _params()
    items = p.get("allocations") or []
    if not isinstance(items, list) or not items:
        return jsonify(ok=False, error="no allocations to commit"), 400

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
