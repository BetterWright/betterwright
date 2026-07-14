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
    with BetterWright(
        home=tmp_path,
        policy=NetworkPolicy(),
        browser="chromium",
        headless=True,
    ) as bw:
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
    assert result.challenges[0]["solve"]["maxAttempts"] == 3
    assert any("solve it before retrying" in warning for warning in result.warnings)
    assert any(artifact.kind == "captcha" for artifact in result.artifacts)


def test_iframe_only_bot_challenge_is_reported(browser):
    result = browser.run(
        "await page.setContent('<iframe srcdoc=\"<h1>Verify you are human</h1>\"></iframe>'); "
        "return 'loaded'"
    )
    assert result.ok, result.error
    assert any(
        challenge["type"] == "bot_challenge"
        and challenge["detectedIn"] == "frame"
        for challenge in result.challenges
    )


def test_failed_run_preserves_bot_challenge_evidence(browser):
    result = browser.run(
        "await page.setContent('<h1>Verify you are human to continue</h1>'); "
        "throw new Error('blocked action')"
    )
    assert not result.ok
    assert "blocked action" in (result.error or "")
    assert result.challenges[0]["type"] == "bot_challenge"
    assert any(artifact.kind == "captcha" for artifact in result.artifacts)


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


def test_captcha_inspect_emits_challenge_image(browser):
    result = browser.run(
        "await page.setContent('<div id=\"challenge\" "
        "style=\"width:300px;height:180px\">Select every bus</div>'); "
        "const bounds = await page.locator('#challenge').boundingBox(); "
        "return captcha.inspect(bounds)"
    )
    assert result.ok, result.error
    assert result.value["kind"] == "captcha"
    assert "Inspect the attached challenge" in result.value["instruction"]


def test_human_helpers_drive_pointer_keyboard_and_wheel(browser):
    result = browser.run(
        r"""
        await page.setContent(`
          <button id="go" style="margin:80px;width:180px;height:50px">Go</button>
          <input id="name" style="display:block;margin:40px;width:240px;height:40px" value="old">
          <div style="height:2400px"></div>
          <p id="status">Waiting</p>
          <script>
            window.pointerMoves = 0;
            window.wheelEvents = 0;
            document.addEventListener('pointermove', () => window.pointerMoves++);
            document.addEventListener('wheel', () => window.wheelEvents++);
            document.querySelector('#go').addEventListener('click', () => {
              document.querySelector('#status').textContent = 'Clicked';
            });
          <\/script>
        `);
        await human.click(page.locator('#go'));
        await human.type('#name', 'Ada');
        await human.scroll(600, {steps: 6});
        return page.evaluate(() => ({
          status: document.querySelector('#status').textContent,
          value: document.querySelector('#name').value,
          pointerMoves: window.pointerMoves,
          wheelEvents: window.wheelEvents,
          scrollY,
        }));
        """
    )
    result.raise_for_status()
    assert result.value["status"] == "Clicked"
    assert result.value["value"] == "Ada"
    assert result.value["pointerMoves"] >= 18
    assert result.value["wheelEvents"] >= 2
    assert result.value["scrollY"] > 0


def test_sessions_are_isolated(browser):
    browser.run("state.marker = 'a'; return state.marker", session="a")
    other = browser.run("return state.marker ?? 'unset'", session="b")
    assert other.value == "unset"
