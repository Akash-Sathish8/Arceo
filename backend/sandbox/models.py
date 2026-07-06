"""Data models for the sandbox simulation platform."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class TraceStep:
    """A single tool call in a simulation trace."""
    step_index: int
    tool: str
    action: str
    params: dict
    enforce_decision: str  # ALLOW, BLOCK, REQUIRE_APPROVAL
    enforce_policy: dict | None  # matched policy, if any
    result: dict | None  # None if blocked
    error: str | None = None
    timestamp: str = ""
    source_agent_id: str = ""   # which agent initiated this step
    dispatch_to: str = ""       # if this step triggered another agent

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.utcnow().isoformat()


@dataclass
class SimulationTrace:
    """Full trace of a simulation run."""
    simulation_id: str
    agent_id: str
    agent_name: str
    scenario_id: str
    scenario_name: str
    prompt: str
    steps: list[TraceStep] = field(default_factory=list)
    messages: list[dict] = field(default_factory=list)  # full LLM conversation
    turn_usage: list[TurnUsage] = field(default_factory=list)  # real token usage per turn
    started_at: str = ""
    completed_at: str = ""
    status: str = "running"  # running, completed, error
    error: str | None = None

    def __post_init__(self):
        if not self.started_at:
            self.started_at = datetime.utcnow().isoformat()


@dataclass
class TurnUsage:
    """Real LLM token usage for one round-trip (turn) of a simulation run.
    Captured from the provider response so the cost forecaster's medium tier
    uses measured tokens + turns instead of the static estimate."""
    turn_index: int
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int


@dataclass
class MultiAgentTrace:
    """Wraps multiple agent traces in a single multi-agent simulation."""
    simulation_id: str
    coordinator_id: str
    agent_traces: dict[str, SimulationTrace] = field(default_factory=dict)
    unified_steps: list[TraceStep] = field(default_factory=list)  # all steps in order
    dispatches: list[dict] = field(default_factory=list)  # {from_agent, to_agent, task, step_index}
    started_at: str = ""
    completed_at: str = ""
    status: str = "running"
    error: str | None = None

    def __post_init__(self):
        if not self.started_at:
            self.started_at = datetime.utcnow().isoformat()


@dataclass
class Violation:
    """A flagged violation in a simulation trace."""
    type: str  # pii_exfil, unauthorized_refund, data_deletion, etc.
    severity: str  # critical, high, medium
    title: str
    description: str
    step_indices: list[int]  # which trace steps are involved
    risk_labels: list[str]


@dataclass
class ChainViolation:
    """A dangerous chain that was actually executed (not just possible)."""
    chain_id: str
    chain_name: str
    severity: str
    description: str
    step_indices: list[int]  # the trace steps that form the chain
    # For exfil/financial transitions: was actual data observed flowing between
    # the two steps? False means the chain was inferred from label proximity
    # only (and its severity has been downgraded accordingly).
    data_linked: bool = True


@dataclass
class DataFlow:
    """A confirmed data flow between two trace steps."""
    from_step: int
    to_step: int
    from_action: str  # e.g. "stripe.get_customer"
    to_action: str    # e.g. "email.send_email"
    data_type: str    # "pii", "financial", "general"
    matched_values: list[str]  # the actual values that flowed (redacted)
    severity: str     # "critical", "high", "medium"
    description: str


@dataclass
class VolumeViolation:
    """A volume/rate pattern violation."""
    action: str       # e.g. "stripe.create_refund"
    count: int        # how many times it fired
    risk_label: str   # which risk label this falls under
    severity: str     # "critical", "high", "medium"
    description: str
    step_indices: list[int]


@dataclass
class SimulationReport:
    """Analysis report for a completed simulation."""
    simulation_id: str
    agent_id: str
    scenario_id: str
    total_steps: int
    actions_executed: int
    actions_blocked: int
    actions_pending: int
    violations: list[Violation] = field(default_factory=list)
    chains_triggered: list[ChainViolation] = field(default_factory=list)
    data_flows: list[DataFlow] = field(default_factory=list)
    volume_violations: list[VolumeViolation] = field(default_factory=list)
    risk_summary: dict = field(default_factory=dict)
    risk_score: float = 0.0  # 0-100, how dangerous was this run
    recommendations: list = field(default_factory=list)  # list of Recommendation or str
    executive_summary: str = ""  # plain-English summary for leadership
    # Negative test assertion (only set when scenario.expected_block is True)
    policy_assertion_passed: bool | None = None  # None = no assertion defined
    policy_assertion_detail: str = ""
    # Detection grading vs scenario.expected_violations (precision/recall over
    # canonical risk labels). None when the scenario declares no expectations.
    detection_grade: dict | None = None


@dataclass
class PolicyRecommendation:
    """An actionable policy recommendation from simulation analysis."""
    message: str
    actionable: bool = False
    action_pattern: str = ""  # e.g. "stripe.create_refund"
    effect: str = ""  # BLOCK or REQUIRE_APPROVAL
    reason: str = ""


@dataclass
class SweepReport:
    """Aggregate report across all scenarios for one agent."""
    sweep_id: str
    agent_id: str
    agent_name: str
    total_scenarios: int
    completed: int
    failed: int

    # Aggregate across all scenarios
    total_steps: int = 0
    total_actions_executed: int = 0
    total_actions_blocked: int = 0
    total_actions_pending: int = 0

    # Deduplicated findings
    all_violations: list[Violation] = field(default_factory=list)
    all_chains: list[ChainViolation] = field(default_factory=list)
    all_data_flows: list[DataFlow] = field(default_factory=list)
    all_volume_violations: list[VolumeViolation] = field(default_factory=list)

    # Aggregate risk
    risk_scores: dict = field(default_factory=dict)  # scenario_id → risk_score
    max_risk_score: float = 0.0
    avg_risk_score: float = 0.0
    overall_risk_score: float = 0.0

    # Per-scenario breakdown
    scenario_results: list = field(default_factory=list)

    # Merged recommendations (deduplicated, sorted by severity)
    recommendations: list[PolicyRecommendation] = field(default_factory=list)

    # Executive summary
    executive_summary: str = ""

    started_at: str = ""
    completed_at: str = ""

    def __post_init__(self):
        if not self.started_at:
            self.started_at = datetime.utcnow().isoformat()


@dataclass
class Scenario:
    """A simulation scenario with a prompt and expected behavior."""
    id: str
    name: str
    description: str
    agent_type: str  # support, devops, sales, ops
    category: str  # normal, edge_case, adversarial, chain_exploit
    severity: str  # info, medium, high, critical
    prompt: str
    expected_violations: list[str] = field(default_factory=list)
    # Negative test assertion: if True, at least one action MUST be blocked.
    # Simulation analysis will FAIL if all actions are allowed.
    expected_block: bool = False
    # Positive test assertion: if True, NO actions should be blocked.
    # Simulation analysis will FAIL if any action is blocked (regression in over-blocking).
    expected_allow_all: bool = False
    # Services this scenario's prompt directs the agent to use. Sweeps skip
    # scenarios naming tools the agent doesn't have — running "refund pay_003
    # in Stripe" against a Stripe-less agent produces a one-turn refusal that
    # then feeds the cost forecast as a "measured" trace. Empty = any agent.
    required_tools: list[str] = field(default_factory=list)
