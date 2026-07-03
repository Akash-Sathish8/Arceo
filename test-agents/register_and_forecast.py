#!/usr/bin/env python3
"""
register_and_forecast.py — drive Arceo's spend forecaster against the synthetic
spend-test fleet and score how accurate it is vs each agent's hand-computed
expected_truth.

The core discipline (see README.md): a forecast is only "accurate" measured
against an INDEPENDENTLY-KNOWN true cost. Every synthetic/*.json carries an
`expected_truth.monthly_point_usd` that was computed by hand from the model
pricing + behavior — never from Arceo. This script registers each agent, asks
Arceo for its forecast, and reports the relative error against that truth.

Stdlib only (urllib, json, os, glob, argparse). No third-party deps.

Endpoints used (exactly as documented in the spec — nothing invented):
  POST /api/auth/login                         -> {"token": "...", "user": {...}}
  POST /api/authority/agents/register          -> {"id","status","blast_radius"}  (unauth)
  GET  /api/agents/{id}/spend-forecast?...      -> {"point","low","high","confidence",...}
  POST /api/sandbox/sweep                       -> {"id"/"sweep_id", ...}   (--sweep only)

simulation_model is NOT settable through any API (the register/PUT bodies accept
only name/description/tools, and neither writes the simulation_model column).
This script therefore does NOT attempt to set it — it surfaces the declared
simulation_model from each JSON for reference only and prints a note. To make a
real sweep run on the declared model you must UPDATE the agents.simulation_model
column directly in actiongate.db.
"""

import argparse
import glob
import json
import os
import sys
import urllib.error
import urllib.request

# ── Config ───────────────────────────────────────────────────────────────────

DEFAULT_BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
SYNTHETIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic")
ADMIN_EMAIL = os.environ.get("ARCEO_EMAIL", "admin@actiongate.io")
ADMIN_PASSWORD = os.environ.get("ARCEO_PASSWORD", "admin123")


# ── HTTP helpers (stdlib only) ───────────────────────────────────────────────

def _request(method, url, token=None, body=None, timeout=600):
    """Issue an HTTP request and return parsed JSON. Raises on non-2xx."""
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} -> HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"{method} {url} -> connection failed: {e.reason}. "
            f"Is the backend running at the base URL?"
        ) from None


def login(base_url):
    """POST /api/auth/login -> JWT in the top-level `token` field."""
    out = _request(
        "POST",
        f"{base_url}/api/auth/login",
        body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    token = out.get("token")
    if not token:
        raise RuntimeError(f"login succeeded but no `token` in response: {out}")
    return token


def register_agent(base_url, payload):
    """POST /api/authority/agents/register (unauth) -> {id, status, blast_radius}."""
    out = _request("POST", f"{base_url}/api/authority/agents/register", body=payload)
    agent_id = out.get("id")
    if not agent_id:
        raise RuntimeError(f"register returned no id: {out}")
    return agent_id


def declare_forecast_inputs(base_url, token, agent_id, spec):
    """POST /api/authority/agent/{id}/forecast-inputs — declare volume + model.

    Dev now gates the forecast behind a declared volume signal (available:false,
    reason:no_data until expected_calls_per_day or traces exist). We declare
    ONLY what a real customer would type at onboarding: calls/day and the model.
    Token mixes / cache rates stay undeclared — the forecaster must estimate
    those itself, or the test would be grading our own inputs.
    """
    body = {
        "expected_calls_per_day": spec.get("behavior", {}).get("calls_per_day"),
        "simulation_model": spec.get("simulation_model"),
    }
    body = {k: v for k, v in body.items() if v is not None}
    if not body:
        return
    _request(
        "POST",
        f"{base_url}/api/authority/agent/{agent_id}/forecast-inputs",
        token=token,
        body=body,
    )


def derive_agent_id(payload):
    """Mirror the server's id derivation (name.lower, spaces/underscores -> '-')
    so --no-register can reuse an already-registered agent without re-POSTing."""
    name = payload.get("name", "")
    return name.lower().replace(" ", "-").replace("_", "-")


def get_forecast(base_url, token, agent_id):
    """GET /api/agents/{id}/spend-forecast (LOW tier — no query overrides).

    We pass NO query params so the forecaster uses its own defaults/baseline.
    The whole point is to grade Arceo's unaided estimate, not a slider what-if.
    """
    url = f"{base_url}/api/agents/{agent_id}/spend-forecast"
    return _request("GET", url, token=token)


def run_sweep(base_url, token, agent_id, dry_run):
    """POST /api/sandbox/sweep -> generates traces -> upgrades agent to MEDIUM tier.

    dry_run=True skips the LLM (fast, free, but produces thinner traces).
    dry_run=False runs the real LLM loop (needs ANTHROPIC_API_KEY on the server
    and spends tokens) — that is what actually exercises the cost path.
    """
    body = {"agent_id": agent_id, "dry_run": dry_run, "categories": []}
    return _request("POST", f"{base_url}/api/sandbox/sweep", token=token, body=body)


# ── Synthetic fleet loading ──────────────────────────────────────────────────

def load_fleet():
    """Load every synthetic/*.json, sorted by filename for stable ordering."""
    fleet = []
    for path in sorted(glob.glob(os.path.join(SYNTHETIC_DIR, "*.json"))):
        with open(path, "r") as f:
            spec = json.load(f)
        fleet.append({"path": path, "file": os.path.basename(path), "spec": spec})
    return fleet


def expected_point(spec):
    """The hand-computed independent truth — the only legitimate yardstick."""
    return float(spec["expected_truth"]["monthly_point_usd"])


# ── Scoring ──────────────────────────────────────────────────────────────────

def rel_error_pct(forecast_point, truth_point):
    """Signed relative error vs truth, in percent. Positive = over-forecast."""
    if truth_point == 0:
        return float("inf") if forecast_point else 0.0
    return (forecast_point - truth_point) / truth_point * 100.0


def fmt_usd(x):
    return f"${x:,.2f}"


def print_table(title, rows):
    """rows: list of dicts with keys name, point, low, high, truth, err, tier."""
    print(f"\n{title}")
    print("-" * 108)
    print(
        f"{'agent':<30} {'tier':<8} {'forecast pt':>13} "
        f"{'band':>24} {'truth pt':>13} {'rel err':>10}"
    )
    print("-" * 108)
    for r in rows:
        band = f"[{fmt_usd(r['low'])} – {fmt_usd(r['high'])}]"
        err = "n/a" if r["err"] is None else f"{r['err']:+.1f}%"
        print(
            f"{r['name'][:29]:<30} {str(r['tier']):<8} {fmt_usd(r['point']):>13} "
            f"{band:>24} {fmt_usd(r['truth']):>13} {err:>10}"
        )
    print("-" * 108)


def collect_rows(base_url, token, fleet):
    """Forecast every agent and assemble scoreable rows."""
    rows = []
    for item in fleet:
        spec = item["spec"]
        agent_id = item["agent_id"]
        truth = expected_point(spec)
        try:
            fc = get_forecast(base_url, token, agent_id)
            if fc.get("point") is None:
                # Dev's forecast contract: available:false + reason until the
                # agent has a volume signal. Surface it instead of crashing.
                reason = fc.get("reason", "unavailable")
                print(f"  ! no forecast for {agent_id}: {reason} "
                      f"(needs: {', '.join(fc.get('needs', []) or [])})", file=sys.stderr)
                rows.append({
                    "name": spec.get("register_payload", {}).get("name", agent_id),
                    "agent_id": agent_id,
                    "point": 0.0, "low": 0.0, "high": 0.0,
                    "truth": truth, "err": None, "tier": f"NO-{reason.upper()}",
                })
                continue
            point = float(fc.get("point", 0.0))
            low = float(fc.get("low", 0.0))
            high = float(fc.get("high", 0.0))
            tier = fc.get("confidence", "?")
            err = rel_error_pct(point, truth)
        except RuntimeError as e:
            print(f"  ! forecast failed for {agent_id}: {e}", file=sys.stderr)
            point = low = high = 0.0
            tier = "ERROR"
            err = None
        rows.append({
            "name": spec.get("register_payload", {}).get("name", agent_id),
            "agent_id": agent_id,
            "point": point,
            "low": low,
            "high": high,
            "truth": truth,
            "err": err,
            "tier": tier,
        })
    return rows


def print_scorecard(low_rows, medium_rows=None):
    """Final summary: per-agent error, did MEDIUM beat LOW, and band coverage."""
    print("\n" + "=" * 108)
    print("SCORECARD")
    print("=" * 108)

    abs_errs = [abs(r["err"]) for r in low_rows if r["err"] is not None]
    if abs_errs:
        mean_abs = sum(abs_errs) / len(abs_errs)
        print(f"LOW tier  — mean |rel error| vs truth: {mean_abs:.1f}%  "
              f"(median {sorted(abs_errs)[len(abs_errs)//2]:.1f}%)")

    # Band coverage: does the independent truth land inside Arceo's stated band?
    covered = sum(
        1 for r in low_rows
        if r["tier"] != "ERROR" and r["low"] <= r["truth"] <= r["high"]
    )
    total = sum(1 for r in low_rows if r["tier"] != "ERROR")
    if total:
        print(f"LOW tier  — truth inside stated band: {covered}/{total} agents")

    if medium_rows:
        by_id = {r["agent_id"]: r for r in low_rows}
        improved = same = worse = 0
        med_abs = []
        for m in medium_rows:
            if m["err"] is None:
                continue
            med_abs.append(abs(m["err"]))
            lo = by_id.get(m["agent_id"])
            if not lo or lo["err"] is None:
                continue
            if abs(m["err"]) < abs(lo["err"]) - 0.5:
                improved += 1
            elif abs(m["err"]) > abs(lo["err"]) + 0.5:
                worse += 1
            else:
                same += 1
        if med_abs:
            print(f"MEDIUM tier — mean |rel error| vs truth: "
                  f"{sum(med_abs)/len(med_abs):.1f}%")
        print(f"LOW -> MEDIUM convergence: {improved} improved, "
              f"{same} unchanged, {worse} regressed")
        print("  Note: MEDIUM may narrow the band without moving the point — "
              "sandbox traces feed unit-economics + tier detection but NOT the "
              "per-call token basis (only live LLM captures do). See README.")
    print("=" * 108)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description=(
            "Register the synthetic spend-test fleet against a running Arceo "
            "backend and score forecast accuracy vs each agent's hand-computed "
            "expected_truth. Forecasts are graded ONLY against independent truth, "
            "never against Arceo's own numbers."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Tiers:\n"
            "  LOW    = default run (no flags). Capability tree only — the "
            "forecaster has no traces.\n"
            "  MEDIUM = --sweep. Runs a sandbox sweep per agent first, then "
            "re-forecasts.\n\n"
            "WARNING about --sweep:\n"
            "  A REAL sweep (dry_run=false, via --real-sweep) runs the agent's "
            "LLM loop and\n"
            "  therefore SPENDS LLM TOKENS and requires ANTHROPIC_API_KEY set on "
            "the SERVER.\n"
            "  Plain --sweep uses dry_run=true (no LLM, free, but thinner traces).\n\n"
            "  simulation_model is NOT API-settable; this script never tries to "
            "set it. To run\n"
            "  a sweep on the declared model, UPDATE agents.simulation_model in "
            "actiongate.db directly.\n"
        ),
    )
    p.add_argument("--base-url", default=DEFAULT_BASE_URL,
                   help=f"Arceo backend base URL (default: {DEFAULT_BASE_URL})")
    p.add_argument("--no-register", action="store_true",
                   help="Skip registration; reuse agents already in the DB "
                        "(ids derived from each payload name).")
    p.add_argument("--sweep", action="store_true",
                   help="Run a sandbox sweep per agent to reach MEDIUM tier, "
                        "then print a second forecast table. Uses dry_run=true "
                        "unless --real-sweep is also given.")
    p.add_argument("--real-sweep", action="store_true",
                   help="With --sweep, run the REAL LLM loop (dry_run=false). "
                        "Spends tokens; needs ANTHROPIC_API_KEY on the server.")
    args = p.parse_args()

    base_url = args.base_url.rstrip("/")
    print(f"Base URL: {base_url}")

    # 1) Auth
    print("Logging in as admin@actiongate.io ...")
    token = login(base_url)
    print("  got JWT.")

    # 2) Load fleet
    fleet = load_fleet()
    if not fleet:
        print(f"No synthetic/*.json found in {SYNTHETIC_DIR}", file=sys.stderr)
        sys.exit(1)
    print(f"Loaded {len(fleet)} synthetic agents.")

    # 3) Register (or reuse) + declare volume/model via forecast-inputs
    print("\nRegistering agents (declaring calls/day + model via forecast-inputs):")
    for item in fleet:
        spec = item["spec"]
        payload = spec["register_payload"]
        declared_model = spec.get("simulation_model", "?")
        if args.no_register:
            item["agent_id"] = derive_agent_id(payload)
            print(f"  reuse  {item['agent_id']:<34} (model declared: {declared_model})")
        else:
            agent_id = register_agent(base_url, payload)
            item["agent_id"] = agent_id
            declare_forecast_inputs(base_url, token, agent_id, spec)
            print(f"  ok     {agent_id:<34} (model declared: {declared_model})")

    # 4) LOW-tier forecast + table
    low_rows = collect_rows(base_url, token, fleet)
    print_table("LOW TIER — Arceo forecast vs independent truth", low_rows)

    # 5) Optional MEDIUM tier via sweep
    medium_rows = None
    if args.sweep:
        dry_run = not args.real_sweep
        mode = "REAL LLM (dry_run=false)" if args.real_sweep else "dry-run (no LLM)"
        print(f"\nRunning sandbox sweeps to reach MEDIUM tier — mode: {mode}")
        if args.real_sweep:
            print("  WARNING: this spends LLM tokens and needs ANTHROPIC_API_KEY "
                  "on the server.")
        for item in fleet:
            agent_id = item["agent_id"]
            try:
                out = run_sweep(base_url, token, agent_id, dry_run)
                sid = out.get("id") or out.get("sweep_id") or "?"
                print(f"  swept  {agent_id:<34} sweep={sid}")
            except RuntimeError as e:
                print(f"  ! sweep failed for {agent_id}: {e}", file=sys.stderr)
        medium_rows = collect_rows(base_url, token, fleet)
        print_table("MEDIUM TIER — forecast after sandbox sweep vs truth",
                    medium_rows)

    # 6) Scorecard
    print_scorecard(low_rows, medium_rows)


if __name__ == "__main__":
    main()
