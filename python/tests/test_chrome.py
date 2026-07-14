"""Tests for the attach/auto-launch CDP helper (`connect_over_cdp="auto"`)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from betterwright import chrome as chrome_mod
from betterwright import ensure_chrome_cdp
from betterwright.bridge import Bridge


class _VersionHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server API
        if self.path == "/json/version":
            body = json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1/x"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):  # silence
        pass


@pytest.fixture
def cdp_endpoint():
    server = HTTPServer(("127.0.0.1", 0), _VersionHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()


def test_reuses_a_running_debug_endpoint(cdp_endpoint, tmp_path):
    info = ensure_chrome_cdp(home=tmp_path, port=cdp_endpoint)
    assert info["started"] is False
    assert info["endpoint"] == f"http://127.0.0.1:{cdp_endpoint}"


def test_requires_chrome_when_nothing_is_listening(tmp_path, monkeypatch):
    monkeypatch.setattr(chrome_mod, "find_chrome_executable", lambda explicit="": None)
    with pytest.raises(RuntimeError, match="not installed"):
        ensure_chrome_cdp(home=tmp_path, port=59997)


def test_find_chrome_executable_honors_explicit_path(tmp_path):
    fake = tmp_path / "chrome"
    fake.write_text("x")
    assert chrome_mod.find_chrome_executable(str(fake)) == str(fake)


def test_bridge_resolves_auto_to_endpoint(tmp_path, monkeypatch):
    calls = []

    def fake_ensure(**kwargs):
        calls.append(kwargs)
        return {
            "endpoint": "http://127.0.0.1:9999",
            "profile_dir": str(tmp_path),
            "started": True,
        }

    monkeypatch.setattr(chrome_mod, "ensure_chrome_cdp", fake_ensure)
    bridge = Bridge(home=tmp_path, connect_over_cdp="auto")
    try:
        bridge._resolve_cdp_endpoint()
        assert bridge.connect_over_cdp == "http://127.0.0.1:9999"
        assert bridge._cdp_resolved is True
        # Idempotent: a second call does not relaunch/reresolve.
        bridge._resolve_cdp_endpoint()
        assert len(calls) == 1
    finally:
        bridge.close()


def test_bridge_leaves_explicit_endpoint_untouched(tmp_path):
    bridge = Bridge(home=tmp_path, connect_over_cdp="http://127.0.0.1:9222")
    try:
        bridge._resolve_cdp_endpoint()
        assert bridge.connect_over_cdp == "http://127.0.0.1:9222"
    finally:
        bridge.close()
