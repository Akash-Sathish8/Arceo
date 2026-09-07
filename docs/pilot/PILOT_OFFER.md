# The Arceo pilot — what you get, what we ask for

**A free, time-boxed pilot for teams running AI agents in or near production.** This document is
the whole offer. If something is not written here, it is not promised.

Companion documents: `CONFIDENCE_AND_LIMITS.md` (what our numbers mean and where they stop),
`ONBOARDING.md` (how to connect an agent), `../DATA_RETENTION.md` (what we store and how it goes away).

---

## What Arceo does

**Arceo tells you how much your AI agent will cost — and what could go wrong with it — before you
put it in production.**

Two answers in one report a finance team can read:

- **Cost.** A monthly spend forecast with an honest confidence range, broken down by model tokens,
  tool API charges, and compute. Per agent and across your fleet. Exportable as a PDF.
- **Risk.** Every action your agent can take, scored for blast radius, with the dangerous *chains*
  flagged — sequences that are only dangerous in combination, like "read customer records → send
  external email." Plus enforceable policies that block or require approval at runtime.

---

## What you get

1. **A hosted Arceo workspace**, run by us. No infrastructure on your side.
2. **Onboarding for up to 5 agents**, by whichever of the five connect paths fits — repo scan,
   code upload, GitHub Action, MCP, or routing through Arceo. See `ONBOARDING.md`.
3. **A cost forecast per agent and for the fleet**, with the confidence band stated plainly and a
   CFO-readable PDF export.
4. **A blast-radius and risk-chain report** per agent, with recommended approval policies.
5. **Policy enforcement** if you want it — block or require approval on specific actions, at
   runtime, through the proxy or the SDK.
6. **A pull-request scan** via the GitHub Action, so a risky change is caught before it merges.
7. **Direct access to the people building it.** See the support section below.
8. **Your negotiated model rates honoured** in the forecast, if you have them.

## What it costs

**Nothing.** The pilot is free and there is no payment path in the product during it. Pricing is not
settled and we are not going to invent a number to put in front of you.

## What we ask for in return

Three things, and they are the reason the pilot is free:

1. **A weekly 30-minute check-in** for the duration. Not a status meeting. One question:
   *"What did Arceo tell you this week that you didn't already know, and what did it get wrong?"*
2. **Permission to use you as a reference** — a named logo and a short quote — **if** the pilot goes
   well. If it doesn't, we would rather have the feedback than the logo, and you owe us nothing.
3. **Honest reports of what broke.** We are pre-v1. Finding the sharp edges is the point.

## Duration

**Eight weeks from go-live**, with the end date set in writing when we start. At the end: either we
have a conversation about continuing, or we shut the workspace down and delete your data on request
(`../DATA_RETENTION.md` describes exactly what that removes and what survives).

No auto-renewal, no notice period, no obligation to continue.

---

## Support and response expectations

> ⚠️ **DECISION NEEDED FROM REZA before this goes to a customer.** The recommendation below is a
> default, not a settled choice. Delete this block once confirmed.

**Recommended: a shared Slack Connect channel, with email as the fallback.**

The reasoning: the single most valuable output of this pilot is not the customer's summary opinion
at week eight — it is *which surface they hit first and what it told them*. People report friction
in a Slack channel that they would never write an email about. An email alias would lose most of
that signal, which is the thing we are actually buying with a free pilot.

| | Channel | Response |
|---|---|---|
| **Anything blocking** | Shared Slack Connect channel | Same business day |
| **Everything else** | Same channel | Next business day |
| **If Slack isn't possible** | A named email address | Next business day |
| **Weekly** | 30-minute call | Scheduled at kickoff |

**Business days are US hours.** We are a small team and we would rather commit to next-business-day
and hit it than promise an hour and miss.

**What we do not offer during the pilot:** a 24/7 on-call rotation, a contractual SLA, or a
guaranteed uptime figure. If you need those written down, that is a conversation for a paid
contract, not a free pilot.

---

## What is explicitly not in the pilot

So there is no gap between what you expect and what arrives:

- **No SOC 2 report.** We do not have one. It is on the roadmap and it is not done. If your
  procurement process requires it before any data moves, tell us now and we will scope the pilot to
  non-sensitive agents or wait for you.
- **No data-quality or hallucination monitoring.** Explicit non-goal — see `CONFIDENCE_AND_LIMITS.md`.
- **No self-service organisation deletion.** Workspace closure is a manual operation we perform on
  request, same day.
- **No paid tier to upgrade into yet.** Pricing is unsettled.

---

## How we will know it worked

Agreed at kickoff, measured at week eight:

1. **Every agent you care about is onboarded and forecast**, with the confidence tier we predicted
   at qualification.
2. **The forecast was checked against a real bill at least once**, and we can explain any gap.
3. **At least one risk finding changed something** — a policy added, a permission removed, a chain
   broken, or a deliberate documented decision to accept it.
4. **You can answer the budget question for your agents** to whoever was asking it before Arceo.

If (4) is still "no" at week eight, the pilot did not work, and we would like to know why more than
we would like a testimonial.
