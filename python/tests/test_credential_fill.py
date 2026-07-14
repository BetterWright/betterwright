"""Trusted credential-fill tests, including confirm-password (signup) flows.

The browser-driven cases are skipped automatically when the runtime is not
installed, so the fast unit suite still runs anywhere.
"""

import pytest

from betterwright import BetterWright, CredentialVault, NetworkPolicy
from betterwright.client import _build_fill_spec
from betterwright.runtime import diagnose

ORIGIN = "https://example.com"

# A username + password + confirm-password form served from the example.com
# origin (setContent keeps the page URL, so the vault scopes to that origin).
SIGNUP_FORM = (
    "<form>"
    "<input id='u' name='username'>"
    "<input id='p' name='password' type='password'>"
    "<input id='c' name='confirm' type='password'>"
    "<button id='go' type='button'>Sign up</button>"
    "<p id='status'>idle</p>"
    "<script>document.querySelector('#go').addEventListener('click',()=>{"
    "document.querySelector('#status').textContent="
    "document.querySelector('#p').value&&"
    "document.querySelector('#p').value===document.querySelector('#c').value"
    "?'submitted':'mismatch';});<\\/script>"
    "</form>"
)


# --- unit: spec construction (no browser) --------------------------------


def test_build_fill_spec_defaults_to_fill_action():
    spec = _build_fill_spec(password_selector="#p", username="alice")
    assert spec["action"] == "fill"
    assert spec["fields"]["passwordSelector"] == "#p"
    assert spec["record"] == {"username": "alice"}


def test_build_fill_spec_generate_carries_options():
    spec = _build_fill_spec(
        password_selector="#p",
        confirm_password_selector="#c",
        generate={"username": "alice", "label": None, "length": 32,
                  "includeSymbols": False},
    )
    assert spec["action"] == "generate"
    assert spec["fields"]["confirmPasswordSelector"] == "#c"
    assert spec["generate"]["length"] == 32


def test_build_fill_spec_omits_empty_record_selectors():
    spec = _build_fill_spec(password_selector="#p")
    assert spec["record"] == {}


# --- integration: real browser -------------------------------------------

pytestmark = pytest.mark.skipif(
    not diagnose()["ready"],
    reason="browser runtime not installed (run `betterwright setup`)",
)


@pytest.fixture
def browser(tmp_path):
    vault = CredentialVault(tmp_path / "vault")
    with BetterWright(
        home=tmp_path,
        policy=NetworkPolicy(),
        vault=vault,
        browser="chromium",
        headless=True,
    ) as bw:
        bw.run(f"await page.goto('{ORIGIN}')").raise_for_status()
        yield bw


def _load_form(browser):
    browser.run(f"await page.setContent(`{SIGNUP_FORM}`)").raise_for_status()


def test_generate_and_fill_populates_both_password_fields(browser):
    _load_form(browser)
    result = browser.generate_and_fill_credential(
        username_selector="#u",
        password_selector="#p",
        confirm_password_selector="#c",
        username="alice",
    )
    result.raise_for_status()

    assert result.value["filled"] == ["username", "password", "confirmPassword"]
    assert result.value["submitted"] is False
    assert "secret" not in result.value  # the password never comes back
    assert result.value["id"].startswith("cred_")

    # Booleans are not redacted: prove both fields hold the same non-empty value
    # and the username (not a secret) was typed as given.
    checks = browser.run(
        "return page.evaluate(() => ({"
        "match: document.querySelector('#p').value === "
        "document.querySelector('#c').value, "
        "empty: document.querySelector('#p').value.length === 0, "
        "uname: document.querySelector('#u').value}))"
    )
    checks.raise_for_status()
    assert checks.value == {"match": True, "empty": False, "uname": "alice"}

    # The generated secret is stored, scoped to this origin, with metadata only.
    stored = browser.vault.list_credentials(ORIGIN)
    assert len(stored) == 1
    assert stored[0]["username"] == "alice"
    assert "password" not in stored[0]


def test_generated_secret_is_redacted_from_run_output(browser):
    _load_form(browser)
    browser.generate_and_fill_credential(
        password_selector="#p", confirm_password_selector="#c"
    ).raise_for_status()
    # Reading the raw field value back must not surface the secret.
    leaked = browser.run(
        "return page.evaluate(() => document.querySelector('#p').value)"
    )
    leaked.raise_for_status()
    assert "REDACT" in leaked.value


def test_fill_existing_credential_and_submit(browser):
    browser.vault.save(ORIGIN, "bob", "bob-secret-passphrase-1234")
    _load_form(browser)
    result = browser.fill_credential(
        username="bob",
        username_selector="#u",
        password_selector="#p",
        confirm_password_selector="#c",
        submit_selector="#go",
    )
    result.raise_for_status()
    assert result.value["submitted"] is True
    status = browser.run(
        "return page.evaluate(() => document.querySelector('#status').textContent)"
    )
    status.raise_for_status()
    assert status.value == "submitted"


def test_missing_credential_reports_error(browser):
    _load_form(browser)
    result = browser.fill_credential(password_selector="#p", username="nobody")
    assert not result.ok
    assert "credential" in (result.error or "").lower()


def test_model_snippet_cannot_fill(browser):
    _load_form(browser)
    result = browser.run(
        "return credentials.fill({username: 'bob', "
        "usernameSelector: '#u', passwordSelector: '#p'})"
    )
    assert not result.ok
    assert "disabled" in (result.error or "").lower()
