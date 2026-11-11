"""Try a prompt on one of the team's own agents.

Two ways in, chosen per try:
  instructions  the prompt replaces the agent's system prompt; the agent gets a test task
  task          the agent keeps its own instructions and receives the filled prompt

Two depths:
  estimate  free, no LLM. The sandbox dry-run predicts which of the agent's actions
            the prompt reaches; those are scored with the agent-detail blast-radius
            recipe next to the agent's full ceiling. Cost uses the agent's model,
            turns and volume, side by side with the agent as it is today.
  run       one real sandbox run (mock tools, real policy enforcement) on the
            agent's model. Metered like QA: the team's own key, else one of the
            free runs. Stored as a simulation so it shows in the agent's history.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from typing import Literal, Optional

from analysis.spend_forecast import _estimate_tool_cost_per_call, load_defaults, price_call
from llm_models import SIM_MODEL
from sandbox.models import Scenario

from . import qa
from .cost import score_cost
from .danger import _capability_labels

Mode = Literal["instructions", "task"]

MAX_TURNS = 8
MIN_TURNS = 2
SIM_MAX_OUTPUT = 4096          # sandbox/runner.py's per-call max_tokens
TOKENS_PER_ACTION_DEF = 60     # tool schema overhead the agent sends every turn
ASSUMED_OUTPUT_TOKENS = 400    # per turn, when nothing is measured
HISTORY_TOKENS_PER_TURN = 600  # tool results + prior turns carried forward
DEFAULT_TURNS = 3

# Labels whose pairing with an untrusted placeholder is worth a callout.
_HIGH_IMPACT = ("moves_money", "deletes_data", "sends_external", "changes_production",
                "changes_access", "bulk_export", "executes_code", "reads_secrets")

# "this agent can <phrase>" / "the prompt asks to <phrase>"
_CAN = {
    "moves_money": "move money", "touches_pii": "read personal data", "deletes_data": "delete data",
    "sends_external": "send messages outside the company", "changes_production": "change production",
    "changes_access": "change who has access", "reads_secrets": "read secrets",
    "evades_detection": "turn off logging", "bulk_export": "export data in bulk", "executes_code": "run code",
}


def _can(label: str) -> str:
    return _CAN.get(label, label.replace("_", " "))


def _join(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


# ── building the try ─────────────────────────────────────────────────────

def default_task(agent: dict) -> str:
    desc = (agent.get("description") or "").strip()
    return f"Handle a typical request for {agent['name']}" + (f" ({desc})." if desc else ".")


def build_try(prompt: dict, agent: dict, mode: Mode, task: Optional[str],
              values: Optional[dict[str, str]] = None) -> tuple[Optional[str], str]:
    """(system prompt override or None, user message)."""
    body = qa._fill(prompt.get("body") or "", {**qa._sample_values(prompt), **(values or {})})
    if mode == "instructions":
        return body, (task or "").strip() or default_task(agent)
    return None, body


def _scenario(prompt: dict, agent: dict, user_msg: str) -> Scenario:
    return Scenario(
        id=f"prompt:{prompt['id']}", name=f"Prompt: {prompt.get('title') or 'Untitled'}",
        description="Prompt library: try on my agent", agent_type=agent["id"],
        category="custom", severity="info", prompt=user_msg,
    )


def _action_count(agent: dict) -> int:
    return sum(len(t.get("actions") or []) for t in agent.get("tools") or [])


# ── cost ─────────────────────────────────────────────────────────────────

def _volume(agent: dict, prompt: dict) -> tuple[Optional[float], int]:
    runs = agent.get("expected_calls_per_day") or prompt.get("runs_per_day")
    turns = int(agent.get("expected_turns_per_run") or DEFAULT_TURNS)
    return (float(runs) if runs else None), max(1, turns)


def _per_run(text: str, agent: dict, model: str, turns: int, defaults: dict, org: Optional[str]) -> dict:
    """Estimated $ for one agent run whose instructions + request are `text`."""
    row = score_cost(text, {}, expected_output_tokens=ASSUMED_OUTPUT_TOKENS, models=[model],
                     org_id=org, allow_network=False)["models"][0]
    if not row.get("available"):
        return {"available": False, "model": model}
    overhead = _action_count(agent) * TOKENS_PER_ACTION_DEF + int(agent.get("avg_context_tokens") or 0)
    in_per_turn = row["input_tokens"] + overhead
    llm = 0.0
    for t in range(turns):
        llm += price_call(row["model_key"], in_per_turn + t * HISTORY_TOKENS_PER_TURN,
                          ASSUMED_OUTPUT_TOKENS, defaults=defaults)["usd"] or 0.0
    tools, _, _ = _estimate_tool_cost_per_call(agent, defaults)
    return {"available": True, "model_key": row["model_key"], "input_tokens_per_turn": in_per_turn,
            "output_tokens_per_turn": ASSUMED_OUTPUT_TOKENS, "llm_usd": round(llm, 8),
            "tool_usd": round(tools, 8), "usd_per_run": round(llm + tools, 8)}


def _cost_block(per_run: dict, baseline: dict, runs_per_day: Optional[float], turns: int) -> dict:
    out = {**per_run, "turns": turns, "runs_per_day": runs_per_day, "basis": "estimate"}
    if not per_run.get("available"):
        return out
    if runs_per_day:
        out["usd_per_month"] = round(per_run["usd_per_run"] * runs_per_day * 30, 4)
    if baseline.get("available") and baseline["usd_per_run"] > 0:
        out["baseline_usd_per_run"] = baseline["usd_per_run"]
        if runs_per_day:
            out["baseline_usd_per_month"] = round(baseline["usd_per_run"] * runs_per_day * 30, 4)
        out["delta_pct"] = round((per_run["usd_per_run"] / baseline["usd_per_run"] - 1) * 100, 1)
    return out


# ── blast radius ─────────────────────────────────────────────────────────

def _radius_dict(radius) -> dict:
    return {"score": radius.score, "residual_score": radius.residual_score, "band": radius.band,
            "magnitude_usd": radius.magnitude_usd,
            "top_contributors": list(radius.top_contributors or [])[:5]}


def _agent_labels(catalog: dict, agent: dict) -> dict[str, list[str]]:
    """risk label -> ["tool.action", ...] the agent can perform."""
    out: dict[str, list[str]] = {}
    for t in agent.get("tools") or []:
        for a in t.get("actions") or []:
            mapped = (catalog.get(t["name"]) or {}).get(a["action"])
            for lab in (mapped.risk_labels if mapped else a.get("risk_labels") or []):
                out.setdefault(lab, []).append(f"{t['name']}.{a['action']}")
    return out


def _overlaps(prompt: dict, agent_labels: dict[str, list[str]]) -> list[dict]:
    """Where the prompt's own risks meet what this agent can actually do."""
    danger = prompt.get("danger_summary") or {}
    untrusted = danger.get("untrusted_variables") or []
    wants = set(_capability_labels(prompt.get("body") or "", prompt.get("tools") or []))
    wants |= set(((prompt.get("ai_check") or {}).get("labels") or {}).keys())
    out = []
    reachable_high = [l for l in _HIGH_IMPACT if l in agent_labels]
    if untrusted and reachable_high:
        names = ", ".join("{{" + v + "}}" for v in untrusted[:3])
        out.append({"severity": "critical" if len(reachable_high) > 1 else "high",
                    "title": f"{names} can carry injected instructions into an agent that can "
                             + _join([_can(l) for l in reachable_high[:3]]),
                    "actions": [a for l in reachable_high for a in agent_labels[l]][:6]})
    for lab in sorted(wants):
        if lab in agent_labels:
            out.append({"severity": "medium", "title": f"The prompt asks it to {_can(lab)}, "
                                                      "and this agent can",
                        "actions": agent_labels[lab][:4]})
        else:
            out.append({"severity": "info", "title": f"The prompt asks it to {_can(lab)}, "
                                                    "but this agent has no tool for that",
                        "actions": []})
    return out


def _steps(trace, report) -> list[dict]:
    return [{"tool": s.tool, "action": s.action, "decision": s.enforce_decision} for s in trace.steps]


def _chains(report) -> list[dict]:
    return [{"name": c.chain_name, "severity": c.severity} for c in report.chains_triggered]


def _model(agent: dict) -> str:
    return agent.get("simulation_model") or SIM_MODEL


# ── estimate ─────────────────────────────────────────────────────────────

def estimate(conn, prompt: dict, agent: dict, mode: Mode, task: Optional[str],
             values: Optional[dict], org: Optional[str]) -> dict:
    """Free: no LLM call, no metering."""
    from main import _agent_risk_snapshot
    from sandbox.analyzer import analyze_trace
    from sandbox.runner import run_simulation_dry

    system, user_msg = build_try(prompt, agent, mode, task, values)
    ceiling = _agent_risk_snapshot(conn, agent, org)
    # The dry run reads intent from one text; give it the instructions too.
    dry_scn = _scenario(prompt, agent, f"{system}\n\n{user_msg}" if system else user_msg)
    trace = run_simulation_dry(agent, dry_scn)
    report = analyze_trace(trace, scenario=dry_scn, summarize=False)
    reached = {(s.tool, s.action) for s in trace.steps}
    reach = _agent_risk_snapshot(conn, agent, org, only_actions=reached)
    reach_d = _radius_dict(reach["radius"])
    ceil_d = _radius_dict(ceiling["radius"])
    reach_d["score"] = min(reach_d["score"], ceil_d["score"])

    defaults = load_defaults(org)
    runs_per_day, turns = _volume(agent, prompt)
    model = _model(agent)
    with_prompt = _per_run(f"{system or agent.get('system_prompt') or ''}\n\n{user_msg}", agent, model,
                           turns, defaults, org)
    # The agent as it is today: its own instructions on a typical request.
    baseline = _per_run(f"{agent.get('system_prompt') or ''}\n\n{default_task(agent)}", agent, model,
                        turns, defaults, org)

    return {
        "mode": mode, "basis": "estimate",
        "agent": {"id": agent["id"], "name": agent["name"], "model": model},
        "system_prompt": system, "user_message": user_msg,
        "blast_radius": {
            "reachable": reach_d, "ceiling": ceil_d,
            "likely_actions": _steps(trace, report),
            "chains": _chains(report),
            "ceiling_chains": [{"name": fc.chain.name, "severity": fc.chain.severity}
                               for fc in ceiling["chain_result"].flagged_chains][:6],
            "overlaps": _overlaps(prompt, _agent_labels(ceiling["catalog"], agent)),
        },
        "efficiency": {**_cost_block(with_prompt, baseline, runs_per_day, turns),
                       "tool_calls": len(trace.steps)},
    }


# ── real run ─────────────────────────────────────────────────────────────

def _worst_case(model_key: str, in_per_turn: int, turns: int, defaults: dict) -> float:
    return sum(price_call(model_key, in_per_turn + t * HISTORY_TOKENS_PER_TURN * 2, SIM_MAX_OUTPUT,
                          defaults=defaults)["usd"] or 0.0 for t in range(turns))


def run(prompt: dict, agent: dict, mode: Mode, task: Optional[str], values: Optional[dict],
        org: Optional[str], user: dict) -> dict:
    """One metered sandbox run. Raises qa.QaError for key / cap / model problems."""
    from db import get_db, log_audit
    from sandbox.analyzer import analyze_trace
    from sandbox.runner import run_simulation

    system, user_msg = build_try(prompt, agent, mode, task, values)
    model = _model(agent)
    (model_key, provider), = qa.resolve_models([model], org)
    keys = qa.Keys(org, {provider})
    defaults = load_defaults(org)

    row = score_cost(f"{system or agent.get('system_prompt') or ''}\n\n{user_msg}", {}, models=[model_key],
                     org_id=org, allow_network=False)["models"][0]
    in_per_turn = row["input_tokens"] + _action_count(agent) * TOKENS_PER_ACTION_DEF
    turns = MAX_TURNS
    while turns > MIN_TURNS and _worst_case(model_key, in_per_turn, turns, defaults) > qa.RUN_CAP_USD:
        turns -= 1
    qa.check_caps(_worst_case(model_key, in_per_turn, turns, defaults), keys, org)

    scenario = _scenario(prompt, agent, user_msg)
    started = time.perf_counter()
    trace = run_simulation(agent, scenario, api_key=keys.key_for(provider), max_turns=turns,
                           system_prompt=system)
    wall_ms = int((time.perf_counter() - started) * 1000)
    report = analyze_trace(trace, scenario=scenario)

    usage = trace.turn_usage
    llm_usd = sum(price_call(model_key, u.input_tokens, u.output_tokens, cached_input=u.cached_input_tokens,
                             defaults=defaults)["usd"] or 0.0 for u in usage)
    tools_usd, _, _ = _estimate_tool_cost_per_call(agent, defaults, [asdict(trace)])
    keys.record("agent_try", llm_usd)
    if keys.uses_server:
        # The sandbox runner doesn't meter; Arceo's key counts toward the org's COGS cap.
        import cogs
        for u in usage:
            cogs.record(model_key, {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens},
                        org_id=org, source="prompt_agent_try")

    with get_db() as conn:
        conn.execute("""
            INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at, run_mode)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (trace.simulation_id, trace.agent_id, trace.scenario_id, trace.status,
              json.dumps(asdict(trace)), json.dumps(asdict(report)), org, trace.started_at, "live"))
        log_audit(conn, user["sub"], user["email"], "RUN_SIMULATION", resource=agent["id"],
                  detail=f"Prompt library try: {prompt['id']}", org_id=org)

    runs_per_day, _ = _volume(agent, prompt)
    per_run = llm_usd + tools_usd
    lat = [u.latency_ms for u in usage if u.latency_ms]
    return {
        "mode": mode, "basis": "measured",
        "agent": {"id": agent["id"], "name": agent["name"], "model": model},
        "simulation_id": trace.simulation_id, "status": trace.status, "error": trace.error,
        "system_prompt": system, "user_message": user_msg,
        "blast_radius": {
            "risk_score": report.risk_score,
            "actions": _steps(trace, report),
            "executed": report.actions_executed, "blocked": report.actions_blocked,
            "pending": report.actions_pending,
            "chains": _chains(report),
            "violations": [{"title": v.title, "severity": v.severity} for v in report.violations][:8],
            "summary": report.executive_summary,
        },
        "efficiency": {
            "model_key": model_key, "turns": len(usage), "max_turns": turns, "tool_calls": len(trace.steps),
            "input_tokens": sum(u.input_tokens for u in usage),
            "output_tokens": sum(u.output_tokens for u in usage),
            "latency_ms": sum(lat) if lat else wall_ms,
            "latency_ms_per_turn": int(sum(lat) / len(lat)) if lat else None,
            "llm_usd": round(llm_usd, 8), "tool_usd": round(tools_usd, 8),
            "usd_per_run": round(per_run, 8),
            "usd_per_month": round(per_run * runs_per_day * 30, 4) if runs_per_day else None,
            "runs_per_day": runs_per_day,
        },
        "key_source": "server" if keys.uses_server else "org",
    }
