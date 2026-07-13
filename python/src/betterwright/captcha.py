"""Provider-agnostic CAPTCHA solving.

When a legitimate, authorized flow stalls on a "verify you're human" wall,
this module hands the challenge to a third-party solving service and returns
the token to inject back into the page. It speaks the legacy ``in.php`` /
``res.php`` protocol that every 2Captcha-compatible service exposes (2Captcha,
CapMonster, CapSolver, RuCaptcha, ...), so switching providers is a base-URL
change.

The service API key is read from ``CAPTCHA_SOLVER_API_KEY`` and never returned
in results.

This is a convenience for finishing a task the user owns — the same category as
the credential vault. It is not a tool for bulk account creation, credential
stuffing, or scraping behind anti-bot walls at scale. A CAPTCHA is a site asking
automation to stop; only override it inside a flow you are authorized to run.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from betterwright._home import betterwright_home

DEFAULT_BASE_URL = "https://2captcha.com"
DEFAULT_KEY_FILE = "captcha-api-key"
_POLL_INTERVAL_S = 5.0
_FIRST_POLL_DELAY_S = 15.0  # services need ~15s before a token is ready
_DEFAULT_TIMEOUT_S = 180.0
_HTTP_TIMEOUT_S = 30.0

CaptchaType = str  # one of: recaptcha_v2 recaptcha_v3 hcaptcha turnstile image


class CaptchaError(RuntimeError):
    """A CAPTCHA could not be solved; ``str(exc)`` is the service error code."""


@dataclass
class Solution:
    """A solved CAPTCHA. ``token`` is the value to inject into the page."""

    type: CaptchaType
    token: str
    request_id: str


class CaptchaSolver:
    """Client for a 2Captcha-compatible solving service."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self.api_key = _resolve_api_key(api_key)
        self.base_url = (
            base_url or os.environ.get("CAPTCHA_SOLVER_BASE_URL", DEFAULT_BASE_URL)
        ).rstrip("/")
        self.timeout = timeout

    # -- transport --------------------------------------------------------

    @staticmethod
    def _post(url: str, fields: dict[str, str]) -> str:
        data = urllib.parse.urlencode(fields).encode()
        request = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_S) as response:
            return response.read().decode("utf-8", "replace").strip()

    @staticmethod
    def _get(url: str, params: dict[str, str]) -> str:
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(f"{url}?{query}", method="GET")
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_S) as response:
            return response.read().decode("utf-8", "replace").strip()

    def _require_key(self) -> None:
        if not self.api_key:
            raise CaptchaError("CAPTCHA_SOLVER_API_KEY is not set")

    def _submit(self, fields: dict[str, str]) -> str:
        raw = self._post(f"{self.base_url}/in.php", {**fields, "json": "1"})
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            if raw.startswith("OK|"):
                return raw.split("|", 1)[1]
            raise CaptchaError(raw or "ERROR_EMPTY_RESPONSE") from None
        if str(payload.get("status")) != "1":
            raise CaptchaError(str(payload.get("request", "ERROR_SUBMIT_FAILED")))
        return str(payload["request"])

    def _poll(self, request_id: str) -> str:
        deadline = time.monotonic() + self.timeout
        time.sleep(min(_FIRST_POLL_DELAY_S, self.timeout))
        while True:
            raw = self._get(
                f"{self.base_url}/res.php",
                {"key": self.api_key, "action": "get", "id": request_id, "json": "1"},
            )
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                if raw == "CAPCHA_NOT_READY":
                    payload = {"status": "0", "request": "CAPCHA_NOT_READY"}
                elif raw.startswith("OK|"):
                    return raw.split("|", 1)[1]
                else:
                    raise CaptchaError(raw or "ERROR_EMPTY_RESPONSE") from None
            if str(payload.get("status")) == "1":
                return str(payload["request"])
            request = str(payload.get("request", ""))
            if request and request != "CAPCHA_NOT_READY":
                raise CaptchaError(request)
            if time.monotonic() >= deadline:
                raise CaptchaError("ERROR_TIMEOUT")
            time.sleep(_POLL_INTERVAL_S)

    def _solve(self, captcha_type: CaptchaType, fields: dict[str, str]) -> Solution:
        self._require_key()
        try:
            request_id = self._submit({"key": self.api_key, **fields})
            token = self._poll(request_id)
        except (urllib.error.URLError, OSError) as exc:
            raise CaptchaError(f"transport: {exc}") from exc
        return Solution(type=captcha_type, token=token, request_id=request_id)

    # -- public API -------------------------------------------------------

    def balance(self) -> str:
        """Return the account balance string; raises on a bad key."""

        self._require_key()
        try:
            raw = self._get(
                f"{self.base_url}/res.php",
                {"key": self.api_key, "action": "getbalance", "json": "1"},
            )
        except (urllib.error.URLError, OSError) as exc:
            raise CaptchaError(f"transport: {exc}") from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            if raw.startswith("ERROR"):
                raise CaptchaError(raw) from None
            return raw
        if str(payload.get("status")) != "1":
            raise CaptchaError(str(payload.get("request", "ERROR_BALANCE_FAILED")))
        return str(payload["request"])

    def recaptcha_v2(
        self, sitekey: str, url: str, *, invisible: bool = False
    ) -> Solution:
        fields = {"method": "userrecaptcha", "googlekey": sitekey, "pageurl": url}
        if invisible:
            fields["invisible"] = "1"
        return self._solve("recaptcha_v2", fields)

    def recaptcha_v3(
        self,
        sitekey: str,
        url: str,
        *,
        action: str = "verify",
        min_score: float = 0.7,
    ) -> Solution:
        return self._solve(
            "recaptcha_v3",
            {
                "method": "userrecaptcha",
                "googlekey": sitekey,
                "pageurl": url,
                "version": "v3",
                "action": action,
                "min_score": str(min_score),
            },
        )

    def hcaptcha(self, sitekey: str, url: str) -> Solution:
        return self._solve(
            "hcaptcha", {"method": "hcaptcha", "sitekey": sitekey, "pageurl": url}
        )

    def turnstile(
        self, sitekey: str, url: str, *, action: str | None = None
    ) -> Solution:
        fields = {"method": "turnstile", "sitekey": sitekey, "pageurl": url}
        if action:
            fields["action"] = action
        return self._solve("turnstile", fields)

    def image(self, image: str | Path | bytes) -> Solution:
        """Solve an image/text CAPTCHA.

        ``image`` may be a file path, raw bytes, a base64 string, or a
        ``data:`` URL. For simple readable images, a vision model is cheaper —
        reach for the service only when that is unavailable or unsure.
        """

        return self._solve("image", {"method": "base64", "body": _to_base64(image)})


def _resolve_api_key(explicit: str | None) -> str:
    if explicit is not None:
        return explicit.strip()
    configured = os.environ.get("CAPTCHA_SOLVER_API_KEY", "").strip()
    if configured:
        return configured
    key_file = Path(
        os.environ.get("CAPTCHA_SOLVER_API_KEY_FILE", "")
        or betterwright_home() / DEFAULT_KEY_FILE
    ).expanduser()
    try:
        if os.name != "nt" and key_file.stat().st_mode & 0o077:
            raise CaptchaError(f"CAPTCHA solver key file must be private (chmod 600): {key_file}")
        return key_file.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def _to_base64(image: str | Path | bytes) -> str:
    if isinstance(image, bytes):
        return base64.b64encode(image).decode()
    text = os.fspath(image) if isinstance(image, Path) else str(image)
    candidate = Path(text)
    try:
        if candidate.exists():
            return base64.b64encode(candidate.read_bytes()).decode()
    except OSError:
        pass
    if text.startswith("data:") and "," in text:
        return text.split(",", 1)[1]
    return text


__all__ = [
    "CaptchaError",
    "CaptchaSolver",
    "CaptchaType",
    "DEFAULT_BASE_URL",
    "DEFAULT_KEY_FILE",
    "Solution",
]
