/**
 * Methodology disclosures for the 0-100 scores Arceo surfaces in the UI.
 * Used inside <Tooltip content={…} /> on score rings, stat tiles, and
 * filter chips so the numbers can be defended in a procurement review.
 */

export const RISK_SCORE_METHODOLOGY = `Sums each action's weight (PII 8, money 12, deletes-data 15, sends-external 7, changes-prod 12). Irreversible actions count 2×; read-only actions 0.15×. Dangerous chains add up to +12. Normalized to 0-100 with a small density bonus for agents whose actions are mostly dangerous. Critical = 80+, High = 60-79, Medium = 40-59, Low = below 40.`

export const SIM_RISK_METHODOLOGY = `Sim risk scores a single simulated run 0-100 on the same bands as blast radius (Critical 80+, High 60-79, Medium 40-59, Low <40) — but measured from what the agent actually did in that run, not from its static capability ceiling.`

export const OVER_PERMISSION_METHODOLOGY = `Counts excess permissions Arceo recommends restricting plus chains that need approval gates between agents. Higher = more changes recommended. 0 means the workflow's permissions are tight for the task it does.`

export const RISK_CHAIN_GLOSSARY = `A multi-step sequence that's only dangerous in combination — e.g. "read customer PII → send external email" is a data exfiltration path even though each step is innocuous alone.`

export const MCP_GLOSSARY = `Model Context Protocol — the standard agents use to discover and call tools. Arceo can connect directly to an MCP server and import every tool it exposes.`
