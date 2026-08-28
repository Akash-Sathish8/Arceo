/**
 * The confidence gate, named once.
 *
 * Every surface that explains why a forecast band is as wide as it is — the
 * Cost Portfolio, the Spend Dashboard, and both CFO PDFs — has to describe the
 * same rule. They used to describe it four different ways, and three of those
 * were wrong.
 *
 * ## The rule, as the engine actually implements it
 *
 * `analysis/spend_forecast.py` promotes an agent to HIGH confidence when it has
 * `LIVE_TRACE_MIN_CALLS` captured production calls inside a **trailing 7-day
 * window**, spanning at least `LIVE_TRACE_MIN_ACTIVE_DAYS` distinct calendar
 * days. The window is rolling: calls older than 7 days fall out of it.
 *
 * ## Why that matters to the copy (item 1.13)
 *
 * Because nothing accumulates, the gate is a **RATE, not a total**. An agent
 * running below roughly {@link HIGH_GATE_MONTHLY_EQUIV} calls a month never
 * reaches HIGH, however many months it runs. Four surfaces told the customer
 * the opposite — "it narrows as evidence accumulates", "accumulate 30+ days of
 * live data", "it tightens as agents accumulate live production data" — which
 * is not a rounding error in the copy. It is advice to wait for something that
 * will not happen.
 *
 * The 2026-08-28 decision on 1.13 was to KEEP the cap and say so plainly. This
 * module exists so that saying so is a single edit rather than four, and so the
 * monthly figure can never disagree with the gate it is derived from.
 *
 * ⚠️ These constants mirror the backend. They are not the source of truth —
 * `spend_forecast.py` is. If the gate moves there, move it here.
 */

/** `LIVE_TRACE_MIN_CALLS` — captured production calls required for HIGH. */
export const HIGH_GATE_CALLS = 50

/** `LIVE_TRACE_MIN_ACTIVE_DAYS` — distinct calendar days those calls must span. */
export const HIGH_GATE_DAYS = 3

/** The trailing window the calls must land inside. Rolling, so nothing banks. */
export const HIGH_GATE_WINDOW_DAYS = 7

/**
 * The gate restated as a monthly call volume, rounded to something a CFO can
 * hold in their head.
 *
 * "50 calls in a rolling week" is not a number anyone can check against their
 * own agent. "About 215 a month" is — it is the number that decides whether
 * this agent can ever leave its current band, and it is the qualification bar
 * for a beta customer (plan item 4.2).
 *
 * Derived, never typed by hand, so it cannot drift from the gate above.
 */
export const HIGH_GATE_MONTHLY_EQUIV =
  Math.round((HIGH_GATE_CALLS / HIGH_GATE_WINDOW_DAYS) * 30 / 5) * 5

/**
 * The one sentence every surface owes the reader: the gate is a rate, so an
 * agent below it stays where it is. Plain enough for the CFO PDF, which leaves
 * the building with no engineer attached to it.
 */
export const HIGH_GATE_IS_A_RATE =
  `That is a rate, not a total, so it does not arrive by waiting — roughly ` +
  `${HIGH_GATE_MONTHLY_EQUIV} calls a month. An agent that runs below that ` +
  `rate stays at its current band however long it runs.`

/** The gate itself, stated once, for surfaces that need the mechanics. */
export const HIGH_GATE_SENTENCE =
  `High confidence needs ${HIGH_GATE_CALLS}+ captured production calls in any ` +
  `rolling ${HIGH_GATE_WINDOW_DAYS} days, spanning ${HIGH_GATE_DAYS}+ distinct days.`
