# Carve request version 1

Use the REQUEST tab to copy a prompt for the current plan. Give that prompt
and your requirements to any model, then paste the returned JSON or load a
UTF-8 `.json` file. Loading a file never previews or commits automatically.
Check/preview validates the document first and then simulates every attempt.
The dashed mint overlays show selected successful proposals in either density.
Uncheck unwanted proposals, including individual split children, and explicitly
commit the selected count. Your source text survives errors and refreshes.
Nothing is transmitted to a model by this app.

```json
{
  "version": 1,
  "items": [
    {
      "id": "web",
      "parents": ["192.0.2.0/24"],
      "repeat": 2,
      "prefix_length": 28,
      "name_template": "{parent}.web-{n}",
      "tags": ["web", "prod"],
      "description": "Application subnets"
    }
  ]
}
```

The example parent must exist in your plan. Requests never contain output
CIDRs: the server chooses them. A prompt is a snapshot, not reserved capacity.

## Grammar and limits

Only JSON objects are accepted. No comments, Markdown fences, trailing commas,
duplicate object keys, non-finite numbers, unknown fields, or lone Unicode
surrogates. Integers must be JSON integers, not booleans, strings, or floats.
The UTF-8 POST body limit is 1 MiB, including a commit envelope.

Root fields are exactly `version` (integer 1) and `items` (1–256 objects).
Each item has:

| Field | Rule |
| --- | --- |
| `id` | Required; unique; `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `parents` | Required; 1–256 distinct strict aligned IPv4 CIDRs with numeric prefixes; canonicalized |
| `prefix_length` | Integer 0–32; first aligned free slot |
| `host_count` | Integer 1–4294967294; smallest block covering hosts **plus two** addresses, even for one or two hosts |
| `count` | Power-of-two integer 1–256; entire equal split of an entirely empty parent |
| `repeat` | Integer 1–64; default 1 |
| `name_template` | Trimmed string, at most 256 characters; default empty |
| `description` | Trimmed string, at most 4096 characters; default empty |
| `tags` | At most 32 trimmed strings of 1–64 characters; default empty array; order and duplicates preserved |

Exactly one of `prefix_length`, `host_count`, or `count` is required.
The worst-case expansion `sum(len(parents) * repeat * (count or 1))` must not
exceed 256, even when some attempts will fail. No tags are implicitly inherited.

Only `{parent}` and `{n}` are permitted in a name template. Other or unmatched
braces, expressions, formatting specifiers, and escapes are rejected. Parent
is the original parent's nonempty name, otherwise canonical CIDR. Numbering
starts at 1 and counts successful proposals per parent across the whole
request. Expansion is single-pass; braces in parent names remain literal.
Resolved names can exceed the template's length limit.

## Simulation

Execution order is items, parents, repeats, then ascending split children.
Each prefix/hosts iteration requests one subnet; each count iteration requests
a whole split. Earlier successes consume space. Failed attempts consume neither
space nor name numbers. An entire split succeeds or fails together; `count:1`
conflicts with the existing parent. A later split repeat normally cannot fit.

Parents resolve only from the original plan, across all three record kinds.
Reservations and parents inside reservations are explicitly forbidden. Missing
parents and normalized duplicate records are reported. Supernets qualify;
allocations qualify only when they have strict descendants and belong to a
supernet. Leaf and orphan allocations cannot be carved into.

Direct free space excludes existing child containers, even when their own
subtrees have space. A fully tiled parent is omitted from prompt inventory;
its eligible descendants can appear independently. Total free addresses do
not guarantee an aligned prefix fits. No overlapping capacities are summed.
The prompt includes canonical parents, names, kinds, direct free CIDRs, direct
free counts, largest free CIDR, and warnings for excluded records. Empty
inventory is valid. Plan strings are delimited untrusted data in the prompt.

Simulation does not modify the Plan. Each attempt reports `item_id`, `parent`,
one-based `iteration`, `status`, `reason_code`, `message`, `conflicts`, and
`proposals`. Failures have no proposals. Conflict records have `kind`, `cidr`,
and `name`. Proposals have `id`, `parent`, `cidr`, `name`, `tags`, `description`.
IDs are `item_id:parent_index:repeat_index:child_index`, with zero-based indices.

| Status | Reason code | UI treatment |
| --- | --- | --- |
| `will_succeed` | null | Selectable proposals, “Fits” |
| `will_not_fit` | `capacity` | “Does not fit” plus specific explanation |
| `conflicts_existing` | `conflict` | “Resolve conflict” |
| `parent_not_found` | `missing_parent` | “Choose an existing parent” |
| `parent_is_reservation` | `reserved_parent` | “Choose an unreserved parent” |

Detailed distinctions such as fragmentation, ineligible leaves, duplicate
records, or reservation ancestors are explanatory text, not extra codes.

## HTTP API

All responses are JSON with `Cache-Control: no-store`.

- `GET /plans/<name>/carve_prompt`: returns `ok`, `version`, `plan_revision`,
  `limits` (`max_allocations`, `max_repeat`, `max_request_bytes`), `parents`,
  `warnings` (`code`, `cidr`, `message`), and complete copyable `prompt`.
- `POST /plans/<name>/carve_request/preview`: `application/json`, body exactly
  the versioned document. Returns 200 with `ok:true`, `valid:true`,
  `plan_revision`, all `results`, and `summary` (`attempts`,
  `successful_attempts`, `failed_attempts`, `proposed_allocations`, `all_fit`).
  Valid requests return 200 even when no attempt succeeds.
- `POST /plans/<name>/commit_carve`: adds this mutually exclusive form:

```json
{
  "carve_request": {
    "version": 1,
    "items": [{"id": "web", "parents": ["192.0.2.0/24"], "prefix_length": 28}]
  },
  "plan_revision": "revision-from-preview",
  "selection": "fitting",
  "selected_proposal_ids": ["web:0:0:0"]
}
```

`selection:all` requires every attempt to succeed and every proposal to be
selected. `fitting` requires a nonempty explicit subset of successful IDs,
without duplicates. Both paths revalidate the document and re-simulate the
**whole** request; selection never backfills space or renumbers names.
Unknown envelope fields and mixed `allocations`/`carve_request` are rejected.
Selected allocations are authored by the server, validated on a private Plan,
and saved once, all or none. Success is `{ok:true, committed:["CIDR",...],
rejected:[]}`. No client-supplied resolved names or CIDRs are accepted.

Revision is SHA-256 of `Plan.to_dict()` encoded as canonical UTF-8 JSON:
sorted object keys, compact separators, preserved array order, `ensure_ascii=False`.
Metadata changes also invalidate the revision. Staleness returns 409 with
`{ok:false, code:"stale_plan", error:"Plan changed; preview again",
committed:[], rejected:[]}` and no writes. Re-preview after editing the request,
a plan change, or an uncertain commit response. Do not automatically retry
commits. A completed prior commit changes the revision.

Syntax errors return 400/`invalid_json`; schema errors 422/`invalid_schema`;
oversize bodies 413/`request_too_large`; wrong media type
415/`unsupported_media_type`. Validation envelopes have `ok:false`,
`valid:false`, `code`, `error`, and `errors` containing JSON Pointer `path`,
`code`, and `message` (plus one-based `line`/`column` for syntax errors when
available). They contain no feasibility results. Malformed input never runs
simulation. Inconsistent selections return 422/`invalid_selection`.
Invalid names return JSON 400/`invalid_plan_name`; missing plans return JSON
404/`plan_not_found`; storage/unexpected failures return sanitized JSON 500.

The legacy `{allocations:[...]}` form retains its partial-save semantics:
accepted entries are saved even when others are rejected. Ordinary manual
previews now use the server simulator, including full equal splits; clicked
exact-slot previews remain separate. Legacy commit is not an atomic batch.

This remains a local single-user tool. There is no global mutation lock or
cross-process transaction guarantee. Revision checking detects completed
changes; concurrent writers racing between the check and save are unsupported.
No calculator, external LLM connection, second skill, or standalone request
validator is part of this feature.
