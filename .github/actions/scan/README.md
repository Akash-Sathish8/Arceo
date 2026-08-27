# Arceo Agent Security Scan — GitHub Action

Scan AI agent code on every push and PR. On each run, Arceo extracts the agent's tool tree, computes a **blast-radius score** (0–100), detects **dangerous risk-label chains** (e.g. `touches_pii → sends_external`), and posts a markdown report as a PR comment. The build fails if the score exceeds your threshold or if any critical chain is detected.

## Quick start

1. **Generate an API key.** Log into your Arceo dashboard → Settings → API Keys → "New Key." Copy it once — you won't see it again.
2. **Add it to your repo's secrets.** In GitHub: Settings → Secrets and variables → Actions → New repository secret. Name: `ARCEO_API_KEY`. Value: the key from step 1.
3. **Add the workflow.** Create `.github/workflows/arceo.yml` in your repo:

```yaml
name: Arceo Agent Security

on:
  push:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Akash-Sathish8/Arceo/.github/actions/scan@dev
        with:
          api-key: ${{ secrets.ARCEO_API_KEY }}
          threshold: 60
```

Push the file and open a PR — the scan runs automatically.

## Inputs

| Name | Default | Description |
|---|---|---|
| `api-key` | _required_ | Arceo API key. Use a repo secret. |
| `api-url` | _(none — required)_ | The base URL of your Arceo instance, e.g. `https://arceo.your-company.com`. There is no hosted default. |
| `threshold` | `60` | Fail the build when any agent's blast radius score exceeds this. |
| `comment-mode` | `pr-comment` | `pr-comment` posts the report to the PR; `none` skips the comment but still writes to the step summary. |
| `paths` | `.py,.ts,.tsx,.js,.jsx,.mjs` | Comma-separated extensions to scan. |
| `max-files` | `25` | Cap on files sent per run. |
| `github-token` | `${{ github.token }}` | Used for posting PR comments — defaults to the workflow's token. |

## What gets scanned

The action filters changed files by extension and a substring scan for LLM SDK indicators (`anthropic`, `openai`, `langchain`, `@tool`, `messages.create`, `crewai`, MCP, AutoGen, LlamaIndex, etc.). Only files that look like agents are sent to Arceo — your other source code is ignored.

## Exit codes

- `0` — `pass` or `warn`
- `1` — `fail` (max blast radius exceeded threshold, or one or more critical chains detected)

## Verdict logic

| Verdict | Trigger |
|---|---|
| `fail` | `critical_chains > 0` OR `max_blast_radius > threshold` |
| `warn` | `max_blast_radius` within 20 points of `threshold` |
| `pass` | otherwise |

## Local testing

You can run the script directly against a local Arceo backend:

```bash
ARCEO_API_KEY=ag_xxx ARCEO_API_URL=http://localhost:8000 \
  python .github/actions/scan/run.py
```

Or run the action in a local GitHub runner with [`act`](https://github.com/nektos/act):

```bash
act pull_request \
  -s ARCEO_API_KEY=ag_xxx \
  -s ARCEO_API_URL=http://host.docker.internal:8000
```

## Cost guardrails

The action enforces caps to prevent runaway Haiku spend:
- Max 25 files per scan (`max-files` input)
- Max 200KB per file (server-side)
- Quick substring filter happens client-side before any LLM call
