"""Shared ingestion pipeline — normalize, register, analyze, store."""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from dataclasses import asdict

from db import get_db, get_agent_from_db, log_audit, DEFAULT_ORG_ID
from sandbox.models import SimulationTrace, TraceStep
from sandbox.analyzer import analyze_trace


def ingest_trace(
    agent_name: str,
    normalized_steps: list[dict],
    org_id: str = DEFAULT_ORG_ID,
    user_id: str = None,
    user_email: str = None,
    source: str = "generic",
) -> dict:
    """Shared pipeline: auto-register agent → build trace → analyze → store → return report.

    normalized_steps: [{"tool": str, "action": str, "params": dict, "result": dict, "timestamp": str, "duration_ms": float}]
    """
    from authority.risk_classifier import classify_with_fallback

    agent_id = agent_name.lower().replace(" ", "-").replace("_", "-")

    # Auto-register agent from detected tools
    tools_from_trace: dict[str, set] = {}
    for step in normalized_steps:
        tools_from_trace.setdefault(step["tool"], set()).add(step["action"])

    reg_tools = []
    for tool_name, actions in tools_from_trace.items():
        reg_tools.append({
            "name": tool_name,
            "service": tool_name.replace("-", " ").replace("_", " ").title(),
            "description": tool_name,
            "actions": [{"name": a, "description": a} for a in sorted(actions)],
        })

    # Upsert agent
    with get_db() as conn:
        from main import _upsert_agent
        _upsert_agent(conn, agent_id, agent_name, agent_name, reg_tools, f"ingest-{source}")

        # Set org_id on the agent
        conn.execute("UPDATE agents SET org_id = ? WHERE id = ?", (org_id, agent_id))

    # Build simulation trace
    trace = SimulationTrace(
        simulation_id=uuid.uuid4().hex[:12],
        agent_id=agent_id,
        agent_name=agent_name,
        scenario_id=f"ingest-{source}",
        scenario_name=f"Ingested from {source}",
        prompt=f"Historical trace from {source}",
    )

    for i, step in enumerate(normalized_steps):
        trace.steps.append(TraceStep(
            step_index=i,
            tool=step["tool"],
            action=step["action"],
            params=step.get("params", {}),
            enforce_decision="ALLOW",  # historical — already happened
            enforce_policy=None,
            result=step.get("result", {}),
            timestamp=step.get("timestamp", ""),
        ))

    # Analyze
    report = analyze_trace(trace)

    # Store
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (trace.simulation_id, agent_id, f"ingest-{source}", "completed",
             json.dumps(asdict(trace), default=str),
             json.dumps(asdict(report), default=str),
             org_id, datetime.utcnow().isoformat()),
        )

        if user_id:
            log_audit(conn, user_id, user_email, f"INGEST_{source.upper()}", resource=agent_id,
                      detail=f"Ingested {len(normalized_steps)} actions, risk={report.risk_score}", org_id=org_id)

    # Get blast radius
    with get_db() as conn:
        agent = get_agent_from_db(conn, agent_id)

    from main import _compute_agent_summary
    summary = _compute_agent_summary(agent)

    return {
        "agent_id": agent_id,
        "source": source,
        "actions_ingested": len(normalized_steps),
        "tools_detected": list(tools_from_trace.keys()),
        "simulation_id": trace.simulation_id,
        "blast_radius": summary["blast_radius"],
        "report": {
            "risk_score": report.risk_score,
            "violations": len(report.violations),
            "chains": len(report.chains_triggered),
            "data_flows": len(report.data_flows),
            "volume_violations": len(report.volume_violations),
            "executive_summary": report.executive_summary,
        },
    }
