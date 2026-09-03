# What our numbers mean, and what they don't

**The honesty contract.** Arceo's whole claim is that a forecast you can check is worth more than
a forecast that sounds confident. This document is where we state the limits of our own numbers
before you find them.

Written to be read by a CFO with no engineer attached. Companion documents:
`../DATA_RETENTION.md` (what we store and how it goes away), `ONBOARDING.md` (how to connect an
agent), `PILOT_OFFER.md` (what the pilot is).

---

## The one number to understand: the confidence tier

Every forecast Arceo produces carries a **confidence tier**, and the tier decides how wide the
range is. The range is not measured run-to-run variance. **It is a statement about how much
evidence sits behind the number.**

| Tier | What it's based on | Range | Spread |
|---|---|---|---|
| **Low** | Your agent's code and declared capabilities only. No runs. | ×0.50 – ×3.00 | 6× |
| **Moderate** | Sandbox simulations. We ran your agent against test conversations. | ×0.70 – ×2.00 | 2.9× |
| **High** | Captured production calls. Real traffic, real token counts. | ×0.85 – ×1.15 | 1.35× |

So a Moderate-confidence forecast of $1,000/month means **"somewhere between $700 and $2,000, and
we are telling you that honestly rather than quoting you $1,000."**

**The bands are deliberately asymmetric**, and that is not a rounding artefact. They were
calibrated against a hand-checked fleet in July 2026: capability-only estimates skew *under* the
truth, because a static read cannot see a skewed tool mix, a loop that runs longer than declared,
or context beyond the declared bucket. A symmetric band covered 4 of 8 agents; `[0.50, 3.00]`
covered 8 of 8. We would rather show you a wide honest band than a narrow flattering one.

---

## ⚠️ High confidence is a rate, not a milestone — and some agents can never reach it

**This is the limit most likely to matter to you, so it is first.**

High confidence requires **50 captured production calls within any rolling 7-day window, spanning
at least 3 distinct days.** Restated as a number you can check against your own agent:
**roughly 215 LLM calls a month, sustained.**

The window **rolls**. Calls older than seven days fall out of it. Nothing accumulates.

The consequence is blunt, and we would rather say it than let you discover it:

> **An agent that runs below roughly 215 calls a month will never reach high confidence, no matter
> how many months it runs.** It is not "not yet." It is "not on this traffic volume."

If your agent runs at 20 calls a month, it will sit at Moderate — a ±30%-ish band — permanently.
That is still a real, useful forecast. It is simply not the ±15% number, and no amount of patience
converts one into the other.

**Why we designed it this way, rather than letting the number drift down over time:** a quiet month
is genuinely weaker evidence about next month than a busy week is. An agent that made 200 calls
spread thinly over 60 days has told us less about its steady-state behaviour than one that made 200
calls in six days. Averaging the quiet agent to a tight band would produce a confident-looking
number backed by very little, which is the failure mode this entire product exists to avoid.

**What this means for the pilot:** if your agent is below the rate, say so up front and we will
scope the pilot around the Moderate band rather than promising you ±15%.

---

## What Arceo does not model

Stated plainly, because every one of these has been asked in a real conversation.

**We do not judge whether your agent is *right*.** Arceo governs what an agent is allowed to do and
what it will cost — not whether the data it reasons over is true. If your agent confidently returns
a wrong answer from bad input, Arceo will not catch that, and we are not going to claim otherwise.
What we do instead is bound what a wrong answer can *cost* you: which irreversible actions it can
reach, which chains of them we will block before deployment, and what the bill looks like. Data
quality decides how often your agent is wrong. We decide how much that costs when it happens.

**We do not quote a worst-case dollar figure for a security incident.** We used to. We removed it
in August 2026 because the per-incident numbers were not defensible, and a number we cannot defend
is worse than no number. You will see blast radius as a 0–100 score and named risk chains; you will
not see "this breach would cost you $X."

**We do not model volume discounts.** Committed-use tiers, enterprise commitments, and batch-API
discounts are not in the pricing engine. If you have a negotiated rate with your model vendor, enter
it in Settings → Cost overrides and we will forecast against your real rate — that path works
today and is the one to use. What we cannot yet do is model a graduated discount that kicks in at
a volume threshold.

**We do not roll dispatched sub-agent cost into an orchestrator's forecast.** If agent A dispatches
work to agent B, each is forecast separately. The fleet total is correct; the parent agent's own
number does not include its children.

**We do not forecast agents that have never run and have no sandbox results.** They appear as "needs
sandbox runs" rather than being extrapolated. The fleet total reports only what is calibrated — it
does not estimate over the gaps.

---

## Where our prices come from

Every model price in the catalog carries the vendor page it was read from and the date it was
verified. We do not infer a missing price from a similar model: we tried that once, and both
checkable guesses were wrong — one by more than 2×. If your model is not in the catalog, we add the
row from the vendor's own page before we forecast you, rather than approximating.

A weekly automated audit flags rows that have gone stale. Prices move; a forecast built on a price
from six months ago is a different kind of wrong from a forecast built on a bad model, and we track
them separately.

**If your agent uses a model we have not priced,** tell us before the pilot starts. Adding a row is
a small task. Forecasting you against a prefix-matched neighbour would be a wrong number wearing a
right number's badge.

---

## What the forecast is actually built from

So you can audit it rather than trust it:

- **Token counts** come from your agent's real captured calls (High), from sandbox runs (Moderate),
  or from the declared context bucket in your code (Low).
- **Volume** is calls per day on a **calendar-day** basis — quiet days are priced in rather than
  averaged away.
- **Cache reads** are priced separately from fresh input, because they are billed differently and
  cache-heavy agents are otherwise overstated.
- **Long-context surcharges** apply where your vendor charges them: several models bill roughly
  double above a token threshold, and we price the tier your prompt actually lands in.
- **Tool API costs** are per-call charges for the services your agent touches, from a catalog.
- **Infrastructure** is a fixed per-call overhead plus a runtime-proportional compute cost.

Every input on the Cost Portfolio carries a badge saying whether it was **declared** by you,
**measured** from real traffic, or **defaulted** by us. A defaulted input never reads as a
measurement.

---

## How to make the number better

In order of how much difference it makes:

1. **Connect production traces.** This is the single biggest gain and the only route to High
   confidence — subject to the rate above.
2. **Enter your negotiated model rates** if you have them (Settings → Cost overrides). List price
   for a customer with a contract is simply the wrong number.
3. **Tell us about tool services we haven't priced.** Unpriced tools are visible as gaps rather
   than guessed at, but a gap is still a gap.
4. **Run a sandbox sweep** if you have no production traffic yet. It moves Low → Moderate, which is
   a 6× band down to a 2.9× band.

**Time is not on this list, and that is deliberate.** See the rate discussion above.
