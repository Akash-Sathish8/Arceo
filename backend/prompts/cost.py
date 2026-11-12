"""What a prompt costs to run: $ per run and per 1,000 runs, per model.

Input tokens come from the rendered template (tokens.py). Output tokens come,
best first, from measured QA runs, then from the author's declared expected
output length. With neither, output cost is unavailable and the per-run figure
is shown as an input-only floor. A model whose price is not verified in the
catalog is reported unavailable rather than priced at a related row's guess.
"""

from __future__ import annotations

from typing import Optional

from analysis.spend_forecast import (
    catalog_calibration_date,
    is_recommendable,
    load_defaults,
    model_provider,
    overrides_status,
    price_call,
)

from .template import VariableSpec, render
from .tokens import count_tokens

# The comparison set shown when the caller doesn't pick models: the current
# workhorse and budget rows of the three vendors founders and agencies use most.
# Filtered against the live catalog so a retired or removed row never appears.
DEFAULT_MODELS = (
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o-mini",
    "gemini-2-5-pro",
    "gemini-2-5-flash",
)

# Weakest-first, so a total's basis is the weakest basis among its parts.
_BASIS_RANK = {"unavailable": 0, "heuristic": 1, "declared": 2, "exact": 3, "measured": 4}


def weakest(*bases: str) -> str:
    return min(bases, key=lambda b: _BASIS_RANK.get(b, 0)) if bases else "unavailable"


def default_models(defaults: dict) -> list[str]:
    rows = defaults.get("models") or {}
    return [m for m in DEFAULT_MODELS if m in rows and is_recommendable(rows[m])]


def score_cost(
    body: str,
    variables: dict[str, VariableSpec],
    *,
    expected_output_tokens: Optional[int] = None,
    measured_output_tokens: Optional[dict[str, int]] = None,
    models: Optional[list[str]] = None,
    org_id: Optional[str] = None,
    allow_network: bool = True,
) -> dict:
    """Per-model cost of one run of this prompt.

    `measured_output_tokens` maps catalog model key -> median output tokens from
    QA runs; it beats `expected_output_tokens` for that model.
    """
    defaults = load_defaults(org_id)
    rows = defaults.get("models") or {}
    text, declared_in, unsized = render(body, variables)
    measured_output_tokens = measured_output_tokens or {}

    out_rows = []
    for requested in (models or default_models(defaults)):
        probe = price_call(requested, 0, 0, defaults=defaults)
        key = probe["model_key"]
        row = rows.get(key) or {}
        provider = model_provider(row)
        if probe["usd"] is None:
            out_rows.append({
                "model": requested, "model_key": None, "provider": provider,
                "available": False, "reason": "model_not_in_catalog",
            })
            continue

        in_tok, in_basis = count_tokens(text, key, provider,
                                        float(row.get("tokenizer_inflation", 1.0)),
                                        allow_network=allow_network)
        in_tok += declared_in
        if declared_in:
            in_basis = weakest(in_basis, "declared")

        if key in measured_output_tokens:
            out_tok, out_basis = int(measured_output_tokens[key]), "measured"
        elif expected_output_tokens is not None:
            out_tok, out_basis = int(expected_output_tokens), "declared"
        else:
            out_tok, out_basis = 0, "unavailable"

        usd = price_call(key, in_tok, out_tok, defaults=defaults)["usd"]
        out_rows.append({
            "model": requested,
            "model_key": key,
            "provider": provider,
            "available": True,
            "input_tokens": in_tok,
            "output_tokens": out_tok if out_basis != "unavailable" else None,
            "input_basis": in_basis,
            "output_basis": out_basis,
            # A floor when output is unknown: input cost only, labelled as such.
            "is_floor": out_basis == "unavailable" or bool(unsized),
            # Sub-cent values are the point here, so keep 8 decimals per run.
            "usd_per_run": round(usd, 8),
            "usd_per_1k_runs": round(usd * 1000, 5),
            "basis": weakest(in_basis, out_basis),
            "verified_on": row.get("verified_on"),
        })

    priced = [r for r in out_rows if r["available"]]
    cheapest = min(priced, key=lambda r: r["usd_per_run"], default=None)
    return {
        "models": out_rows,
        "cheapest_model": cheapest["model_key"] if cheapest else None,
        "unsized_variables": unsized,
        "catalog_date": catalog_calibration_date(defaults),
        "rates": overrides_status(defaults),  # applied | none | unavailable
    }
