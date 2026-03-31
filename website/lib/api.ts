// All calls go to /api/backend/... which Next.js proxies to the real backend.
// This avoids any CORS issues regardless of deployment domain.

const BASE = "/api/backend";

let _cachedToken: string | null = null;

async function getDemoToken(): Promise<string> {
  if (_cachedToken) return _cachedToken;
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@actiongate.io", password: "admin123" }),
  });
  if (!res.ok) throw new Error("Demo auth failed");
  const data = await res.json();
  _cachedToken = data.access_token as string;
  return _cachedToken;
}

export interface DemoAgent {
  id: string;
  name: string;
  blast_radius_score: number;
  risk_labels: string[];
  description?: string;
  tool_count?: number;
}

export interface DemoScenario {
  id: string;
  name: string;
  category: string;
  prompt: string;
}

export interface ScanViolation {
  type: string;
  severity: string;
  title: string;
  description?: string;
}

export interface ScanChain {
  pattern?: string;
  chain_type?: string;
  severity?: string;
  description?: string;
}

export interface ScanResult {
  simulation_id: string;
  risk_score: number;
  violations: ScanViolation[];
  chains: ScanChain[];
  actions_blocked: number;
  actions_executed: number;
}

export async function fetchDemoAgent(): Promise<{ agent: DemoAgent; token: string }> {
  const token = await getDemoToken();
  const res = await fetch(`${BASE}/authority/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to fetch agents");
  const data = await res.json();
  const agents: DemoAgent[] = data.agents ?? data ?? [];
  if (!agents.length) throw new Error("No agents found in demo account");
  return { agent: agents[0], token };
}

export async function fetchDemoScenario(token: string): Promise<DemoScenario> {
  const res = await fetch(`${BASE}/sandbox/scenarios`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to fetch scenarios");
  const data = await res.json();
  const scenarios: DemoScenario[] = data.scenarios ?? data ?? [];
  // Prefer adversarial for a more dramatic demo
  const adversarial = scenarios.filter((s) => s.category === "adversarial");
  return adversarial[0] ?? scenarios[0];
}

export async function runDemoScan(
  agentId: string,
  scenarioId: string,
  token: string
): Promise<ScanResult> {
  const simRes = await fetch(`${BASE}/sandbox/simulate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ agent_id: agentId, scenario_id: scenarioId, dry_run: true }),
  });
  if (!simRes.ok) throw new Error("Simulation failed");
  const simData = await simRes.json();

  const simId: string = simData.simulation_id ?? simData.id;
  if (!simId) {
    // Some responses return the full report inline
    return normalizeResult(simData);
  }

  const reportRes = await fetch(`${BASE}/sandbox/simulation/${simId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!reportRes.ok) throw new Error("Failed to fetch simulation report");
  const reportData = await reportRes.json();
  return normalizeResult({ ...reportData, simulation_id: simId });
}

function normalizeResult(data: Record<string, unknown>): ScanResult {
  const report = (data.report ?? data) as Record<string, unknown>;
  return {
    simulation_id: (data.simulation_id as string) ?? "",
    risk_score: (report.risk_score as number) ?? (data.risk_score as number) ?? 0,
    violations: (report.violations as ScanViolation[]) ?? (data.violations as ScanViolation[]) ?? [],
    chains:
      (report.chains_detected as ScanChain[]) ??
      (data.chains_detected as ScanChain[]) ??
      (data.chains as ScanChain[]) ??
      [],
    actions_blocked:
      (report.actions_blocked as number) ?? (data.actions_blocked as number) ?? 0,
    actions_executed:
      (report.actions_executed as number) ?? (data.actions_executed as number) ?? 0,
  };
}
