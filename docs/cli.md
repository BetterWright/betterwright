# CLI reference

`betterwright <command>` runs one command. Bare `betterwright` opens the
interactive agent console documented in [agent.md](agent.md#interactive-console-betterwright).

`--version` (or `-v`) prints the package version without loading anything else.
`betterwright <command> --help` prints the command's own help text, which this
page mirrors. `betterwright help <command>` does the same thing.

Commands group into setup, driving the browser, and agent integration. Options
marked "shared" below are the browser options accepted by `run`, `repl`,
`exec`, and the interactive console together:

| Shared flag | Effect |
| --- | --- |
| `--session <name>` | Which persistent session to use (default `"default"`) |
| `--profile <name>` | A separate identity with its own cookies and daemon (`BETTERWRIGHT_PROFILE` sets one for the whole shell) |
| `--headed` | Show the browser window |
| `--headed-invisible` | Headed window parked off-screen |
| `--no-daemon` | Skip the session daemon; one-shot browser per call |
| `--browser <name\|url>` | Cloud provider name or `wss://` CDP endpoint instead of the managed fork |
| `--browser-key <key>` | Provider API key for this launch |
| `--session-id <id>` | Attach to an existing cloud box instead of minting one |
| `--ad-block` / `--no-ad-block` | Enable or disable ad/tracker blocking (default on; `BETTERWRIGHT_AD_BLOCK`) |
| `--stealth` | Isolated-world driver; needs the optional `patchright-core` package |
| `--block-private-network` | Deny RFC 1918/intranet destinations |
| `--block-loopback` | Deny loopback destinations |
| `--allow-host <host>` | Re-allow one blocked host (repeatable) |
| `--block-host <host>` | Deny a host (repeatable) |
| `--no-launch-identity` | Disable the coherent identity layer |
| `--upstream-proxy <url>` | `http://`/`socks5://` egress proxy chained through the guard |
| `--geoip` | Resolve locale/timezone from the egress IP |
| `--locale <bcp47>` | Pin the browser locale |
| `--timezone <iana>` | Pin the browser timezone |
| `--platform <os>` | Pin the reported platform (`macos`, `windows`, `linux`) |

## Setup and diagnosis

### `betterwright init`

Guided first-time setup: checks Bun, installs the managed browser, wires up
detected agent hosts, and proves the path with a real page load. Idempotent.

| Flag | Effect |
| --- | --- |
| `--yes` | Accept every default; never prompt |
| `--skip-browser` | Do not download or verify the browser |
| `--skip-agents` | Do not touch any agent configuration |

See [getting started](getting-started.md#install-and-set-up).

### `betterwright setup` / `betterwright update`

Download or refresh the managed BetterChromium build. `setup` also refreshes
already-installed agent skill files. `--force` re-downloads even when the
pinned version is present. See [chromium-fork.md](chromium-fork.md).

### `betterwright doctor`

Readiness report grouped by area (runtime, browser, agent integration, model
backends, credentials). Every `✗` names its fix; `!` lines are optional
components that are not set up. Exits 0 when ready, 1 otherwise.

| Flag | Effect |
| --- | --- |
| `--json` | Raw report for scripts |
| `--quiet` | Print only the lines that need attention |

### `betterwright configure`

Persist the default browser in `<BETTERWRIGHT_HOME>/config.json`. With no
flags on a terminal it walks through the choices and offers a connection test.
Full semantics in [browser-providers.md](browser-providers.md#configuring-a-default).

| Flag | Effect |
| --- | --- |
| `--show` | Print the current setting (default with no terminal); `--json` for scripts |
| `--browser <name\|url\|path>` | Set the launch default: provider name, `wss://` CDP endpoint, or absolute Chromium path |
| `--browser-key <key>` | Store the provider key in the config file |
| `--key-env <NAME>` | Read the key from this environment variable instead |
| `--connect <name>` | Save a provider key without changing the launch default (alias: `connect <name>`) |
| `--disconnect <name>` | Forget a saved provider key |
| `--managed` / `--reset` | Clear the default; launches use the managed fork again |
| `--add <name>` | Add a custom provider, with `--cdp-url <template>` ( `${apiKey}` is replaced at launch ), `--key-env`/`--browser-key`, `--docs <url>`, `--display-name <label>` |
| `--remove <name>` | Delete a custom provider |
| `--test` | Connect to the configured browser and print its version |
| `--no-test` | Do not offer the connection test in the interactive flow |

## Driving the browser

### `betterwright run`

```bash
betterwright run -c "await page.goto('https://example.com'); return page.title()"
betterwright run snippet.js
betterwright run -            # snippet from stdin
```

Runs one snippet of async Playwright JavaScript in the persistent browser and
prints one JSON result envelope. Exits 0 on `ok: true`, 1 otherwise. All shared
flags apply, plus:

| Flag | Effect |
| --- | --- |
| `--close` | Close the session after this call |
| `--pretty` | Indent JSON even when stdout is piped (terminals indent by default) |
| `--no-auto-ui` | Omit the automatic UI catalog on a successful call; on-demand discovery still works |
| `--approve-downloads` | Allow downloads for this one run |

The globals inside a snippet are documented in [browser-api.md](browser-api.md).

### `betterwright repl`

Reads blank-line-separated snippets from stdin and runs each against the same
live session, printing one JSON result per snippet. Ctrl-D quits. Takes the
same session, profile, network, and browser flags as `run`, plus `--close` to
end the session when input ends.

### `betterwright exec "<task>"`

Hands a whole task to BetterWright's own agent loop and prints one JSON answer.
`--stdin` reads the task from stdin. Repeated execs on a session continue the
same conversation and browser; `--fresh` forgets the conversation, `--close`
ends the session after the task. All shared flags apply, plus the model flags:

| Flag | Effect |
| --- | --- |
| `--model <id>` | Real model id; `source/id` only to pin a collision (`BETTERWRIGHT_MODEL`) |
| `--base-url <url>` | Pin a custom OpenAI-compatible `/v1` endpoint (`--endpoint` is an alias) |
| `--api-key-env <name>` | Read the API key from a named environment variable |
| `--protocol <name>` | `chat` (default) or `responses` |
| `--effort <level>` | Reasoning effort where the model supports it (`--reasoning` is an alias) |
| `--allow-insecure-model-endpoint` | Permit a key over non-loopback plain HTTP |
| `--live-view` | Start the viewer at step 0 and print its URL |
| `--fresh` | Forget this session's exec conversation |
| `--stdin` | Read the task from stdin |

Model sources, auth, and the result fields are in [agent.md](agent.md).

### `betterwright view`

Opens a live web view of the browser and holds it until Ctrl-C. Attaches to
the running session daemon when one exists, so you see the tabs the agent is
driving; otherwise starts a private browser. Hosting presets, the password
gate, and the security model are in [live-view.md](live-view.md).

| Flag | Effect |
| --- | --- |
| `--expose <preset>` | `lan` (default), `local`, or `tailscale` |
| `--host <host>` | Bind address; overrides `--expose` |
| `--port <port>` | Bind port (default ephemeral) |
| `--public-host <host>` | Host printed in the URL when binding wildcard |
| `--session <name>` | Watch that session's current tab (default `"default"`) |
| `--profile <name>` | Watch that profile's browser |
| `--watch-only` | No takeover controls |
| `--set-password` | Store a password every viewer must enter |
| `--clear-password` | Remove that password |

### `betterwright record`

```bash
betterwright record start demo.mp4 --session demo --fps 60
betterwright record restart take-2.mp4 --session demo
betterwright record status --session demo
betterwright record stop --session demo
```

Records the current tab as MP4/H.264 (`.webm` selects VP8/WebM) without
replacing its page or session state. Requires the session daemon; `--no-daemon`
and `--close` are rejected. FFmpeg must be on `PATH` (or
`BETTERWRIGHT_FFMPEG_PATH`). See [recording.md](recording.md).

`start`/`restart` options: `--fps <n>` (1-60, default 60), `--max-width <px>`
(default 1280), `--max-height <px>` (default 720), `--quality <n>` (1-100,
default 80), `--max-duration <s>` (default 300), `--session`, `--profile`.

## Sessions, cookies, and credentials

### `betterwright sessions`

Lists the sessions held by each profile's daemon: pid, version, uptime, active
runs, per-session idle time, watchers, and in-flight calls. Never starts a
daemon. See [sessions.md](sessions.md#diagnosing).

### `betterwright close [name]`

Closes a session's tabs and forgets its live state; the on-disk profile and
its logins survive. `--session <name>` picks the session (a positional name
also works), `--profile <name>` picks the identity, `--all` closes every
session of every profile and stops each daemon.

### `betterwright cookies`

```bash
betterwright cookies browsers [--json]
betterwright cookies profiles <browser> [--json]
betterwright cookies sync <browser> (--domain <host>... | --all) [options]
```

Copies cookies from a local browser profile into the selected BetterWright
profile, or into a cloud browser with per-call consent. Semantics, source
support, and the trust boundary are in [cookie-sync.md](cookie-sync.md).

`sync` options: `--domain <host>` (repeatable), `--all`, `--source-profile <id>`,
`--include-session`, `--allow-app-bound`, `--profile <name>`,
`--browser <name|url>`, `--browser-key <key>`, `--session-id <id>`,
`--allow-cloud <target>`, `--no-daemon`, `--json`.

### `betterwright vault`

The owner-facing door to the credential vault. `list` and `show` are
metadata-only; `--reveal`, `copy`, and `type` are the only paths to plaintext
and every reveal is audited. Full rules in
[credentials.md](credentials.md#getting-a-password-back-betterwright-vault).

| Subcommand | Effect |
| --- | --- |
| `status` | Master-password protection and lock state |
| `setup` | Set a master password (hidden terminal prompt) |
| `unlock` | Unlock the selected profile's session daemon |
| `lock` | Lock the vault across all profiles and processes |
| `settings [agent-use\|offer-save\|autosave on\|off]` | Inspect or change saving preferences |
| `list [--query <text>] [--category <c>]` | Saved credentials, metadata only |
| `show <id> [--reveal]` | One credential; `--reveal` prints the password to a terminal only |
| `get <id>` | Alias for `show` |
| `copy <id>` | Copy the password to the clipboard |
| `type <id> [--delay <s>] [--key-delay <ms>]` | Type the password into the focused window (`paste` is an alias) |
| `rm <id> [--yes]` | Delete one credential |
| `audit [--limit <n>]` | Recent vault activity, metadata only |
| `path` | Where the encrypted files live |

Options: `--json`, `--force` (allow `--reveal` when stdout is not a terminal).

## Cloud browser boxes

### `betterwright boxes`

```bash
betterwright boxes list [--browser <name>] [--status <s>]
betterwright boxes start [--browser <name>]
betterwright boxes show <id> [--browser <name>]
betterwright boxes stop <id> [--browser <name>]
```

Manages billed sessions on the six REST-backed providers. `--browser-key`
passes a key for one call only; `--key-env <NAME>` reads it from the
environment; `--json` masks credentials in output. Browserless, Bright Data,
and Oxylabs are connect-only and have no session lifecycle. See
[browser-providers.md](browser-providers.md#managing-boxes).

## Agent integration

### `betterwright auth`

`auth --login codex` or `auth --login grok` runs the provider's OAuth PKCE
flow and stores the tokens for `exec`. `auth --status` shows which backends
are signed in. Anthropic models use `ANTHROPIC_API_KEY` instead; local models
need no sign-in. See [agent.md](agent.md#signing-in-betterwright-auth).

### `betterwright models [source]`

Lists the models reachable right now: native backends plus local Ollama/vLLM
servers, and OpenRouter when `OPENROUTER_API_KEY` is set. `source` limits the
list to `openrouter`, `ollama`, or `vllm`. `--base-url <url>` queries a custom
endpoint, `--api-key-env <name>` supplies its key, `--json` prints the
machine-readable catalog. See [agent.md](agent.md#how-selection-works).

### `betterwright skill`

Prints the agent instructions that teach a shell-capable agent to drive the
browser. `--install` writes the browser and e2e-review skills to
`~/.claude/skills` and `~/.agents/skills`; `--all` adds `~/.cursor/skills`.
`--claude` prints the Claude-form SKILL.md to stdout; `--status` shows where
the skills are installed and whether they are current. See
[SETUP.md](../SETUP.md#1--cli--skill-any-agent-that-can-run-shell-commands).

### `betterwright skills [list | show <name>]`

Reads the on-demand site knowledge packs. `list` prints name and description
per pack; `show <name>` prints a pack's body. See [skills.md](skills.md).

### `betterwright mcp`

Serves the MCP stdio server: `browser`, `browser_batch`, `browser_download`,
`browser_record`, `browser_handoff`, `browser_doctor`, plus `browser_login`
when the vault is enabled. `--check` verifies the server can start, which is
the way to debug a client that shows no tools. `--ad-block`/`--no-ad-block`
override `BETTERWRIGHT_AD_BLOCK`. Policy comes from the environment; the full
variable list is in [environment.md](environment.md). Registration and client
notes are in [SETUP.md](../SETUP.md#3--mcp-client).
