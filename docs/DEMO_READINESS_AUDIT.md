# Arceo — Demo-Readiness Audit

_Full-product audit: every page, every backend module, the frontend↔backend contract, live API probing, security, and build/test health. Findings were produced by a multi-agent review and then adversarially verified against the running stack (frontend :3000, backend :8000). Only findings confirmed in code or against live data are listed as confirmed._

**Verdict: NOT ready for a hands-on / unscripted demo. Ready only for a tightly-scripted happy-path walkthrough that avoids the flows below.** The core surfaces are polished and the underlying math is careful, but several primary click-paths — the two "generate a report" payoffs, the flagship worst-case alert, and the Workflows value-prop — are broken or misleading, and there are live security holes.

---

## P0 — Demo-path breakers (a prospect will hit these)

1. **Sandbox "Sweep all scenarios" → dead page.** Clicking the free full-scan button runs the sweep, navigates to `/sweep/{id}`, and always shows **"Sweep not found."** The GET endpoint returns a flat report but the page reads `data.sweep` (no wrapper) — and even if unwrapped, every field name differs (`aggregate`/`scenarios`/`violations.rule` vs `overall_risk_score`/`scenario_results`/`all_violations.title`). `SweepDetail.tsx:122`, `main.py:5095`. **CRITICAL.**

2. **AgentDetail "Worst Case Scenario" always reads "Unnamed chain."** The flagship amber alert — the most prominent element on the page — reads `topChain.chain_name`, which the backend never sends (it sends `name`/`description`). `chainNarrative(undefined)` returns the truthy string "Unnamed chain", so the real threat name ("PII to Financial Action") is never shown. Fires on **both** demo agents. `AgentDetail.tsx:557`. **HIGH.**

3. **SimulationDetail renders half-empty.** Violation cards read `v.rule` (backend sends `title`) → blank violation titles on any past simulation with findings. The "Apply All" button POSTs to `/api/authority/agent/{id}/apply-recommendations`, which **does not exist** (404). `SimulationDetail.tsx:468,331`. **HIGH.**

4. **Workflows "Apply All Recommendations" silently does nothing.** It writes REQUIRE_APPROVAL gates with `action_pattern = "*"`, which the enforcement matcher never matches (a bare `*` splits to 1 part; the matcher requires 2). The toast says "Applied N recommendations," a policy row is written, but the gate fires on zero actions. The page's core promise — gating risky handoffs — is inert. `Workflows.tsx:1073`, `enforcement.py:159`. **HIGH.**

5. **Workflows risk preview contradicts its own detail.** The "Riskiest combinations" card (from `/top-pairings`, which dedups symmetric pairs and downgrades pii-exfil) opens into `/cross-agent-chains` (no dedup, no downgrade). Live: a card labeled **5 critical / 3 high** opens to **12 critical / 6 high** with pii-exfil doubled and upgraded to CRITICAL. Same agents, contradictory numbers. `Workflows.tsx:986`, `main.py:1167` vs `3558`. **HIGH.**

6. **Spend confidence band on screen ≠ the CFO PDF.** The dashboard card hardcodes **±28%** ($575–$1,023 on live data) while the PDF exported from the same page uses the real asymmetric band (**−45% / +177%**, $437–$2,212). A CFO comparing the two sees a 2× different range for the same fleet. `SpendDashboard.tsx:355`. **HIGH.**

---

## P0 — Security (fix before exposing the instance to anyone)

7. **Live `admin123` credential on a non-demo server.** `/api/demo-mode` reports `demo:false`, yet `admin@actiongate.io` / `admin123` logs in with a full admin token. A DB seeded once under DEMO_MODE keeps the public password forever with no rotation path. `db.py:330`. **CRITICAL.**

8. **Cross-tenant agent hijack/wipe.** `POST /api/ingest/langsmith|langfuse|generic` (authed, but accepts an arbitrary `agent_name`) upserts against the `default` org without the caller's `org_id`, then force-reassigns `org_id` scoped only by the global agent-id PK. A second tenant importing a trace for `Finance Refund Specialist` steals/wipes the primary org's `finance-refund-specialist` (or 500s). `ingestion/base.py:47`. **CRITICAL / IDOR.**

9. **Unauthenticated `/mock/*` surface.** `GET /mock/sessions` and `/mock/session/{id}/trace` return 200 with no token and expose every session's steps; `POST /mock/{tool}/{action}` takes `agent_id` from a header and writes `execution_log` rows — an anonymous caller can inject fake **PENDING_APPROVAL** items into the demo's Approvals queue. `main.py:5237,5334`. **HIGH.**

10. **Unauthenticated `POST /api/traces/live`.** No auth (only a rate limit); accepts attacker-chosen `agent_id` and broadcasts forged events to authenticated WebSocket subscribers. Latent today (no frontend consumer wired), immediate the moment the live-trace panel ships. `main.py:3915`. **MEDIUM.**

11. **Default JWT secret is a forgery landmine.** `JWT_SECRET` falls back to a hardcoded string; the hard-fail guard only fires on 4 named platforms (Railway/Fly/Render/PRODUCTION). Any other host (bare VM, Docker, tunneled laptop) boots with the public secret → anyone can forge an admin token for any org. The current live server uses a real secret, so it's latent. `auth.py:16`. **MEDIUM.**

12. **No rate-limit/lockout on login/signup** despite an in-house limiter used elsewhere; combined with the 6-char password minimum and the known `admin123`, brute force is open. `main.py:926`. **LOW.**

---

## P1 — "Why does it say X here but Y there?" (asked-in-demo inconsistencies)

13. **Fleet risk distribution mislabels High as Critical.** The Overview panel folds the `high` band (60–79) into a bucket **labeled "Critical"** with the red token, while each agent card shows the same agent as "High." `Authority.tsx:1086`. **MEDIUM.**

14. **Cross-org agent-id collision → raw 500.** `_upsert_agent`'s existence check is org-scoped but `agents.id` is a global PK, so importing an agent whose name collides with another tenant's (or the demo's own seeded name) throws a 500 instead of a clean "name taken." The sibling `create_agent` guards this exact case; the import path doesn't. `main.py:1504`. **HIGH.**

15. **`*.action` wildcard BLOCK: scored "protected," enforced-blind.** `graph.py` treats a `*.create_refund` BLOCK as fully mitigating (score drops, card says protected) but `enforcement.py` never matches it at runtime → the proxy allows the action. Reachable only via raw API (the UI can't emit this pattern), so latent. `enforcement.py:159` vs `graph.py:271`. **MEDIUM.**

16. **Read-only actions fabricate critical delete-chains.** The read-strip in the classifier omits `deletes_data`, so `list_purge_jobs` / `search_deleted_items` get a locked `deletes_data` label the LLM can't veto, spawning phantom critical "deletion" chains. Latent for the seeded agents; fires on realistic enterprise catalogs. `risk_classifier.py:417`. **HIGH.**

17. **Team invite creates an orphan account.** Settings' "invite a teammate" calls `signup`, which puts the invitee in a **brand-new empty org** (never the inviter's), and reports success even if the email already exists. `Settings.tsx:634`, `main.py:885`. **HIGH.**

18. **History headline stats are capped at 100.** The endpoint is `LIMIT 100`; the page computes "Total Actions / Executed / Blocked" client-side over just that page (192 rows exist in the DB), so the totals silently understate. `main.py:2818`, `History.tsx:328`. **MEDIUM.**

19. **Policy-conflict banner renders "— overrides —".** Reads `winner/loser.action_pattern`; backend returns `policy_a`/`policy_b` + `winner:{id,effect}`. Header count is right, every detail row is blank. Only appears once a user authors overlapping policies. `AgentDetail.tsx:2164`. **MEDIUM.**

20. **Drawer "Add policy" CTA lands on the wrong tab** — links to `#policies` (hash) but AgentDetail only honors `?tab=policies`. `AgentDrawer.tsx:526`. **MEDIUM.**

21. **Risk-band thresholds disagree across pages.** SimulationDetail and Comparison hardcode 70/40 "Critical/High/Safe" with raw hex, while the rest of the app uses the authoritative 80/60/40 `scoreBand`. A score of 72 is "Critical" on one page, "High" on another. `SimulationDetail.tsx:129`, `Comparison.tsx:562`. **LOW.**

22. **$0-instead-of-empty-state spend.** The Overview "Forecast spend / mo" tile and FleetStrip use `(acc ?? 0) + f.point` where `point` is `null` for unavailable forecasts → `0 + null === 0`, so a fresh fleet shows a confident "**$0 / Across 0 agents**" instead of "Awaiting forecasts." `Authority.tsx:1078`. **MEDIUM.**

---

## P2 — Error-states dressed as success (silent, but corrosive)

- Batch-forecast failure → "all agents need sandbox runs"; cost-report failure → "no risky actions detected"; forecast-fetch failure → "run a simulation." Failures look like honest empty states. (`SpendDashboard`, `CostPortfolio`)
- Notifications GET failure renders blank defaults; Save then overwrites the org's real webhook/email with blanks. `Settings.tsx:486`.
- Errored simulations render a green "0 / Safe" ring with an amber "error" chip and never show the error reason. `SimulationDetail.tsx:405`.
- CostPortfolio slider refetch failure keeps stale dollars under a green "Updated forecast" label. `CostPortfolio.tsx:629`.
- CFO PDF "largest single-incident loss" can be smaller than a risk listed below it once the top action is gated — exactly the flow the product recommends. `cfoReport.ts:241`.

## P2 — Robustness / state bugs (mostly latent with 2 seeded agents)

- Sandbox: typing one char in the custom-prompt box wipes the queued scenarios; the LLM cost warning is gated on a stale `runMode` so "add all → Test (real LLM)" fires a paid multi-minute batch with no warning; errored runs badged "Clean"; an unescaped `agent_id` in `new RegExp` can crash the page. (`Sandbox.tsx`)
- Approvals: 10s poll can resurrect a just-decided card → "not pending approval" error on re-click.
- `getUser()` `JSON.parse` has no try/catch → corrupt `localStorage` white-screens the app.
- Combined "acting together" score can read **below** the riskiest single agent (weights max at 0.6). `Workflows.tsx:1485`.
- Cross-org agent CRUD audit writes omit `org_id` → tenant audit trails leak into the default org.
- Both HTTP proxies forward a stale `Content-Length` after httpx decompression → corrupts gzip'd upstream responses.

## P3 — Cosmetic / polish

Composition percentages round independently (bar sums to 99/101%); "Running 0 of 3" off-by-one on run buttons; every trace step shows a raw kebab agent-id chip; chain labels render "Cross Agent: Pii Exfiltration" (humanized fallback fed titles not keys); recommendation text shows "stripe.Create Payout"; simulations list shows raw slugs (no friendly names); enforcement snippets hardcode `https://api.arceo.io`; History legend colors drift from row dots; `formatMoney` compact mode → "$-1.5k".

---

## Build / test / lint health

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ **clean** |
| `npm run build` | ✅ succeeds (react-pdf is a 1.4 MB lazy chunk; main bundle 840 KB / 234 KB gz) |
| `pytest` | ⚠️ **102 pass, 1 fail** — the failure (`test_no_hardcoded_model_ids`) scans `venv/`'s vendored Anthropic SDK, a test-scoping bug, not app code. Also `InsecureKeyLengthWarning`: JWT HMAC key is 24 bytes (< 32-byte min). |
| `npm run lint` | ❌ **broken config** — `files: ['**/*.{js,jsx}']` never matches the `.ts`/`.tsx` app, so lint covers **zero source files** and emits 310 errors from vendored `.vite/deps`. No real coverage. |

---

## What's genuinely solid (don't lose this in the noise)

- Auth flow, token storage, 401→logout, ProtectedRoute, ErrorBoundary, NotFound, and clean per-page error states ("Couldn't load this agent / Try again").
- `/api/*` endpoints are consistently org-scoped and auth-guarded; live IDOR probes on `agent/{id}` and `simulation/{id}` correctly return 404 across tenants; SSRF guard on MCP-connect; extract-github regex-locked.
- The blast-radius scoring, band boundaries (80/60/40), enforcement precedence (applied BLOCK beats broad ALLOW), and the 3-tier forecast/cost math are careful and internally consistent.
- Primary dashboard surfaces (agent list, agent-detail header + stat drill-downs, chains tab, spend totals, history table, approvals view) render correctly and their numbers reconcile.
- The design-system pass is real: shared primitives, consistent tokens, thoughtful empty/error states.

_One finding was **refuted** on verification: the Workflow-optimize "View Full Report 404" — that link belongs to the multi-simulate flow, which does persist its simulation._
