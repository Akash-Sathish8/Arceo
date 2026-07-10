"""Enforcement precedence + robustness (2026-07-06 cleanup; Phase-1 B1 semantics).

Most-specific pattern wins (a narrow exception overrides a broad rule); at
equal breadth the restrictive EFFECT wins structurally (BLOCK >
REQUIRE_APPROVAL > ALLOW) regardless of the priority column; wildcards `*` and
`*.action` actually match; a policy whose conditions can't be evaluated fails
CLOSED; singular/plural action variants match when the exact form has no
policy.
"""

from __future__ import annotations

from authority.enforcement import match_policy


def _pol(pattern, effect, priority, conditions="[]", id=1):
    return {"id": id, "action_pattern": pattern, "effect": effect, "priority": priority,
            "conditions": conditions, "reason": f"{effect} {pattern}"}


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


def test_same_breadth_block_beats_allow_even_with_higher_allow_priority():
    # Effect rank is structural: an ALLOW can never out-prioritize a
    # same-breadth BLOCK, no matter what the priority column says.
    pols = [_pol("stripe.*", "ALLOW", 1000), _pol("stripe.*", "BLOCK", 0)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"
    pols = [_pol("stripe.*", "ALLOW", 1000), _pol("stripe.*", "REQUIRE_APPROVAL", 0)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "REQUIRE_APPROVAL"


def test_partial_wildcard_more_specific_than_tool_wildcard():
    pols = [_pol("stripe.*", "ALLOW", 10), _pol("stripe.create_*", "BLOCK", 100)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"
    assert match_policy("stripe.get_customer", pols)["effect"] == "ALLOW"


def test_malformed_conditions_does_not_crash():
    pols = [_pol("stripe.create_refund", "BLOCK", 100, conditions="{not valid json")]
    m = match_policy("stripe.create_refund", pols)
    assert m is not None and m["effect"] == "BLOCK"  # unevaluable -> fails closed, still fires


# ── Phase-1 B1: wildcard matching ─────────────────────────────────────────────

def test_bare_star_matches_everything():
    # The Workflows "Apply All" case: a bare `*` gate must actually fire.
    pols = [_pol("*", "REQUIRE_APPROVAL", 100)]
    m = match_policy("stripe.create_refund", pols)
    assert m is not None and m["effect"] == "REQUIRE_APPROVAL"
    m = match_policy("zendesk.delete_ticket", pols)
    assert m is not None and m["effect"] == "REQUIRE_APPROVAL"


def test_bare_star_block_fires():
    pols = [_pol("*", "BLOCK", 100)]
    m = match_policy("github.push_code", pols)
    assert m is not None and m["effect"] == "BLOCK"


def test_tool_wildcard_action_exact_matches():
    # `*.create_refund` — graph.py already scores these as mitigating;
    # enforcement must agree.
    pols = [_pol("*.create_refund", "BLOCK", 100)]
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"
    assert match_policy("paypal.create_refund", pols)["effect"] == "BLOCK"
    assert match_policy("stripe.get_customer", pols) is None


def test_exact_still_beats_bare_star():
    pols = [_pol("*", "BLOCK", 100), _pol("stripe.get_customer", "ALLOW", 0)]
    assert match_policy("stripe.get_customer", pols)["effect"] == "ALLOW"
    assert match_policy("stripe.create_refund", pols)["effect"] == "BLOCK"


# ── Phase-1 B1: unevaluable conditions fail closed ────────────────────────────

def test_malformed_conditions_on_allow_fails_closed():
    # The old behavior silently widened a conditional ALLOW into an
    # unconditional ALLOW. Unevaluable now means BLOCK.
    pols = [_pol("stripe.create_refund", "ALLOW", 100, conditions="{not valid json")]
    m = match_policy("stripe.create_refund", pols)
    assert m is not None
    assert m["effect"] == "BLOCK"
    assert m.get("unevaluable") is True


def test_wrong_shape_conditions_fail_closed():
    # JSON-valid but not a list of condition dicts.
    pols = [_pol("stripe.create_refund", "ALLOW", 100, conditions='{"field": "amount"}')]
    m = match_policy("stripe.create_refund", pols)
    assert m is not None and m["effect"] == "BLOCK" and m.get("unevaluable") is True


def test_unevaluable_does_not_shadow_more_specific_clean_policy():
    # Precedence still applies: an exact clean policy outranks a broader
    # malformed one, so the malformed policy is never reached.
    pols = [
        _pol("stripe.*", "ALLOW", 10, conditions="{broken", id=1),
        _pol("stripe.get_customer", "ALLOW", 10, id=2),
    ]
    m = match_policy("stripe.get_customer", pols)
    assert m["id"] == 2 and m["effect"] == "ALLOW"


def test_valid_conditions_still_evaluate():
    pols = [_pol("stripe.create_refund", "BLOCK", 100,
                 conditions='[{"field": "amount", "op": "gt", "value": 100}]')]
    assert match_policy("stripe.create_refund", pols, params={"amount": 500})["effect"] == "BLOCK"
    assert match_policy("stripe.create_refund", pols, params={"amount": 50}) is None


# ── Phase-1 B1: singular/plural action variants ───────────────────────────────

def test_plural_action_matches_singular_policy():
    # Proxy infers `create_refunds` from `POST /v1/refunds`; the policy says
    # `create_refund`.
    pols = [_pol("stripe.create_refund", "BLOCK", 100)]
    m = match_policy("stripe.create_refunds", pols)
    assert m is not None and m["effect"] == "BLOCK"


def test_singular_action_matches_plural_policy():
    pols = [_pol("stripe.list_charges", "BLOCK", 100)]
    m = match_policy("stripe.list_charge", pols)
    assert m is not None and m["effect"] == "BLOCK"


def test_exact_match_wins_over_variant():
    # When both singular and plural policies exist, the exact form decides —
    # the variant pass never runs.
    pols = [_pol("stripe.get_charge", "BLOCK", 100, id=1), _pol("stripe.get_charges", "ALLOW", 10, id=2)]
    m = match_policy("stripe.get_charges", pols)
    assert m["id"] == 2 and m["effect"] == "ALLOW"
