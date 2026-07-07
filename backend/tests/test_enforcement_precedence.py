"""Enforcement precedence + robustness (2026-07-06 cleanup).

Most-specific pattern wins (a narrow exception overrides a broad rule), with
effect priority as the tie-break at equal breadth; malformed conditions on the
hot path must not crash.
"""

from __future__ import annotations

from authority.enforcement import match_policy


def _pol(pattern, effect, priority, conditions="[]"):
    return {"action_pattern": pattern, "effect": effect, "priority": priority, "conditions": conditions}


def test_exact_allow_beats_broad_block():
    pols = [_pol("stripe.*", "BLOCK", 100), _pol("stripe.get_customer", "ALLOW", 10)]
    assert match_policy("stripe.get_customer", pols)["effect"] == "ALLOW"  # the exception wins
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"  # everything else still blocked


def test_exact_block_beats_broad_allow():
    pols = [_pol("stripe.*", "ALLOW", 10), _pol("stripe.create_refund", "BLOCK", 100)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"
    assert match_policy("stripe.get_customer", pols)["effect"] == "ALLOW"


def test_same_breadth_block_beats_allow():
    pols = [_pol("stripe.*", "ALLOW", 10), _pol("stripe.*", "BLOCK", 100)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"


def test_partial_wildcard_more_specific_than_tool_wildcard():
    pols = [_pol("stripe.*", "ALLOW", 10), _pol("stripe.create_*", "BLOCK", 100)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"
    assert match_policy("stripe.get_customer", pols)["effect"] == "ALLOW"


def test_malformed_conditions_does_not_crash():
    pols = [_pol("stripe.create_refund", "BLOCK", 100, conditions="{not valid json")]
    m = match_policy("stripe.create_refund", pols)
    assert m is not None and m["effect"] == "BLOCK"  # treated as no conditions, still fires
