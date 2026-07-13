"""End-to-end tests that drive a real browser.

Skipped automatically when the runtime is not installed, so the fast unit
suite still runs anywhere. Run `betterwright setup` to enable these.
"""

import pytest

from betterwright import BetterWright, NetworkPolicy
from betterwright.runtime import diagnose

pytestmark = pytest.mark.skipif(
    not diagnose()["ready"],
    reason="browser runtime not installed (run `betterwright setup`)",
)


@pytest.fixture
def browser(tmp_path):
    with BetterWright(home=tmp_path, policy=NetworkPolicy(), headless=True) as bw:
        yield bw


def test_navigate_and_read_title(browser):
    result = browser.run(
        "await page.goto('https://example.com'); return page.title()"
    )
    assert result.ok, result.error
    assert result.value == "Example Domain"


def test_screenshot_produces_png(browser):
    browser.run("await page.goto('https://example.com')")
    result = browser.run("return screenshot({kind: 'proof', name: 'home'})")
    assert result.ok, result.error
    shots = result.screenshots("proof")
    assert len(shots) == 1
    assert shots[0].path.endswith(".png")


def test_metadata_endpoint_blocked(browser):
    result = browser.run(
        "await page.goto('http://169.254.169.254/latest/meta-data/'); return 'reached'"
    )
    assert not result.ok


def test_sessions_are_isolated(browser):
    browser.run("state.marker = 'a'; return state.marker", session="a")
    other = browser.run("return state.marker ?? 'unset'", session="b")
    assert other.value == "unset"
