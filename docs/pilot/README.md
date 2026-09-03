# The pilot kit

**What a beta customer is actually promised, in writing.** Everything here is customer-facing —
written to be handed over without an engineer attached to explain it.

These live in the repo rather than in a slide deck on purpose: they state numbers the product
computes, and a document that states a number the code does not is the defect this whole product
exists to avoid. `test_pilot_kit.py` pins the ones that can drift.

| Document | What it is |
|---|---|
| **`PILOT_OFFER.md`** | Scope of the offer — what they get, what we ask for, duration, support, and what is explicitly not included. |
| **`CONFIDENCE_AND_LIMITS.md`** | The honesty contract. What the confidence tiers mean, why some agents can never reach HIGH, and what Arceo does not model. |
| **`ONBOARDING.md`** | The five connect paths, with the real limits of each. |
| **`../DATA_RETENTION.md`** | What we store, how long, and how it is deleted. **One document, two owners** — it is also Tier 3.2's deliverable. Do not write a second copy here. |

## Objection handling

Deliberately **not** in this directory. It is internal sales material, not something a customer
receives, and mixing the two is how an internal note ends up in a customer's inbox. It lives in the
brain at `Live/Tier 4.1 + 4.4(3) — pitch opening and objection handling — 2026-08-28.md`.

## Before sending any of this to a customer

1. **`PILOT_OFFER.md` has an unresolved decision block** on the support channel. Resolve it and
   delete the block.
2. Fill in the concrete dates — the offer says "eight weeks from go-live", which needs real dates
   at signature.
3. Re-read `CONFIDENCE_AND_LIMITS.md` against the current engine. The test pins the numbers, but it
   cannot pin the prose.
