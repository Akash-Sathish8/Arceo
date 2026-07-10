"""Durable held-action queue (Phase 4).

When a policy returns REQUIRE_APPROVAL, the action is parked in
`pending_requests` so it can be replayed verbatim once a human approves — or
so a waiting agent can be told to proceed. This module owns the table's
create / claim / lookup logic; main.py wires it into the proxy, enforce, and
approvals endpoints.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime

# Inbound credentials are NEVER stored — the vault provides the real upstream
# secret at replay time, so persisting the agent's own key would be both
# useless and a secret-at-rest leak.
_REDACT_HEADERS = {"authorization", "x-api-key"}


def _redact_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in _REDACT_HEADERS}


def make_idempotency_key() -> str:
    return uuid.uuid4().hex


def create_pending_proxy(conn, *, execution_id: int, org_id: str, agent_id: str,
                         service: str, method: str, path: str, query: dict,
                         headers: dict, body: bytes, action: str, params: dict | None) -> str:
    """Park a full proxy request for replay-on-approve. Returns the pending id."""
    pid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO pending_requests (id, execution_id, org_id, agent_id, kind, status, "
        "service, method, path, query_json, headers_json, body, tool, action, params_json, "
        "idempotency_key, created_at) "
        "VALUES (%s, %s, %s, %s, 'proxy', 'PENDING', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (pid, execution_id, org_id, agent_id, service, method, path,
         json.dumps(query or {}), json.dumps(_redact_headers(headers or {})),
         base64.b64encode(body or b"").decode(), service, action,
         json.dumps(params) if params else None, make_idempotency_key(),
         datetime.utcnow().isoformat()),
    )
    return pid


def create_pending_enforce(conn, *, execution_id: int, org_id: str, agent_id: str,
                           tool: str, action: str, params: dict | None) -> str:
    """Park an enforce decision-gate (no request to replay — the agent proceeds
    itself on approval). Returns the pending id."""
    pid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO pending_requests (id, execution_id, org_id, agent_id, kind, status, "
        "tool, action, params_json, idempotency_key, created_at) "
        "VALUES (%s, %s, %s, %s, 'enforce', 'PENDING', %s, %s, %s, %s, %s)",
        (pid, execution_id, org_id, agent_id, tool, action,
         json.dumps(params) if params else None, make_idempotency_key(),
         datetime.utcnow().isoformat()),
    )
    return pid


def get_by_execution(conn, execution_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM pending_requests WHERE execution_id = %s", (execution_id,)
    ).fetchone()
    return dict(row) if row else None


def claim_decision(conn, execution_id: int, decision: str, decided_by: str) -> dict | None:
    """Atomically transition PENDING → APPROVED/REJECTED for the pending row
    linked to this execution. The conditional WHERE status='PENDING' means only
    ONE caller wins even if two approvers race — no SELECT-then-UPDATE gap.
    Returns the claimed row, or None if it was already decided (or has no
    pending_requests row — e.g. legacy rows predating Phase 4)."""
    new_status = "APPROVED" if decision == "approve" else "REJECTED"
    row = conn.execute(
        "UPDATE pending_requests SET status = %s, decided_by = %s, decided_at = %s "
        "WHERE execution_id = %s AND status = 'PENDING' RETURNING *",
        (new_status, decided_by, datetime.utcnow().isoformat(), execution_id),
    ).fetchone()
    return dict(row) if row else None


def mark_replayed(conn, pending_id: str, ok: bool, detail: str) -> None:
    conn.execute(
        "UPDATE pending_requests SET status = %s, replayed_at = %s, replay_detail = %s "
        "WHERE id = %s",
        ("REPLAYED" if ok else "REPLAY_FAILED", datetime.utcnow().isoformat(), detail, pending_id),
    )


def decoded_body(row: dict) -> bytes:
    return base64.b64decode(row["body"]) if row.get("body") else b""
