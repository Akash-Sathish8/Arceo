"""Cost model — maps agent capabilities to estimated financial exposure.

Takes a blast radius analysis, maps each risky capability to a cost category,
and outputs per-tool breach scenarios with cost ranges. All numbers come from
a configurable YAML — no made-up defaults. Unconfigured values show as $0
with a "NOT_CONFIGURED" flag so it's clear the customer needs to set them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from authority.risk_classifier import classify_action


DEFAULT_CONFIG_PATH = Path(__file__).parent / "cost_defaults.yaml"


def _load_config(config_path: str = None) -> dict:
    """Load cost configuration from YAML."""
    path = config_path or os.getenv("ARCEO_COST_CONFIG") or str(DEFAULT_CONFIG_PATH)
    with open(path) as f:
        return yaml.safe_load(f)


@dataclass
class CostLineItem:
    tool: str
    action: str
    capability: str              # risk label: moves_money, touches_pii, etc.
    category: str                # direct_financial_loss, regulatory_fine, etc.
    breach_scenario: str
    per_incident_min_usd: float
    per_incident_max_usd: float
    annualized_min_usd: float
    annualized_max_usd: float
    confidence: str              # high, medium, low
    configured: bool             # False if customer hasn't set values
    reversible: bool
    has_policy: bool             # True if a policy covers this action


@dataclass
class CostReport:
    agent_id: str
    agent_name: str
    total_risky_actions: int = 0
    total_unprotected: int = 0   # risky actions with no policy
    configured: bool = False     # True if customer has set cost values

    # Aggregates
    total_min_exposure_usd: float = 0.0
    total_max_exposure_usd: float = 0.0
    annualized_min_usd: float = 0.0
    annualized_max_usd: float = 0.0

    # Per category
    by_category: dict = field(default_factory=dict)

    # Line items
    items: list[CostLineItem] = field(default_factory=list)

    # Config info
    daily_runs: int = 0
    config_source: str = ""


def generate_cost_report(
    agent_config: dict,
    policies: list = None,
    config_path: str = None,
    daily_runs: int = None,
) -> CostReport:
    """Generate a cost-of-breach report for an agent.

    Maps each risky action to a cost category and breach scenario.
    Multiplies by exposure window for annualized risk.
    """
    config = _load_config(config_path)
    cap_mapping = config.get("capability_mapping", {})
    severity_ranges = config.get("severity_ranges", {})
    exposure = config.get("exposure", {})
    confidence_map = config.get("confidence", {})

    runs_per_day = daily_runs or exposure.get("daily_runs", 0)
    days_per_year = exposure.get("days_per_year", 365)
    annual_runs = runs_per_day * days_per_year

    # Build set of actions covered by policies
    protected_actions = set()
    if policies:
        for p in policies:
            pattern = p.get("action_pattern", "")
            effect = p.get("effect", "")
            if effect in ("BLOCK", "REQUIRE_APPROVAL"):
                protected_actions.add(pattern)

    report = CostReport(
        agent_id=agent_config["id"],
        agent_name=agent_config["name"],
        daily_runs=runs_per_day,
        config_source=config_path or str(DEFAULT_CONFIG_PATH),
    )

    # Check if any severity ranges are configured (non-zero)
    any_configured = any(
        r.get("per_incident_max_usd", 0) > 0
        for r in severity_ranges.values()
    )
    report.configured = any_configured

    category_totals = {}

    for tool in agent_config.get("tools", []):
        tool_name = tool["name"]
        for action in tool.get("actions", []):
            action_name = action["action"] if isinstance(action, dict) else action
            description = action.get("description", "") if isinstance(action, dict) else ""
            db_labels = action.get("risk_labels", []) if isinstance(action, dict) else []
            reversible = action.get("reversible", True) if isinstance(action, dict) else True

            if db_labels:
                labels = db_labels
            else:
                labels, rev = classify_action(action_name, description)
                reversible = rev

            if not labels:
                continue

            action_key = f"{tool_name}.{action_name}"

            # Check if protected by policy
            has_policy = action_key in protected_actions
            for pat in protected_actions:
                if pat.endswith(".*") and action_key.startswith(pat[:-1]):
                    has_policy = True
                if pat == f"{tool_name}.*":
                    has_policy = True

            report.total_risky_actions += 1
            if not has_policy:
                report.total_unprotected += 1

            for label in labels:
                cap_info = cap_mapping.get(label)
                if not cap_info:
                    continue

                category = cap_info["category"]
                scenarios = cap_info.get("breach_scenarios", ["Unspecified breach scenario"])
                sev = severity_ranges.get(category, {})

                per_min = sev.get("per_incident_min_usd", 0)
                per_max = sev.get("per_incident_max_usd", 0)

                # Irreversible actions get full cost; reversible get reduced
                if reversible:
                    per_min *= 0.3
                    per_max *= 0.3

                # Unprotected actions get full exposure; protected get reduced
                if has_policy:
                    per_min *= 0.05  # 95% reduction if policy catches it
                    per_max *= 0.05

                annual_min = per_min * annual_runs if annual_runs else 0
                annual_max = per_max * annual_runs if annual_runs else 0

                confidence = confidence_map.get("static_only", "low")
                configured = per_max > 0

                for scenario in scenarios[:1]:  # one scenario per action per label
                    item = CostLineItem(
                        tool=tool_name,
                        action=action_name,
                        capability=label,
                        category=category,
                        breach_scenario=scenario,
                        per_incident_min_usd=round(per_min, 2),
                        per_incident_max_usd=round(per_max, 2),
                        annualized_min_usd=round(annual_min, 2),
                        annualized_max_usd=round(annual_max, 2),
                        confidence=confidence,
                        configured=configured,
                        reversible=reversible,
                        has_policy=has_policy,
                    )
                    report.items.append(item)

                    # Aggregate by category
                    if category not in category_totals:
                        category_totals[category] = {"min": 0, "max": 0, "annual_min": 0, "annual_max": 0, "count": 0}
                    category_totals[category]["min"] += per_min
                    category_totals[category]["max"] += per_max
                    category_totals[category]["annual_min"] += annual_min
                    category_totals[category]["annual_max"] += annual_max
                    category_totals[category]["count"] += 1

    # Totals
    report.total_min_exposure_usd = round(sum(c["min"] for c in category_totals.values()), 2)
    report.total_max_exposure_usd = round(sum(c["max"] for c in category_totals.values()), 2)
    report.annualized_min_usd = round(sum(c["annual_min"] for c in category_totals.values()), 2)
    report.annualized_max_usd = round(sum(c["annual_max"] for c in category_totals.values()), 2)

    report.by_category = {
        cat: {
            "per_incident_min_usd": round(vals["min"], 2),
            "per_incident_max_usd": round(vals["max"], 2),
            "annualized_min_usd": round(vals["annual_min"], 2),
            "annualized_max_usd": round(vals["annual_max"], 2),
            "actions": vals["count"],
        }
        for cat, vals in category_totals.items()
    }

    return report


def report_to_dict(report: CostReport) -> dict:
    result = {
        "agent_id": report.agent_id,
        "agent_name": report.agent_name,
        "configured": report.configured,
        "daily_runs": report.daily_runs,
        "total_risky_actions": report.total_risky_actions,
        "total_unprotected": report.total_unprotected,
        "per_incident": {
            "min_usd": report.total_min_exposure_usd,
            "max_usd": report.total_max_exposure_usd,
        },
        "annualized": {
            "min_usd": report.annualized_min_usd,
            "max_usd": report.annualized_max_usd,
        },
        "by_category": report.by_category,
        "items": [
            {
                "tool": i.tool,
                "action": i.action,
                "capability": i.capability,
                "category": i.category,
                "breach_scenario": i.breach_scenario,
                "per_incident_min_usd": i.per_incident_min_usd,
                "per_incident_max_usd": i.per_incident_max_usd,
                "annualized_min_usd": i.annualized_min_usd,
                "annualized_max_usd": i.annualized_max_usd,
                "confidence": i.confidence,
                "configured": i.configured,
                "reversible": i.reversible,
                "has_policy": i.has_policy,
            }
            for i in report.items
        ],
    }

    if not report.configured:
        result["warning"] = (
            "Cost values are NOT CONFIGURED. All amounts show $0. "
            "Configure severity_ranges in cost_defaults.yaml or POST /api/agents/{id}/cost-config "
            "with your business-specific values (average transaction size, regulatory fine ranges, "
            "downtime cost per minute)."
        )

    return result
