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
python run.py
```

Opens `http://127.0.0.1:5000` in your browser.

## What it does

- **Supernets** — top-level blocks you own (e.g. `10.0.0.0/16`).
- **Allocations** — existing subnets within those supernets.
- **Carve** — ask for a new subnet by:
  - **prefix length** (`/24`),
  - **host count** (`500 hosts` → smallest prefix that fits), or
  - **equal split** (`4` → four equal power-of-two subnets).
  The tool suggests the first free slot; confirm to commit.
- **Conflict detection** — duplicates and misaligned CIDRs are rejected.
  Allocations that don't sit inside any supernet are flagged as orphans.
- **Visualization** — nested-rectangle view of each supernet, colored by
  usage; free blocks labeled with their CIDR so you can see at a glance
  where to carve next.

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
| `PORT`         | `5000`        | Bind port                                  |
| `NO_BROWSER=1` | *unset*       | Skip auto-opening a browser on startup     |

## Scope

**In v1:**

- IPv4 only
- Three carve modes (prefix / host-count / equal split)
- Conflict + orphan detection
- Nested hierarchy tree + D3 rectangle visualization
- JSON-file persistence per plan

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
