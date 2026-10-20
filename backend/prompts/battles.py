"""Prompt battles: one task, fixed hidden inputs, every entry run on the same model.

Voters see two outputs for the same input, blind, and pick one. Ratings are Elo,
COMPUTED FROM THE VOTES on every read (chronological replay), so ranking never
writes to another org's rows. Each entry also carries its cost per run on the
battle model (measured from its own outputs) and its danger score, and the
leaderboard can rank by quality, by "cheapest that's still good", or by safety.
That last part is what a prompt contest without cost and risk can't offer.
"""

from __future__ import annotations

import random
import statistics
from typing import Optional

from analysis.spend_forecast import load_defaults, model_provider, price_call

from . import qa, store
from .cost import score_cost
from .danger import score_danger
from .template import VariableSpec, variables_in

ELO_START = 1000.0
ELO_K = 32.0


def elo(entry_ids: list[str], votes: list[dict]) -> dict[str, dict]:
    """Replay votes in order -> {entry_id: {elo, wins, losses, ties, votes}}."""
    table = {e: {"elo": ELO_START, "wins": 0, "losses": 0, "ties": 0, "votes": 0} for e in entry_ids}
    for v in votes:
        a, b = v["entry_a"], v["entry_b"]
        if a not in table or b not in table:
            continue
        ra, rb = table[a]["elo"], table[b]["elo"]
        ea = 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
        if v["winner"] == "tie":
            sa = 0.5
            table[a]["ties"] += 1
            table[b]["ties"] += 1
        elif v["winner"] == a:
            sa = 1.0
            table[a]["wins"] += 1
            table[b]["losses"] += 1
        else:
            sa = 0.0
            table[b]["wins"] += 1
            table[a]["losses"] += 1
        table[a]["elo"] = ra + ELO_K * (sa - ea)
        table[b]["elo"] = rb + ELO_K * ((1 - sa) - (1 - ea))
        table[a]["votes"] += 1
        table[b]["votes"] += 1
    for t in table.values():
        t["elo"] = round(t["elo"])
    return table


def battle_variables(inputs: list[dict]) -> list[str]:
    names: dict[str, None] = {}
    for i in inputs:
        for k in (i.get("values") or {}):
            names.setdefault(k, None)
    return list(names)


def run_entry(battle: dict, body: str, org_id: str) -> dict:
    """Run one entry on every battle input; return outputs + cost + danger.

    Same spend rules as QA: priced up front against the per-run cap and the
    org's monthly cap, metered to the entrant's org.
    """
    import cogs

    defaults = load_defaults(org_id)
    priced = price_call(battle["model"], 0, 0, defaults=defaults)
    if priced["usd"] is None:
        raise qa.QaError(400, "This comparison's model isn't in the price catalog.")
    key = priced["model_key"]
    provider = model_provider((defaults.get("models") or {}).get(key) or {})
    inputs = battle["inputs"] or []
    est_row = score_cost(body, {}, expected_output_tokens=qa.MAX_OUTPUT_TOKENS, models=[key],
                         org_id=org_id, allow_network=False)["models"][0]
    longest = max((sum(len(v) for v in (i.get("values") or {}).values()) for i in inputs), default=0)
    estimate = (est_row["usd_per_run"] + (price_call(key, longest // 4, 0, defaults=defaults)["usd"] or 0)) * len(inputs)
    if estimate > qa.RUN_CAP_USD:
        raise qa.QaError(400, f"Running this entry could cost up to ${estimate:.2f}, over the per-run cap.")
    if (cogs.total(org_id) or 0.0) + estimate > qa.MONTHLY_CAP_USD:
        raise qa.QaError(429, "Your team has used its monthly QA budget.")

    outputs, outs_tok, ins_tok = [], [], []
    for i in inputs:
        text = qa._fill(body, i.get("values") or {})
        r = qa.call_model(key, provider, None, text, org_id)
        outputs.append(r["text"])
        outs_tok.append(r["output_tokens"])
        ins_tok.append(r["input_tokens"])
    med_in = int(statistics.median(ins_tok)) if ins_tok else 0
    med_out = int(statistics.median(outs_tok)) if outs_tok else 0
    usd = price_call(key, med_in, med_out, defaults=defaults)["usd"]
    cost = {"model_key": key, "usd_per_run": round(usd or 0.0, 8), "usd_per_1k_runs": round((usd or 0.0) * 1000, 5),
            "input_tokens": med_in, "output_tokens": med_out, "basis": "measured"}
    # Battle inputs are written by the organiser, so they're scored as pasted-in
    # content: a contest prompt will be reused on real, untrusted text.
    variables = {n: VariableSpec(untrusted=True) for n in variables_in(body)}
    danger = score_danger(body, variables)
    return {"outputs": outputs, "cost": cost, "danger": danger}


def leaderboard(entries: list[dict], votes: list[dict], sort: str = "best") -> list[dict]:
    ratings = elo([e["id"] for e in entries], votes)
    rows = []
    for e in entries:
        r = ratings[e["id"]]
        rows.append({"id": e["id"], "author_id": e.get("author_id"), "author_name": e.get("author_name"),
                     "cost": e.get("cost"), "danger": e.get("danger"), **r})
    if sort == "cheapest_good":
        # "Good" = rated at or above the field's median; then cheapest first.
        floor = statistics.median([r["elo"] for r in rows]) if rows else 0
        good = [r for r in rows if r["elo"] >= floor]
        rest = [r for r in rows if r["elo"] < floor]
        key = lambda r: ((r.get("cost") or {}).get("usd_per_run") or float("inf"), -r["elo"])
        rows = sorted(good, key=key) + sorted(rest, key=key)
    elif sort == "safest":
        rows.sort(key=lambda r: ((r.get("danger") or {}).get("score", 100), -r["elo"]))
    else:
        rows.sort(key=lambda r: (-r["elo"], -r["wins"]))
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    return rows


def pick_matchup(entries: list[dict], voted: set[tuple], voter_id: str, n_inputs: int,
                 rng: Optional[random.Random] = None) -> Optional[dict]:
    """A random pair the voter hasn't judged on some input, excluding their own entry.

    `voted` holds (entry_a, entry_b, input_index) with a < b. Sides are shuffled
    so position never reveals which entry is which.
    """
    rng = rng or random.Random()
    pool = [e for e in entries if e.get("author_id") != voter_id]
    options = []
    for i in range(len(pool)):
        for j in range(i + 1, len(pool)):
            a, b = sorted((pool[i]["id"], pool[j]["id"]))
            for k in range(n_inputs):
                if (a, b, k) not in voted:
                    options.append((a, b, k))
    if not options:
        return None
    a, b, k = rng.choice(options)
    left, right = (a, b) if rng.random() < 0.5 else (b, a)
    return {"left": left, "right": right, "input_index": k}
