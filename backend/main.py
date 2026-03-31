"""ActionGate API — Authority Engine with auth, CRUD, enforcement, audit, execution tracking."""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict
from datetime import datetime

from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

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

ALLOWED_ORIGINS = os.getenv("CORS_ORIGINS", "*")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()


@app.get("/api/services")
def list_available_services():
    """Return all known services and their actions for the service picker."""
    from authority.action_mapper import ACTION_CATALOG
    services = {}
    for tool_name, actions in ACTION_CATALOG.items():
        action_list = []
        for action_name, mapped in actions.items():
            action_list.append({
                "action": action_name,
                "description": mapped.description,
                "risk_labels": mapped.risk_labels,
                "reversible": mapped.reversible,
            })
        services[tool_name] = {
            "service": mapped.service if actions else tool_name.title(),
            "actions": action_list,
            "action_count": len(action_list),
        }
    return {"services": services}


# ── Proxy Layer ──────────────────────────────────────────────────────────
# Companies change one env var (e.g. STRIPE_API_URL=https://actiongate.co/proxy/stripe)
# and all traffic routes through ActionGate automatically. No SDK, no code changes.

SERVICE_BASE_URLS = {
    "stripe": "https://api.stripe.com",
    "zendesk": "https://{subdomain}.zendesk.com/api/v2",
    "salesforce": "https://{instance}.salesforce.com/services/data/v59.0",
    "sendgrid": "https://api.sendgrid.com/v3",
    "github": "https://api.github.com",
    "slack": "https://slack.com/api",
    "pagerduty": "https://api.pagerduty.com",
    "hubspot": "https://api.hubapi.com",
    "gmail": "https://gmail.googleapis.com/gmail/v1",
    "calendly": "https://api.calendly.com/v2",
}

# Allow overrides via env vars: ACTIONGATE_PROXY_STRIPE=https://api.stripe.com
for svc in list(SERVICE_BASE_URLS.keys()):
    env_override = os.getenv(f"ACTIONGATE_PROXY_{svc.upper()}")
    if env_override:
        SERVICE_BASE_URLS[svc] = env_override


def _infer_action_from_request(method: str, path: str) -> str:
    """Infer an action name from HTTP method + path for policy matching.

    Examples:
      GET /v1/customers/cust_123 → get_customers
      POST /v1/refunds → create_refunds
      DELETE /v1/customers/cust_123 → delete_customers
    """
    # Strip version prefixes, IDs, and query params
    parts = [p for p in path.strip("/").split("/") if p and not p.startswith("v") and not p[0].isdigit() and "_" not in p[:4]]
    resource = parts[-1] if parts else "unknown"
    # Remove trailing IDs like cust_123
    if resource and any(c.isdigit() for c in resource):
        resource = parts[-2] if len(parts) >= 2 else resource

    method_prefix = {
        "GET": "get", "POST": "create", "PUT": "update",
        "PATCH": "update", "DELETE": "delete",
    }.get(method.upper(), "call")

    return f"{method_prefix}_{resource}"


@app.api_route("/proxy/{service}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_request(service: str, path: str, request: Request):
    """Transparent proxy — enforces policies then forwards to the real API.

    Usage: set STRIPE_API_URL=https://actiongate.yourcompany.com/proxy/stripe
    Headers:
      X-Agent-ID: required — identifies which agent is calling
      Everything else is forwarded to the upstream API as-is.
    """
    import httpx as _httpx

    agent_id = request.headers.get("X-Agent-ID", "")
    if not agent_id:
        raise HTTPException(status_code=400, detail="X-Agent-ID header required for proxy requests")

    base_url = SERVICE_BASE_URLS.get(service)
    if not base_url:
        raise HTTPException(status_code=404, detail=f"Unknown service '{service}'. Known: {', '.join(SERVICE_BASE_URLS.keys())}")

    # Infer action from HTTP method + path
    action = _infer_action_from_request(request.method, path)

    # Read body for POST/PUT/PATCH (needed for condition evaluation)
    body = await request.body()
    params = {}
    if body:
        try:
            params = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

    # Enforce policy using shared logic
    result = enforce_check(agent_id, service, action, params=params or None)
    effect = result["decision"]

    if effect == "BLOCK":
        return {"blocked": True, "reason": result["message"], "action": result["action"], "agent_id": agent_id}

    if effect == "REQUIRE_APPROVAL":
        return {"pending_approval": True, "reason": result["message"], "action": result["action"], "agent_id": agent_id}

    # Forward to upstream
    upstream_url = f"{base_url}/{path}"
    # Forward all headers except host and agent-id
    forward_headers = {k: v for k, v in request.headers.items()
                       if k.lower() not in ("host", "x-agent-id", "content-length")}

    try:
        async with _httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method=request.method,
                url=upstream_url,
                headers=forward_headers,
                content=body if body else None,
                params=dict(request.query_params),
            )
        return StreamingResponse(
            iter([resp.content]),
            status_code=resp.status_code,
            headers={k: v for k, v in resp.headers.items() if k.lower() not in ("content-encoding", "transfer-encoding")},
        )
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Upstream {service} timed out")
    except _httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Upstream {service} error: {str(e)}")


# ── Post-Hoc Report (zero-friction audit) ────────────────────────────────
# Agent runs normally, then reports what it did. No enforcement, full visibility.

class ReportAction(BaseModel):
    tool: str
    action: str
    params: dict = {}
    result: dict = {}
    timestamp: str = ""


class PostHocReport(BaseModel):
    agent_id: str
    session_id: str = ""
    actions: list[ReportAction]


class SDKTraceStep(BaseModel):
    tool: str
    action: str
    params: dict = {}
    result: dict = {}
    error: Union[str, None] = None
    duration_ms: float = 0.0
    timestamp: str = ""


class SDKTraceInput(BaseModel):
    agent_name: str = "unknown"
    prompt: str = ""
    steps: list[SDKTraceStep] = []
    tools_detected: list[str] = []
    started_at: str = ""
    completed_at: str = ""


@app.post("/api/sdk/analyze-trace")
def analyze_sdk_trace(req: SDKTraceInput):
    """Arceo SDK endpoint — accepts a captured trace, auto-registers the agent,
    runs full analysis, and returns a risk report."""
    from sandbox.models import SimulationTrace, TraceStep
    from sandbox.analyzer import analyze_trace
    from authority.risk_classifier import classify_with_fallback
    from dataclasses import asdict

    # Auto-register agent from detected tools
    agent_id = req.agent_name.lower().replace(" ", "-").replace("_", "-")

    # Build tool manifest from trace steps
    tools_from_trace: dict[str, set] = {}
    for step in req.steps:
        tools_from_trace.setdefault(step.tool, set()).add(step.action)

    reg_tools = []
    for tool_name, actions in tools_from_trace.items():
        reg_tools.append({
            "name": tool_name,
            "service": tool_name.replace("-", " ").replace("_", " ").title(),
            "description": tool_name,
            "actions": [{"name": a, "description": a} for a in sorted(actions)],
        })

    with get_db() as conn:
        _upsert_agent(conn, agent_id, req.agent_name, req.agent_name, reg_tools, "arceo-sdk")
        agent = get_agent_from_db(conn, agent_id)

    # Get blast radius
    summary = _compute_agent_summary(agent)

    # Build simulation trace for analysis
    trace = SimulationTrace(
        simulation_id=uuid.uuid4().hex[:12],
        agent_id=agent_id,
        agent_name=req.agent_name,
        scenario_id="sdk-trace",
        scenario_name="SDK Captured Trace",
        prompt=req.prompt,
    )

    for i, step in enumerate(req.steps):
        trace.steps.append(TraceStep(
            step_index=i,
            tool=step.tool,
            action=step.action,
            params=step.params,
            enforce_decision="ALLOW",
            enforce_policy=None,
            result=step.result,
            error=step.error or None,
            timestamp=step.timestamp or "",
        ))

    report = analyze_trace(trace)

    # Store as simulation
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (trace.simulation_id, agent_id, "sdk-trace", "completed",
             json.dumps(asdict(trace), default=str),
             json.dumps(asdict(report), default=str),
             datetime.utcnow().isoformat()),
        )

    return {
        "agent_id": agent_id,
        "blast_radius": summary["blast_radius"],
        "report": asdict(report),
    }


@app.post("/api/report")
def submit_post_hoc_report(req: PostHocReport):
    """Agent reports what it did after the fact. No enforcement, full analysis."""
    from sandbox.models import SimulationTrace, TraceStep
    from sandbox.analyzer import analyze_trace
    from dataclasses import asdict

    # Build a trace from the reported actions
    trace = SimulationTrace(
        simulation_id=req.session_id or uuid.uuid4().hex[:12],
        agent_id=req.agent_id,
        agent_name=req.agent_id,
        scenario_id="post-hoc",
        scenario_name="Post-Hoc Report",
        prompt="Agent self-reported actions",
    )

    for i, action in enumerate(req.actions):
        trace.steps.append(TraceStep(
            step_index=i,
            tool=action.tool,
            action=action.action,
            params=action.params,
            enforce_decision="ALLOW",  # already happened
            enforce_policy=None,
            result=action.result,
            timestamp=action.timestamp or datetime.utcnow().isoformat(),
        ))

    report = analyze_trace(trace)

    # Log each action
    with get_db() as conn:
        for action in req.actions:
            log_execution(conn, req.agent_id, action.tool, action.action, "REPORTED",
                          detail="post-hoc report")

        # Store as a simulation for dashboard visibility
        def _asdict_safe(obj):
            if hasattr(obj, '__dataclass_fields__'):
                return asdict(obj)
            return obj

        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (trace.simulation_id, req.agent_id, "post-hoc", "completed",
             json.dumps(asdict(trace), default=str),
             json.dumps(asdict(report), default=str),
             datetime.utcnow().isoformat()),
        )
        log_audit(conn, None, req.agent_id, "POST_HOC_REPORT",
                  resource=req.agent_id,
                  detail=f"Reported {len(req.actions)} actions, risk score: {report.risk_score}")

    return {
        "simulation_id": trace.simulation_id,
        "risk_score": report.risk_score,
        "violations": len(report.violations),
        "chains": len(report.chains_triggered),
        "data_flows": len(report.data_flows),
        "volume_violations": len(report.volume_violations),
        "executive_summary": report.executive_summary,
    }


def _match_policy(action_key: str, policies: list, params: dict | None = None, session_context: list | None = None) -> dict | None:
    """Match an action key against policies, evaluating conditions if present.

    Conditions are optional JSON: [{"field": "amount", "op": "gt", "value": 100}]
    Supported ops: gt, gte, lt, lte, eq, neq, in, not_in, contains, requires_prior
    If a policy has conditions and params are provided, ALL conditions must match.
    If no params provided, conditions are ignored (backward compatible).
    session_context is a list of prior action strings (e.g. ["pagerduty.get_incident", "aws.list_instances"]).
    """
    for p in policies:
        pattern = p["action_pattern"]
        pattern_match = False

        if pattern == action_key:
            pattern_match = True
        elif pattern.endswith(".*") and action_key.startswith(pattern[:-1]):
            pattern_match = True
        elif "*" in pattern:
            parts = pattern.split(".")
            key_parts = action_key.split(".")
            if len(parts) == 2 and len(key_parts) == 2:
                tool_match = parts[0] == "*" or parts[0] == key_parts[0]
                action_match = parts[1] == "*" or (parts[1].endswith("*") and key_parts[1].startswith(parts[1][:-1]))
                if tool_match and action_match:
                    pattern_match = True

        if not pattern_match:
            continue

        # Check conditions if present
        try:
            raw_conditions = p["conditions"]
        except (KeyError, IndexError):
            raw_conditions = None
        conditions = json.loads(raw_conditions) if raw_conditions else []
        if conditions:
            # Split into param conditions and session conditions
            param_conds = [c for c in conditions if c.get("op") != "requires_prior"]
            session_conds = [c for c in conditions if c.get("op") == "requires_prior"]

            param_ok = True
            if param_conds:
                if params:
                    param_ok = _evaluate_conditions(param_conds, params)
                else:
                    param_ok = False  # has param conditions but no params

            session_ok = True
            if session_conds:
                session_ok = _evaluate_session_conditions(session_conds, session_context)

            if param_ok and session_ok:
                return p
        else:
            # No conditions — pattern match is enough
            return p

    return None


def _evaluate_conditions(conditions: list[dict], params: dict) -> bool:
    """Evaluate param conditions against action params. ALL must match."""
    for cond in conditions:
        field = cond.get("field", "")
        op = cond.get("op", "eq")
        value = cond.get("value")

        if op == "requires_prior":
            continue  # handled separately

        actual = params.get(field)
        if actual is None:
            return False

        try:
            if op == "gt" and not (float(actual) > float(value)):
                return False
            elif op == "gte" and not (float(actual) >= float(value)):
                return False
            elif op == "lt" and not (float(actual) < float(value)):
                return False
            elif op == "lte" and not (float(actual) <= float(value)):
                return False
            elif op == "eq" and str(actual) != str(value):
                return False
            elif op == "neq" and str(actual) == str(value):
                return False
            elif op == "in" and actual not in value:
                return False
            elif op == "not_in" and actual in value:
                return False
            elif op == "contains" and str(value) not in str(actual):
                return False
        except (ValueError, TypeError):
            return False

    return True


def _evaluate_session_conditions(conditions: list[dict], session_context: list | None) -> bool:
    """Evaluate session-aware conditions (requires_prior).

    requires_prior checks that a specific tool.action was called earlier in the session.
    Supports wildcards: "pagerduty.*" matches any pagerduty action.
    """
    if not session_context:
        return False  # has session conditions but no context — fails

    for cond in conditions:
        required_pattern = str(cond.get("value", ""))
        if not required_pattern:
            return False

        found = False
        for prior_action in session_context:
            if required_pattern == prior_action:
                found = True
                break
            if required_pattern.endswith(".*") and prior_action.startswith(required_pattern[:-1]):
                found = True
                break
            if "*" in required_pattern:
                parts = required_pattern.split(".")
                action_parts = prior_action.split(".")
                if len(parts) == 2 and len(action_parts) == 2:
                    t_match = parts[0] == "*" or parts[0] == action_parts[0]
                    a_match = parts[1] == "*" or parts[1] == action_parts[1]
                    if t_match and a_match:
                        found = True
                        break

        if not found:
            return False

    return True


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
    """Generate recommendations from the agent's specific risk profile and chains."""
    recs = []

    # Recommendations from detected chains — these are the most actionable
    for fc in chain_result.flagged_chains:
        chain = fc.chain
        # Recommend gating the escalation step (second action in the chain)
        escalation_actions = fc.matching_actions[1] if len(fc.matching_actions) > 1 else []
        action_list = ", ".join(escalation_actions[:3])
        if chain.severity == "critical":
            recs.append({"severity": "critical", "title": f"Break chain: {chain.name}",
                          "description": f"{chain.description}. Gate the escalation actions ({action_list}) with approval to prevent this chain."})
        else:
            recs.append({"severity": "high", "title": f"Monitor chain: {chain.name}",
                          "description": f"{chain.description}. Consider requiring approval for: {action_list}."})

    # Recommendations from irreversible actions — these can't be undone
    if radius.irreversible_actions > 0:
        recs.append({"severity": "critical" if radius.irreversible_actions > 2 else "high",
                      "title": "Irreversible actions need gates",
                      "description": f"{radius.irreversible_actions} actions are irreversible (deletes, terminates, sends). These cannot be undone — add approval or block policies."})

    # Only add label-count recs if no chain already covers it
    chain_labels = set()
    for fc in chain_result.flagged_chains:
        chain_labels.update(fc.chain.risk_tags)

    if radius.moves_money > 0 and "moves_money" not in chain_labels:
        recs.append({"severity": "high", "title": "Financial actions exposed",
                      "description": f"{radius.moves_money} money-moving action(s). Run a simulation to see which ones fire, then add approval gates."})
    if radius.deletes_data > 0 and "deletes_data" not in chain_labels:
        recs.append({"severity": "high", "title": "Deletion actions exposed",
                      "description": f"{radius.deletes_data} data-deletion action(s). Run a simulation to test, then block or require approval."})

    if not recs:
        recs.append({"severity": "info", "title": "Low risk profile",
                      "description": "No critical chains or high-risk actions detected. Run simulations to verify."})

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


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/change-password")
def change_password(req: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    """Change the current user's password."""
    from auth import verify_password, hash_password
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["sub"],)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if not verify_password(req.current_password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
        new_hash = hash_password(req.new_password)
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["sub"]))
        log_audit(conn, user["sub"], user["email"], "CHANGE_PASSWORD", detail="Password changed")
    return {"message": "Password updated"}


# ── Authority Engine: READ endpoints ────────────────────────────────────────

@app.get("/api/authority/agents")
def list_agents(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        log_audit(conn, user["sub"], user["email"], "LIST_AGENTS")
        agents = get_all_agents_from_db(conn)

    with get_db() as conn:
        results = []
        for agent in agents:
            summary = _compute_agent_summary(agent)
            policy_count = conn.execute(
                "SELECT COUNT(*) FROM policies WHERE agent_id = ?", (agent["id"],)
            ).fetchone()[0]
            pending_count = conn.execute(
                "SELECT COUNT(*) FROM execution_log WHERE agent_id = ? AND status = 'PENDING_APPROVAL'", (agent["id"],)
            ).fetchone()[0]
            last_exec = conn.execute(
                "SELECT timestamp FROM execution_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1", (agent["id"],)
            ).fetchone()
            results.append({
                "id": agent["id"],
                "name": agent["name"],
                "description": agent["description"],
                "tools": [t["service"] for t in agent["tools"]],
                "created_at": agent["created_at"],
                "policy_count": policy_count,
                "pending_count": pending_count,
                "last_execution_at": last_exec["timestamp"] if last_exec else None,
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

        # Clean up all related data
        sim_count = conn.execute("SELECT COUNT(*) FROM simulations WHERE agent_id = ?", (agent_id,)).fetchone()[0]
        sweep_count = conn.execute("SELECT COUNT(*) FROM sweeps WHERE agent_id = ?", (agent_id,)).fetchone()[0]
        exec_count = conn.execute("SELECT COUNT(*) FROM execution_log WHERE agent_id = ?", (agent_id,)).fetchone()[0]

        conn.execute("DELETE FROM simulations WHERE agent_id = ?", (agent_id,))
        conn.execute("DELETE FROM sweeps WHERE agent_id = ?", (agent_id,))
        conn.execute("DELETE FROM execution_log WHERE agent_id = ?", (agent_id,))
        conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))  # cascades to tools, actions, policies, test_data

        log_audit(conn, user["sub"], user["email"], "DELETE_AGENT", resource=agent_id,
                  detail=f"Deleted agent '{existing['name']}' + {sim_count} simulations, {sweep_count} sweeps, {exec_count} executions")

    return {"message": "Agent deleted", "cleaned": {"simulations": sim_count, "sweeps": sweep_count, "executions": exec_count}}


class BulkDeleteRequest(BaseModel):
    agent_ids: list[str]


@app.post("/api/authority/agents/delete")
def bulk_delete_agents(req: BulkDeleteRequest, user: dict = Depends(get_current_user)):
    """Delete multiple agents and all their history in one call."""
    deleted = []
    not_found = []
    with get_db() as conn:
        for agent_id in req.agent_ids:
            existing = conn.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)).fetchone()
            if not existing:
                not_found.append(agent_id)
                continue

            conn.execute("DELETE FROM simulations WHERE agent_id = ?", (agent_id,))
            conn.execute("DELETE FROM sweeps WHERE agent_id = ?", (agent_id,))
            conn.execute("DELETE FROM execution_log WHERE agent_id = ?", (agent_id,))
            conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
            deleted.append(agent_id)

        if deleted:
            log_audit(conn, user["sub"], user["email"], "BULK_DELETE_AGENTS",
                      detail=f"Deleted {len(deleted)} agents: {', '.join(deleted)}")

    return {"deleted": deleted, "not_found": not_found}


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
        except Exception as e:
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

from typing import Union


class ConditionInput(BaseModel):
    field: str       # param field name, e.g. "amount"
    op: str          # gt, gte, lt, lte, eq, neq, in, not_in, contains
    value: Union[str, int, float, list] = ""


class PolicyInput(BaseModel):
    action_pattern: str
    effect: str  # BLOCK, REQUIRE_APPROVAL, ALLOW
    reason: str = ""
    conditions: list[ConditionInput] = []


@app.get("/api/authority/agent/{agent_id}/policies")
def list_policies(agent_id: str, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY created_at DESC", (agent_id,)
        ).fetchall()
    result = []
    for p in policies:
        d = dict(p)
        d["conditions"] = json.loads(d.get("conditions") or "[]")
        result.append(d)
    return {"policies": result}


@app.post("/api/authority/agent/{agent_id}/policies")
def create_policy(agent_id: str, req: PolicyInput, user: dict = Depends(get_current_user)):
    if req.effect not in ("BLOCK", "REQUIRE_APPROVAL", "ALLOW"):
        raise HTTPException(status_code=400, detail="Effect must be BLOCK, REQUIRE_APPROVAL, or ALLOW")

    valid_ops = {"gt", "gte", "lt", "lte", "eq", "neq", "in", "not_in", "contains", "requires_prior"}
    for c in req.conditions:
        if c.op not in valid_ops:
            raise HTTPException(status_code=400, detail=f"Invalid condition op '{c.op}'. Must be one of: {', '.join(sorted(valid_ops))}")

    conditions_json = json.dumps([c.model_dump() for c in req.conditions]) if req.conditions else "[]"

    # Auto-assign priority: BLOCK=100, REQUIRE_APPROVAL=50, ALLOW=10
    priority = {"BLOCK": 100, "REQUIRE_APPROVAL": 50, "ALLOW": 10}.get(req.effect, 0)

    with get_db() as conn:
        existing = conn.execute("SELECT id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

        cur = conn.execute(
            "INSERT INTO policies (agent_id, action_pattern, effect, reason, conditions, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (agent_id, req.action_pattern, req.effect, req.reason, conditions_json, priority, user["email"], datetime.utcnow().isoformat()),
        )

        condition_desc = f" when {conditions_json}" if req.conditions else ""
        log_audit(conn, user["sub"], user["email"], "CREATE_POLICY", resource=agent_id,
                  detail=f"{req.effect} on {req.action_pattern}{condition_desc}")

    return {"id": cur.lastrowid, "priority": priority, "message": "Policy created"}


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


@app.get("/api/authority/agent/{agent_id}/policy-conflicts")
def detect_policy_conflicts(agent_id: str, user: dict = Depends(get_current_user)):
    """Find overlapping policies that might conflict (e.g., BLOCK on stripe.* and ALLOW on stripe.get_customer)."""
    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY priority DESC, id", (agent_id,)
        ).fetchall()

    policy_list = []
    for p in policies:
        d = dict(p)
        d["conditions"] = json.loads(d.get("conditions") or "[]")
        policy_list.append(d)

    conflicts = []
    for i, p1 in enumerate(policy_list):
        for p2 in policy_list[i + 1:]:
            if p1["effect"] == p2["effect"]:
                continue  # same effect — no conflict
            # Check if patterns overlap
            overlap = _patterns_overlap(p1["action_pattern"], p2["action_pattern"])
            if overlap:
                winner = p1 if p1.get("priority", 0) >= p2.get("priority", 0) else p2
                conflicts.append({
                    "policy_a": {"id": p1["id"], "pattern": p1["action_pattern"], "effect": p1["effect"], "priority": p1.get("priority", 0)},
                    "policy_b": {"id": p2["id"], "pattern": p2["action_pattern"], "effect": p2["effect"], "priority": p2.get("priority", 0)},
                    "overlap": overlap,
                    "winner": {"id": winner["id"], "effect": winner["effect"]},
                })

    return {"agent_id": agent_id, "conflicts": conflicts, "total": len(conflicts)}


def _patterns_overlap(pattern_a: str, pattern_b: str) -> str | None:
    """Check if two action patterns overlap. Returns description of overlap or None."""
    # Exact match
    if pattern_a == pattern_b:
        return f"identical: {pattern_a}"
    # One is a wildcard that covers the other
    if pattern_a.endswith(".*"):
        prefix = pattern_a[:-1]
        if pattern_b.startswith(prefix):
            return f"{pattern_a} covers {pattern_b}"
    if pattern_b.endswith(".*"):
        prefix = pattern_b[:-1]
        if pattern_a.startswith(prefix):
            return f"{pattern_b} covers {pattern_a}"
    # Both wildcards on same tool
    parts_a = pattern_a.split(".")
    parts_b = pattern_b.split(".")
    if len(parts_a) == 2 and len(parts_b) == 2:
        if parts_a[0] == parts_b[0] and ("*" in parts_a[1] or "*" in parts_b[1]):
            return f"both match {parts_a[0]} actions"
    return None


# ── Enforcement Check (what agents call at runtime) ─────────────────────────

class SessionAction(BaseModel):
    tool: str
    action: str


class EnforceRequest(BaseModel):
    agent_id: str
    tool: str
    action: str
    params: dict = {}
    session_context: list[str] = []  # prior actions: ["pagerduty.get_incident", "aws.list_instances"]


def _fire_block_notification(agent_id: str, tool: str, action: str, reason: str):
    """Fire Slack webhook when an action is blocked. Never raises — notification failures must not break enforcement."""
    try:
        with get_db() as conn:
            row = conn.execute("SELECT * FROM workspace_settings WHERE id = 1").fetchone()
        if not row or not row["notify_on_block"]:
            return
        slack_url = row["slack_webhook_url"] or ""
        if not slack_url:
            return
        import httpx
        payload = {
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f":shield: *Arceo blocked an action*\n*Agent:* `{agent_id}`\n*Action:* `{tool}.{action}`\n*Reason:* {reason or 'Policy match'}",
                    },
                }
            ]
        }
        httpx.post(slack_url, json=payload, timeout=4)
    except Exception:
        pass  # Never let notification failures break enforcement


def enforce_check(agent_id: str, tool: str, action: str, params: dict = None, session_context: list = None) -> dict:
    """Shared enforce logic — used by the endpoint, proxy, and sandbox executor."""
    action_key = f"{tool}.{action}"

    with get_db() as conn:
        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY priority DESC, id", (agent_id,)
        ).fetchall()

        matched_policy = _match_policy(action_key, policies, params=params or None, session_context=session_context or None)

        if matched_policy:
            effect = matched_policy["effect"]
            status = "BLOCKED" if effect == "BLOCK" else "PENDING_APPROVAL" if effect == "REQUIRE_APPROVAL" else "EXECUTED"
        else:
            effect = "ALLOW"
            status = "EXECUTED"

        log_execution(conn, agent_id, tool, action, status,
                      policy_id=matched_policy["id"] if matched_policy else None,
                      detail=matched_policy["reason"] if matched_policy else "No matching policy")

        if status == "BLOCKED":
            _fire_block_notification(agent_id, tool, action, matched_policy["reason"] if matched_policy else "")

        return {
            "decision": effect,
            "action": action_key,
            "agent_id": agent_id,
            "policy": dict(matched_policy) if matched_policy else None,
            "message": matched_policy["reason"] if matched_policy else "Action allowed — no matching policy",
        }


@app.post("/api/enforce")
def enforce_action(req: EnforceRequest):
    """Runtime enforcement — agents call this before executing an action.

    Supports conditional policies (e.g. amount > 100) and session-aware
    conditions (e.g. requires_prior: pagerduty.get_incident).
    """
    check_rate_limit(f"enforce:{req.agent_id}")
    return enforce_check(req.agent_id, req.tool, req.action, req.params or None, req.session_context or None)


# ── Notification Settings ───────────────────────────────────────────────────

class NotificationSettingsRequest(BaseModel):
    slack_webhook_url: str = ""
    alert_email: str = ""
    notify_on_block: bool = True


@app.get("/api/notifications/settings")
def get_notification_settings(user: dict = Depends(get_current_user)):
    """Get workspace notification settings."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM workspace_settings WHERE id = 1").fetchone()
    if not row:
        return {"slack_webhook_url": "", "alert_email": "", "notify_on_block": True}
    return {
        "slack_webhook_url": row["slack_webhook_url"] or "",
        "alert_email": row["alert_email"] or "",
        "notify_on_block": bool(row["notify_on_block"]),
    }


@app.post("/api/notifications/settings")
def save_notification_settings(req: NotificationSettingsRequest, user: dict = Depends(get_current_user)):
    """Save workspace notification settings."""
    now = datetime.utcnow().isoformat()
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM workspace_settings WHERE id = 1").fetchone()
        if existing:
            conn.execute(
                "UPDATE workspace_settings SET slack_webhook_url=?, alert_email=?, notify_on_block=?, updated_at=? WHERE id=1",
                (req.slack_webhook_url, req.alert_email, 1 if req.notify_on_block else 0, now),
            )
        else:
            conn.execute(
                "INSERT INTO workspace_settings (id, slack_webhook_url, alert_email, notify_on_block, updated_at) VALUES (1, ?, ?, ?, ?)",
                (req.slack_webhook_url, req.alert_email, 1 if req.notify_on_block else 0, now),
            )
        log_audit(conn, user["sub"], user["email"], "UPDATE_NOTIFICATIONS", detail="Notification settings updated")
    return {"message": "Saved"}


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


@app.get("/api/approvals")
def get_pending_approvals(user: dict = Depends(get_current_user)):
    """Return all PENDING_APPROVAL executions across all agents."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT e.*, a.name as agent_name
               FROM execution_log e
               LEFT JOIN agents a ON e.agent_id = a.id
               WHERE e.status = 'PENDING_APPROVAL'
               ORDER BY e.timestamp DESC""",
        ).fetchall()
    return {"approvals": [dict(r) for r in rows]}


class ApprovalDecision(BaseModel):
    decision: str  # "approve" or "reject"
    reason: str = ""


@app.post("/api/approvals/{execution_id}")
def decide_approval(execution_id: int, body: ApprovalDecision, user: dict = Depends(get_current_user)):
    """Approve or reject a PENDING_APPROVAL execution."""
    if body.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'reject'")
    new_status = "EXECUTED" if body.decision == "approve" else "BLOCKED"
    detail_suffix = f" [{'Approved' if body.decision == 'approve' else 'Rejected'} by {user['email']}]"
    if body.reason:
        detail_suffix += f": {body.reason}"
    with get_db() as conn:
        row = conn.execute("SELECT * FROM execution_log WHERE id = ?", (execution_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row["status"] != "PENDING_APPROVAL":
            raise HTTPException(status_code=400, detail="Execution is not pending approval")
        existing_detail = row["detail"] or ""
        conn.execute(
            "UPDATE execution_log SET status = ?, detail = ? WHERE id = ?",
            (new_status, existing_detail + detail_suffix, execution_id),
        )
        log_audit(conn, user["email"], body.decision.upper() + "_EXECUTION", "execution", str(execution_id),
                  f"{'Approved' if body.decision == 'approve' else 'Rejected'} execution #{execution_id}")
    return {"id": execution_id, "status": new_status}


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


class MultiSimulateRequest(BaseModel):
    agent_ids: list[str]
    coordinator_id: str
    scenario_id: str = ""
    custom_prompt: str = ""
    dry_run: bool = True


@app.post("/api/sandbox/simulate/multi")
def run_multi_agent_simulation(req: MultiSimulateRequest, user: dict = Depends(get_current_user)):
    """Run a multi-agent simulation with dispatch between agents."""
    from sandbox.multi_runner import run_multi_simulation, run_multi_simulation_dry
    from sandbox.analyzer import analyze_multi_trace
    from sandbox.prompts.scenarios import get_scenario, Scenario
    from dataclasses import asdict as _asdict

    if req.coordinator_id not in req.agent_ids:
        raise HTTPException(status_code=400, detail="coordinator_id must be in agent_ids")

    # Load all agent configs
    agent_configs = {}
    with get_db() as conn:
        for aid in req.agent_ids:
            agent = get_agent_from_db(conn, aid)
            if not agent:
                raise HTTPException(status_code=404, detail=f"Agent '{aid}' not found")
            agent_configs[aid] = agent

    # Build scenario
    scenario = None
    if req.scenario_id:
        scenario = get_scenario(req.scenario_id)
        if not scenario:
            raise HTTPException(status_code=404, detail=f"Scenario '{req.scenario_id}' not found")
    elif req.custom_prompt:
        scenario = Scenario(
            id="custom", name="Custom Multi-Agent Prompt", description="Custom prompt",
            agent_type="ops", category="custom", severity="medium", prompt=req.custom_prompt,
        )
    else:
        raise HTTPException(status_code=400, detail="Provide scenario_id or custom_prompt")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    custom_data = _get_custom_data(req.coordinator_id)

    if req.dry_run:
        multi_trace = run_multi_simulation_dry(agent_configs, req.coordinator_id, scenario, custom_data=custom_data)
    else:
        if not api_key:
            raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY required for LLM simulation")
        multi_trace = run_multi_simulation(agent_configs, req.coordinator_id, scenario, api_key=api_key, custom_data=custom_data)

    report = analyze_multi_trace(multi_trace, agent_configs)

    # Store simulation
    with get_db() as conn:
        conn.execute(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (multi_trace.simulation_id, req.coordinator_id, scenario.id, multi_trace.status,
             json.dumps(_asdict(multi_trace), default=str),
             json.dumps(_asdict(report), default=str),
             datetime.utcnow().isoformat()),
        )
        log_audit(conn, user["sub"], user["email"], "MULTI_SIMULATE", resource=req.coordinator_id,
                  detail=f"Multi-agent sim with {len(req.agent_ids)} agents, dry_run={req.dry_run}")

    return {
        "simulation_id": multi_trace.simulation_id,
        "status": multi_trace.status,
        "agents": list(multi_trace.agent_traces.keys()),
        "dispatches": multi_trace.dispatches,
        "trace": {
            "total_steps": len(multi_trace.unified_steps),
            "steps": [_asdict(s) for s in multi_trace.unified_steps],
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
            "SELECT id, agent_id, scenario_id, status, created_at, report_json FROM simulations ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    simulations = []
    for r in rows:
        sim = dict(r)
        report = json.loads(sim.pop("report_json") or "{}")
        sim["risk_score"] = report.get("risk_score", 0)
        sim["violations"] = len(report.get("violations", []))
        sim["actions_blocked"] = report.get("actions_blocked", 0)
        sim["total_steps"] = report.get("total_steps", 0)
        simulations.append(sim)
    return {"simulations": simulations}


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


# ── Sweep (Full Agent Scan) ───────────────────────────────────────────────

class SweepRequest(BaseModel):
    agent_id: str
    dry_run: bool = True
    categories: list[str] = []  # optional filter, default: all


@app.post("/api/sandbox/sweep")
def run_sweep(req: SweepRequest, user: dict = Depends(get_current_user)):
    """Run every applicable scenario for an agent and produce an aggregate report."""
    from sandbox.runner import run_simulation, run_simulation_dry
    from sandbox.analyzer import analyze_trace, aggregate_reports
    from sandbox.prompts.scenarios import get_scenarios_for_agent, generate_scenarios_for_agent
    from sandbox.models import Scenario
    from dataclasses import asdict as _asdict

    with get_db() as conn:
        agent = get_agent_from_db(conn, req.agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent '{req.agent_id}' not found")

    config = _db_agent_to_config(agent)

    # Collect scenarios: hardcoded + auto-generated
    agent_type = _infer_agent_type_from_config(agent)
    scenarios = list(get_scenarios_for_agent(agent_type))
    auto_scenarios = generate_scenarios_for_agent(agent)
    scenarios.extend(auto_scenarios)

    # Filter by categories if specified
    if req.categories:
        scenarios = [s for s in scenarios if s.category in req.categories]

    if not scenarios:
        raise HTTPException(status_code=400, detail="No applicable scenarios found for this agent")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    custom_data = _get_custom_data(req.agent_id)
    sweep_id = uuid.uuid4().hex[:12]

    # Run each scenario
    results = []
    for scenario in scenarios:
        try:
            if req.dry_run:
                trace = run_simulation_dry(agent, scenario, custom_data=custom_data)
            else:
                if not api_key:
                    raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY required for LLM sweep")
                trace = run_simulation(agent, scenario, api_key=api_key, custom_data=custom_data)

            report = analyze_trace(trace)
            results.append((scenario, trace, report))
        except Exception as e:
            # Create a failed trace
            from sandbox.models import SimulationTrace
            failed_trace = SimulationTrace(
                simulation_id=sweep_id, agent_id=req.agent_id,
                agent_name=agent["name"], scenario_id=scenario.id,
                scenario_name=scenario.name, prompt=scenario.prompt,
                status="error", error=str(e),
            )
            from sandbox.models import SimulationReport
            empty_report = SimulationReport(
                simulation_id=sweep_id, agent_id=req.agent_id,
                scenario_id=scenario.id, total_steps=0,
                actions_executed=0, actions_blocked=0, actions_pending=0,
            )
            results.append((scenario, failed_trace, empty_report))

    # Aggregate
    sweep_report = aggregate_reports(results, req.agent_id, agent["name"], sweep_id)

    # Store
    with get_db() as conn:
        conn.execute(
            "INSERT INTO sweeps (id, agent_id, status, total_scenarios, completed, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sweep_id, req.agent_id, "completed", sweep_report.total_scenarios,
             sweep_report.completed, json.dumps(_asdict(sweep_report), default=str),
             datetime.utcnow().isoformat()),
        )
        log_audit(conn, user["sub"], user["email"], "SWEEP", resource=req.agent_id,
                  detail=f"Sweep: {sweep_report.total_scenarios} scenarios, risk={sweep_report.overall_risk_score}")

    return _asdict(sweep_report)


@app.get("/api/sandbox/sweeps")
def list_sweeps(user: dict = Depends(get_current_user)):
    """List past sweep runs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, agent_id, status, total_scenarios, completed, created_at, report_json FROM sweeps ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    sweeps = []
    for r in rows:
        s = dict(r)
        report = json.loads(s.pop("report_json") or "{}")
        s["overall_risk_score"] = report.get("overall_risk_score", 0)
        s["max_risk_score"] = report.get("max_risk_score", 0)
        s["violations"] = len(report.get("all_violations", []))
        s["chains"] = len(report.get("all_chains", []))
        sweeps.append(s)
    return {"sweeps": sweeps}


@app.get("/api/sandbox/sweep/{sweep_id}")
def get_sweep(sweep_id: str, user: dict = Depends(get_current_user)):
    """Get full sweep detail."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM sweeps WHERE id = ?", (sweep_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Sweep '{sweep_id}' not found")
    return json.loads(row["report_json"])


def _infer_agent_type_from_config(agent: dict) -> str:
    """Infer agent type from tool names for scenario matching."""
    tool_names = {t["name"] for t in agent.get("tools", [])}
    if "zendesk" in tool_names or ("stripe" in tool_names and "email" in tool_names):
        return "support"
    if "github" in tool_names or "aws" in tool_names:
        if "pagerduty" in tool_names:
            return "ops"
        return "devops"
    if "hubspot" in tool_names or "calendly" in tool_names:
        return "sales"
    return "support"  # default


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
    except Exception as e:
        logger.debug("Could not parse request body as JSON: %s", e)
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
    except Exception as e:
        logger.warning("Mock endpoint enforcement/logging error for %s.%s: %s", tool, action, e)

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


# ── API Key Management ─────────────────────────────────────────────────────

import hashlib as _hashlib
import secrets as _secrets


def _generate_api_key() -> tuple[str, str, str]:
    """Generate an API key. Returns (full_key, key_hash, key_prefix)."""
    raw = _secrets.token_urlsafe(32)
    full_key = f"ag_{raw}"
    key_hash = _hashlib.sha256(full_key.encode()).hexdigest()
    key_prefix = full_key[:10]
    return full_key, key_hash, key_prefix


def verify_api_key(request: Request) -> dict | None:
    """Check X-API-Key header against the api_keys table. Returns key row or None."""
    key = request.headers.get("X-API-Key", "")
    if not key:
        return None
    key_hash = _hashlib.sha256(key.encode()).hexdigest()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM api_keys WHERE key_hash = ? AND active = 1", (key_hash,)).fetchone()
        if row:
            conn.execute("UPDATE api_keys SET last_used = ? WHERE id = ?", (datetime.utcnow().isoformat(), row["id"]))
            return dict(row)
    return None


class CreateApiKeyRequest(BaseModel):
    name: str
    agent_id: str = ""  # optional: scope key to a specific agent


@app.post("/api/keys")
def create_api_key(req: CreateApiKeyRequest, user: dict = Depends(get_current_user)):
    """Generate a new API key for agent authentication."""
    full_key, key_hash, key_prefix = _generate_api_key()
    key_id = uuid.uuid4().hex[:12]

    with get_db() as conn:
        conn.execute(
            "INSERT INTO api_keys (id, key_hash, key_prefix, name, created_by, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (key_id, key_hash, key_prefix, req.name, user["email"], req.agent_id or None, datetime.utcnow().isoformat()),
        )
        log_audit(conn, user["sub"], user["email"], "CREATE_API_KEY", resource=key_id,
                  detail=f"Key '{req.name}' for agent={req.agent_id or 'any'}")

    # Return full key only once — it's never stored in plaintext
    return {"id": key_id, "key": full_key, "prefix": key_prefix, "name": req.name,
            "message": "Save this key — it won't be shown again."}


@app.get("/api/keys")
def list_api_keys(user: dict = Depends(get_current_user)):
    """List all API keys (shows prefix only, not the full key)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, key_prefix, name, agent_id, active, last_used, created_at, created_by FROM api_keys ORDER BY created_at DESC"
        ).fetchall()
    return {"keys": [dict(r) for r in rows]}


@app.delete("/api/keys/{key_id}")
def revoke_api_key(key_id: str, user: dict = Depends(get_current_user)):
    """Revoke an API key."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="API key not found")
        conn.execute("UPDATE api_keys SET active = 0 WHERE id = ?", (key_id,))
        log_audit(conn, user["sub"], user["email"], "REVOKE_API_KEY", resource=key_id,
                  detail=f"Revoked key '{row['name']}'")
    return {"message": "API key revoked"}


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
