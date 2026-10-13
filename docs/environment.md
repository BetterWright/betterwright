# Environment variables

Every `BETTERWRIGHT_*` variable the runtime reads, grouped by what it
controls. Flags and constructor options beat the environment where both exist.
Variables for external services (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
provider keys, endpoint base URLs) are listed in [agent.md](agent.md) and
[browser-providers.md](browser-providers.md), not here.

A handful of `BETTERWRIGHT_*` names exist only for the build and test harness
(`BETTERWRIGHT_COVERAGE`, `BETTERWRIGHT_REQUIRE_BROWSER`,
`BETTERWRIGHT_REQUIRE_RECORDING`, `BETTERWRIGHT_LIVE_CAPTCHA`) or as internal
overrides used by development and CI. They are not supported configuration and
are not listed below.

## Saved launch defaults

Every host (SDK, CLI, MCP, and Pi) reads the `launch` section of
`$BETTERWRIGHT_HOME/config.json` when constructing a browser. For example:

```json
{
  "launch": {
    "headless": true,
    "profile": "research",
    "adBlock": true,
    "locale": "en-US",
    "timezone": "America/New_York",
    "downloadPolicy": "ask"
  }
}
```

The allowed keys are `headless` (boolean or `"auto"`), `headedInvisible`
(boolean), `profile` (valid profile name or `null` for the shared profile),
`adBlock` (boolean), `locale` (BCP 47), `timezone` (IANA), and
`downloadPolicy` (`"ask"`, `"allow"`, or `"deny"`). Unknown and invalid saved
values are ignored. Other sections, such as `browser` and `liveView`, keep
their existing meaning. Network policy, provider credentials, and arbitrary
constructor options are not accepted in `launch`.

Explicit constructor options and CLI flags override environment variables;
environment variables override saved defaults. Omitting a setting preserves
the host's existing default: the CLI starts headless, and the SDK, MCP, and Pi
use automatic display detection. `headedInvisible: true` forces a headed
window parked off-screen; an explicit `headless` option or
`BETTERWRIGHT_HEADLESS` cancels an inherited off-screen setting. Changes apply
to newly constructed browsers. Close a running CLI daemon before applying
changed launch defaults.

## Home, sessions, and the daemon

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_HOME` | `~/.betterwright` | State directory: profiles, vault, artifacts, daemon sockets, `config.json` |
| `BETTERWRIGHT_PROFILE` | unset | Select a named identity across all hosts; an explicit `profile` option or `--profile` wins |
| `BETTERWRIGHT_SESSION_TTL_SECONDS` | `900` | Idle time before a session's pages close |
| `BETTERWRIGHT_ORPHAN_GRACE_SECONDS` | `30` | Grace period before the daemon stops a run whose watcher disappeared; `0` lets detached runs finish |
| `BETTERWRIGHT_NO_DAEMON` | unset | `1` forces one-shot browsers, skipping the session daemon entirely |

See [sessions.md](sessions.md).

## Browser selection

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_BACKEND` | `auto` | `chromium-fork` requires the managed build and fails closed; any other value is an error |
| `BETTERWRIGHT_CHROMIUM_PATH` | unset | Absolute path to a BetterChromium executable; wins over the root |
| `BETTERWRIGHT_CHROMIUM_ROOT` | unset | Absolute path to an artifact root with the fixed platform layout |
| `BETTERWRIGHT_CHROMIUM_ARGS` | unset | Extra whitespace-separated Chromium switches for a managed launch; BetterWright-owned switches are rejected, duplicates dropped with a warning |
| `BETTERWRIGHT_CDP_URL` | unset | Shorthand for `provider: { cdpUrl }`; sits between `--browser` and the configured default in precedence |

`BETTERWRIGHT_BROWSER` is a rejected legacy value; it once selected a bundled
fallback browser that no longer exists. See
[attach-mode.md](attach-mode.md#managed-browser-enforcement) and
[chromium-fork.md](chromium-fork.md).

## Display and identity

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_HEADLESS` | unset | Across all hosts: `0` requests a visible window, `1` forces headless, `auto` uses display detection |
| `BETTERWRIGHT_DISPLAY` | detected | `1` forces headed-capable detection, `0` forces headless |
| `BETTERWRIGHT_LOCALE` | unset | Browser locale (BCP 47) across all hosts; `locale` or `--locale` wins |
| `BETTERWRIGHT_TIMEZONE` | unset | Browser timezone (IANA) across all hosts; `timezone` or `--timezone` wins |

Identity must match egress geography; see
[launch-identity.md](launch-identity.md) and
[attach-mode.md](attach-mode.md#choosing-the-display-mode).

## Network and downloads

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_BLOCK_PRIVATE_NETWORK` | unset | `1` denies RFC 1918/intranet destinations |
| `BETTERWRIGHT_BLOCK_LOOPBACK` | unset | `1` denies loopback destinations |
| `BETTERWRIGHT_ALLOW_HOSTS` | unset | Re-allow listed hosts inside a blocked scope |
| `BETTERWRIGHT_BLOCK_HOSTS` | unset | Deny listed hosts |
| `BETTERWRIGHT_PUBLIC_SEARCH_POLICY` | `allow` | `block` has the worker refuse public search-result UIs |
| `BETTERWRIGHT_DOWNLOAD_POLICY` | `ask` | `allow` lets any run save files; `deny` disables downloads entirely |

See [network-policy.md](network-policy.md) and
[SETUP.md](../SETUP.md#6--safeguards-configure-to-taste).

## Features

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_AD_BLOCK` | on | `0` disables ad/tracker blocking across the API, CLI, MCP, and Pi; `1` enables it. An explicit option or flag wins |
| `BETTERWRIGHT_PARK_BACKGROUND_PAGES` | on | `0` keeps idle headless pages running between calls instead of parking them |
| `BETTERWRIGHT_STEALTH_RUNTIME_FIX` | off | `1` runs snippets in an isolated world through the optional `patchright-core` driver |
| `BETTERWRIGHT_FFMPEG_PATH` | `PATH` lookup | Absolute path to an FFmpeg binary for recording |

## Live view

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_LIVE_VIEW` | unset | MCP only: `1` permits a non-loopback bind host |
| `BETTERWRIGHT_LIVE_VIEW_EXPOSE` | `lan` | Hosting preset: `lan`, `local`, or `tailscale` |
| `BETTERWRIGHT_LIVE_VIEW_HOST` | `0.0.0.0` | Bind host |
| `BETTERWRIGHT_LIVE_VIEW_PORT` | ephemeral | Bind port |
| `BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST` | LAN IPv4 | Host printed in the URL when binding wildcard |
| `BETTERWRIGHT_LIVE_VIEW_PASSWORD` | unset | Viewer password for MCP deployments that cannot use `view --set-password` |

See [live-view.md](live-view.md).

## Timeouts

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_TIMEOUT_SECONDS` | `120` (MCP) | Per-snippet timeout for the MCP server, minimum 5 |
| `BETTERWRIGHT_WORKER_START_TIMEOUT_MS` | `15000` | How long the client waits for a fresh worker's ready handshake before killing it |

## Credential vault

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE` | unset | `1` lets `vault show --reveal` write to a redirected or piped stdout, same as `--force` |

See [credentials.md](credentials.md#getting-a-password-back-betterwright-vault).

## Model backends

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_MODEL` | unset | Default `--model` for `exec` and the console |
| `BETTERWRIGHT_MODEL_BASE_URL` | unset | Default custom OpenAI-compatible endpoint |
| `BETTERWRIGHT_MODEL_API_KEY` | unset | Key for that custom endpoint |
| `BETTERWRIGHT_MODEL_PROTOCOL` | `chat` | `chat` or `responses` |
| `BETTERWRIGHT_CLAUDE_MODEL` | built-in | Default id `betterwright models` shows for Claude |
| `BETTERWRIGHT_CODEX_MODEL` | built-in | Default id shown for Codex |
| `BETTERWRIGHT_GROK_MODEL` | built-in | Default id shown for Grok |

Endpoint and key variables for each source (`OPENROUTER_API_KEY`,
`OLLAMA_BASE_URL`, `CODEX_BASE_URL`, `XAI_API_KEY`, and friends) are tabulated
in [agent.md](agent.md#preset-endpoints-and-environment).

## Pi extension

| Variable | Default | Effect |
| --- | --- | --- |
| `BETTERWRIGHT_PI_START_URL` | unset | Navigate once to an HTTP(S) start page before the first tool call |
| `BETTERWRIGHT_PI_MAX_STEPS` | unset | Positive browser-tool step budget |
| `BETTERWRIGHT_PI_SESSION` | `pi` | Persistent BetterWright session name |
| `BETTERWRIGHT_PI_TRACE_DIR` | unset | Write JSONL steps and copied screenshots for evaluation or audit |
| `BETTERWRIGHT_PI_AUTO_SCREENSHOT` | on | Attach the active page after a call that produced no image |
| `BETTERWRIGHT_PI_TIMEOUT_SECONDS` | unset | Per-snippet BetterWright timeout |
| `BETTERWRIGHT_PI_DOWNLOAD_POLICY` | `ask` | `ask`, `allow`, or `deny`; non-interactive `ask` fails closed |
| `BETTERWRIGHT_PI_REQUIRE_EVIDENCE` | off | When set, browser tools refuse to run until `browser_evidence` is initialized with every atomic task requirement |

See [SETUP.md](../SETUP.md#2--pi-coding-agent).
