"""Single source of truth for every Anthropic model ID the backend calls.

A retired model ID does not crash anything — every call site catches the SDK
error, so simulations quietly become error traces and extraction 502s. That
exact failure shipped once already (a retired Sonnet ID silently zeroed every
LLM simulation). Centralizing the IDs here and verifying them at startup turns
the next retirement into one loud log line and a one-line fix.

Pricing tables in analysis/*.yaml and spend_forecast.py deliberately keep their
own model keys — they price CUSTOMER agents' declared models, which are not
ours to centralize.
"""

import logging
import os

# Sandbox simulation loops, multi-agent coordinator, red-team attacker.
SIM_MODEL = "claude-sonnet-4-6"

# High-volume cheap calls: risk classification, code extraction, LLM mocks,
# executive summaries.
FAST_MODEL = "claude-haiku-4-5-20251001"

# Low-volume deep reasoning: scenario generation.
DEEP_MODEL = "claude-opus-4-8"

ALL_MODELS = (SIM_MODEL, FAST_MODEL, DEEP_MODEL)

logger = logging.getLogger("arceo")

# Bounded timeout for every Anthropic call (MED-004). The SDK defaults to a
# 10-minute timeout, so a slow/hung upstream pins a worker thread for the whole
# window; a burst exhausts the threadpool and turns a latency problem into an
# availability outage. Seconds; override with ARCEO_ANTHROPIC_TIMEOUT.
ANTHROPIC_TIMEOUT = float(os.getenv("ARCEO_ANTHROPIC_TIMEOUT", "60"))


def anthropic_client(api_key: str | None = None):
    """Construct an Anthropic client with a bounded timeout (MED-004).

    Every call site MUST use this rather than anthropic.Anthropic() directly so
    the timeout is applied uniformly. Passing api_key=None makes the SDK read
    ANTHROPIC_API_KEY from the environment, collapsing the old
    `Anthropic(api_key=k) if k else Anthropic()` pattern. The SDK's built-in
    retries (max_retries, default 2) still cover transient errors."""
    import anthropic
    return anthropic.Anthropic(api_key=api_key or None, timeout=ANTHROPIC_TIMEOUT)


# Same reasoning as ANTHROPIC_TIMEOUT, for the OpenAI-compatible path (MED-008).
# The OpenAI SDK defaults to a 600s request timeout, so a hung upstream pinned a
# worker thread for ten minutes — and because these calls run inside the sandbox
# handlers, that directly compounded the threadpool exhaustion in MED-006.
OPENAI_TIMEOUT = float(os.getenv("ARCEO_OPENAI_TIMEOUT", "60"))
OPENAI_MAX_RETRIES = int(os.getenv("ARCEO_OPENAI_MAX_RETRIES", "2"))


def openai_client(api_key: str | None = None, base_url: str | None = None):
    """Construct an OpenAI-compatible client with a bounded timeout (MED-008).

    `base_url` drives the OpenAI-compatible providers the sandbox supports
    (Gemini's OpenAI endpoint, DeepSeek, xAI/Grok, Together, Groq, …). Every call
    site MUST use this rather than OpenAI() directly, so the timeout applies
    uniformly — the same contract anthropic_client() carries. max_retries is
    pinned too: the SDK default retries transient errors silently, multiplying
    both wall-clock latency and token spend per logical call."""
    from openai import OpenAI
    return OpenAI(
        api_key=api_key or os.getenv("OPENAI_API_KEY"),
        base_url=base_url,
        timeout=OPENAI_TIMEOUT,
        max_retries=OPENAI_MAX_RETRIES,
    )


def verify_models_at_startup(api_key: str | None) -> None:
    """Check every model ID resolves against the live Models API.

    Logs loudly and returns — never raises. A dead model ID must not stop the
    server from booting; the point is that the operator finds out at startup
    instead of from a customer's silently-empty simulation.
    """
    if not api_key:
        logger.warning(
            "ANTHROPIC_API_KEY is not set — LLM simulation, extraction, "
            "red-team, and unknown-action classification are all degraded or "
            "unavailable. Set the key before any demo."
        )
        return
    try:
        import anthropic
        client = anthropic_client(api_key)
        for model_id in ALL_MODELS:
            try:
                client.models.retrieve(model_id)
            except anthropic.NotFoundError:
                logger.error(
                    "MODEL ID '%s' DOES NOT RESOLVE on the Anthropic API — "
                    "every feature that calls it will fail silently (error "
                    "traces, 502s). Update llm_models.py now.", model_id,
                )
    except Exception as e:  # network blip, bad key — warn, don't block boot
        logger.warning("Could not verify model IDs at startup: %s", e)
