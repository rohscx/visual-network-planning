# Visual Network Planning

A small, single-user, web-based **IPv4 network range planning** tool. Seed it
with your existing supernets and allocations, carve out new subnets
interactively, see the hierarchy and free space at a glance, and get warned
about overlaps.

Built with Flask + vanilla JS + D3. No build step, no database, no account
system. Plans are plain JSON files on disk — easy to diff, easy to commit to
your own private repo.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 run.py
```

Opens `http://127.0.0.1:5050` in your browser.

> Use `python3`, not `python`. On stock Ubuntu / Debian / WSL the bare
> `python` command isn't linked by default (it lives in the
> `python-is-python3` package). `python3` works everywhere.

## Offline / air-gapped install

If the host where you want to run vnp can't reach PyPI, grab
`vnp-deps.tar.gz` from the
[Releases](https://github.com/rohscx/visual-network-planning/releases)
page. It bundles every Python dependency vnp needs as wheels — pure-Python
ones once, plus MarkupSafe's compiled wheels for **macOS arm64** and
**Linux x86_64** across Python **3.10 – 3.14**. Then:

```bash
tar -xzf vnp-deps.tar.gz
python3 -m venv .venv
source .venv/bin/activate
pip install --no-index --find-links wheelhouse/ -r requirements.txt
python3 run.py
```

The `--no-index` flag tells pip not to try PyPI, so the install stays
fully offline. The `source .venv/bin/activate` step matters: without
it, a bare `python3 run.py` resolves to your **system** Python (which
doesn't have Flask installed), even if your shell prompt suggests the
venv is active from an earlier session.

To rebuild the bundle (e.g. after editing `requirements.txt`, or to
target a different platform / Python version), run
`./scripts/build-wheelhouse.sh`. The script's header comment documents
the `PLATFORMS` and `PYVERS` arrays you'd edit to add coverage.

## UI

Three-pane plan view: hierarchy tree on the left, D3 nested-rectangle
visualization in the middle (the hero), command rail on the right with
**add / carve / import** tabs. Dark theme only — the aesthetic is
terminal/engineering and a light variant felt out of place.
JetBrains Mono for CIDRs, Geist Sans for prose.

Keyboard: <kbd>/</kbd> search · <kbd>c</kbd> carve · <kbd>d</kbd> toggle
detail/compact density · <kbd>Esc</kbd> closes overlays.

The viz has two densities. **Detail** draws every supernet as a full
nested-rectangle strip. **Compact** draws each as a 40px row with a
proportional strip and an overview column that keeps every supernet on
screen; click a row to expand it in place (free-slot click-to-carve works
there exactly as in detail). The choice is remembered per browser, and
`?density=compact` in the URL forces it for a shareable link.

## What it does

- **Supernets** — top-level blocks you own (e.g. `10.0.0.0/16`).
- **Allocations** — existing subnets within those supernets.
- **Carve** — ask for a new subnet by:
  - **prefix length** (`/24`),
  - **host count** (`500 hosts` → smallest prefix that fits), or
  - **equal split** (`4` → four equal power-of-two subnets).
  Run one query against **multiple parents** at once with a per-parent
  **repeat** count; preview the proposed CIDRs as dashed-mint overlays
  in the viz, then commit them all atomically. Name template supports
  `{parent}` and `{n}` (e.g. `{parent}.elb-{n}`, `{n}` resets per parent).
- **Reservations** — a third entry type alongside supernet/allocation. A
  reservation consumes free space (so future carves skip it) but is **never
  carved into itself**. Use it for ranges you want to keep off-limits —
  gateway pools, future expansion, "don't touch this." Reservations render
  in the viz with a dashed warn-color border and don't appear in the
  carve-parent picker.
- **Conflict detection** — duplicates and misaligned CIDRs are rejected.
  Allocations or reservations that don't sit inside any supernet are
  flagged as orphans. Conflicts and orphans surface as click-to-jump
  banners.
- **Visualization** — nested-rectangle view of each supernet, colored by
  used·free / by tag / by utilization gradient. Hover any block for a
  detail tooltip; click a free slot to pre-fill the carve form;
  zoom into the selection.
- **Detail panel** — click any node for a slide-over with editable name /
  description / tags, plus delete.
- **Search** — <kbd>/</kbd> to fuzzy-filter the tree by CIDR, name, or
  tag; click any tag chip to filter the viz to that tag.
- **Infoblox CSV import** — drop in a `network` / `networkcontainer`
  export from Infoblox and the tool seeds the plan: `networkcontainer`
  rows become supernets, `network` rows become allocations, names/tags
  come from the `EA-Network Name` and `EA-TAGS` extensible attributes.
  See [`docs/infoblox-csv-schema.md`](docs/infoblox-csv-schema.md) for
  the exact format vnp accepts (including how to author one from
  scratch if you don't have an Infoblox export).

## Layout

```
app/
├── __init__.py      # Flask factory
├── routes.py        # HTTP routes (pages + JSON API)
├── planning.py      # Pure IPv4 logic (carve, conflicts, free-space, tree)
├── storage.py       # JSON load/save per plan
├── models.py        # Plan + Allocation dataclasses
├── templates/       # Jinja templates (base / index / plan)
└── static/          # app.css + viz.js (D3 nested-rectangle renderer)
plans/               # Your plan JSON files (gitignored by default)
tests/               # Pytest unit tests for planning.py
run.py               # Entrypoint
```

Plans live as `plans/<name>.json`. The built-in `.gitignore` excludes them so
you don't accidentally commit your environment's real addressing into this
repo. Version them somewhere else (a private repo is a good idea — the JSON
is intentionally diff-friendly).

## Running tests

```bash
source .venv/bin/activate
pytest
```

## Environment variables

| Variable       | Default       | Purpose                                    |
| -------------- | ------------- | ------------------------------------------ |
| `HOST`         | `127.0.0.1`   | Bind address                               |
| `PORT`         | `5050`        | Bind port (avoid `5000` — see below)       |
| `NO_BROWSER=1` | *unset*       | Skip auto-opening a browser on startup     |

### Why not port 5000?

macOS Monterey+ runs the **AirPlay Receiver** on port 5000 by default and
returns `403 Forbidden` to any non-AirPlay request. If you bind Flask to
`5000` your terminal will look happy, but the browser will still hit
AirPlay first and you'll see `HTTP ERROR 403`. We default to `5050` to
sidestep that. If you'd rather keep `5000`, turn AirPlay Receiver off in
**System Settings → General → AirDrop & Handoff**.

## Scope

**In v1:**

- IPv4 only
- Three carve modes (prefix / host-count / equal split)
- Conflict + orphan detection
- Nested hierarchy tree + D3 rectangle visualization
- JSON-file persistence per plan
- Infoblox CSV import (`network` + `networkcontainer` rows)

**Not in v1** (intentionally — contributions welcome):

- IPv6
- Undo / redo
- Multi-plan cross-queries
- CSV or Markdown report export
- Authentication / multi-user
- Drag-and-drop editing in the viz

## Security / privacy notes

This tool is built for **local, single-user** planning. It binds to
`127.0.0.1` by default and has **no authentication**. Do not expose it to a
network or the public internet without adding auth and hardening CSRF.
Plan files can contain real addressing information from your environment, so
they are gitignored by default — keep them local or in a private repo of
your own.

## Contributing

See [AGENTS.md](AGENTS.md) for conventions used by both human contributors
and AI coding agents — where logic lives, what's in scope, test layout, and
style.

## License

MIT.
