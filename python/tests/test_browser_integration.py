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


def test_visible_bot_challenge_is_reported(browser):
    result = browser.run(
        "await page.setContent('<h1>One last step</h1>"
        "<p>Please solve the challenge below to continue</p>'); return 'loaded'"
    )
    assert result.ok, result.error
    assert result.challenges[0]["type"] == "bot_challenge"
    assert "Do not retry" in result.warnings[0]


def test_captcha_click_activates_checkbox_style_challenge(browser):
    result = browser.run(
        "await page.setContent('<button id=\"verify\">Verify you are human</button>'); "
        "await page.locator('#verify').evaluate(element => {"
        "element.addEventListener('click', () => {element.textContent = 'Verified'});}); "
        "const bounds = await page.locator('#verify').boundingBox(); "
        "return captcha.click(bounds)"
    )
    assert result.ok, result.error
    assert "Verified" in result.value


def test_captcha_drag_performs_pointer_drag(browser):
    result = browser.run(
        "await page.setContent(`<button id=\"handle\" "
        "style=\"position:absolute;left:40px;top:40px;width:40px;height:40px\">Slide</button>"
        "<p id=\"status\" aria-live=\"polite\">Waiting</p><script>let started=false;"
        "document.querySelector('#handle').addEventListener('mousedown',()=>{started=true});"
        "document.addEventListener('mouseup',event=>{if(started&&event.clientX>200)"
        "document.querySelector('#status').textContent='Dragged'});<\\/script>`); "
        "const bounds = await page.locator('#handle').boundingBox(); "
        "const from = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2}; "
        "return captcha.drag(from, {x: 260, y: from.y}, {steps: 12})"
    )
    assert result.ok, result.error
    assert "Dragged" in result.value


def test_captcha_read_text_emits_cropped_image(browser):
    result = browser.run(
        "await page.setContent('<div id=\"code\" "
        "style=\"font:32px monospace;width:220px;height:70px\">A7K9</div>'); "
        "const bounds = await page.locator('#code').boundingBox(); "
        "return captcha.readText(bounds)"
    )
    assert result.ok, result.error
    assert result.value["kind"] == "captcha"
    shots = result.screenshots("captcha")
    assert len(shots) == 1
    assert shots[0].read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_sessions_are_isolated(browser):
    browser.run("state.marker = 'a'; return state.marker", session="a")
    other = browser.run("return state.marker ?? 'unset'", session="b")
    assert other.value == "unset"
