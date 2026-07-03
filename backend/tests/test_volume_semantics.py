"""P1/P2/P3 regression tests (D21): volume semantics + per-component honesty.

The 546%-mean-error baseline had ONE dominant cause: declared calls/day was
silently multiplied by an archetype turns guess (4-8x). Worse, the two
best-looking forecasts were 8x volume inflation cancelling a 10x token
underestimate. These tests pin the semantics AND the components so neither
bug class can return quietly.
"""

from analysis.spend_forecast import forecast_spend, _default_turns_per_run, load_defaults


def _agent(tools, **kw):
    return {"id": "t", "name": "t", "tools": tools, **kw}


def _github_tool(n_actions):
    return {
        "name": "github",
        "actions": [
            {"action": f"get_thing_{i}", "risk_labels": [], "reversible": True}
            for i in range(n_actions)
        ],
    }


def test_declared_volume_is_total_model_calls_when_turns_unknown():
    """P1: a declared calls/day number is never multiplied by a turns guess."""
    fc = forecast_spend(_agent([_github_tool(1)], expected_calls_per_day=10))
    assert fc["available"]
    assert fc["turnsPerRun"] == 1
    assert fc["callsPerDay"] == 10
    assert fc["inputSources"]["turnsPerRun"] == "volume"


def test_declared_turns_still_multiplies():
    """Declaring BOTH runs and turns opts into the runs x turns model."""
    fc = forecast_spend(_agent([_github_tool(1)], expected_calls_per_day=10, expected_turns_per_run=6))
    assert fc["turnsPerRun"] == 6
    assert fc["callsPerDay"] == 60
    assert fc["inputSources"]["turnsPerRun"] == "declared"


def test_slider_turns_override_multiplies():
    """Explicit what-if overrides (the UI sliders) always show their math."""
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=10),
        overrides={"runs_per_day": 20, "turns_per_run": 3},
    )
    assert fc["callsPerDay"] == 60


def test_turns_guess_capped_for_tiny_toolsets():
    """P2: a 1-action `github` tool must not inherit the 8-turn devops guess."""
    defaults = load_defaults()
    assert _default_turns_per_run(_agent([_github_tool(1)]), defaults) <= 2
    # A real many-action devops toolkit keeps its archetype guess.
    assert _default_turns_per_run(_agent([_github_tool(12)]), defaults) >= 4


def test_declared_context_raises_token_estimate():
    """P3: avg_context_tokens lifts a RAG-style agent out of the flat default."""
    small = forecast_spend(_agent([_github_tool(1)], expected_calls_per_day=10))
    big = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=10, avg_context_tokens=80000)
    )
    assert big["tokensPerCall"] > 80000 > small["tokensPerCall"]
    assert big["inputSources"]["tokensPerCall"] == "declared"
    assert big["pointExact"] > small["pointExact"] * 5


def test_components_sum_to_point_no_cancellation():
    """Anti-cancellation: the monthly point must equal its disclosed components,
    and each component must scale off the SAME callsPerDay — a volume error
    can't hide in one component while another compensates."""
    fc = forecast_spend(_agent([_github_tool(1)], expected_calls_per_day=100))
    total = fc["tokensUsd"] + fc["toolsUsd"] + fc["infraUsd"]
    assert abs(total - fc["point"]) <= 2  # rounding of 3 components
    # Doubling declared volume doubles the point (linear, no hidden multiplier).
    fc2 = forecast_spend(_agent([_github_tool(1)], expected_calls_per_day=200))
    assert abs(fc2["pointExact"] - 2 * fc["pointExact"]) < 0.01 * fc2["pointExact"]
