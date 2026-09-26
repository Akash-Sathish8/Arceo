"""Seed the July 2026 OpenAI / Hugging Face incident demo.

Run with the backend up on :8000, after any `demo` reset:

    cd backend && ARCEO_ENV=dev ./venv/bin/python seed_demo_incident.py
    ./venv/bin/python seed_demo_incident.py --without-policies   # the "before" state

What it seeds, in order:

  1. Ingests the twelve-step attack trace as historical evidence. This
     registers the agent from the trace's tools and stores a simulation whose
     chains are the "Without Arceo" view on /incident.
  2. Re-registers the agent through the register API so the description,
     environment and trigger source read correctly on its page. Same tools,
     so the manifest is unchanged. Asserts the band is critical and the four
     incident chains are named.
  3. Writes the guard policies from demo_incident.POLICIES (unless
     --without-policies).
  4. Backdates a week of quiet LLM traffic plus a 3,779-call burst in the last
     24 hours, so the Cost Portfolio shows the anomaly banner. audit_log is not
     cleared by the demo wipe, so this survives resets; re-running appends.
  5. Sets a small monthly budget so the budget panel reads over threshold.

The replay itself is NOT run here. The /incident page runs it live so the
approvals queue fills in front of the audience.
"""

import argparse
import json
import random
import sys
from datetime import datetime, timedelta

import httpx

from db import get_db
from demo_incident import (
    AGENT_DESCRIPTION, AGENT_ID, AGENT_NAME, EXPECTED_CHAIN_IDS, POLICIES, TOOLS, TRACE,
)

BASE = "http://localhost:8000"
ADMIN = {"email": "admin@actiongate.io", "password": "admin123"}
MODEL = "gpt-5.6-sol"
BURST_CALLS = 3779   # the incident's day-one action count
BASELINE_PER_DAY = 40


def login() -> dict:
    r = httpx.post(f"{BASE}/api/auth/login", json=ADMIN, timeout=30)
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['token']}"}


def ingest_trace(h: dict) -> str:
    r = httpx.post(f"{BASE}/api/ingest/generic", headers=h,
                   json={"agent_name": AGENT_NAME, "actions": TRACE}, timeout=120)
    r.raise_for_status()
    body = r.json()
    print(f"  ingested {body['actions_ingested']} actions, simulation {body['simulation_id']}, "
          f"{body['report']['chains']} chains executed")
    return body["simulation_id"]


def register(h: dict) -> None:
    r = httpx.post(f"{BASE}/api/authority/agents/register", headers=h, json={
        "name": AGENT_NAME, "description": AGENT_DESCRIPTION, "tools": TOOLS,
        "simulation_model": MODEL, "environment": "prod",
        "trigger_source": "untrusted", "human_in_loop": False,
        "expected_calls_per_day": BASELINE_PER_DAY, "expected_turns_per_run": 8,
    }, timeout=120)
    r.raise_for_status()
    body = r.json()
    assert body["id"] == AGENT_ID, body
    band = body["blast_radius"]["band"]
    detail = httpx.get(f"{BASE}/api/authority/agent/{AGENT_ID}", headers=h, timeout=60).json()
    chain_ids = {c["id"] for c in detail["chains"]}
    missing = EXPECTED_CHAIN_IDS - chain_ids
    print(f"  registered {AGENT_ID}: band={band}, score={body['blast_radius'].get('score')}, "
          f"chains={len(chain_ids)}")
    if band != "critical" or missing:
        sys.exit(f"DEMO BROKEN: band={band}, missing chains={missing}")
    with get_db() as conn:
        conn.execute("UPDATE agents SET is_demo = true WHERE id = %s", (AGENT_ID,))


def clear_policies() -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM policies WHERE agent_id = %s", (AGENT_ID,))


def write_policies(h: dict) -> None:
    for p in POLICIES:
        r = httpx.post(f"{BASE}/api/authority/agent/{AGENT_ID}/policies", headers=h, json=p, timeout=30)
        r.raise_for_status()
    print(f"  wrote {len(POLICIES)} guard policies")


def _usage_detail(rng: random.Random) -> str:
    return json.dumps({
        "provider": "openai", "model": MODEL,
        "response": {"usage": {
            "input_tokens": rng.randint(700, 1400),
            "output_tokens": rng.randint(80, 220),
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }},
    })


def seed_anomaly(org_id: str) -> int:
    rng = random.Random(7)
    now = datetime.utcnow()
    rows = []
    # Seven quiet days, then the burst.
    for day in range(8, 1, -1):
        date = now - timedelta(days=day)
        for _ in range(max(20, int(rng.gauss(BASELINE_PER_DAY, 6)))):
            ts = date.replace(hour=rng.randint(8, 20), minute=rng.randint(0, 59), second=rng.randint(0, 59))
            rows.append((None, AGENT_ID, "LLM_CALL", f"openai:{MODEL}", _usage_detail(rng), org_id, ts.isoformat()))
    for i in range(BURST_CALLS):
        ts = now - timedelta(seconds=rng.randint(60, 23 * 3600))
        rows.append((None, AGENT_ID, "LLM_CALL", f"openai:{MODEL}", _usage_detail(rng), org_id, ts.isoformat()))
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO audit_log (user_id, user_email, action, resource, detail, org_id, timestamp) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)", rows)
    return len(rows)


def seed_budget(h: dict) -> None:
    r = httpx.put(f"{BASE}/api/agents/{AGENT_ID}/budget", headers=h,
                  json={"monthly_budget_usd": 250, "alert_threshold_pct": 80}, timeout=30)
    r.raise_for_status()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--without-policies", action="store_true",
                    help="seed the agent with no guards, so the replay lets everything through")
    ap.add_argument("--skip-anomaly", action="store_true",
                    help="do not append LLM traffic (audit_log is append-only)")
    args = ap.parse_args()

    h = login()
    print("1. ingesting the attack trace")
    sim_id = ingest_trace(h)
    print("2. registering the agent")
    register(h)
    with get_db() as conn:
        org_id = conn.execute("SELECT org_id FROM agents WHERE id = %s", (AGENT_ID,)).fetchone()["org_id"]
    print("3. policies")
    clear_policies()
    if args.without_policies:
        print("  none (--without-policies)")
    else:
        write_policies(h)
    if not args.skip_anomaly:
        print("4. LLM traffic")
        n = seed_anomaly(org_id)
        print(f"  {n} calls: a quiet week, then {BURST_CALLS} in the last 24 hours")
    print("5. budget")
    seed_budget(h)
    r = httpx.get(f"{BASE}/api/spend-anomalies", headers=h, timeout=60).json()
    flagged = [a for a in r.get("anomalies", r if isinstance(r, list) else []) if a.get("agentId") == AGENT_ID]
    print(f"  anomaly flagged: {bool(flagged)}" + (f" ({flagged[0]['ratio']:.0f}x)" if flagged else ""))

    print(f"""
Demo order:
  1. http://localhost:5173/agent/{AGENT_ID}            critical, chains named
  2.   Pre-launch tab                                       not ready, apply all
  3. http://localhost:5173/incident                        play, toggle, replay
  4. http://localhost:5173/approvals                       two held, reject
  5. http://localhost:5173/agent/{AGENT_ID}/spend      anomaly banner
  (without-Arceo simulation: {sim_id})""")


if __name__ == "__main__":
    main()
