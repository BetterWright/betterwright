// BetterWright's own agent harness — the `aside exec` mode.
//
// BetterWright is normally an add-on: some other agent (Claude Code, Codex, Pi,
// an MCP client) drives it through `run()`, the MCP `browser` tool, or the Pi
// package. That is the `aside repl` shape — bring your own harness.
//
// This module adds the other shape, `aside exec`: BetterWright supplies the
// browser-tuned harness and you plug a *model* into it, then hand it a
// natural-language task. The harness owns the observe → act → verify loop (the
// part that made a browser-specialized agent faster than a general coding agent
// in the head-to-head), and the model is a small injectable interface — which
// is also how someone brings their own model or agent.
//
// A model is any object with:
//     async complete({ system, messages, tools }) -> { text, toolCalls, stopReason }
// over the neutral message shape this file defines. Three adapters ship:
// `claude` (Anthropic SDK), `codex` (the ChatGPT-backend Responses API over codex
// OAuth creds, or OpenAI-compatible with an API key), and `grok`
// (OpenAI-compatible over grok OAuth creds). Pass a model name to pick one, or
// pass your own object to drive the loop with anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { codexAccessToken, codexHome, grokAccessToken, loadCodexAuth, loadGrokAuth } from "./auth.mjs";
import { BetterWright, NetworkPolicy } from "./client.mjs";
import { agentSystemPrompt } from "./prompt.mjs";

// The ChatGPT backend Responses endpoint the codex CLI drives with a ChatGPT
// OAuth access token (overridable if the backend path moves).
const CHATGPT_RESPONSES_BASE =
  process.env.CODEX_RESPONSES_BASE || "https://chatgpt.com/backend-api/codex";

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOKENS = 4096;
const OBSERVATION_LIMIT = 12_000;

// How the harness introduces its tools. `agentSystemPrompt()` speaks in terms of
// `run()`; this preamble maps that onto the `browser` tool so the same operator
// guidance applies unchanged.
const HARNESS_PREAMBLE = `You are operating a real, persistent, policy-guarded web browser to complete the user's task end to end, autonomously.

Call the \`browser\` tool with async Playwright JavaScript to act — each call is one \`run()\` in the guidance below. A single trailing expression is returned; a statement block must \`return\`. Globals: page, pages, context, state, openPage, usePage, closePage, snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human, overlays, controls, media.

Work in as few \`browser\` calls as the task safely allows: every call is a full model round-trip, so the number of calls — not the browser — sets your speed. One \`browser\` call can run a whole sequence, so plan the next stretch of work and do it in a single call.

- Plan, then batch. When you already know what to read and where from — a value on a page, the same field across several pages, a comparison between tabs — do it in ONE call: navigate (or open several tabs with \`Promise.all([openPage(a), openPage(b)])\`), extract each value, compute, and return the finished result. Do not spend one call per page.
- Prefer direct extraction when the target is unambiguous: \`page.locator(...).innerText()\`, \`getByRole\`, \`allInnerTexts()\`, or \`page.url()\` after a redirect. Known shortcuts (a project's \`/releases/latest\` URL) beat click-through exploration. Compute in JS and return the finished answer, not raw page dumps.
- When the right element is not obvious — an article's first real sentence (leading nodes are often empty or hatnotes), the "main" result among many — read a scoped \`snapshot({interactive:true})\` or \`snapshot({selector})\` first to see the real structure, then target precisely. If an extraction returns empty, too short, or clearly wrong, do NOT retry the same blind locator — take one snapshot to see the structure, then extract. One snapshot beats three guesses.
- Use the read → act → verify loop when the page is interactive or its structure is unknown — forms, logins, search boxes, dynamic UIs, or when an action's outcome is uncertain: \`snapshot({interactive: true})\` to see what to click, act on \`[ref=eN]\` via \`page.locator('aria-ref=eN')\`, then \`snapshot({diff: true})\` to confirm. Snapshots cover the whole page including iframes and off-screen elements — never scroll just to read, never guess a ref or URL.

You are operating autonomously: the user is not watching and cannot answer mid-task. Do not ask "shall I proceed?" — for reversible steps that follow from the task, act. Work until the task is genuinely done or you are truly blocked (an MFA code you cannot obtain, a consequential choice with no reasonable default).

When finished, call the \`done\` tool with a clear answer for the user. On any task with a visible result, capture \`screenshot({kind: 'proof'})\` of the end state first — do it in the same \`browser\` call as your final action when you can, to save a turn. Call \`done\` exactly once, at the end.`;

const BROWSER_TOOL_DESCRIPTION = `Run async Playwright JavaScript in the persistent browser and get back a JSON observation ({ok, result, error, console, pages, challenges, skills, warnings, screenshots, duration_ms}). Read with snapshot({interactive:true}); act on [ref=eN] via page.locator('aria-ref=eN'); verify with snapshot({diff:true}). Never type or print a password — use the login tool if present, or a password-manager extension.`;

const DONE_TOOL_DESCRIPTION = `Finish the task. Call this exactly once when the task is complete or genuinely blocked, with the final answer or status for the user. Capture a proof screenshot first when there is a visible result.`;

const LOGIN_TOOL_DESCRIPTION = `Fill a saved or freshly generated credential without the secret ever entering the conversation. The password is fetched, typed, and (with submitSelector) submitted inside the browser worker — never returned, never shown in a snapshot. Provide CSS selectors for the fields. Set generate=true to create and save a new strong password when signing up.`;

const LOGIN_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    passwordSelector: { type: "string", description: "CSS selector for the password field (required)." },
    usernameSelector: { type: "string", description: "CSS selector for the username/email field." },
    confirmPasswordSelector: { type: "string", description: "CSS selector for a confirm-password field (signup)." },
    submitSelector: { type: "string", description: "CSS selector clicked to submit in the same trusted call." },
    id: { type: "string", description: "Select the saved record by id." },
    username: { type: "string", description: "Select the saved record by username, or set the new one on signup." },
    generate: { type: "boolean", description: "Generate, fill, and save a new strong password (signup)." },
    length: { type: "integer", description: "Generated password length (default 24)." },
    includeSymbols: { type: "boolean", description: "Include symbols in a generated password (default true)." },
    label: { type: "string", description: "Human label for a newly saved record." },
  },
  required: ["passwordSelector"],
};

const BROWSER_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    code: { type: "string", description: "The async Playwright JavaScript to execute." },
    note: { type: "string", description: "A short present-tense status line describing this step." },
  },
  required: ["code"],
};

const DONE_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The final answer or status to report to the user." },
  },
  required: ["answer"],
};

function toolsForHarness({ withLogin }) {
  const tools = [
    { name: "browser", description: BROWSER_TOOL_DESCRIPTION, parameters: BROWSER_TOOL_PARAMETERS },
    { name: "done", description: DONE_TOOL_DESCRIPTION, parameters: DONE_TOOL_PARAMETERS },
  ];
  if (withLogin)
    tools.push({ name: "login", description: LOGIN_TOOL_DESCRIPTION, parameters: LOGIN_TOOL_PARAMETERS });
  return tools;
}

// Compact a run result envelope into a text observation the model reads back.
// Screenshots are surfaced as artifact paths (with their `kind`) rather than
// inline images, so the same text loop works across every model adapter.
function observationFromResult(result) {
  const screenshots = (result.artifacts || [])
    .filter((a) => a.path && /\.(png|jpe?g)$/i.test(a.path))
    .map((a) => ({ kind: a.kind, path: a.path }));
  const summary = {
    ok: result.ok,
    result: result.result ?? null,
    error: result.error ?? null,
    console: result.console || [],
    pages: result.pages || [],
    challenges: result.challenges || [],
    skills: result.skills || [],
    warnings: result.warnings || [],
    screenshots,
    duration_ms: result.durationMs,
  };
  let text = JSON.stringify(summary);
  if (text.length > OBSERVATION_LIMIT) {
    summary.result = "[truncated — inspect via a scoped snapshot]";
    text = JSON.stringify(summary);
    if (text.length > OBSERVATION_LIMIT) text = `${text.slice(0, OBSERVATION_LIMIT)}…`;
  }
  return text;
}

function loginOptionsFromInput(input = {}, session) {
  const options = {
    session,
    passwordSelector: String(input.passwordSelector || ""),
    generate: input.generate === true,
  };
  for (const key of [
    "usernameSelector",
    "confirmPasswordSelector",
    "submitSelector",
    "id",
    "username",
    "label",
  ])
    if (input[key] != null) options[key] = String(input[key]);
  if (input.length != null) options.length = Number(input.length);
  if (typeof input.includeSymbols === "boolean") options.includeSymbols = input.includeSymbols;
  return options;
}

/**
 * Run a natural-language task through BetterWright's own agent harness.
 *
 * @param {object} options
 * @param {string} options.task the natural-language task to complete
 * @param {string|object} [options.model="claude"] a model name ("claude",
 *   "codex", "grok") or your own object with an async `complete` method
 * @param {object} [options.modelOptions] passed to the named adapter (apiKey,
 *   model id, baseURL, maxTokens, effort, fetchImpl, client)
 * @param {BetterWright} [options.browser] drive an existing browser; otherwise
 *   one is created from the options below and closed when the task ends
 * @param {import("./prompt.mjs").Guardrails} [options.guardrails] deployer limits
 * @param {number} [options.maxSteps=24] hard cap on model turns
 * @param {string} [options.session="default"] browser session name
 * @param {boolean|"auto"} [options.headless] browser headless mode (new browsers)
 * @param {NetworkPolicy} [options.policy] network policy (new browsers)
 * @param {object} [options.vault] credential vault for the `login` tool (new
 *   browsers only — ignored when an external `browser` is passed, whose own
 *   vault then decides login availability)
 * @param {(event: object) => void} [options.onStep] progress callback per step
 * @returns {Promise<{ok: boolean, answer: string, steps: number, reason: string, transcript: object[], proof: (string|null)}>}
 */
export async function runAgentTask(options = {}) {
  const task = String(options.task || "").trim();
  if (!task) throw new Error("runAgentTask requires a non-empty `task`.");

  const model = resolveModel(options.model || "claude", options.modelOptions || {});
  const maxSteps = Math.max(1, Number(options.maxSteps) || DEFAULT_MAX_STEPS);
  const session = String(options.session || "default");
  const onStep = typeof options.onStep === "function" ? options.onStep : () => {};

  const ownsBrowser = !options.browser;
  const browser =
    options.browser ||
    new BetterWright({
      policy: options.policy || new NetworkPolicy(),
      headless: options.headless,
      ...(options.vault ? { vault: options.vault } : {}),
    });
  const withLogin = Boolean(browser.vault);

  const system = `${HARNESS_PREAMBLE}\n\n${agentSystemPrompt(options.guardrails || {})}`;
  const tools = toolsForHarness({ withLogin });
  const messages = [{ role: "user", text: task }];

  let answer = "";
  let proof = null;
  let finished = false;
  let reason = "max-steps";
  let steps = 0;

  try {
    for (steps = 1; steps <= maxSteps; steps += 1) {
      const response = await model.complete({ system, messages, tools });
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      messages.push({ role: "assistant", text: response.text || "", toolCalls });

      // No tool call: the model answered in prose. Treat that text as the
      // result and stop rather than looping until the step cap.
      if (!toolCalls.length) {
        answer = String(response.text || "").trim();
        reason = answer ? "answered" : "stopped";
        finished = true;
        break;
      }

      const results = [];
      for (const call of toolCalls) {
        if (call.name === "done") {
          answer = String(call.input?.answer ?? "").trim();
          reason = "done";
          finished = true;
          results.push({ id: call.id, name: call.name, content: "Task marked complete." });
          continue;
        }
        if (finished) {
          // Ignore any tool calls the model batched after `done`.
          results.push({ id: call.id, name: call.name, content: "Ignored — task already finished." });
          continue;
        }
        if (call.name === "login") {
          onStep({ step: steps, tool: "login", note: "filling credential" });
          try {
            const result = await browser.fillCredential(loginOptionsFromInput(call.input, session));
            results.push({ id: call.id, name: call.name, content: observationFromResult(result) });
          } catch (error) {
            results.push({ id: call.id, name: call.name, content: `login error: ${error?.message || error}` });
          }
          continue;
        }
        if (call.name === "browser") {
          const note = String(call.input?.note || "");
          onStep({ step: steps, tool: "browser", note });
          const result = await browser.run(String(call.input?.code || ""), { session, note: note || undefined });
          for (const shot of result.artifacts || [])
            if (shot.kind === "proof" && shot.path) proof = shot.path;
          results.push({ id: call.id, name: call.name, content: observationFromResult(result) });
          continue;
        }
        results.push({ id: call.id, name: call.name, content: `Unknown tool: ${call.name}` });
      }
      messages.push({ role: "tool", results });
      if (finished) break;
    }
  } finally {
    if (ownsBrowser) await browser.close();
  }

  return {
    ok: finished && reason !== "stopped",
    answer,
    // On exhaustion the for-loop increments past the cap; report the real count.
    steps: Math.min(steps, maxSteps),
    reason,
    transcript: messages,
    proof,
  };
}

/**
 * Resolve a model name (or pass-through object) to a model adapter.
 * @param {string|object} model "claude" | "codex" | "grok" (aliases: "anthropic"
 *   → claude, "openai" → codex, "xai" → grok), or an object with an async
 *   `complete` method to use directly.
 * @param {object} [modelOptions]
 * @returns {{name: string, complete: Function}}
 */
export function resolveModel(model, modelOptions = {}) {
  if (model && typeof model === "object" && typeof model.complete === "function") return model;
  const name = String(model || "").toLowerCase();
  if (name === "claude" || name === "anthropic") return claudeModel(modelOptions);
  if (name === "codex" || name === "openai") return codexModel(modelOptions);
  if (name === "grok" || name === "xai") return grokModel(modelOptions);
  throw new Error(
    `Unknown model "${model}". Use "claude", "codex", "grok", or pass a model object with a complete() method.`,
  );
}

// --- Claude (Anthropic SDK) ------------------------------------------------

function anthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.text }] };
    if (m.role === "tool")
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
        })),
      };
    const content = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const tc of m.toolCalls || [])
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input || {} });
    return { role: "assistant", content };
  });
}

function parseAnthropicResponse(message) {
  let text = "";
  const toolCalls = [];
  for (const block of message.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use")
      toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  }
  return { text, toolCalls, stopReason: message.stop_reason };
}

/**
 * Claude adapter over the official Anthropic SDK (an optional peer dependency —
 * `npm install @anthropic-ai/sdk`). Auth resolves from ANTHROPIC_API_KEY, or an
 * explicit `apiKey`, the SDK's usual way.
 * @param {object} [options]
 * @param {string} [options.model="claude-opus-4-8"] override with any current id
 *   (e.g. "claude-fable-5", "claude-sonnet-5")
 * @param {string} [options.apiKey]
 * @param {number} [options.maxTokens=4096]
 * @param {"low"|"medium"|"high"|"xhigh"|"max"} [options.effort="low"]
 * @param {object} [options.client] inject a preconstructed SDK client (tests)
 */
export function claudeModel(options = {}) {
  const modelId = options.model || process.env.BETTERWRIGHT_CLAUDE_MODEL || "claude-opus-4-8";
  const maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
  const effort = options.effort || "low";
  let clientPromise = options.client ? Promise.resolve(options.client) : null;

  async function client() {
    if (!clientPromise)
      clientPromise = (async () => {
        let Anthropic;
        try {
          ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
        } catch {
          throw new Error(
            "The Claude model needs the Anthropic SDK. Install it with `npm install @anthropic-ai/sdk`.",
          );
        }
        return new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
      })();
    return clientPromise;
  }

  return {
    name: "claude",
    modelId,
    async complete({ system, messages, tools }) {
      const anthropic = await client();
      const message = await anthropic.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system,
        output_config: { effort },
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: anthropicMessages(messages),
      });
      return parseAnthropicResponse(message);
    },
  };
}

// --- OpenAI-compatible (codex, grok) --------------------------------------

function openaiMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "tool") {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.content });
    } else {
      const turn = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length)
        turn.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      out.push(turn);
    }
  }
  return out;
}

function parseOpenaiResponse(data) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls = [];
  let synthetic = 0;
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function?.arguments };
    }
    // Some OpenAI-compatible servers omit ids; synthesize a stable one so the
    // assistant turn and its tool result line up on the next request.
    synthetic += 1;
    toolCalls.push({ id: tc.id || `call_${synthetic}`, name: tc.function?.name, input });
  }
  return { text: msg.content || "", toolCalls, stopReason: choice.finish_reason };
}

/**
 * A generic OpenAI-compatible chat-completions adapter over `fetch` — no SDK
 * dependency. Both the codex and grok adapters build on it; you can also use it
 * directly against any OpenAI-compatible endpoint.
 * @param {object} options
 * @param {string} options.baseURL e.g. "https://api.openai.com/v1"
 * @param {string} options.model model id the endpoint serves
 * @param {string} [options.apiKey] bearer token
 * @param {object} [options.headers] extra request headers
 * @param {number} [options.maxTokens=4096]
 * @param {string} [options.effort] passed as reasoning_effort when set
 * @param {string} [options.name="openai"] adapter name
 * @param {typeof fetch} [options.fetchImpl] inject a fetch (tests)
 */
export function openaiModel(options = {}) {
  const baseURL = String(options.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelId = options.model;
  const maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!modelId) throw new Error(`The ${options.name || "openai"} model needs a model id.`);
  if (typeof fetchImpl !== "function")
    throw new Error("No fetch implementation available (need Node 22+ or a fetchImpl).");

  return {
    name: options.name || "openai",
    modelId,
    async complete({ system, messages, tools }) {
      // A dynamic auth provider (OAuth) refreshes the token per request; a
      // static apiKey is the simple case.
      const auth = typeof options.getAuth === "function" ? await options.getAuth() : {};
      const apiKey = auth.apiKey ?? options.apiKey;
      const body = {
        model: modelId,
        max_completion_tokens: maxTokens,
        messages: openaiMessages(system, messages),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
        parallel_tool_calls: true,
      };
      if (options.effort) body.reasoning_effort = options.effort;
      const response = await fetchImpl(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(options.headers || {}),
          ...(auth.headers || {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${options.name || "openai"} request failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      return parseOpenaiResponse(await response.json());
    },
  };
}

function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.text });
      continue;
    }
    if (message.role === "assistant") {
      if (message.text) input.push({ role: "assistant", content: message.text });
      for (const call of message.toolCalls || []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input || {}),
        });
      }
      continue;
    }
    if (message.role === "tool") {
      for (const result of message.results) {
        input.push({ type: "function_call_output", call_id: result.id, output: result.content });
      }
    }
  }
  return input;
}

function parseResponsesOutput(output = []) {
  const text = [];
  const toolCalls = [];
  let synthetic = 0;
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) text.push(part.text);
      }
    } else if (item.type === "function_call") {
      let input = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        input = { _raw: item.arguments };
      }
      synthetic += 1;
      toolCalls.push({ id: item.call_id || item.id || `call_${synthetic}`, name: item.name, input });
    }
  }
  return { text: text.join(""), toolCalls };
}

function parseResponsesStream(raw) {
  let text = "";
  let completed;
  const toolCalls = [];
  const seenCalls = new Set();
  let synthetic = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta") text += event.delta || "";
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const item = event.item;
      let input = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        input = { _raw: item.arguments };
      }
      synthetic += 1;
      const id = item.call_id || item.id || `call_${synthetic}`;
      if (!seenCalls.has(id)) {
        seenCalls.add(id);
        toolCalls.push({ id, name: item.name, input });
      }
    }
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.failed" || event.type === "error") {
      const detail = event.response?.error?.message || event.error?.message || event.message || JSON.stringify(event);
      throw new Error(`Responses request failed: ${detail}`);
    }
  }
  const fallback = parseResponsesOutput(completed?.output);
  return {
    text: text || fallback.text,
    toolCalls: toolCalls.length ? toolCalls : fallback.toolCalls,
    stopReason: completed?.status || (toolCalls.length ? "tool_calls" : "completed"),
  };
}

function responsesModel(options = {}) {
  const baseURL = String(options.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelId = options.model;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!modelId) throw new Error(`The ${options.name || "responses"} model needs a model id.`);
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation available (need Node 22+ or a fetchImpl).");

  return {
    name: options.name || "responses",
    modelId,
    async complete({ system, messages, tools }) {
      // A dynamic auth provider (OAuth) refreshes the token per request; a
      // static apiKey is the simple case.
      const auth = typeof options.getAuth === "function" ? await options.getAuth() : {};
      const apiKey = auth.apiKey ?? options.apiKey;
      const body = {
        model: modelId,
        instructions: system,
        input: responsesInput(messages),
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
        ...(options.bodyExtra || {}),
      };
      const response = await fetchImpl(`${baseURL}${options.responsesPath || "/responses"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(options.headers || {}),
          ...(auth.headers || {}),
        },
        body: JSON.stringify(body),
      });
      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`${options.name || "responses"} request failed (${response.status}): ${raw.slice(0, 500)}`);
      }
      if (/^(?:event|data):/m.test(raw)) return parseResponsesStream(raw);
      const data = JSON.parse(raw);
      const parsed = parseResponsesOutput(data.output);
      return { ...parsed, stopReason: data.status || "completed" };
    },
  };
}

// Read codex's stored OAuth credentials (~/.codex/auth.json) and configured
// model (~/.codex/config.toml). Best-effort — every field is overridable.
function readCodexConfig() {
  const dir = codexHome();
  const out = {};
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    if (auth.OPENAI_API_KEY) out.apiKey = auth.OPENAI_API_KEY;
  } catch {
    // no stored codex auth
  }
  try {
    const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    const match = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (match) out.model = match[1];
  } catch {
    // no codex config
  }
  return out;
}

// Per-request auth for the ChatGPT backend: a fresh access token (refreshed if
// expired) plus the account header codex requires.
function codexOAuthAuth(sessionId) {
  return async () => {
    const { accessToken, accountId } = await codexAccessToken();
    // Headers match the codex CLI's ChatGPT-backend client (bearer_auth_provider
    // + default_client): originator identifies the caller; session_id ties a
    // task's turns together for prompt caching. OpenAI-Beta is not required on
    // the plain SSE path.
    const headers = {
      authorization: `Bearer ${accessToken}`,
      originator: "codex_cli_rs",
      session_id: sessionId,
    };
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
    return { headers };
  };
}

/**
 * Codex adapter. Three ways to reach the model, in priority order:
 *   1. An explicit API key (OPENAI_API_KEY / options.apiKey) → OpenAI-compatible.
 *   2. A ChatGPT OAuth session from `betterwright auth --login codex` → the
 *      ChatGPT backend Responses API directly, refreshing the token per request.
 *   3. A configured router base URL (CODEX_BASE_URL) → Responses over that.
 * @param {object} [options] baseURL, model, apiKey, protocol, effort, fetchImpl
 */
export function codexModel(options = {}) {
  const stored = readCodexConfig();
  const configuredBase = options.baseURL || process.env.CODEX_BASE_URL || process.env.OPENAI_BASE_URL;
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || stored.apiKey;
  const model = options.model || process.env.BETTERWRIGHT_CODEX_MODEL || stored.model || "gpt-5.6-sol";
  const effort = options.effort || "low";
  if (apiKey) {
    const baseURL = configuredBase || "https://api.openai.com/v1";
    if (options.protocol === "responses")
      return responsesModel({ ...options, name: "codex", baseURL, apiKey, model, effort });
    return openaiModel({ ...options, name: "codex", baseURL, apiKey, model, effort });
  }
  // ChatGPT OAuth session (from `betterwright auth --login codex`): call the
  // backend directly, no router binary required.
  if (!configuredBase && loadCodexAuth()) {
    const sessionId = crypto.randomUUID();
    return responsesModel({
      ...options,
      name: "codex",
      baseURL: CHATGPT_RESPONSES_BASE,
      responsesPath: "/responses",
      model,
      effort,
      getAuth: codexOAuthAuth(sessionId),
      bodyExtra: { include: [], prompt_cache_key: sessionId, ...(options.bodyExtra || {}) },
    });
  }
  // Bring-your-own Responses-compatible base URL (CODEX_BASE_URL): the endpoint
  // supplies its own auth (or none, for a local proxy).
  if (configuredBase) {
    return responsesModel({ ...options, name: "codex", baseURL: configuredBase, model, effort });
  }
  throw new Error(
    "No codex credentials found. Run `betterwright auth --login codex`, or set OPENAI_API_KEY / CODEX_BASE_URL.",
  );
}

/**
 * Grok adapter. Three ways to reach the model, in priority order:
 *   1. An explicit xAI API key (GROK_API_KEY / XAI_API_KEY) → OpenAI-compatible.
 *   2. An xAI OAuth session from `betterwright auth --login grok` → xAI's
 *      OpenAI-compatible endpoint, refreshing the token per request.
 *   3. A configured router base URL (GROK_BASE_URL) → Responses over that.
 * @param {object} [options] baseURL, model, apiKey, protocol, effort, fetchImpl
 */
export function grokModel(options = {}) {
  const configuredBase = options.baseURL || process.env.GROK_BASE_URL || process.env.XAI_BASE_URL;
  const apiKey = options.apiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  const model = options.model || process.env.BETTERWRIGHT_GROK_MODEL || process.env.XAI_MODEL || "grok-4.3";
  const effort = options.effort || "low";
  if (apiKey) {
    const baseURL = configuredBase || "https://api.x.ai/v1";
    if (options.protocol === "responses")
      return responsesModel({ ...options, name: "grok", baseURL, apiKey, model, effort });
    return openaiModel({ ...options, name: "grok", baseURL, apiKey, model, effort });
  }
  // xAI OAuth session (from `betterwright auth --login grok`): call xAI's
  // OpenAI-compatible endpoint directly with a per-request fresh access token.
  if (!configuredBase && loadGrokAuth()) {
    return openaiModel({
      ...options,
      name: "grok",
      baseURL: "https://api.x.ai/v1",
      model,
      effort,
      getAuth: async () => {
        const { accessToken } = await grokAccessToken();
        return { headers: { authorization: `Bearer ${accessToken}` } };
      },
    });
  }
  // Bring-your-own Responses-compatible base URL (GROK_BASE_URL): the endpoint
  // supplies its own auth (or none, for a local proxy).
  if (configuredBase) {
    return responsesModel({ ...options, name: "grok", baseURL: configuredBase, model, effort });
  }
  throw new Error(
    "No grok credentials found. Run `betterwright auth --login grok`, set GROK_API_KEY (or XAI_API_KEY), or configure GROK_BASE_URL.",
  );
}
