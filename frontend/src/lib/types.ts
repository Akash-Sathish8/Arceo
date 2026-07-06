export type RiskLabel =
  | "moves_money"
  | "touches_pii"
  | "deletes_data"
  | "sends_external"
  | "changes_production"
  | "changes_access"
  | "reads_secrets"
  | "evades_detection"
  | "bulk_export"
  | "executes_code";

export type Severity = "critical" | "high" | "medium" | "safe";

export type PolicyEffect = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";

export interface PolicyCondition {
  field: string;
  op: string;
  value: string | number | boolean;
}

export interface Policy {
  id: string;
  agent_id: string;
  action: string;
  effect: PolicyEffect;
  priority: number;
  condition?: PolicyCondition;
  created_at: string;
}

export interface Chain {
  from_label: RiskLabel;
  to_label: RiskLabel;
  rule_name: string;
  severity: "critical" | "high" | "medium";
  description: string;
}

export interface Tool {
  name: string;
  description: string;
  risk_labels: RiskLabel[];
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  agent_type: string;
  tools: Tool[];
  blast_radius_score: number;
  risk_labels: RiskLabel[];
  dangerous_chains: Chain[];
  policies: Policy[];
  created_at: string;
  updated_at: string;
  last_active: string | null;
}

export interface Violation {
  step: number;
  tool_name: string;
  policy_id: string;
  effect: PolicyEffect;
  reason: string;
}

export interface TraceStep {
  step: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  risk_labels: RiskLabel[];
  enforced: boolean;
  action_taken: "allowed" | "blocked" | "approval_required";
  timestamp: string;
}

export interface DataFlow {
  from_tool: string;
  to_tool: string;
  data_type: string;
  risk_labels: RiskLabel[];
}

export interface SimulationReport {
  violations: Violation[];
  chains_triggered: Chain[];
  data_flows: DataFlow[];
  executive_summary: string;
  risk_score: number;
  total_steps: number;
}

export interface SimulationRun {
  id: string;
  agent_id: string;
  scenario_id: string;
  scenario_name: string;
  status: string;
  created_at: string;
  report: SimulationReport;
}

export interface AuditEntry {
  id: string;
  agent_id: string;
  agent_name: string;
  action: string;
  risk_labels: RiskLabel[];
  result: string;
  timestamp: string;
}

export interface ApprovalItem {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  params: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  note: string | null;
}

export interface User {
  id: string;
  email: string;
  role: string;
}
