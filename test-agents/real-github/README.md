# Real-GitHub spend-test agents

These are **real public agent repos** used to test the Arceo spend forecaster on realistic,
production-shaped code — not hand-written fixtures. They span the full cost spectrum
(cheap notifiers → loop-heavy multi-agent orchestrators) so we can calibrate that the
forecaster scores benign single-tool agents near the floor and token-heavy critical agents
near the ceiling. No code is copied into this repo; each agent is scanned in-place.

## How to ingest

Each repo is ingested with the whole-repo GitHub extractor:

```
POST /api/authority/agents/extract-github
{ "url": "<repo url>", "branch": "<branch>" }
```

Use the exact `url` + `branch` pairs from `agents.json`. The extractor walks the public
GitHub tree and runs the Haiku code-extraction path per file (~5–8s/file), auto-classifying
risk labels and tools.

## Two test modes

- **`tools_overlap_mocks: true`** repos (all of them here) can additionally be **swept** in the
  sandbox (`POST /api/sandbox/sweep`) to generate **MEDIUM-tier traces** — their tools overlap
  Arceo's service mocks (slack, email/gmail, stripe, hubspot, aws, github, calendly), so the
  send/payment/deploy paths actually execute.
- Repos that don't overlap mocks would test **extraction + LOW-tier (static) forecast** only —
  blast-radius + cost from declared capabilities, no live trace. (Not applicable to the current
  set; every repo overlaps mocks.)

## Repos

| Repo | Role | Expected cost band | Danger |
|---|---|---|---|
| masseater/slack-webhook-mcp | Single-tool Slack notifier (send_slack_message) | cheap | low |
| egyptianego17/email-mcp-server | SMTP email sender (3 send tools) | cheap | low |
| piekstra/slack-mcp-server | Broad Slack server (~20 read/write tools) | cheap | low |
| openai/openai-cookbook | Stripe dispute-resolution agent (Agents SDK) | normal | medium |
| anthropics/claude-cookbooks | Claude tool-use customer-support agent | normal | low |
| kaymen99/sales-outreach-automation-langgraph | LangGraph sales outreach (CRM + Gmail) | normal | medium |
| openai/openai-cs-agents-demo | 6-agent airline support orchestrator | expensive | high |
| kaymen99/personal-ai-assistant | Hierarchical assistant (manager + 5 sub-agents) | expensive | high |
| agenticsorg/devops | Autonomous DevOps/SRE over AWS + GitHub | expensive | critical |
