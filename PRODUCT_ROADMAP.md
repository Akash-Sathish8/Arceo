---
name: product-roadmap
description: 24-week, 6-phase plan to a 10/10 engineering floor — fail-closed, Postgres + vault, tenancy, real approvals, streaming/RBAC, audit-grade logging
aliases: [Product direction]
metadata:
  type: project
---

# Arceo — Product Roadmap: Path to a 10/10 Engineering Piece

> **Goal:** In 24 weeks, take Arceo (ActionGate) from a strong prototype to a genuinely
> 10/10-*engineered* system — correct, secure, fail-closed, production-grade, tested, and
> honest (no dead code, no claim the code can't back).
>
> **Team:** Founder + 2 engineers (strong mid-to-senior full-stack).
> **Stack:** Python/FastAPI backend · React/TS frontend · (migrating SQLite → Postgres) · Python SDK.

---

## Capacity reality (read this first)

- 2 engineers × 24 weeks ≈ **48 raw engineer-weeks**, but ~**40 net** after code review, test↔fix
  ping-pong, and infra ops.
- Total scoped debt is **~71 raw eng-weeks (~95–110 with risk multipliers).**
- So 24 weeks delivers a genuine **10/10 engineering floor** — everything correct, secure, and
  honest. **Two research-grade items (real customer-code sandboxing, generic data-flow chain
  analysis) do not fit** and are placed explicitly *beyond week 24*. This plan does not pretend
  otherwise.

---

## What "10/10 engineering" means here (the rubric)

| Dimension | The bar |
|---|---|
| **Correctness** | Does exactly what it claims; no theater, no dead endpoints; fail-*closed* everywhere |
| **Security** | No unauth write paths; per-query tenant isolation; encryption at rest; RBAC enforced; secrets vaulted; no fail-open |
| **Architecture** | Postgres hot path; durable multi-worker state; streaming-correct proxy; credential custody |
| **Reliability** | No dropped audit rows; idempotent replay; break-glass/health story |
| **Testability** | Adversarial bypass + cross-tenant + RBAC + enforcement suites gating CI |
| **Maintainability** | Alembic migrations (not ad-hoc PRAGMA hacks); typed; documented |
| **Honesty** | Every UI number backed by real computation |

---

## Team structure

Two parallel tracks, dependency-ordered:

- **Engineer A — Platform:** datastore migration, tenancy, shared state, encryption, test infra, SOC2 code pieces.
- **Engineer B — Enforcement & Product-correctness:** credential vault, proxy, approvals, decision semantics, risk-gate, honesty fixes.

Founder shields both from meetings and owns the two external dependencies flagged below.

---

## Phase 1 · Weeks 1–4 — Stop the theater + fail-closed semantics

**Goal:** the codebase stops lying and stops failing open. Cheapest, highest-trust wins first.

> **Execution specs (day 1, 2026-07-09):** [[Engineer A — Phase 1 spec]] · [[Engineer B — Phase 1 spec]] — verified against `dev@5b7c504`.

| Task | Owner | ew | Files |
|---|---|---|---|
| Enforcement decision defaults: opt-in DENY-by-default, unevaluable-BLOCK *fires*, `*`→BLOCK precedence, singular/plural action normalization | B | 1.5 | `enforcement.py:100-189,267-269`; `main.py:232-252` |
| Proxy + SDK fail-*closed*: wrap `enforce_check` → BLOCK on exception; flip `on_error` default allow→block; mandatory `X-API-Key`; `ARCEO_FAIL_MODE` | B | 1.0 | `main.py:373-449`; `sdk/arceo/_enforce.py:52-54` |
| Evidence-integrity: add `run_mode` column, exclude dry-runs from uplift, gate `data_linked`/"Demonstrated" behind live runs | B | 2.0 | `runner.py:501`; `graph.py:304`; `AgentDetail.tsx:253,2588` |
| Honesty quick-wins bundle: tier-confidence bug, budget "cap"→"alert" rename + stub column, render existing detection-grade, wire-or-delete dead SSE endpoint | A | 2.6 | `spend_forecast.py:288-300`; `CostPortfolio.tsx`; `SimulationDetail.tsx`; `main.py:3644-3723` |
| Security test baseline: extend `conftest.py` to seed 2 orgs, lock a pre-migration behavioral baseline | A | 1.0 | `backend/tests/` |

**Exit criteria:** No dry-run renders "Confirmed by simulation." SDK fails closed by default. No UI
says "cap" or "measured" when it isn't. Decision-default tests pass. Classifier eval fixtures
regenerated so CI is green. **Ship behind flags** — `default_effect=DENY` is opt-in per agent so
existing agents don't go dark.

**Locks:** Honesty + deterministic fail-closed semantics (partial).

---

## Phase 2 · Weeks 5–8 — Postgres migration + credential vault

**Goal:** production datastore; Arceo holds the credentials (the keystone primitive).

> **Delegation package (2026-07-09):** [[Phase 2 — delegation package]] — operator instructions + verbatim agent prompt, verified against `dev` post-Phase-1. Three PRs (`phase2/prep`, `phase2/postgres-cutover`, `phase2/credential-vault`), owner-reviewed, vault PR gated on the security-specialist sign-off.

| Task | Owner | ew | Files |
|---|---|---|---|
| SQLite→Postgres: SQLAlchemy/psycopg engine + pool; port `init_db` executescript → **Alembic** migrations; rewrite ~200 `?`→`%s` + `sqlite3.Row` sites; kill WAL/busy_timeout + audit-drop-on-lock hacks; data-copy + rollback script | A | 5.0 (→P3) | `db.py:44-304`; ~95 endpoints in `main.py`; `auth.py`; `enforcement.py` |
| Credential vault: `vault.py` envelope encryption (`cryptography`/KMS-wrapped DEK); `provider_credentials` table; `/api/credentials` CRUD (RBAC-gated); proxy egress **strips inbound key + injects vaulted secret** — Stripe + GitHub + one Bearer SaaS only | B | 3.5 | new `vault.py`; `db.py`; `main.py:214-215,426-449` |

**Exit criteria:** All queries run on Postgres in staging. **Integration test proves the agent's
own key is stripped and the vaulted secret injected** against a mock Stripe. Vault round-trips with
a documented rotation path. → **External dependency #1: a security specialist reviews the
envelope-encryption + key-management design before merge.**

**Locks:** Production datastore; credential custody (mandatory chokepoint — "no credential, no call").

> ⚠️ **Biggest trap of the whole plan:** do *not* keep SQLite and bolt on file-locking. Held
> approvals and audit writes cannot survive a restart or a 2nd worker on SQLite. This migration is
> load-bearing for Phases 3–4.

---

## Phase 3 · Weeks 9–12 — Per-query tenancy + close open endpoints + shared state

**Goal:** zero cross-tenant leaks; no unauthenticated writes; multi-worker-safe.

| Task | Owner | ew | Files |
|---|---|---|---|
| Finish PG migration tail | A | 1.5 | — |
| Per-query RLS: `SET LOCAL app.current_org` per request tied to the txn + reset on pool checkin; join-policies/backfill for FK-only tables (`agent_tools`, `tool_actions`, `test_data`); fix known leaks | A | 4.0 | `db.py:403-409`; `main.py:2757`; `ingestion/base.py:47-50` |
| Auth `/agents/register` + `/traces/live`; login/signup + enforce rate limiting via Redis sliding window | B | 2.0 | `main.py:1590,3957,866,926` |
| Shared store: move `_rate_limits`, `_live_traces`, `_ws_subscribers`, alert-dedup dicts to Redis; **pub/sub fan-out** so a trace on worker A reaches a WS subscriber on worker B | B | 2.0 | `main.py:68,78-88,2283,3926-3928` |

**Exit criteria:** Adversarial matrix — org-A token hitting **all 95 endpoints** with org-B ids —
returns **zero leaks**. No unauthenticated write path remains. Live traces + rate limits verified
behind 2 workers. → **External dependency #2: paid review of the RLS-with-pooling design** (silent
cross-tenant leak is invisible until a customer finds it). Register-auth ships with a migration
window + SDK docs (breaks zero-config self-register).

**Locks:** Enforced-per-query isolation; production multi-tenant infra; durable shared state.

---

## Phase 4 · Weeks 13–16 — Real approvals + durable held-request queue

**Goal:** the flagship human-in-the-loop workflow becomes real instead of fictional.

| Task | Owner | ew | Files |
|---|---|---|---|
| Params + full-request schema (one schema for log **and** replay, avoid double-migration); surface real params in Approvals UI (dead code already renders them); redact before store | B | 1.0 | `db.py:149-159,428-433`; `Approvals.tsx:207-226` |
| Real `REQUIRE_APPROVAL`: persist pending request → return 202 + poll URL; **replay-on-approve** through vaulted egress with **idempotency** (no double-charge); reject → block; SDK `enforce-and-wait` poll helper | B | 3.0 | `main.py:423-424,2883-2905`; `sdk/arceo/_enforce.py` |
| Durable multi-worker queue: `pending_requests` on Postgres with `SELECT … FOR UPDATE` atomic claim; non-blocking/batched audit writes so rows aren't dropped | A | 2.5 | new table; `enforcement.py:271` |
| Begin streaming/request-rewrite proxy | A | 2.0 (→P5) | `main.py:316-370,432-445` |

**Exit criteria:** Approve → replays the exact stored request **exactly once** (idempotency test);
reject → blocks. Approver sees real params. Two workers / two approvers cannot double-release. Held
state survives a restart.

**Locks:** Real, params-visible, tamper-evident approvals; reliability.

---

## Phase 5 · Weeks 17–20 — Streaming-correct proxy + encryption/PII + RBAC

**Goal:** proxy stops breaking real agents; data protected; roles actually enforced.

| Task | Owner | ew | Files |
|---|---|---|---|
| Finish streaming: `client.stream()` + `StreamingResponse(aiter_bytes())`; fill `SERVICE_BASE_URLS` `{subdomain}`/`{instance}` placeholders; clear held-vs-streamable rules | A | 1.5 | `main.py:214-215,316-370` |
| Encryption-at-rest + PII redaction: redaction pass on ingest; envelope-encrypt `trace_json`/`system_prompt`/params with decrypt-on-read; **specialist review** | A | 3.0 | `main.py:3199`; `ingestion/base.py`; `db.py:99` |
| Env-guard fail-closed on explicit `ARCEO_ENV`; **RBAC `require_role` on every mutating route**; password-change token revocation (`token_version`/`jti`) | B | 2.5 | `auth.py:16-57`; `db.py:25,84`; ~all mutating endpoints |
| Enforcement adversarial test harness: bypass, fail-closed, key-never-leaks, replay-exactly-once, per-provider auth injection | B | 1.5 | `backend/tests/` |

**Exit criteria:** SSE/streaming agents pass through without buffering (time-to-first-token
restored). PII redacted before persist; encrypted columns with analytics intact. Viewer role
blocked from **every** mutating route (matrix test — one miss is a hole). Enforcement adversarial
suite green.

**Locks:** Streaming correctness; encryption + RBAC; enforcement trust via tests.

---

## Phase 6 · Weeks 21–24 — Honest risk gate + capture + test debt + audit-grade logging

**Goal:** close the remaining honesty gaps; harden; reach audit-ready code posture.

| Task | Owner | ew | Files |
|---|---|---|---|
| CI-gate inversion: penalize opaque/unclassified capability + subprocess/`os` import hints; stop hard-failing honest billing agents; fleet recalibration | B | 2.5 | `main.py:750,2144,1965`; `evals/calibrate_fleet.py` |
| Ingestion tool-identity honesty: only count provider-marked tool calls; loop all `tool_calls`; tag `tool_unresolved` + exclude from auto-register instead of minting `unknown.<name>` | B | 1.2 | `ingestion/langsmith.py:34`; `langfuse.py:35,106` |
| One async/streaming capture adapter + honest SDK/Settings docs on exactly what is/isn't captured | B | 2.0 | `sdk/arceo/_capture.py:143-196` |
| Security test-debt paydown: cross-tenant, RBAC, rate-limit, API-key scoping, approvals auth, unauth-reject | A | 3.0 | `backend/tests/` |
| SOC2 Type I **code pieces**: hash-chained non-droppable audit log, TLS/HSTS, backups + restore drill, structured privileged-action events | A | 3.0 | `db.py:412-425`; audit path |

**Exit criteria:** CI gate no longer passes obfuscated shell agents *and* no longer hard-fails
honest billing agents (recalibrated + tested). Ingestion mints no phantom tools. Audit log is
append-only / hash-chained / non-droppable. Risky paths covered by tests gating CI.

**Locks:** Honest risk gate; audit-grade logging; test coverage. → **10/10 engineering floor reached.**

---

## Beyond week 24 (honest — these genuinely don't fit)

| Item | ew | Why it's out |
|---|---|---|
| **Simulation fidelity** — run customer's real code vs mocked tools in a sandbox | 8 (3× risk) | Safe execution of untrusted code is a research-grade infra bet. **Interim honest posture:** elevate trace-replay of *real captured traces* (already the strongest evidence path) as primary; keep LLM roleplay clearly labeled "surrogate." |
| **Static chains as data-flow reachability** | 4.5 | Needs tool *output* schemas that don't exist (`TOOL_SCHEMAS` is input-only) |
| **Behavioral anti-rename scoring** | 4 | Depends on real execution above |
| **Full capture coverage** (all gateways + JS/TS SDK) | 3+ | One adapter lands in P6; rest is a follow-on |
| **Team-invite same-org collaboration** | 1.5 | Only safe *after* tenancy is proven; pull into P6 if ahead of pace |
| **SOC 2 Type II** | — | 3–6 months of *operating* evidence — calendar-bound regardless of code speed |

---

## Cross-cutting practices (all 24 weeks)

- **CI gates from week 1:** the security test suites must be required checks, not aspirational.
- **Migrations discipline:** every schema change is a reviewed Alembic migration with a rollback — no more `PRAGMA table_info` + `ALTER` hacks.
- **Feature-flag the breaking changes:** DENY-by-default, register-auth, RBAC enforcement all ship dark → staged → default-on.
- **Break-glass story:** fail-closed means an Arceo outage halts customer agents — document the health-check + manual-bypass path *before* Phase 2 ships.

---

## Two things only the founder can unblock (start now)

1. **Budget a part-time security specialist** for the envelope-encryption (P2), RLS-with-pooling
   (P3), and PII-redaction (P5) reviews. Two generalists shipping these unreviewed is a
   silent-breach risk.
2. **Engage a SOC2 auditor + compliance platform (Vanta/Drata) now** — the paperwork and Type II
   observation window run in parallel and gate attestation regardless of how fast the code lands.

---

## Milestone summary

| Phase | Weeks | Milestone | 10/10 property locked |
|---|---|---|---|
| 1 | 1–4 | Honest + fail-closed | Correctness / Honesty |
| 2 | 5–8 | Postgres + credential custody | Architecture (datastore + chokepoint) |
| 3 | 9–12 | Per-query isolation + no open writes | Security (tenancy) |
| 4 | 13–16 | Real approvals + durable queue | Reliability |
| 5 | 17–20 | Streaming + encryption + RBAC | Security / Correctness |
| 6 | 21–24 | Honest gate + tests + audit log | Testability / Maintainability |

**Net:** in 24 weeks, 2 engineers make Arceo a genuinely 10/10-*engineered* system. The two
research-grade capabilities are the *only* things that push past 24 weeks.
