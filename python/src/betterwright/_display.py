"""Detect whether a graphical display is available.

Used to resolve ``headless="auto"``: run a visible browser when there is a
screen to show it on, and fall back to headless on servers, containers, and CI.
The checks are deliberately conservative heuristics — pass ``headless=True`` or
``headless=False`` explicitly to override.
"""

from __future__ import annotations

import os
import sys


def display_available() -> bool:
    """Return ``True`` when a GUI session appears to be present."""

    # An explicit override wins, so automation can force a choice.
    forced = os.environ.get("BETTERWRIGHT_DISPLAY", "").strip().lower()
    if forced in {"1", "true", "yes", "on"}:
        return True
    if forced in {"0", "false", "no", "off"}:
        return False

    if sys.platform == "darwin":
        # macOS almost always has a window server for a logged-in user. Treat a
        # pure SSH session (no local Aqua session) as headless.
        return not (os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"))

    if sys.platform.startswith("win"):
        # Assume a desktop unless running in a non-interactive service session.
        return os.environ.get("SESSIONNAME", "").strip().lower() != "services"

    # X11 / Wayland (Linux, BSD): a display is advertised via these variables.
    return bool(
        os.environ.get("DISPLAY", "").strip()
        or os.environ.get("WAYLAND_DISPLAY", "").strip()
    )


def resolve_headless(headless: bool | str) -> bool:
    """Resolve a ``headless`` setting of ``True``/``False``/``"auto"``."""

    if isinstance(headless, str):
        if headless.strip().lower() == "auto":
            return not display_available()
        raise ValueError('headless must be True, False, or "auto"')
    return bool(headless)


__all__ = ["display_available", "resolve_headless"]
