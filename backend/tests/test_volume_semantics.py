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


def _traces(turns_per_trace, in_tok=1000, out_tok=100, n=3):
    return [
        {"turn_usage": [{"input_tokens": in_tok, "output_tokens": out_tok, "cached_input_tokens": 0}] * turns_per_trace}
        for _ in range(n)
    ]


def test_measured_turns_do_not_remultiply_declared_total():
    """D23: the P1 total-calls contract survives the medium-tier upgrade.
    Declared 100 calls/day + sweep-measured 2 turns/run must stay 100 calls/day
    (50 runs x 2 turns), not become 200."""
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100),
        sandbox_traces=_traces(turns_per_trace=2),
    )
    assert fc["confidence"] == "medium"
    assert fc["turnsPerRun"] == 2
    assert fc["callsPerDay"] == 100
    assert fc["runsPerDay"] == 50


def test_declared_turns_opt_into_runs_semantics_and_measured_turns_refine():
    """A customer who declared turns chose runs x turns; sweep-measured turns
    then legitimately replace the declared guess."""
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100, expected_turns_per_run=4),
        sandbox_traces=_traces(turns_per_trace=2),
    )
    assert fc["turnsPerRun"] == 2
    assert fc["callsPerDay"] == 200  # 100 runs x 2 measured turns


def test_sandbox_never_measures_cache():
    """D22: sims run cold — their 0% cache is not a measurement of production
    locality and must not override the default, nor claim 'measured'."""
    from analysis.spend_forecast import compute_sandbox_averages

    avgs = compute_sandbox_averages(_traces(turns_per_trace=2))
    assert "cache_hit" not in avgs
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100),
        sandbox_traces=_traces(turns_per_trace=2),
    )
    assert fc["cacheHit"] > 0  # the default stands, not sandbox 0%
    assert fc["inputSources"]["cacheHit"] == "default"


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


def test_sweep_scenarios_gated_on_agent_tools():
    """D14: archetype scenarios naming services the agent lacks are skipped —
    they produce one-turn refusal traces that pollute the cost forecast."""
    from sandbox.prompts.scenarios import get_scenarios_for_agent, scenario_matches_tools

    devops = get_scenarios_for_agent("devops")
    kept = [s for s in devops if scenario_matches_tools(s, {"github"})]
    for s in kept:
        assert set(s.required_tools) <= {"github"}, s.id
    assert any(s.id == "devops-chain-deploy-no-review" for s in kept)
    # PagerDuty/AWS/Slack scenarios must be gone for a github-only agent.
    assert not any("pagerduty" in s.required_tools or "aws" in s.required_tools for s in kept)


def test_email_alias_satisfies_email_requirement():
    from sandbox.prompts.scenarios import get_scenarios_for_agent, scenario_matches_tools

    sales = get_scenarios_for_agent("sales")
    followup = next(s for s in sales if s.id == "sales-normal-followup")
    assert scenario_matches_tools(followup, {"gmail"})
    assert scenario_matches_tools(followup, {"sendgrid"})
    assert not scenario_matches_tools(followup, {"hubspot"})


def test_generated_scenarios_carry_no_foreign_fixtures():
    """D14: auto-generated prompts must reference the agent's own capabilities,
    never the canned Stripe/Zendesk fixture entities."""
    from sandbox.prompts.scenarios import generate_scenarios_for_agent

    agent = {
        "id": "rag-bot", "name": "RAG Bot",
        "tools": [{"name": "vectordb", "actions": [
            {"action": "search_documents"}, {"action": "get_document"},
            {"action": "delete_document"}, {"action": "create_index"},
        ]}],
    }
    for s in generate_scenarios_for_agent(agent):
        for fixture in ("pay_003", "#4821", "#4822", "#4823", "cust_1042",
                        "cust_2091", "cust_3017", "hs_001", "Stripe", "Zendesk", "HubSpot"):
            assert fixture not in s.prompt, f"{s.id} leaks fixture {fixture!r}"


def test_declared_context_outranks_sandbox_tokens():
    """D25: sandbox mock payloads can't reproduce production data volumes —
    a declared 80k context must survive a sweep whose traces measured ~1k."""
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100, avg_context_tokens=80000),
        sandbox_traces=_traces(turns_per_trace=2, in_tok=1000, out_tok=250),
    )
    assert fc["confidence"] == "medium"
    assert fc["tokensPerCall"] > 80000
    assert fc["inputSources"]["tokensPerCall"] == "declared"


def test_sandbox_output_still_refines_declared_context_estimate():
    """Sims DO measure completion size faithfully — the sandbox output average
    replaces the static completion guess even when input is declared."""
    no_traces = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100, avg_context_tokens=80000)
    )
    with_traces = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100, avg_context_tokens=80000),
        sandbox_traces=_traces(turns_per_trace=2, in_tok=1000, out_tok=5000),
    )
    assert with_traces["tokensPerCall"] > no_traces["tokensPerCall"]  # 5000-out measured


def test_sandbox_tokens_used_when_nothing_declared():
    fc = forecast_spend(
        _agent([_github_tool(1)], expected_calls_per_day=100),
        sandbox_traces=_traces(turns_per_trace=2, in_tok=3000, out_tok=300),
    )
    assert fc["tokensPerCall"] == 3300
    assert fc["inputSources"]["tokensPerCall"] == "measured"


def test_cost_report_discloses_assumptions():
    """D18: every breach-cost multiplier and basis must be disclosed in plain
    English on the report — no silent x0.3/x0.05 behind a CFO headline number."""
    from analysis.cost_model import generate_cost_report, report_to_dict

    agent = {
        "id": "t", "name": "t",
        "tools": [{"name": "stripe", "actions": [
            {"action": "create_refund", "risk_labels": ["moves_money"], "reversible": True},
        ]}],
    }
    report = generate_cost_report(agent, policies=[{"action_pattern": "stripe.create_refund", "effect": "BLOCK"}])
    d = report_to_dict(report)
    text = " ".join(d["assumptions"]).lower()
    assert "reversible" in text          # x0.3 disclosed with rationale
    assert "policy" in text or "block" in text  # x0.05 disclosed
    assert "one worst-case incident" in text    # annualized basis disclosed
    assert "industry-anchored" in text          # default ranges cite their basis
