"""Parses arceo.yaml config file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class AgentConfig:
    name: str
    entry: str
    decorator: str = "arceo.monitor"


@dataclass
class PolicyConfig:
    max_blast_radius: float = 100.0
    block_chains: bool = False
    require_approval_for: list[str] = field(default_factory=list)


@dataclass
class ArceoConfig:
    agents: list[AgentConfig] = field(default_factory=list)
    policy: PolicyConfig = field(default_factory=PolicyConfig)
    arceo_url: str = "http://localhost:8000"
    api_key: str = ""


def load_config(path: str | Path = "arceo.yaml") -> ArceoConfig:
    """Load and parse arceo.yaml from the given path."""
    config_path = Path(path)

    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path) as f:
        raw = yaml.safe_load(f)

    if not raw:
        raise ValueError("Empty config file")

    agents = []
    for a in raw.get("agents", []):
        agents.append(AgentConfig(
            name=a["name"],
            entry=a.get("entry", ""),
            decorator=a.get("decorator", "arceo.monitor"),
        ))

    policy_raw = raw.get("policy", {})
    policy = PolicyConfig(
        max_blast_radius=float(policy_raw.get("max_blast_radius", 100)),
        block_chains=bool(policy_raw.get("block_chains", False)),
        require_approval_for=policy_raw.get("require_approval_for", []),
    )

    arceo_url = raw.get("arceo_url", os.getenv("ARCEO_URL", "http://localhost:8000"))
    api_key = raw.get("api_key", os.getenv("ARCEO_API_KEY", ""))

    return ArceoConfig(agents=agents, policy=policy, arceo_url=arceo_url, api_key=api_key)
