"""Launch or reuse a dedicated, persistent Google Chrome CDP endpoint.

This is the Python twin of ``src/chrome.mjs``. It powers ``connect_over_cdp=
"auto"``: reuse a debug Chrome if one is already listening, otherwise start a
real Google Chrome with a persistent BetterWright profile and attach to that.

The persistent profile (``~/.betterwright/chrome-cdp-profile``) is where you
install and unlock a password-manager extension (e.g. 1Password) once; every
later run reuses the same signed-in browser state instead of a throwaway
automation profile. BetterWright never points remote debugging at your everyday
Chrome profile — Chrome 136+ refuses the debug port on the default profile.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from betterwright._home import betterwright_home

_DEFAULT_CDP_PORT = 9223
_START_TIMEOUT_SECONDS = 12.0


def chrome_executable_candidates(platform: str | None = None) -> list[str]:
    """Return likely Google Chrome executable paths for the current platform."""

    platform = platform or sys.platform
    home = Path.home()
    if platform == "darwin":
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            str(home / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    if platform == "win32":
        program_files = os.environ.get("PROGRAMFILES", "C:\\Program Files")
        program_files_x86 = os.environ.get(
            "PROGRAMFILES(X86)", "C:\\Program Files (x86)"
        )
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        return [
            str(Path(program_files) / "Google/Chrome/Application/chrome.exe"),
            str(Path(program_files_x86) / "Google/Chrome/Application/chrome.exe"),
            str(Path(local_appdata) / "Google/Chrome/Application/chrome.exe"),
        ]
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]


def find_chrome_executable(explicit: str = "") -> str | None:
    """Return the first existing Chrome binary, honoring an explicit path."""

    requested = str(explicit or "").strip()
    if requested and Path(requested).exists():
        return requested
    for candidate in chrome_executable_candidates():
        if Path(candidate).exists():
            return candidate
    return None


def _endpoint_ready(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed localhost debug URL
            f"{endpoint}/json/version", timeout=0.75
        ) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return False
    return bool(payload.get("webSocketDebuggerUrl"))


def ensure_chrome_cdp(
    *,
    home: str | Path | None = None,
    port: int | None = None,
    executable_path: str = "",
    timeout: float | None = None,
) -> dict[str, object]:
    """Start (or reuse) a dedicated, persistent Google Chrome CDP profile.

    Returns ``{"endpoint", "profile_dir", "started"}``. ``started`` is ``False``
    when an already-running debug Chrome was reused.
    """

    configured_home = (
        Path(home).expanduser()
        if home
        else (
            Path(os.environ["BETTERWRIGHT_HOME"]).expanduser()
            if os.environ.get("BETTERWRIGHT_HOME", "").strip()
            else betterwright_home()
        )
    )
    resolved_port = max(1024, min(int(port or _DEFAULT_CDP_PORT), 65535))
    endpoint = f"http://127.0.0.1:{resolved_port}"
    profile_dir = configured_home / "chrome-cdp-profile"

    if _endpoint_ready(endpoint):
        return {"endpoint": endpoint, "profile_dir": str(profile_dir), "started": False}

    executable = find_chrome_executable(executable_path)
    if not executable:
        raise RuntimeError("Google Chrome is not installed.")
    profile_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.Popen(  # noqa: S603 - fixed args, resolved Chrome binary
        [
            executable,
            f"--remote-debugging-port={resolved_port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    deadline = time.monotonic() + max(
        float(timeout or _START_TIMEOUT_SECONDS), 1.0
    )
    while time.monotonic() < deadline:
        if _endpoint_ready(endpoint):
            return {
                "endpoint": endpoint,
                "profile_dir": str(profile_dir),
                "started": True,
            }
        time.sleep(0.15)
    raise RuntimeError(
        f"Google Chrome did not open its debugging endpoint at {endpoint}."
    )


__all__ = [
    "chrome_executable_candidates",
    "ensure_chrome_cdp",
    "find_chrome_executable",
]
