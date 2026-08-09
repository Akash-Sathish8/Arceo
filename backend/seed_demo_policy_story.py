"""Seed the "apply the recommendations" demo agent — Incident Response Copilot.

Why this exists: the demo needs one agent that is *visibly dangerous* and whose
danger visibly falls when you click apply-all on the sandbox's own
recommendations. Everything below is chosen so that story is product-driven —
no hand-placed policies, no staged numbers.

The agent is an on-call SRE copilot over PagerDuty + AWS + Salesforce + Stripe.
Every tool overlaps an Arceo service mock, so a sandbox sweep genuinely executes
its actions rather than no-op'ing.

Measured on dev @ 2026-08-05 (13-scenario dry-run sweep):

                        before        after apply-all (4 policies)
  blast radius          95 critical   95 critical   <- inherent never moves
  residual score        95            54            "-41 from gates"
  sandbox risk score    64.1          5.4
  violations            8             2
  chains fired          14            0
  actions executed      54            31  (23 held for approval)

Two violations survive on purpose — `secret_access` (high) and `pii_access`
(medium). They are READS that never completed a dangerous chain, so the sweep
does not recommend gating them. Narrate that; don't hide it. A second sweep
after applying offers 0 new recommendations, so don't promise convergence.

**The headline blast-radius number does NOT drop, by design.** `graph.py` defines
`score` as the inherent capability ceiling; only `residual_score` responds to
policy. The agent detail page renders the delta as "-41 from gates". The fleet
card shows inherent, so it stays 95 CRITICAL.

Idempotent: re-running re-registers the agent and DELETES every policy on it, so
the agent is always returned to the "before" state. Run it before each rehearsal.

    cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/arceo \
        ./venv/bin/python seed_demo_policy_story.py

Registers through the public (unauthenticated) endpoint so it never logs in —
which matters, because the demo server runs DEMO_MODE=true where a `demo`-email
login wipes the demo tables.
"""

import sys

import httpx

from db import get_db

BASE = "http://localhost:8000"
AGENT_NAME = "Incident Response Copilot"
AGENT_ID = "incident-response-copilot"

DESCRIPTION = (
    "On-call SRE copilot: triages PagerDuty incidents, pulls customer context, "
    "runs remediation on AWS, and issues goodwill refunds for affected customers."
)

# Chosen for label spread, not volume: reads_secrets, executes_code,
# evades_detection, bulk_export, moves_money, deletes_data, changes_production,
# touches_pii, sends_external, changes_access. That spread is what produces 22
# capability chains (14 critical) and the 95 inherent score.
TOOLS = [
    {"name": "pagerduty", "service": "PagerDuty", "description": "Incident management", "actions": [
        {"name": "get_incident", "description": "Read an incident"},
        {"name": "escalate_incident", "description": "Escalate an incident to the on-call chain"},
    ]},
    {"name": "aws", "service": "AWS", "description": "Cloud infrastructure", "actions": [
        {"name": "get_secret", "description": "Read a secret from Secrets Manager"},
        {"name": "run_command", "description": "Run a remediation shell command on an instance"},
        {"name": "terminate_instance", "description": "Terminate an EC2 instance"},
        {"name": "disable_cloudtrail", "description": "Pause CloudTrail logging during remediation"},
    ]},
    {"name": "salesforce", "service": "Salesforce", "description": "CRM", "actions": [
        {"name": "query_contacts", "description": "Look up affected customer contacts"},
        {"name": "bulk_export_contacts", "description": "Export the affected-customer list"},
    ]},
    {"name": "stripe", "service": "Stripe", "description": "Payments", "actions": [
        {"name": "create_refund", "description": "Issue a goodwill refund to an affected customer"},
    ]},
]


def register_agent() -> str:
    r = httpx.post(f"{BASE}/api/authority/agents/register", json={
        "name": AGENT_NAME, "description": DESCRIPTION, "tools": TOOLS,
    }, timeout=60)
    r.raise_for_status()
    return r.json()["id"]


def clear_policies(agent_id: str) -> int:
    """Return the agent to the 'before' state. Without this, a second rehearsal
    starts with the gates already applied and the whole story falls flat."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT count(*) AS n FROM policies WHERE agent_id = %s", (agent_id,)
        ).fetchone()
        n = rows["n"] if rows else 0
        conn.execute("DELETE FROM policies WHERE agent_id = %s", (agent_id,))
    return n


def main() -> int:
    try:
        agent_id = register_agent()
    except Exception as e:
        print(f"Could not register agent (is the server up on :8000?): {e}", file=sys.stderr)
        return 1

    removed = clear_policies(agent_id)

    print(f"Seeded '{AGENT_NAME}' ({agent_id}):")
    print(f"  • {sum(len(t['actions']) for t in TOOLS)} actions across "
          f"{len(TOOLS)} tools, all covered by service mocks")
    print(f"  • cleared {removed} policy/policies → agent is back in the 'before' state")
    print( "  • expect: blast radius 95 CRITICAL, 22 chains (14 critical), residual 95")
    print()
    print( "Demo sequence:")
    print(f"  1. Show the agent      {BASE.replace(':8000', ':5173')}/agent/{agent_id}")
    print( "  2. Sandbox → Sweep all scenarios (dry run, free) → risk 64.1, 8 violations, 14 chains")
    print( "  3. Apply all recommended policies (4)")
    print( "  4. Re-sweep            → risk 5.4, 2 violations, 0 chains, 23 held for approval")
    print( "  5. Agent page          → residual 54, '-41 from gates' (inherent stays 95)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
