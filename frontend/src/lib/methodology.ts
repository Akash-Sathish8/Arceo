/**
 * Methodology disclosures for the 0-100 scores Arceo surfaces in the UI.
 * Used inside <Tooltip content={…} /> on score rings, stat tiles, and
 * filter chips so the numbers can be defended in a procurement review.
 */

export const RISK_SCORE_METHODOLOGY = `Sums each action's weight (PII 3, money 8, deletes-data 10, sends-external 5, changes-prod 8). Irreversible actions count 1.5×; read-only actions 0.1×. Normalized to 0-100 with a small density bonus for agents whose actions are mostly dangerous. Critical = 70+, Warning = 40-69, Safe = below 40.`

export const OVER_PERMISSION_METHODOLOGY = `Counts excess permissions Arceo recommends restricting plus chains that need approval gates between agents. Higher = more changes recommended. 0 means the workflow's permissions are tight for the task it does.`

export const RISK_CHAIN_GLOSSARY = `A multi-step sequence that's only dangerous in combination — e.g. "read customer PII → send external email" is a data exfiltration path even though each step is innocuous alone.`

export const MCP_GLOSSARY = `Model Context Protocol — the standard agents use to discover and call tools. Arceo can connect directly to an MCP server and import every tool it exposes.`
