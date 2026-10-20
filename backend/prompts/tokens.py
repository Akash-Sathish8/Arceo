"""Token counting for prompt scoring.

Three bases, best first. The basis is always returned so the UI can say how
much to trust the count:
  "exact"     - the provider's own tokenizer (Anthropic count_tokens API, or
                tiktoken for OpenAI models when the package is installed)
  "heuristic" - ~4 chars/token scaled by the catalog row's tokenizer_inflation,
                the same rule the agent forecaster uses for system prompts
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger("arceo")

CHARS_PER_TOKEN = 4

try:  # optional: not in the hash-locked requirements, so never required
    import tiktoken  # type: ignore
except Exception:  # pragma: no cover - absence is the normal case
    tiktoken = None  # type: ignore


def _heuristic(text: str, inflation: float = 1.0) -> int:
    if not text:
        return 0
    return max(1, round(len(text) / CHARS_PER_TOKEN * (inflation or 1.0)))


def _anthropic_count(text: str, model: str) -> Optional[int]:
    """Exact count via the free count_tokens endpoint; None on any failure.

    Unmetered client: count_tokens is not billed, so it must not reach COGS.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        from llm_models import anthropic_client
        client = anthropic_client(meter=False)
        resp = client.messages.count_tokens(
            model=model, messages=[{"role": "user", "content": text or " "}],
        )
        return int(resp.input_tokens)
    except Exception as exc:  # network, unknown model id, SDK drift
        logger.info("prompt count_tokens fell back to heuristic: %s", type(exc).__name__)
        return None


def _openai_count(text: str, model: str) -> Optional[int]:
    if tiktoken is None:
        return None
    try:
        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("o200k_base")
        return len(enc.encode(text or ""))
    except Exception:
        return None


def count_tokens(text: str, model_key: str, provider: Optional[str],
                 inflation: float = 1.0, *, allow_network: bool = True) -> tuple[int, str]:
    """(tokens, basis) for `text` as `model_key` would bill it."""
    n: Optional[int] = None
    if provider == "Anthropic" and allow_network:
        n = _anthropic_count(text, model_key)
    elif provider == "OpenAI":
        n = _openai_count(text, model_key)
    if n is not None:
        return n, "exact"
    return _heuristic(text, inflation), "heuristic"
