# Arceo SDK

Capture your AI agent's LLM calls so Arceo can forecast its cost — and enforce
your policies at runtime. **Zero dependencies** (stdlib only); it sits alongside
your existing `anthropic` or `openai` client.

## Install

```bash
pip install -e sdk        # from the repo root
# or, once published:
pip install arceo
```

> Dev note: if you `import arceo` while your shell is *inside* this repo's root,
> Python finds the repo's own `arceo/` folder (backend/frontend) first. Run from
> any other directory — a real consumer project won't have that folder.

## Capture LLM calls → cost forecast

Wrap your client once. Every completion's token usage is reported to Arceo
(async, best-effort — it never changes the response or raises). After ~50 calls
in a 7-day window your forecast moves to its high-confidence (±15%) tier.

Capture is **authenticated**: mint an API key (Settings → API keys, or
`POST /api/keys`) and pass it as `api_key=` (or set `ARCEO_API_KEY`). Without a
valid key the capture endpoint returns 401 and — because capture is best-effort
— the call is silently dropped and nothing is recorded. `base_url` is *your*
Arceo instance (default `http://localhost:8000`); there is no hosted Arceo, so
point it at wherever you run the backend.

```python
from anthropic import Anthropic
from arceo import wrap_llm

client = wrap_llm(
    Anthropic(), "your-agent-id",
    base_url="http://localhost:8000",   # your Arceo instance
    api_key="ag_...",                    # from Settings → API keys (or set ARCEO_API_KEY)
)

client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=512,
    messages=[{"role": "user", "content": "hi"}],
)
# ↑ usage reported to Arceo automatically
```

OpenAI works the same way:

```python
from openai import OpenAI
from arceo import wrap_llm

client = wrap_llm(OpenAI(), "your-agent-id", api_key="ag_...")
client.chat.completions.create(model="gpt-4o", messages=[...])
```

**What's sent:** provider, model, token usage, and request *shape* (message/tool
counts) — **never prompt or response content**. Pass `capture_prompts=True` to
also include the system prompt.

**Streaming (`stream=True`) is captured too (0.4.0).** The returned stream is
wrapped in a transparent proxy that reports usage once you finish consuming it —
your loop is unchanged:

```python
client = wrap_llm(Anthropic(), "your-agent-id")
stream = client.messages.create(model="claude-...", messages=[...], max_tokens=1024, stream=True)
for event in stream:
    ...
# ↑ usage reported after the stream is fully consumed
```

- **Anthropic** always works — usage rides in the stream events.
- **OpenAI** reports usage only when you pass `stream_options={"include_usage": True}`;
  without it the API never sends usage, so there is nothing honest to report and
  the call is skipped (no crash, no guessed numbers).

Already have the raw response and want to report it yourself?

```python
from arceo import report_llm_call
report_llm_call("your-agent-id", provider="anthropic", model="claude-sonnet-4-6", response=resp)
```

## Enforce policies at runtime

Check a tool call against your Arceo policies before you run it:

```python
from arceo import enforce

decision = enforce("your-agent-id", "stripe", "create_refund",
                   {"amount": 500}, token="<your-arceo-jwt>")

if decision["decision"] == "ALLOW":
    stripe.refunds.create(...)
elif decision["decision"] == "REQUIRE_APPROVAL":
    queue_for_human(decision)
else:  # BLOCK
    raise PermissionError(decision.get("reason"))
```

### Chain policies (`requires_prior`)

A policy can require that another action ran earlier this session before it
allows a dangerous one (e.g. "refund only after a customer lookup"). These fire
**only when the check carries the prior actions** — otherwise the condition is
treated as unmet and the guarded action falls through. Use `ArceoClient`, which
remembers each `ALLOW`ed action and replays them automatically:

```python
from arceo import ArceoClient

arceo = ArceoClient(base_url="http://localhost:8000", token="<jwt>")
arceo.enforce("your-agent-id", "stripe", "get_customer", {"id": "cus_1"})   # remembered
arceo.enforce("your-agent-id", "stripe", "create_refund", {"amount": 500})  # sees the prior
# arceo.reset_session()  # clear the tracked priors at a task boundary
```

Prefer the raw `enforce()`? Pass the priors yourself:
`enforce(..., session_context=["stripe.get_customer"])`. If you author a
`requires_prior` policy but your traffic never carries context, the agent's
dashboard flags the policy as **inert** so the gap is visible.

> **Breaking change in 0.2.0:** `enforce` now fails **closed** by default — if
> Arceo is unreachable, the decision is `BLOCK` and the action must not run.
> Opt out per call with `on_error="allow"`, or process-wide with
> `ARCEO_FAIL_MODE=allow` (the break-glass so an Arceo outage doesn't halt
> your agents). An explicit `on_error=` argument always wins over the env var.

### Wait for a human (0.3.0)

When an action needs a person's sign-off, `enforce_and_wait` blocks right there
until they decide — no polling loop to write yourself:

```python
from arceo import enforce_and_wait

decision = enforce_and_wait("your-agent-id", "stripe", "create_refund",
                            {"amount": 5000}, token="<your-arceo-jwt>")

if decision["decision"] == "ALLOW":      # a human approved
    stripe.refunds.create(...)
else:                                     # BLOCK = rejected (or PENDING if max_wait hit)
    log.info("refund not approved")
```

`ALLOW`/`BLOCK` return immediately; `REQUIRE_APPROVAL` polls the held action
until a teammate approves or rejects it in the Arceo dashboard. It waits
indefinitely by default (Arceo never expires a pending action); pass
`max_wait=<seconds>` to give up and get back `{"decision": "PENDING"}`.

## Configuration

Set these in the environment to avoid passing them every call:

- `ARCEO_BASE_URL` — your Arceo backend (default `http://localhost:8000`). There
  is no hosted Arceo; this is whatever host you run the backend on.
- `ARCEO_API_KEY` — an Arceo X-API-Key (mint at Settings → API keys or
  `POST /api/keys`). **Required for capture** — the `/api/agent/{id}/llm-call`
  endpoint 401s without it and capture is silently dropped. Also accepted by
  `enforce`.
- `ARCEO_TOKEN` — your Arceo JWT, an alternative credential for `enforce`
  (`enforce` accepts either a JWT or an X-API-Key).
- `ARCEO_FAIL_MODE` — `block` (default) or `allow`; the process-wide fallback
  when Arceo is unreachable during `enforce`.
