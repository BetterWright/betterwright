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
**Node.js 22+** on your `PATH`. The browser itself is downloaded once by
`setup` / `update`.

```bash
npm install betterwright
npx betterwright setup     # Chromium fork on mac/linux; Cloak everywhere
npx betterwright update    # download/refresh the fork (switches off Cloak default)
npx betterwright doctor    # prints what resolved; should end with "BetterWright is ready."
```

If `doctor` reports Node missing, install it from <https://nodejs.org> and rerun
`setup`. If `doctor` reports the browser missing, rerun
`npx betterwright setup` (or `update` for the fork only).

Upgrade the npm package with `npm update betterwright` or
`npm install betterwright@latest`, then run `betterwright update` so the
pinned Chromium fork matches that package. Package updates are intentional
rather than automatic, so application lockfiles continue to control when a
new BetterWright version is adopted.

### Managed CloakBrowser backend

On platforms without a public fork artifact (Windows today), or when you pass
`--cloak-only`, launches use CloakBrowser. `betterwright setup` asks the
pinned official wrapper to fetch the correct binary directly from CloakHQ's
release source and verify the published checksums with its pinned Ed25519
signature before extraction. BetterWright ships the wrapper integration, not
the separately licensed browser binary, and does not redistribute that binary.

To use a CloakBrowser binary already installed through an official channel,
point `CLOAKBROWSER_BINARY_PATH` at it before starting BetterWright:

```bash
export CLOAKBROWSER_BINARY_PATH="$HOME/.cloakbrowser/chromium-.../chrome"
```

The managed backend keeps one stable fingerprint seed and persistent profile.
That removes several stock automation signals and can reduce false positives;
it cannot guarantee that a site will accept the session or never issue a
challenge.

BetterWright pins the CloakBrowser npm wrapper, while the separately cached
browser binary follows CloakBrowser's signed stable channel. `betterwright
doctor` reports both versions. For a reproducible deployment, set a full
`CLOAKBROWSER_VERSION`; to keep an already installed build from checking for a
newer stable build, set `CLOAKBROWSER_AUTO_UPDATE=false`.

### Native Chromium fork (default on macOS arm64 / Linux x64)

`betterwright setup` and `betterwright update` download BetterWright's own
Chromium build into `~/.betterwright/chromium/` (SHA-256 verified from the
pinned GitHub Release). Discovery then prefers the fork over CloakBrowser —
per-profile-stable canvas/audio farbling, platform masking (a Linux server
presents as a consumer Mac), and bundled macOS-metric fonts. The npm package
is only the JS/runtime; the ~200 MB zip is fetched on demand, never as an
install lifecycle side effect. Details: [chromium-fork.md](chromium-fork.md).

```bash
npx betterwright update          # install/refresh fork only
npx betterwright update --force  # re-download even if present
npx betterwright setup --cloak-only  # CloakBrowser only (skip fork)
```

Resolution order:

1. `BETTERWRIGHT_CHROMIUM_PATH` (explicit binary) or
   `BETTERWRIGHT_CHROMIUM_ROOT` (artifact root). A configured-but-missing
   binary is an error — it fails closed, never silently downgrades.
2. Zero-config discovery at `~/.betterwright/chromium/<platform>/`: if the
   artifact for this platform exists there, it is used automatically
   (this is what `update` / default `setup` populate).
3. Otherwise the managed CloakBrowser backend. Platforms with no shipped
   artifact (Windows) always land here.

Force the managed path even with an artifact installed:

```bash
export BETTERWRIGHT_CHROMIUM_ROOT=off
```

**Timezone / locale must match egress.** The fork does not hard-code any
country. Pin `timezone` and `locale` to the geography of the IP sites see
(constructor options, `--timezone` / `--locale`, or `geoip: true` with
`upstreamProxy`). A Singapore residential exit with host `UTC` still trips
geo-sensitive gates (e.g. Google `/sorry`); the same binary with
`Asia/Singapore` + `en-US` does not.

**Do not share one profile across backends.** Cloak (~146) and the fork
(150) both write `$BETTERWRIGHT_HOME/browser/profile`. Once the fork has
opened that directory, falling back to Cloak fails closed
(`assertProfileNotNewer`). Use a separate `BETTERWRIGHT_HOME` for fork
hosts, or delete `browser/profile` when switching backends (saved site
logins in that profile are lost).

A typical split: **Linux and macOS hosts get the fork artifact, Windows hosts
run `betterwright setup` and stay on CloakBrowser** — one config, no branching
in your deployment code.

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

- [The browser API](browser-api.md) — every global available inside a snippet.
- [The built-in agent](agent.md) — `betterwright exec`, the interactive
  console, and using BetterWright as a browser sub-agent.
- [Live view & handoff](live-view.md) — watch the agent work, chat guidance,
  and take the controls for MFA or consequential clicks.
- [Agent guidance](agent-prompt.md) — make a model drive the browser decisively,
  with configurable guardrails.
- [Headed and headless browsing](attach-mode.md) — run the same managed Cloak
  profile with or without a visible window.
- [Network policy](network-policy.md) — controlling what the browser can reach.
- [Credentials](credentials.md) — built-in encrypted storage, site matching,
  detected forms, and pending generated-password commits.
- [Native CAPTCHA helpers](captcha.md) — resumable handling for authorized flows.
- [Architecture](architecture.md) — how it works and what it does/doesn't secure.
- [Examples](../examples) — runnable JavaScript scripts.
