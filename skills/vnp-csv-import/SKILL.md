---
name: vnp-csv-import
description: Author Infoblox-format CSV files for bulk-importing IPv4 networks into vnp (visual network planning) or into Infoblox IPAM itself. Use this whenever someone wants to turn a list of subnets, an IP plan, a spreadsheet of VPC ranges, or a network inventory into an importable CSV — and also whenever they mention vnp, network containers, supernets/allocations, "header-network" rows, EA-TAGS, or bulk-loading address space into an IPAM tool. Reach for this even if they don't name the format, because a plain "make me a CSV of these networks" will silently produce a file the importer rejects or misreads.
---

# Authoring vnp / Infoblox import CSVs

vnp's importer reads the CSV shape that Infoblox's *CSV Job Manager* exports.
It is not a normal flat CSV — the column names live in `header-<type>` rows
that precede their data rows, and the same file can carry several such blocks.
Getting that structure wrong is the single most common failure, because a
plain-looking CSV parses to zero rows without raising anything you'd notice.

## Minimum viable file

```csv
header-networkcontainer,address*,netmask*,comment,EA-Network Name,EA-TAGS
networkcontainer,10.0.0.0,16,Corp HQ supernet,corp-hq,"corp,prod"

header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS
network,10.0.1.0,24,Web tier,web,"prod,web"
network,10.0.2.0,24,DB tier,db,"prod,db"
```

That imports as one supernet (`10.0.0.0/16`) with two allocations nested
underneath it. The nesting is *computed from CIDR containment* — you never
declare parent/child relationships, and row order is irrelevant.

## Structure rules

**`header-<type>` rows define columns for the data rows that follow.** Column
one is the literal tag `header-network` or `header-networkcontainer`; the
remaining cells are field names. Data rows start with the bare tag (`network`,
`networkcontainer`) and their values align to the header's fields starting at
column one. A data row appearing before any header of its type is an error.

**You may repeat header blocks.** The most recent header for a given type
applies to subsequent rows of that type, so a file can mix column sets. Real
Infoblox exports do this; you generally shouldn't need to.

**Field order is yours to choose.** The header defines position, so
`address*,netmask*` and `EA-TAGS,comment,netmask*,address*` both work as long
as data rows match. Prefer the conventional order above for readability.

**The `*` suffix is decorative.** Infoblox marks required fields that way and
the importer strips it. `address*` and `address` are identical.

## Columns

Only these five are read. Everything else — `disabled`, `enable_ddns`,
`lease_time`, other `EA-*` attributes — is parsed and discarded, so you can
carry a real export through untouched, or omit them entirely.

| Column | Required | Becomes | Notes |
| --- | --- | --- | --- |
| `address*` | yes | part of CIDR | **Bare IP only** — no `/prefix` |
| `netmask*` | yes | part of CIDR | `24` or `255.255.255.0`, both fine |
| `comment` | no | `description`, and `name` if `EA-Network Name` is blank | |
| `EA-Network Name` | no | `name` | Preferred over `comment` |
| `EA-TAGS` | no | `tags` | Comma-separated; **quote the field** |

Row types map to vnp's buckets:

- `networkcontainer` → **supernet** (a block you own and carve within)
- `network` → **allocation** (a subnet in use)
- anything else (`ipv6network`, `hostrecord`, …) → silently skipped

## Choosing container vs. network

This is the judgment call you'll actually have to make, and the source list
usually won't state it outright. The useful question isn't "how big is this
block" but **"is this something we'll later carve out of, or something already
spoken for?"**

A block is a `networkcontainer` when it exists to hold other things — a
region, a VPC, an availability zone, an allocated-to-a-team range with
subnets yet to be assigned. It's a `network` when it's the leaf: a subnet
that's actually attached to something, where nobody expects to subdivide
further.

Two practical signals. If the source list shows a block *and* smaller blocks
inside it, the outer one is a container. And if the user describes a block as
"we own this range" or "reserved for X" rather than naming a workload, it's
almost certainly a container.

When it's genuinely ambiguous, prefer `network` and say so — vnp can
reclassify either direction in one click from the detail panel, and an
allocation that should have been a supernet is a smaller annoyance than a
supernet that swallows blocks the user meant to keep separate.

If the request is to *plan* new space rather than record existing space
("carve me eight /24s out of 10.5.0.0/16"), compute aligned, non-overlapping
blocks yourself and emit the parent as a `networkcontainer` with the children
as `network` rows. Alternatively, import just the container and let the user
carve interactively in the app, which is what its carve panel is for — worth
offering when the sizing isn't fully specified.

## Traps worth knowing

These are the failure modes that actually bite, verified against the parser:

**Host bits are silently cleared.** `address=10.0.0.128, netmask=23` imports as
`10.0.0.0/23` with no warning. If you meant a /23 starting at .128, that
address isn't a valid network boundary and your intent is lost quietly. Always
compute the true network address before writing the row — this is the one
mistake that produces a wrong plan rather than a visible error.

**Don't put the prefix in `address`.** `address=10.0.0.0/24` with
`netmask=24` errors (`Only one '/' permitted`), and with an empty netmask it
errors too. Split them.

**Quote `EA-TAGS` whenever it holds more than one tag.** Unquoted
`aws,prod,web` becomes three columns and shifts everything after it. Write
`"aws,prod,web"`.

**`comment` alone fills both name and description.** If you set `comment` and
leave `EA-Network Name` empty, the record ends up with the same string in both
fields. Set `EA-Network Name` explicitly when you want them to differ.

**Reservations can't be imported.** vnp has a third bucket for blocks
deliberately excluded from carving, but Infoblox has no equivalent and the
importer only produces supernets and allocations. Tell the user to add
reservations through the app's **Add** panel, or to import them as allocations
and reclassify in the detail panel.

**Short and long rows are tolerated.** Missing trailing values become empty
strings; extra values past the header's width are dropped. Neither raises an
error, so a misaligned row can import as subtly wrong data. Keep the widths
matched.

## What happens on import

Each parsed row is validated against the plan as it grows. Rows whose CIDR
already exists are **skipped as duplicates** (so re-importing the same file is
safe and idempotent). The importer reports counts of added supernets, added
allocations, skipped duplicates, rejected rows, and parse errors — a row that
fails never aborts the rest of the file.

Limits: **10,000 rows** per import, **16 MB** per upload. Split larger sets.

## Validate before you hand it over

`scripts/validate_vnp_csv.py` replays the importer's exact parsing rules and
reports what the file will actually produce. It needs only the standard
library, so it runs anywhere:

```bash
python3 scripts/validate_vnp_csv.py networks.csv
```

It prints the resulting supernets and allocations and flags problems the
importer itself would let through quietly — silently-normalized host bits,
duplicate CIDRs within the file, and allocations with no containing supernet
(which import as orphans). Run it on anything you generate. Reading back the
parsed CIDRs is the fastest way to catch an off-by-one in a subnet plan, and
it costs one command.

## Worked example

Turning "two AZs in 10.20.0.0/16, each with a /24 for apps and a /28 for load
balancers" into an import file:

```csv
header-networkcontainer,address*,netmask*,comment,EA-Network Name,EA-TAGS
networkcontainer,10.20.0.0,16,Region us-east-1,us-east-1,"aws,us-east-1"
networkcontainer,10.20.0.0,18,Availability zone 1,us-east-1-az1,"aws,az1"
networkcontainer,10.20.64.0,18,Availability zone 2,us-east-1-az2,"aws,az2"

header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS
network,10.20.0.0,24,AZ1 application tier,az1-app,"aws,az1,app"
network,10.20.1.0,28,AZ1 load balancers,az1-elb,"aws,az1,elb"
network,10.20.64.0,24,AZ2 application tier,az2-app,"aws,az2,app"
network,10.20.65.0,28,AZ2 load balancers,az2-elb,"aws,az2,elb"
```

which imports as:

```
10.20.0.0/16      supernet     us-east-1
  10.20.0.0/18    supernet     us-east-1-az1
    10.20.0.0/24  allocation   az1-app
    10.20.1.0/28  allocation   az1-elb
  10.20.64.0/18   supernet     us-east-1-az2
    10.20.64.0/24 allocation   az2-app
    10.20.65.0/28 allocation   az2-elb
```

**Nesting follows containment, and only containment.** Two things worth
noticing. The per-AZ `networkcontainer` rows are what create the middle tier —
without them both allocations would hang directly off the /16. And the ELB /28
sits at `10.20.1.0`, *outside* the app /24, which is what keeps it a sibling;
had it been `10.20.0.240/28` it would have imported as a **child** of
`10.20.0.0/24`, since that address falls inside it. When a block should sit
beside another rather than within it, give it space that doesn't overlap.

Boundaries matter too: a /28 must start on a 16-address multiple. `.240` is
valid, `.245` is not — and per the host-bits trap above, an invalid one is
silently rounded down rather than rejected.

## Documentation-safe address space

When producing examples, samples, or test fixtures rather than a real plan, use
the RFC 5737 documentation ranges — `192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`. They're reserved for exactly this and can never collide with
someone's real network. Reserve RFC 1918 space (`10/8`, `172.16/12`,
`192.168/16`) for files describing an actual environment.

Real IPAM exports routinely carry identifying detail — ticket numbers, staff
names, cloud account IDs, internal hostnames. If you're handling one, treat it
as sensitive and don't copy it into examples or commit it anywhere public.
