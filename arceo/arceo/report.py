"""Beautiful terminal report — scannable in 5 seconds."""

from __future__ import annotations

from arceo.models import ArceoTrace

_TL, _TR, _BL, _BR = "\u250c", "\u2510", "\u2514", "\u2518"
_H, _V, _ML, _MR = "\u2500", "\u2502", "\u251c", "\u2524"
_BLK, _LT = "\u2588", "\u2591"
_OK, _WARN, _FAIL = "\u2705", "\u26a0\ufe0f", "\u274c"
_CHAIN, _ARROW = "\u26d3", "\u2192"

W = 52


def _line(text):
    print("%s %-*s%s" % (_V, W, text, _V))


def print_report(trace: ArceoTrace, chains=None, backend_data=None):
    """Print the risk report to terminal."""
    chains = chains or []
    bd = backend_data or {}
    blast = bd.get("blast_radius", {}).get("score", 0)
    br_report = bd.get("report", {})

    print()
    print(_TL + _H * (W + 1) + _TR)
    _line("Arceo Risk Report")
    print(_ML + _H * (W + 1) + _MR)
    _line("Agent: %s" % trace.agent_name)
    if trace.framework:
        _line("Framework: %s" % trace.framework)

    tools = sorted(set(tc.tool_name for tc in trace.tool_calls))
    _line("Tools: %d (%s)" % (len(tools), ", ".join(tools[:4])))
    _line("Actions: %d calls this run" % len(trace.tool_calls))

    if trace.llm_calls:
        models = set(c.model for c in trace.llm_calls if c.model)
        tokens = sum(c.input_tokens + c.output_tokens for c in trace.llm_calls)
        _line("LLM: %d calls, %d tokens (%s)" % (len(trace.llm_calls), tokens, ", ".join(models) or "?"))

    _line("")

    # Blast radius
    if blast > 0:
        bar_len = int(blast / 100 * 20)
        bar = _BLK * bar_len + _LT * (20 - bar_len)
        icon = _OK if blast < 40 else _WARN if blast < 70 else _FAIL
        _line("Blast Radius: %s %.0f/100 %s" % (bar, blast, icon))
    else:
        # Local estimate from tool calls
        from arceo.analysis.risk import infer_risk
        score = 0
        for tc in trace.tool_calls:
            if not tc.is_read_only:
                score += len(tc.inferred_risk_hints) * 5
        score = min(100, score)
        bar_len = int(score / 100 * 20)
        bar = _BLK * bar_len + _LT * (20 - bar_len)
        icon = _OK if score < 40 else _WARN if score < 70 else _FAIL
        _line("Risk Estimate: %s ~%d/100 %s" % (bar, score, icon))

    # Chains
    if chains:
        _line("Dangerous Chains: %d" % len(chains))
        for c in chains[:3]:
            sev = c.get("severity", "?")
            fr = c.get("from_operation", "?")
            to = c.get("to_operation", "?")
            _line("  %s %s %s %s [%s]" % (_CHAIN, fr, _ARROW, to, sev))
    else:
        _line("Dangerous Chains: 0 %s" % _OK)

    # Tool calls
    if trace.tool_calls:
        _line("")
        _line("Tool Calls This Run: %d" % len(trace.tool_calls))
        for tc in trace.tool_calls[:8]:
            if tc.is_read_only:
                icon = _OK
                label = "read_only"
            elif any(h in ("deletes_data", "moves_money") for h in tc.inferred_risk_hints):
                icon = _WARN
                label = ", ".join(tc.inferred_risk_hints)
            elif tc.inferred_risk_hints:
                icon = _OK
                label = ", ".join(tc.inferred_risk_hints)
            else:
                icon = _OK
                label = "internal"
            _line("  %s %s (%s)" % (icon, tc.full_operation, label))

    # Backend violations
    violations = br_report.get("violations", [])
    if violations:
        _line("")
        _line("Violations: %d" % len(violations))
        for v in violations[:4]:
            _line("  [%s] %s" % (v.get("severity", "?"), v.get("title", "?")))

    # Policy
    _line("")
    policy_v = br_report.get("policy_violations", [])
    if policy_v:
        _line("Policy: %d violation(s) %s" % (len(policy_v), _FAIL))
    else:
        _line("Policy: No violations %s" % _OK)

    # Duration
    if trace.total_duration_ms > 0:
        _line("")
        _line("Duration: %.0fms" % trace.total_duration_ms)

    print(_BL + _H * (W + 1) + _BR)
    print()
