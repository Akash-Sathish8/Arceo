# Changelog

All notable changes to Arceo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository hygiene: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`,
  pull-request template, `CODEOWNERS`, and Dependabot config.
- Internal engineering docs relocated under `docs/`.

## [0.1.0] — 2026-07-13

First tagged snapshot of the Arceo MVP: predeployment cost + risk governance for
AI agents.

### Added
- **Authority Engine** — blast-radius scoring, an authority graph, and dangerous
  action-chain detection over 10 universal risk labels (32 transition rules).
- **Spend forecaster** — 3-tier confidence forecasting (capability / sandbox ±28% /
  live ±15%) that tightens as real usage data flows in, with an honest "no signal"
  state instead of a fabricated number.
- **Cost Portfolio** — CFO-facing fleet and per-agent spend view with confidence
  bands and PDF export.
- **Sandbox** — single- and multi-agent simulation against 12 mock services, plus
  boundary, red-team, and regression testing.
- **Policy enforcement** — runtime BLOCK / REQUIRE_APPROVAL / ALLOW with conditional
  rules and an approval queue.
- **Agent ingestion** — Anthropic SDK, OpenAI function-calling, MCP live-connect,
  and whole-repo GitHub code scanning.
- **GitHub Action** — Agent Security Scan that scores agent code on every push/PR.
- **Python SDK** — one-line instrumentation for deployed agents.
- **Production hardening** — tamper-evident audit logging, envelope encryption at
  rest, row-level tenant isolation, security headers, and per-caller rate limiting.
- **Deployment** — single-container Docker build (backend + built SPA) suited to a
  customer VPC.

[Unreleased]: https://github.com/Akash-Sathish8/Arceo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Akash-Sathish8/Arceo/releases/tag/v0.1.0
