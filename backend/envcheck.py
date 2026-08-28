"""What counts as a development environment — one answer, for every boot guard.

Arceo has several fail-closed guards that must all agree on the same question:
*is this a real deploy?* The JWT default-secret guard, the DEMO_MODE bypass
guard, the encryption-at-rest guard, the LLM-proxy key requirement and the
database-URL guard each refuse to run in production unless explicitly
configured, and each of them decides "production" by asking whether `ARCEO_ENV`
names a dev environment.

Until now every one of them carried its own copy of that set. Four copies of a
security-relevant constant is how guards drift into disagreeing: the day someone
adds "staging" or "sandbox" to one of them, the others keep failing closed and
the deploy half-boots with one protection silently disabled. There is nothing to
notice, because each file still looks correct on its own.

⚠️ This module must stay a LEAF — it imports nothing from the app. `auth.py`
imports `db.py`, so `db.py` cannot import `auth.py`; putting the constant here
instead of in either of them is what makes it reachable from both.

## The pattern these guards share, and why it is an allowlist of dev

Every guard is written as "refuse UNLESS `ARCEO_ENV` opts in", never as "refuse
IF this looks like production". `auth.py:26-29` records why: the original guards
whitelisted four PaaS environment variables (`RAILWAY_ENVIRONMENT`,
`FLY_APP_NAME`, `RENDER`, `PRODUCTION`) and let *everything else* — bare VMs,
Docker, a tunnelled laptop, and as it turned out Google Cloud Run — through as
though it were a developer's machine.

An allowlist of platforms fails open on every platform it has not heard of. An
allowlist of dev fails closed on everything, and the cost is one environment
variable on a laptop.
"""

from __future__ import annotations

import os

#: The only values of ARCEO_ENV that mean "this is not a real deploy".
#: Adding to this set weakens EVERY boot guard at once — which is the point of
#: it living in one place, but it means a change here is a security review, not
#: a config tweak.
DEV_ENVS = frozenset({"dev", "local", "test", "ci"})


def arceo_env() -> str:
    """The current `ARCEO_ENV`, lowercased; empty string when unset.

    Read live rather than captured at import so tests can monkeypatch it. The
    guards that run at import time (auth.py) necessarily snapshot it anyway.
    """
    return os.getenv("ARCEO_ENV", "").lower()


def is_dev_env() -> bool:
    """True only when `ARCEO_ENV` explicitly names a dev environment.

    Unset counts as production. That is deliberate: forgetting the variable on a
    laptop costs you a startup error with instructions, while forgetting it on a
    deploy would otherwise cost you the guard.
    """
    return arceo_env() in DEV_ENVS
