"""Phase-5 PR-4: real roles + instant session revocation.

viewer < editor < admin. A viewer is 403 on every mutating route; an editor
runs agent operations but is 403 on admin-only surfaces (credentials, keys,
notifications, cost, team); admin does everything. Changing a password
immediately invalidates the old token.
"""

from __future__ import annotations

import uuid

STRIPE_TOOL = {"name": "stripe", "service": "stripe",
               "actions": [{"action": "create_refund", "risk_labels": ["moves_money"], "reversible": False}]}


def _mk_agent(client, headers, name=None):
    name = name or "rbac-" + uuid.uuid4().hex[:6]
    r = client.post("/api/authority/agents", headers=headers, json={"name": name, "tools": [STRIPE_TOOL]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# Representative mutating routes with the role they require. Admin-only routes
# are the org-level security/billing surfaces; the rest are editor+.
def _editor_routes(agent_id):
    return [
        ("POST", "/api/authority/agents", {"name": "x-" + uuid.uuid4().hex[:6], "tools": [STRIPE_TOOL]}),
        ("PUT", f"/api/authority/agent/{agent_id}", {"name": "renamed"}),
        ("POST", f"/api/authority/agent/{agent_id}/policies",
         {"action_pattern": "stripe.*", "effect": "ALLOW", "reason": "x"}),
        ("PUT", f"/api/authority/agent/{agent_id}/test-data", {"customers": {}}),
        ("PUT", f"/api/agents/{agent_id}/budget", {"monthly_budget_usd": 5, "alert_threshold_pct": 50}),
    ]


_ADMIN_ROUTES = [
    ("PUT", "/api/credentials/stripe", {"secret": "s"}),
    ("POST", "/api/keys", {"name": "k"}),
    ("POST", "/api/notifications/settings", {"slack_webhook_url": "", "alert_email": "", "notify_on_block": True}),
    ("POST", "/api/team/invite", {"email": f"t-{uuid.uuid4().hex[:6]}@x.com", "password": "pw12345678", "role": "viewer"}),
]


def test_viewer_blocked_from_all_mutations(client, roles):
    admin, viewer = roles["admin"], roles["viewer"]
    agent_id = _mk_agent(client, admin["headers"])
    leaks = []
    for method, path, body in _editor_routes(agent_id) + _ADMIN_ROUTES:
        r = client.request(method, path, headers=viewer["headers"], json=body)
        if r.status_code != 403:
            leaks.append(f"viewer {method} {path} → {r.status_code} (expected 403)")
    assert not leaks, "viewer could mutate:\n" + "\n".join(leaks)


def test_editor_runs_agent_ops_but_not_admin_surfaces(client, roles):
    admin, editor = roles["admin"], roles["editor"]
    agent_id = _mk_agent(client, admin["headers"])
    # Editor is allowed on agent operations.
    for method, path, body in _editor_routes(agent_id):
        r = client.request(method, path, headers=editor["headers"], json=body)
        assert r.status_code != 403, f"editor blocked from {method} {path}: {r.text[:150]}"
    # ...but 403 on admin-only surfaces.
    for method, path, body in _ADMIN_ROUTES:
        r = client.request(method, path, headers=editor["headers"], json=body)
        assert r.status_code == 403, f"editor reached admin route {method} {path} → {r.status_code}"


def test_admin_can_do_everything(client, roles):
    admin = roles["admin"]
    agent_id = _mk_agent(client, admin["headers"])
    for method, path, body in _editor_routes(agent_id):
        assert client.request(method, path, headers=admin["headers"], json=body).status_code != 403
    # admin-only surfaces reachable (may 4xx on validation, but not 403)
    assert client.post("/api/keys", headers=admin["headers"], json={"name": "k"}).status_code == 200


def test_anyone_can_change_own_password(client, roles):
    # change-password is exempt from the editor gate — a viewer manages their own.
    viewer = roles["viewer"]
    r = client.post("/api/auth/change-password", headers=viewer["headers"],
                    json={"current_password": "pw12345678", "new_password": "pw-newer-123"})
    assert r.status_code == 200, r.text


def test_invite_lands_in_the_inviters_org_not_a_new_one(client, roles):
    """An invited teammate joins the CALLER's org with the requested role.

    The Settings invite form used to POST /api/auth/signup instead of this
    endpoint. Signup mints a fresh org_id and hardcodes role "admin", so the
    "invited" teammate silently became the admin of their own empty tenant and
    saw none of the inviter's data. Nothing on the backend was wrong — the
    frontend called the wrong route — so this pins the invariant the wrong
    route violated: same org, requested role, and a differing role is honored.
    """
    admin = roles["admin"]

    email = f"mate-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/team/invite", headers=admin["headers"],
                    json={"email": email, "password": "pw12345678", "role": "viewer"})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "viewer", "requested role was not honored"

    # Team membership is the observable form of "same org" — GET /api/team is
    # scoped WHERE org_id = the caller's, so appearing here IS the invariant.
    members = client.get("/api/team", headers=admin["headers"]).json()["members"]
    assert any(m["email"] == email and m["role"] == "viewer" for m in members), \
        f"{email} missing from the inviter's team list"

    # The contrast: signup is what the form used to call. It succeeds, reports
    # role "admin", and the new user does NOT join the inviter's org — which is
    # exactly why routing invites through it was wrong.
    solo = f"solo-{uuid.uuid4().hex[:8]}@example.com"
    s = client.post("/api/auth/signup",
                    json={"email": solo, "password": "pw12345678", "name": "solo"})
    assert s.status_code == 200, s.text
    assert s.json()["user"]["role"] == "admin"
    after = client.get("/api/team", headers=admin["headers"]).json()["members"]
    assert not any(m["email"] == solo for m in after), \
        "signup created the user inside the inviter's org — the tenant split is the whole point"


def test_password_change_revokes_old_token(client, roles):
    admin = roles["admin"]
    old_headers = admin["headers"]
    # Old token works now.
    assert client.get("/api/auth/me", headers=old_headers).status_code == 200
    # Change password.
    r = client.post("/api/auth/change-password", headers=old_headers,
                    json={"current_password": "pw12345678", "new_password": "pw-rotated-123"})
    assert r.status_code == 200, r.text
    # The SAME old token is now rejected instantly.
    assert client.get("/api/auth/me", headers=old_headers).status_code == 401
