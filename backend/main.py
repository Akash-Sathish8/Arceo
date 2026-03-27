"""ActionGate API — Authority Engine with auth, CRUD, enforcement, audit, execution tracking."""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict
from datetime import datetime

from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth import get_current_user, login_user
from db import (
    get_db, init_db, get_agent_from_db, get_all_agents_from_db,
    log_audit, log_execution,
)
from authority.chain_detector import detect_chains as _detect_chains
from authority.graph import build_agent_graph, calculate_blast_radius, graph_to_dict
from authority.parser import AgentConfig, ToolDef, parse_agent_config
from authority.risk_classifier import classify_with_fallback, schema_hints

import os
import time
from collections import defaultdict

app = FastAPI(title="ActionGate", version="0.4.0")

# Simple in-memory rate limiter
_rate_limits: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_MAX = int(os.getenv("RATE_LIMIT_MAX", "100"))  # requests per window
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))  # seconds


def check_rate_limit(key: str):
    """Check rate limit for a key. Raises 429 if exceeded."""
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    _rate_limits[key] = [t for t in _rate_limits[key] if t > window_start]
    if len(_rate_limits[key]) >= RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")
    _rate_limits[key].append(now)

ALLOWED_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()


def _match_policy(action_key: str, policies: list) -> dict | None:
    """Match an action key against a list of policies. Returns first match or None."""
    for p in policies:
        pattern = p["action_pattern"]
        if pattern == action_key:
            return p
        if pattern.endswith(".*") and action_key.startswith(pattern[:-1]):
            return p
        if "*" in pattern:
            parts = pattern.split(".")
            key_parts = action_key.split(".")
            if len(parts) == 2 and len(key_parts) == 2:
                tool_match = parts[0] == "*" or parts[0] == key_parts[0]
                action_match = parts[1] == "*" or (parts[1].endswith("*") and key_parts[1].startswith(parts[1][:-1]))
                if tool_match and action_match:
                    return p
    return None


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
    catalog = _db_agent_to_action_catalog(agent_dict)
    radius = calculate_blast_radius(config, action_overrides=catalog)
    chain_result = _detect_chains(config, action_overrides=catalog)
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


class SignupRequest(BaseModel):
    email: str
    password: str
    name: str = ""


@app.post("/api/auth/signup")
def signup(req: SignupRequest):
    """Create a new account."""
    from auth import hash_password, create_token

    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (req.email,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Email already registered")

        user_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        pw_hash = hash_password(req.password)
        name = req.name or req.email.split("@")[0]

        conn.execute(
            "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, req.email, pw_hash, name, "admin", now),
        )
        log_audit(conn, user_id, req.email, "SIGNUP", detail="New account created")

    token = create_token(user_id, req.email, "admin")
    return {
        "token": token,
        "user": {"id": user_id, "email": req.email, "name": name, "role": "admin"},
    }


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
    catalog = _db_agent_to_action_catalog(agent)
    graph = build_agent_graph(config, action_overrides=catalog)
    radius = calculate_blast_radius(config, action_overrides=catalog)
    chain_result = _detect_chains(config, action_overrides=catalog)

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
        catalog = _db_agent_to_action_catalog(agent)
        chain_result = _detect_chains(config, action_overrides=catalog)
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


# ── Agent Discovery: Register + Import ─────────────────────────────────────

class RegisterActionInput(BaseModel):
    name: str
    description: str = ""


class RegisterToolInput(BaseModel):
    name: str
    service: str = ""
    description: str = ""
    actions: list[RegisterActionInput] = []


class RegisterAgentInput(BaseModel):
    name: str
    description: str = ""
    tools: list[RegisterToolInput] = []


def _upsert_agent(conn, agent_id: str, name: str, description: str, tools: list[dict], audit_source: str) -> str:
    """Insert or update an agent with auto-classified actions. Returns 'created' or 'updated'."""
    now = datetime.utcnow().isoformat()
    existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()

    if existing:
        conn.execute(
            "UPDATE agents SET name = ?, description = ?, updated_at = ? WHERE id = ?",
            (name, description, now, agent_id),
        )
        conn.execute("DELETE FROM agent_tools WHERE agent_id = ?", (agent_id,))
        status = "updated"
    else:
        conn.execute(
            "INSERT INTO agents (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (agent_id, name, description, now, now),
        )
        status = "created"

    for tool in tools:
        cur = conn.execute(
            "INSERT INTO agent_tools (agent_id, name, service, description) VALUES (?, ?, ?, ?)",
            (agent_id, tool["name"], tool["service"], tool["description"]),
        )
        tool_id = cur.lastrowid
        for a in tool["actions"]:
            mapped = classify_with_fallback(
                tool["name"], a["name"], a.get("description", ""),
                input_schema=a.get("input_schema"),
            )
            conn.execute(
                "INSERT INTO tool_actions (tool_id, action, description, risk_labels, reversible) VALUES (?, ?, ?, ?, ?)",
                (tool_id, a["name"], mapped.description, json.dumps(mapped.risk_labels), mapped.reversible),
            )

    log_audit(conn, None, audit_source, f"{status.upper()}_AGENT", resource=agent_id,
              detail=f"{'Created' if status == 'created' else 'Updated'} agent '{name}' with {len(tools)} tools")

    return status


@app.post("/api/authority/agents/register")
def register_agent(req: RegisterAgentInput):
    """Unauthenticated — agents call this at startup to self-register."""
    agent_id = req.name.lower().replace(" ", "-").replace("_", "-")

    tools = []
    for t in req.tools:
        tools.append({
            "name": t.name,
            "service": t.service or t.name.capitalize(),
            "description": t.description,
            "actions": [{"name": a.name, "description": a.description} for a in t.actions],
        })

    with get_db() as conn:
        status = _upsert_agent(conn, agent_id, req.name, req.description, tools, "agent-self-register")
        agent = get_agent_from_db(conn, agent_id)

    summary = _compute_agent_summary(agent)

    return {
        "id": agent_id,
        "status": status,
        "blast_radius": summary["blast_radius"],
    }


class MCPToolInput(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict = {}


class MCPImportInput(BaseModel):
    agent_name: str
    agent_description: str = ""
    source: str = ""
    mcp_tools: list[MCPToolInput]


class MCPConnectInput(BaseModel):
    url: str  # MCP server HTTP/SSE URL
    agent_name: str
    agent_description: str = ""


@app.post("/api/authority/agents/connect/mcp")
def connect_mcp_server(req: MCPConnectInput, user: dict = Depends(get_current_user)):
    """Connect to a live MCP server, pull its tools, and register as an agent."""
    import httpx as _httpx

    # Call the MCP server's tools/list via JSON-RPC
    url = req.url.rstrip("/")
    try:
        rpc_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {},
        }
        resp = _httpx.post(url, json=rpc_request, timeout=15.0)
        resp.raise_for_status()
        data = resp.json()
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"MCP server at {url} timed out")
    except _httpx.HTTPError as e:
        # Try as a plain REST endpoint (some MCP servers expose tools/list as GET)
        try:
            resp = _httpx.get(f"{url}/tools/list", timeout=15.0)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            raise HTTPException(status_code=502, detail=f"Could not connect to MCP server at {url}: {str(e)}")

    # Parse response — handle JSON-RPC envelope or plain response
    if "result" in data:
        mcp_tools = data["result"].get("tools", [])
    elif "tools" in data:
        mcp_tools = data["tools"]
    else:
        raise HTTPException(status_code=422, detail=f"Unexpected response from MCP server. Expected 'tools' array, got: {list(data.keys())}")

    if not mcp_tools:
        raise HTTPException(status_code=422, detail="MCP server returned 0 tools")

    # Convert to ActionGate format
    agent_id = req.agent_name.lower().replace(" ", "-").replace("_", "-")
    source = url.split("//")[-1].split("/")[0].split(":")[0]  # extract hostname as source

    actions = []
    for mt in mcp_tools:
        actions.append({
            "name": mt.get("name", "unknown"),
            "description": mt.get("description", ""),
            "input_schema": mt.get("inputSchema") or mt.get("input_schema"),
        })

    tools = [{
        "name": source,
        "service": source.replace("-", " ").replace("_", " ").title(),
        "description": f"MCP server: {url}",
        "actions": actions,
    }]

    with get_db() as conn:
        status = _upsert_agent(conn, agent_id, req.agent_name, req.agent_description, tools, user["email"])
        agent = get_agent_from_db(conn, agent_id)
        log_audit(conn, user["sub"], user["email"], "CONNECT_MCP", resource=agent_id,
                  detail=f"Connected to {url}, imported {len(actions)} tools")

    summary = _compute_agent_summary(agent)

    return {
        "id": agent_id,
        "status": status,
        "tools_imported": len(actions),
        "tool_names": [a["name"] for a in actions],
        "blast_radius": summary["blast_radius"],
    }


@app.post("/api/authority/agents/import/mcp")
def import_mcp(req: MCPImportInput, user: dict = Depends(get_current_user)):
    """Import tools from an MCP server's tools/list response (paste JSON)."""
    agent_id = req.agent_name.lower().replace(" ", "-").replace("_", "-")

    if req.source:
        # All MCP tools become actions under one ActionGate tool
        actions = []
        for mt in req.mcp_tools:
            extra_labels = schema_hints(mt.inputSchema.get("properties", {})) if mt.inputSchema else []
            actions.append({
                "name": mt.name,
                "description": mt.description,
                "input_schema": mt.inputSchema if mt.inputSchema else None,
            })
        tools = [{
            "name": req.source,
            "service": req.source.replace("-", " ").replace("_", " ").title(),
            "description": f"MCP server: {req.source}",
            "actions": actions,
        }]
    else:
        # Each MCP tool becomes its own ActionGate tool with one action
        tools = []
        for mt in req.mcp_tools:
            tools.append({
                "name": mt.name,
                "service": mt.name.replace("-", " ").replace("_", " ").title(),
                "description": mt.description,
                "actions": [{"name": mt.name, "description": mt.description,
                             "input_schema": mt.inputSchema if mt.inputSchema else None}],
            })

    with get_db() as conn:
        status = _upsert_agent(conn, agent_id, req.agent_name, req.agent_description, tools, user["email"])
        agent = get_agent_from_db(conn, agent_id)

    summary = _compute_agent_summary(agent)

    return {
        "id": agent_id,
        "status": status,
        "blast_radius": summary["blast_radius"],
    }


class OpenAIFunctionDef(BaseModel):
    name: str
    description: str = ""
    parameters: dict = {}


class OpenAIToolInput(BaseModel):
    type: str = "function"
    function: OpenAIFunctionDef


class OpenAIImportInput(BaseModel):
    agent_name: str
    agent_description: str = ""
    source: str = ""
    tools: list[OpenAIToolInput]


@app.post("/api/authority/agents/import/openai")
def import_openai(req: OpenAIImportInput, user: dict = Depends(get_current_user)):
    """Import tools from OpenAI function-calling format."""
    agent_id = req.agent_name.lower().replace(" ", "-").replace("_", "-")

    functions = [t.function for t in req.tools]

    if req.source:
        actions = [{"name": f.name, "description": f.description,
                     "input_schema": f.parameters if f.parameters else None} for f in functions]
        tools = [{
            "name": req.source,
            "service": req.source.replace("-", " ").replace("_", " ").title(),
            "description": f"OpenAI function source: {req.source}",
            "actions": actions,
        }]
    else:
        tools = []
        for f in functions:
            tools.append({
                "name": f.name,
                "service": f.name.replace("-", " ").replace("_", " ").title(),
                "description": f.description,
                "actions": [{"name": f.name, "description": f.description,
                             "input_schema": f.parameters if f.parameters else None}],
            })

    with get_db() as conn:
        status = _upsert_agent(conn, agent_id, req.agent_name, req.agent_description, tools, user["email"])
        agent = get_agent_from_db(conn, agent_id)

    summary = _compute_agent_summary(agent)

    return {
        "id": agent_id,
        "status": status,
        "blast_radius": summary["blast_radius"],
    }


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
    check_rate_limit(f"enforce:{req.agent_id}")
    action_key = f"{req.tool}.{req.action}"

    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY id", (req.agent_id,)
        ).fetchall()

        matched_policy = _match_policy(action_key, policies)

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


# ── Sandbox Simulation ─────────────────────────────────────────────────────

from typing import Optional

class TestDataInput(BaseModel):
    customers: Optional[dict] = None  # {"cust_123": {"id": "cust_123", "name": "...", ...}}
    payments: Optional[list] = None
    tickets: Optional[dict] = None
    contacts: Optional[list] = None
    pull_requests: Optional[dict] = None
    instances: Optional[dict] = None
    incidents: Optional[dict] = None
    hubspot_contacts: Optional[list] = None
    deals: Optional[list] = None
    gmail_threads: Optional[list] = None
    calendar_events: Optional[list] = None


@app.put("/api/authority/agent/{agent_id}/test-data")
def upload_test_data(agent_id: str, req: TestDataInput, user: dict = Depends(get_current_user)):
    """Upload custom test data for an agent's sandbox simulations."""
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        data = {k: v for k, v in req.dict().items() if v is not None}
        now = datetime.utcnow().isoformat()

        row = conn.execute("SELECT id FROM test_data WHERE agent_id = ?", (agent_id,)).fetchone()
        if row:
            conn.execute("UPDATE test_data SET data_json = ?, updated_at = ? WHERE agent_id = ?",
                         (json.dumps(data), now, agent_id))
        else:
            conn.execute("INSERT INTO test_data (agent_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
                         (agent_id, json.dumps(data), now, now))

        log_audit(conn, user["sub"], user["email"], "UPLOAD_TEST_DATA", resource=agent_id,
                  detail=f"Uploaded custom test data: {list(data.keys())}")

    return {"message": "Test data uploaded", "fields": list(data.keys())}


@app.get("/api/authority/agent/{agent_id}/test-data")
def get_test_data(agent_id: str, user: dict = Depends(get_current_user)):
    """Get custom test data for an agent."""
    with get_db() as conn:
        row = conn.execute("SELECT data_json FROM test_data WHERE agent_id = ?", (agent_id,)).fetchone()
    if not row:
        return {"agent_id": agent_id, "data": None, "message": "No custom test data — using defaults"}
    return {"agent_id": agent_id, "data": json.loads(row["data_json"])}


@app.delete("/api/authority/agent/{agent_id}/test-data")
def delete_test_data(agent_id: str, user: dict = Depends(get_current_user)):
    """Delete custom test data, revert to defaults."""
    with get_db() as conn:
        conn.execute("DELETE FROM test_data WHERE agent_id = ?", (agent_id,))
    return {"message": "Test data deleted — simulations will use defaults"}


def _get_custom_data(agent_id: str) -> dict | None:
    """Load custom test data for an agent if it exists."""
    with get_db() as conn:
        row = conn.execute("SELECT data_json FROM test_data WHERE agent_id = ?", (agent_id,)).fetchone()
    if row:
        return json.loads(row["data_json"])
    return None


class SimulateRequest(BaseModel):
    agent_id: str
    scenario_id: str = ""
    custom_prompt: str = ""  # If provided, use this instead of a scenario
    dry_run: bool = False


@app.get("/api/sandbox/scenarios")
def list_scenarios():
    """List all available simulation scenarios."""
    from sandbox.prompts.scenarios import list_all_scenarios
    return {"scenarios": list_all_scenarios()}


@app.get("/api/sandbox/scenarios/{agent_type}")
def list_agent_scenarios(agent_type: str):
    """List scenarios for a specific agent type (support, devops, sales)."""
    from sandbox.prompts.scenarios import get_scenarios_for_agent
    scenarios = get_scenarios_for_agent(agent_type)
    return {
        "agent_type": agent_type,
        "scenarios": [
            {"id": s.id, "name": s.name, "description": s.description,
             "category": s.category, "severity": s.severity}
            for s in scenarios
        ],
    }


@app.get("/api/sandbox/agent/{agent_id}/scenarios")
def get_agent_scenarios(agent_id: str, user: dict = Depends(get_current_user)):
    """Auto-generate scenarios based on an agent's actual tool configuration."""
    from sandbox.prompts.scenarios import generate_scenarios_for_agent

    with get_db() as conn:
        agent = get_agent_from_db(conn, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    scenarios = generate_scenarios_for_agent(agent)
    return {
        "agent_id": agent_id,
        "agent_name": agent["name"],
        "scenarios": [
            {"id": s.id, "name": s.name, "description": s.description,
             "agent_type": s.agent_type, "category": s.category, "severity": s.severity}
            for s in scenarios
        ],
    }


@app.post("/api/sandbox/simulate")
def run_sandbox_simulation(req: SimulateRequest, user: dict = Depends(get_current_user)):
    """Run a simulation: agent + scenario + mocks + enforcement + trace."""
    from sandbox.prompts.scenarios import get_scenario
    from sandbox.analyzer import analyze_trace
    from dataclasses import asdict as _asdict

    # Load agent config
    with get_db() as conn:
        agent = get_agent_from_db(conn, req.agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{req.agent_id}' not found")
        log_audit(conn, user["sub"], user["email"], "RUN_SIMULATION",
                  resource=req.agent_id, detail=f"Scenario: {req.scenario_id or 'custom prompt'}")

    # Load scenario — custom prompt, hardcoded, or auto-generated
    if req.custom_prompt:
        from sandbox.models import Scenario as ScenarioModel
        scenario = ScenarioModel(
            id="custom", name="Custom Prompt", description="User-provided prompt",
            agent_type=req.agent_id, category="custom", severity="info",
            prompt=req.custom_prompt,
        )
    else:
        scenario = get_scenario(req.scenario_id)
        if not scenario:
            from sandbox.prompts.scenarios import generate_scenarios_for_agent
            auto_scenarios = generate_scenarios_for_agent(agent)
            scenario = next((s for s in auto_scenarios if s.id == req.scenario_id), None)
        if not scenario:
            raise HTTPException(status_code=404, detail=f"Scenario '{req.scenario_id}' not found")

    # Load custom test data if available
    custom_data = _get_custom_data(req.agent_id)

    # Run simulation
    if req.dry_run:
        from sandbox.runner import run_simulation_dry
        trace = run_simulation_dry(agent, scenario, custom_data=custom_data)
    else:
        from sandbox.runner import run_simulation
        trace = run_simulation(agent, scenario, custom_data=custom_data)

    # Analyze
    report = analyze_trace(trace)

    # Store simulation in DB
    with get_db() as conn:
        conn.execute("""
            INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            trace.simulation_id, trace.agent_id, trace.scenario_id,
            trace.status, json.dumps(_asdict(trace)), json.dumps(_asdict(report)),
            trace.started_at,
        ))

    return {
        "simulation_id": trace.simulation_id,
        "status": trace.status,
        "error": trace.error,
        "trace": {
            "total_steps": len(trace.steps),
            "steps": [_asdict(s) for s in trace.steps],
        },
        "report": _asdict(report),
    }


@app.get("/api/sandbox/simulate/stream")
def run_sandbox_simulation_stream(agent_id: str, scenario_id: str, request: Request):
    """SSE endpoint: stream simulation steps as they happen."""
    from sandbox.prompts.scenarios import get_scenario
    from sandbox.analyzer import analyze_trace
    from sandbox.mocks.registry import MockState
    from sandbox.agents.executor import execute_tool_call
    from sandbox.models import SimulationTrace
    from dataclasses import asdict as _asdict
    import sandbox.mocks  # noqa — registers all mocks

    # Validate inputs
    with get_db() as conn:
        agent = get_agent_from_db(conn, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    scenario = get_scenario(scenario_id)
    if not scenario:
        raise HTTPException(status_code=404, detail=f"Scenario '{scenario_id}' not found")

    def event_stream():
        import uuid as _uuid
        simulation_id = _uuid.uuid4().hex[:12]
        state = MockState()

        trace = SimulationTrace(
            simulation_id=simulation_id,
            agent_id=agent["id"],
            agent_name=agent["name"],
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            prompt=scenario.prompt,
        )

        # Send simulation start
        yield f"data: {json.dumps({'type': 'start', 'simulation_id': simulation_id, 'agent_name': agent['name'], 'scenario_name': scenario.name})}\n\n"

        step_index = 0
        for tool in agent.get("tools", []):
            tool_name = tool["name"]
            for action in tool.get("actions", []):
                action_name = action["action"] if isinstance(action, dict) else action

                step = execute_tool_call(
                    agent_id=agent["id"],
                    tool=tool_name,
                    action=action_name,
                    params={},
                    state=state,
                    step_index=step_index,
                )
                trace.steps.append(step)

                # Stream this step
                yield f"data: {json.dumps({'type': 'step', 'step': _asdict(step)})}\n\n"
                step_index += 1

        trace.status = "completed"
        trace.completed_at = datetime.utcnow().isoformat()

        # Analyze and send report
        report = analyze_trace(trace)

        # Store in DB
        with get_db() as conn:
            conn.execute("""
                INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                trace.simulation_id, trace.agent_id, trace.scenario_id,
                trace.status, json.dumps(_asdict(trace)), json.dumps(_asdict(report)),
                trace.started_at,
            ))

        yield f"data: {json.dumps({'type': 'complete', 'simulation_id': simulation_id, 'report': _asdict(report)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/sandbox/simulations")
def list_simulations(user: dict = Depends(get_current_user)):
    """List past simulation runs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, agent_id, scenario_id, status, created_at FROM simulations ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    return {"simulations": [dict(r) for r in rows]}


@app.get("/api/sandbox/simulation/{simulation_id}")
def get_simulation(simulation_id: str, user: dict = Depends(get_current_user)):
    """Get full simulation detail with trace and report."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM simulations WHERE id = ?", (simulation_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Simulation '{simulation_id}' not found")
    return {
        "simulation_id": row["id"],
        "agent_id": row["agent_id"],
        "scenario_id": row["scenario_id"],
        "status": row["status"],
        "trace": json.loads(row["trace_json"]),
        "report": json.loads(row["report_json"]),
        "created_at": row["created_at"],
    }


class ApplyPolicyRequest(BaseModel):
    agent_id: str
    action_pattern: str
    effect: str
    reason: str = ""


@app.post("/api/sandbox/apply-policy")
def apply_recommended_policy(req: ApplyPolicyRequest, user: dict = Depends(get_current_user)):
    """One-click: apply a recommended policy from a simulation report."""
    if req.effect not in ("BLOCK", "REQUIRE_APPROVAL", "ALLOW"):
        raise HTTPException(status_code=400, detail="Effect must be BLOCK, REQUIRE_APPROVAL, or ALLOW")

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (req.agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{req.agent_id}' not found")

        # Check if policy already exists
        dupe = conn.execute(
            "SELECT id FROM policies WHERE agent_id = ? AND action_pattern = ? AND effect = ?",
            (req.agent_id, req.action_pattern, req.effect),
        ).fetchone()
        if dupe:
            return {"id": dupe["id"], "message": "Policy already exists", "already_exists": True}

        cur = conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (req.agent_id, req.action_pattern, req.effect, req.reason, user["email"], datetime.utcnow().isoformat()),
        )
        log_audit(conn, user["sub"], user["email"], "APPLY_RECOMMENDATION", resource=req.agent_id,
                  detail=f"{req.effect} on {req.action_pattern}")

    return {"id": cur.lastrowid, "message": "Policy created", "already_exists": False}


class ApplyAllPoliciesRequest(BaseModel):
    agent_id: str
    policies: list[ApplyPolicyRequest]


@app.post("/api/sandbox/apply-all-policies")
def apply_all_recommended_policies(req: ApplyAllPoliciesRequest, user: dict = Depends(get_current_user)):
    """One-click: apply ALL recommended policies from a simulation report."""
    created = 0
    skipped = 0

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (req.agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{req.agent_id}' not found")

        for p in req.policies:
            dupe = conn.execute(
                "SELECT id FROM policies WHERE agent_id = ? AND action_pattern = ? AND effect = ?",
                (req.agent_id, p.action_pattern, p.effect),
            ).fetchone()
            if dupe:
                skipped += 1
                continue

            conn.execute(
                "INSERT INTO policies (agent_id, action_pattern, effect, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (req.agent_id, p.action_pattern, p.effect, p.reason, user["email"], datetime.utcnow().isoformat()),
            )
            created += 1

        log_audit(conn, user["sub"], user["email"], "APPLY_ALL_RECOMMENDATIONS", resource=req.agent_id,
                  detail=f"Created {created} policies, skipped {skipped} duplicates")

    return {"created": created, "skipped": skipped, "message": f"Applied {created} policies"}


# ── Mock HTTP Endpoints (for real agents to call) ─────────────────────────

_mock_sessions: dict[str, dict] = {}  # session_id -> {state, agent_id, steps}


class MockSessionRequest(BaseModel):
    agent_id: str = "unknown"


@app.post("/mock/session")
def create_mock_session(req: MockSessionRequest):
    """Create a sandbox session. Real agents call this before testing.

    Body: {"agent_id": "my-agent"}
    Returns: {"session_id": "...", "base_url": "http://localhost:8000/mock"}
    """
    import sandbox.mocks  # noqa — registers all mocks
    from sandbox.mocks.registry import MockState

    agent_id = req.agent_id
    session_id = uuid.uuid4().hex[:12]

    # Load custom test data if available for this agent
    custom_data = _get_custom_data(agent_id)

    _mock_sessions[session_id] = {
        "state": MockState(custom_data=custom_data),
        "agent_id": agent_id,
        "steps": [],
        "created_at": datetime.utcnow().isoformat(),
    }

    return {
        "session_id": session_id,
        "agent_id": agent_id,
        "base_url": "http://localhost:8000/mock",
        "usage": "POST /mock/{tool}/{action} with headers X-Session-ID and X-Agent-ID",
    }


@app.post("/mock/{tool}/{action}")
async def call_mock_endpoint(tool: str, action: str, request: Request):
    """Mock HTTP endpoint. Real agents call this instead of real APIs.

    Headers:
      X-Session-ID: session from /mock/session
      X-Agent-ID: agent id (for enforce check)
    Body: JSON params for the action
    """
    import sandbox.mocks  # noqa
    from sandbox.mocks.registry import call_mock

    session_id = request.headers.get("x-session-id", "")
    agent_id = request.headers.get("x-agent-id", "")
    check_rate_limit(f"mock:{agent_id or session_id or 'anon'}")

    # Get or create session
    if session_id and session_id in _mock_sessions:
        session = _mock_sessions[session_id]
    else:
        # Auto-create session for convenience
        from sandbox.mocks.registry import MockState
        session_id = session_id or uuid.uuid4().hex[:12]
        auto_custom_data = _get_custom_data(agent_id) if agent_id else None
        session = {
            "state": MockState(custom_data=auto_custom_data),
            "agent_id": agent_id or "unknown",
            "steps": [],
            "created_at": datetime.utcnow().isoformat(),
        }
        _mock_sessions[session_id] = session

    if not agent_id:
        agent_id = session["agent_id"]

    # Parse body
    try:
        params = await request.json()
    except Exception:
        params = {}

    # Step 1: Enforce check
    enforce_decision = "ALLOW"
    enforce_reason = ""
    try:
        with get_db() as conn:
            policies = conn.execute(
                "SELECT * FROM policies WHERE agent_id = ? ORDER BY id", (agent_id,)
            ).fetchall()

            action_key = f"{tool}.{action}"
            matched = _match_policy(action_key, policies)
            if matched:
                enforce_decision = matched["effect"]
                enforce_reason = matched["reason"]

            status = "BLOCKED" if enforce_decision == "BLOCK" else "PENDING_APPROVAL" if enforce_decision == "REQUIRE_APPROVAL" else "EXECUTED"
            log_execution(conn, agent_id, tool, action, status, detail=enforce_reason or "Mock endpoint")
    except Exception:
        pass

    # Step 2: Call mock if allowed
    if enforce_decision == "BLOCK":
        step = {"tool": tool, "action": action, "decision": "BLOCK", "reason": enforce_reason, "result": None}
        session["steps"].append(step)
        return {"blocked": True, "action": f"{tool}.{action}", "reason": enforce_reason, "decision": "BLOCK"}

    if enforce_decision == "REQUIRE_APPROVAL":
        step = {"tool": tool, "action": action, "decision": "REQUIRE_APPROVAL", "reason": enforce_reason, "result": None}
        session["steps"].append(step)
        return {"pending_approval": True, "action": f"{tool}.{action}", "reason": enforce_reason, "decision": "REQUIRE_APPROVAL"}

    # Execute mock
    result = call_mock(tool, action, params, session["state"])
    step = {"tool": tool, "action": action, "decision": "ALLOW", "result": result}
    session["steps"].append(step)

    return result


@app.get("/mock/session/{session_id}/trace")
def get_mock_session_trace(session_id: str):
    """Get the full trace of a mock session — what the agent did."""
    session = _mock_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")

    return {
        "session_id": session_id,
        "agent_id": session["agent_id"],
        "created_at": session["created_at"],
        "total_steps": len(session["steps"]),
        "steps": session["steps"],
    }


@app.get("/mock/sessions")
def list_mock_sessions():
    """List all active mock sessions with step counts."""
    sessions = []
    for sid, session in _mock_sessions.items():
        sessions.append({
            "session_id": sid,
            "agent_id": session["agent_id"],
            "total_steps": len(session["steps"]),
            "created_at": session["created_at"],
        })
    sessions.sort(key=lambda s: s["created_at"], reverse=True)
    return {"sessions": sessions}


@app.get("/mock/available")
def list_mock_endpoints():
    """List all available mock endpoints."""
    import sandbox.mocks  # noqa
    from sandbox.mocks.registry import list_available_mocks

    mocks = list_available_mocks()
    return {
        "total": len(mocks),
        "endpoints": [f"POST /mock/{m.replace('.', '/')}" for m in mocks],
        "usage": {
            "1_create_session": "POST /mock/session {\"agent_id\": \"my-agent\"}",
            "2_call_tool": "POST /mock/{tool}/{action} with X-Session-ID and X-Agent-ID headers",
            "3_get_trace": "GET /mock/session/{session_id}/trace",
        },
    }


# ── Health ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Serve frontend static files ───────────────────────────────────────────

STATIC_DIR = Path(__file__).parent / "static"

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        """Serve the React SPA for any non-API route."""
        file_path = STATIC_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(STATIC_DIR / "index.html"))
