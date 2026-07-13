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
    BETTERWRIGHT_HEADLESS=0              run Chromium headed (visible window)
    BETTERWRIGHT_CONNECT_OVER_CDP=http://127.0.0.1:9222
                                         attach to an existing Chrome instead of
                                         launching one (see docs/attach-mode.md)
    CLOAKBROWSER_BINARY_PATH=/path/to/chrome
                                         use an explicitly installed CloakBrowser

Screenshots are returned as native MCP image content, so a client renders them
directly — you never hand it a file path or guess a MIME type.
"""

from __future__ import annotations

import json
import os

from betterwright import BetterWright, NetworkPolicy
from betterwright.runtime import diagnose

try:
    from mcp.server.fastmcp import FastMCP, Image
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
# Default to "auto" (headed when a display exists, else headless); honor an
# explicit BETTERWRIGHT_HEADLESS=0/1 when the deployer sets one.
_headless: bool | str = "auto"
if os.environ.get("BETTERWRIGHT_HEADLESS", "").strip():
    _headless = _bool_env("BETTERWRIGHT_HEADLESS")

_browser = BetterWright(
    policy=_policy_from_env(),
    headless=_headless,
    connect_over_cdp=os.environ.get("BETTERWRIGHT_CONNECT_OVER_CDP", "").strip() or None,
)


@mcp.tool()
def browser(code: str, session: str = "default", note: str = "") -> list:
    """Run async Playwright JavaScript in a persistent, policy-guarded browser.

    Globals available to `code`: page, pages, context, state, openPage, usePage,
    closePage, snapshot, screenshot, artifactPath, dialogs, credentials, captcha,
    human. A single trailing expression is returned automatically; a statement
    block must return.
    Capture `screenshot({kind: 'proof'})` before claiming a visible task is done —
    the image is returned inline; you do not need to open any file path.

    Args:
        code: The Playwright JavaScript to execute.
        session: Independent set of pages/state; reuse a name across calls.
        note: Optional present-tense status line (not run in the browser).
    """

    result = _browser.run(code, session=session, note=note or None)
    summary = {
        "ok": result.ok,
        "result": result.value,
        "error": result.error,
        "console": result.console,
        # Screenshots are returned as image content below, not as paths. Other
        # files (downloads, spilled output) are listed here as paths only — never
        # attach them as images.
        "files": [{"kind": a.kind, "path": a.path} for a in result.files()],
        "pages": result.pages,
        "challenges": result.challenges,
        "warnings": result.warnings,
        "duration_ms": result.duration_ms,
    }
    # Return the JSON summary as text plus each screenshot as native MCP image
    # content, so the client renders images without guessing MIME types from a
    # path. This is what prevents "unsupported image MIME type" errors.
    content: list = [json.dumps(summary, default=str, ensure_ascii=False)]
    for shot in result.screenshots():
        try:
            content.append(Image(path=shot.path))
        except OSError:
            pass
    return content


@mcp.tool()
def browser_doctor() -> dict:
    """Report whether the BetterWright browser runtime is installed and ready."""

    return diagnose()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
