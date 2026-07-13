"""BetterWright — a persistent, policy-guarded Playwright browser for agents.

BetterWright wraps Playwright in a long-lived, sandboxed Node worker that an
LLM can drive with ordinary Playwright JavaScript. It adds the parts an
autonomous agent needs and Playwright leaves to you: a persistent profile, a
network policy enforced on every request, an encrypted credential vault, typed
screenshot artifacts for proof-of-work, and optional CAPTCHA solving.

    from betterwright import BetterWright

    with BetterWright() as bw:
        result = bw.run(
            "await page.goto('https://example.com'); return page.title()"
        )
        print(result.value)

See https://github.com/CuriosityOS/betterwright for the full documentation.
"""

from __future__ import annotations

from betterwright._home import betterwright_home
from betterwright.client import (
    Artifact,
    BetterWright,
    BrowserError,
    RunResult,
    Session,
)
from betterwright.policy import NetworkPolicy
from betterwright.prompt import Guardrails, agent_system_prompt
from betterwright.vault import (
    CredentialVault,
    VaultError,
    normalize_http_origin,
)

__version__ = "0.1.0"

__all__ = [
    "Artifact",
    "BetterWright",
    "BrowserError",
    "CredentialVault",
    "Guardrails",
    "NetworkPolicy",
    "RunResult",
    "Session",
    "VaultError",
    "__version__",
    "agent_system_prompt",
    "betterwright_home",
    "normalize_http_origin",
]
