import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeModel,
  codexModel,
  endpointModel,
  grokModel,
  listEndpointModels,
  MODEL_ENDPOINT_PRESETS,
  modelSelectionChoices,
  openaiModel,
  resolveModel,
  resolveModelSelection,
  runAgentTask,
} from "../../src/agent.mjs";
import { formatAgentUsage, uncachedInputTokens } from "../../src/agent-usage.mjs";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function futureJwt(extra = {}) {
  const payload = { exp: Math.floor(Date.now() / 1000) + 3600, ...extra };
  return `${base64url(Buffer.from("{}"))}.${base64url(Buffer.from(JSON.stringify(payload)))}.`;
}

// A fake browser standing in for BetterWright — records run() calls and returns
// canned result envelopes. `vault` toggles the login tool.
function fakeBrowser({ vault = null, runs = [], fills = [] } = {}) {
  const calls = { run: [], fill: [], closed: false };
  let i = 0;
  let fillIndex = 0;
  return {
    vault,
    calls,
    async run(code, options) {
      calls.run.push({ code, options });
      return runs[i++] || { ok: true, result: "done", artifacts: [], durationMs: 5 };
    },
    async fillCredential(options) {
      calls.fill.push(options);
      return (
        fills[fillIndex++] || {
          ok: true,
          result: "filled",
          artifacts: [],
          durationMs: 5,
        }
      );
    },
    async close() {
      calls.closed = true;
    },
  };
}

// A scripted model: returns the next canned response each complete() call.
function scriptedModel(responses) {
  const seen = [];
  let i = 0;
  return {
    name: "scripted",
    seen,
    async complete(request) {
      seen.push(request);
      return responses[i++] || { text: "", toolCalls: [] };
    },
  };
}

test("runAgentTask drives browser then finishes on done", async () => {
  const browser = fakeBrowser({
    runs: [{ ok: true, result: "HN", artifacts: [{ kind: "proof", path: "/tmp/p.png" }], durationMs: 9 }],
  });
  const model = scriptedModel([
    { text: "checking", toolCalls: [{ id: "c1", name: "browser", input: { code: "return page.title()", note: "read" } }] },
    { text: "", toolCalls: [{ id: "c2", name: "done", input: { answer: "The answer" } }] },
  ]);

  const result = await runAgentTask({ task: "get the title", model, browser });

  assert.equal(result.ok, true);
  assert.equal(result.answer, "The answer");
  assert.equal(result.reason, "done");
  assert.equal(result.proof, "/tmp/p.png");
  // Browser was driven with the model's code, scoped to the default session.
  assert.equal(browser.calls.run.length, 1);
  assert.equal(browser.calls.run[0].code, "return page.title()");
  assert.equal(browser.calls.run[0].options.session, "default");
  // An owned browser would close; a passed-in one is left to the caller.
  assert.equal(browser.calls.closed, false);
  // The browser observation was fed back into the transcript.
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /"result":"HN"/);
});

test("runAgentTask finishes in one turn when the code returns { finalAnswer }", async () => {
  const browser = fakeBrowser({
    runs: [
      {
        ok: true,
        result: { finalAnswer: "The Eiffel Tower is taller, by 237 m.", eiffel: 330, liberty: 93 },
        artifacts: [{ kind: "proof", path: "/tmp/compare.png" }],
        durationMs: 900,
      },
    ],
  });
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [{ id: "c1", name: "browser", input: { code: "…extract, compute, return {finalAnswer}…" } }],
    },
  ]);

  const result = await runAgentTask({ task: "which is taller?", model, browser });

  // One model turn total — no separate `done` round-trip.
  assert.equal(model.seen.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "done");
  assert.equal(result.answer, "The Eiffel Tower is taller, by 237 m.");
  assert.equal(result.steps, 1);
  assert.equal(result.proof, "/tmp/compare.png");
  // The single-call finish is taught to the model.
  assert.match(model.seen[0].system, /finalAnswer/);
});

test("runAgentTask ignores finalAnswer on an errored browser call", async () => {
  const browser = fakeBrowser({
    runs: [
      { ok: false, error: "boom", result: { finalAnswer: "should not count" }, artifacts: [] },
      { ok: true, result: "recovered", artifacts: [] },
    ],
  });
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "c1", name: "browser", input: { code: "fail" } }] },
    { text: "", toolCalls: [{ id: "c2", name: "browser", input: { code: "retry" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "real answer" } }] },
  ]);

  const result = await runAgentTask({ task: "x", model, browser });

  assert.equal(result.answer, "real answer");
  assert.equal(model.seen.length, 3, "the errored finalAnswer did not end the task");
});

test("runAgentTask ignores browser calls batched after a finalAnswer call", async () => {
  const browser = fakeBrowser({
    runs: [{ ok: true, result: { finalAnswer: "42" }, artifacts: [] }],
  });
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "browser", input: { code: "finish" } },
        { id: "c2", name: "browser", input: { code: "extra" } },
      ],
    },
  ]);

  const result = await runAgentTask({ task: "x", model, browser });

  assert.equal(result.answer, "42");
  assert.equal(browser.calls.run.length, 1, "the batched call after the finish never executed");
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[1].content, /already finished/);
});

test("runAgentTask reports uncached input, cache usage, and full final context", async () => {
  const browser = fakeBrowser({
    runs: [
      { ok: true, result: "a", artifacts: [], durationMs: 1 },
      { ok: true, result: "b", artifacts: [], durationMs: 1 },
    ],
  });
  const model = scriptedModel([
    // One turn batching two browser calls, with a usage block.
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "browser", input: { code: "1" } },
        { id: "c2", name: "browser", input: { code: "2" } },
      ],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 40 },
    },
    // A final turn: done + a usage block. Providers that omit usage contribute 0.
    {
      text: "",
      toolCalls: [{ id: "d1", name: "done", input: { answer: "ok" } }],
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 },
    },
  ]);

  const result = await runAgentTask({ task: "count", model, browser });

  // 2 browser + 1 done = 3 tool calls across 2 steps.
  assert.equal(result.toolCalls, 3);
  // User-facing input excludes cache reads per turn: (100 - 60) + (50 - 30).
  assert.equal(result.usage.inputTokens, 60);
  assert.equal(result.usage.outputTokens, 30);
  // Cache read/write sum across turns; context is the LAST turn's full input size.
  assert.equal(result.usage.cacheReadTokens, 90);
  assert.equal(result.usage.cacheWriteTokens, 40);
  assert.equal(result.usage.context, 50);
  // Wall-clock is reported as a non-negative number of milliseconds.
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.durationMs >= 0);
});

test("cache-aware usage formatting is shared by every CLI summary", () => {
  assert.equal(
    formatAgentUsage({
      inputTokens: 6880,
      outputTokens: 1330,
      cacheReadTokens: 40000,
      cacheWriteTokens: 2000,
      context: 20000,
    }),
    "6,880 in / 1,330 out · 40,000 cache read · 2,000 cache write · context 20,000",
  );
  assert.equal(
    formatAgentUsage({
      inputTokens: 6880,
      outputTokens: 1330,
      cacheReadTokens: 40000,
      cacheWriteTokens: 0,
      context: 20000,
    }),
    "6,880 in / 1,330 out · 40,000 cache read · context 20,000",
  );
});

test("uncached input cannot become negative when provider usage is inconsistent", () => {
  assert.equal(uncachedInputTokens(50, 60), 0);
  assert.equal(uncachedInputTokens(50, 30), 20);
});

test("runAgentTask reports zeroed usage when the model omits a usage block", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([{ text: "hi", toolCalls: [] }]);
  const result = await runAgentTask({ task: "x", model, browser });
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    context: 0,
  });
  assert.equal(result.toolCalls, 0);
});

test("runAgentTask continues from a prior transcript (session memory)", async () => {
  const browser = fakeBrowser();
  const prior = [
    { role: "user", text: "first task" },
    { role: "assistant", text: "did the first task", toolCalls: [] },
  ];
  const model = scriptedModel([{ text: "used the earlier context", toolCalls: [] }]);

  const result = await runAgentTask({ task: "follow-up", model, browser, history: prior });

  // The model saw the prior transcript plus the new task.
  const sent = model.seen[0].messages;
  assert.equal(sent[0].text, "first task");
  assert.equal(sent[1].text, "did the first task");
  assert.equal(sent[2].text, "follow-up");
  // The returned transcript extends the same history (so the console can chain).
  assert.equal(result.transcript[0].text, "first task");
  assert.equal(result.transcript.at(-1).text, "used the earlier context");
});

test("claudeModel coalesces consecutive user turns so a continued session stays valid", async () => {
  let captured;
  const client = {
    messages: {
      async create(req) {
        captured = req;
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };
  const model = claudeModel({ client, model: "claude-test" });
  // A carried transcript ends in a tool result (user-role); then a new user task.
  await model.complete({
    system: "s",
    messages: [
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "browser", input: {} }] },
      { role: "tool", results: [{ id: "t1", name: "browser", content: "obs" }] },
      { role: "user", text: "next task" },
    ],
    tools: [{ name: "browser", description: "d", parameters: { type: "object" } }],
  });

  // No two adjacent messages share a role, and the tool result + new task merged
  // into one user turn carrying both blocks.
  for (let i = 1; i < captured.messages.length; i += 1)
    assert.notEqual(captured.messages[i].role, captured.messages[i - 1].role);
  const merged = captured.messages.find(
    (m) => m.role === "user" && m.content.some((c) => c.type === "tool_result") && m.content.some((c) => c.type === "text"),
  );
  assert.ok(merged, "tool result and the new user task should be one coalesced user turn");
});

test("runAgentTask treats a prose reply (no tool call) as the answer", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([{ text: "Paris is the capital.", toolCalls: [] }]);
  const result = await runAgentTask({ task: "capital of France?", model, browser });
  assert.equal(result.answer, "Paris is the capital.");
  assert.equal(result.reason, "answered");
  assert.equal(result.ok, true);
});

test("runAgentTask has no step cap and runs until the model finishes", async () => {
  const browser = fakeBrowser({ runs: Array(30).fill({ ok: true, result: "x", artifacts: [] }) });
  const model = scriptedModel([
    ...Array(30).fill({ text: "", toolCalls: [{ id: "c", name: "browser", input: { code: "1" } }] }),
    { text: "", toolCalls: [{ id: "d", name: "done", input: { answer: "finally done" } }] },
  ]);
  const result = await runAgentTask({ task: "long loop", model, browser });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "done");
  assert.equal(result.answer, "finally done");
  assert.equal(result.steps, 31);
  assert.equal(browser.calls.run.length, 30);
});

test("runAgentTask stops at its wall-clock budget without restoring a step cap", async () => {
  const browser = fakeBrowser();
  let completed = false;
  let modelSignal;
  const model = {
    async complete({ signal }) {
      modelSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      completed = true;
      return { text: "too late", toolCalls: [] };
    },
  };

  const result = await runAgentTask({
    task: "do not run forever",
    model,
    browser,
    maxDurationMs: 10,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.answer, "");
  assert.equal(result.steps, 1);
  assert.equal(completed, false, "the caller returned before the stalled model");
  assert.equal(modelSignal.aborted, true, "the stalled model received cancellation");
  assert.ok(result.durationMs >= 8);
});

test("runAgentTask rejects an invalid wall-clock budget", async () => {
  await assert.rejects(
    runAgentTask({
      task: "x",
      model: scriptedModel([]),
      browser: fakeBrowser(),
      maxDurationMs: 0,
    }),
    /maxDurationMs must be between/,
  );
});

test("runAgentTask bounds its transcript without imposing a step count", async () => {
  const model = scriptedModel([{ text: "should not run", toolCalls: [] }]);
  const result = await runAgentTask({
    task: "a task longer than the configured transcript budget",
    model,
    browser: fakeBrowser(),
    maxTranscriptChars: 10,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "context_limit");
  assert.equal(model.seen.length, 0);
});

test("login tool is offered only with a vault and runs fillCredential", async () => {
  const withVault = fakeBrowser({ vault: {} });
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "l1", name: "login", input: { username: "alice", currentPasswordSelector: "#old-password", submit: false, generate: true, matchMode: "exact-origin", session: "untrusted", code: "danger()" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "in" } }] },
  ]);
  await runAgentTask({ task: "log in", model, browser: withVault });
  assert.equal(withVault.calls.fill.length, 1);
  assert.equal(withVault.calls.fill[0].passwordSelector, undefined);
  assert.equal(withVault.calls.fill[0].currentPasswordSelector, "#old-password");
  assert.equal(withVault.calls.fill[0].submit, false);
  assert.equal(withVault.calls.fill[0].session, "default");
  assert.equal(withVault.calls.fill[0].code, undefined);
  assert.equal(withVault.calls.fill[0].matchMode, "exact-origin");
  // The tool list handed to the model included login.
  const loginTool = model.seen[0].tools.find((t) => t.name === "login");
  assert.ok(loginTool);
  assert.deepEqual(loginTool.parameters.properties.matchMode.enum, [
    "base-domain",
    "host",
    "exact-origin",
    "never",
  ]);
  assert.ok(!loginTool.parameters.required?.includes("passwordSelector"));
  assert.equal(
    loginTool.parameters.properties.currentPasswordSelector.type,
    "string",
  );
  assert.match(model.seen[0].system, /Loaded skill: credential-manager/);

  const noVault = fakeBrowser({ vault: null });
  const model2 = scriptedModel([{ text: "no", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: model2, browser: noVault });
  assert.ok(!model2.seen[0].tools.some((t) => t.name === "login"));

  const invalidModel = scriptedModel([
    {
      text: "",
      toolCalls: [
        {
          id: "l2",
          name: "login",
          input: { generate: true, matchMode: "same-site" },
        },
      ],
    },
    { text: "", toolCalls: [{ id: "d2", name: "done", input: { answer: "stopped" } }] },
  ]);
  const invalidResult = await runAgentTask({
    task: "generate a login",
    model: invalidModel,
    browser: withVault,
  });
  assert.equal(withVault.calls.fill.length, 1);
  const invalidToolTurn = invalidResult.transcript.find(
    (message) => message.role === "tool",
  );
  assert.match(invalidToolTurn.results[0].content, /login error: matchMode.*exact-origin/);
});

test("login failure exposes secret-free pending recovery to the model", async () => {
  const pendingCredential = {
    pendingId: "pending-recovery-1",
    origin: "https://signup.example",
    matchMode: "exact-origin",
    username: "alice@example.com",
    label: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const browser = fakeBrowser({
    vault: {},
    fills: [
      {
        ok: false,
        error: "submit control disappeared",
        pendingCredential,
        artifacts: [],
      },
    ],
  });
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        { id: "l1", name: "login", input: { generate: true } },
      ],
    },
    {
      text: "",
      toolCalls: [{ id: "d1", name: "done", input: { answer: "recovered" } }],
    },
  ]);

  await runAgentTask({ task: "create account", model, browser });

  const toolTurn = model.seen[1].messages.find(
    (message) => message.role === "tool",
  );
  const observation = JSON.parse(toolTurn.results[0].content);
  assert.equal(observation.error, "submit control disappeared");
  assert.deepEqual(observation.pendingCredential, pendingCredential);
  assert.equal(Object.hasOwn(observation.pendingCredential, "secret"), false);
});

test("ask tool is offered only with an askUser handler and routes to it", async () => {
  const browser = fakeBrowser();
  const asked = [];
  const askUser = async ({ question, options }) => {
    asked.push({ question, options });
    return "the blue one";
  };
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "a1", name: "ask", input: { question: "Which?", options: ["blue", "red"] } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "picked blue" } }] },
  ]);

  const result = await runAgentTask({ task: "choose", model, browser, askUser });

  // The tool list handed to the model included ask, and the handler ran.
  assert.ok(model.seen[0].tools.some((t) => t.name === "ask"));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { question: "Which?", options: ["blue", "red"] });
  // The user's answer was fed back to the model as the tool result.
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /the blue one/);
  // ask + done both count as tool calls.
  assert.equal(result.toolCalls, 2);

  // Without askUser, no ask tool is offered and the loop stays autonomous.
  const noAsk = fakeBrowser();
  const model2 = scriptedModel([{ text: "done", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: model2, browser: noAsk });
  assert.ok(!model2.seen[0].tools.some((t) => t.name === "ask"));
});

test("interactive preamble invites the ask tool; headless does not", async () => {
  const browser = fakeBrowser();
  const withAsk = scriptedModel([{ text: "hi", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: withAsk, browser, askUser: async () => "" });
  assert.match(withAsk.seen[0].system, /interactive session/);
  assert.match(withAsk.seen[0].system, /`ask` tool/);

  const headless = scriptedModel([{ text: "hi", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: headless, browser: fakeBrowser() });
  assert.match(headless.seen[0].system, /operating autonomously/);
  assert.doesNotMatch(headless.seen[0].system, /`ask` tool/);
});

test("terminal steering is injected at the next model turn", async () => {
  const steering = [[], ["use the cheaper option"], [], []];
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        { id: "b1", name: "browser", input: { code: "return 1" } },
      ],
    },
    {
      text: "",
      toolCalls: [{ id: "d1", name: "done", input: { answer: "updated" } }],
    },
  ]);

  const result = await runAgentTask({
    task: "find a computer",
    model,
    browser: fakeBrowser(),
    drainSteering: () => steering.shift() || [],
  });

  assert.equal(result.answer, "updated");
  const guidance = model.seen[1].messages.find(
    (message) =>
      message.role === "user" &&
      /interactive terminal/i.test(message.text || ""),
  );
  assert.match(guidance.text, /use the cheaper option/);
});

test("steering that arrives with done defers completion", async () => {
  const steering = [[], ["also compare warranties"], [], []];
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [{ id: "d1", name: "done", input: { answer: "too early" } }],
    },
    {
      text: "",
      toolCalls: [{ id: "d2", name: "done", input: { answer: "compared" } }],
    },
  ]);

  const result = await runAgentTask({
    task: "pick one",
    model,
    browser: fakeBrowser(),
    drainSteering: () => steering.shift() || [],
  });

  assert.equal(result.answer, "compared");
  assert.equal(result.steps, 2);
  const firstToolTurn = result.transcript.find(
    (message) => message.role === "tool",
  );
  assert.match(firstToolTurn.results[0].content, /Completion deferred/);
  assert.ok(
    model.seen[1].messages.some(
      (message) =>
        message.role === "user" &&
        /also compare warranties/.test(message.text || ""),
    ),
  );
});

test("resolveModel uses actual model ids, passes objects through, and rejects shortcuts", () => {
  const custom = { name: "mine", complete: async () => ({ text: "", toolCalls: [] }) };
  assert.equal(resolveModel(custom), custom);
  assert.throws(() => resolveModel("claude"), /Unknown model/);
  assert.throws(() => resolveModel("codex"), /Unknown model/);
  assert.throws(() => resolveModel("grok"), /Unknown model/);
  const endpoint = resolveModel("vendor/opaque-id", {
    baseURL: "https://models.example/v1",
  });
  assert.equal(endpoint.name, "custom");
  assert.equal(endpoint.modelId, "vendor/opaque-id");
  assert.throws(() => resolveModel("mistral-large"), /Unknown model/);
});

test("resolveModel accepts bare and source-qualified actual model ids", () => {
  // gpt-* / o* → codex, grok-* → grok, claude-* → claude; the id becomes model id.
  const codex = resolveModel("gpt-5.6-luna", { apiKey: "k" });
  assert.equal(codex.name, "codex");
  assert.equal(codex.modelId, "gpt-5.6-luna");

  const grok = resolveModel("grok-4.3", { apiKey: "k" });
  assert.equal(grok.name, "grok");
  assert.equal(grok.modelId, "grok-4.3");

  const claude = resolveModel("claude-opus-4-8");
  assert.equal(claude.name, "claude");
  assert.equal(claude.modelId, "claude-opus-4-8");

  const pinned = resolveModel("codex/gpt-5.6-luna", { apiKey: "k" });
  assert.equal(pinned.name, "codex");
  assert.equal(pinned.modelId, "gpt-5.6-luna");

  const ollama = resolveModel("ollama/qwen3:8b");
  assert.equal(ollama.name, "ollama");
  assert.equal(ollama.modelId, "qwen3:8b");
});

test("bare endpoint ids auto-resolve only when one available source exposes them", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async text() {
      return JSON.stringify({
        data: url.includes("11434")
          ? [{ id: "qwen3:8b" }, { id: "gpt-5.6-sol" }]
          : [],
      });
    },
  });

  const unique = await resolveModelSelection("qwen3:8b", { fetchImpl });
  assert.equal(unique.name, "ollama");
  assert.equal(unique.modelId, "qwen3:8b");

  await assert.rejects(
    resolveModelSelection("gpt-5.6-sol", {
      apiKey: "native-key",
      fetchImpl,
    }),
    /multiple sources: codex\/gpt-5\.6-sol, ollama\/gpt-5\.6-sol/,
  );

  await assert.rejects(
    resolveModelSelection("codex", { fetchImpl }),
    /No available model source exposes "codex"/,
  );
  await assert.rejects(
    resolveModelSelection("claude", { fetchImpl }),
    /No available model source exposes "claude"/,
  );
  await assert.rejects(
    resolveModelSelection("grok", { fetchImpl }),
    /No available model source exposes "grok"/,
  );
});

test("model choices omit source prefixes until a real collision", () => {
  const choices = modelSelectionChoices([
    { source: "codex", model: "gpt-5.6-sol" },
    { source: "openrouter", model: "openai/gpt-5.6-sol" },
    { source: "ollama", model: "qwen3:8b" },
    { source: "vllm", model: "shared-model" },
    { source: "ollama", model: "shared-model" },
  ]);
  const bySourceAndModel = new Map(
    choices.map((choice) => [
      `${choice.source}/${choice.model}`,
      choice.selector,
    ]),
  );

  assert.equal(
    bySourceAndModel.get("codex/gpt-5.6-sol"),
    "codex/gpt-5.6-sol",
  );
  assert.equal(
    bySourceAndModel.get("openrouter/openai/gpt-5.6-sol"),
    "openai/gpt-5.6-sol",
  );
  assert.equal(bySourceAndModel.get("ollama/qwen3:8b"), "qwen3:8b");
  assert.equal(
    bySourceAndModel.get("vllm/shared-model"),
    "vllm/shared-model",
  );
  assert.equal(
    bySourceAndModel.get("ollama/shared-model"),
    "ollama/shared-model",
  );
});

test("endpoint presets keep model ids opaque and use a conservative chat request", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
      redirect: init.redirect,
    };
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: [{ type: "text", text: "working" }],
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "browser",
                      arguments: { code: "return page.title()" },
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      },
    };
  };

  const model = resolveModel("ollama/qwen3:8b", {
    fetchImpl,
  });
  const out = await model.complete({
    system: "SYS",
    messages: [{ role: "user", text: "hi" }],
    tools: [
      {
        name: "browser",
        description: "run browser code",
        parameters: { type: "object" },
      },
    ],
  });

  assert.equal(model.name, "ollama");
  assert.equal(model.modelId, "qwen3:8b");
  assert.equal(captured.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(captured.body.model, "qwen3:8b");
  assert.equal(captured.body.max_tokens, 4096);
  assert.equal(Object.hasOwn(captured.body, "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(captured.body, "parallel_tool_calls"), false);
  assert.equal(Object.hasOwn(captured.headers, "authorization"), false);
  assert.equal(captured.redirect, "error");
  assert.equal(out.text, "working");
  assert.deepEqual(out.toolCalls[0].input, {
    code: "return page.title()",
  });
});

test("OpenRouter preset supplies attribution headers and requires its API key", async () => {
  assert.throws(
    () =>
      endpointModel({
        source: "openrouter",
        model: "anthropic/model-id",
        apiKey: "",
      }),
    /OpenRouter needs an API key/,
  );

  let captured;
  const model = endpointModel({
    source: "openrouter",
    model: "anthropic/model-id",
    apiKey: "router-key",
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers };
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
          };
        },
      };
    },
  });
  await model.complete({
    system: "SYS",
    messages: [],
    tools: [],
  });

  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer router-key");
  assert.equal(
    captured.headers["HTTP-Referer"],
    "https://github.com/BetterWright/betterwright",
  );
  assert.equal(captured.headers["X-OpenRouter-Title"], "BetterWright");
});

test("custom endpoint validation is helpful and protects non-local API keys", () => {
  assert.throws(
    () => endpointModel({ source: "custom", model: "model-id" }),
    /custom endpoint needs --base-url/,
  );
  assert.throws(
    () =>
      endpointModel({
        source: "custom",
        baseURL: "http://models.example/v1",
        model: "model-id",
        apiKey: "secret",
      }),
    /Refusing to send.*plain HTTP/,
  );
  assert.throws(
    () =>
      endpointModel({
        source: "custom",
        baseURL: "https://models.example/v1",
        model: "model-id",
        apiKeyEnv: "not-a-valid-name",
      }),
    /Invalid --api-key-env/,
  );
  assert.doesNotThrow(() =>
    endpointModel({
      source: "custom",
      baseURL: "http://127.0.0.1:9000/v1",
      model: "model-id",
      apiKey: "local-secret",
    }),
  );
});

test("endpoint Responses protocol is explicit and omits optional compatibility fields", async () => {
  let captured;
  const model = endpointModel({
    source: "vllm",
    model: "served-model",
    protocol: "responses",
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
            status: "completed",
          });
        },
      };
    },
  });
  const out = await model.complete({
    system: "SYS",
    messages: [],
    tools: [],
  });

  assert.equal(captured.url, "http://127.0.0.1:8000/v1/responses");
  assert.equal(captured.body.model, "served-model");
  assert.equal(captured.body.max_output_tokens, 4096);
  assert.equal(captured.body.stream, false);
  assert.equal(Object.hasOwn(captured.body, "parallel_tool_calls"), false);
  assert.equal(Object.hasOwn(captured.body, "store"), false);
  assert.equal(out.text, "done");
});

test("listEndpointModels normalizes standard and Ollama-style model lists", async () => {
  const requests = [];
  const standard = await listEndpointModels({
    source: "custom",
    baseURL: "https://models.example/v1/",
    apiKey: "key",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            data: [
              { id: "first/model" },
              { id: "second-model" },
              { id: "first/model" },
            ],
          });
        },
      };
    },
  });
  assert.deepEqual(standard, {
    source: "custom",
    baseURL: "https://models.example/v1",
    models: ["first/model", "second-model"],
  });
  assert.equal(requests[0].url, "https://models.example/v1/models");
  assert.equal(requests[0].init.headers.authorization, "Bearer key");
  assert.equal(requests[0].init.redirect, "error");

  const ollama = await listEndpointModels({
    source: "ollama",
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({
          models: [{ name: "qwen3:8b" }, { model: "gpt-oss:20b" }],
        });
      },
    }),
  });
  assert.deepEqual(ollama.models, ["qwen3:8b", "gpt-oss:20b"]);
});

test("endpoint preset defaults stay stable", () => {
  assert.equal(
    MODEL_ENDPOINT_PRESETS.openrouter.baseURL,
    "https://openrouter.ai/api/v1",
  );
  assert.equal(
    MODEL_ENDPOINT_PRESETS.ollama.baseURL,
    "http://127.0.0.1:11434/v1",
  );
  assert.equal(
    MODEL_ENDPOINT_PRESETS.vllm.baseURL,
    "http://127.0.0.1:8000/v1",
  );
  assert.equal(MODEL_ENDPOINT_PRESETS.custom.baseURL, null);
});

test("openaiModel translates the transcript and parses tool calls", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), signal: init.signal };
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "working",
                tool_calls: [
                  // No id — the adapter must synthesize one.
                  { type: "function", function: { name: "browser", arguments: '{"code":"return 1"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
          },
        };
      },
    };
  };
  const model = openaiModel({ baseURL: "https://api.example/v1/", model: "m1", apiKey: "k", fetchImpl });
  const controller = new AbortController();
  const out = await model.complete({
    system: "SYS",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok", toolCalls: [{ id: "a1", name: "browser", input: { code: "x" } }] },
      { role: "tool", results: [{ id: "a1", name: "browser", content: "obs" }] },
    ],
    tools: [{ name: "browser", description: "d", parameters: { type: "object" } }],
    signal: controller.signal,
  });

  assert.equal(captured.url, "https://api.example/v1/chat/completions");
  assert.equal(captured.body.model, "m1");
  assert.equal(captured.body.messages[0].role, "system");
  assert.equal(captured.body.messages[0].content, "SYS");
  assert.equal(captured.body.messages[2].tool_calls[0].function.name, "browser");
  assert.equal(captured.body.messages[3].role, "tool");
  assert.equal(captured.body.tools[0].type, "function");
  assert.equal(captured.signal, controller.signal);
  assert.equal(out.text, "working");
  assert.equal(out.toolCalls[0].name, "browser");
  assert.deepEqual(out.toolCalls[0].input, { code: "return 1" });
  assert.equal(out.toolCalls[0].id, "call_1"); // synthesized
  // prompt_/completion_tokens normalize to input/output; cached_tokens → cache read
  // and cache_write_tokens → cache write are read directly (GPT-5.6+).
  assert.deepEqual(out.usage, { inputTokens: 42, outputTokens: 8, cacheReadTokens: 30, cacheWriteTokens: 5 });
});

test("openaiModel surfaces HTTP errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async text() { return "no auth"; } });
  const model = openaiModel({ baseURL: "https://x/v1", model: "m", apiKey: "k", fetchImpl });
  await assert.rejects(model.complete({ system: "s", messages: [], tools: [] }), /401.*no auth/s);
});

test("claudeModel maps to the Anthropic shape and parses content", async () => {
  let captured;
  let requestOptions;
  const client = {
    messages: {
      async create(req, options) {
        captured = req;
        requestOptions = options;
        return {
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "t1", name: "done", input: { answer: "A" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 30, cache_read_input_tokens: 12, cache_creation_input_tokens: 8, output_tokens: 5 },
        };
      },
    },
  };
  const model = claudeModel({ client, model: "claude-test" });
  const controller = new AbortController();
  const out = await model.complete({
    system: "SYS",
    messages: [
      { role: "user", text: "hi" },
      { role: "tool", results: [{ id: "x", name: "browser", content: "obs" }] },
    ],
    tools: [{ name: "done", description: "finish", parameters: { type: "object" } }],
    signal: controller.signal,
  });

  assert.equal(captured.model, "claude-test");
  // System goes as a block array with a cache breakpoint after the static
  // prefix; a second breakpoint sits on the final message's last block so each
  // turn re-reads the prior conversation from cache and writes only the tail.
  assert.deepEqual(captured.system, [
    { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(captured.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  const marked = captured.messages
    .flatMap((m) => m.content)
    .filter((c) => c.cache_control).length;
  assert.equal(marked, 1, "exactly one message block carries the moving breakpoint");
  assert.equal(captured.tools[0].input_schema.type, "object");
  assert.equal(requestOptions.signal, controller.signal);
  // A `tool` message maps to a tool_result block (position may shift when adjacent
  // user turns coalesce).
  const toolResult = captured.messages.flatMap((m) => m.content).find((c) => c.type === "tool_result");
  assert.equal(toolResult?.tool_use_id, "x");
  assert.equal(out.text, "sure");
  assert.equal(out.toolCalls[0].name, "done");
  assert.deepEqual(out.toolCalls[0].input, { answer: "A" });
  // input = uncached + cache read + cache write (30 + 12 + 8); cache parts break out.
  assert.deepEqual(out.usage, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 8 });
});

test("codex and grok adapters require credentials", () => {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_BASE_URL", "GROK_API_KEY", "XAI_API_KEY", "GROK_BASE_URL"])
    delete process.env[key];
  // Point both OAuth homes at nonexistent dirs so no stored session is found.
  process.env.CODEX_HOME = "/nonexistent-codex-home";
  process.env.GROK_HOME = "/nonexistent-grok-home";
  try {
    assert.throws(() => codexModel(), /codex credentials/);
    assert.throws(() => grokModel(), /grok credentials/);
    // With an explicit key, the adapter builds and carries its model id.
    assert.equal(grokModel({ apiKey: "k", model: "grok-x" }).modelId, "grok-x");
    assert.equal(codexModel({ apiKey: "k" }).name, "codex");
  } finally {
    process.env = env;
  }
});

test("codex OAuth session calls the ChatGPT backend with the account header", async () => {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_BASE_URL", "OPENAI_BASE_URL"]) delete process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-codex-"));
  process.env.CODEX_HOME = home;
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: futureJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }),
        access_token: futureJwt(),
        refresh_token: "r",
        account_id: "acct-9",
      },
      last_refresh: new Date().toISOString(),
    }),
  );
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      async text() {
        return 'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      },
    };
  };
  try {
    const model = codexModel({ fetchImpl, effort: "low" });
    assert.equal(model.modelId, "gpt-5.6-sol", "defaults to the codex slug");
    const out = await model.complete({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] });
    assert.equal(out.text, "hi");
    assert.match(captured.url, /chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.equal(captured.headers["ChatGPT-Account-ID"], "acct-9");
    assert.equal(captured.headers.originator, "codex_cli_rs");
    assert.match(captured.headers.authorization, /^Bearer /);
    assert.equal(captured.body.store, false);
    assert.equal(captured.body.stream, true);
    assert.deepEqual(captured.body.reasoning, { effort: "low" });
  } finally {
    process.env = env;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runAgentTask runs multiple browser calls batched in one turn", async () => {
  const browser = fakeBrowser({
    runs: [
      { ok: true, result: "A", artifacts: [], durationMs: 3 },
      { ok: true, result: "B", artifacts: [], durationMs: 3 },
    ],
  });
  const model = scriptedModel([
    {
      text: "batching",
      toolCalls: [
        { id: "b1", name: "browser", input: { code: "return 'A'" } },
        { id: "b2", name: "browser", input: { code: "return 'B'" } },
      ],
    },
    { text: "", toolCalls: [{ id: "d", name: "done", input: { answer: "done" } }] },
  ]);
  const result = await runAgentTask({ task: "batch", model, browser });
  assert.equal(browser.calls.run.length, 2, "both batched calls ran in the one turn");
  assert.equal(result.reason, "done");
  // Both results come back in a single tool message so the model sees them together.
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.equal(toolTurn.results.length, 2);
  assert.match(toolTurn.results[0].content, /"result":"A"/);
  assert.match(toolTurn.results[1].content, /"result":"B"/);
});

test("runAgentTask ignores tool calls batched after done", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        { id: "d", name: "done", input: { answer: "final" } },
        { id: "b", name: "browser", input: { code: "return 1" } },
      ],
    },
  ]);
  const result = await runAgentTask({ task: "x", model, browser });
  assert.equal(result.answer, "final");
  assert.equal(result.reason, "done");
  assert.equal(browser.calls.run.length, 0, "the browser call after done never executed");
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[1].content, /already finished/);
});

test("runAgentTask reports an unknown tool without crashing", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "u", name: "teleport", input: {} }] },
    { text: "", toolCalls: [{ id: "d", name: "done", input: { answer: "ok" } }] },
  ]);
  const result = await runAgentTask({ task: "x", model, browser });
  assert.equal(result.reason, "done");
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /Unknown tool: teleport/);
});

test("responsesModel parses batched function_call items from the SSE stream and dedups", async () => {
  let captured;
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"planning"}',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"fc_1","name":"browser","arguments":"{\\"code\\":\\"return 1\\"}"}}',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"fc_2","name":"browser","arguments":"{\\"code\\":\\"return 2\\"}"}}',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"fc_1","name":"browser","arguments":"{\\"code\\":\\"return 1\\"}"}}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":64,"cache_write_tokens":16}}}}',
  ].join("\n\n");
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return sse; } };
  };
  const model = codexModel({ apiKey: "k", protocol: "responses", baseURL: "https://router.test/v1", fetchImpl });
  const out = await model.complete({
    system: "s",
    messages: [{ role: "user", text: "go" }],
    tools: [{ name: "browser", description: "d", parameters: { type: "object" } }],
  });
  assert.equal(out.text, "planning");
  assert.equal(out.toolCalls.length, 2, "the duplicate call_id is collapsed");
  assert.deepEqual(out.toolCalls.map((c) => c.id), ["fc_1", "fc_2"]);
  assert.deepEqual(out.toolCalls[0].input, { code: "return 1" });
  assert.equal(out.stopReason, "completed");
  assert.deepEqual(out.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 64,
    cacheWriteTokens: 16,
  });
  // Batched tool calls are enabled on the request.
  assert.equal(captured.body.parallel_tool_calls, true);
  assert.match(captured.url, /\/responses$/);
});

test("responsesModel throws on a response.failed event", async () => {
  const sse = 'data: {"type":"response.failed","response":{"error":{"message":"model exploded"}}}\n\n';
  const fetchImpl = async () => ({ ok: true, status: 200, async text() { return sse; } });
  const model = codexModel({ apiKey: "k", protocol: "responses", baseURL: "https://r/v1", fetchImpl });
  await assert.rejects(model.complete({ system: "s", messages: [], tools: [] }), /model exploded/);
});

test("responsesModel parses a non-streaming JSON response body", async () => {
  const json = JSON.stringify({
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "plain answer" }] },
      { type: "function_call", call_id: "c9", name: "done", arguments: '{"answer":"A"}' },
    ],
  });
  const fetchImpl = async () => ({ ok: true, status: 200, async text() { return json; } });
  const model = codexModel({ apiKey: "k", protocol: "responses", baseURL: "https://r/v1", fetchImpl });
  const out = await model.complete({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] });
  assert.equal(out.text, "plain answer");
  assert.equal(out.toolCalls[0].name, "done");
  assert.deepEqual(out.toolCalls[0].input, { answer: "A" });
  assert.equal(out.stopReason, "completed");
});

test("codexModel reads the configured model id from config.toml", () => {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_BASE_URL", "OPENAI_BASE_URL", "BETTERWRIGHT_CODEX_MODEL"])
    delete process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-codexcfg-"));
  process.env.CODEX_HOME = home;
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-custom-9"\n');
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: futureJwt(), refresh_token: "r", id_token: futureJwt() },
    }),
  );
  try {
    const model = codexModel({ fetchImpl: async () => ({ ok: true, status: 200, async text() { return ""; } }) });
    assert.equal(model.modelId, "gpt-custom-9");
  } finally {
    process.env = env;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("grok OAuth session calls xAI chat/completions with a bearer token", async () => {
  const env = { ...process.env };
  for (const key of ["GROK_API_KEY", "XAI_API_KEY", "GROK_BASE_URL", "XAI_BASE_URL"]) delete process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-grok-"));
  process.env.GROK_HOME = home;
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      provider: "grok",
      tokens: { access_token: "grok-access", refresh_token: "r", id_token: null },
      account_id: "u1",
      expires_at: Date.now() + 3_600_000,
      last_refresh: new Date().toISOString(),
    }),
  );
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers };
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "yo" }, finish_reason: "stop" }] };
      },
    };
  };
  try {
    const model = grokModel({ fetchImpl, model: "grok-4.3" });
    const out = await model.complete({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] });
    assert.equal(out.text, "yo");
    assert.match(captured.url, /api\.x\.ai\/v1\/chat\/completions$/);
    assert.equal(captured.headers.authorization, "Bearer grok-access");
  } finally {
    process.env = env;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Live view + handoff

// Extend the fake browser with the live-view surface the handoff tool uses.
function liveViewBrowser(overrides = {}) {
  const browser = fakeBrowser(overrides);
  browser.calls.liveView = [];
  browser.calls.handoffs = [];
  browser.calls.asks = [];
  browser.calls.chatPosts = [];
  browser.calls.chatDrains = 0;
  browser.calls.stops = 0;
  browser._inbox = Array.isArray(overrides.inbox) ? [...overrides.inbox] : [];
  browser.startLiveView = async (options) => {
    browser.calls.liveView.push(options);
    return {
      ok: true,
      url: "http://127.0.0.1:4242/?t=secret",
      alreadyRunning: browser.calls.liveView.length > 1,
      ...(overrides.startLiveViewResult || {}),
    };
  };
  browser.waitForHandoff = async (options) => {
    browser.calls.handoffs.push(options);
    return overrides.handoffResult || { ok: true, action: "done", note: "approved" };
  };
  browser.waitForAsk = async (options) => {
    browser.calls.asks.push(options);
    return overrides.askResult || { ok: true, action: "answer", answer: "42" };
  };
  browser.liveViewPostChat = async (options) => {
    browser.calls.chatPosts.push(options);
    return { ok: true };
  };
  browser.liveViewDrainChat = async () => {
    browser.calls.chatDrains += 1;
    const messages = browser._inbox.splice(0, browser._inbox.length);
    return { ok: true, messages };
  };
  browser.stopLiveView = async () => {
    browser.calls.stops += 1;
    return { ok: true, running: false };
  };
  return browser;
}

test("the handoff tool pauses on waitForHandoff and resumes with the human note", async () => {
  const browser = liveViewBrowser();
  const steps = [];
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "h1", name: "handoff", input: { reason: "Approve the MFA prompt", expectation: "the dashboard loads" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "signed in" } }] },
  ]);
  const result = await runAgentTask({
    task: "log in",
    model,
    browser,
    onStep: (event) => steps.push(event),
  });

  assert.equal(result.ok, true);
  // The handoff tool was offered to the model (onStep is the URL surface).
  assert.ok(model.seen[0].tools.some((tool) => tool.name === "handoff"));
  // The viewer started on demand and the loop blocked on waitForHandoff.
  assert.equal(browser.calls.liveView.length, 1);
  assert.equal(browser.calls.handoffs.length, 1);
  assert.match(browser.calls.handoffs[0].prompt, /Approve the MFA prompt/);
  assert.match(browser.calls.handoffs[0].prompt, /the dashboard loads/);
  // The URL reached the user through onStep.
  const handoffStep = steps.find((event) => event.tool === "handoff");
  assert.equal(handoffStep.url, "http://127.0.0.1:4242/?t=secret");
  // The human's note reached the model, with a re-observe instruction.
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /Human note: approved/);
  assert.match(toolTurn.results[0].content, /re-observe/);
  // The agent started the viewer, so it stopped it (external browser).
  assert.equal(browser.calls.stops, 1);
});

test("a cancelled handoff tells the model the step is blocked", async () => {
  const browser = liveViewBrowser({ handoffResult: { ok: true, action: "cancel", note: "wrong account" } });
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "h1", name: "handoff", input: { reason: "Approve" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "blocked" } }] },
  ]);
  const result = await runAgentTask({ task: "x", model, browser, onStep: () => {} });
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /cancelled/);
  assert.match(toolTurn.results[0].content, /wrong account/);
  assert.match(toolTurn.results[0].content, /blocked/);
});

test("handoff is not offered without a URL surface or when liveView is false", async () => {
  const silent = liveViewBrowser();
  const model = scriptedModel([{ text: "done", toolCalls: [] }]);
  await runAgentTask({ task: "x", model, browser: silent });
  assert.ok(!model.seen[0].tools.some((tool) => tool.name === "handoff"));

  const disabled = liveViewBrowser();
  const model2 = scriptedModel([{ text: "done", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: model2, browser: disabled, liveView: false, onStep: () => {} });
  assert.ok(!model2.seen[0].tools.some((tool) => tool.name === "handoff"));
  assert.equal(disabled.calls.liveView.length, 0);
});

test("ordinary progress mirroring never starts Live View without explicit activation", async () => {
  const browser = liveViewBrowser();
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        { id: "b1", name: "browser", input: { code: "return 1", note: "checking" } },
      ],
    },
    { text: "done", toolCalls: [] },
  ]);
  const result = await runAgentTask({
    task: "check the page",
    model,
    browser,
    onStep: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(browser.calls.liveView.length, 0);
  assert.equal(browser.calls.chatPosts.length, 0);
  assert.equal(browser.calls.stops, 0);
});

test("liveView: true starts the viewer before step 1 and stops it at task end", async () => {
  const browser = liveViewBrowser();
  const steps = [];
  const model = scriptedModel([{ text: "all done", toolCalls: [] }]);
  const result = await runAgentTask({
    task: "x",
    model,
    browser,
    liveView: true,
    onStep: (event) => steps.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(browser.calls.liveView.length, 1);
  assert.equal(steps[0].tool, "liveView");
  assert.equal(steps[0].url, "http://127.0.0.1:4242/?t=secret");
  assert.equal(browser.calls.stops, 1);
  // The system prompt tells the model when to reach for handoff vs ask.
  assert.match(model.seen[0].system, /`handoff` tool/);
  // Mid-session watch without pause is a dedicated tool.
  assert.ok(model.seen[0].tools.some((tool) => tool.name === "live_view"));
  // Live view also offers ask (chat-backed) and freeform guidance.
  assert.ok(model.seen[0].tools.some((tool) => tool.name === "ask"));
  assert.ok(browser.calls.chatPosts.some((line) => /Message the agent/i.test(line.text) || /guidance/i.test(line.text)));
});

test("live_view tool starts mid-task and returns the watch URL without handoff", async () => {
  const browser = liveViewBrowser();
  const steps = [];
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [{ id: "lv1", name: "live_view", input: { action: "start" } }],
    },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "watching" } }] },
  ]);
  const result = await runAgentTask({
    task: "show me",
    model,
    browser,
    onStep: (event) => steps.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(browser.calls.liveView.length, 1);
  assert.equal(browser.calls.handoffs.length, 0);
  const liveStep = steps.find((event) => event.tool === "liveView");
  assert.equal(liveStep.url, "http://127.0.0.1:4242/?t=secret");
  const toolTurn = result.transcript.find((m) => m.role === "tool");
  assert.match(toolTurn.results[0].content, /127\.0\.0\.1:4242/);
  assert.equal(browser.calls.stops, 1);
});

test("liveView reuses a host-owned viewer without re-announcing or stopping it", async () => {
  const browser = liveViewBrowser({
    startLiveViewResult: { alreadyRunning: true },
  });
  const steps = [];
  const model = scriptedModel([{ text: "all done", toolCalls: [] }]);

  const result = await runAgentTask({
    task: "x",
    model,
    browser,
    liveView: true,
    onStep: (event) => steps.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(browser.calls.liveView.length, 1);
  assert.equal(steps.some((event) => event.tool === "liveView"), false);
  assert.equal(browser.calls.stops, 0);
  assert.ok(browser.calls.chatDrains >= 1);
});

test("live-view chat drains into the transcript between turns", async () => {
  const browser = liveViewBrowser({
    inbox: [{ text: "prefer the API docs tab" }],
  });
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "b1", name: "browser", input: { code: "return 1", note: "looking" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "found it" } }] },
  ]);
  // Seed inbox after live view starts: drain runs at the start of each model turn.
  // Turn 1 drains empty (inbox set before start is fine — drain on turn 1 picks it up).
  const result = await runAgentTask({
    task: "find the version",
    model,
    browser,
    liveView: true,
    onStep: () => {},
  });
  assert.equal(result.ok, true);
  assert.ok(browser.calls.chatDrains >= 1);
  // Human guidance appears as a user turn before a later model complete.
  const guidance = result.transcript.filter(
    (message) =>
      message.role === "user" &&
      /live view/i.test(message.text || "") &&
      /prefer the API docs tab/i.test(message.text || ""),
  );
  assert.ok(guidance.length >= 1);
  assert.ok(browser.calls.chatPosts.some((line) => line.kind === "browser"));
});

test("ask tool waits on live-view chat when liveView is available", async () => {
  const browser = liveViewBrowser({
    askResult: { ok: true, action: "answer", answer: "account ending 999" },
  });
  const model = scriptedModel([
    {
      text: "",
      toolCalls: [
        {
          id: "a1",
          name: "ask",
          input: { question: "Which account?", options: ["999", "111"] },
        },
      ],
    },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "ok" } }] },
  ]);
  const result = await runAgentTask({
    task: "sign in",
    model,
    browser,
    liveView: true,
    onStep: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(browser.calls.asks.length, 1);
  assert.equal(browser.calls.asks[0].question, "Which account?");
  const toolTurn = result.transcript.find((message) => message.role === "tool");
  assert.match(toolTurn.results[0].content, /account ending 999/);
});
