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
npm install -g betterwright && betterwright init

betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

`init` downloads the browser, wires up whichever agents it finds on your
machine, and proves it works by loading a real page. One command, no choices to
make up front.

**30–75% fewer observation tokens** than a standard accessibility dump ·
read-only tasks finish in **one model turn** · persistent sessions so you
don't re-pay login and navigation cost every step.

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
# The short version: init detects your agent hosts and wires them all.
betterwright init

# Or do it by hand, one host at a time:
betterwright skill --install       # ~/.claude/skills + ~/.agents/skills
betterwright skill --install --all # also ~/.cursor/skills
betterwright skill --status        # where it landed, and whether it is current
betterwright skill >> ~/.codex/AGENTS.md   # Codex reads an instructions file

# Any custom agent — the same instructions ship as SKILL.md in this repo
# and the npm package (node_modules/betterwright/SKILL.md); copy it wherever
# your agent reads skills, or print it with `betterwright skill`.

# MCP (stdio server: browser, browser_login, browser_download, browser_handoff, browser_doctor)
npm install -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- npx betterwright mcp
betterwright mcp --check           # why does my client show no tools?

# Pi Coding Agent (native persistent tools, trusted login, approval-gated downloads)
pi install npm:betterwright
```

After an npm upgrade, `setup` / `update` refresh already-installed skill files,
and `doctor` says so if one is still stale.

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
betterwright exec "find the top Hacker News story and give me its title and points" --model gpt-5.6-sol
```

The loop observes with compressed snapshots, acts, verifies, captures a proof
screenshot, and prints **one JSON object** — answer, steps, token usage,
proof path.

**Models are selected by real id**, not by adapter nickname. Pass the model
id you want (`gpt-5.6-sol`, `claude-opus-5`, `qwen3.5:9b`, …). BetterWright
probes running local servers (Ollama, vLLM), OpenRouter when keyed, and native
Claude / Codex / Grok routes; if exactly one source exposes that id, it uses
it. Prefix the source only to pin a collision (`ollama/qwen3.5:9b`). The words
`claude`, `codex`, and `grok` alone are **not** model shortcuts.

| You have… | Typical start |
| --- | --- |
| ChatGPT / Codex subscription | `betterwright auth --login codex` → `--model gpt-5.6-sol` |
| Anthropic API key | `ANTHROPIC_API_KEY=…` → `--model claude-opus-5` |
| xAI (OAuth or API key) | `betterwright auth --login grok` or `XAI_API_KEY` → `--model grok-4.5` |
| Local [Ollama](https://ollama.com) | pull a tool-calling model → `--model qwen3.5:9b` or `ollama/…` |
| Local vLLM | serve with tool-calling enabled → `--model <id>` or `vllm/<id>` |
| [OpenRouter](https://openrouter.ai) | `OPENROUTER_API_KEY=…` → `--model <author/model>` |
| Any OpenAI-compatible `/v1` | `--base-url https://host/v1 --model <id>` |

```bash
# Discover what is available (native defaults + reachable endpoints)
betterwright models
betterwright models ollama

# Local Ollama — no API key; default base http://127.0.0.1:11434/v1
betterwright exec "check example.com" --model ollama/qwen3.5:9b

# OpenRouter — bare author/model id when unambiguous
OPENROUTER_API_KEY=… betterwright exec "check example.com" \
  --model anthropic/claude-sonnet-5

# Custom OpenAI-compatible endpoint
BETTERWRIGHT_MODEL_API_KEY=… betterwright exec "check example.com" \
  --base-url https://models.example/v1 --model <model-id>
```

The model must support **function / tool calling** well enough to drive the
browser tools — text-only chat models are not enough. Full flags, env vars,
and troubleshooting: [docs/agent.md](docs/agent.md).

Run bare **`betterwright`** for the interactive console: one browser session
across tasks, steps streaming as they happen, `/model`, `/endpoint`, and
`/models`, plus an `ask` tool so the agent can check with you before
consequential choices.

**Use it as a sub-agent.** Because `exec` is one shell command in and one JSON
object out, a *coding* agent can delegate entire browser tasks to it:

```bash
betterwright exec "log in to staging and download this month's invoice" --model gpt-5.6-sol
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
| [**Built-in agent loop**](docs/agent.md) | `betterwright exec` / the interactive console / `runAgentTask()` — model-first selection across Claude, Codex, Grok, OpenRouter, Ollama, vLLM, and any OpenAI-compatible endpoint |
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
betterwright init      # guided: browser + agent wiring + a real page load
```

`init` is safe to re-run and reports what is already done. The steps it runs
are all available on their own:

```bash
betterwright setup     # fork (mac/linux) + Cloak fallback
betterwright update    # refresh / switch to the Chromium fork
betterwright doctor    # what is installed, what is missing, how to fix it
```

## Getting a password back out

The vault fills logins without ever handing a secret to model code — which
would leave *you* locked out of a password your agent generated during a
signup. So there is a separate, human-only door:

```bash
betterwright vault list                # metadata: site, username, when
betterwright vault copy <id>           # password → clipboard, never the screen
betterwright vault show <id> --reveal  # print it (refuses to a pipe or a file)
betterwright vault audit               # every read and write, metadata only
```

`--reveal` writes plaintext only to a terminal; redirect it and it fails closed.
These commands live on an owner-only API that the browser worker — and so
model-authored snippet code — cannot reach. See
[SECURITY.md](SECURITY.md#the-shell-is-a-trusted-channel) for what that does
and does not protect.

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
| [CAPTCHA recipes](docs/browser-recipes.md) | | Benchmarks: [Online-Mind2Web, 92.7%](benchmarks/online-mind2web/REPORT.md) · [agent head-to-head](benchmarks/exec-headtohead/REPORT.md) |

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
