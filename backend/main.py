"""ActionGate API — Authority Engine with auth, CRUD, enforcement, audit, execution tracking."""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict
from datetime import datetime

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from auth import get_current_user, login_user
from db import (
    get_db, init_db, get_agent_from_db, get_all_agents_from_db,
    log_audit, log_execution,
)
from authority.chain_detector import detect_chains as _detect_chains
from authority.graph import build_agent_graph, calculate_blast_radius, graph_to_dict
from authority.parser import AgentConfig, ToolDef, parse_agent_config

app = FastAPI(title="ActionGate", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()


# ── Helpers ─────────────────────────────────────────────────────────────────

def _db_agent_to_config(agent_dict: dict) -> AgentConfig:
    """Convert a DB agent dict to an AgentConfig for the engine."""
    return AgentConfig(
        id=agent_dict["id"],
        name=agent_dict["name"],
        description=agent_dict["description"] or "",
        tools=[
            ToolDef(
                name=t["name"],
                service=t["service"],
                description=t["description"] or "",
                actions=[a["action"] for a in t["actions"]],
            )
            for t in agent_dict["tools"]
        ],
    )


def _db_agent_to_action_catalog(agent_dict: dict) -> dict:
    """Build an action catalog from DB data for risk analysis."""
    from authority.action_mapper import MappedAction, ACTION_CATALOG

    # Merge: use DB data, fall back to hardcoded catalog
    catalog = {}
    for tool in agent_dict["tools"]:
        tool_actions = {}
        hardcoded = ACTION_CATALOG.get(tool["name"], {})
        for a in tool["actions"]:
            if a["action"] in hardcoded:
                tool_actions[a["action"]] = hardcoded[a["action"]]
            else:
                tool_actions[a["action"]] = MappedAction(
                    tool=tool["name"],
                    service=tool["service"],
                    action=a["action"],
                    description=a["description"],
                    risk_labels=a["risk_labels"],
                    reversible=a["reversible"],
                )
        catalog[tool["name"]] = tool_actions
    return catalog


def _compute_agent_summary(agent_dict: dict) -> dict:
    """Compute blast radius and chains for a DB agent."""
    config = _db_agent_to_config(agent_dict)
    radius = calculate_blast_radius(config)
    chain_result = _detect_chains(config)
    return {
        "blast_radius": asdict(radius),
        "chain_count": len(chain_result.flagged_chains),
        "critical_chains": sum(1 for fc in chain_result.flagged_chains if fc.chain.severity == "critical"),
    }


def _generate_recommendations(radius, chain_result) -> list[dict]:
    recs = []
    if radius.moves_money > 2:
        recs.append({"severity": "critical", "title": "Restrict financial actions",
                      "description": f"This agent can perform {radius.moves_money} money-moving actions. Add approval gates for create_charge, create_refund, and cancel_subscription."})
    if radius.deletes_data > 1:
        recs.append({"severity": "critical", "title": "Add deletion safeguards",
                      "description": f"This agent can delete data in {radius.deletes_data} ways. Require confirmation or soft-delete instead of hard-delete."})
    if radius.touches_pii > 4:
        recs.append({"severity": "high", "title": "Limit PII access scope",
                      "description": f"This agent touches PII in {radius.touches_pii} actions. Apply field-level masking and audit logging."})
    if radius.sends_external > 2:
        recs.append({"severity": "high", "title": "Gate external communications",
                      "description": f"This agent can send {radius.sends_external} types of external messages. Add human-in-the-loop for outbound comms."})
    if radius.changes_production > 3:
        recs.append({"severity": "critical", "title": "Require deployment approval",
                      "description": f"This agent can modify production in {radius.changes_production} ways. Add mandatory approval for merge, deploy, and infrastructure changes."})
    critical_chains = [fc for fc in chain_result.flagged_chains if fc.chain.severity == "critical"]
    if critical_chains:
        recs.append({"severity": "critical", "title": "Break dangerous action chains",
                      "description": f"{len(critical_chains)} critical chains detected. Insert approval gates between read and write steps to prevent automated exploitation."})
    if radius.irreversible_actions > 3:
        recs.append({"severity": "high", "title": "Add undo capability",
                      "description": f"{radius.irreversible_actions} actions are irreversible. Implement soft-delete patterns and transaction logs."})
    return recs


# ── Auth endpoints ──────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def login(req: LoginRequest):
    return login_user(req.email, req.password)


@app.get("/api/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {"user": {"id": user["sub"], "email": user["email"], "role": user["role"]}}


# ── Authority Engine: READ endpoints ────────────────────────────────────────

@app.get("/api/authority/agents")
def list_agents(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        log_audit(conn, user["sub"], user["email"], "LIST_AGENTS")
        agents = get_all_agents_from_db(conn)

    results = []
    for agent in agents:
        summary = _compute_agent_summary(agent)
        results.append({
            "id": agent["id"],
            "name": agent["name"],
            "description": agent["description"],
            "tools": [t["service"] for t in agent["tools"]],
            "created_at": agent["created_at"],
            **summary,
        })

    return {"agents": results}


@app.get("/api/authority/agent/{agent_id}")
def get_agent_detail(agent_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        agent = get_agent_from_db(conn, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        log_audit(conn, user["sub"], user["email"], "VIEW_AGENT", resource=agent_id)

        # Get policies for this agent
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY created_at DESC", (agent_id,)
        ).fetchall()

        # Get execution logs for this agent
        executions = conn.execute(
            "SELECT * FROM execution_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 50", (agent_id,)
        ).fetchall()

    config = _db_agent_to_config(agent)
    graph = build_agent_graph(config)
    radius = calculate_blast_radius(config)
    chain_result = _detect_chains(config)

    flagged = []
    for fc in chain_result.flagged_chains:
        flagged.append({
            "id": fc.chain.id, "name": fc.chain.name, "description": fc.chain.description,
            "severity": fc.chain.severity, "steps": fc.chain.steps,
            "matching_actions": fc.matching_actions,
        })

    recommendations = _generate_recommendations(radius, chain_result)

    return {
        "agent": {
            "id": agent["id"], "name": agent["name"], "description": agent["description"],
            "created_at": agent["created_at"],
            "tools": [{"name": t["name"], "service": t["service"], "description": t["description"],
                        "actions": t["actions"]} for t in agent["tools"]],
        },
        "graph": graph_to_dict(graph),
        "blast_radius": asdict(radius),
        "chains": flagged,
        "recommendations": recommendations,
        "policies": [dict(p) for p in policies],
        "executions": [dict(e) for e in executions],
    }


@app.get("/api/authority/chains")
def list_all_chains(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        agents = get_all_agents_from_db(conn)

    output = []
    for agent in agents:
        config = _db_agent_to_config(agent)
        chain_result = _detect_chains(config)
        for fc in chain_result.flagged_chains:
            output.append({
                "agent_id": agent["id"], "agent_name": agent["name"],
                "chain_id": fc.chain.id, "chain_name": fc.chain.name,
                "description": fc.chain.description, "severity": fc.chain.severity,
                "steps": fc.chain.steps, "matching_actions": fc.matching_actions,
            })
    return {"chains": output}


# ── Agent CRUD ──────────────────────────────────────────────────────────────

class ToolActionInput(BaseModel):
    action: str
    description: str = ""
    risk_labels: list[str] = []
    reversible: bool = True


class ToolInput(BaseModel):
    name: str
    service: str
    description: str = ""
    actions: list[ToolActionInput] = []


class AgentInput(BaseModel):
    name: str
    description: str = ""
    tools: list[ToolInput] = []


@app.post("/api/authority/agents")
def create_agent(req: AgentInput, user: dict = Depends(get_current_user)):
    agent_id = req.name.lower().replace(" ", "-").replace("_", "-")
    now = datetime.utcnow().isoformat()

    with get_db() as conn:
        # Check for duplicate
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if existing:
            agent_id = f"{agent_id}-{uuid.uuid4().hex[:6]}"

        conn.execute(
            "INSERT INTO agents (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (agent_id, req.name, req.description, now, now),
        )

        for tool in req.tools:
            cur = conn.execute(
                "INSERT INTO agent_tools (agent_id, name, service, description) VALUES (?, ?, ?, ?)",
                (agent_id, tool.name, tool.service, tool.description),
            )
            tool_id = cur.lastrowid
            for a in tool.actions:
                conn.execute(
                    "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                    (tool_id, a.action, a.description, json.dumps(a.risk_labels), a.reversible),
                )

        log_audit(conn, user["sub"], user["email"], "CREATE_AGENT", resource=agent_id,
                  detail=f"Created agent '{req.name}' with {len(req.tools)} tools")

    return {"id": agent_id, "message": "Agent created"}


@app.put("/api/authority/agent/{agent_id}")
def update_agent(agent_id: str, req: AgentInput, user: dict = Depends(get_current_user)):
    now = datetime.utcnow().isoformat()

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        conn.execute(
            "UPDATE agents SET name = ?, description = ?, updated_at = ? WHERE id = ?",
            (req.name, req.description, now, agent_id),
        )

        # Delete old tools/actions and re-insert
        conn.execute("DELETE FROM agent_tools WHERE agent_id = ?", (agent_id,))

        for tool in req.tools:
            cur = conn.execute(
                "INSERT INTO agent_tools (agent_id, name, service, description) VALUES (?, ?, ?, ?)",
                (agent_id, tool.name, tool.service, tool.description),
            )
            tool_id = cur.lastrowid
            for a in tool.actions:
                conn.execute(
                    "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                    (tool_id, a.action, a.description, json.dumps(a.risk_labels), a.reversible),
                )

        log_audit(conn, user["sub"], user["email"], "UPDATE_AGENT", resource=agent_id,
                  detail=f"Updated agent '{req.name}'")

    return {"message": "Agent updated"}


@app.delete("/api/authority/agent/{agent_id}")
def delete_agent(agent_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        existing = conn.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        log_audit(conn, user["sub"], user["email"], "DELETE_AGENT", resource=agent_id,
                  detail=f"Deleted agent '{existing['name']}'")

    return {"message": "Agent deleted"}


# ── Enforcement Policies ────────────────────────────────────────────────────

class PolicyInput(BaseModel):
    action_pattern: str
    effect: str  # BLOCK, REQUIRE_APPROVAL, ALLOW
    reason: str = ""


@app.get("/api/authority/agent/{agent_id}/policies")
def list_policies(agent_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY created_at DESC", (agent_id,)
        ).fetchall()
    return {"policies": [dict(p) for p in policies]}


@app.post("/api/authority/agent/{agent_id}/policies")
def create_policy(agent_id: str, req: PolicyInput, user: dict = Depends(get_current_user)):
    if req.effect not in ("BLOCK", "REQUIRE_APPROVAL", "ALLOW"):
        raise HTTPException(status_code=400, detail="Effect must be BLOCK, REQUIRE_APPROVAL, or ALLOW")

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        cur = conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (agent_id, req.action_pattern, req.effect, req.reason, user["email"], datetime.utcnow().isoformat()),
        )

        log_audit(conn, user["sub"], user["email"], "CREATE_POLICY", resource=agent_id,
                  detail=f"{req.effect} on {req.action_pattern}")

    return {"id": cur.lastrowid, "message": "Policy created"}


@app.delete("/api/authority/policy/{policy_id}")
def delete_policy(policy_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        policy = conn.execute("SELECT * FROM policies WHERE id = ?", (policy_id,)).fetchone()
        if not policy:
            raise HTTPException(status_code=404, detail="Policy not found")

        conn.execute("DELETE FROM policies WHERE id = ?", (policy_id,))
        log_audit(conn, user["sub"], user["email"], "DELETE_POLICY", resource=str(policy_id),
                  detail=f"Removed {policy['effect']} on {policy['action_pattern']}")

    return {"message": "Policy deleted"}


# ── Enforcement Check (what agents call at runtime) ─────────────────────────

class EnforceRequest(BaseModel):
    agent_id: str
    tool: str
    action: str


@app.post("/api/enforce")
def enforce_action(req: EnforceRequest):
    """Runtime enforcement — agents call this before executing an action."""
    action_key = f"{req.tool}.{req.action}"

    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY id", (req.agent_id,)
        ).fetchall()

        # Check policies: most specific match wins
        matched_policy = None
        for p in policies:
            pattern = p["action_pattern"]
            # Exact match
            if pattern == action_key:
                matched_policy = p
                break
            # Wildcard: "stripe.*" matches "stripe.create_refund"
            if pattern.endswith(".*") and action_key.startswith(pattern[:-1]):
                matched_policy = p
            # Wildcard: "*.delete_*" matches "salesforce.delete_record"
            if "*" in pattern:
                parts = pattern.split(".")
                key_parts = action_key.split(".")
                if len(parts) == 2 and len(key_parts) == 2:
                    tool_match = parts[0] == "*" or parts[0] == key_parts[0]
                    action_match = parts[1] == "*" or (parts[1].endswith("*") and key_parts[1].startswith(parts[1][:-1]))
                    if tool_match and action_match:
                        matched_policy = p

        if matched_policy:
            effect = matched_policy["effect"]
            status = "BLOCKED" if effect == "BLOCK" else "PENDING_APPROVAL" if effect == "REQUIRE_APPROVAL" else "EXECUTED"
        else:
            effect = "ALLOW"
            status = "EXECUTED"

        log_execution(conn, req.agent_id, req.tool, req.action, status,
                      policy_id=matched_policy["id"] if matched_policy else None,
                      detail=matched_policy["reason"] if matched_policy else "No matching policy")

        return {
            "decision": effect,
            "action": action_key,
            "agent_id": req.agent_id,
            "policy": dict(matched_policy) if matched_policy else None,
            "message": matched_policy["reason"] if matched_policy else "Action allowed — no matching policy",
        }


# ── Audit Log ───────────────────────────────────────────────────────────────

@app.get("/api/audit")
def get_audit_log(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 100"
        ).fetchall()
    return {"entries": [dict(r) for r in rows]}


# ── Execution Log ───────────────────────────────────────────────────────────

@app.get("/api/executions")
def get_execution_log(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM execution_log ORDER BY timestamp DESC LIMIT 100"
        ).fetchall()
    return {"entries": [dict(r) for r in rows]}


@app.get("/api/executions/{agent_id}")
def get_agent_executions(agent_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM execution_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 50",
            (agent_id,),
        ).fetchall()
    return {"entries": [dict(r) for r in rows]}


# ── Health ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}
