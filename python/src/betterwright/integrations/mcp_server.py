"""A Model Context Protocol server exposing BetterWright as a browser tool.

This lets any MCP client — Claude Code, Cursor, Windsurf, and others — drive a
persistent, policy-guarded browser. It exposes one tool, ``browser``, that runs
async Playwright JavaScript, plus a ``browser_doctor`` tool that reports whether
the runtime is installed.

Run it directly (stdio transport):

    pip install "betterwright[mcp]"     # or: pip install betterwright mcp
    betterwright setup                  # one-time Chromium download
    python -m betterwright.integrations.mcp_server

Then register it with your MCP client. For Claude Code:

    claude mcp add betterwright -- python -m betterwright.integrations.mcp_server

Configuration is read from the environment so the same command works everywhere:

    BETTERWRIGHT_ALLOW_LOOPBACK=1        allow 127.0.0.1 / localhost
    BETTERWRIGHT_ALLOW_PRIVATE_NETWORK=1 allow RFC1918 / *.internal hosts
    BETTERWRIGHT_ALLOW_HOSTS=a.com,b.com always-allow list (comma-separated)
    BETTERWRIGHT_BLOCK_HOSTS=ads.com     always-block list (comma-separated)
    BETTERWRIGHT_HEADLESS=0              run Chromium headed
"""

from __future__ import annotations

import os

from betterwright import BetterWright, NetworkPolicy
from betterwright.runtime import diagnose

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover - guidance for a missing extra
    raise SystemExit(
        "The MCP SDK is required. Install it with "
        "`pip install \"betterwright[mcp]\"` or `pip install mcp`."
    ) from exc


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _list_env(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _policy_from_env() -> NetworkPolicy:
    return NetworkPolicy(
        allow_loopback=_bool_env("BETTERWRIGHT_ALLOW_LOOPBACK"),
        allow_private_network=_bool_env("BETTERWRIGHT_ALLOW_PRIVATE_NETWORK"),
        allow_hosts=_list_env("BETTERWRIGHT_ALLOW_HOSTS"),
        block_hosts=_list_env("BETTERWRIGHT_BLOCK_HOSTS"),
    )


mcp = FastMCP("betterwright")

# One persistent browser for the life of the server, so pages and logins survive
# across tool calls the way an agent expects.
_browser = BetterWright(
    policy=_policy_from_env(),
    headless=not _bool_env("BETTERWRIGHT_HEADLESS"),
)


@mcp.tool()
def browser(code: str, session: str = "default", note: str = "") -> dict:
    """Run async Playwright JavaScript in a persistent, policy-guarded browser.

    Globals available to `code`: page, pages, context, state, openPage, usePage,
    closePage, snapshot, screenshot, artifactPath, dialogs, credentials. A single
    trailing expression is returned automatically; a statement block must return.
    Capture `screenshot({kind: 'proof'})` before claiming a visible task is done,
    and cite the returned MEDIA: path.

    Args:
        code: The Playwright JavaScript to execute.
        session: Independent set of pages/state; reuse a name across calls.
        note: Optional present-tense status line (not run in the browser).
    """

    result = _browser.run(code, session=session, note=note or None)
    return {
        "ok": result.ok,
        "result": result.value,
        "error": result.error,
        "console": result.console,
        "artifacts": [
            {"kind": a.kind, "media": a.media_reference} for a in result.artifacts
        ],
        "pages": result.pages,
        "warnings": result.warnings,
        "duration_ms": result.duration_ms,
    }


@mcp.tool()
def browser_doctor() -> dict:
    """Report whether the BetterWright browser runtime is installed and ready."""

    return diagnose()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
