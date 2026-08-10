"""Keep skills/vnp-csv-import/ honest against the real importer.

The skill ships a stdlib-only validator that reimplements app/infoblox.py's
parsing rules so an LLM can preview a file without a vnp checkout. That's
only useful while the two agree — a drift means the skill starts vouching
for files the importer would mangle or reject.

These tests pin both halves of that contract:
  1. the validator's parse matches parse_infoblox_csv on tricky inputs
  2. every ```csv example inside SKILL.md actually imports cleanly
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

from app.infoblox import parse_infoblox_csv

SKILL_DIR = Path(__file__).resolve().parent.parent / "skills" / "vnp-csv-import"
VALIDATOR = SKILL_DIR / "scripts" / "validate_vnp_csv.py"
SKILL_MD = SKILL_DIR / "SKILL.md"


@pytest.fixture(scope="module")
def validator():
    """Import the skill's standalone validator as a module."""
    spec = importlib.util.spec_from_file_location("vnp_csv_validator", VALIDATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


HEADER = "header-network,address*,netmask*,comment,EA-Network Name,EA-TAGS\n"
HEADER_C = "header-networkcontainer,address*,netmask*,comment,EA-Network Name,EA-TAGS\n"

# Inputs chosen to cover the importer's quirks, not just the happy path.
DIFFERENTIAL_CASES = {
    "host_bits_cleared":  HEADER + "network,10.0.0.128,23,,hb,\n",
    "prefix_in_address":  HEADER + "network,10.0.0.0/24,24,,bad,\n",
    "empty_netmask":      HEADER + "network,10.0.0.0/24,,,bad2,\n",
    "name_falls_back":    HEADER + "network,10.0.1.0,24,mycomment,,\n",
    "short_row":          HEADER + "network,10.0.2.0,24\n",
    "long_row":           HEADER + "network,10.0.3.0,24,c,n,t,X,Y\n",
    "unknown_row_types":  HEADER + "ipv6network,2001:db8::,64,,,\nnetwork,10.0.4.0,24,,ok,\n",
    "asterisks_omitted":  ("header-network,address,netmask,comment,EA-Network Name,EA-TAGS\n"
                           "network,10.0.5.0,24,,na,\n"),
    "columns_reordered":  ('header-network,EA-TAGS,comment,netmask*,address*,EA-Network Name\n'
                           'network,"a,b",cm,24,10.0.6.0,nm\n'),
    "dotted_quad_mask":   HEADER + "network,10.0.7.0,255.255.255.240,,dq,\n",
    "row_before_header":  "network,10.0.8.0,24,,early,\n" + HEADER,
    "both_row_types":     (HEADER_C + "networkcontainer,10.1.0.0,16,,top,\n"
                           + HEADER + "network,10.1.1.0,24,,kid,\n"),
    "repeated_headers":   (HEADER + "network,10.2.0.0,24,,a,\n"
                           + "header-network,address*,netmask*,comment\n"
                           + "network,10.2.1.0,24,second\n"),
    "blank_lines":        "\n" + HEADER + "\n" + "network,10.3.0.0,24,,bl,\n\n",
    "quoted_tags":        HEADER + 'network,10.4.0.0,24,,qt,"aws,cde,prod"\n',
    "empty_file":         "",
    "header_only":        HEADER,
    "flat_csv_no_header": "address,netmask,name\n10.0.1.0,24,web\n",
}


def _real_records(text: str):
    r = parse_infoblox_csv(text)
    return sorted(
        [("supernet", a.cidr, a.name, a.description, tuple(a.tags)) for a in r["supernets"]]
        + [("allocation", a.cidr, a.name, a.description, tuple(a.tags)) for a in r["allocations"]]
    )


def _validator_records(mod, text: str):
    return sorted(
        (mod.KIND_LABEL[rec["kind"]], rec["cidr"], rec["name"],
         rec["description"], tuple(rec["tags"]))
        for rec in mod.parse(text)["records"]
    )


@pytest.mark.parametrize("label", sorted(DIFFERENTIAL_CASES))
def test_validator_matches_importer(validator, label):
    """The skill's validator must produce the same records as the importer."""
    text = DIFFERENTIAL_CASES[label]
    assert _validator_records(validator, text) == _real_records(text)


@pytest.mark.parametrize("label", sorted(DIFFERENTIAL_CASES))
def test_validator_matches_importer_error_count(validator, label):
    """It must also reject the same rows, not silently accept bad ones."""
    text = DIFFERENTIAL_CASES[label]
    assert len(validator.parse(text)["errors"]) == len(parse_infoblox_csv(text)["errors"])


def _skill_csv_blocks() -> list[str]:
    return re.findall(r"```csv\n(.*?)```", SKILL_MD.read_text(), re.S)


def test_skill_md_has_csv_examples():
    # Guards the regex above: if the fences change, the next test would
    # vacuously pass over an empty list.
    assert len(_skill_csv_blocks()) >= 2


@pytest.mark.parametrize("idx", range(len(_skill_csv_blocks())))
def test_skill_md_examples_import_cleanly(idx):
    """LLMs copy examples verbatim, so a broken one in SKILL.md is the
    worst failure mode available. Every block must parse without errors
    and actually yield records."""
    result = parse_infoblox_csv(_skill_csv_blocks()[idx])
    assert result["errors"] == []
    assert result["supernets"] or result["allocations"]


def test_validator_flags_host_bits(validator):
    """The silent-normalization trap is the skill's headline warning —
    if the linter stops catching it, the skill's main claim is false."""
    text = HEADER + "network,10.0.0.128,23,,hb,\n"
    warnings = validator.lint(validator.parse(text)["records"])
    assert any("host bits" in w for w in warnings)


def test_validator_flags_duplicate_cidrs(validator):
    text = HEADER + "network,10.0.4.0,24,,one,\nnetwork,10.0.4.0,24,,two,\n"
    warnings = validator.lint(validator.parse(text)["records"])
    assert any("already appeared" in w for w in warnings)


def test_validator_summarizes_when_no_containers(validator):
    """A file of pure allocations is legitimate (topping up an existing
    plan); it should produce one note, not one warning per row."""
    text = HEADER + "".join(f"network,10.0.{i}.0,24,,a{i},\n" for i in range(5))
    warnings = validator.lint(validator.parse(text)["records"])
    orphan_warnings = [w for w in warnings if "orphan" in w]
    assert len(orphan_warnings) == 1
