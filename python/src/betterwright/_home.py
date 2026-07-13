"""Resolution of the BetterWright state directory.

Everything BetterWright persists — the browser profile, artifacts, downloads,
the credential vault, and the private Node runtime installed by
``betterwright setup`` — lives under one directory so that it is easy to
inspect, back up, or delete.
"""

from __future__ import annotations

import os
from pathlib import Path

_ENV_VAR = "BETTERWRIGHT_HOME"


def betterwright_home() -> Path:
    """Return the state directory, honoring ``BETTERWRIGHT_HOME``.

    Defaults to ``~/.betterwright``. The directory is not created here;
    components create the subdirectories they own with restrictive modes.
    """

    configured = os.environ.get(_ENV_VAR, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".betterwright").resolve()


__all__ = ["betterwright_home"]
