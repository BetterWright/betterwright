# Python API reference

```python
from betterwright import (
    BetterWright, Session, RunResult, Artifact, BrowserError,
    NetworkPolicy, CredentialVault,
)
```

## `BetterWright`

```python
BetterWright(
    *,
    home: Path | None = None,          # state dir; default $BETTERWRIGHT_HOME or ~/.betterwright
    policy: NetworkPolicy | None = None,   # default: safe policy
    vault: CredentialVault | bool | None = True,   # True → default vault; False/None → disabled
    browser: str | None = None,        # "cloak" default; "chromium" fallback
    executable_path: str | None = None,    # explicit binary selects Chromium fallback
    headless: bool | str = "auto",
    default_timeout: int = 30,             # per-snippet seconds, min 5
    connect_over_cdp: str | None = None,   # trusted host attach mode only
    public_search_policy: str | None = None, # "block" default; "allow" opt-in
    search_min_interval_ms: int = 0,
    download_policy: str = "ask",          # "ask", "allow", or "deny"
)
```

The managed Cloak backend is the default. It keeps BetterWright's stable profile
and policy while reducing common stock-browser automation signals; it cannot
guarantee undetectability. Choose `browser="chromium"` for compatibility or
deterministic tests, with the caveat that stock Chromium exposes more automation
signals. `BETTERWRIGHT_BROWSER` sets the process-wide default.

`connect_over_cdp` is trusted host configuration, not a model tool parameter.
Model-authored snippets cannot access CDP, the raw browser object, or
`newCDPSession`.

For broad discovery, use the host's web-search tool and open its returned
results in BetterWright rather than automating Google or Bing's public search
UI.
The default is enforced by the worker. Trusted hosts can opt in with
`public_search_policy="allow"` or
`BETTERWRIGHT_PUBLIC_SEARCH_POLICY=allow`; pacing applies only after that opt-in.

| Method / property | Description |
| --- | --- |
| `run(code, *, session="default", note=None, timeout=None, approved_downloads=False) -> RunResult` | Execute one snippet. |
| `session(name) -> Session` | A handle bound to one named session. |
| `policy -> NetworkPolicy` | The active policy. |
| `vault -> CredentialVault \| None` | The active vault, if any. |
| `close()` | Shut the worker down. Idempotent. |

`BetterWright` is a context manager; prefer `with BetterWright() as bw:` so the
worker is always closed. `note` is a present-tense status line for host UIs and
is not interpreted by the browser.

### Download approval

The default `download_policy="ask"` keeps browser downloads denied during
ordinary runs. A trusted host must ask the user first, then set
`approved_downloads=True` on that one run. Set `download_policy="allow"` to
remove the approval prompt while retaining size and artifact quotas, or `"deny"`
to block downloads even from approved runs.

## `Session`

```python
session = bw.session("checkout")
session.run(code, *, note=None, timeout=None, approved_downloads=False) -> RunResult
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
| `screenshots(kind=None) -> list[Artifact]` | Captured screenshots, optionally filtered by `"proof"`/`"question"`/`"debug"`/`"captcha"`. |
| `raise_for_status() -> RunResult` | Raise `BrowserError` if `not ok`; else return self. |

### `Artifact`

`kind` (`"proof"`, `"question"`, `"debug"`, `"captcha"`, `"download"`, `"artifact"`), `path`,
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

## Trusted credential fill

```python
BetterWright.fill_credential(*, password_selector, username_selector=None,
    confirm_password_selector=None, submit_selector=None, record_id=None,
    username=None, session="default", timeout=None) -> RunResult
BetterWright.generate_and_fill_credential(*, password_selector,
    confirm_password_selector=None, username_selector=None, submit_selector=None,
    username="", label=None, length=24, include_symbols=True,
    session="default", timeout=None) -> RunResult
```

Fill a stored (or freshly generated) credential into the current page from
trusted host code. The worker fetches the secret, types the fields, and can
submit — all outside the model sandbox — and returns only non-secret metadata
(`filled`, `submitted`, record `id`). The password never reaches this process.
`generate_and_fill_credential` is the safe primitive for signing up. Also
available on a named `Session`. See [credentials.md](credentials.md).

## `ensure_chrome_cdp`

```python
from betterwright import ensure_chrome_cdp
ensure_chrome_cdp(*, home=None, port=None, executable_path="", timeout=None)
    -> {"endpoint": str, "profile_dir": str, "started": bool}
```

Reuse a running debug Chrome or launch a real Google Chrome with a persistent
profile and return its CDP endpoint. `BetterWright(connect_over_cdp="auto")` does
this for you. See [attach-mode.md](attach-mode.md).

## Native CAPTCHA helpers

Code passed to `BetterWright.run()` receives `captcha.inspect(bounds?)`,
`captcha.click(bounds)`, `captcha.drag(from, to)`, and
`captcha.readText(bounds)`. Detected challenges attach a `captcha` image to the
result automatically. Work through at most three distinct stages, checking the
fresh result after each action, and resume the original action when the
challenge clears. After three unresolved stages, use an alternate first-party
source or request human help. No separate Python solver object or API key is
required. See [captcha.md](captcha.md).

## Human-shaped actions

Browser snippets also receive `human.click(target)`, `human.type(target, text)`,
and `human.scroll(deltaY)`. See the
[browser API](browser-api.md#human-shaped-interactions) for details.

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
