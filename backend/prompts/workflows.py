"""Prompt workflows: prompts stacked into steps, scored as one unit.

A step fills each `{{variable}}` from one of:
  {"from": "input", "name": "<workflow input>"}  - supplied when the workflow runs
  {"from": "step", "step": k}                     - the output of an earlier step k
  (unmapped)                                      - the prompt's own sample/length

Cost per model = the sum of the steps, where a step-fed variable costs exactly
the previous step's output tokens (measured or declared, the same basis rules
as one prompt). The total's basis is the weakest step's.

Danger = the worst step, re-scored with TAINT: a workflow input that is
untrusted, and any step output that was produced from tainted content, is
untrusted where it lands. When tainted content reaches a step that can act,
that is the workflow form of chain_detector's untrusted-input -> action
transition, and it is scored as a chain even if no single step looks dangerous alone.
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

from authority.graph import _soft_cap, score_band

from .cost import default_models, score_cost, weakest
from .danger import _TRUSTED_SUFFIX, CHAIN_UPLIFT, MULTI_FACTOR_UPLIFT, _reason, score_danger
from .template import VariableSpec, variables_in

MAX_STEPS = 8

_UNTRUSTED_INPUT = re.compile(
    r"(email|mail|message|reply|chat|transcript|comment|review|ticket|page|html|web|url|article|doc|file|"
    r"pdf|attachment|resume|post|feedback|input|customer|client|pasted|paste|content|text|body|query|scrape)",
    re.I,
)


class StepSource(BaseModel):
    source: Literal["input", "step"] = Field(alias="from")
    name: Optional[str] = Field(default=None, max_length=80)
    step: Optional[int] = Field(default=None, ge=0, lt=MAX_STEPS)
    model_config = {"populate_by_name": True}


class Step(BaseModel):
    prompt_id: str = Field(..., max_length=64)
    input_map: dict[str, StepSource] = Field(default_factory=dict)


class WorkflowInput(BaseModel):
    name: str = Field(..., max_length=80)
    untrusted: Optional[bool] = None
    expected_tokens: Optional[int] = Field(default=None, ge=0, le=2_000_000)


class WorkflowSpec(BaseModel):
    steps: list[Step] = Field(default_factory=list, max_length=MAX_STEPS)
    inputs: list[WorkflowInput] = Field(default_factory=list, max_length=20)


class WorkflowError(ValueError):
    pass


def _validate(spec: WorkflowSpec, prompts: list[Optional[dict]]) -> None:
    names = {i.name for i in spec.inputs}
    for idx, (step, p) in enumerate(zip(spec.steps, prompts)):
        if p is None:
            raise WorkflowError(f"Step {idx + 1}: prompt not found or not shared with you.")
        body_vars = set(variables_in(p["body"]))
        for var, src in step.input_map.items():
            if var not in body_vars:
                raise WorkflowError(f"Step {idx + 1}: the prompt has no {var.replace('_', ' ')} blank.")
            if src.source == "step" and (src.step is None or src.step >= idx):
                raise WorkflowError(f"Step {idx + 1}: the {var.replace('_', ' ')} blank can only use the answer from an EARLIER step.")
            if src.source == "input" and src.name not in names:
                raise WorkflowError(f"Step {idx + 1}: the {var.replace('_', ' ')} blank uses something you paste in that hasn't been set up.")


def _input_untrusted(inp: WorkflowInput) -> bool:
    if inp.untrusted is not None:
        return inp.untrusted
    return bool(_UNTRUSTED_INPUT.search(inp.name)) and not _TRUSTED_SUFFIX.search(inp.name)


def score_workflow(spec: WorkflowSpec, prompts: list[Optional[dict]], org_id: Optional[str],
                   models: Optional[list[str]] = None) -> dict:
    """`prompts[i]` is the readable prompt row for step i (store.get_prompt shape)."""
    _validate(spec, prompts)
    from analysis.spend_forecast import load_defaults
    model_list = models or default_models(load_defaults(org_id))
    inputs = {i.name: i for i in spec.inputs}

    # ── cost: walk steps per model, feeding each step's output length forward ──
    per_model = {}
    for model in model_list:
        out_tokens: list[Optional[int]] = []
        total, bases, floor, steps_out = 0.0, [], False, []
        available = True
        for idx, (step, p) in enumerate(zip(spec.steps, prompts)):
            base_vars = {k: VariableSpec(**v) for k, v in (p.get("variables") or {}).items()}
            for var, src in step.input_map.items():
                if src.source == "step":
                    prev = out_tokens[src.step]
                    base_vars[var] = VariableSpec(expected_tokens=prev) if prev else VariableSpec()
                else:
                    inp = inputs[src.name]
                    base_vars[var] = VariableSpec(expected_tokens=inp.expected_tokens) if inp.expected_tokens else base_vars.get(var, VariableSpec())
            measured = (p.get("cost_summary") or {}).get("models", [])
            measured_out = {m["model_key"]: m["output_tokens"] for m in measured
                            if m.get("output_basis") == "measured" and m.get("output_tokens")}
            row = score_cost(p["body"], base_vars, expected_output_tokens=p.get("expected_output_tokens"),
                             measured_output_tokens=measured_out, models=[model], org_id=org_id,
                             allow_network=False)["models"][0]
            if not row["available"]:
                available = False
                break
            total += row["usd_per_run"]
            bases.append(row["basis"])
            floor = floor or row["is_floor"]
            out_tokens.append(row["output_tokens"])
            steps_out.append({"step": idx, "usd_per_run": row["usd_per_run"], "basis": row["basis"],
                              "input_tokens": row["input_tokens"], "output_tokens": row["output_tokens"]})
        per_model[model] = ({"model": model, "available": False} if not available else {
            "model": model, "model_key": row["model_key"], "available": True,
            "usd_per_run": round(total, 8), "usd_per_1k_runs": round(total * 1000, 5),
            "basis": weakest(*bases) if bases else "unavailable", "is_floor": floor, "steps": steps_out,
        })
    priced = [m for m in per_model.values() if m["available"]]
    cheapest = min(priced, key=lambda m: m["usd_per_run"], default=None)

    # ── danger: taint propagation, then per-step score and chain detection ──
    tainted_out: list[bool] = []
    step_dangers, reasons = [], []
    for idx, (step, p) in enumerate(zip(spec.steps, prompts)):
        vars_ = {k: VariableSpec(**v) for k, v in (p.get("variables") or {}).items()}
        tainted_vars = []
        for var, src in step.input_map.items():
            t = tainted_out[src.step] if src.source == "step" else _input_untrusted(inputs[src.name])
            spec_v = vars_.get(var, VariableSpec())
            vars_[var] = spec_v.model_copy(update={"untrusted": t})
            if t:
                tainted_vars.append(var)
        d = score_danger(p["body"], vars_, tools=p.get("tools") or [])
        # Any untrusted content in this step taints its output for later steps.
        tainted_out.append(bool(d["untrusted_variables"]))
        step_dangers.append({"step": idx, "title": p["title"], "score": d["score"], "band": d["band"],
                             "reasons": d["reasons"]})
        # Cross-step chain: tainted content that arrived from an EARLIER step,
        # landing in a step that can act. Inside step idx the variable is just
        # "untrusted"; the hand-off is what the reader needs to see, so that
        # step's generic chain reason is replaced by one naming both steps.
        caps = [r for r in d["reasons"] if r["factor"] == "capability"]
        upstream = [v for v in tainted_vars if step.input_map[v].source == "step"]
        cross = bool(caps and upstream)
        for r in d["reasons"]:
            if not (cross and r["factor"] == "chain"):
                reasons.append({**r, "step": idx})
        if cross:
            top = max(caps, key=lambda r: r["points"])
            src_step = step.input_map[upstream[0]].step
            reasons.append({**_reason(
                "chain", top["points"] + CHAIN_UPLIFT,
                f"A stranger's message in step {src_step + 1} could steer step {idx + 1}",
                f"Step {src_step + 1} reads text from outside, and its answer goes into step {idx + 1}, which takes action "
                f"({top['title'].lower()}). Hidden instructions in that text can carry through from one step to the next.",
                f"step {src_step + 1} -> step {idx + 1}"), "step": idx})

    by_factor: dict[str, float] = {}
    for r in reasons:
        by_factor[r["factor"]] = max(by_factor.get(r["factor"], 0), r["points"])
    ordered = sorted(by_factor.values(), reverse=True)
    base = ordered[0] if ordered else 0.0
    extra = sum(1 for v in ordered[1:] if v >= 40)
    score = int(round(_soft_cap(base + MULTI_FACTOR_UPLIFT * extra)))
    reasons.sort(key=lambda r: -r["points"])

    return {
        "cost": {"models": list(per_model.values()),
                 "cheapest_model": cheapest["model_key"] if cheapest else None},
        "danger": {"score": score, "band": score_band(score), "status": "static",
                   "reasons": reasons, "steps": step_dangers},
    }


def run_workflow(spec: WorkflowSpec, prompts: list[Optional[dict]], inputs: dict[str, str],
                 model: str, org_id: Optional[str]) -> dict:
    """Run every step in order on one model, feeding outputs forward.

    Same spend rules as QA (qa.Keys: own key or the free allowance; up-front cap
    from the worst case of every step at max output). Returns per-step outputs
    and measured tokens and dollars, plus the total.
    """
    from analysis.spend_forecast import load_defaults, price_call

    from . import qa

    _validate(spec, prompts)
    missing = [i.name for i in spec.inputs if not (inputs.get(i.name) or "").strip()]
    if missing:
        raise qa.QaError(400, "Fill in " + ", ".join(m.replace("_", " ") for m in missing) + " to run this workflow.")
    (model_key, provider), = qa.resolve_models([model], org_id)
    keys = qa.Keys(org_id, {provider})
    defaults = load_defaults(org_id)
    est = 0.0
    longest_input = sum(len(v) for v in inputs.values())
    for p in prompts:
        row = score_cost(p["body"], {}, expected_output_tokens=qa.MAX_OUTPUT_TOKENS, models=[model_key],
                         org_id=org_id, allow_network=False)["models"][0]
        # Each step can receive the inputs plus every earlier step's max output.
        carry = longest_input // 3 + qa.MAX_OUTPUT_TOKENS * len(prompts)
        est += row["usd_per_run"] + (price_call(model_key, carry, 0, defaults=defaults)["usd"] or 0.0)
    qa.check_caps(est, keys, org_id)

    outputs: list[str] = []
    steps, total = [], 0.0
    for idx, (step, p) in enumerate(zip(spec.steps, prompts)):
        values = {k: (v or {}).get("sample") or "" for k, v in (p.get("variables") or {}).items()}
        for var, src in step.input_map.items():
            values[var] = outputs[src.step] if src.source == "step" else inputs.get(src.name, "")
        text = qa._fill(p["body"], values)
        r = qa.call_model(model_key, provider, None, text, org_id, api_key=keys.key_for(provider))
        usd = price_call(model_key, r["input_tokens"], r["output_tokens"], defaults=defaults)["usd"] or 0.0
        total += usd
        outputs.append(r["text"])
        steps.append({"step": idx, "title": p["title"], "output": r["text"], "input_tokens": r["input_tokens"],
                      "output_tokens": r["output_tokens"], "usd": round(usd, 8), "latency_ms": r["latency_ms"]})
    keys.record("workflow_run", total)
    from .store import now
    return {"model": model_key, "steps": steps, "usd_total": round(total, 8), "at": now(),
            "key_source": "server" if keys.uses_server else "own"}
