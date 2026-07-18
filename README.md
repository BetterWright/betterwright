# BetterWright

**A persistent, policy-guarded Playwright browser for AI agents.**

![BetterWright logo — a browser path ending at a verified checkpoint](https://raw.githubusercontent.com/CuriosityOS/betterwright/main/docs/assets/hero.png)

Playwright gives you a browser automation API. BetterWright is the layer you
need on top of it when the thing driving the browser is a language model rather
than a test script: a long-lived session the agent can return to, a network
policy enforced on every request, an encrypted credential store for trusted
host code, screenshot artifacts the agent cites as proof of work, and native
CAPTCHA helpers. Managed sessions use CloakBrowser by default to reduce common
automation false positives while keeping BetterWright's policy and tool
boundaries in place.

It is CLI-first: any agent that can run a shell command can drive the browser,
and `betterwright skill` prints the instructions that teach it how.

```bash
betterwright run -c "await page.goto('https://example.com'); return page.title()"
# {"ok": true, "result": "Example Domain", ...}
```

---

## Why not just use Playwright directly?

Playwright is built for tests: a script that knows exactly what it will click,
running to completion and tearing the browser down. An agent is the opposite —
it decides what to do next from what it sees, one step at a time, and the same
browser has to still be there on the next step. That difference is where the
work is, and it is what BetterWright handles for you:

| Concern | Playwright | BetterWright |
| --- | --- | --- |
| **Session lifetime** | You open and close a browser per script. | One persistent managed browser with a real profile; the agent runs snippets against it across many turns. |
| **Untrusted control** | The script is trusted; it gets the full API. | Model code runs in a sandbox with the file, process, and network-routing APIs removed. |
| **Network scope** | Any URL the code names. | Every request is checked against a policy — even against DNS rebinding. Cloud metadata endpoints are always blocked; hosts you name can be allowed or denied. |
| **Secrets** | Passwords live in your script or env. | An encrypted, origin-scoped vault is available to trusted host code; secret-bearing fill operations are not exposed to model snippets. |
| **Evidence** | You assert; nobody looks. | `screenshot({kind: 'proof'})` produces a tagged artifact the agent returns as proof a task finished. |
| **CAPTCHAs** | Out of scope. | Local `captcha.solve()` (no third-party APIs): auto checkbox / Turnstile / managed / slider stages, vision handoff for image grids, plus manual helpers. |

If you are writing a test, use Playwright. If you are handing a browser to an
agent and need it to stay safe and accountable, that is what this is for.

---

## Install

BetterWright needs **Node.js 22+** on `PATH`. Setup downloads CloakBrowser's
signed binary directly from its official release source. BetterWright does not
redistribute that binary.

```bash
npm install -g betterwright
betterwright setup     # downloads the managed Cloak browser (~200 MB, once)
betterwright doctor    # confirms everything resolves
```

BetterWright never downloads a browser as a hidden npm lifecycle side effect,
so installs remain predictable and work with `--ignore-scripts`. The browser
binary is fetched and signature-verified by the official CloakBrowser wrapper,
then cached outside this package.

Update with `npm update -g betterwright`. Run `betterwright setup` again after
an update only when `doctor` reports that the managed runtime is missing.

---

## Give it to your agent

The primary integration is **CLI + skill**: the agent runs the `betterwright`
CLI through the shell tool it already has, and a skill teaches it how.
`betterwright skill` prints that skill — CLI usage followed by BetterWright's
operator guidance (act decisively on authorized tasks, verify with proof
screenshots, work through challenges, never touch secrets). No server, no SDK,
no glue code.

**Claude Code**

```bash
mkdir -p ~/.claude/skills/browser
betterwright skill --claude > ~/.claude/skills/browser/SKILL.md
```

(`--claude` adds SKILL.md frontmatter. Use `.claude/skills/browser/SKILL.md`
inside a repo for a project-scoped skill.)

**Codex**

```bash
betterwright skill >> ~/.codex/AGENTS.md      # global, or >> AGENTS.md per-repo
```

**Hermes or any custom agent** — append `betterwright skill` output to the
agent's system prompt; its shell/exec tool does the rest.

The agent then drives the browser like this:

```bash
# one action — prints one JSON result
betterwright run -c "await page.goto('https://example.com'); return page.title()"

# multi-step work — blank-line-separated snippets against one live session
betterwright repl < steps.txt
```

Logins, cookies, and the profile persist across every invocation; open tabs and
in-memory `state` persist within a `repl` session. A one-shot `run` — launch,
navigate, result, clean shutdown — completes in about a second.

**[SETUP.md](SETUP.md)** is the full integration guide, written to be followed
by an AI agent: point your coding agent at it and it can wire any host end to
end.

### Or let BetterWright drive itself (`betterwright exec`)

Everything above is the *bring your own agent* shape — an external harness drives
BetterWright. BetterWright also ships its own browser-tuned agent loop, so you
can hand it a task and a model and let it run:

```bash
betterwright auth --login codex        # opens "Sign in to Codex with ChatGPT"
betterwright exec "find the top Hacker News story and give me its title and points" --model codex
```

Pick the model with `--model claude|codex|grok`, or pass a bare model id and let
BetterWright infer the backend from its prefix (`gpt-*`/`o*` → codex, `grok-*` →
grok, `claude-*` → claude), e.g. `--model gpt-5.6-sol`. `codex` and `grok` sign in
through BetterWright's own OAuth flow (`betterwright auth --login codex|grok`) and
call the ChatGPT / xAI backends directly — no API key to paste, no router; `claude`
uses the Anthropic SDK (`npm install @anthropic-ai/sdk`, `ANTHROPIC_API_KEY`). The
model is a small pluggable interface, so you can also plug in your own model or
agent. The loop observes with `snapshot`, acts, verifies, captures a proof
screenshot, and finishes — see [docs/agent.md](docs/agent.md).

### Pi Coding Agent (native package)

BetterWright is a native Pi package. Its manifest loads a persistent `browser`
tool, a trusted `browser_login` tool that fills saved or generated credentials
without the secret ever entering the conversation, an approval-gated
`browser_download` tool, vision screenshots, and the operator prompt — no skill
file or MCP hop needed:

```bash
pi install npm:betterwright
npx -y betterwright setup
pi
```

See the [Pi integration guide](SETUP.md#2--pi-coding-agent) and the reproducible
[Online-Mind2Web benchmark](https://github.com/CuriosityOS/betterwright/tree/main/benchmarks/online-mind2web).

### MCP (if you prefer it)

For MCP clients, BetterWright also ships a stdio server with `browser`,
`browser_login` (trusted credential fill, secret never returned),
`browser_download`, and `browser_doctor` tools:

```bash
npm install -g betterwright @modelcontextprotocol/sdk
claude mcp add betterwright -- npx betterwright mcp
```

---

## The JavaScript API

For a JS/TS agent you can edit, embed the client in-process. `run()` takes a
string of asynchronous Playwright JavaScript; a single trailing expression is
returned automatically. Inside that string the agent has a small set of
globals — `page`, `openPage`, `snapshot`, `screenshot`, `human`, `credentials`,
and a few others — documented in [docs/browser-api.md](docs/browser-api.md).

```js
import { BetterWright } from "betterwright";

const bw = new BetterWright();
await bw.run("await page.goto('http://localhost:5173')", { session: "dev" });
const title = await bw.run("return page.title()", { session: "dev" });
console.log(title.result);
await bw.close();
```

The client returns the worker's result envelope (`ok`, `result`, `error`,
`artifacts`, `console`, `events`, `pages`, `challenges`, `warnings`,
`durationMs`). See [docs/javascript.md](docs/javascript.md) for the full API.

Headed and headless runs both use the same persistent managed Cloak profile and
network boundary. For broad discovery, use the host's web-search tool and open
its results in BetterWright instead of automating Google or Bing's public search
UI; set `publicSearchPolicy: "block"` to have the managed worker enforce that
(it is permitted by default). Visible bot challenges are surfaced as resumable
state. See [headed browsing](docs/attach-mode.md).

---

## What each piece does

- **[Network policy](docs/network-policy.md)** — every navigation, subresource,
  WebSocket, and raw TCP connection is checked. Cloud-metadata endpoints and
  secret-bearing URLs are always blocked; the public internet, private networks,
  and loopback are open by default so local dev servers just work. Harden with
  `allowPrivateNetwork: false`, `allowLoopback: false`, `blockHosts`, or a
  `custom` hook.
- **[Credential vault](docs/credentials.md)** — AES-256-GCM, origin-scoped,
  stored outside Chromium's profile. Trusted host code fills logins and signups
  (including confirm-password) with `fillCredential` / `generateAndFillCredential`;
  the secret is typed outside the sandbox and never returned. Model snippets
  cannot request a secret-bearing fill. A password-manager extension can be
  installed once in the persistent headed Cloak profile when needed.
- **[Proof artifacts](docs/browser-api.md#screenshots-and-artifacts)** —
  screenshots tagged `proof`, `question`, or `debug`, returned as artifact
  paths a host UI can render.
- **Download approval** — ordinary browser runs deny downloads. A trusted host
  approves one download run at a time; deployments can configure `ask`, `allow`,
  or `deny` without weakening the byte and artifact quotas.
- **[Native CAPTCHA helpers](docs/captcha.md)** — local `captcha.solve()` with
  no third-party solving service: auto checkbox, Turnstile, managed-challenge,
  and slider stages; image grids and text challenges hand off to the agent's
  existing vision with tile bounds and crops.
- **[Human-shaped actions](docs/browser-api.md#human-shaped-interactions)** —
  curved pointer movement, paced typing, and eased wheel events without another
  runtime dependency.
- **[Managed CloakBrowser backend](docs/getting-started.md#managed-cloakbrowser-backend)** —
  the only backend in both headed and headless modes, reducing common
  browser-fingerprint false positives without silently falling back to Chrome.
- **[Agent guidance](docs/agent-prompt.md)** — drop-in operator instructions
  (`agentSystemPrompt()`, or the CLI's `betterwright skill`) that make the
  model act decisively on authorized tasks — logging in, signing up, buying —
  instead of hedging, with guardrail options to re-impose confirmation,
  spending caps, or hard prohibitions.

## How it works

The CLI (or your JS host code) owns one long-lived Node worker. The worker holds
a persistent browser context and exposes a sandboxed set of globals to the
model's code; it calls back to the client to authorize each request and to
handle credentials. CDP and the underlying browser/context handles remain
worker internals and are not exposed to model-authored snippets. The security
model — what the sandbox removes, why the metadata floor cannot be lifted, and
where it does *not* claim to be a boundary — is written up in
[docs/architecture.md](docs/architecture.md).

## Scope and responsible use

BetterWright automates a browser under your direction, including signing in and
interacting with simple CAPTCHAs on sites you are authorized to use. It is not
built for bulk account creation, credential stuffing, or scraping behind
anti-bot walls at scale, and its native helpers exist to unblock a task you
legitimately own, not to repeatedly defeat a site that is telling automation to
stop. Managed CloakBrowser and human-shaped actions reduce false positives; no
browser configuration can guarantee undetectability or challenge acceptance. See
[docs/architecture.md#security-model](docs/architecture.md#security-model) for
the boundaries the code does and does not enforce.

## License

MIT — see [LICENSE](LICENSE).
