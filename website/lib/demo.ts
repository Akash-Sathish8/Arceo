/* The one set of demo figures the site shows. The product window and the
   OG image both read from here, so no two places can disagree.

   The arithmetic holds together:
   - Acme Support Copilot handles 820 tickets a day, so 24,600 runs a month.
   - Each run is 3 Sonnet turns plus 1 Haiku triage call plus 1 help-center search.
   - The cost rows sum to the $2,840 point forecast.
   - The HIGH tier band is ×0.85–×1.15, which gives $2,410–$3,270 (rounded to $10).

   Labels, bands and copy are the product's own (frontend/src/pages/*). */

export type Band = "Low" | "Medium" | "High" | "Critical";

/** The product's bands: Low <40, Medium 40–59, High 60–79, Critical ≥80. */
export function band(score: number): Band {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

export const AGENTS = [
  { name: "Incident Response Copilot", score: 81, tools: "AWS, PagerDuty, Slack", state: "Pre-deployment" },
  { name: "Acme Support Copilot", score: 62, tools: "Stripe, SendGrid, Zendesk", state: "Deployed" },
  { name: "Sales Outreach Agent", score: 44, tools: "HubSpot, Gmail", state: "Deployed" },
  { name: "Meeting Scheduler", score: 4, tools: "Calendly", state: "Deployed" },
] as const;

export const FLEET = {
  agents: 12,
  forecastPerMonth: "$9,460",
  criticalChains: 2,
  unguarded: 1,
};

export const CHAIN = {
  name: "Customer data sent outside",
  severity: "Critical",
  agent: "Acme Support Copilot",
  steps: [
    { action: "zendesk.get_ticket", label: "touches PII" },
    { action: "sendgrid.send_email", label: "sends external" },
  ],
  why: "Reads personal data, then sends it outside your org, so that data could leak.",
  fix: "Require approval on sendgrid.send_email",
};

/** Real wording from the prompt checker (backend/prompts/danger.py, show-secrets). */
export const PROMPT_WARNING = {
  title: "Asks your agent to show or share your passwords or keys",
  detail: "Your passwords and keys would end up written out in the chat, where they can be saved, shared or seen by others.",
};

export const FORECAST = {
  agent: "Acme Support Copilot",
  point: "$2,840",
  low: "$2,410",
  high: "$3,270",
  confidence: "HIGH",
  basis: "28,700 captured calls over 7 days",
  budget: "$3,500",
  rows: [
    { item: "Claude Sonnet 4.6 · draft reply", calls: "73,800", perCall: "$0.026", perMonth: "$1,919" },
    { item: "help_center.search", calls: "24,600", perCall: "$0.012", perMonth: "$295" },
    { item: "Claude Haiku 4.5 · triage", calls: "24,600", perCall: "$0.011", perMonth: "$271" },
    { item: "Hosting and logs", calls: "", perCall: "", perMonth: "$355" },
  ],
  inputs: [
    { name: "Tickets a day", value: "820", source: "measured" },
    { name: "Turns per ticket", value: "3", source: "measured" },
    { name: "Model", value: "Sonnet 4.6", source: "declared" },
  ],
};

/** Titles straight from the starter library (backend/prompts/seed/*.yaml). */
export const PROMPTS = [
  { title: "Catch someone up on a long email thread", category: "Email & messages", cost: "$0.010 each time" },
  { title: "Fix this error message", category: "Fix & debug", cost: "$0.021 each time" },
  { title: "Landing page for my idea", category: "Build something", cost: "$0.046 each time" },
  { title: "Make every page feel good on a phone", category: "Look & feel", cost: "$0.034 each time" },
];

export const PROMPT_COUNT = 319;

export const SEND_TO = ["Claude Code", "ChatGPT", "Cursor", "Lovable", "Replit"];
