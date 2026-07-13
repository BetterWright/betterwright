"""Tests for the CAPTCHA solver's protocol handling (no live network)."""

import pytest

from betterwright.captcha import CaptchaError, CaptchaSolver, Solution


class _FakeService:
    """Records the last submit and scripts the poll sequence."""

    def __init__(self, submit_response, poll_responses):
        self.submit_response = submit_response
        self.poll_responses = list(poll_responses)
        self.last_fields = None

    def post(self, url, fields):
        self.last_fields = fields
        return self.submit_response

    def get(self, url, params):
        return self.poll_responses.pop(0)


@pytest.fixture
def solver(monkeypatch):
    solver = CaptchaSolver(api_key="test-key", timeout=1)
    fake = _FakeService('{"status":"1","request":"req-123"}', ['{"status":"1","request":"the-token"}'])
    monkeypatch.setattr(CaptchaSolver, "_post", staticmethod(fake.post))
    monkeypatch.setattr(CaptchaSolver, "_get", staticmethod(fake.get))
    monkeypatch.setattr("betterwright.captcha._FIRST_POLL_DELAY_S", 0)
    solver._fake = fake
    return solver


def test_recaptcha_v2_submit_fields(solver):
    solution = solver.recaptcha_v2("SITEKEY", "https://example.com")
    assert isinstance(solution, Solution)
    assert solution.token == "the-token"
    assert solution.request_id == "req-123"
    assert solver._fake.last_fields["method"] == "userrecaptcha"
    assert solver._fake.last_fields["googlekey"] == "SITEKEY"


def test_turnstile_fields(solver):
    solver.turnstile("TS-KEY", "https://example.com", action="login")
    assert solver._fake.last_fields["method"] == "turnstile"
    assert solver._fake.last_fields["action"] == "login"


def test_missing_key_raises():
    with pytest.raises(CaptchaError, match="not set"):
        CaptchaSolver(api_key="").recaptcha_v2("k", "https://example.com")


def test_service_error_propagates(monkeypatch):
    solver = CaptchaSolver(api_key="key", timeout=1)
    monkeypatch.setattr(
        CaptchaSolver, "_post", staticmethod(lambda url, fields: "ERROR_ZERO_BALANCE")
    )
    with pytest.raises(CaptchaError, match="ERROR_ZERO_BALANCE"):
        solver.hcaptcha("k", "https://example.com")


def test_not_ready_then_solved(monkeypatch):
    solver = CaptchaSolver(api_key="key", timeout=5)
    polls = ["CAPCHA_NOT_READY", '{"status":"1","request":"tok"}']
    monkeypatch.setattr(
        CaptchaSolver, "_post", staticmethod(lambda url, fields: '{"status":"1","request":"id"}')
    )
    monkeypatch.setattr(CaptchaSolver, "_get", staticmethod(lambda url, params: polls.pop(0)))
    monkeypatch.setattr("betterwright.captcha._FIRST_POLL_DELAY_S", 0)
    monkeypatch.setattr("betterwright.captcha._POLL_INTERVAL_S", 0)
    assert solver.image(b"fake-bytes").token == "tok"
