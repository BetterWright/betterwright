# Python API reference

```python
from betterwright import (
    BetterWright, Session, RunResult, Artifact, BrowserError,
    NetworkPolicy, CredentialVault,
)
from betterwright.captcha import CaptchaSolver, Solution, CaptchaError
```

## `BetterWright`

```python
BetterWright(
    *,
    home: Path | None = None,          # state dir; default $BETTERWRIGHT_HOME or ~/.betterwright
    policy: NetworkPolicy | None = None,   # default: safe policy
    vault: CredentialVault | bool | None = True,   # True → default vault; False/None → disabled
    executable_path: str | None = None,    # explicit Chromium binary
    headless: bool = True,
    default_timeout: int = 30,             # per-snippet seconds, min 5
)
```

| Method / property | Description |
| --- | --- |
| `run(code, *, session="default", note=None, timeout=None) -> RunResult` | Execute one snippet. |
| `session(name) -> Session` | A handle bound to one named session. |
| `policy -> NetworkPolicy` | The active policy. |
| `vault -> CredentialVault \| None` | The active vault, if any. |
| `close()` | Shut the worker down. Idempotent. |

`BetterWright` is a context manager; prefer `with BetterWright() as bw:` so the
worker is always closed. `note` is a present-tense status line for host UIs and
is not interpreted by the browser.

## `Session`

```python
session = bw.session("checkout")
session.run(code, *, note=None, timeout=None) -> RunResult
```

A thin handle that forwards to `bw.run(..., session=name)`.

## `RunResult`

The typed outcome of a `run()`.

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `bool` | Whether the snippet completed without error. |
| `value` | `Any` | The snippet's return value (JSON-compatible). |
| `error` | `str \| None` | The error message when `ok` is `False`. |
| `console` | `list[dict]` | Captured `console.*` calls (`{level, text}`). |
| `events` | `list[dict]` | Page lifecycle events (downloads, popups, dialogs, crashes). |
| `artifacts` | `list[Artifact]` | Files produced (screenshots, downloads, spilled output). |
| `pages` | `list[dict]` | Open pages, each summarized `{type, pageId, url, title, closed}`. |
| `challenges` | `list[dict]` | Visible CAPTCHA/bot checks with page, provider, URL, and routing advice. |
| `warnings` | `list[str]` | Non-fatal notices (e.g. artifact-quota evictions). |
| `duration_ms` | `float` | Wall-clock time in the worker. |
| `truncated` | `bool` | `True` when the return value was spilled to a file. |

| Method | Description |
| --- | --- |
| `screenshots(kind=None) -> list[Artifact]` | Captured screenshots, optionally filtered by `"proof"`/`"question"`/`"debug"`. |
| `raise_for_status() -> RunResult` | Raise `BrowserError` if `not ok`; else return self. |

### `Artifact`

`kind` (`"proof"`, `"question"`, `"debug"`, `"download"`, `"artifact"`), `path`,
`size`, and `media_reference` (`"MEDIA:<path>"`).

## `NetworkPolicy`

```python
NetworkPolicy(
    allow_private_network: bool = False,
    allow_loopback: bool = False,
    allow_hosts: tuple[str, ...] = (),
    block_hosts: tuple[str, ...] = (),
    block_secret_bearing_urls: bool = True,
    custom: Callable[[str, dict], dict | None] | None = None,
)
```

`policy.check(url, details=None) -> {"allowed": bool, "reason"?: str}`. See
[network-policy.md](network-policy.md) for semantics and evaluation order.

## `CredentialVault`

```python
CredentialVault(root: str | Path | None = None)   # default ~/.betterwright/vault
```

Direct methods (all origin-scoped): `save`, `generate`, `update`,
`list_credentials`, `fetch_for_fill`, `reveal`, `remove`. `save`/`list`/`update`
return metadata only; `fetch_for_fill`/`reveal`/`generate` include a `secret`
for trusted use. `redact(value)` scrubs handled secrets from any JSON-like
value. See [credentials.md](credentials.md).

## `CaptchaSolver`

```python
from betterwright.captcha import CaptchaSolver
CaptchaSolver(api_key=None, *, base_url=None, timeout=180.0)
```

`recaptcha_v2`, `recaptcha_v3`, `hcaptcha`, `turnstile`, `image`, and `balance`.
Each solve returns a `Solution(type, token, request_id)` or raises
`CaptchaError`. See [captcha.md](captcha.md).

## `agent_system_prompt` and `Guardrails`

```python
from betterwright import agent_system_prompt, Guardrails

agent_system_prompt(guardrails: Guardrails | None = None) -> str
```

Returns operator guidance to include in a browser agent's system prompt. With no
guardrails the agent is told to act on authorized tasks (login, signup,
purchase) rather than hedge. `Guardrails` fields — `confirm_before_purchase`,
`confirm_before_irreversible`, `forbid_purchases`, `forbid_account_creation`,
`spending_limit`, `extra_rules` — append a guardrails section. See
[agent-prompt.md](agent-prompt.md).

## Runtime helpers

```python
from betterwright.runtime import diagnose, worker_path, playwright_core_dir
diagnose()   # {"node": …, "playwright_ok": …, "ready": bool, …}
```

`diagnose()` is what `betterwright doctor` prints and what the integration tests
gate on.
