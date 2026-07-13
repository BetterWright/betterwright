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


@dataclass
class Artifact:
    """A file the worker produced: a screenshot, download, or spilled output."""

    kind: str
    path: str
    size: int | None = None

    @property
    def media_reference(self) -> str:
        """The ``MEDIA:<path>`` form agents cite so a UI can render the file."""

        return f"MEDIA:{self.path}"


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
    warnings: list[str] = field(default_factory=list)
    duration_ms: float = 0.0
    truncated: bool = False

    def screenshots(self, kind: str | None = None) -> list[Artifact]:
        """Return captured screenshots, optionally filtered by ``kind``.

        ``kind`` is one of ``"proof"``, ``"question"``, or ``"debug"`` — the
        three categories the ``screenshot()`` helper tags images with.
        """

        images = [a for a in self.artifacts if a.kind in {"proof", "question", "debug"}]
        return [a for a in images if kind is None or a.kind == kind]

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
    headless:
        Whether Chromium runs headless. Defaults to ``True``.
    default_timeout:
        Per-snippet timeout in seconds (minimum 5).
    """

    def __init__(
        self,
        *,
        home: Path | None = None,
        policy: NetworkPolicy | None = None,
        vault: CredentialVault | bool | None = True,
        executable_path: str | None = None,
        headless: bool = True,
        default_timeout: int = 30,
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
