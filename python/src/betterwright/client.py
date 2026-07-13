"""The public BetterWright client.

Typical use::

    from betterwright import BetterWright

    with BetterWright() as bw:
        result = bw.run("await page.goto('https://example.com'); return page.title()")
        print(result.value)

The client is a thin, ergonomic layer over :class:`~betterwright.bridge.Bridge`:
it turns the worker's JSON envelope into a typed :class:`RunResult`, and lets
you address independent browser sessions by name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from betterwright.bridge import Bridge
from betterwright.policy import NetworkPolicy
from betterwright.vault import CredentialVault

#: Artifact kinds that are images (as opposed to downloads or spilled output).
IMAGE_KINDS = frozenset({"proof", "question", "debug", "captcha"})

_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


@dataclass
class Artifact:
    """A file the worker produced: a screenshot, download, or spilled output."""

    kind: str
    path: str
    size: int | None = None

    @property
    def is_image(self) -> bool:
        """Whether this artifact is a screenshot (safe to show a vision model)."""

        return self.kind in IMAGE_KINDS

    @property
    def media_reference(self) -> str:
        """The ``MEDIA:<path>`` form a host may resolve to render the file."""

        return f"MEDIA:{self.path}"

    @property
    def mime_type(self) -> str:
        """Best-effort MIME type from the file extension."""

        import os

        return _MIME_BY_EXT.get(os.path.splitext(self.path)[1].lower(), "application/octet-stream")

    def read_bytes(self) -> bytes:
        """Read the artifact's raw bytes from disk."""

        with open(self.path, "rb") as handle:
            return handle.read()

    def data_url(self) -> str:
        """Return the artifact as a ``data:<mime>;base64,...`` URL.

        Use this to hand a screenshot straight to a vision model that expects an
        image URL (OpenAI/Anthropic/Codex style) — it avoids the file-path and
        ``MEDIA:`` conventions a generic host does not understand.
        """

        import base64

        encoded = base64.b64encode(self.read_bytes()).decode("ascii")
        return f"data:{self.mime_type};base64,{encoded}"


@dataclass
class RunResult:
    """The outcome of one :meth:`BetterWright.run` call."""

    ok: bool
    value: Any = None
    error: str | None = None
    console: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    pages: list[dict] = field(default_factory=list)
    challenges: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    duration_ms: float = 0.0
    truncated: bool = False

    def screenshots(self, kind: str | None = None) -> list[Artifact]:
        """Return captured screenshots, optionally filtered by ``kind``.

        ``kind`` is one of ``"proof"``, ``"question"``, ``"debug"``, or
        ``"captcha"``. The latter is emitted by ``captcha.readText()``.
        """

        images = [a for a in self.artifacts if a.is_image]
        return [a for a in images if kind is None or a.kind == kind]

    def files(self) -> list[Artifact]:
        """Return non-image artifacts (downloads, spilled output) as files.

        These must never be handed to a vision model as images — that is what
        produces "unsupported image MIME type" errors in hosts that attach
        artifacts automatically.
        """

        return [a for a in self.artifacts if not a.is_image]

    def raise_for_status(self) -> RunResult:
        """Raise :class:`BrowserError` if the snippet failed; else return self."""

        if not self.ok:
            raise BrowserError(self.error or "browser execution failed")
        return self

    @classmethod
    def _from_envelope(cls, envelope: dict) -> RunResult:
        raw_result = envelope.get("result")
        value: Any = raw_result
        truncated = False
        if isinstance(raw_result, dict) and raw_result.get("truncated"):
            truncated = True
            value = raw_result
        artifacts = [
            Artifact(
                kind=str(item.get("kind", "artifact")),
                path=str(item.get("path", "")),
                size=item.get("size"),
            )
            for item in envelope.get("artifacts", [])
            if isinstance(item, dict)
        ]
        return cls(
            ok=bool(envelope.get("ok")),
            value=value,
            error=envelope.get("error"),
            console=list(envelope.get("console", [])),
            events=list(envelope.get("events", [])),
            artifacts=artifacts,
            pages=list(envelope.get("pages", [])),
            challenges=list(envelope.get("challenges", [])),
            warnings=list(envelope.get("warnings", [])),
            duration_ms=float(envelope.get("durationMs", 0.0) or 0.0),
            truncated=truncated,
        )


class BrowserError(RuntimeError):
    """Raised by :meth:`RunResult.raise_for_status` for a failed snippet."""


class BetterWright:
    """A persistent, policy-guarded Playwright browser.

    Parameters
    ----------
    home:
        State directory (profile, artifacts, vault). Defaults to
        ``$BETTERWRIGHT_HOME`` or ``~/.betterwright``.
    policy:
        A :class:`NetworkPolicy`. Defaults to the safe policy that blocks cloud
        metadata endpoints and private networks.
    vault:
        A :class:`CredentialVault`, ``True`` to enable the default file-backed
        vault, or ``None``/``False`` to disable the ``credentials`` helpers.
    executable_path:
        An explicit Chromium binary to launch instead of the pinned build.
        When unset, ``CLOAKBROWSER_BINARY_PATH`` is honored if present.
    headless:
        ``True``, ``False``, or ``"auto"`` (the default). ``"auto"`` runs a
        visible browser when a display is available and headless otherwise — so
        it shows a window on a desktop and stays headless on servers and CI.
    default_timeout:
        Per-snippet timeout in seconds (minimum 5).
    connect_over_cdp:
        Attach to an already-running Chrome/Chromium at this CDP endpoint (e.g.
        ``"http://127.0.0.1:9222"``) instead of launching an isolated browser.
        The target must have been started with ``--remote-debugging-port``. In
        this mode BetterWright uses the browser's existing context and tabs, and
        the launch-time network floor (metadata resolver rules, forced transport
        proxy) is not active — only the per-request :class:`NetworkPolicy`
        applies. See ``docs/attach-mode.md``.
    search_min_interval_ms:
        Minimum spacing between top-level Google, Bing, or DuckDuckGo search
        navigations. ``0`` (the default) disables pacing.
    """

    def __init__(
        self,
        *,
        home: Path | None = None,
        policy: NetworkPolicy | None = None,
        vault: CredentialVault | bool | None = True,
        executable_path: str | None = None,
        headless: bool | str = "auto",
        default_timeout: int = 30,
        connect_over_cdp: str | None = None,
        search_min_interval_ms: int = 0,
    ) -> None:
        resolved_vault: CredentialVault | None
        if vault is True:
            resolved_vault = CredentialVault(
                (Path(home).expanduser() / "vault") if home else None
            )
        elif vault in (False, None):
            resolved_vault = None
        else:
            resolved_vault = vault  # type: ignore[assignment]

        self._bridge = Bridge(
            home=home,
            policy=policy,
            vault=resolved_vault,
            executable_path=executable_path,
            headless=headless,
            default_timeout=default_timeout,
            connect_over_cdp=connect_over_cdp,
            search_min_interval_ms=search_min_interval_ms,
        )

    @property
    def policy(self) -> NetworkPolicy:
        return self._bridge.policy

    @property
    def vault(self) -> CredentialVault | None:
        return self._bridge.vault

    def run(
        self,
        code: str,
        *,
        session: str = "default",
        note: str | None = None,
        timeout: int | None = None,
    ) -> RunResult:
        """Execute one Playwright snippet and return a :class:`RunResult`.

        ``code`` is asynchronous Playwright JavaScript. A single trailing
        expression is returned automatically; a statement block must ``return``.
        ``note`` is an optional present-tense status line for host UIs; it is
        not interpreted by the browser. ``session`` selects an independent set
        of pages and state.
        """

        _ = note  # Reserved for host status surfaces; kept out of the sandbox.
        envelope = self._bridge.execute(code, session, timeout=timeout)
        return RunResult._from_envelope(envelope)

    def session(self, name: str) -> Session:
        """Return a handle bound to one named browser session."""

        return Session(self, name)

    def close(self) -> None:
        self._bridge.close()

    def __enter__(self) -> BetterWright:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class Session:
    """A handle bound to one named session of a :class:`BetterWright` browser."""

    def __init__(self, browser: BetterWright, name: str) -> None:
        self._browser = browser
        self.name = name

    def run(
        self, code: str, *, note: str | None = None, timeout: int | None = None
    ) -> RunResult:
        return self._browser.run(code, session=self.name, note=note, timeout=timeout)


__all__ = ["Artifact", "BetterWright", "BrowserError", "RunResult", "Session"]
