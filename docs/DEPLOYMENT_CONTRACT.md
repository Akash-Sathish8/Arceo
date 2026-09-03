# Deployment contract

**What Arceo requires from whatever runs it.** Written for whoever designs the
hosting (Tim Kelly's proposal, per the 2026-08-06 Foundry decision to standardise
on Google Cloud), and kept in the repo so it stays true as the code changes.

**Scope, deliberately.** This is the *application's* half of the contract. Cloud
Run service YAML, Terraform, `cloudbuild.yaml`, Cloud Scheduler and IAM are
**not** in this repo and should not be — `docker-compose.yml`,
`docs/MIGRATION_RUNBOOK.md`, `scripts/setup_prod_role.sql`,
`scripts/backup_restore_drill.sh`, `scripts/verify_rls_active.py` and
`scripts/migrate_sqlite_to_pg.py` already constitute a deliberate self-host set,
and that customer-VPC posture is what the governance wedge sells on. Consume the
platform template; do not let this document grow parallel IaC.

---

## 1. Two backing services, neither optional

| | Variable | If it is missing |
|---|---|---|
| **Postgres** | `DATABASE_URL` | The app **refuses to start** unless `ARCEO_ENV` names a dev environment. |
| **Redis** | `REDIS_URL` | The app **refuses to start** outside dev. |

**Redis is a dependency, not a cache.** There is deliberately no in-memory
fallback — one would silently reintroduce the multi-worker bugs it replaced — and
rate limiting **fails closed**. So an unreachable Redis does not degrade Arceo,
it 429s login, signup, `/api/enforce`, `/api/scan` (the GitHub Action's
endpoint), the LLM proxy, live-trace ingest and the mock sandbox, **while
`/api/health` keeps returning 200**. That is why the app now refuses to boot
rather than serving in that state.

> ⚠️ **On Google Cloud this means Memorystore plus a Serverless VPC connector.**
> It is a prerequisite of the deployment, not an add-on to it.

⚠️ **The Cloud SQL Auth Proxy sidecar binds `127.0.0.1:5432`** — the same address
as the dev docker-compose default. That is precisely why the `DATABASE_URL` guard
was inverted (Tier 2.1): the previous version allow-listed four PaaS environment
variables, none of which Cloud Run sets, so a missing `DATABASE_URL` would have
*silently connected to whatever the proxy fronted* and run migrations on it.

## 2. Ports and probes

- **The container honours `$PORT`** and defaults to 8000. Cloud Run injects it;
  nothing extra is needed.
- **`GET /api/health` is liveness.** It checks nothing on purpose — a liveness
  probe that depends on Postgres restarts the container during a database blip.
- **`GET /api/ready` is readiness.** `SELECT 1`, 503 when the database is
  unreachable, result cached ~5s. **Point the orchestrator's readiness probe
  here, not at `/api/health`.**
- ⚠️ **`/api/ready` deliberately does not probe Redis.** The *global* limiter
  fails open so a Redis outage degrades rate limiting rather than taking the API
  down; gating readiness on Redis would convert that designed partial
  degradation into every instance reporting unready at once. Redis is enforced at
  boot instead.

## 3. Migrations are a deploy step, not a boot step

`ARCEO_RUN_MIGRATIONS_ON_BOOT` defaults **on in dev, off everywhere else**.
Production runs as the restricted `arceo_app` role; migrations need the owner
role.

⚠️ **This is a release-ordering hazard, and it hides well.** At head, alembic
degenerates to a `SELECT version_num` that `arceo_app` can execute — so ordinary
restarts look fine. It is the **first boot of a release carrying an unapplied
revision** that raises permission-denied, i.e. exactly the deploy that matters,
and the container never serves.

```bash
DATABASE_URL=<owner-url> alembic -c backend/alembic.ini upgrade head   # deploy step
# then start the app pointed at arceo_app
```

The app **verifies the schema is at head** when it did not migrate, and refuses
to serve if it is behind — naming the revision it found, the command, and the
role. A forgotten migration fails at deploy time rather than as a 500 on the
first affected request.

**After cutover, run `scripts/verify_rls_active.py`** as a gate. It is proven
against a real `NOSUPERUSER NOBYPASSRLS` role in `test_cutover.py`.

## 4. Background jobs: turn the in-process scheduler off

Arceo runs a daemon thread on a ~6-hour sleep loop driving forecast snapshots,
the weekly digest, and **the only automated data-retention control**
(`purge_llm_captures`, which deletes captured prompt and response bodies past
their retention window).

⚠️ **Cloud Run throttles CPU between requests, so that loop essentially never
ticks.** Silently. Including the retention control.

Set **`DISABLE_SNAPSHOT_SCHEDULER=true`** and drive the three jobs with Cloud
Scheduler against Cloud Run Jobs. Each already has a standalone entrypoint:

```
python -m jobs.snapshot_forecasts
python -m jobs.weekly_digest
python -m jobs.purge_llm_captures
```

**This is deploy configuration, not an application change.** Do not build
authenticated internal endpoints for it.

## 5. Proxy headers — get this wrong and rate limiting is decorative

`TRUSTED_PROXY` is off by default. When on, **`ARCEO_TRUSTED_PROXY_HOPS` is
required and the app refuses to start without it.** There is no safe default:

| Topology | Hops | Because |
|---|---|---|
| Direct `*.run.app` | `0` | the client IP is the **right-most** `X-Forwarded-For` entry |
| GCLB in front of Cloud Run | `1` | skip the one entry the load balancer appended |

Too low and a caller forges their own rate-limit bucket; too high and every
caller collapses into one, so the eleventh login from *anyone* is refused.

> ⚠️ **Do not set `FORWARDED_ALLOW_IPS=*`.** It is the common Cloud Run recipe
> and it is wrong here. uvicorn's `ProxyHeadersMiddleware` is on by default, and
> with a trusted set of `*` it takes the **left-most, caller-written** hop and
> overwrites `request.client.host` with it **before the application sees the
> request** — reinstating the spoof even with `TRUSTED_PROXY` off. The Dockerfile
> pins `--forwarded-allow-ips=127.0.0.1`, which beats the environment variable,
> so the setting cannot take effect there. Leave it pinned.

## 6. Flags that disable a protection

All are dev-only. Each is ignored or refuses to boot outside a dev `ARCEO_ENV`.
**None belongs on a deploy.**

| Flag | What it turns off |
|---|---|
| `DEMO_MODE` | Authentication entirely, and makes a magic login wipe the demo tables. |
| `ARCEO_FAIL_MODE=allow` | Enforcement fails **open** — errors mid-decision return ALLOW. A documented break-glass; the app now logs a loud warning at boot when it is set. |
| `ARCEO_ALLOW_INTERNAL_MCP` | The SSRF guard. See below. |

⚠️ **`ARCEO_ALLOW_INTERNAL_MCP` had no production gate until Tier 2.10.** It
returns before DNS resolution, disabling both the loopback/private/link-local
rejection *and* the DNS-rebind IP pinning, on a path where the URL is
caller-supplied and there is no host allowlist. **On Google Cloud that reaches
`169.254.169.254` — the metadata server that issues service-account tokens.** It
is now gated on `ARCEO_ENV`.

> `docs/security/backend/Dead_Code_Report.md` previously asserted these flags
> were "each fenced against production by an explicit gate." That was true of
> `DEMO_MODE` and **false** of this one, which is a plausible reason it survived
> review. The correction is recorded in that file.

**`ARCEO_ENCRYPT_AT_REST` is required outside dev** — the app refuses to boot
without it, because captured LLM bodies, execution params and held requests must
not sit in cleartext. It needs `ARCEO_VAULT_MASTER_KEY`, or writes fail at
runtime.

## 7. Storage: `/data` is not durable, and the docs used to say it was

`ARCEO_LLM_CACHE_PATH` defaults into `/data`, and the image tells operators this
"keeps cached classifications across restarts." True for `docker run -v`; **false
on any platform with ephemeral container storage**, where the SQLite
classification cache becomes per-instance, RAM-billed, and lost on scale-in.

The consequence is repeat Haiku spend plus classification **non-determinism
across instances**, which contradicts `risk_classifier.py`'s promise that the
same action never flips risk tier across restarts.

⚠️ **Do not "fix" this by moving the cache into Postgres.** Classification runs
*inside* an open application transaction, which is exactly why the cache lives
outside the app database. Either mount durable storage or accept the caveat.

## 8. Session affinity

The mock sandbox holds sessions in process (`_mock_sessions`), so a sandbox run
started on one instance will not find its session on another. A documented,
accepted limit — it holds a live object rather than data, so it is not a
straightforward move to Redis. **Enable session affinity, or accept that mock
sandbox runs must complete against one instance.**

---

## Pre-flight checklist

```
DATABASE_URL                     set, owner role for migrations / arceo_app for the app
REDIS_URL                        set and reachable (Memorystore + VPC connector)
ARCEO_ENV                        UNSET  ← anything else is a dev environment
JWT_SECRET                       set, not the demo default
ANTHROPIC_API_KEY                set
ARCEO_ENCRYPT_AT_REST=1          plus ARCEO_VAULT_MASTER_KEY
ARCEO_RUN_MIGRATIONS_ON_BOOT     unset (off) — migrations are a deploy step
DISABLE_SNAPSHOT_SCHEDULER=true  plus Cloud Scheduler for the three jobs
DEMO_MODE                        UNSET
ARCEO_FAIL_MODE                  unset (block)
ARCEO_ALLOW_INTERNAL_MCP         UNSET
FORWARDED_ALLOW_IPS              UNSET — the Dockerfile pins the flag
TRUSTED_PROXY / _HOPS            both, or neither
readiness probe                  /api/ready   (liveness: /api/health)
after cutover                    scripts/verify_rls_active.py
```
