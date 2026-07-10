"""Arceo SDK.

Two things, zero dependencies:

  wrap_llm(client, agent_id)  — capture every LLM completion so Arceo can
                                forecast your agent's cost and tighten it with
                                real usage. Capture is async + best-effort and
                                never changes the response or raises.

  enforce(agent_id, ...)      — check a tool call against your Arceo policies
                                before you run it (ALLOW / BLOCK / REQUIRE_APPROVAL).

Quickstart:

    from anthropic import Anthropic
    from arceo import wrap_llm

    client = wrap_llm(Anthropic(), "your-agent-id", base_url="https://api.arceo.dev")
    client.messages.create(model="claude-sonnet-4-6", max_tokens=512, messages=[...])
    # ^ usage is reported to Arceo automatically

Set ARCEO_BASE_URL (and ARCEO_TOKEN for enforce) in the environment to avoid
passing them on every call.
"""

from ._capture import wrap_llm, report_llm_call
from ._enforce import enforce, ArceoClient

__all__ = ["wrap_llm", "report_llm_call", "enforce", "ArceoClient"]
__version__ = "0.2.0"
