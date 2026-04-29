"""Tests for Infoblox CSV import.

Fixtures use RFC 5737 documentation ranges (192.0.2.0/24 etc.) so this file
is safe in a public repo and never reflects a real environment.
"""

from __future__ import annotations

from app.infoblox import parse_infoblox_csv


# Minimal but realistic-shape header rows. Real Infoblox exports have ~50+
# columns; we only care about address*, netmask*, comment, EA-Network Name,
# and EA-TAGS. Other columns are present so column alignment is exercised.
HEADER_NETWORK = (
    "header-network,address*,netmask*,comment,disabled,"
    "EA-Network Name,EA-TAGS\n"
)
HEADER_CONTAINER = (
    "header-networkcontainer,address*,netmask*,comment,disabled,"
    "EA-Network Name,EA-TAGS\n"
)


def test_parses_network_with_dotted_quad_netmask():
    csv = HEADER_NETWORK + "network,192.0.2.0,255.255.255.128,web subnet,False,web,\"prod,web\"\n"
    out = parse_infoblox_csv(csv)
    assert out["errors"] == []
    assert len(out["allocations"]) == 1
    a = out["allocations"][0]
    assert a.cidr == "192.0.2.0/25"
    assert a.name == "web"
    assert a.description == "web subnet"
    assert a.tags == ["prod", "web"]


def test_parses_networkcontainer_with_prefix_integer_netmask():
    csv = HEADER_CONTAINER + "networkcontainer,192.0.2.0,24,corp container,False,corp,\n"
    out = parse_infoblox_csv(csv)
    assert out["errors"] == []
    assert len(out["supernets"]) == 1
    s = out["supernets"][0]
    assert s.cidr == "192.0.2.0/24"
    assert s.name == "corp"
    assert s.description == "corp container"


def test_falls_back_to_comment_when_ea_name_blank():
    csv = HEADER_NETWORK + "network,198.51.100.0,255.255.255.0,fallback-name,False,,\n"
    out = parse_infoblox_csv(csv)
    a = out["allocations"][0]
    assert a.name == "fallback-name"
    assert a.description == "fallback-name"


def test_combined_network_and_container():
    csv = HEADER_NETWORK + HEADER_CONTAINER \
        + "networkcontainer,203.0.113.0,24,top,False,top,\n" \
        + "network,203.0.113.0,255.255.255.128,half,False,half,\n"
    out = parse_infoblox_csv(csv)
    assert [s.cidr for s in out["supernets"]] == ["203.0.113.0/24"]
    assert [a.cidr for a in out["allocations"]] == ["203.0.113.0/25"]


def test_skips_unknown_row_types_silently():
    csv = HEADER_NETWORK + "ipv6network,2001:db8::,64,,,,\nnetwork,192.0.2.0,255.255.255.0,a,False,a,\n"
    out = parse_infoblox_csv(csv)
    assert len(out["allocations"]) == 1
    assert out["errors"] == []  # unknown types are not errors, just ignored


def test_data_row_before_header_is_an_error():
    csv = "network,192.0.2.0,255.255.255.0,early,False,early,\n" + HEADER_NETWORK
    out = parse_infoblox_csv(csv)
    assert out["allocations"] == []
    assert len(out["errors"]) == 1
    assert "before any header-network" in out["errors"][0]


def test_invalid_address_is_an_error_but_does_not_abort():
    csv = HEADER_NETWORK \
        + "network,not-an-ip,255.255.255.0,bad,False,bad,\n" \
        + "network,192.0.2.0,255.255.255.0,good,False,good,\n"
    out = parse_infoblox_csv(csv)
    assert len(out["allocations"]) == 1
    assert out["allocations"][0].cidr == "192.0.2.0/24"
    assert len(out["errors"]) == 1


def test_blank_lines_are_ignored():
    csv = "\n" + HEADER_NETWORK + "\n" \
        + "network,192.0.2.0,255.255.255.0,a,False,a,\n\n"
    out = parse_infoblox_csv(csv)
    assert len(out["allocations"]) == 1


def test_quoted_fields_with_commas_in_tags():
    csv = HEADER_NETWORK + 'network,192.0.2.0,255.255.255.0,c,False,n,"AWS,CDE,Cloud,ONA"\n'
    out = parse_infoblox_csv(csv)
    assert out["allocations"][0].tags == ["AWS", "CDE", "Cloud", "ONA"]


def test_later_header_overrides_earlier():
    # Two consecutive header-network rows; the second one's columns apply
    # to subsequent data rows.
    csv = (
        "header-network,address*,netmask*,comment\n"
        "network,192.0.2.0,255.255.255.0,first\n"
        "header-network,address*,netmask*,comment,EA-Network Name\n"
        "network,198.51.100.0,255.255.255.0,second-comment,second-name\n"
    )
    out = parse_infoblox_csv(csv)
    assert [a.cidr for a in out["allocations"]] == ["192.0.2.0/24", "198.51.100.0/24"]
    assert out["allocations"][0].name == "first"  # comment fallback
    assert out["allocations"][1].name == "second-name"
