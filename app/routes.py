from __future__ import annotations

from pathlib import Path

from flask import (
    Blueprint, abort, current_app, flash, jsonify, redirect,
    render_template, request, url_for,
)

from . import infoblox, planning, storage
from .models import Allocation

bp = Blueprint("main", __name__)


def _plans_dir() -> Path:
    return current_app.config["PLANS_DIR"]


def _load_or_404(name: str):
    try:
        return storage.load_plan(_plans_dir(), name)
    except FileNotFoundError:
        abort(404, description=f"Plan '{name}' not found")
    except ValueError as e:
        abort(400, description=str(e))


@bp.get("/")
def index():
    plans = storage.list_plans(_plans_dir())
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


@bp.get("/plans/<name>")
def view_plan(name: str):
    plan = _load_or_404(name)
    tree = planning.build_tree(plan)
    conflicts = planning.find_conflicts(plan)
    return render_template(
        "plan.html",
        plan=plan,
        tree=tree,
        conflicts=conflicts,
    )


@bp.get("/plans/<name>/tree.json")
def tree_json(name: str):
    plan = _load_or_404(name)
    tree = planning.build_tree(plan)
    return jsonify(tree)


@bp.post("/plans/<name>/supernet")
def add_supernet(name: str):
    plan = _load_or_404(name)
    cidr = (request.form.get("cidr") or "").strip()
    label = (request.form.get("name") or "").strip()
    description = (request.form.get("description") or "").strip()
    try:
        planning.parse_strict(cidr)
    except ValueError as e:
        flash(f"Invalid CIDR: {e}", "error")
        return redirect(url_for("main.view_plan", name=name))
    ok, reason = planning.validate_new_allocation(plan, cidr)
    if not ok:
        flash(reason, "error")
        return redirect(url_for("main.view_plan", name=name))
    plan.supernets.append(Allocation(cidr=str(planning.parse(cidr)), name=label, description=description))
    storage.save_plan(_plans_dir(), plan)
    flash(f"Added supernet {cidr}", "ok")
    return redirect(url_for("main.view_plan", name=name))


@bp.post("/plans/<name>/allocate")
def add_allocation(name: str):
    plan = _load_or_404(name)
    cidr = (request.form.get("cidr") or "").strip()
    label = (request.form.get("name") or "").strip()
    description = (request.form.get("description") or "").strip()
    try:
        planning.parse_strict(cidr)
    except ValueError as e:
        flash(f"Invalid CIDR: {e}", "error")
        return redirect(url_for("main.view_plan", name=name))
    ok, reason = planning.validate_new_allocation(plan, cidr)
    if not ok:
        flash(reason, "error")
        return redirect(url_for("main.view_plan", name=name))
    plan.allocations.append(Allocation(cidr=str(planning.parse(cidr)), name=label, description=description))
    storage.save_plan(_plans_dir(), plan)
    flash(f"Added allocation {cidr}", "ok")
    return redirect(url_for("main.view_plan", name=name))


@bp.post("/plans/<name>/carve")
def carve(name: str):
    plan = _load_or_404(name)
    parent = (request.form.get("parent") or "").strip()
    mode = (request.form.get("mode") or "").strip()
    value_s = (request.form.get("value") or "").strip()
    label = (request.form.get("new_name") or "").strip()
    description = (request.form.get("description") or "").strip()
    commit = request.form.get("commit") == "1"

    try:
        value = int(value_s)
    except ValueError:
        flash("Value must be an integer.", "error")
        return redirect(url_for("main.view_plan", name=name))

    kwargs: dict[str, int] = {}
    if mode == "prefix":
        kwargs["prefix_length"] = value
    elif mode == "hosts":
        kwargs["host_count"] = value
    elif mode == "split":
        kwargs["count"] = value
    else:
        flash(f"Unknown carve mode: {mode}", "error")
        return redirect(url_for("main.view_plan", name=name))

    existing = [s.cidr for s in plan.supernets] + [a.cidr for a in plan.allocations]
    try:
        suggestions = planning.carve(parent, existing, **kwargs)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("main.view_plan", name=name))

    if not suggestions:
        flash(f"No free slot in {parent} matches that request.", "error")
        return redirect(url_for("main.view_plan", name=name))

    if not commit:
        flash(
            f"Suggested: {', '.join(suggestions)}. "
            "Submit again with 'Confirm' checked to commit.",
            "info",
        )
        return redirect(url_for("main.view_plan", name=name))

    for i, cidr in enumerate(suggestions):
        alloc_name = label if len(suggestions) == 1 else f"{label} #{i + 1}" if label else ""
        ok, reason = planning.validate_new_allocation(plan, cidr)
        if not ok:
            flash(f"Rejected {cidr}: {reason}", "error")
            continue
        plan.allocations.append(Allocation(cidr=cidr, name=alloc_name, description=description))
    storage.save_plan(_plans_dir(), plan)
    flash(f"Committed: {', '.join(suggestions)}", "ok")
    return redirect(url_for("main.view_plan", name=name))


@bp.post("/plans/<name>/import_infoblox")
def import_infoblox(name: str):
    plan = _load_or_404(name)
    file = request.files.get("file")
    if not file or not file.filename:
        flash("No file uploaded.", "error")
        return redirect(url_for("main.view_plan", name=name))
    try:
        text = file.read().decode("utf-8", errors="replace")
    except Exception as e:
        flash(f"Could not read upload: {e}", "error")
        return redirect(url_for("main.view_plan", name=name))

    result = infoblox.parse_infoblox_csv(text)

    added_super = added_alloc = skipped_dup = 0
    rejected: list[str] = []

    for s in result["supernets"]:
        ok, reason = planning.validate_new_allocation(plan, s.cidr)
        if not ok:
            if "duplicate" in reason.lower():
                skipped_dup += 1
            else:
                rejected.append(f"{s.cidr}: {reason}")
            continue
        plan.supernets.append(s)
        added_super += 1

    for a in result["allocations"]:
        ok, reason = planning.validate_new_allocation(plan, a.cidr)
        if not ok:
            if "duplicate" in reason.lower():
                skipped_dup += 1
            else:
                rejected.append(f"{a.cidr}: {reason}")
            continue
        plan.allocations.append(a)
        added_alloc += 1

    if added_super or added_alloc:
        storage.save_plan(_plans_dir(), plan)

    summary = f"Imported {added_super} supernets, {added_alloc} allocations"
    extras = []
    if skipped_dup:
        extras.append(f"skipped {skipped_dup} duplicates")
    if rejected:
        extras.append(f"{len(rejected)} rejected (overlap)")
    if result["errors"]:
        extras.append(f"{len(result['errors'])} parse errors")
    if extras:
        summary += " (" + "; ".join(extras) + ")"
    flash(summary + ".", "ok" if (added_super or added_alloc) else "info")
    for e in result["errors"][:10]:
        flash(e, "error")
    for r in rejected[:10]:
        flash(r, "error")
    return redirect(url_for("main.view_plan", name=name))


@bp.post("/plans/<name>/delete")
def delete_allocation(name: str):
    plan = _load_or_404(name)
    cidr = (request.form.get("cidr") or "").strip()
    kind = request.form.get("kind", "allocation")
    if kind == "supernet":
        plan.supernets = [s for s in plan.supernets if s.cidr != cidr]
    else:
        plan.allocations = [a for a in plan.allocations if a.cidr != cidr]
    storage.save_plan(_plans_dir(), plan)
    flash(f"Removed {cidr}", "ok")
    return redirect(url_for("main.view_plan", name=name))
