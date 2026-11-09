# IPv4 network calculator

Open **calculator** in the plan toolbar or press **k**. The read-only slide-over
uses the same 360px rail as record details in both detail and compact densities.
Escape closes it and restores focus. Opening record details closes the calculator;
opening the calculator closes details. Carve drafts and REQUEST proposals stay in
place underneath it.

## Strict input

Enter one of these forms (outer whitespace is trimmed):

- `192.0.2.0/24`: IPv4 address and decimal prefix, 0–32.
- `192.0.2.37`: **bare address interpreted as a single host**, `/32`, regardless
  of plan context.
- `192.0.2.0 255.255.255.0`: address and contiguous dotted-quad netmask,
  separated by whitespace. All-zero and all-one masks mean /0 and /32.

Host bits are rejected through `parse_strict()`. For example, `192.0.2.37/24`
returns `host_bits_set` with `suggested_cidr: "192.0.2.0/24"`. The **Use** button
explicitly replaces the input and calculates the suggested range. Nothing is
silently normalized. IPv6, leading-zero octets, malformed addresses, wildcard
or noncontiguous input masks, extra tokens, nonstrings, empty input, and input
longer than 128 characters (including outer whitespace) are rejected.

## Results and semantics

The result includes canonical `cidr`, trimmed `input`, `input_kind` (`cidr`,
`address`, or `netmask`), `prefix_length`, `netmask`, and `wildcard` (inverse
netmask). `network_address` and `range_end` always describe the inclusive
mathematical boundaries. `total_addresses` counts every address in that range.

| Prefix | Usable hosts and endpoints | Broadcast |
| --- | --- | --- |
| /0–/30 | `2^(32-prefix)-2`; first is network + 1, last is range end − 1 | `broadcast_address` is range end; `broadcast_kind: directed` |
| /31 | Both endpoints, count 2; `host_semantics: point_to_point` | null; `broadcast_kind: none_point_to_point` |
| /32 | One host, count and total 1; `host_semantics: single_host` | null; `broadcast_kind: none_single_host` |

The conventional case has `host_semantics: conventional`. Endpoint fields are
`first_usable_host` and `last_usable_host`; the count is `usable_host_count`.
RFC 3021 point-to-point: both addresses are endpoints; no directed broadcast.
A /32 is a single host; no subnet broadcast. Counts express subnet arithmetic,
not global assignability. Counts use arithmetic, never host enumeration.

`next_prefix_subnets` contains exactly two ascending children for /0–/31.
Click either child to calculate it. A /32 has an empty list and displays
“cannot split further.”

This RFC-aware calculator deliberately differs from `carve(host_count=...)`,
which adds two reserved addresses when choosing a size. That sizing behavior
is unchanged. To carve a /31, choose prefix mode in the existing carve workflow.
The calculator never fills or changes that workflow.

## Plan context and navigation

Each reference is `{kind, cidr, name, description, tags}` with a canonical CIDR.
All three kinds—supernet, allocation, reservation—are included:

- `containing_supernets`: every supernet containing the entire range, including
  equality, most-specific first, then original bucket order for ties.
- `containing_supernet`: the first reference above, or null.
- `records_inside`: all strict descendants, including deeply nested records.
- `equal_records`: every exact normalized match.
- `containing_records`: all strict ancestors.

The three record lists sort by network address, prefix length, kind, then
original bucket index. Duplicate records remain visible; CIDR navigation cannot
distinguish them, and the calculator warns when duplicates occur.
`context_message` names the selected containing supernet or explicitly says
that no supernet contains the entire input range. Enclosing several roots does
not mean any one of them contains the query. Orphans remain visible.

An empty descendant list is **not evidence of free space**: a leaf allocation
or reservation ancestor may occupy the range. Lists describe containment only.
Click a record to select its CIDR and open existing record details. Click the
canonical CIDR or any address/mask field to copy using the standard affordance.

Editing input clears previous results. Loading, invalid input, failed queries,
and successful empty lists have distinct messages. Errors preserve input;
transport/server failures offer retry. Older responses cannot replace a newer
input. Plan refresh invalidates results and recalculates context.

## HTTP API

`POST /plans/<name>/calculate`, `Content-Type: application/json`, with exactly:

```json
{"input": "192.0.2.0/24"}
```

No query parameters or unknown keys are accepted. The body limit is 4 KiB.
Success returns HTTP 200 with `ok: true` and the fields above. The endpoint
requires an existing named plan, but pure `calculate_network(input, plan=None)`
also supports context-free use with identical mathematics. It never saves or
mutates the Plan. All endpoint responses include `Cache-Control: no-store`.

Errors contain `{ok: false, code, error}`. Validation errors additionally carry
`field: "input"` and `suggested_cidr` (only host-bit errors have a string;
otherwise null).

| HTTP | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_plan_name` |
| 404 | `plan_not_found` |
| 413 | `request_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_input`, `host_bits_set`, `invalid_netmask` |
| 500 | `invalid_plan_data` |

Malformed existing plan CIDRs fail the whole calculation as `invalid_plan_data`;
no partial context is returned. Valid but misaligned stored CIDRs retain the
existing plan normalization convention, including duplicate detection.
