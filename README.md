<div align="center">

<img src="https://raw.githubusercontent.com/BetterWright/betterwright/main/docs/assets/logo.png" alt="BetterWright" width="96" />

# BetterWright

**The token-efficient browser for AI agents.**

[![npm](https://img.shields.io/npm/v/betterwright?color=cb3837&logo=npm)](https://www.npmjs.com/package/betterwright)
[![CI](https://github.com/BetterWright/betterwright/actions/workflows/ci.yml/badge.svg)](https://github.com/BetterWright/betterwright/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/betterwright?color=339933&logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/npm/l/betterwright)](LICENSE)

One persistent, policy-guarded browser your agent returns to turn after turn.
Drive it from your own agent (skill, MCP, or JS API) — or hand whole tasks to
its built-in browser agent and just read the answer.

</div>

```bash
npm install -g betterwright && betterwright setup

betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

**92.7% on Online-Mind2Web** — 300 tasks, **98.8% on easy**, 84.2% on hard
(scored by our own strict multimodal judge,
[full report](benchmarks/online-mind2web/REPORT.md)) ·
**30–75% fewer observation tokens** than a standard accessibility dump ·
read-only tasks finish in **one model turn**.

---

## Two ways to use it

|  | You want… | You get… |
| --- | --- | --- |
| **[Integrated](#1-integrated--your-agent-drives-the-browser)** | your agent (Claude Code, Codex, Pi, any MCP client, your own code) to browse as one part of a bigger job | a skill, MCP server, or JS API through which *your* agent mans the browser step by step |
| **[Standalone agent](#2-standalone--betterwright-is-the-browser-agent)** | to hand over a whole browser task and read back one answer | `betterwright exec "<task>"` — BetterWright's own browser-tuned agent loop does the driving; you (or your agent) get one JSON result |

They share everything — the same persistent sessions, vault, network policy,
and snapshots — so you can start with one and mix in the other later.

### 1. Integrated — your agent drives the browser

Any agent that can run a shell command can drive the browser.
`betterwright skill` prints the instructions that teach it how — CLI usage
plus operator guidance. No server, no SDK, no glue code.

```bash
# Claude Code — install as a skill (writes ~/.claude/skills/browser/SKILL.md)
betterwright skill --install

# Codex — append to AGENTS.md
betterwright skill >> ~/.codex/AGENTS.md

# Any custom agent — the same instructions ship as SKILL.md in this repo
# and the npm package (node_modules/betterwright/SKILL.md); copy it wherever
# your agent reads skills, or print it with `betterwright skill`.

# MCP (stdio server: browser, browser_login, browser_download, browser_handoff, browser_doctor)
npm install -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- npx betterwright mcp

# Pi Coding Agent (native persistent tools, trusted login, approval-gated downloads)
pi install npm:betterwright
```

Or drive it from your own code:

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
await bw.run("await page.goto('http://localhost:5173')", { session: "dev" });
const title = await bw.run("return page.title()", { session: "dev" });
console.log(title.result);
await bw.close();
```

`run()` takes a string of async Playwright JavaScript with sandboxed globals —
`page`, `snapshot`, `screenshot`, `human`, `credentials`, and friends — and
returns one result envelope. Full API: [docs/javascript.md](docs/javascript.md)
· [docs/browser-api.md](docs/browser-api.md).

**[SETUP.md](SETUP.md)** is the full integration guide, written to be followed
by an AI agent — point your coding agent at it and it wires any host end to end.

### 2. Standalone — BetterWright *is* the browser agent

BetterWright ships its own browser-tuned agent loop. Plug in a model, hand it
a task in plain language:

```bash
betterwright auth --login codex     # OAuth sign-in, no API key to paste
betterwright exec "find the top Hacker News story and give me its title and points" --model codex
```

The loop observes with compressed snapshots, acts, verifies, captures a proof
screenshot, and prints **one JSON object** — answer, steps, token usage,
proof path. `--model claude|codex|grok`, or any bare model id / OpenAI-compatible
endpoint. Run bare **`betterwright`** for the interactive console: one browser
session across tasks, steps streaming as they happen, and an `ask` tool so the
agent can check with you before consequential choices.
Details: [docs/agent.md](docs/agent.md).

**Use it as a sub-agent.** Because `exec` is one shell command in and one JSON
object out, a *coding* agent can delegate entire browser tasks to it:

```bash
betterwright exec "log in to staging and download this month's invoice" --model codex
```

The whole browsing transcript — every snapshot, every retry — stays inside the
sub-agent. A 30-turn checkout costs your main agent **one tool call**, not
30 pages of context. Programmatic equivalent: `runAgentTask()` from
`betterwright/agent`.

## Tokens are the bottleneck

An agent's browser loop is *observe → decide → act*, and the observe step is
where context windows go to die. Raw HTML dumps, full accessibility trees, and
screenshot-only loops burn thousands of tokens per turn — so tasks hit context
limits, costs climb, and the model drowns in markup it never needed.

BetterWright's whole observation stack is built around that problem:

| Mechanism | Token effect |
| --- | --- |
| **Compressed agent snapshots** | A distilled accessibility tree — not raw HTML — measuring **30–75% fewer tokens** than standard tree output, with `[ref=eN]` markers the model acts on directly instead of re-deriving selectors |
| **Diff mode** | After an action, return **only what changed** — not the page again |
| **Interactive-only filter** | Drop static text nodes; keep what the agent can click, fill, or read |
| **Scoped truncation** | Hints about *where* to look next instead of a silently clipped wall |
| **Single-call finish** | Read-only tasks complete in **one model turn** — the code returns `{finalAnswer}` and the loop ends, no confirmation round-trip |
| **Persistent session** | One long-lived browser: no re-login, no re-navigation, no re-paying the token cost of getting back to where you were |
| **Sub-agent delegation** | `betterwright exec` keeps the entire browsing transcript out of your main agent's context — a whole task costs it one tool call |

## Benchmarks

- **[Online-Mind2Web](benchmarks/online-mind2web/REPORT.md)** — **278/300
  (92.7%)** on the pinned 300-task snapshot: **98.8% easy**, 93.7% medium,
  84.2% hard. Scored by BetterWright's local strict multimodal judge (not an
  official leaderboard entry); config, dataset hashes, and per-task results in
  the report.
- **[Agent-scaffold head-to-head](benchmarks/exec-headtohead/REPORT.md)** —
  same model, same effort, 15 tasks × 3 rounds vs another agent scaffold:
  **14/15 correct vs 12/15**, faster median (10.2s vs 14.7s), and a login →
  cart → checkout flow in **5 model turns vs 13** — cheap observations mean
  fewer turns to the same answer.
- **[Browser-runtime head-to-head](benchmarks/browser-agent-headtohead/REPORT.md)**
  — per-operation latency at parity with the fastest available browser agent;
  the wins above come from the scaffold and the token diet, not from cutting
  corners in the runtime.

## Watch it, coach it, take the wheel

Every run can carry a self-hosted [live view](docs/live-view.md): a web page
showing the browser in real time, with chat to guide the agent between turns
and a **handoff** flow for the moments automation shouldn't finish alone —
MFA, a resistant CAPTCHA, a consequential click. The agent pauses, you take
the controls, hit **Done**, and it resumes with your note.

```bash
betterwright exec "…" --live-view          # watch the whole run
betterwright view --expose tailscale       # drive a headless VPS browser from your laptop
betterwright view --set-password           # lock every viewer behind a password
```

Hosting is one word (`lan`, `local`, `tailscale`), auth is a capability token
plus an optional config-stored password, and nothing live-view-related is
reachable from model code.

## Why not just Playwright?

Playwright is built for tests: trusted scripts, known selectors, teardown at
the end. An agent is the opposite — untrusted model output deciding its next
step from what it sees, in a browser that must still be there next turn:

|  | Playwright | BetterWright |
| --- | --- | --- |
| **Observations** | Raw accessibility tree or DIY HTML | Compressed, diffable, redacted snapshots priced for a context window |
| **Session** | Browser per script | One persistent managed browser — logins survive turns, days, restarts |
| **Trust** | Full API access | Model code runs sandboxed: no file, process, or network-routing APIs |
| **Network** | Any URL | Every request policy-checked (DNS-rebinding-proof); cloud metadata endpoints always blocked |
| **Secrets** | Passwords in the script | AES-256-GCM vault; forms are detected and filled without the secret ever entering the conversation |
| **Evidence** | Assertions | `screenshot({kind: 'proof'})` — tagged artifacts the agent cites as proof of work |
| **CAPTCHAs** | Out of scope | Local `captcha.solve()` — checkbox, Turnstile, slider; vision handoff for image grids |
| **Human in the loop** | Out of scope | Token-gated [live view](docs/live-view.md): watch, chat, answer `ask`, or take over on `handoff` |

## What's in the box

| Piece | What it gives you |
| --- | --- |
| [**Agent snapshots**](docs/browser-api.md#reading-the-page) | The token-efficiency core: compressed tree, `[ref=eN]` actions, diff and interactive-only modes, password redaction |
| [**Built-in agent loop**](docs/agent.md) | `betterwright exec` / the interactive console / `runAgentTask()` — a browser-specialized scaffold with claude/codex/grok adapters and a pluggable model interface |
| [**Credential vault**](docs/credentials.md) | AES-256-GCM outside the profile; PSL site matching, selector-free login detection, metadata-only account choice |
| [**Live view & handoff**](docs/live-view.md) | Watch and coach the agent live; token + optional password gated; `handoff` pauses for human hands and resumes on Done |
| [**Network policy**](docs/network-policy.md) | Every navigation, subresource, WebSocket, and raw TCP connection checked; metadata endpoints always blocked |
| [**CAPTCHA helpers**](docs/captcha.md) | Local solving for checkbox/Turnstile/slider; image grids hand off to the agent's own vision with tile crops |
| [**Human-shaped input**](docs/browser-api.md#human-shaped-interactions) | Curved pointer movement, paced typing, eased wheel — no extra dependency |
| [**Cloaking V2**](docs/cloaking-v2.md) | Coherent native fingerprint: build-specific viewport, locale, timezone, optional geo-matched egress. No page-world shims; live reCAPTCHA v3 returns 0.9 headed and headless |
| [**Native Chromium fork**](docs/chromium-fork.md) | Optional BetterWright-built Chromium: per-profile-stable canvas/audio farbling, platform masking, macOS-metric fonts. Auto-detected at `~/.betterwright/chromium/`; platforms without an artifact (Windows) stay on managed CloakBrowser |
| [**Skill packs**](docs/skills.md) | Per-site and per-password-manager guidance the host agent reads on demand — surfaced automatically when an open page matches |
| [**Download approval**](docs/browser-api.md) | Denied by default; a trusted host approves one download run at a time |
| [**Operator guidance**](docs/agent-prompt.md) | `betterwright skill` / `agentSystemPrompt()` — decisive action on authorized tasks, with optional confirmation/spending guardrails |

## Install

Requires **Node.js 22+**. Setup downloads the browser (~200 MB, once) — the
Chromium fork on macOS arm64 / Linux x64, CloakBrowser elsewhere — never as an
npm lifecycle side effect, so installs stay predictable with `--ignore-scripts`.

```bash
npm install -g betterwright
betterwright setup     # fork (mac/linux) + Cloak fallback
betterwright update    # refresh / switch to the Chromium fork
betterwright doctor    # confirm everything resolves
```

## How it works

The CLI (or your JS host) owns one long-lived Node worker. The worker holds
the persistent browser context and exposes sandboxed globals to model code; it
calls back to the host to authorize requests and resolve credentials without
putting secrets in results. CDP and raw browser handles stay worker-internal.
The security model — what the sandbox removes, why the metadata floor cannot
be lifted, and where it does *not* claim to be a boundary — is in
[docs/architecture.md](docs/architecture.md).

## Docs

| Start here | Capabilities | Under the hood |
| --- | --- | --- |
| [Getting started](docs/getting-started.md) | [Credential vault](docs/credentials.md) | [Architecture & security model](docs/architecture.md) |
| [Integration guide (SETUP.md)](SETUP.md) | [Live view & handoff](docs/live-view.md) | [Cloaking V2](docs/cloaking-v2.md) |
| [The built-in agent](docs/agent.md) | [CAPTCHA helpers](docs/captcha.md) | [Chromium fork](docs/chromium-fork.md) |
| [JavaScript API](docs/javascript.md) | [Network policy](docs/network-policy.md) | [Headed / headless](docs/attach-mode.md) |
| [Browser API (snippet globals)](docs/browser-api.md) | [Skill packs](docs/skills.md) | [Operator guidance](docs/agent-prompt.md) |
| [Recipes](docs/browser-recipes.md) | | |

## Scope and responsible use

BetterWright automates a browser under your direction, including signing in
and interacting with simple CAPTCHAs on sites you are authorized to use. It is
not built for bulk account creation, credential stuffing, or scraping behind
anti-bot walls at scale; its helpers exist to unblock a task you legitimately
own, not to repeatedly defeat a site that is telling automation to stop. No
browser configuration can guarantee undetectability or challenge acceptance.
See [the security model](docs/architecture.md#security-model) for the
boundaries the code does and does not enforce.

## License

MIT — see [LICENSE](LICENSE).
