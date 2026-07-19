<div align="center">

<img src="https://raw.githubusercontent.com/CuriosityOS/betterwright/main/docs/assets/logo.png" alt="BetterWright" width="96" />

# BetterWright

**A persistent, policy-guarded Playwright browser for AI agents.**

[![npm](https://img.shields.io/npm/v/betterwright?color=cb3837&logo=npm)](https://www.npmjs.com/package/betterwright)
[![CI](https://github.com/CuriosityOS/betterwright/actions/workflows/ci.yml/badge.svg)](https://github.com/CuriosityOS/betterwright/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/betterwright?color=339933&logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/npm/l/betterwright)](LICENSE)

One long-lived browser your agent returns to, turn after turn — with a network
policy on every request, an origin-scoped credential vault the model can never
read, proof screenshots, human-shaped input, and native CAPTCHA helpers.

</div>

```bash
npm install -g betterwright && betterwright setup

betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

![BetterWright — a browser path ending at a verified checkpoint](https://raw.githubusercontent.com/CuriosityOS/betterwright/main/docs/assets/hero.png)

---

## Why not just use Playwright directly?

Playwright is built for tests: a trusted script that knows exactly what it will
click, running to completion and tearing the browser down. An agent is the
opposite — it decides its next step from what it sees, its code is untrusted
model output, and the same browser has to still be there on the next turn.
That difference is where the work is:

|  | Playwright | BetterWright |
| --- | --- | --- |
| **Session** | Browser per script, torn down at the end | One persistent managed browser with a real profile — logins survive across turns, invocations, and days |
| **Trust** | The script gets the full API | Model code runs in a sandbox with file, process, and network-routing APIs removed |
| **Network** | Any URL the code names | Every request checked against policy (DNS-rebinding-proof); cloud metadata endpoints always blocked |
| **Secrets** | Passwords in your script or env | AES-256-GCM origin-scoped vault; secrets are typed outside the sandbox and never returned to the model |
| **Evidence** | You assert; nobody looks | `screenshot({kind: 'proof'})` — tagged artifacts the agent cites as proof of work |
| **Snapshots** | Raw accessibility tree | Compressed agent-ready tree, 30–75% fewer tokens, `[ref=eN]` markers the agent acts on directly |
| **CAPTCHAs** | Out of scope | Local `captcha.solve()` — checkbox, Turnstile, slider; vision handoff for image grids. No third-party services |

Writing a test? Use Playwright. Handing a browser to an agent that must stay
safe and accountable? That's what this is for.

---

## Quick start

Requires **Node.js 22+**. Setup downloads CloakBrowser's signed binary (~200 MB,
once) from its official release source — never as a hidden npm lifecycle side
effect, so installs stay predictable and work with `--ignore-scripts`.

```bash
npm install -g betterwright
betterwright setup     # fetch + verify the managed browser (once)
betterwright doctor    # confirm everything resolves
```

Then drive it:

```bash
# one action — one JSON result, ~1s including launch and clean shutdown
betterwright run -c "await page.goto('https://example.com'); return page.title()"

# multi-step work — blank-line-separated snippets against one live session
betterwright repl < steps.txt
```

Logins, cookies, and the profile persist across every invocation; open tabs and
in-memory `state` persist within a `repl` session.

---

## Give it to your agent

Any agent that can run a shell command can drive the browser.
`betterwright skill` prints the instructions that teach it how — CLI usage plus
operator guidance (act decisively, verify with proof screenshots, never touch
secrets). No server, no SDK, no glue code.

<details open>
<summary><b>Claude Code</b></summary>

```bash
mkdir -p ~/.claude/skills/browser
betterwright skill --claude > ~/.claude/skills/browser/SKILL.md
```

Use `.claude/skills/browser/SKILL.md` inside a repo for a project-scoped skill.

</details>

<details>
<summary><b>Codex</b></summary>

```bash
betterwright skill >> ~/.codex/AGENTS.md      # global, or >> AGENTS.md per-repo
```

</details>

<details>
<summary><b>Pi Coding Agent (native package)</b></summary>

BetterWright's manifest loads a persistent `browser` tool, trusted
`browser_login` (fills saved or generated credentials without the secret ever
entering the conversation), approval-gated `browser_download`, vision
screenshots, and the operator prompt — no skill file or MCP hop:

```bash
pi install npm:betterwright
npx -y betterwright setup
pi
```

See the [Pi guide](SETUP.md#2--pi-coding-agent) and the reproducible
[Online-Mind2Web benchmark](benchmarks/online-mind2web).

</details>

<details>
<summary><b>MCP</b></summary>

A stdio server with `browser`, `browser_login`, `browser_download`, and
`browser_doctor` tools:

```bash
npm install -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- npx betterwright mcp
```

</details>

<details>
<summary><b>Any custom agent</b></summary>

Append `betterwright skill` output to the agent's system prompt; its shell tool
does the rest. **[SETUP.md](SETUP.md)** is the full integration guide, written
to be followed by an AI agent — point your coding agent at it and it can wire
any host end to end.

</details>

### Or let it drive itself

BetterWright ships its own browser-tuned agent loop — hand it a task and a
model:

```bash
betterwright auth --login codex     # OAuth sign-in, no API key to paste
betterwright exec "find the top Hacker News story and give me its title and points" --model codex
```

`--model claude|codex|grok`, or a bare model id (`--model gpt-5.6-sol`) and the
backend is inferred from the prefix. The loop observes with `snapshot`, acts,
verifies, captures a proof screenshot, and reports what the run cost in tokens
and tool calls — see [docs/agent.md](docs/agent.md).

Run **`betterwright`** with no arguments for the interactive console: type
tasks, watch each step stream, keep one browser session across tasks, and
answer the agent's `ask` when it genuinely needs you (an MFA code, a
consequential choice):

```console
$ betterwright --model codex
▸ find the top Hacker News story and give me its title and points
```

---

## The JavaScript API

For a JS/TS host, embed the client in-process. `run()` takes a string of async
Playwright JavaScript; inside it the agent has a small set of globals — `page`,
`snapshot`, `screenshot`, `human`, `credentials`, and friends
([docs/browser-api.md](docs/browser-api.md)):

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
await bw.run("await page.goto('http://localhost:5173')", { session: "dev" });
const title = await bw.run("return page.title()", { session: "dev" });
console.log(title.result);
await bw.close();
```

Every call returns the worker's result envelope (`ok`, `result`, `error`,
`artifacts`, `console`, `pages`, `challenges`, `warnings`, `durationMs`).
Full API: [docs/javascript.md](docs/javascript.md).

---

## What each piece does

| Piece | What it gives you |
| --- | --- |
| [**Network policy**](docs/network-policy.md) | Every navigation, subresource, WebSocket, and raw TCP connection checked. Metadata endpoints and secret-bearing URLs always blocked; private networks and loopback open by default so dev servers just work. Harden with `blockHosts`, `allowPrivateNetwork: false`, or a `custom` hook. |
| [**Credential vault**](docs/credentials.md) | AES-256-GCM, origin-scoped, stored outside the browser profile. `credentials.fill()` / `generateAndFill()` type the secret outside the sandbox — it is never returned, and the redaction net scrubs it from every output channel. |
| [**Agent snapshots**](docs/browser-api.md#reading-the-page) | A compressed accessibility tree with actionable `[ref=eN]` markers, interactive-only and diff modes, password values redacted, and scoping hints instead of silent truncation. |
| [**Proof artifacts**](docs/browser-api.md#screenshots-and-artifacts) | Screenshots tagged `proof`, `question`, or `debug`, returned as paths a host UI can render. |
| [**CAPTCHA helpers**](docs/captcha.md) | Local `captcha.solve()`: checkbox, Turnstile, managed-challenge, and slider stages; image grids hand off to the agent's own vision with tile bounds and crops. No third-party solving services. |
| [**Human-shaped input**](docs/browser-api.md#human-shaped-interactions) | Curved pointer movement, paced typing, eased wheel events — no extra runtime dependency. |
| [**Managed CloakBrowser**](docs/getting-started.md#managed-cloakbrowser-backend) | The only backend, headed and headless — reduces common fingerprint false positives without silently falling back to Chrome. |
| [**Download approval**](docs/browser-api.md) | Denied by default; a trusted host approves one download run at a time, with byte and artifact quotas intact. |
| [**Operator guidance**](docs/agent-prompt.md) | `agentSystemPrompt()` / `betterwright skill` — makes the model act decisively on authorized tasks instead of hedging, with guardrail options for confirmation, spending caps, or hard prohibitions. |

## How it works

The CLI (or your JS host) owns one long-lived Node worker. The worker holds a
persistent browser context and exposes sandboxed globals to the model's code;
it calls back to the host to authorize each request and handle credentials.
CDP and raw browser handles stay worker-internal. The security model — what
the sandbox removes, why the metadata floor cannot be lifted, and where it
does *not* claim to be a boundary — is written up in
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
