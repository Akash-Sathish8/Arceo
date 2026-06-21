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

```python
from anthropic import Anthropic
from arceo import wrap_llm

client = wrap_llm(Anthropic(), "your-agent-id", base_url="https://api.arceo.dev")

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

client = wrap_llm(OpenAI(), "your-agent-id")
client.chat.completions.create(model="gpt-4o", messages=[...])
```

**What's sent:** provider, model, token usage, and request *shape* (message/tool
counts) — **never prompt or response content**. Pass `capture_prompts=True` to
also include the system prompt. Streaming calls (`stream=True`) are skipped
(usage isn't available until the stream is consumed).

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

`enforce` fails **open** by default (an Arceo outage won't halt your agent); pass
`on_error="block"` to fail closed.

## Configuration

Set these in the environment to avoid passing them every call:

- `ARCEO_BASE_URL` — your Arceo backend (default `http://localhost:8000`)
- `ARCEO_TOKEN` — your Arceo JWT (for `enforce`; capture is unauthenticated)
