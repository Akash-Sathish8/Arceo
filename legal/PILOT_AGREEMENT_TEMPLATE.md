# Arceo Design-Partner Pilot Agreement — TEMPLATE

> ⚠️ **NOT A BINDING CONTRACT AND NOT LEGAL ADVICE.** This is an internal
> starting-point template to speed up a $15K design-partner pilot. It has **not**
> been reviewed by counsel. Do not send it to a customer or sign it until a
> lawyer has reviewed and adapted it to your entity, jurisdiction, and the
> specific deal. Bracketed `[...]` fields are placeholders to fill in.

---

**This Pilot Agreement** ("Agreement") is entered into as of `[EFFECTIVE DATE]`
between `[ARCEO LEGAL ENTITY NAME]` ("Arceo") and `[CUSTOMER LEGAL ENTITY NAME]`
("Customer").

## 1. Purpose

Customer wishes to evaluate Arceo's cost-and-risk governance software (the
"Software") for AI agents during a time-limited pilot, deployed in Customer's
own environment (VPC / self-hosted).

## 2. Pilot scope & term

- **Term:** `[e.g., 60 days]` from the Effective Date, unless extended in writing.
- **Fee:** `[$15,000]`, `[due within 30 days of the Effective Date]`.
- **Deployment:** Customer runs the Software in Customer's infrastructure per the
  deployment docs (`docker-compose.pilot.yml` — app + PostgreSQL + Redis). Arceo
  will provide reasonable installation support.
- **Scope:** up to `[N]` agents and `[N]` users.

## 3. License grant (pilot)

Subject to this Agreement, Arceo grants Customer a limited, non-exclusive,
non-transferable, non-sublicensable license to install and use the Software
solely for Customer's internal evaluation during the Term. All other rights are
reserved (see `LICENSE`).

## 4. Data & privacy

- Customer controls its own data; the Software runs in Customer's environment.
- Arceo does not receive Customer's production data except telemetry Customer
  explicitly chooses to share.
- The Software calls the Anthropic API for classification/forecasting using
  Customer's own API key; Customer's use of that API is governed by Customer's
  agreement with Anthropic.
- `[Attach or reference a DPA where personal data is processed.]`

## 5. Confidentiality

Each party will protect the other's Confidential Information (including the
Software, its risk models, and Customer's data) with the same care it uses for
its own, and not disclose it to third parties, for `[3]` years.

## 6. Intellectual property

The Software and all improvements remain Arceo's exclusive property. Feedback
Customer provides may be used by Arceo without restriction.

## 7. Warranties & disclaimer

The Software is provided **"AS IS"** for the pilot, without warranties of any
kind. `[Consider a limited "will perform materially as documented" warranty for
production contracts — not typical for a free/low-cost pilot.]`

## 8. Limitation of liability

Each party's aggregate liability is capped at the fees paid under this Agreement.
Neither party is liable for indirect, incidental, or consequential damages.
`[Carve-outs: confidentiality breach, IP infringement, indemnity — per counsel.]`

## 9. Conversion

The parties may negotiate a production subscription before the Term ends.
`[Optionally: pilot fee credited toward year-1 subscription.]`

## 10. Termination

Either party may terminate for material breach uncured after `[15]` days' notice.
On termination, Customer stops using and deletes the Software.

## 11. General

Governing law: `[STATE/COUNTRY]`. This Agreement is the entire agreement on the
pilot and supersedes prior discussions.

---

**Arceo:** `[NAME / TITLE / SIGNATURE / DATE]`

**Customer:** `[NAME / TITLE / SIGNATURE / DATE]`
