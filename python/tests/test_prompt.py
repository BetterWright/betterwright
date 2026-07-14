"""Tests for the operator guidance and its guardrails."""

from betterwright.prompt import Guardrails, agent_system_prompt


def test_default_prompt_is_permissive():
    prompt = agent_system_prompt()
    compact = " ".join(prompt.split())
    assert "You are authorized" in prompt
    # It explicitly tells the model not to refuse authorized actions.
    assert "do not refuse" in prompt.lower()
    assert "automate Google or Bing's public search UI" in prompt
    assert "captcha.inspect(bounds)" in compact
    assert "captcha.click(bounds)" in compact
    assert "captcha.drag(from, to)" in compact
    assert "captcha.readText(bounds)" in compact
    assert "human.click(target)" in compact
    assert "human.type(target, text)" in compact
    assert "human.scroll(deltaY)" in compact
    assert "host's approval-gated download tool" in compact
    assert "before enabling that one bounded download run" in compact
    assert "three distinct stages" in compact
    assert "stop native challenge attempts immediately" in compact
    assert "Replay the original action only when it is idempotent" in compact
    assert "never duplicate a submission, purchase, or message" in compact
    assert "Inspect the returned image itself before citing it" in compact
    assert "fix the page and retake it" in compact
    assert "Guardrails for this session" not in prompt


def test_no_guardrails_equals_default():
    assert agent_system_prompt(Guardrails()) == agent_system_prompt()


def test_confirm_before_purchase_adds_clause():
    prompt = agent_system_prompt(Guardrails(confirm_before_purchase=True))
    assert "Guardrails for this session" in prompt
    assert "explicit user confirmation" in prompt
    assert "order summary" in prompt


def test_forbid_purchases_supersedes_confirm():
    guard = Guardrails(forbid_purchases=True, confirm_before_purchase=True)
    prompt = agent_system_prompt(guard)
    assert "Do not complete any purchase" in prompt
    # The weaker confirm clause is not also emitted.
    assert "get explicit user confirmation. Never complete a purchase" not in prompt


def test_spending_limit_included_verbatim():
    prompt = agent_system_prompt(Guardrails(spending_limit="$50"))
    assert "$50" in prompt


def test_spending_limit_omitted_when_purchases_forbidden():
    prompt = agent_system_prompt(Guardrails(forbid_purchases=True, spending_limit="$50"))
    assert "$50" not in prompt


def test_extra_rules_appended():
    prompt = agent_system_prompt(Guardrails(extra_rules=("Only browse example.com.",)))
    assert "Only browse example.com." in prompt


def test_forbid_account_creation():
    prompt = agent_system_prompt(Guardrails(forbid_account_creation=True))
    assert "Do not create new accounts" in prompt


def test_password_manager_section_omitted_by_default():
    assert "## Password manager" not in agent_system_prompt()


def test_password_manager_section_added_when_set():
    prompt = agent_system_prompt(Guardrails(password_manager="1Password"))
    assert "## Password manager" in prompt
    assert "1Password badge" in prompt
    assert "on-screen position" in prompt


def test_password_manager_name_normalized():
    prompt = agent_system_prompt(Guardrails(password_manager="1password"))
    assert "A 1Password extension" in prompt


def test_password_manager_precedes_guardrails():
    prompt = agent_system_prompt(
        Guardrails(password_manager="1Password", confirm_before_purchase=True)
    )
    assert prompt.index("## Password manager") < prompt.index(
        "## Guardrails for this session"
    )
