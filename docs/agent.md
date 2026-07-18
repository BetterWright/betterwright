# The built-in agent harness (`betterwright exec`)

BetterWright works in two shapes, mirroring Aside's `repl` and `exec`:

- **Bring your own agent** (like `aside repl`): some other harness — Claude Code,
  Codex, Pi, an MCP client, or your own code — drives BetterWright through
  `run()`, the MCP `browser` tool, or the Pi package. This is the default and is
  covered everywhere else in these docs.
- **Let BetterWright drive itself** (like `aside exec`): BetterWright supplies a
  browser-tuned agent loop, you plug a *model* into it, and you hand it a
  natural-language task. That is this page.

The second shape exists because the browser runtime was never the slow part. In
the [head-to-head](../benchmarks/asidewright-headtohead/REPORT.md) BetterWright's
per-operation latency matched AsideWright's; the end-to-end gap was the *agent
scaffold* — a browser-specialized loop takes fewer, tighter steps than a general
coding agent. `betterwright exec` gives BetterWright that scaffold.

## CLI

```bash
betterwright exec "find the top Hacker News story and give me its title and points" --model claude
```

Progress notes stream to stderr as the loop runs; the final result is one JSON
object on stdout:

```json
{ "ok": true, "answer": "…", "steps": 6, "reason": "done", "proof": "/…/proof-….png" }
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <name>` | `claude` | An adapter name (`claude`, `codex`, `grok`) **or** a bare model id whose backend is inferred from its prefix — `gpt-*`/`o*` → codex, `grok-*` → grok, `claude-*` → claude (e.g. `--model gpt-5.6-sol`) |
| `--model-id <id>` | per-adapter | Override the model id (e.g. `claude-fable-5`, `grok-4`); wins over an id passed to `--model` |
| `--effort <level>` | `low` | `low`/`medium`/`high`/`xhigh`/`max` where the model supports it |
| `--max-steps <n>` | `24` | Hard cap on model turns |
| `--session <name>` | `default` | Browser session name |
| `--headed` | off | Show the managed browser |

Network flags (`--block-private-network`, `--allow-host`, …) work the same as on
`run`/`repl`.

## Choosing a model

The three built-in adapters resolve their own credentials:

- **`claude`** — the official Anthropic SDK, an *optional* peer dependency.
  Install it once (`npm install @anthropic-ai/sdk`) and set `ANTHROPIC_API_KEY`.
  Defaults to `claude-opus-4-8`; override with `--model-id claude-fable-5` (or
  `BETTERWRIGHT_CLAUDE_MODEL`).
- **`codex`** — signs in with ChatGPT (Codex plans) and calls the ChatGPT
  backend directly. Run `betterwright auth --login codex` once; BetterWright then
  holds its own OAuth tokens and refreshes them. Defaults to `gpt-5.6-sol`;
  override with `--model-id` or `BETTERWRIGHT_CODEX_MODEL`. An `OPENAI_API_KEY`
  (OpenAI-compatible) or a `CODEX_BASE_URL` router are also accepted.
- **`grok`** — signs in with xAI (SuperGrok / X Premium+). Run
  `betterwright auth --login grok` once; BetterWright calls xAI's
  OpenAI-compatible endpoint with the OAuth token (refreshed automatically).
  Defaults to `grok-4.3`; override with `--model-id` or `BETTERWRIGHT_GROK_MODEL`.
  A `GROK_API_KEY` / `XAI_API_KEY`, or a `GROK_BASE_URL` / `XAI_BASE_URL` base-URL
  override, is also accepted. (xAI gates OAuth API access by subscription tier; if
  you get a 403, use an API key instead.)

### Signing in (`betterwright auth`)

```bash
betterwright auth --login codex     # opens "Sign in to Codex with ChatGPT"
betterwright auth --login grok       # opens the xAI sign-in
betterwright auth --status           # who am I signed in as?
```

`auth --login` runs the provider's OAuth 2.0 PKCE flow itself: it starts a
loopback callback server, opens the consent page in your default browser, and
stores the returned tokens (codex tokens land in `~/.codex/auth.json`, shared
with the codex CLI; grok tokens in `~/.grok/auth.json`). No API key is pasted and
no router is needed — BetterWright refreshes the access token per request.

## Programmatic use

`runAgentTask` is the same loop the CLI uses:

```js
import { runAgentTask } from "betterwright/agent";

const result = await runAgentTask({
  task: "log in to example.com and download this month's invoice",
  model: "claude",                 // or "codex" | "grok" | your own model object
  guardrails: { confirmBeforePurchase: true },
  onStep: ({ step, tool, note }) => console.error(`[${step}] ${tool}: ${note}`),
});
console.log(result.answer, result.proof);
```

`runAgentTask` constructs and closes its own browser unless you pass one:

```js
import { BetterWright } from "betterwright";
import { runAgentTask } from "betterwright/agent";

const browser = new BetterWright({ vault: myVault });   // vault enables the `login` tool
await runAgentTask({ task: "…", browser, model: "claude" });
await browser.close();
```

When the browser has a vault, the loop also exposes a `login` tool — the same
origin-scoped trusted fill as the MCP/Pi `browser_login` tool, so a password is
filled and submitted inside the worker and never enters the transcript.

## Bring your own model or agent

The model is a small pluggable interface — this is how you plug in anything the
three built-in adapters don't cover:

```js
const myModel = {
  name: "my-model",
  async complete({ system, messages, tools }) {
    // messages is a neutral transcript (see types/agent.d.ts); tools is
    // [{ name, description, parameters }]. Return the model's reply:
    return { text: "…", toolCalls: [{ id, name, input }], stopReason };
  },
};

await runAgentTask({ task: "…", model: myModel });
```

The harness handles the browser tools, the observe/act/verify discipline, proof
capture, and the operator guidance; your adapter only has to translate the
neutral transcript to and from your provider's wire format. `openaiModel({ baseURL,
model, apiKey })` is a ready-made adapter for any OpenAI-compatible endpoint.

## What the loop does

Each turn: the model sees the task, the operator guidance from
[`agentSystemPrompt`](agent-prompt.md), and the tools (`browser`, `done`, and
`login` when a vault is present). It calls `browser` with async Playwright
JavaScript; BetterWright runs it and feeds back a compact JSON observation
(`ok`, `result`, `console`, `pages`, `challenges`, `skills`, `warnings`,
`screenshots`). The loop ends when the model calls `done` (or answers in prose),
or at `--max-steps`. Screenshots are captured as artifacts and their paths
surfaced; the last `proof` screenshot is returned on the result.
