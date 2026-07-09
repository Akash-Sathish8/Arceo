"""Core enforcement logic — policy matching, condition evaluation, and decision making.

Extracted from main.py so sandbox components can import it without circular deps.
Used by: main.py (API endpoint), sandbox/runner.py (dry-run), proxy layer.
"""

from __future__ import annotations

import json


# ── Policy Matching ───────────────────────────────────────────────────────────

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

    CONTRACT: a session-conditioned policy only matches when the caller passes
    session_context. With no context (or an empty one) the requires_prior
    condition is treated as UNMET, so the policy does NOT apply — the guarded
    action is decided by the remaining policies/default. Callers that enforce
    session-gated policies MUST pass session_context (the prior actions this
    session); the /proxy and sandbox executor do. This is deliberate: a policy
    conditioned on a prior that did not happen should not fire, and we do not
    over-gate every action just because a caller omitted context.
    """
    if not session_context:
        return False  # has session conditions but no/empty context — condition unmet

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


def _pattern_specificity(pattern: str) -> int:
    """How specific a policy pattern is. Higher wins.

    3 exact (stripe.create_refund) > 2 partial wildcard (stripe.create_*) >
    1 tool wildcard (stripe.*) > 0 full wildcard (*). Lets an explicit exact-match
    exception override a broader rule regardless of effect — the intuitive
    firewall/CSS "most specific rule wins", so `ALLOW stripe.get_customer` beats
    `BLOCK stripe.*` while `BLOCK stripe.create_refund` beats `ALLOW stripe.*`.
    """
    if "*" not in pattern:
        return 3
    if pattern in ("*", "*.*", ".*"):
        return 0
    if pattern.endswith(".*") and pattern.count("*") == 1:
        return 1
    return 2


def match_policy(action_key: str, policies: list, params: dict | None = None, session_context: list | None = None) -> dict | None:
    """Match an action key against policies, evaluating conditions if present.

    Conditions are optional JSON: [{"field": "amount", "op": "gt", "value": 100}]
    Supported ops: gt, gte, lt, lte, eq, neq, in, not_in, contains, requires_prior
    If a policy has conditions and params are provided, ALL conditions must match.
    If no params provided, conditions are ignored (backward compatible).
    session_context is a list of prior action strings (e.g. ["pagerduty.get_incident", "aws.list_instances"]).

    Precedence: most SPECIFIC matching pattern first, then effect priority
    (BLOCK 100 > REQUIRE_APPROVAL 50 > ALLOW 10) as the tie-break within the same
    specificity — so a narrow exception beats a broad rule, but two rules at the
    same breadth resolve by effect (a BLOCK wins over an ALLOW).
    """
    def _get(p, key, default):
        # Policies arrive as either dicts or sqlite3.Row (no .get()); Row raises
        # IndexError on a missing column.
        try:
            v = p[key]
            return default if v is None else v
        except (KeyError, IndexError, TypeError):
            return default

    policies = sorted(
        policies,
        key=lambda p: (_pattern_specificity(_get(p, "action_pattern", "")), _get(p, "priority", 0)),
        reverse=True,
    )
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
        # Guard the parse: a malformed conditions row must not 500 the enforcement
        # hot path (the read endpoints already tolerate it). Treat unparseable as
        # "no conditions" so pattern match alone decides — for a BLOCK that means
        # it still fires (fail-safe).
        try:
            conditions = json.loads(raw_conditions) if raw_conditions else []
        except (ValueError, TypeError):
            conditions = []
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


# ── Notification ──────────────────────────────────────────────────────────────

def fire_block_notification(agent_id: str, tool: str, action: str, reason: str):
    """Fire Slack webhook when an action is blocked. Never raises — notification failures must not break enforcement."""
    try:
        from db import get_db
        with get_db() as conn:
            org_row = conn.execute("SELECT org_id FROM agents WHERE id = ?", (agent_id,)).fetchone()
            org_id = org_row["org_id"] if org_row else None
            row = conn.execute("SELECT * FROM workspace_settings WHERE org_id = ?", (org_id,)).fetchone()
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


# ── Enforcement Decision ──────────────────────────────────────────────────────

def enforce_check(agent_id: str, tool: str, action: str, params: dict = None, session_context: list = None) -> dict:
    """Shared enforce logic — used by the API endpoint, proxy, and sandbox executor.

    Returns a dict with:
        decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL"
        action: "tool.action"
        agent_id: str
        policy: matched policy dict or None
        message: human-readable reason
    """
    from db import get_db, log_execution, DEFAULT_ORG_ID

    action_key = f"{tool}.{action}"

    with get_db() as conn:
        # Resolve the agent's org so the execution row (and the approvals queue it
        # feeds) lands in the right tenant rather than defaulting to 'default'.
        agent_row = conn.execute("SELECT org_id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        agent_org = agent_row["org_id"] if agent_row else DEFAULT_ORG_ID

        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = ? ORDER BY priority DESC, id", (agent_id,)
        ).fetchall()

        matched_policy = match_policy(action_key, policies, params=params or None, session_context=session_context or None)

        if matched_policy:
            effect = matched_policy["effect"]
            status = "BLOCKED" if effect == "BLOCK" else "PENDING_APPROVAL" if effect == "REQUIRE_APPROVAL" else "EXECUTED"
        else:
            effect = "ALLOW"
            status = "EXECUTED"

        log_execution(conn, agent_id, tool, action, status,
                      policy_id=matched_policy["id"] if matched_policy else None,
                      detail=matched_policy["reason"] if matched_policy else "No matching policy",
                      org_id=agent_org, params=params)

        if status == "BLOCKED":
            fire_block_notification(agent_id, tool, action, matched_policy["reason"] if matched_policy else "")

        return {
            "decision": effect,
            "action": action_key,
            "agent_id": agent_id,
            "policy": dict(matched_policy) if matched_policy else None,
            "message": matched_policy["reason"] if matched_policy else "Action allowed — no matching policy",
        }
