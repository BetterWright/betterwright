<div align="center">

<img src="https://raw.githubusercontent.com/CuriosityOS/betterwright/main/docs/assets/logo.png" alt="BetterWright" width="96" />

# BetterWright

**The token-efficient browser for AI agents.**

[![npm](https://img.shields.io/npm/v/betterwright?color=cb3837&logo=npm)](https://www.npmjs.com/package/betterwright)
[![CI](https://github.com/CuriosityOS/betterwright/actions/workflows/ci.yml/badge.svg)](https://github.com/CuriosityOS/betterwright/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/betterwright?color=339933&logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/npm/l/betterwright)](LICENSE)

One persistent, policy-guarded browser your agent returns to turn after turn —
engineered so every observation costs the fewest tokens possible.

</div>

```bash
npm install -g betterwright && betterwright setup

betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

---

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

Measured end-to-end against another agent scaffold driving the same model at
the same effort ([benchmark](benchmarks/exec-headtohead/REPORT.md), 15 tasks,
3 rounds): **14/15 correct vs 12/15**, faster median (10.2s vs 14.7s), and a
login → cart → checkout flow in **5 model turns vs 13** — because cheap
observations mean fewer turns to reach the same answer.

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

## Quick start

Requires **Node.js 22+**. Setup downloads the managed browser (~200 MB, once)
from its official release source — never as an npm lifecycle side effect, so
installs stay predictable and work with `--ignore-scripts`.

```bash
npm install -g betterwright
betterwright setup     # fetch + verify the managed browser (once)
betterwright doctor    # confirm everything resolves
```

```bash
# one action — one JSON result, ~1s including launch
betterwright run -c "await page.goto('https://example.com'); return page.title()"

# multi-step work — blank-line-separated snippets against one live session
betterwright repl < steps.txt
```

## Give it to your agent

Any agent that can run a shell command can drive the browser.
`betterwright skill` prints the instructions that teach it how — CLI usage
plus operator guidance. No server, no SDK, no glue code.

```bash
# Claude Code
mkdir -p ~/.claude/skills/browser
betterwright skill --claude > ~/.claude/skills/browser/SKILL.md

# Codex
betterwright skill >> ~/.codex/AGENTS.md

# MCP (stdio server: browser, browser_login, browser_download, browser_doctor)
npm install -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- npx betterwright mcp

# Pi Coding Agent (native persistent tools, trusted login, approval-gated downloads)
pi install npm:betterwright
```

**[SETUP.md](SETUP.md)** is the full integration guide, written to be followed
by an AI agent — point your coding agent at it and it wires any host end to end.

### Or let it drive itself

BetterWright ships its own browser-tuned agent loop:

```bash
betterwright auth --login codex     # OAuth sign-in, no API key to paste
betterwright exec "find the top Hacker News story and give me its title and points" --model codex
```

`--model claude|codex|grok`, or a bare model id and the backend is inferred.
The loop observes with snapshots, acts, verifies, captures proof, and reports
what the run cost in tokens and tool calls — [docs/agent.md](docs/agent.md).
Run **`betterwright`** bare for the interactive console: one browser session
across tasks, steps streaming as they happen.

## The JavaScript API

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
await bw.run("await page.goto('http://localhost:5173')", { session: "dev" });
const title = await bw.run("return page.title()", { session: "dev" });
console.log(title.result);
await bw.close();
```

`run()` takes a string of async Playwright JavaScript with sandboxed globals —
`page`, `snapshot`, `screenshot`, `human`, `credentials`, and friends. Every
call returns one result envelope (`ok`, `result`, `error`, `artifacts`,
`console`, `pages`, `challenges`, `warnings`, `durationMs`).
Full API: [docs/javascript.md](docs/javascript.md) ·
[docs/browser-api.md](docs/browser-api.md).

## What each piece does

| Piece | What it gives you |
| --- | --- |
| [**Agent snapshots**](docs/browser-api.md#reading-the-page) | The token-efficiency core: compressed tree, `[ref=eN]` actions, diff and interactive-only modes, password redaction |
| [**Credential vault**](docs/credentials.md) | AES-256-GCM outside the profile; PSL site matching, selector-free login detection, metadata-only account choice |
| [**Network policy**](docs/network-policy.md) | Every navigation, subresource, WebSocket, and raw TCP connection checked; metadata endpoints always blocked |
| [**CAPTCHA helpers**](docs/captcha.md) | Local solving for checkbox/Turnstile/slider; image grids hand off to the agent's own vision with tile crops |
| [**Human-shaped input**](docs/browser-api.md#human-shaped-interactions) | Curved pointer movement, paced typing, eased wheel — no extra dependency |
| [**Cloaking V2**](docs/cloaking-v2.md) | Coherent native fingerprint: build-specific viewport, locale, timezone, optional geo-matched egress. No page-world shims; live reCAPTCHA v3 returns 0.9 headed and headless |
| [**Native Chromium fork**](docs/chromium-fork.md) | Optional BetterWright-built Chromium: per-profile-stable canvas/audio farbling, platform masking, macOS-metric fonts. Auto-detected at `~/.betterwright/chromium/`; platforms without an artifact (Windows) stay on managed CloakBrowser |
| [**Download approval**](docs/browser-api.md) | Denied by default; a trusted host approves one download run at a time |
| [**Operator guidance**](docs/agent-prompt.md) | `betterwright skill` / `agentSystemPrompt()` — decisive action on authorized tasks, with optional confirmation/spending guardrails |

## How it works

The CLI (or your JS host) owns one long-lived Node worker. The worker holds
the persistent browser context and exposes sandboxed globals to model code; it
calls back to the host to authorize requests and resolve credentials without
putting secrets in results. CDP and raw browser handles stay worker-internal.
The security model — what the sandbox removes, why the metadata floor cannot
be lifted, and where it does *not* claim to be a boundary — is in
[docs/architecture.md](docs/architecture.md).

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
