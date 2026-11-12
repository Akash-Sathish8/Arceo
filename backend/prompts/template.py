"""Prompt templates: `{{variable}}` placeholders and how to fill them for scoring."""

from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, Field

VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


class VariableSpec(BaseModel):
    """What the author tells us about one `{{variable}}`.

    `untrusted` marks content the prompt's user pastes in from elsewhere (an
    email, a web page, a client doc). None means "not declared": the danger
    scorer then infers it from the variable's name.
    """
    sample: Optional[str] = Field(default=None, max_length=200_000)
    expected_tokens: Optional[int] = Field(default=None, ge=0, le=2_000_000)
    untrusted: Optional[bool] = None


def variables_in(body: str) -> list[str]:
    """Placeholder names in first-appearance order, deduplicated."""
    seen: dict[str, None] = {}
    for m in VAR_RE.finditer(body or ""):
        seen.setdefault(m.group(1), None)
    return list(seen)


def render(body: str, variables: dict[str, VariableSpec]) -> tuple[str, int, list[str]]:
    """Fill placeholders for token counting.

    Returns (rendered_text, declared_tokens, unsized):
      - a placeholder with a `sample` is replaced by it, and the tokenizer counts it
      - one with only `expected_tokens` is removed from the text, and its declared
        count is returned separately, because counting synthetic filler would
        measure the filler, not the content
      - `unsized` placeholders have neither; they contribute zero, so the
        caller must disclose that the input count is a floor
    """
    unsized: list[str] = []
    declared = 0

    def _fill(m: re.Match) -> str:
        nonlocal declared
        name = m.group(1)
        spec = variables.get(name)
        if spec and spec.sample is not None:
            return spec.sample
        if spec and spec.expected_tokens:
            declared += spec.expected_tokens
            return ""
        if name not in unsized:
            unsized.append(name)
        return ""

    return VAR_RE.sub(_fill, body or ""), declared, unsized
