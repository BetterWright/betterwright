# The built-in agent harness (`betterwright exec`)

BetterWright works in two shapes:

- **Bring your own agent** (the REPL shape): some other harness — Claude Code,
  Codex, Pi, an MCP client, or your own code — drives BetterWright through
  `run()`, the MCP `browser` tool, or the Pi package. This is the default and is
  covered everywhere else in these docs.
- **Let BetterWright drive itself** (the exec shape): BetterWright supplies a
  browser-tuned agent loop, you plug a *model* into it, and you hand it a
  natural-language task. That is this page.

The second shape exists because the browser runtime was never the slow part. In
the [head-to-head](../benchmarks/browser-agent-headtohead/REPORT.md) BetterWright's
per-operation latency matched the fastest available browser agent's; the
end-to-end gap was the *agent scaffold* — a browser-specialized loop takes
fewer, tighter steps than a general coding agent. `betterwright exec` gives
BetterWright that scaffold.

## CLI

```bash
betterwright exec "find the top Hacker News story and give me its title and points" --model claude
```

Progress notes stream to stderr as the loop runs — the last one summarizes the
run's cost (`done in 6 steps, 7 tool calls, 11.4s, 6,880 in / 1,330 out · 40,000
cache read · context 20,000`) — and the final result is one JSON object on
stdout:

```json
{
  "ok": true,
  "answer": "…",
  "steps": 6,
  "reason": "done",
  "toolCalls": 7,
  "usage": {
    "inputTokens": 6880,
    "outputTokens": 1330,
    "cacheReadTokens": 40000,
    "cacheWriteTokens": 0,
    "context": 20000
  },
  "durationMs": 11400,
  "proof": "/…/proof-….png"
}
```

`toolCalls` counts the `browser`/`login`/`ask`/`done` calls the model issued (it
can exceed `steps` when a turn batches several). `usage` sums the token counts the
model adapter reported across turns (a field is `0` when the provider returned no
usage block); `inputTokens` is fresh input only: each turn's provider input total
minus the portion served from cache.
`cacheReadTokens` and `cacheWriteTokens` come straight from the provider's usage
block — the Responses API's `input_tokens_details.cached_tokens` /
`cache_write_tokens`, the Chat Completions `prompt_tokens_details` equivalents, or
Anthropic's `cache_read_input_tokens` / `cache_creation_input_tokens`. The CLI
always shows cache reads; it shows cache writes only when the run has a positive,
provider-reported count. It never derives writes from fresh input. `context` is
the full prompt size at the **end** of the task — the last turn's provider input
total, i.e. how much context the model was holding when it finished. `durationMs`
is the task wall-clock (it excludes tearing down a browser the loop created for
itself).

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <name>` | `claude` | An adapter name (`claude`, `codex`, `grok`) **or** a bare model id whose backend is inferred from its prefix — `gpt-*`/`o*` → codex, `grok-*` → grok, `claude-*` → claude (e.g. `--model gpt-5.6-sol`) |
| `--model-id <id>` | per-adapter | Override the model id (e.g. `claude-fable-5`, `grok-4`); wins over an id passed to `--model` |
| `--effort <level>` (alias `--reasoning`) | `low` | Reasoning effort: `low`/`medium`/`high`/`xhigh`/`max` where the model supports it |
| `--max-steps <n>` | `24` | Hard cap on model turns |
| `--session <name>` | `default` | Browser session name |
| `--headed` | off | Show the managed browser |

Network flags (`--block-private-network`, `--allow-host`, …) work the same as on
`run`/`repl`.

## Interactive console (`betterwright`)

`betterwright exec` runs one task and exits. Run **`betterwright`** with no
subcommand for the interactive counterpart — a console where you type tasks and
watch the agent work:

```
$ betterwright --model codex
BetterWright — interactive agent console
model codex · reasoning low · session default · headless
Type a task and press Enter. /help for commands, /exit or Ctrl-D to quit.

▸ what is the page title of example.com
  · [1] browser: opening the page and reading its title

The page title is "Example Domain."
proof: /…/proof-….png
done · 2 steps · 2 tool calls · 2.1s · 1,889 in / 120 out · 3,072 cache read · context 4,961

▸
```

Each step the agent takes streams as it happens, then the answer, the proof
screenshot path, and the same cost summary `exec` prints. **The session carries
across tasks**: both the browser (you stay signed in, tabs stay open) *and* the
conversation — a follow-up task remembers what earlier ones did and can refer back
to them without repeating the work (it's fed the running transcript). `/new` clears
both the memory and the browser to start fresh. The same `--model`, `--model-id`,
`--effort`/`--reasoning`, `--session`, `--headed`, and network flags apply.

Because the transcript accumulates, a long session grows the context each task
sends (largely served from cache — watch `cache read` in the summary); `/new` when
you switch to unrelated work.

Meta-commands (a line starting with `/`):

| Command | Effect |
| --- | --- |
| `/help` | list the commands |
| `/model <name>` | switch model for the next task |
| `/reasoning <level>` | change reasoning effort (`/effort` also works) |
| `/headed` | show the browser window (`/headless` to hide it again) |
| `/new` | start a fresh browser session (close open tabs) |
| `/clear` | clear the screen |
| `/exit` | quit (or Ctrl-D) |

### The `ask` tool

Because a user is present, the interactive console gives the agent an **`ask`
tool**: when it genuinely needs input — a code it cannot obtain, a consequential
choice with no reasonable default, or a task ambiguous enough that guessing risks
the wrong thing — it asks you a question (offering short concrete options when the
answer is a choice) and waits for your typed reply before continuing. It still
acts on its own for ordinary reversible steps; it does not ask permission to
proceed. `betterwright exec` has no user watching, so it runs without the `ask`
tool and never stalls on a question.

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
console.log(result.toolCalls, result.usage, result.durationMs);
// 7, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, context }, 11400
```

Pass an **`askUser`** handler to let the loop ask the human mid-task — this is
how the interactive console wires the `ask` tool. Given a handler, `runAgentTask`
exposes an `ask` tool to the model; without one it runs fully autonomously.

```js
const result = await runAgentTask({
  task: "book me a table for dinner tonight",
  model: "codex",
  askUser: async ({ question, options }) => {
    // Route to your UI/host; return the user's answer as a string.
    return await promptTheUser(question, options);
  },
});
```

`runAgentTask` constructs and closes its own browser unless you pass one:

```js
import { BetterWright } from "betterwright";
import { runAgentTask } from "betterwright/agent";

const browser = new BetterWright(); // encrypted local vault + `login` tool by default
await runAgentTask({ task: "…", browser, model: "claude" });
await browser.close();
```

The loop exposes a selector-free `login` tool backed by the same URL-matched
worker fill as MCP/Pi's `browser_login`. Generated signup/rotation passwords
remain pending until a later browser step verifies success and commits them, so
failed forms do not leave stale saved items. Pass `vault: false` to disable the
tool or a custom adapter to replace the local store.

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
[`agentSystemPrompt`](agent-prompt.md), and the tools (`browser`, `done`,
`login` when a vault is present, and `ask` when an `askUser` handler is present).
It calls `browser` with async Playwright
JavaScript; BetterWright runs it and feeds back a compact JSON observation
(`ok`, `result`, `console`, `pages`, `challenges`, `skills`, `warnings`,
`screenshots`). The loop ends when the model calls `done` (or answers in prose),
or at `--max-steps`. Screenshots are captured as artifacts and their paths
surfaced; the last `proof` screenshot is returned on the result.

A `browser` call can also end the task in the *same* turn: when the model's
code returns `{ finalAnswer: "…" }` (from an `ok` run), the harness records
that as the answer and finishes without spending another model round-trip. The
preamble teaches the model to use this single-call shape for read-only tasks —
navigate, extract, compute, capture proof, and return `finalAnswer` in one
call — which makes a simple lookup cost one model turn instead of two.
