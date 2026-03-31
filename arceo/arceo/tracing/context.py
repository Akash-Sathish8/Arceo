"""Thread-safe trace context using contextvars."""

from __future__ import annotations
import contextvars

_ctx = contextvars.ContextVar("arceo_trace", default=None)


def get_trace():
    return _ctx.get()

def set_trace(trace):
    return _ctx.set(trace)

def clear_trace(token=None):
    if token:
        _ctx.reset(token)
    else:
        _ctx.set(None)
