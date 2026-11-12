"""Signup helper for the prompt-library tests.

Import THIS, never `tests.conftest`: importing conftest under a second module
name re-runs it, which blanks ANTHROPIC_API_KEY and drops/recreates the test
database in the middle of the session.
"""

from __future__ import annotations


def signup(client, email: str) -> dict:
    r = client.post("/api/auth/signup", json={"email": email, "password": "pw12345678", "name": email.split("@")[0]})
    assert r.status_code == 200, f"signup failed: {r.text}"
    token = r.json()["token"]
    from db import get_db
    with get_db() as conn:
        org_id = conn.execute("SELECT org_id FROM users WHERE email = %s", (email,)).fetchone()["org_id"]
    return {"token": token, "org_id": org_id, "email": email, "headers": {"Authorization": f"Bearer {token}"}}
