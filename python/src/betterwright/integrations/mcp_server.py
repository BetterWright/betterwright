"""A Model Context Protocol server exposing BetterWright as a browser tool.

This lets any MCP client — Claude Code, Cursor, Windsurf, and others — drive a
persistent, policy-guarded browser. It exposes ``browser`` for ordinary runs,
``browser_download`` for approval-gated downloads, and ``browser_doctor`` for
runtime diagnostics.

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
    BETTERWRIGHT_DOWNLOAD_POLICY=ask     ask (default), allow, or deny downloads
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
    from mcp.server.fastmcp import Context, FastMCP, Image
    from pydantic import BaseModel, Field
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


def _download_policy_from_env() -> str:
    policy = os.environ.get("BETTERWRIGHT_DOWNLOAD_POLICY", "ask").strip().lower()
    if policy not in {"ask", "allow", "deny"}:
        raise SystemExit(
            'BETTERWRIGHT_DOWNLOAD_POLICY must be "ask", "allow", or "deny".'
        )
    return policy


mcp = FastMCP("betterwright")

# One persistent browser for the life of the server, so pages and logins survive
# across tool calls the way an agent expects.
# Default to "auto" (headed when a display exists, else headless); honor an
# explicit BETTERWRIGHT_HEADLESS=0/1 when the deployer sets one.
_headless: bool | str = "auto"
if os.environ.get("BETTERWRIGHT_HEADLESS", "").strip():
    _headless = _bool_env("BETTERWRIGHT_HEADLESS")

_download_policy = _download_policy_from_env()

_browser = BetterWright(
    policy=_policy_from_env(),
    headless=_headless,
    connect_over_cdp=os.environ.get("BETTERWRIGHT_CONNECT_OVER_CDP", "").strip() or None,
    download_policy=_download_policy,
)


class DownloadApproval(BaseModel):
    """Explicit user decision for one proposed browser download run."""

    approved: bool = Field(description="Approve this browser download?")


def _content_for_result(result) -> list:
    summary = {
        "ok": result.ok,
        "result": result.value,
        "error": result.error,
        "console": result.console,
        # Screenshots are returned as image content below, not as paths. Other
        # files (downloads, spilled output) are listed here as paths only.
        "files": [{"kind": a.kind, "path": a.path} for a in result.files()],
        "pages": result.pages,
        "challenges": result.challenges,
        "warnings": result.warnings,
        "duration_ms": result.duration_ms,
    }
    content: list = [json.dumps(summary, default=str, ensure_ascii=False)]
    for shot in result.screenshots():
        try:
            content.append(Image(path=shot.path))
        except OSError:
            pass
    return content


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
    return _content_for_result(result)


@mcp.tool()
async def browser_download(
    code: str,
    ctx: Context,
    session: str = "default",
    note: str = "",
) -> list:
    """Run browser code that may download a file, with user approval first.

    Use this instead of ``browser`` whenever the Playwright code will click a
    download link or otherwise save a remote file. In the default ``ask`` mode,
    the MCP client presents a confirmation before any browser code runs. Set
    ``BETTERWRIGHT_DOWNLOAD_POLICY=allow`` to remove that prompt, or ``deny`` to
    disable all downloads.
    """

    if _download_policy == "deny":
        raise RuntimeError("Downloads are disabled by BETTERWRIGHT_DOWNLOAD_POLICY=deny.")
    if _download_policy == "ask":
        try:
            decision = await ctx.elicit(
                message=(
                    "Allow BetterWright to run browser code that may download a file?"
                    + (f" Requested action: {note}" if note else "")
                ),
                schema=DownloadApproval,
            )
        except Exception as exc:  # noqa: BLE001 - unsupported clients fail closed
            raise RuntimeError(
                "This MCP client cannot present download approval; the download was blocked."
            ) from exc
        approved = (
            decision.action == "accept"
            and decision.data is not None
            and decision.data.approved is True
        )
        if not approved:
            raise RuntimeError("The user declined or cancelled the download.")

    result = _browser.run(
        code,
        session=session,
        note=note or None,
        approved_downloads=True,
    )
    return _content_for_result(result)


@mcp.tool()
def browser_doctor() -> dict:
    """Report whether the BetterWright browser runtime is installed and ready."""

    return diagnose()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
