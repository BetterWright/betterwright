"""Tests for artifact handling, image data URLs, and display resolution."""

import base64

import pytest

from betterwright._display import resolve_headless
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
