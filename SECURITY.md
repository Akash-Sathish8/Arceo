# Security Policy

Arceo is a security product — we hold ourselves to the bar we sell. If you find a
vulnerability, we want to hear about it before anyone else does.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Email **security@arceo.io** (or, until that inbox is live,
`akakash.sathish@gmail.com`) with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected component (backend / frontend / SDK / GitHub Action) and version or commit

We aim to acknowledge reports within **2 business days** and to provide a
remediation timeline within **5 business days**. We will keep you updated through
resolution and credit you if you'd like.

## Scope

In scope: the backend Authority Engine, the dashboard, the Python SDK, the
GitHub Action, and the container image in this repository.

Out of scope: findings that require a compromised host or physical access,
denial-of-service via volumetric traffic, and reports against third-party
dependencies without a demonstrated exploit path in Arceo.

## Supported versions

Arceo is pre-1.0 and ships from `Prod`. Security fixes land on `Prod`; there are
no maintained release branches yet.

## Security architecture

The engineering design behind Arceo's own security posture — tamper-evident audit
logging, envelope encryption at rest, row-level tenant isolation, and the
credential vault — is documented in [`docs/SECURITY_DESIGN.md`](docs/SECURITY_DESIGN.md).
