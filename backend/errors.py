"""What the client is told vs what the server records (MED-016).

Several handlers raised `HTTPException` with `str(e)` interpolated straight into
`detail`, which put upstream response bodies, internal URLs and third-party
library internals in front of whoever made the request. Two of them were also
probe oracles: the service proxy and the MCP connect path reported what the
server saw when it reached an address the *caller* supplied, which turns an
error message into a scanner.

The fix is not to swallow the detail — a 502 nobody can diagnose is its own
problem, and at least one of these sites was not logging the exception at all,
so redacting the response would have destroyed the only copy. Instead the detail
MOVES: each call site logs the exception in full against a short reference and
returns only that reference, so an operator can still join a user's bug report
to a traceback without the traceback being the response body.
"""

from __future__ import annotations

import logging
import uuid


def log_and_ref(logger: logging.Logger, where: str, exc: BaseException) -> str:
    """Log `exc` in full; return a short reference to quote to the client.

    `where` is a fixed, developer-written label for the failing operation — never
    caller-supplied text, so the log line itself stays unforgeable (see
    redaction.log_safe for values that do come from callers).

    The reference is random per occurrence and carries no information about the
    failure: it is a join key for the logs, not an encoding of the error.
    """
    ref = uuid.uuid4().hex[:12]
    logger.warning(
        "%s failed [ref=%s]: %s: %s", where, ref, type(exc).__name__, exc, exc_info=True
    )
    return ref
