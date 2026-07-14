"""Tests for artifact handling, image data URLs, and display resolution."""

import base64

import pytest

from betterwright import runtime
from betterwright._display import resolve_headless
from betterwright.bridge import Bridge
from betterwright.cli import _result_to_dict
from betterwright.client import Artifact, RunResult


def test_image_kinds_are_images():
    assert Artifact("proof", "/x/a.png").is_image
    assert Artifact("question", "/x/a.png").is_image
    assert Artifact("debug", "/x/a.png").is_image
    assert not Artifact("download", "/x/a.bin").is_image
    assert not Artifact("artifact", "/x/spill.json").is_image


def test_mime_type_from_extension():
    assert Artifact("proof", "/x/a.png").mime_type == "image/png"
    assert Artifact("proof", "/x/a.jpg").mime_type == "image/jpeg"
    assert Artifact("artifact", "/x/a.json").mime_type == "application/octet-stream"


def test_data_url_round_trips(tmp_path):
    png = tmp_path / "shot.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nfake-image-bytes")
    artifact = Artifact("proof", str(png))
    url = artifact.data_url()
    assert url.startswith("data:image/png;base64,")
    decoded = base64.b64decode(url.split(",", 1)[1])
    assert decoded == b"\x89PNG\r\n\x1a\nfake-image-bytes"


def test_screenshots_and_files_are_disjoint():
    result = RunResult(
        ok=True,
        artifacts=[
            Artifact("proof", "/x/proof.png"),
            Artifact("artifact", "/x/browser-output.json"),  # the spill file
            Artifact("download", "/x/report.pdf"),
        ],
    )
    assert [a.path for a in result.screenshots()] == ["/x/proof.png"]
    assert sorted(a.path for a in result.files()) == [
        "/x/browser-output.json",
        "/x/report.pdf",
    ]
    # The spill file that caused the "unsupported MIME type" error is a file,
    # never a screenshot.
    assert all(not a.is_image for a in result.files())


def test_challenges_are_preserved_from_worker_envelope():
    result = RunResult._from_envelope(
        {
            "ok": True,
            "challenges": [
                {
                    "type": "bot_challenge",
                    "provider": "bing",
                    "url": "https://www.bing.com/search?q=test",
                }
            ],
        }
    )
    assert result.challenges[0]["provider"] == "bing"


def test_cli_serialization_includes_resumable_challenges():
    challenge = {"type": "bot_challenge", "solve": {"maxAttempts": 3}}
    serialized = _result_to_dict(RunResult(ok=True, challenges=[challenge]))
    assert serialized["challenges"] == [challenge]


def test_resolve_headless_explicit():
    assert resolve_headless(True) is True
    assert resolve_headless(False) is False


def test_resolve_headless_auto(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setenv("BETTERWRIGHT_DISPLAY", "0")
    assert resolve_headless("auto") is True  # no display -> headless
    monkeypatch.setenv("BETTERWRIGHT_DISPLAY", "1")
    assert resolve_headless("auto") is False  # display -> headed


def test_resolve_headless_rejects_bad_string():
    with pytest.raises(ValueError):
        resolve_headless("maybe")


def test_cloak_is_the_managed_default(monkeypatch, tmp_path):
    monkeypatch.delenv("CLOAKBROWSER_BINARY_PATH", raising=False)
    bridge = Bridge(home=tmp_path)
    assert bridge.executable_path is None
    assert bridge.browser_flavor == "cloak"
    assert bridge._worker_config()["browserFlavor"] == "cloak"


def test_cloak_binary_env_overrides_managed_binary(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", "/opt/cloak/chrome")
    bridge = Bridge(home=tmp_path)
    assert bridge.executable_path == "/opt/cloak/chrome"
    assert bridge.browser_flavor == "cloak"
    assert bridge._worker_config()["browserFlavor"] == "cloak"


def test_explicit_binary_wins_over_cloak_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", "/opt/cloak/chrome")
    bridge = Bridge(home=tmp_path, executable_path="/opt/chromium")
    assert bridge.executable_path == "/opt/chromium"
    assert bridge.browser_flavor == "chromium"


def test_stock_chromium_must_be_selected_explicitly(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOAKBROWSER_BINARY_PATH", "/opt/cloak/chrome")
    bridge = Bridge(home=tmp_path, browser="chromium")
    assert bridge.executable_path is None
    assert bridge.browser_flavor == "chromium"
    with pytest.raises(ValueError, match="cloak.*chromium"):
        Bridge(home=tmp_path, browser="other")


def test_explicit_empty_browser_does_not_inherit_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("BETTERWRIGHT_BROWSER", "chromium")
    with pytest.raises(ValueError, match="browser"):
        Bridge(home=tmp_path, browser="")


def test_download_policy_defaults_to_ask_and_is_configurable(tmp_path):
    guarded = Bridge(home=tmp_path / "guarded")
    allowed = Bridge(home=tmp_path / "allowed", download_policy="allow")
    assert guarded.download_policy == "ask"
    assert guarded._worker_config()["downloadPolicy"] == "ask"
    assert allowed.download_policy == "allow"
    with pytest.raises(ValueError, match="download_policy"):
        Bridge(home=tmp_path / "invalid", download_policy="sometimes")


def test_public_search_ui_is_blocked_by_default_and_opt_in(tmp_path):
    guarded = Bridge(home=tmp_path / "guarded")
    allowed = Bridge(
        home=tmp_path / "allowed", public_search_policy="allow"
    )
    assert guarded._worker_config()["publicSearchPolicy"] == "block"
    assert allowed._worker_config()["publicSearchPolicy"] == "allow"
    with pytest.raises(ValueError, match="public_search_policy"):
        Bridge(home=tmp_path / "invalid", public_search_policy="pace")


def test_explicit_empty_public_search_policy_does_not_inherit_environment(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("BETTERWRIGHT_PUBLIC_SEARCH_POLICY", "allow")
    with pytest.raises(ValueError, match="public_search_policy"):
        Bridge(home=tmp_path, public_search_policy="")


def test_runtime_discovery_matches_node_ancestor_lookup(monkeypatch, tmp_path):
    package_dir = tmp_path / "project" / "python" / "src" / "betterwright"
    package_dir.mkdir(parents=True)
    node_modules = tmp_path / "project" / "node_modules"
    versions = {
        "playwright-core": runtime.PINNED_PLAYWRIGHT_VERSION,
        "cloakbrowser": runtime.PINNED_CLOAKBROWSER_VERSION,
    }
    for package, version in versions.items():
        target = node_modules / package
        target.mkdir(parents=True)
        (target / "package.json").write_text(
            f'{{"version":"{version}"}}', encoding="utf-8"
        )

    monkeypatch.setattr(runtime, "__file__", str(package_dir / "runtime.py"))
    monkeypatch.setattr(runtime, "betterwright_home", lambda: tmp_path / "home")
    monkeypatch.delenv("BETTERWRIGHT_PLAYWRIGHT_CORE_PATH", raising=False)
    monkeypatch.delenv("BETTERWRIGHT_CLOAKBROWSER_PATH", raising=False)

    assert runtime.playwright_core_dir() == (node_modules / "playwright-core").resolve()
    assert runtime.cloakbrowser_dir() == (node_modules / "cloakbrowser").resolve()


def test_diagnose_reports_cloak_binary_identity(monkeypatch, tmp_path):
    worker = tmp_path / "worker.mjs"
    worker.write_text("", encoding="utf-8")
    core = tmp_path / "playwright-core"
    cloak = tmp_path / "cloakbrowser"
    core.mkdir()
    cloak.mkdir()

    monkeypatch.setattr(runtime, "node_executable", lambda: "/usr/bin/node")
    monkeypatch.setattr(runtime, "worker_path", lambda: worker)
    monkeypatch.setattr(runtime, "playwright_core_dir", lambda: core)
    monkeypatch.setattr(runtime, "cloakbrowser_dir", lambda: cloak)
    monkeypatch.setattr(
        runtime,
        "_cloak_binary_info",
        lambda _node, _cloak: {
            "version": "145.0.7632.109.2",
            "tier": "free",
            "binaryPath": "/cache/cloak/chrome",
            "installed": True,
        },
    )
    monkeypatch.delenv("BETTERWRIGHT_BROWSER", raising=False)

    report = runtime.diagnose()

    assert report["cloakbrowser_binary_version"] == "145.0.7632.109.2"
    assert report["cloakbrowser_binary_tier"] == "free"
    assert report["ready"] is True
