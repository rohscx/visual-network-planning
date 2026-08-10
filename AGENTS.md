# AGENTS.md

Conventions for contributors — both human and AI — working on this repo.

## Project at a glance

- **Purpose:** local, single-user, web-based IPv4 network range planning.
- **Stack:** Python + Flask + Jinja2 + vanilla JS + D3 (CDN). No build step,
  no database. Standard-library `ipaddress` handles all CIDR math.
- **Entry point:** `run.py` serves the app on `http://127.0.0.1:5000`.

Read [README.md](README.md) first for the user-facing overview.

## Environment

Always work in a project-local virtualenv at `.venv/`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Do not add system-wide installs, Docker, Poetry, or other packaging layers
without discussion — the project is deliberately minimal so a new contributor
can be running in under a minute.

## Layer boundaries — respect these

```
app/planning.py    pure logic over ipaddress; no Flask, no I/O, no globals
app/infoblox.py    pure CSV parser for Infoblox exports; no Flask, no I/O
app/storage.py     JSON load/save; no Flask
app/models.py      dataclasses; no Flask
app/routes.py      HTTP surface; calls planning + infoblox + storage
app/templates/     Jinja: index.html (server-rendered table) + plan.html (SPA shell)
app/static/        CSS + D3 viz.js (no build step, load D3 from CDN)
```

The **plans index** is server-rendered (a static table). The **plan view** is
a thin Jinja shell that fetches `/plans/<name>/plan.json` once at load and
re-fetches after every mutation; almost all interactivity lives in
`app/static/viz.js`. Mutating routes return JSON (`{ok, error?}`) — no
flash-redirect cycle on the plan page.

**Rule:** `planning.py` stays pure. No imports from Flask, no file I/O, no
global state. Every function takes data in and returns data out. This is what
makes the unit tests fast and honest — keep it that way.

## IPv4 semantics

- User input must go through `planning.parse_strict()` at the route boundary.
  It rejects misaligned CIDRs like `10.0.0.128/23` with host bits set, which
  Python's `ipaddress` would otherwise silently normalize.
- Aligned CIDRs can only be *disjoint* or in a *containment* relationship —
  partial overlaps are mathematically impossible. And since `planning.parse()`
  normalizes host bits (`strict=False`), even hand-edited misaligned JSON
  becomes aligned on load. `find_conflicts` therefore only detects
  *duplicates after normalization* (same parsed network from two entries) —
  there is no partial-overlap branch because none is reachable.
- Duplicate detection (two entries resolving to the same network, possibly
  across buckets) *is* a real runtime case and must stay covered.
- `planning.parse()` is `lru_cache`d — it must stay a pure function of its
  string argument, and `IPv4Network` results must never be mutated.
- `build_tree` assigns parents with a sorted containment sweep (O(N log N)),
  relying on the laminar-family property of aligned CIDRs. If you ever relax
  the alignment guarantee, that sweep's correctness argument goes with it.

## Three entry types

A plan tracks three flat lists of `Allocation` records:

- **`supernets`** — top-level blocks the engineer owns. Roots of the tree.
- **`allocations`** — existing or newly-carved subnets. Children of supernets.
- **`reservations`** — ranges held off-limits. Treated like allocations for
  containment, conflict, and free-space purposes (they consume space), but
  the carve algorithm never lands inside one because reservations are
  filtered out of `eligibleParents()` in the frontend and they show up in
  the `used` set passed to `_free_space()` on the backend. Visually
  distinguished by a dashed warn-color border.

When adding logic that iterates "everything in the plan," use
`planning._all_owned_pairs(plan)` to get all three kinds at once — don't
write a new `supernets + allocations` chain that silently skips
reservations.

## Carve modes

`planning.carve()` accepts exactly one of:

- `prefix_length=N` — first free slot of that prefix
- `host_count=N` — smallest prefix whose usable-host count covers N (accounts
  for network + broadcast addresses)
- `count=N` — equal split of the parent into N power-of-two subnets (only
  valid when the parent is entirely free)

Passing more than one or none raises `ValueError`. Tests enforce this.

## Infoblox CSV import

`app/infoblox.py` parses real Infoblox network/networkcontainer CSV exports.
Conventions:

- `header-<type>` rows carry the schema; multiple may appear and the most
  recent wins for that type. Required columns end in `*` (stripped on read).
- `network` rows become allocations; `networkcontainer` rows become
  supernets. Other Infoblox object types are silently ignored.
- `netmask*` accepts both dotted-quad (`255.255.255.0`) and integer
  prefixes (`24`); `ipaddress.IPv4Network` handles both.
- Name comes from `EA-Network Name`, falling back to `comment`. Tags come
  from `EA-TAGS` split on commas. Description is the `comment` field.
- Errors (bad address, missing fields, data row before header) are
  collected per-row and returned in `result["errors"]` — the parser never
  raises on bad input; it carries on and reports.

Real exports may contain identifying organizational data (ticket numbers,
person names, AWS account IDs). **Never commit a real export.** Tests use
RFC 5737 documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`) and inline string fixtures.

The accepted CSV format (required columns, multiple-header behavior,
mapping into the plan model, error handling) is documented in
[`docs/infoblox-csv-schema.md`](docs/infoblox-csv-schema.md). Keep that
doc in sync with `app/infoblox.py` if you change parser behavior.

There is also an Agent Skill at [`skills/vnp-csv-import/`](skills/vnp-csv-import/)
that teaches an LLM to author these files. It bundles
`scripts/validate_vnp_csv.py`, a stdlib-only reimplementation of the
importer's parsing rules. **If you change `app/infoblox.py`, update that
validator too** — the two are differential-tested against each other, and
a drift means the skill starts vouching for files the importer rejects.

## Persistence

- One plan per file: `plans/<name>.json`.
- Plan names are validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` in
  `storage.safe_name` — don't relax this.
- `save_plan` writes to `<path>.tmp` then `os.replace`s, so partial writes
  never corrupt an existing plan. Preserve this pattern for any new writer.
- `plans/*.json` is **gitignored**. Contributors' own plan data never enters
  this repo. Do not add example plans with real-looking addresses.

## Testing

- All logic changes to `planning.py` must land with a pytest case in
  `tests/test_planning.py`.
- `pytest` must pass with zero failures before any commit or PR.
- Tests are synchronous, stdlib-only, and run in well under a second. Keep
  it that way — no fixtures that touch the network, clock, or disk.

```bash
source .venv/bin/activate
pytest
```

## Coding style

- Python 3.10+ syntax (`list[str]`, `X | None`, `match`/`case` if helpful).
  `from __future__ import annotations` at the top of each module.
- Dataclasses for data types. No ORMs. No Pydantic. Stdlib only in the core.
- Comments are rare: only when *why* is non-obvious. Don't narrate *what*
  well-named code already shows.
- No third-party CIDR libraries — `ipaddress` is sufficient and precise.
- No JavaScript build tooling. The viz stays in `static/viz.js` as a
  single-file IIFE; D3 loads from the CDN.

## Security posture

This app is **local-only**. It has no authentication, no CSRF tokens, and
binds to `127.0.0.1` by default. Do not add features that assume or enable
remote access without also adding proper auth, CSRF protection, and an
explicit opt-in flag — and discuss the change first.

Never commit:

- Real environment addressing (use `10.0.0.0/16`, `192.0.2.0/24`, etc. for
  examples — documentation ranges from RFC 5737).
- `.claude/settings.local.json` or any other personal tool config.
- `.venv/`, `__pycache__/`, `.pytest_cache/` — all gitignored.

## Pull requests

Before opening a PR:

1. `pytest` passes.
2. README.md and AGENTS.md are updated if behavior or conventions changed.
3. No unrelated refactors piggybacking on the change.
4. Commit messages describe the *why*, not just the *what*.

## Common agent pitfalls

- **Introducing ORMs, async, Pydantic, npm:** don't. Scope creep is a real
  regression here.
- **Silently normalizing misaligned CIDRs:** use `parse_strict` at the
  boundary and let users see the error.
- **Assuming partial overlap is possible between aligned CIDRs:** it isn't.
  Model conflicts as duplicates + orphans + misalignment, not as overlap.
- **Writing example plans into `plans/`:** that directory is per-user data.
  Put example fixtures under `tests/` if they're needed.
