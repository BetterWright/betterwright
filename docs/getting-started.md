# Getting started

## Pick your shape first

BetterWright is used in two ways, and everything else in these docs assumes
you know which one you're in:

- **Integrated — your agent drives.** You hand your existing agent (Claude
  Code, Codex, Pi, an MCP client, or your own JS host) the controls: the
  [skill](../SETUP.md) teaches it the CLI, `betterwright mcp` exposes tools
  over MCP, and the [JS API](javascript.md) embeds it in code. Your agent
  decides each browser step itself.
- **Standalone — BetterWright drives.** You (or your agent) hand over a whole
  task in plain language — `betterwright exec "<task>" --model <id>` or the
  interactive `betterwright` console — and BetterWright's own browser-tuned
  agent loop does the driving, returning one JSON answer. Pass a real model
  id (Claude, Codex/GPT, Grok, Ollama, vLLM, OpenRouter, or any
  OpenAI-compatible endpoint); see [agent.md](agent.md#choosing-a-model). A
  coding agent can treat this as a browser *sub-agent*: one shell command in,
  one answer out, with the entire browsing transcript kept out of its context.

Both shapes share the same persistent sessions, credential vault, network
policy, and token-efficient snapshots, so nothing below is shape-specific:
install once and use either — or both.

## Install and set up

BetterWright drives a managed browser through Playwright, so it needs
**Bun 1.4** on your `PATH`. The browser itself is downloaded once.

```bash
bun install -g betterwright
betterwright init
```

`init` is the whole of setup: it checks Bun, downloads the browser, installs
the agent skill into whichever hosts it finds on this machine, and then loads a
real page to confirm the path works end to end. It is safe to re-run — it
reports what is already done and changes only what is not. Add `--yes` to skip
the prompts (CI, scripts), or `--skip-agents` to leave your agent configuration
alone.

The individual steps remain available when you want them:

```bash
betterwright setup     # install native BetterChromium
betterwright update    # download/refresh BetterChromium
betterwright doctor    # grouped readiness report; every ✗ names its fix
```

`doctor` groups its output by what the check is about — runtime, browser, agent
integration, model backends, credentials. A `✗` is a real problem and carries
the command that fixes it; a `!` is something optional you have not set up.
`doctor --json` prints the raw report for scripts, and `--quiet` prints only
the lines that need attention.

Upgrade with `bun install -g betterwright@latest`, then run `betterwright update`
so the pinned BetterChromium release matches that package. Package updates are
intentional rather than automatic, so application lockfiles continue to control
when a new BetterWright version is adopted.

### BetterChromium, and bringing your own browser

On supported macOS arm64, Linux x64, and Windows x64 hosts, native
BetterChromium is the only bundled backend for every session, including
screenshots, credentials, CAPTCHA handling, and live view. `betterwright
setup` installs it under `~/.betterwright/chromium/`; `betterwright update`
refreshes the pinned release. There is no silent fallback when it is missing
or fails to launch.

When BetterWright does not publish a BetterChromium artifact for the current
OS/architecture (for example Linux arm64), or you want a different browser
entirely, the **provider option** swaps in a browser you supply: a local
Chromium binary (`provider: { executablePath }`, still on the guard proxy),
any CDP endpoint (`provider: { cdpUrl }` / `BETTERWRIGHT_CDP_URL`), or a
cloud browser from Browser Use, Kernel, Browserbase, Steel, Anchor,
Hyperbrowser, Browserless, Bright Data, or Oxylabs. `betterwright configure`
walks you through the choice and persists a default; `--connect` saves a key
for `betterwright boxes` (start/list/stop on the six REST-backed providers)
without changing that default. Custom CDP services can be added by name.
See [browser-providers.md](browser-providers.md).

### BetterChromium backend (macOS arm64 / Linux x64 / Windows x64)

`betterwright setup` downloads BetterWright's own
Chromium build into `~/.betterwright/chromium/` (SHA-256 verified from the
pinned GitHub Release). The runtime uses the fork for all browser work —
per-profile-stable canvas/audio farbling and a coherent fingerprint identity
that presents the host's real platform (a Linux server is a Linux browser;
no OS is masked as another). The npm package is only the JS/runtime; the
~200 MB zip is fetched on demand, never as an install lifecycle side effect.
Details: [chromium-fork.md](chromium-fork.md).

```bash
betterwright setup           # install native BetterChromium
betterwright setup --force   # re-download BetterChromium
```

Resolution order:

1. `BETTERWRIGHT_CHROMIUM_PATH` (explicit binary) or
   `BETTERWRIGHT_CHROMIUM_ROOT` (artifact root). A configured-but-missing
   binary is an error — it fails closed, never silently downgrades.
2. Zero-config discovery at `~/.betterwright/chromium/<platform>/`: if the
   artifact for this platform exists there, it is used automatically
   (this is what default `setup` populates).
3. Otherwise launch fails with setup guidance — or names the provider option
   when no artifact exists for this platform.

Backend policy can also be stated directly:

```bash
export BETTERWRIGHT_BACKEND=auto            # default policy
export BETTERWRIGHT_BACKEND=chromium-fork   # require BetterChromium
```

`chromium-fork` fails closed when the native artifact cannot be resolved.
`betterwright doctor --json` reports `browser_selection_reason` so a routing
decision is never silent.

### Extra Chromium switches

BetterWright builds its own launch arguments, but a host can append switches the
managed list has no opinion on. For example, a host can cap Chromium's on-disk
HTTP cache without changing browser identity or network routing:

```bash
export BETTERWRIGHT_CHROMIUM_ARGS="--disk-cache-size=104857600"
```

Whitespace-separated; quote a value that contains spaces
(`--host-rules="MAP * 127.0.0.1"`). The same list is settable in code as
`chromiumArgs: ["--disk-cache-size=104857600"]`, and both sources apply
together.

On Linux without an accessible `/dev/dri` render device, the fork's
SwiftShader fallback keeps WebGL available on the CPU; `doctor` reports the
fallback as a warning. `--disable-software-rasterizer` is ignored with a
result warning because it would recreate the blocked graphics surface fixed
in 1.8.1; it does not fail launch. `--host-resolver-rules` is ignored for the
same reason: Chromium draws a persistent unsupported-flag infobar whenever
that switch is present, and hostname policy is already enforced by the SOCKS
guard. `--disable-gpu` remains available as a caller-controlled compatibility
switch.

Two rules keep this from undermining the managed browser:

- **Reserved switches are rejected** with a `TypeError` naming the supported
  alternative — proxy selection (`--proxy-server`, `--no-proxy-server`, …),
  remote debugging, `--user-data-dir` / `--profile-directory`, and the identity
  family (`--fingerprint*`, `--lang`, `--bw-timezone`, `--headless`). These are
  the switches that decide where traffic goes, who can drive the browser, which
  profile is opened, and what identity is presented.
- **Duplicates are dropped, not appended.** Chromium resolves a repeated switch
  last-wins, so appending one that BetterWright already sets would override its
  value rather than lose to it. A dropped switch is reported in the next
  result's `warnings` so it never fails silently.

**Timezone / locale must match egress.** The fork does not hard-code any
country. Pin `timezone` and `locale` to the geography of the IP sites see
(constructor options, `--timezone` / `--locale`, or `geoip: true` with
`upstreamProxy`). A Singapore residential exit with host `UTC` still trips
geo-sensitive gates (e.g. Google `/sorry`); the same binary with
`Asia/Singapore` + `en-US` does not.

**Profiles are versioned by the browser that wrote them.** A Chromium profile
cannot be opened by an older Chromium than the one that last touched it;
BetterWright detects that boundary, preserves the newer profile, and gives
the older browser a stable nested compatibility profile. This matters when
you point `provider: { executablePath }` at an older Chromium than the fork.
A separate `BETTERWRIGHT_HOME` remains useful when operators want visibly
separate homes.

### Idle CPU and page parking

A headless Chromium page is never "hidden". `document.visibilityState` stays
`"visible"` for the life of the target, so none of the machinery a headed
browser uses to stop paying for background tabs ever engages: the frame loop
free-runs at the host refresh rate, and any page with a spinner, a carousel, or
a canvas keeps a core busy for as long as the session lives. Nothing in the
launch arguments changes this.

So BetterWright parks a session's pages once its last execution unwinds —
disabling page script and setting animation timelines to rate zero — and
restores them before the next execution starts. The parked window is the model's
thinking time, which is where all of the waste was. An idle five-tab session
drops from ~97% CPU to ~25%.

This is on by default and needs no configuration. It never applies in headed
mode or while a live view is streaming, it waits 750 ms so an agent's
back-to-back calls never pay for it, and it leaves pages with credential capture
in flight running. The one visible difference is that a page animated by a
`requestAnimationFrame` chain does not resume that chain after being parked;
timers, CSS animations, in-page state, and everything else do. To opt out:

```bash
export BETTERWRIGHT_PARK_BACKGROUND_PAGES=0
```

or `new BetterWright({ parkBackgroundPages: false })`.

### Slow hosts

The client gives a freshly spawned worker 15 s to print its ready handshake
before it gives up and kills it. A cold disk or a small ARM board can need
longer on the first run:

```bash
export BETTERWRIGHT_WORKER_START_TIMEOUT_MS=60000
```

The error you would see otherwise names this variable.

## Your first run

A snippet is a string of async Playwright JavaScript. The last expression is
returned automatically.

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
const result = await bw.run("await page.goto('https://example.com'); return page.title()");
console.log(result.ok, result.result);   // true "Example Domain"
await bw.close();
```

## Your first batch

Most tasks need more than one action. [AgentBatch](agent-batch.md) is the
default way to run them: read the page's spec, then send every step in one
call. The worker runs the steps back to back and returns per-step results
plus a fresh snapshot to plan from.

```js
const spec = await bw.batch({ url: "https://example.com" });
console.log(spec.result.snapshot);   // page page-1 https://example.com/ "Example Domain"
                                     // - link "More information..." [ref=e3]
const done = await bw.batch(
  [
    { action: "click", target: { ref: "e3" } },
    { action: "read", target: { role: "heading" }, expect: "Example Domains" },
  ],
  { allowWrites: true },
);
console.log(done.result.ok, done.result.steps[1].text);
```

The same two calls are the MCP `browser_batch` tool, the built-in agent's
`batch` tool, and `betterwright batch` on the command line.

## Sessions

A session is an independent set of pages and `state`. Use one per concurrent
task; snippets in the same session share the same tabs across calls.

```js
const bw = new BetterWright();
await bw.run("await page.goto('https://shop.example/cart')", { session: "checkout" });
// …a later turn, same tabs still open…
await bw.run("await page.click('text=Place order')", { session: "checkout" });
```

## Proof of work

Have the agent capture a `proof` screenshot before it claims a task is done, and
return the artifact reference so a UI can show it.

```js
const r = await bw.run("return screenshot({kind: 'proof', name: 'order-confirmed'})");
console.log(r.artifacts[0].media);   // MEDIA:/…/order-confirmed-….png
```

## Local development targets

The default policy reaches `localhost` and the private network, so a dev server
just works. Harden it when the agent runs somewhere its private network is
sensitive:

```js
import { BetterWright, NetworkPolicy } from "betterwright";

// Public internet only — no private network, no loopback.
const bw = new BetterWright({
  policy: new NetworkPolicy({ allowPrivateNetwork: false, allowLoopback: false }),
});
await bw.run("await page.goto('https://example.com')");
```

## Where to go next

- [AgentBatch](agent-batch.md) — the default two-call protocol: every step,
  target, option, and result field.
- [The browser API](browser-api.md) — every global available inside a snippet.
- [The built-in agent](agent.md) — `betterwright exec`, the interactive
  console, and using BetterWright as a browser sub-agent.
- [Live view & handoff](live-view.md) — watch the agent work, chat guidance,
  and take the controls for MFA or consequential clicks.
- [Agent guidance](agent-prompt.md) — make a model drive the browser decisively,
  with configurable guardrails.
- [Headed and headless browsing](attach-mode.md) — run the same managed fork
  profile with or without a visible window.
- [Network policy](network-policy.md) — controlling what the browser can reach.
- [Credentials](credentials.md) — built-in encrypted storage, site matching,
  detected forms, and pending generated-password commits.
- [Native CAPTCHA helpers](captcha.md) — resumable handling for authorized flows.
- [Architecture](architecture.md) — how it works and what it does/doesn't secure.
- [Examples](../examples) — runnable TypeScript scripts.
