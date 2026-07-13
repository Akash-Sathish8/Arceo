# Contributing to Arceo

Thanks for working on Arceo. This guide covers local setup, the branch model, and
the checks a change has to pass before it lands.

## Local development

Arceo is three services plus an installable SDK. Each runs independently.

```bash
# Backend — FastAPI Authority Engine (port 8000)
cd backend
python3.11 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env        # required for LLM classification + simulation
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env # never ship the default secret
python -m uvicorn main:app --reload --port 8000

# Frontend — Vite + React 19 dashboard (port 5173)
cd frontend && npm install && npm run dev

# Website — Next.js marketing site (port 3000)
cd website && npm install && npm run dev
```

Or run the whole product as one container:

```bash
docker build -t arceo .
docker run -p 8000:8000 -v arceo-data:/data \
  -e ANTHROPIC_API_KEY=... -e JWT_SECRET=... arceo
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces fit together and
[`CLAUDE.md`](CLAUDE.md) for a deep map of the codebase.

## Branch model

- **`Prod`** — the default, release-ish branch and promote target. Merges into
  `Prod` are deliberate release events.
- **`dev`** — where all active work lands, via feature-branch pull requests.
  **Never push to `dev` directly.**
- Branch off `dev` with a descriptive prefix: `feat/…`, `fix/…`, `chore/…`,
  `docs/…`. GitHub deletes head branches on merge — keep the branch list clean.

## Making a change

1. Branch off `dev`.
2. Keep commits lean and scoped; write a clear message.
3. Run the checks below.
4. Open a PR into `dev` using the pull-request template.

## Tests & checks

```bash
# Backend test suite (CI runs this on every push/PR)
cd backend && pytest

# Frontend build must pass
cd frontend && npm run build
```

CI (`.github/workflows/ci.yml`) runs pytest on push and PR. The conftest isolates
the database via `ARCEO_DB_PATH` and stubs the LLM, so tests need no API key.

## Conventions

- **SQL:** always parameterized (`?` placeholders) — never string interpolation.
- **Multi-tenant:** every query is scoped by `org_id` from the JWT.
- **API client (frontend):** `import { apiFetch } from "@/lib/api"` (auto-attaches the Bearer token).
- **Secrets:** never commit `.env`, `*.db`, keys, or tokens. `.gitignore` covers the common cases; double-check your diff.

## Security

Found a vulnerability? Do **not** open a public issue — follow
[`SECURITY.md`](SECURITY.md).
