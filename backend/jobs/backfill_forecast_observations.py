"""One-off: recover ledger rows from traffic that was captured before 0016.

`audit_log` has been storing every LLM_CALL since long before the ledger existed,
so the realized half of the training set is already on disk — it just was never
paired with anything. This walks back over trailing 7-day windows and writes one
row per agent per window from the calls that actually landed in it.

What it can and cannot recover:

  Y  is real. The token and call counts are provider-reported and were written
     down at the time; nothing about them is reconstructed.
  X  is the agent's CURRENT config, not its config during the window. Usually
     the same thing, and `config_hash` is stored so a later eval can detect the
     rows where it wasn't.
  F  is left NULL, deliberately. A contemporaneous forecast cannot be honestly
     reconstructed — prices, defaults and the formula have all moved since. A
     NULL `forecast_point_usd` is therefore the marker for "backfilled: Y only",
     and any query that grades forecast error must filter it out.

    cd arceo/backend && python3 -m jobs.backfill_forecast_observations --dry-run
    cd arceo/backend && python3 -m jobs.backfill_forecast_observations --days 90
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

import encryption
from analysis.forecast_observations import (
    OUTCOME_ARCEO_CAPTURE,
    build_observation,
    insert_observation,
    observation_exists,
)
from analysis.spend_forecast import compute_live_rolling_averages
from db import current_org, get_all_agents_from_db, get_db

WINDOW_DAYS = 7
DEFAULT_LOOKBACK_DAYS = 90
# Same floor the live forecast uses: below it there is not enough traffic for the
# rolling averages to mean anything, and a thin window would enter the training
# set looking like a real measurement.
MIN_CALLS_PER_WINDOW = 5


def _window_rows(conn, agent_id: str, start_iso: str, end_iso: str) -> list:
    rows = conn.execute(
        "SELECT detail, detail_enc, timestamp FROM audit_log "
        "WHERE action IN ('LLM_CALL', 'LLM_CALL_PROXY') AND user_email = %s "
        "AND timestamp > %s AND timestamp <= %s",
        (agent_id, start_iso, end_iso),
    ).fetchall()
    return [encryption.hydrate(dict(r), "detail") for r in rows]


def backfill(days: int = DEFAULT_LOOKBACK_DAYS, dry_run: bool = False) -> dict:
    """Walk trailing windows for every agent. Returns a summary dict."""
    today = datetime.utcnow().date()
    # Non-overlapping windows, newest first, so each captured call is counted once.
    window_ends = [today - timedelta(days=n) for n in range(0, days, WINDOW_DAYS)]

    with get_db() as conn:
        all_agents = get_all_agents_from_db(conn)

    by_org: dict[str, list] = {}
    for agent in all_agents:
        if not agent:
            continue
        by_org.setdefault(agent.get("org_id") or "default", []).append(agent)

    written = skipped = failed = 0
    for org_id_ctx, agents in by_org.items():
        # Per-org context, same as the nightly job: the RLS backstop is inert for
        # anything that runs the whole fleet at the 'system' context.
        token = current_org.set(org_id_ctx)
        try:
            with get_db() as conn:
                for agent in agents:
                    agent_id = agent["id"]
                    org_id = agent.get("org_id") or "default"
                    for end in window_ends:
                        observed_on = end.isoformat()
                        start_iso = (end - timedelta(days=WINDOW_DAYS)).isoformat()
                        end_iso = end.isoformat() + "T23:59:59"
                        try:
                            if observation_exists(conn, agent_id, org_id, observed_on,
                                                  OUTCOME_ARCEO_CAPTURE):
                                skipped += 1
                                continue
                            rows = _window_rows(conn, agent_id, start_iso, end_iso)
                            if len(rows) < MIN_CALLS_PER_WINDOW:
                                skipped += 1
                                continue
                            live_avgs = compute_live_rolling_averages(rows) or {}
                            if not live_avgs:
                                skipped += 1
                                continue
                            live_avgs["observed_calls"] = len(rows)
                            row = build_observation(
                                agent,
                                # F stays empty: see the module docstring.
                                {},
                                observed_on=observed_on,
                                captured_at=datetime.utcnow().isoformat(),
                                window_days=WINDOW_DAYS,
                                outcome_source=OUTCOME_ARCEO_CAPTURE,
                                live_avgs=live_avgs,
                            )
                            if dry_run:
                                print(f"  would write {agent_id} {observed_on} "
                                      f"({len(rows)} calls)")
                            else:
                                insert_observation(conn, row)
                            written += 1
                        except Exception as e:  # noqa: BLE001 — one bad window must not stop the walk
                            print(f"  ✗ {agent_id} {observed_on}: {e}", file=sys.stderr)
                            failed += 1
        finally:
            current_org.reset(token)

    return {"written": written, "skipped": skipped, "failed": failed, "dry_run": dry_run}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=DEFAULT_LOOKBACK_DAYS,
                    help=f"how far back to walk (default {DEFAULT_LOOKBACK_DAYS})")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the rows that would be written, write nothing")
    args = ap.parse_args()

    result = backfill(days=args.days, dry_run=args.dry_run)
    verb = "would write" if result["dry_run"] else "wrote"
    print(f"forecast_observations backfill: {verb}={result['written']} "
          f"skipped={result['skipped']} failed={result['failed']}")
    return 0 if result["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
