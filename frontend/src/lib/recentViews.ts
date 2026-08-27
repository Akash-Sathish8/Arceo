/**
 * Client-side "recently viewed" tracking for agents.
 *
 * Views are recorded per browser in localStorage (no backend table for this):
 * opening an agent's drawer on the Authority page or landing on its detail
 * page stamps `{ [agentId]: ISO timestamp }`. The Authority sort reads the
 * map to order "Recently Viewed". Agents never viewed have no entry and
 * sort last.
 */

const STORAGE_KEY = "agentViewedAt";

export type AgentViewTimes = Record<string, string>;

function read(): AgentViewTimes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AgentViewTimes) : {};
  } catch {
    // Corrupt JSON or storage blocked — treat as "nothing viewed yet".
    return {};
  }
}

export function recordAgentView(agentId: string): void {
  const next: AgentViewTimes = { ...read(), [agentId]: new Date().toISOString() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full/blocked — the sort just won't reflect this view.
  }
}

export function getAgentViewTimes(): AgentViewTimes {
  return read();
}
