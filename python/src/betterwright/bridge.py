"""Process-scoped bridge between Python and the Node Playwright worker.

The bridge owns one long-lived Node child. Snippets are executed one at a time,
but a dedicated reader thread services the worker's ``guard`` and ``vault`` RPCs
*during* an in-flight evaluation. That decoupling is what avoids the classic
duplex deadlock: a navigation inside the worker blocks on a policy answer while
the caller blocks on the navigation result.

A single bridge is safe to share across threads; ``execute`` serializes callers.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from betterwright._display import resolve_headless
from betterwright._home import betterwright_home
from betterwright.policy import NetworkPolicy
from betterwright.runtime import (
    cloakbrowser_dir,
    node_executable,
    playwright_core_dir,
    worker_path,
)
from betterwright.vault import CredentialVault

logger = logging.getLogger("betterwright")

_DEFAULT_TIMEOUT_SECONDS = 30
_WORKER_START_TIMEOUT_SECONDS = 15
_DOWNLOAD_POLICIES = frozenset({"ask", "allow", "deny"})
_BROWSERS = frozenset({"cloak", "chromium"})
_PUBLIC_SEARCH_POLICIES = frozenset({"block", "allow"})


def _normalize_download_policy(value: str) -> str:
    policy = str(value or "ask").strip().lower()
    if policy not in _DOWNLOAD_POLICIES:
        raise ValueError(
            'download_policy must be "ask", "allow", or "deny"; '
            f"received {value!r}"
        )
    return policy


def _normalize_browser(value: str | None) -> str:
    raw = value if value is not None else os.environ.get("BETTERWRIGHT_BROWSER", "cloak")
    browser = str(raw).strip().lower()
    if browser not in _BROWSERS:
        raise ValueError('browser must be "cloak" or "chromium"')
    return browser


def _normalize_public_search_policy(value: str | None) -> str:
    raw = (
        value
        if value is not None
        else os.environ.get("BETTERWRIGHT_PUBLIC_SEARCH_POLICY", "block")
    )
    policy = str(raw).strip().lower()
    if policy not in _PUBLIC_SEARCH_POLICIES:
        raise ValueError('public_search_policy must be "block" or "allow"')
    return policy


class WorkerStartError(RuntimeError):
    """Raised when the Node worker cannot be launched."""


class Bridge:
    """One Node worker plus its persistent Chromium context.

    Parameters
    ----------
    home:
        State directory for the profile, artifacts, downloads, and vault.
        Defaults to :func:`betterwright_home`.
    policy:
        Network policy evaluated for every request. Defaults to the safe
        :class:`NetworkPolicy` (metadata and private networks blocked).
    vault:
        Credential store, or ``None`` to disable the ``credentials`` helpers.
    executable_path:
        Explicit Chromium binary. Supplying one selects the Chromium fallback.
    browser:
        ``"cloak"`` (the managed default) or the explicit, degraded
        ``"chromium"`` fallback.
    """

    def __init__(
        self,
        *,
        home: Path | None = None,
        policy: NetworkPolicy | None = None,
        vault: CredentialVault | None = None,
        executable_path: str | None = None,
        browser: str | None = None,
        headless: bool | str = "auto",
        default_timeout: int = _DEFAULT_TIMEOUT_SECONDS,
        connect_over_cdp: str | None = None,
        search_min_interval_ms: int = 0,
        public_search_policy: str | None = None,
        download_policy: str = "ask",
    ) -> None:
        self.home = Path(home).expanduser().resolve() if home else betterwright_home()
        self.policy = policy if policy is not None else NetworkPolicy()
        self.vault = vault
        requested_browser = _normalize_browser(browser)
        self.browser_flavor = "chromium" if executable_path else requested_browser
        cloak_executable = os.environ.get("CLOAKBROWSER_BINARY_PATH", "").strip()
        self.executable_path = (
            executable_path
            or (cloak_executable if self.browser_flavor == "cloak" else "")
            or None
        )
        self.headless = resolve_headless(headless)
        self.default_timeout = max(int(default_timeout), 5)
        self.connect_over_cdp = (connect_over_cdp or "").strip()
        self.search_min_interval_ms = max(int(search_min_interval_ms), 0)
        self.public_search_policy = _normalize_public_search_policy(
            public_search_policy
        )
        self.download_policy = _normalize_download_policy(download_policy)

        self._process: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._ready = threading.Event()
        self._write_lock = threading.Lock()
        self._execute_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._pending: dict[str, queue.Queue] = {}
        self._pending_lock = threading.Lock()
        self._stderr_tail: list[str] = []
        self._last_config: dict | None = None
        self._closed = False
        self._cdp_resolved = False
        atexit.register(self.close)

    # -- configuration ----------------------------------------------------

    def _worker_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["NODE_NO_WARNINGS"] = "1"
        core = playwright_core_dir()
        if core is not None:
            env["BETTERWRIGHT_PLAYWRIGHT_CORE_PATH"] = str(core)
        cloak = cloakbrowser_dir()
        if cloak is not None:
            env["BETTERWRIGHT_CLOAKBROWSER_PATH"] = str(cloak)
        return env

    def _resolve_cdp_endpoint(self) -> None:
        """Turn ``connect_over_cdp="auto"`` into a concrete endpoint, launching a
        real Google Chrome with a persistent profile if none is already up."""

        if self._cdp_resolved:
            return
        if self.connect_over_cdp.strip().lower() == "auto":
            from betterwright.chrome import ensure_chrome_cdp

            result = ensure_chrome_cdp(home=self.home)
            self.connect_over_cdp = str(result["endpoint"])
        self._cdp_resolved = True

    def _worker_config(self) -> dict:
        root = self.home / "browser"
        artifacts = self.home / "artifacts"
        downloads = artifacts / "downloads"
        runtime = root / "runtime"
        for directory in (root, artifacts, downloads, runtime):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                directory.chmod(0o700)
            except OSError:
                pass
        return {
            "profileDir": str(root / "profile"),
            "runtimeDir": str(runtime),
            "artifactsDir": str(artifacts),
            "downloadsDir": str(downloads),
            "executablePath": str(Path(self.executable_path).expanduser())
            if self.executable_path
            else "",
            "browserFlavor": self.browser_flavor,
            "headless": bool(self.headless),
            "cdpEndpoint": self.connect_over_cdp,
            "searchMinIntervalMs": self.search_min_interval_ms,
            "publicSearchPolicy": self.public_search_policy,
            "downloadPolicy": self.download_policy,
            "outputLimit": 12_000,
            "maxArtifactBytes": 100 * 1024 * 1024,
            "maxDownloadBytes": 50 * 1024 * 1024,
            "pageIdleTimeoutMs": 1_800 * 1000,
        }

    # -- lifecycle --------------------------------------------------------

    def _start(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                raise WorkerStartError("This bridge has been closed.")
            if self._process is not None and self._process.poll() is None:
                return
            node = node_executable()
            if not node:
                raise WorkerStartError(
                    "Node.js was not found on PATH. Install Node 22+ and rerun "
                    "`betterwright setup`."
                )
            worker = worker_path()
            if not worker.is_file():
                raise WorkerStartError(f"Worker script is missing: {worker}")
            self._ready.clear()
            self._stderr_tail.clear()
            self._process = subprocess.Popen(
                [node, str(worker)],
                cwd=str(worker.parent),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
                env=self._worker_env(),
            )
            self._reader = threading.Thread(
                target=self._read_stdout, name="betterwright-reader", daemon=True
            )
            self._stderr_reader = threading.Thread(
                target=self._read_stderr, name="betterwright-stderr", daemon=True
            )
            self._reader.start()
            self._stderr_reader.start()
        if not self._ready.wait(timeout=_WORKER_START_TIMEOUT_SECONDS):
            tail = "\n".join(self._stderr_tail[-8:])
            self.close()
            raise WorkerStartError(
                "The BetterWright worker did not start. If Chromium is missing, "
                "run `betterwright setup`.\n" + tail
            )

    def close(self) -> None:
        """Shut the worker down. Safe to call more than once."""

        with self._lifecycle_lock:
            self._closed = True
            process = self._process
            self._process = None
            self._last_config = None
            self._ready.clear()
            if process is None:
                return
            try:
                if process.stdin:
                    process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass

    def __enter__(self) -> Bridge:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transport --------------------------------------------------------

    def _send(self, message: dict) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise WorkerStartError("The BetterWright worker is not running.")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            process.stdin.write(encoded + "\n")
            process.stdin.flush()

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    logger.warning("Ignoring non-JSON worker output")
                    continue
                kind = message.get("type")
                if kind == "ready":
                    self._ready.set()
                elif kind == "rpc_request":
                    self._service_rpc(message)
                elif kind == "result":
                    request_id = str(message.get("id", ""))
                    with self._pending_lock:
                        waiter = self._pending.get(request_id)
                    if waiter is not None:
                        waiter.put(message)
        finally:
            self._ready.set()
            error = {
                "type": "result",
                "ok": False,
                "error": "The BetterWright worker exited unexpectedly.",
            }
            with self._pending_lock:
                waiters = list(self._pending.values())
            for waiter in waiters:
                waiter.put(error)

    def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            clean = line.rstrip()
            if clean:
                self._stderr_tail.append(clean)
                del self._stderr_tail[:-40]
                logger.debug("worker: %s", clean)

    def _service_rpc(self, message: dict) -> None:
        request_id = str(message.get("requestId", ""))
        try:
            method = message.get("method")
            payload = message.get("payload") or {}
            if method == "guard":
                url = str(payload.get("url", ""))
                details = {k: v for k, v in payload.items() if k != "url"}
                result = self.policy.check(url, details)
            elif method == "vault":
                if self.vault is None:
                    raise RuntimeError("No credential vault is configured for this browser.")
                result = self.vault.handle_request(
                    str(payload.get("action", "")),
                    payload.get("payload") or {},
                    str(payload.get("origin", "")),
                )
            else:
                raise ValueError(f"Unknown worker RPC method: {method}")
            response = {
                "type": "rpc_response",
                "requestId": request_id,
                "ok": True,
                "result": result,
            }
        except Exception as exc:  # noqa: BLE001 - reported back to the worker
            response = {
                "type": "rpc_response",
                "requestId": request_id,
                "ok": False,
                "error": str(exc),
            }
        try:
            self._send(response)
        except (OSError, WorkerStartError):
            logger.debug("Dropping RPC response during worker shutdown")

    # -- execution --------------------------------------------------------

    def execute(
        self,
        code: str,
        session_id: str = "default",
        *,
        timeout: int | None = None,
        approved_downloads: bool = False,
    ) -> dict:
        """Run one Playwright snippet and return the worker's result envelope."""

        if not isinstance(code, str) or not code.strip():
            return {"ok": False, "error": "code must be a non-empty string"}
        if len(code) > 100_000:
            return {"ok": False, "error": "code exceeds the 100,000 character limit"}

        timeout_seconds = max(int(timeout or self.default_timeout), 5)
        with self._execute_lock:
            self._resolve_cdp_endpoint()
            config = self._worker_config()
            if (
                self._process is not None
                and self._process.poll() is None
                and self._last_config != config
            ):
                self.close()
                self._closed = False
            self._start()
            self._last_config = config

            request_id = uuid.uuid4().hex
            waiter: queue.Queue = queue.Queue(maxsize=1)
            with self._pending_lock:
                self._pending[request_id] = waiter
            try:
                self._send(
                    {
                        "type": "execute",
                        "id": request_id,
                        "sessionId": str(session_id or "default"),
                        "code": code,
                        "approvedDownloads": approved_downloads is True,
                        "timeoutMs": timeout_seconds * 1000,
                        "config": config,
                    }
                )
                try:
                    response = waiter.get(timeout=timeout_seconds + 5)
                except queue.Empty:
                    self.close()
                    self._closed = False
                    return {
                        "ok": False,
                        "error": (
                            f"Execution timed out after {timeout_seconds}s; "
                            "the worker was restarted."
                        ),
                    }
            finally:
                with self._pending_lock:
                    self._pending.pop(request_id, None)

        return self._finish_envelope(response)

    def fill_credential(
        self,
        spec: dict,
        session_id: str = "default",
        *,
        timeout: int | None = None,
    ) -> dict:
        """Fill a vault credential into the current page via the trusted worker.

        Reachable only from host code (never a model ``run()`` snippet). The
        worker fetches the secret, types the username/password/confirm-password
        fields, and optionally submits — all outside the sandbox — and returns
        only non-secret metadata.
        """

        if self.vault is None:
            return {"ok": False, "error": "No credential vault is configured."}

        timeout_seconds = max(int(timeout or self.default_timeout), 5)
        with self._execute_lock:
            self._resolve_cdp_endpoint()
            config = self._worker_config()
            if (
                self._process is not None
                and self._process.poll() is None
                and self._last_config != config
            ):
                self.close()
                self._closed = False
            self._start()
            self._last_config = config

            request_id = uuid.uuid4().hex
            waiter: queue.Queue = queue.Queue(maxsize=1)
            with self._pending_lock:
                self._pending[request_id] = waiter
            try:
                self._send(
                    {
                        "type": "credential_fill",
                        "id": request_id,
                        "sessionId": str(session_id or "default"),
                        "timeoutMs": timeout_seconds * 1000,
                        "spec": spec,
                        "config": config,
                    }
                )
                try:
                    response = waiter.get(timeout=timeout_seconds + 5)
                except queue.Empty:
                    self.close()
                    self._closed = False
                    return {
                        "ok": False,
                        "error": (
                            f"Credential fill timed out after {timeout_seconds}s; "
                            "the worker was restarted."
                        ),
                    }
            finally:
                with self._pending_lock:
                    self._pending.pop(request_id, None)

        return self._finish_envelope(response)

    def _finish_envelope(self, response: dict) -> dict:
        response.pop("type", None)
        response.pop("id", None)
        restart = bool(response.pop("restartWorker", False))
        if self.vault is not None:
            try:
                response = self.vault.redact(response)
            except Exception:  # noqa: BLE001 - redaction must never raise out
                logger.debug("Vault redaction failed", exc_info=True)
        if restart:
            self.close()
            self._closed = False
        return response


def which_node() -> str | None:
    """Convenience wrapper mirroring :func:`node_executable` for callers."""

    return shutil.which("node")


__all__ = ["Bridge", "WorkerStartError"]
