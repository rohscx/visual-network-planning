# Infoblox CSV import — schema

The **Import** tab on the plan view accepts the CSV format produced by
Infoblox's *Data Management → IPAM → CSV Job Manager* export. This
document describes the subset of that format that vnp parses, how it maps
into vnp's plan model, and how to format a CSV from scratch if you don't
have an Infoblox export to hand.

## TL;DR

A minimal valid CSV looks like this:

```csv
header-networkcontainer,address*,netmask*,comment,EA-Network Name,EA-TAGS
networkcontainer,192.0.2.0,24,Top-level container,corp,"primary,corp"

header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS
network,192.0.2.0,255.255.255.128,Web tier,web,"prod,web"
network,192.0.2.128,255.255.255.192,DB tier,db,"prod,db"
```

After import:

- `192.0.2.0/24` becomes a **supernet** named `corp`
- `192.0.2.0/25` and `192.0.2.128/26` become **allocations** named
  `web` and `db`, with their tags

## File format

The format is plain CSV (`,` delimiter, `"` for quoted fields containing
commas). It is **row-oriented and self-describing** — every block of data
rows is preceded by a `header-<type>` row that names the columns for that
block.

### Row types

| First column | Meaning |
| --- | --- |
| `header-network` | Defines column names for subsequent `network` rows |
| `header-networkcontainer` | Defines column names for subsequent `networkcontainer` rows |
| `network` | One allocation (a leaf subnet) |
| `networkcontainer` | One supernet (a parent container) |
| anything else | Silently ignored (e.g. `header-ipv6network`, blank lines) |

### Multiple headers

You can repeat `header-<type>` rows in the same file. Each new header
applies to all data rows of that type **after** it, until the next header
of the same type. This matches Infoblox's export behavior: a single file
may contain multiple data blocks with slightly different column sets.

```csv
header-network,address*,netmask*,comment
network,192.0.2.0,255.255.255.0,first-block

header-network,address*,netmask*,comment,EA-Network Name
network,198.51.100.0,255.255.255.0,second-block,my-name
```

### Required columns

Both row types require:

- `address*` — the network address, e.g. `10.0.0.0`
- `netmask*` — the subnet mask. Either format is accepted:
  - dotted-quad (`255.255.255.0`)
  - prefix integer (`24`)

The `*` suffix is Infoblox's marker for "required field." We tolerate it
in the header row and strip it; you don't need to write `*` if you're
authoring a CSV from scratch.

### Optional columns we read

| Column | Used for |
| --- | --- |
| `comment` | The record's **description**, and a fallback for its **name** if `EA-Network Name` is empty |
| `EA-Network Name` | The record's **name** (preferred over `comment`) |
| `EA-TAGS` | Comma-separated tag list — quote the field if it contains commas |

Every other Infoblox column (`disabled`, `enable_ddns`, `lease_time`,
extensible attributes other than the three above, etc.) is **read but
ignored**. You can leave them in the file or strip them; vnp neither
requires them nor uses them.

## Mapping into the plan model

| Infoblox row | vnp record |
| --- | --- |
| `networkcontainer` | `supernets[]` entry |
| `network` | `allocations[]` entry |
| `address` + `netmask` | `cidr` (e.g. `10.0.0.0/24`) |
| `EA-Network Name`, fallback `comment` | `name` |
| `comment` | `description` |
| `EA-TAGS` (split on `,`) | `tags` |

vnp does not support importing **reservations** from CSV — they're a vnp
concept, not an Infoblox one. Add reservations through the **Add** panel
after the import.

## How errors are handled

Per-row, not per-file. If one row is malformed, vnp records the problem
and continues with the rest. The import panel shows a summary:

- **added supernets** / **added allocations** — successful inserts
- **skipped duplicates** — exact-CIDR matches against existing entries
- **rejected (overlap)** — partial overlaps with existing entries (rare
  with aligned CIDRs; usually a sign the source data was hand-edited)
- **parse errors** — bad address, missing netmask, data row appearing
  before its `header-<type>` row, etc.

The plan file is only saved if at least one record was added; a CSV that
parses to all errors leaves the plan unchanged.

## Privacy

Real Infoblox exports typically contain identifying information — ticket
numbers, person names, AWS account IDs, real RFC 1918 ranges that map to
actual networks. **Don't commit them to a shared repository.** The
project's `.gitignore` excludes `*.csv` for this reason. Keep your
exports local, or stash them in a private repo of your own.

When writing examples or test fixtures, use the RFC 5737 documentation
ranges:

| Range | Purpose |
| --- | --- |
| `192.0.2.0/24` | TEST-NET-1 |
| `198.51.100.0/24` | TEST-NET-2 |
| `203.0.113.0/24` | TEST-NET-3 |

These are reserved for documentation and never reflect a real network.

## Complete example

Two networkcontainers, four networks, one of each tagged.

```csv
header-networkcontainer,address*,netmask*,comment,EA-Network Name,EA-TAGS
networkcontainer,192.0.2.0,24,US-East primary,corp-us-east,"corp,us-east"
networkcontainer,198.51.100.0,24,US-West primary,corp-us-west,"corp,us-west"

header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS
network,192.0.2.0,255.255.255.128,East web tier,east-web,"prod,web,us-east"
network,192.0.2.128,255.255.255.192,East DB tier,east-db,"prod,db,us-east"
network,198.51.100.0,255.255.255.128,West web tier,west-web,"prod,web,us-west"
network,198.51.100.128,255.255.255.192,West DB tier,west-db,"prod,db,us-west"
```

Imports as 2 supernets and 4 allocations, with the supernet→allocation
hierarchy inferred from CIDR containment automatically.

## Reference

Parser implementation: [`app/infoblox.py`](../app/infoblox.py)
Tests with worked examples: [`tests/test_infoblox.py`](../tests/test_infoblox.py)
