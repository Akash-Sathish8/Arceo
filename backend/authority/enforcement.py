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


# Restrictive effect wins a specificity tie regardless of the priority column —
# priority only orders policies within the same effect.
_EFFECT_RANK = {"BLOCK": 2, "REQUIRE_APPROVAL": 1, "ALLOW": 0}


def _action_variants(action_key: str) -> list[str]:
    """Naive singular/plural variants of the action part of `tool.action`.

    The proxy infers action names from URL paths (`GET /v1/customers` →
    `get_customers`) while policies are usually authored singular
    (`get_customer`), so an exact-only match silently skips them. Variants are
    consulted ONLY after a full pass with the exact key found nothing: an exact
    policy always wins, and a variant hit can only convert a would-be default
    into a match — which errs toward blocking (fail-safe). That ordering also
    contains the hazard of catalogs where e.g. `get_charge` and `get_charges`
    are both real actions.
    """
    tool, dot, act = action_key.partition(".")
    if not dot or not act:
        return []
    if act.endswith("s"):
        return [f"{tool}.{act[:-1]}"]
    return [f"{tool}.{act}s"]


def match_policy(action_key: str, policies: list, params: dict | None = None, session_context: list | None = None) -> dict | None:
    """Match an action key against policies, evaluating conditions if present.

    Conditions are optional JSON: [{"field": "amount", "op": "gt", "value": 100}]
    Supported ops: gt, gte, lt, lte, eq, neq, in, not_in, contains, requires_prior
    If a policy has conditions and params are provided, ALL conditions must match.
    If no params provided, conditions are ignored (backward compatible).
    session_context is a list of prior action strings (e.g. ["pagerduty.get_incident", "aws.list_instances"]).

    Precedence: most SPECIFIC matching pattern first, then effect
    (BLOCK > REQUIRE_APPROVAL > ALLOW), then the priority column — so a narrow
    exception beats a broad rule, and two rules at the same breadth resolve by
    effect structurally (an ALLOW can never out-prioritize a same-breadth BLOCK).

    A pattern-matched policy whose conditions cannot be parsed or evaluated is
    UNEVALUABLE: the returned dict carries effect="BLOCK" and unevaluable=True.
    Silently widening (a conditional ALLOW becoming unconditional) or narrowing
    it would both be lies — failing closed is the only honest option.

    If a full pass finds nothing, one retry runs with naive singular/plural
    variants of the action (see _action_variants).
    """
    def _get(p, key, default):
        # Policies arrive as dicts (DB rows use dict_row) but may lack keys; missing
        # IndexError on a missing column.
        try:
            v = p[key]
            return default if v is None else v
        except (KeyError, IndexError, TypeError):
            return default

    policies = sorted(
        policies,
        key=lambda p: (
            _pattern_specificity(_get(p, "action_pattern", "")),
            _EFFECT_RANK.get(_get(p, "effect", ""), 0),
            _get(p, "priority", 0),
        ),
        reverse=True,
    )

    def _match_pass(key: str) -> dict | None:
        key_parts = key.split(".")
        for p in policies:
            pattern = p["action_pattern"]
            pattern_match = False

            if pattern == key:
                pattern_match = True
            elif pattern == "*":
                # A bare `*` is a full wildcard. It used to split to one part
                # where the branch below requires two, so `*` policies (e.g.
                # Workflows "Apply All" REQUIRE_APPROVAL gates) never fired.
                pattern_match = True
            elif pattern.endswith(".*") and key.startswith(pattern[:-1]):
                pattern_match = True
            elif "*" in pattern:
                parts = pattern.split(".")
                if len(parts) == 2 and len(key_parts) == 2:
                    tool_match = parts[0] == "*" or parts[0] == key_parts[0]
                    # The `parts[1] == key_parts[1]` arm makes tool-wildcard,
                    # action-exact patterns (`*.create_refund`) match — graph.py
                    # already scores them as mitigating; enforcement must agree.
                    action_match = (
                        parts[1] == "*"
                        or parts[1] == key_parts[1]
                        or (parts[1].endswith("*") and key_parts[1].startswith(parts[1][:-1]))
                    )
                    if tool_match and action_match:
                        pattern_match = True

            if not pattern_match:
                continue

            # Evaluate conditions. A policy we cannot evaluate must not be
            # silently widened OR narrowed — fail closed instead.
            try:
                try:
                    raw_conditions = p["conditions"]
                except (KeyError, IndexError):
                    raw_conditions = None
                conditions = json.loads(raw_conditions) if raw_conditions else []
                if conditions and not isinstance(conditions, list):
                    raise ValueError("conditions must be a JSON list")

                if conditions:
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
            except Exception:
                return {**{k: p[k] for k in p.keys()}, "effect": "BLOCK", "unevaluable": True}
        return None

    matched = _match_pass(action_key)
    if matched is not None:
        return matched
    for variant in _action_variants(action_key):
        matched = _match_pass(variant)
        if matched is not None:
            return matched
    return None


# ── Notification ──────────────────────────────────────────────────────────────

def fire_block_notification(agent_id: str, tool: str, action: str, reason: str):
    """Fire Slack webhook when an action is blocked. Never raises — notification failures must not break enforcement."""
    try:
        from db import get_db
        with get_db() as conn:
            org_row = conn.execute("SELECT org_id FROM agents WHERE id = %s", (agent_id,)).fetchone()
            org_id = org_row["org_id"] if org_row else None
            row = conn.execute("SELECT * FROM workspace_settings WHERE org_id = %s", (org_id,)).fetchone()
        if not row or not row["notify_on_block"]:
            return
        # MED-014: the column may hold ciphertext in slack_webhook_url_enc now
        # (SELECT * above already fetches both). encryption.read prefers the enc
        # column and falls back to plaintext, so this works either way.
        import encryption
        slack_url = encryption.read(row, "slack_webhook_url") or ""
        if not slack_url:
            return
        # Cross-worker dedup: the same BLOCK evaluated on two workers should
        # send ONE Slack message, not two. Short TTL so a genuinely repeated
        # block later still alerts. Best-effort — if Redis is unreachable the
        # notification still fires (worse to go silent than to double-send).
        try:
            import shared_state
            if not shared_state.should_fire_once(f"block:{org_id}:{agent_id}:{tool}:{action}", 60):
                return
        except Exception:
            pass
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
        # MED-010: this fires on every BLOCK with a URL an org admin supplied, so it
        # goes through the guarded egress path — host allowlist, no internal targets,
        # connection pinned to the vetted IP, redirects refused.
        import egress
        egress.post_webhook(slack_url, payload)
    except Exception:
        pass  # Never let notification failures break enforcement


# ── Enforcement Decision ──────────────────────────────────────────────────────

def safe_enforce_check(agent_id: str, tool: str, action: str, params: dict = None,
                       session_context: list = None, source: str = "runtime") -> dict:
    """enforce_check that NEVER raises — the fail-closed wrapper for hot paths.

    An exception mid-decision (DB hiccup, malformed row, anything) must not
    become an uncontrolled 500 that skips both the decision AND the audit row.
    The fallback decision is BLOCK unless ARCEO_FAIL_MODE=allow — the
    documented break-glass for "an Arceo outage must not halt customer
    agents". Matches the sandbox executor's convention (PR #25): enforcement
    failure is an explicit, labeled outcome, never a silent pass.
    """
    import os

    try:
        return enforce_check(agent_id, tool, action, params=params,
                             session_context=session_context, source=source)
    except Exception as exc:
        fail_mode = os.environ.get("ARCEO_FAIL_MODE", "block").strip().lower()
        decision = "ALLOW" if fail_mode == "allow" else "BLOCK"
        detail = f"enforcement_error ({type(exc).__name__}) — fail-{'open (ARCEO_FAIL_MODE=allow)' if decision == 'ALLOW' else 'closed'}"
        # Best-effort audit: the primary decision path just failed, so this may
        # fail too — swallow it, the decision must still return.
        try:
            from db import get_db, log_execution, DEFAULT_ORG_ID
            with get_db() as conn:
                agent_row = conn.execute("SELECT org_id FROM agents WHERE id = %s", (agent_id,)).fetchone()
                log_execution(conn, agent_id, tool, action,
                              "BLOCKED" if decision == "BLOCK" else "EXECUTED",
                              policy_id=None, detail=detail,
                              org_id=agent_row["org_id"] if agent_row else DEFAULT_ORG_ID,
                              params=params, source=source)
        except Exception:
            pass
        return {
            "decision": decision,
            "action": f"{tool}.{action}",
            "agent_id": agent_id,
            "policy": None,
            "reason": "enforcement_error",
            "message": f"Enforcement could not be evaluated ({type(exc).__name__}); failing {'open — ARCEO_FAIL_MODE=allow' if decision == 'ALLOW' else 'closed'}.",
        }


def enforce_check(agent_id: str, tool: str, action: str, params: dict = None, session_context: list = None, source: str = "runtime") -> dict:
    """Shared enforce logic — used by the API endpoint, proxy, and sandbox executor.

    `source` labels the execution row's provenance (runtime | sandbox |
    boundary_test | replay | test) so reviewers can tell live agent traffic
    from simulations. Defaults to "runtime" — the API endpoint and service
    proxy are real traffic; every sandbox-side caller must override it.

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
        agent_row = conn.execute("SELECT * FROM agents WHERE id = %s", (agent_id,)).fetchone()
        agent_org = agent_row["org_id"] if agent_row else DEFAULT_ORG_ID
        # Opt-in per-agent fail-closed posture. Unknown agents keep the historic
        # implicit-ALLOW (zero-config onboarding must not go dark).
        default_effect = "ALLOW"
        if agent_row is not None and "default_effect" in agent_row.keys():
            default_effect = agent_row["default_effect"] or "ALLOW"

        policies = conn.execute(
            "SELECT * FROM policies WHERE agent_id = %s ORDER BY priority DESC, id", (agent_id,)
        ).fetchall()

        matched_policy = match_policy(action_key, policies, params=params or None, session_context=session_context or None)

        # match_policy returns a plain dict (never a Row) exactly when it flags
        # an unevaluable policy.
        unevaluable = isinstance(matched_policy, dict) and bool(matched_policy.get("unevaluable"))
        deny_by_default = False

        if matched_policy:
            effect = matched_policy["effect"]
            status = "BLOCKED" if effect == "BLOCK" else "PENDING_APPROVAL" if effect == "REQUIRE_APPROVAL" else "EXECUTED"
        elif default_effect == "DENY":
            deny_by_default = True
            effect = "BLOCK"
            status = "BLOCKED"
        else:
            effect = "ALLOW"
            status = "EXECUTED"

        if unevaluable:
            detail = f"unevaluable policy {matched_policy.get('id')}. We could not evaluate the conditions, so this failed closed"
        elif matched_policy:
            detail = matched_policy["reason"]
        elif deny_by_default:
            detail = "no policy matched; agent is deny-by-default"
        else:
            detail = "No matching policy"

        execution_id = log_execution(conn, agent_id, tool, action, status,
                      policy_id=matched_policy["id"] if matched_policy else None,
                      detail=detail,
                      org_id=agent_org, params=params, source=source)

        if status == "BLOCKED":
            fire_block_notification(agent_id, tool, action, detail)

        if matched_policy:
            message = detail if unevaluable else matched_policy["reason"]
        elif deny_by_default:
            message = "Blocked. No policy matched and this agent is deny-by-default."
        else:
            message = "Action allowed. No policy matched it."

        return {
            "decision": effect,
            "action": action_key,
            "agent_id": agent_id,
            "policy": dict(matched_policy) if matched_policy else None,
            "message": message,
            # The PENDING_APPROVAL row id, so a caller can park a durable
            # replayable request against it (Phase 4). None for non-approval
            # decisions is fine; callers only use it on REQUIRE_APPROVAL.
            "execution_id": execution_id,
        }
