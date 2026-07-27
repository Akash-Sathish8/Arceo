# Arceo — single-container image: the FastAPI backend serving the built React
# SPA. main.py already serves backend/static/ as the SPA when that directory
# exists, so this image just builds the frontend into it. One container, one
# port — suited to running in a customer's own VPC.
#
# Build:  docker build -t arceo .
# Run:    docker run -p 8000:8000 \
#           -e DATABASE_URL=postgresql://user:pass@host:5432/arceo \
#           -e ANTHROPIC_API_KEY=sk-ant-... \
#           -e JWT_SECRET=<openssl rand -hex 32> \
#           arceo
#
# Runtime env: DATABASE_URL (required — the Postgres instance; the app refuses
# to boot on known prod platforms without it and migrates schema on startup),
# ANTHROPIC_API_KEY (required — classification, simulation, forecasting),
# JWT_SECRET (required — auth warns on the dev default), DEMO_MODE=true (demo
# instances only: enables the `demo` login wipe), CORS_ORIGINS (only if the
# frontend is hosted on another origin), ARCEO_LLM_CACHE_PATH (optional — the
# LLM-classification cache, a local SQLite file; point it at /data to keep
# cached classifications across restarts).

FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# No VITE_API_URL: the SPA defaults to same-origin API calls, which is exactly
# right when the backend serves it.
RUN npm run build

FROM python:3.11-slim
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
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health', timeout=4).status == 200 else 1)"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
