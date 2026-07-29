# Dead Code Report

## Document metadata

| Field | Value |
|---|---|
| Document | Dead Code Report |
| Project | Arceo — Backend Security Audit |
| Audit date | 2026-07-28 |
| Auditor | Arceo Engineering — Internal Security Review |
| Source | `dev`, verified at commit `076f0b0` |
| Scope | `backend/` (FastAPI service, Python 3.11) plus operational scripts (`scripts/`) and migrations (`backend/alembic/`) |
| Classification | Internal / Confidential |

## Purpose and method

This report inventories **security-relevant dead code** — branches, functions, parameters, and stored values that are provably unreferenced in the current checkout and that widen attack surface, invite unsafe reintroduction, or misrepresent a control as active when it is inert. Every item below was confirmed by a reference sweep that returns **zero non-definition callers**; the exact command is given per item so the result can be reproduced against commit `076f0b0`. Nothing here is inferred from documentation — where in-repo documentation conflicts with the checked-out code, the code is authoritative.

Deliberate legacy naming from the ActionGate → Arceo rename (the `actiongate.db`/`llm_cache.db` filenames, the `admin@actiongate.io` seed admin, the `actiongate.*` logger names, and "ActionGate" brand strings) is **intentional** and is not treated as dead code. The "Verified live — not dead code" section at the end records the paths that looked abandoned but were proven reachable, so the exclusions are auditable too.

---

## Summary

| Category | Count | Recommended Action |
|---|---:|---|
| Dead function | 3 | Delete — all three are unreachable; one is an inert cross-tenant security control that reads as active |
| Debug/test-only path (dead branch) | 1 | Remove the unsalted-SHA-256 verify branch once legacy rows are confirmed absent, or gate it behind an explicit migration flag |
| Unused constant / stored-but-unused capability | 1 | Enforce the stored `api_keys.scopes` or drop the column and its permissive default |
| Dead code path (unused parameter) | 1 | Remove the `MockState` `tenant_id` parameter and its merge branch, or wire it end to end |
| **Total** | **6** | |

---

## DC-01 — Unsalted SHA-256 password-verify fallback branch

- **File & line range:** `backend/auth.py:71–80` (the `else` branch of `verify_password`, spanning `backend/auth.py:68–80`).
- **Category:** Debug/test-only path (dead branch).
- **Callers found:** 0 production writers. `verify_password` itself is live (called from `login_user`), but the `else` branch only executes for a stored hash that does **not** begin `$2b$`/`$2a$`. Every production writer of `users.password_hash` produces a bcrypt hash via `auth.hash_password` — signup (`backend/main.py:1373`), change-password (`backend/main.py:1456`), team-invite (`backend/main.py:1490`), first-boot seed (`backend/db.py:138`), and the login re-hash (`backend/auth.py:181–182`). The **only** code anywhere that writes a bare SHA-256 hash into `password_hash` is a test fixture, `backend/tests/test_auth_polish.py:70`, which injects one specifically to exercise the upgrade-on-login path. No code path that runs in a production build creates such a row, so for any database provisioned by this codebase the branch is unreachable.
- **Security impact:** An unsalted single-round SHA-256 password verifier is a weak-cryptography primitive (offline brute-force / rainbow-table exposure) sitting live in the authentication path. It is retained as a migration convenience, but because nothing in the current code produces the hash it accepts, it provides no value while keeping a deprecated verification algorithm resident in the login flow — exactly the kind of latent branch that a future refactor can accidentally make reachable (e.g. a new importer that writes a SHA-256 hash), silently downgrading password security.
- **Recommended action:** Confirm via a one-off query that no `users.password_hash` row is non-bcrypt in any live database, then delete the `else` branch and fail closed on an unrecognized hash format. If legacy rows genuinely exist, gate the branch behind an explicit, time-boxed migration flag rather than leaving it unconditionally in the verify path.
- **Verification command:**
  ```
  rg -n 'sha256\(.*\)\.hexdigest\(\)' backend --glob '!*.lock' | grep -i 'pass'
  # → only auth.py:76 (the verifier) and tests/test_auth_polish.py:70 (a test) — no production writer
  rg -n 'password_hash' backend/main.py backend/db.py backend/auth.py | grep -iE 'INSERT|UPDATE'
  # → all five production writers pair password_hash with hash_password() (bcrypt)
  ```
- **Related finding:** MED-003. (The in-code comment at `backend/auth.py:72` labels this `LOW-003`; it is carried in the audit findings register as MED-003.)

---

## DC-02 — `api_keys.scopes` stored but never read or enforced

- **File & line range:** Column defined at `backend/alembic/versions/0001_baseline.py:188`, with `server_default='["enforce","register","report"]'`. Read path that ignores it: `verify_api_key` at `backend/main.py:6547–6556`.
- **Category:** Unused constant / stored-but-unused capability.
- **Callers found:** 0 readers. `scopes` appears in the schema exactly once (the migration column definition) and is never selected by name, deserialized, or consulted in any authorization decision. `verify_api_key` issues `SELECT * FROM api_keys WHERE key_hash = %s AND active = 1` and returns the row, but no caller ever reads `row["scopes"]`; the API-key trust decision is binary (valid + active) with no per-scope gating. Every other backend hit for the token `scopes` is the unrelated English verb in RLS comments ("RLS scopes this request…"), not the column.
- **Security impact:** The column's permissive default (`enforce`, `register`, `report`) implies a least-privilege capability model on API keys that does not exist — any valid key is honored for every X-API-Key surface (the enforcing proxy, `/api/scan`, agent registration, LLM capture) regardless of the scopes it nominally carries. This is a latent broken-access-control gap dressed as an implemented control: an operator issuing what they believe is a report-only key actually issues a key with full enforcement authority. The stored-but-unenforced field also invites a future developer to "re-enable" scoping and assume historical keys were already constrained, when they never were.
- **Recommended action:** Either implement scope enforcement in `verify_api_key` (parse `scopes`, check the required scope per route, deny on mismatch), or remove the column and its default so the schema no longer advertises a capability the code does not honor. Do not ship the permissive default without an enforcement point.
- **Verification command:**
  ```
  rg -n '\bscopes\b' backend --glob '!*.md' | grep -viE 'RLS|transaction|request|statement|tenant|this request'
  # → only alembic/versions/0001_baseline.py:188 (the column definition); no read, no enforcement
  ```
- **Related finding:** LOW-001.

---

## DC-03 — `MockState(tenant_id=…)` parameter path and its `TENANT_DATA` merge branch

- **File & line range:** `backend/sandbox/mocks/registry.py:57–68` — the `tenant_id` constructor parameter (`registry.py:57`), the `self.tenant_id` assignment (`registry.py:58`), and the tenant-data merge branch it guards (`registry.py:64–68`).
- **Category:** Dead code path (unused parameter).
- **Callers found:** 0 callers pass `tenant_id`. Every `MockState(...)` construction in the codebase supplies only `custom_data=` and/or `seed=` — `backend/main.py:6375` and `:6420` (the `/mock` session endpoints), `backend/sandbox/runner.py:355` and `:534`, `backend/sandbox/multi_runner.py:320` and `:357`, `backend/sandbox/red_team.py:235`, and the `test_sim_enforcement.py` cases. None pass `tenant_id`, so `self.tenant_id` is always `None`, the `if tenant_id and tenant_id in TENANT_DATA:` branch never runs, and the `tenant-alpha`/`tenant-beta` fixtures are never merged into a simulation's mock state. The stored attribute is also never read back anywhere (`state.tenant_id` has no consumer).
- **Security impact:** Arceo's product claim includes detecting cross-tenant data bleed inside simulations. The `tenant_id` parameter is the entry point that would scope a sim's mock data to one tenant so a leak of another tenant's records is observable — and it is inert. In its current state a simulation cannot exercise the multi-tenant isolation fixtures at all, so the tenant-isolation guarantee is untested by any normal run. This dead parameter is the mock-side half of the same abandoned feature whose analyzer-side half is DC-04.
- **Recommended action:** Either wire `tenant_id` through the simulation entry points (`run_simulation` / the `/mock` session creators) so the isolation fixtures are actually exercised and paired with DC-04's detector, or remove the parameter, the merge branch, and the now-orphaned `TENANT_DATA` fixtures to avoid implying a control that does not run.
- **Verification command:**
  ```
  rg -n 'MockState\([^)]*tenant_id' backend        # → no matches: no caller passes tenant_id
  rg -n '\.tenant_id\b' backend | grep -v 'self.tenant_id = tenant_id'   # → no matches: never read back
  ```
- **Related finding:** LOW-017.

---

## DC-04 — Dead cross-tenant data-leak detector `_detect_cross_tenant_access`

- **File & line range:** `backend/sandbox/analyzer.py:1115–1153`.
- **Category:** Dead function.
- **Callers found:** 0. A repo-wide sweep for `_detect_cross_tenant_access` returns only the definition line (`analyzer.py:1115`); the two other in-file matches (`:1117`, `:1126`) are uses of its own `agent_tenant_id` parameter inside the body. It is never invoked from `analyze_trace`, the sweep aggregation, or anywhere else. It is also the only consumer of the `TENANT_DATA` fixtures outside DC-03's never-taken branch, so those fixtures reach live code through no path at all.
- **Security impact:** This function is the control that would flag a simulation step returning another tenant's records (it builds the set of foreign-tenant identifiers from `TENANT_DATA` and raises a `critical` `cross_tenant_access` violation on a match). Because it is never called, cross-tenant bleed in a simulation is silently not detected — a security control that appears implemented (it is written, typed, and complete) but is wired to nothing. Dead detectors are worse than absent ones: a reviewer scanning the analyzer sees cross-tenant detection and reasonably assumes coverage that does not exist.
- **Recommended action:** Wire it into the analysis path and feed it the agent's tenant (paired with DC-03 so `tenant_id` actually flows), or delete it together with the `TENANT_DATA` fixtures if multi-tenant simulation is not being pursued. Do not leave a complete-looking isolation control unreferenced.
- **Verification command:**
  ```
  rg -n '_detect_cross_tenant_access' backend
  # → only analyzer.py:1115 (the def); zero call sites
  ```
- **Related finding:** None assigned in the findings register; corroborated independently in `docs/PRODUCT_FUNCTIONALITY_REVIEW.md`. Directly related to LOW-017 (DC-03) — same abandoned multi-tenant-simulation feature, analyzer side.

---

## DC-05 — Dead held-params decryptor `pending_params`

- **File & line range:** `backend/approvals.py:113–116`.
- **Category:** Dead function.
- **Callers found:** 0. A repo-wide sweep for `pending_params` returns only its definition (`approvals.py:113`). Its sibling reader `decoded_body` (`approvals.py:106`) is wired into the approve-and-replay path (`backend/main.py:3896`) and covered by a test (`backend/tests/test_encrypt_at_rest.py:89`), which confirms the pattern is used elsewhere — `pending_params` is the one member of the pair that was never connected.
- **Security impact:** `pending_params` is the encryption-aware reader for a held action's parameters — customer data at rest (amounts, recipients, record IDs) stored in `pending_requests.params_json` / `params_json_enc` via the same at-rest seam the rest of the product uses. Because the decryptor is dead, any surface that needs to display or replay those held params must read the column some other way, bypassing the single decryption seam and risking a plaintext/ciphertext mismatch (encrypted bytes shown raw, or a silent `None`). The dead reader signals an incompletely wired at-rest encryption read path around the approvals queue, and it is a reintroduction hazard: a future developer may resurrect the wrong reader.
- **Recommended action:** Route the approvals/replay params surface through `pending_params` (mirroring how `decoded_body` handles the body) so held params are decrypted through the one seam, or delete the function if the params are intentionally never surfaced. Do not leave a half-wired encryption read pair.
- **Verification command:**
  ```
  rg -n 'pending_params' .
  # → only approvals.py:113 (the def); zero call sites. Contrast decoded_body → also used at main.py:3896
  ```
- **Related finding:** None assigned; flagged here as new.

---

## DC-06 — Dead extraction wrapper `_extract_string_values`

- **File & line range:** `backend/sandbox/analyzer.py:281–283`.
- **Category:** Dead function (mid-refactor debris).
- **Callers found:** 0. A repo-wide sweep for `_extract_string_values` returns only its definition (`analyzer.py:281`). Its own docstring identifies it as a "backwards-compat wrapper over `_extract_keyed_values`"; the underlying `_extract_keyed_values` is live and used by the data-flow detector (`analyzer.py:335`, `:350`, plus its own recursion), while the flat wrapper was left behind when callers migrated to the keyed form.
- **Security impact:** Low in isolation — this is refactor debris in the PII/financial data-flow extraction path that feeds cross-step leak detection. Its risk is reintroduction and drift: a dead wrapper that quietly returns a lossy (unkeyed) view of the same extraction can be picked up by a future contributor and reintroduce a weaker analysis than the keyed path the code already standardized on. Carrying two extraction entry points where one is unused also obscures which is the maintained path.
- **Recommended action:** Delete the wrapper; migrate any hypothetical external caller to `_extract_keyed_values`. No behavior depends on it.
- **Verification command:**
  ```
  rg -n '_extract_string_values' backend
  # → only analyzer.py:281 (the def); zero call sites. _extract_keyed_values (the live twin) is used at analyzer.py:335,350
  ```
- **Related finding:** None assigned; flagged here as new.

---

## Verified live — not dead code (false-positive discipline)

Each of the following looked abandoned during the sweep and was proven **reachable**, so it is deliberately excluded from the inventory above:

- **`llm_cache.db` SQLite cache path** — `backend/authority/risk_classifier.py:531–558` (`import sqlite3`, `CREATE TABLE IF NOT EXISTS llm_classifications`, `sqlite3.connect(...)`). This matches the pre-Postgres SQLite pattern named in the grounding rule, but it is **live and deliberate**: `_cache_conn` is called by `_cache_get`/`_flush_pending_cache_rows`, and its own docstring records the design decision that this cache "deliberately stays SQLite even as the app DB moves to Postgres." It is the intentional, separate LLM-classification cache — not an abandoned pre-Postgres path — so it is not dead code.
- **`vault.rewrap_blob` / `vault.rewrap_credential`** — `backend/vault.py:160–179`. These have no caller *inside* `backend/` and are exercised by tests, which made them look test-only; the master-key rotation operator script `scripts/rotate_vault_master_key.py:68,82` calls both. They are the live key-rotation primitives, not dead.
- **`scripts/migrate_sqlite_to_pg.py`** — a genuine SQLite-era artifact, but a standalone operator-run migration utility with a `__main__` entry point, reachable by an operator by design. It is not code-unreachable, so it is not reported as dead.
- **`ARCEO_ALLOW_INTERNAL_MCP` bypass (`backend/main.py:395`), `DEMO_MODE`, and the `TESTING` scheduler guard (`backend/main.py:461–465`)** — live, intentional environment-gated feature flags (SSRF dev allowance, demo auth bypass, pytest snapshot guard), each fenced against production by an explicit gate. Reachable and intended, not dead.
- **`backend/alembic/versions/0001_baseline.py:12` "the DEFAULT 1 is dead code"** — this comment documents a SQLite `DEFAULT 1` no-op that was **not** carried into the Postgres baseline (the column became an autoincrement PK). Nothing dead exists in the current checkout; the note explains a design decision, so there is nothing to remove.
- **ActionGate legacy naming** — `actiongate.db`/`llm_cache.db` filenames, `admin@actiongate.io`, `actiongate.*` loggers, and brand strings are the deliberate mid-rename convention and are excluded by policy.

No orphaned endpoint is reported: every FastAPI route is decorator-registered and callable, and the public/unauthenticated-by-design endpoints plus the SDK and frontend clients mean "no caller" cannot be proven for a route from the backend tree alone. Absent proof of zero clients, asserting an endpoint is dead would be speculation and is deliberately omitted.
