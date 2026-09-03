/**
 * Data shaping + jargon translation for the CFO PDF export.
 *
 * Everything here runs on data already fetched from the backend:
 *   GET /api/agents/{id}/spend-forecast  (forecast point + range + composition)
 *   GET /api/agents/{id}/cost-report     (breach_scenario items — names only)
 *
 * The dollarized worst-case exposure this file used to shape was retired on
 * 2026-08-09 (see `pickWorstCase`'s removal): the per-incident figures were not
 * trustworthy enough to put in front of a CFO. The cost-report is still read,
 * but only for the *name* of the riskiest unguarded action, which drives
 * recommendation #1 and does not depend on the dollar being right.
 *
 * Output (CFOReportData) is the only shape the PDF component reads.
 * If a CFO can't parse a string, it does not belong in this file.
 */

import type { MockSpend } from "@/lib/mockSpend"

// ── Backend response shapes (kept local — no other consumers) ───────────────

export interface CostReportItem {
  tool: string
  action: string
  capability: string
  category: string
  breach_scenario: string
  per_incident_min_usd: number
  per_incident_max_usd: number
  annualized_min_usd: number
  annualized_max_usd: number
  confidence: string
  configured: boolean
  reversible: boolean
  has_policy: boolean
}

export interface CostReportResponse {
  agent_id: string
  agent_name: string
  configured: boolean
  daily_runs: number
  total_risky_actions: number
  total_unprotected: number
  per_incident: { min_usd: number; max_usd: number }
  annualized: { min_usd: number; max_usd: number }
  items: CostReportItem[]
  assumptions?: string[]
  warning?: string
}

// ── Output shape (what the PDF consumes) ────────────────────────────────────

export interface CFOReportData {
  org: string
  agentDisplayName: string
  whatItDoes: string
  dateString: string

  // The number
  monthly: number
  monthlyLow: number
  monthlyHigh: number
  annual: number
  confidenceLine: string
  confidenceBadge: { label: string; tone: "low" | "medium" | "high" }

  // Where the money goes
  composition: { label: string; usd: number; pct: number }[]
  topDriverLabel: string
  topDriverMonthly: number
  topUnitCost: { label: string; value: string } | null

  // Recommendations
  recommendedActions: string[]

  // Footer
  reviewBudgetCap: number

  // Basis and limitations — the provenance the screen already renders
  // (coverage banner, source badges, last-calibrated) must survive into the
  // one artifact that leaves the building.
  isDemo: boolean
  basis: {
    lastCalibrated: string | null
    pricedModelLine: string | null
    toolsPricedLine: string | null
    observedDaysLine: string
    inputProvenance: { label: string; source: string }[]
  }
}

// ── Friendly tool names ─────────────────────────────────────────────────────
// Mapping tool keys (what the extractor produces) to CFO-readable phrases.

const TOOL_FRIENDLY: Record<string, string> = {
  stripe: "Refund and payment processing (Stripe)",
  sendgrid: "Email delivery (SendGrid)",
  twilio: "SMS messaging (Twilio)",
  zendesk: "Customer support tickets (Zendesk)",
  salesforce: "CRM records (Salesforce)",
  hubspot: "CRM and marketing (HubSpot)",
  gmail: "Email (Gmail)",
  slack: "Team messaging (Slack)",
  pagerduty: "On-call alerting (PagerDuty)",
  github: "Code repository (GitHub)",
  aws_s3: "File storage (AWS S3)",
  aws_lambda: "Backend compute (AWS Lambda)",
  aws_ec2: "Cloud servers (AWS EC2)",
  aws_ecs: "Container hosting (AWS ECS)",
  aws_rds: "Database (AWS RDS)",
  calendly: "Meeting scheduling (Calendly)",
  clearbit: "Lead enrichment (Clearbit)",
  snowflake: "Data warehouse (Snowflake)",
  bigquery: "Data warehouse (BigQuery)",
  pinecone: "Vector search (Pinecone)",
  openai_embeddings: "AI embeddings (OpenAI)",
  browserbase: "Browser automation (Browserbase)",
}

function friendlyToolName(tool: string): string {
  const key = tool.toLowerCase()
  if (TOOL_FRIENDLY[key]) return TOOL_FRIENDLY[key]
  // Fallback: title-case the key, drop underscores.
  return key.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

// Friendly per-tool *role* — used in the "what does this agent do" line.
// Shorter and verb-first than the long names above.
const TOOL_ROLE: Record<string, string> = {
  stripe: "processes refunds and payments",
  sendgrid: "sends emails on your behalf",
  twilio: "sends SMS messages",
  zendesk: "updates support tickets",
  salesforce: "updates CRM records",
  hubspot: "manages contacts and deals",
  gmail: "sends emails",
  slack: "posts to team channels",
  pagerduty: "creates and updates on-call alerts",
  github: "modifies code and creates deployments",
  aws_s3: "stores and retrieves files",
  aws_lambda: "runs backend code",
  aws_ec2: "manages cloud servers",
  aws_ecs: "deploys containerized services",
  aws_rds: "manages databases",
  calendly: "books meetings",
  clearbit: "enriches lead data",
  snowflake: "queries the data warehouse",
  bigquery: "queries the data warehouse",
}

// ── "What it does" sentence ─────────────────────────────────────────────────

function buildWhatItDoes(tools: string[]): string {
  const uniqueTools = Array.from(new Set(tools.map(t => t.toLowerCase())))
  const roles = uniqueTools
    .map(t => TOOL_ROLE[t])
    .filter((r): r is string => Boolean(r))

  if (roles.length === 0) {
    return "An AI agent operating in your environment. See your engineering team for the full list of capabilities."
  }
  if (roles.length === 1) {
    return `An AI agent that ${roles[0]}.`
  }
  if (roles.length === 2) {
    return `An AI agent that ${roles[0]} and ${roles[1]}.`
  }
  // 3+ roles: "X, Y, and Z"
  const last = roles[roles.length - 1]
  const front = roles.slice(0, -1).join(", ")
  return `An AI agent that ${front}, and ${last}.`
}

// ── Confidence translation ──────────────────────────────────────────────────

// The HIGH criterion below mirrors the engine's real gate: 50 captured
// production calls in a trailing 7-day window spanning at least 3 distinct
// calendar days (spend_forecast.py LIVE_TRACE_MIN_CALLS /
// LIVE_TRACE_MIN_ACTIVE_DAYS). There is no elapsed-time requirement, so the
// copy must never promise one. Pinned by cfoReport.test.ts.
function buildConfidenceLine(tier: "low" | "medium" | "high"): string {
  switch (tier) {
    case "low":
      return "Low — based only on the agent's setup. No test runs yet. Tightens once we run simulations."
    case "medium":
      return "Moderate — based on simulated test conversations. Reaches high confidence once we capture 50+ production calls spanning 3+ distinct days in a week."
    case "high":
      return "High — based on 50+ captured production calls spanning 3+ distinct days in the last week."
  }
}

function confidenceBadge(tier: "low" | "medium" | "high"): { label: string; tone: "low" | "medium" | "high" } {
  return { label: tier === "low" ? "LOW" : tier === "medium" ? "MODERATE" : "HIGH", tone: tier }
}

// ── Basis and limitations ───────────────────────────────────────────────────

const INPUT_LABELS: Record<string, string> = {
  runsPerDay: "Daily volume",
  turnsPerRun: "Work per run",
  tokensPerCall: "AI usage per call",
  cacheHit: "Cache rate",
  model: "AI model",
  toolMix: "Tool mix",
}

const SOURCE_PLAIN: Record<string, string> = {
  declared: "assumed from your setup",
  measured: "measured from this agent's traffic",
  default: "industry default, not yet measured",
  volume: "counted within your declared volume",
}

function buildBasis(forecast: MockSpend): CFOReportData["basis"] {
  const cov = forecast.coverage

  let pricedModelLine: string | null = null
  if (cov?.declaredModel) {
    if (cov.modelMatch === "exact" || cov.modelMatch === "prefix") {
      pricedModelLine = `AI model priced as ${cov.pricedModel} (known rate).`
    } else if (cov.modelMatch === "family") {
      pricedModelLine = `AI model ${cov.declaredModel} is not in our price list; priced at ${cov.pricedModel} rates, an estimate from a related model. The real rate may differ.`
    } else {
      pricedModelLine = `AI model ${cov.declaredModel} is not in our price list; priced at placeholder ${cov.pricedModel} rates, an estimate that could be materially off.`
    }
  }

  const toolsPricedLine = cov && cov.toolsTotal > 0
    ? `${cov.toolsPriced} of ${cov.toolsTotal} tools have a known per-call price${cov.toolsPriced < cov.toolsTotal ? "; tool costs may be understated" : ""}.`
    : null

  const observedDaysLine = forecast.observedDays != null
    ? `Based on ${forecast.observedDays} day${forecast.observedDays === 1 ? "" : "s"} of observed live traffic.`
    : "No live production data yet: this forecast is built from the agent's setup and simulation runs."

  const inputProvenance = Object.entries(forecast.inputSources ?? {})
    .filter(([key, value]) => value != null && INPUT_LABELS[key])
    .map(([key, value]) => ({
      label: INPUT_LABELS[key],
      source: SOURCE_PLAIN[value as string] ?? String(value),
    }))

  return {
    lastCalibrated: forecast.lastCalibrated ?? null,
    pricedModelLine,
    toolsPricedLine,
    observedDaysLine,
    inputProvenance,
  }
}

// ── Composition (already in $ + %, just relabel) ────────────────────────────

function buildComposition(forecast: MockSpend): { label: string; usd: number; pct: number }[] {
  return [
    { label: "AI model usage",  usd: forecast.tokensUsd, pct: forecast.tokensPct },
    { label: "Software fees",   usd: forecast.toolsUsd,  pct: forecast.toolsPct },
    { label: "Infrastructure",  usd: forecast.infraUsd,  pct: forecast.infraPct },
  ]
}

function buildTopDriver(forecast: MockSpend): { label: string; monthly: number } {
  const top = forecast.topTools?.[0]
  if (!top) return { label: "—", monthly: 0 }
  // top.tool is shaped as "toolname.action_name"
  const toolKey = top.tool.split(".")[0]
  return { label: friendlyToolName(toolKey), monthly: top.monthly }
}

// ── Breach scenario phrasing ────────────────────────────────────────────────

// CFO surfaces must not use jargon — translate the risk engine's terms into
// plain scenario language before they reach a screen or a PDF.
const JARGON_PLAIN: Array<[RegExp, string]> = [
  [/\bPII\b/g, "private customer details"],
  [/\bblast radius\b/gi, "potential damage"],
  [/\bexfiltrat(ed|ion|e)\b/gi, "leaked"],
  [/\bprod(uction)? environment\b/gi, "live systems"],
]

function rephraseBreachScenario(item: CostReportItem): string {
  // The breach_scenario field is already plain-ish English from cost_model.py,
  // but we re-anchor it on user-visible language. The tool name in particular
  // can be a key like "stripe" — replace with a friendlier phrase inline.
  const toolKey = (item.tool || "").toLowerCase()
  const friendly = TOOL_FRIENDLY[toolKey]
  let scenario = item.breach_scenario || "An unmitigated risk in this agent's actions."
  for (const [pattern, plain] of JARGON_PLAIN) scenario = scenario.replace(pattern, plain)
  if (friendly && !scenario.toLowerCase().includes(friendly.toLowerCase().split(" ")[0].toLowerCase())) {
    // Append context so the CFO knows which system. e.g. "(via Refund processing — Stripe)"
    return `${scenario} (via ${friendly}).`
  }
  return scenario.endsWith(".") ? scenario : `${scenario}.`
}

// ── Recommendations ─────────────────────────────────────────────────────────

function generateRecommendations(
  forecast: MockSpend,
  costReport: CostReportResponse | null,
  budgetCap: number,
): string[] {
  const recs: string[] = []

  // 1. Top unmitigated risk → add a rule. Ranked by per-incident $ purely to
  // order the list; the figure itself is never published (retired 2026-08-09).
  const items = costReport?.items ?? []
  const unmitigated = [...items]
    .filter(i => !i.has_policy)
    .sort((a, b) => b.per_incident_max_usd - a.per_incident_max_usd)
  if (unmitigated[0]) {
    const scenario = rephraseBreachScenario(unmitigated[0]).replace(/\.$/, "")
    recs.push(`Add a rule preventing: ${scenario}. Estimated effort: ~10 minutes on our side.`)
  }

  // 2. Spend cap = forecast point + ~35% safety margin, rounded to nearest $100.
  // TWO mechanisms at TWO thresholds — do not merge them into one sentence again.
  // This previously read "the agent will pause and notify if it approaches this
  // limit", which was true of neither:
  //   · Enforcement is a 429 rejection at 100% of the cap (`_budget_gate`,
  //     main.py:3569-3572), not a pause on approach, and it only exists once an
  //     `agent_budgets` row does (`_budget_caps`, :3592-3593) — hence "Once set".
  //   · The Slack warning fires at `alert_threshold_pct` (80% default) and returns
  //     silently when no webhook is configured (:3460-3461) — hence "Connect Slack",
  //     stated as a condition rather than a promise.
  recs.push(
    `Cap monthly spend at $${budgetCap.toLocaleString()} (forecast plus a safety margin that covers the upper end of our confidence range). Once set, Arceo stops the agent's paid model calls when it reaches the cap. Connect Slack and it will warn you earlier — at 80% by default.`,
  )

  // 3. Re-review with live data — only relevant while confidence is below high.
  if (forecast.confidence !== "high") {
    recs.push("Re-review in 30 days once live production data is available. The cost estimate will tighten meaningfully with real usage.")
  }

  return recs
}

// ── Public entry point ──────────────────────────────────────────────────────

export function buildCFOReportData(args: {
  orgName: string
  agentDisplayName: string
  toolKeys: string[]
  forecast: MockSpend
  costReport: CostReportResponse | null
  today?: Date
}): CFOReportData {
  const { orgName, agentDisplayName, toolKeys, forecast, costReport } = args
  const today = args.today ?? new Date()
  const dateString = today.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })

  const composition = buildComposition(forecast)
  const topDriver = buildTopDriver(forecast)

  // Round budget cap to nearest $100, with at least 30% margin over the point estimate.
  const budgetCap = Math.max(100, Math.round((forecast.point * 1.35) / 100) * 100)

  return {
    org: orgName,
    agentDisplayName,
    whatItDoes: buildWhatItDoes(toolKeys),
    dateString,

    monthly: forecast.point,
    monthlyLow: forecast.low,
    monthlyHigh: forecast.high,
    annual: forecast.annual,
    confidenceLine: buildConfidenceLine(forecast.confidence),
    confidenceBadge: confidenceBadge(forecast.confidence),

    composition,
    topDriverLabel: topDriver.label,
    topDriverMonthly: topDriver.monthly,
    // Only surface a unit cost the forecaster actually measured — never a
    // null/"not measured" placeholder in a CFO-facing PDF.
    topUnitCost: (() => {
      const u = forecast.unitEcon?.find((x) => x.value != null)
      return u && u.value != null ? { label: u.label, value: u.value } : null
    })(),

    recommendedActions: generateRecommendations(forecast, costReport, budgetCap),
    reviewBudgetCap: budgetCap,

    isDemo: forecast.isDemo ?? false,
    basis: buildBasis(forecast),
  }
}
