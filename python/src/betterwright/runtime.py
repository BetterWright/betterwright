"""Locate the Node worker and its pinned Playwright build.

BetterWright ships a single ``worker.mjs`` and runs it with the system Node.
The worker needs a Playwright build to drive Chromium. It is resolved, in order:

1. ``BETTERWRIGHT_PLAYWRIGHT_CORE_PATH`` if it points at a ``playwright-core``
   package directory (an explicit override, mainly for packagers).
2. A ``node_modules/playwright-core`` next to the installed package (present
   when BetterWright was installed from npm or via ``betterwright setup``).
3. ``node_modules/playwright-core`` under ``BETTERWRIGHT_HOME`` (where
   ``betterwright setup`` installs it for pip-only users).

``betterwright setup`` performs step 3 for both Playwright and CloakBrowser and
downloads the signed managed browser binary from CloakHQ.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from betterwright._home import betterwright_home

#: Playwright is pinned so the worker, the JS facades it relies on, and the
#: downloaded Chromium revision always agree. Bumping this is a deliberate,
#: tested change, not something a user should have to think about.
PINNED_PLAYWRIGHT_VERSION = "1.61.1"
PINNED_CLOAKBROWSER_VERSION = "0.4.10"

_WORKER_FILENAME = "worker.mjs"


def worker_path() -> Path:
    """Absolute path to the bundled Node worker."""

    return (Path(__file__).resolve().parent / "_worker" / _WORKER_FILENAME).resolve()


def node_executable() -> str | None:
    """Path to the ``node`` binary, or ``None`` if it is not on ``PATH``."""

    return shutil.which(os.environ.get("BETTERWRIGHT_NODE", "node"))


def _package_version(package_dir: Path) -> str | None:
    try:
        data = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = data.get("version")
    return version if isinstance(version, str) else None


def _ancestor_node_packages(package: str) -> tuple[Path, ...]:
    package_dir = Path(__file__).resolve().parent
    return tuple(
        parent / "node_modules" / package
        for parent in (package_dir, *package_dir.parents)
    )


def _candidate_core_dirs() -> tuple[Path, ...]:
    candidates: list[Path] = []
    override = os.environ.get("BETTERWRIGHT_PLAYWRIGHT_CORE_PATH", "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    # Mirror Node's ancestor node_modules lookup for editable/monorepo installs.
    candidates.extend(_ancestor_node_packages("playwright-core"))
    # The location ``betterwright setup`` installs into for pip-only users.
    candidates.append(betterwright_home() / "node" / "node_modules" / "playwright-core")
    return tuple(candidates)


def playwright_core_dir() -> Path | None:
    """Return the pinned ``playwright-core`` directory, or ``None`` if missing."""

    for candidate in _candidate_core_dirs():
        if _package_version(candidate) == PINNED_PLAYWRIGHT_VERSION:
            return candidate.resolve()
    return None


def _candidate_cloak_dirs() -> tuple[Path, ...]:
    candidates: list[Path] = []
    override = os.environ.get("BETTERWRIGHT_CLOAKBROWSER_PATH", "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend(_ancestor_node_packages("cloakbrowser"))
    candidates.append(betterwright_home() / "node" / "node_modules" / "cloakbrowser")
    return tuple(candidates)


def cloakbrowser_dir() -> Path | None:
    """Return the pinned CloakBrowser wrapper directory, if installed."""

    for candidate in _candidate_cloak_dirs():
        if _package_version(candidate) == PINNED_CLOAKBROWSER_VERSION:
            return candidate.resolve()
    return None


def _cloak_binary_info(node: str | None, cloak: Path | None) -> dict | None:
    if not node or not cloak:
        return None
    entrypoint = (cloak / "dist" / "index.js").resolve().as_uri()
    script = (
        f"const m=await import({entrypoint!r});"
        "console.log(JSON.stringify(m.binaryInfo()));"
    )
    try:
        completed = subprocess.run(
            [node, "--input-type=module", "-e", script],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if completed.returncode == 0:
            data = json.loads(completed.stdout.strip())
            return data if isinstance(data, dict) else None
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def runtime_install_root() -> Path:
    """Directory ``betterwright setup`` installs the private Node runtime into."""

    return betterwright_home() / "node"


def diagnose() -> dict:
    """Return a structured readiness report used by the CLI's ``doctor`` command."""

    node = node_executable()
    core = playwright_core_dir()
    cloak = cloakbrowser_dir()
    cloak_binary = _cloak_binary_info(node, cloak)
    browser = os.environ.get("BETTERWRIGHT_BROWSER", "cloak").strip().lower()
    report = {
        "node": node,
        "node_ok": node is not None,
        "worker": str(worker_path()),
        "worker_ok": worker_path().is_file(),
        "playwright_core": str(core) if core else None,
        "playwright_version": PINNED_PLAYWRIGHT_VERSION,
        "playwright_ok": core is not None,
        "cloakbrowser": str(cloak) if cloak else None,
        "cloakbrowser_version": PINNED_CLOAKBROWSER_VERSION,
        "cloakbrowser_binary": cloak_binary.get("binaryPath") if cloak_binary else None,
        "cloakbrowser_ok": bool(cloak_binary and cloak_binary.get("installed")),
        "browser": browser,
    }
    report["ready"] = all(
        (
            report["node_ok"],
            report["worker_ok"],
            report["playwright_ok"],
            report["cloakbrowser_ok"] if browser != "chromium" else True,
        )
    )
    return report


__all__ = [
    "PINNED_PLAYWRIGHT_VERSION",
    "PINNED_CLOAKBROWSER_VERSION",
    "cloakbrowser_dir",
    "diagnose",
    "node_executable",
    "playwright_core_dir",
    "runtime_install_root",
    "worker_path",
]
