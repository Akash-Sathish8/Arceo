# Arceo — single-container image: the FastAPI backend serving the built React
# SPA. main.py already serves backend/static/ as the SPA when that directory
# exists, so this image just builds the frontend into it. One container, one
# port — suited to running in a customer's own VPC.
#
# Build:  docker build -t arceo .
# Run:    docker run -p 8000:8000 \
#           -e DATABASE_URL=postgresql://user:pass@host:5432/arceo \
#           -e REDIS_URL=redis://host:6379/0 \
#           -e ANTHROPIC_API_KEY=sk-ant-... \
#           -e JWT_SECRET=<openssl rand -hex 32> \
#           arceo
#
# ⚠️ REDIS_URL is REQUIRED and there is no Redis in this image. Omitting it used
# to leave the container pointing at redis://localhost:6379 INSIDE itself, where
# nothing listens — and because rate limiting fails closed, that container comes
# up healthy and 429s every login. It now refuses to boot instead (Tier 2.3).
#
# Runtime env: DATABASE_URL (required — the Postgres instance; the app refuses
# to boot WITHOUT it unless ARCEO_ENV names a dev environment, and migrates
# schema on startup. Do NOT set ARCEO_ENV here: it is the switch that disables
# every boot guard, and this image is meant for real deploys),
# ANTHROPIC_API_KEY (required — classification, simulation, forecasting),
# REDIS_URL (required — rate limiting, live-trace fan-out and the leader lock;
# fails closed, so an unreachable Redis 429s every request path that checks a
# limit), JWT_SECRET (required — auth warns on the dev default),
# ARCEO_RUN_MIGRATIONS_ON_BOOT (default off here: migrations need the owner role,
# the app runs as arceo_app — see docs/MIGRATION_RUNBOOK.md), DEMO_MODE=true (demo
# instances only: enables the `demo` login wipe), CORS_ORIGINS (only if the
# frontend is hosted on another origin), ARCEO_LLM_CACHE_PATH (optional — the
# LLM-classification cache, a local SQLite file; point it at /data to keep
# cached classifications across restarts).

# LOW-011: pin base images by digest for reproducible, tamper-evident builds.
# Refresh with: docker manifest inspect node:22-alpine (and python:3.11-slim).
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# No VITE_API_URL: the SPA defaults to same-origin API calls, which is exactly
# right when the backend serves it.
RUN npm run build

FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93
WORKDIR /app
# Install from the hash-pinned lockfile so the image is reproducible and every
# wheel's integrity is verified (MED-012). requirements.txt stays the source;
# regenerate the lock with: pip-compile --generate-hashes requirements.txt
COPY backend/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY backend/ ./
COPY --from=frontend /build/dist ./static

RUN useradd --create-home arceo && mkdir -p /data && chown -R arceo:arceo /data /app
USER arceo

ENV ARCEO_LLM_CACHE_PATH=/data/llm_cache.db
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["sh", "-c", "python -c \"import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','8000')+'/api/health', timeout=4).status == 200 else 1)\""]

# --forwarded-allow-ips is pinned deliberately, and must not be removed.
#
# uvicorn's ProxyHeadersMiddleware is ON by default and, when its trusted set is
# "*", returns x_forwarded_for[0] — the LEFT-MOST, caller-written hop — and
# overwrites request.client.host with it, UPSTREAM of our own client_ip(). The
# standard Cloud Run recipe is FORWARDED_ALLOW_IPS=*, so following it would
# reintroduce the exact spoof Tier 2.4 removes, silently, even with
# TRUSTED_PROXY off. (Verified against the pinned uvicorn 0.52.1.)
#
# Pinning the flag here beats the env var, so setting FORWARDED_ALLOW_IPS in the
# deploy environment can no longer take effect. Keeping it at loopback makes the
# middleware inert: request.client.host stays the real peer, and ONE place
# decides who the caller is — client_ip(), with an explicit hop count.
# Shell form so ${PORT} expands, with `exec` so uvicorn stays PID 1 and still
# receives SIGTERM. Nothing in backend/ reads PORT, and the port was hardcoded to
# 8000 — but Cloud Run injects PORT (8080 by default) and routes to it, so a
# by-the-book deploy started a server nobody could reach unless the revision
# explicitly overrode containerPort. Honouring $PORT removes the footgun instead
# of documenting a workaround for it; it still defaults to 8000 everywhere else.
CMD ["sh", "-c", "exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --forwarded-allow-ips 127.0.0.1"]
