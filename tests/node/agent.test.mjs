import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeModel,
  codexModel,
  grokModel,
  openaiModel,
  resolveModel,
  runAgentTask,
} from "../../src/agent.mjs";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function futureJwt(extra = {}) {
  const payload = { exp: Math.floor(Date.now() / 1000) + 3600, ...extra };
  return `${base64url(Buffer.from("{}"))}.${base64url(Buffer.from(JSON.stringify(payload)))}.`;
}

// A fake browser standing in for BetterWright — records run() calls and returns
// canned result envelopes. `vault` toggles the login tool.
function fakeBrowser({ vault = null, runs = [] } = {}) {
  const calls = { run: [], fill: [], closed: false };
  let i = 0;
  return {
    vault,
    calls,
    async run(code, options) {
      calls.run.push({ code, options });
      return runs[i++] || { ok: true, result: "done", artifacts: [], durationMs: 5 };
    },
    async fillCredential(options) {
      calls.fill.push(options);
      return { ok: true, result: "filled", artifacts: [], durationMs: 5 };
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

test("runAgentTask sums token usage and counts every tool call", async () => {
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
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    // A final turn: done + a usage block. Providers that omit usage contribute 0.
    {
      text: "",
      toolCalls: [{ id: "d1", name: "done", input: { answer: "ok" } }],
      usage: { inputTokens: 50, outputTokens: 10 },
    },
  ]);

  const result = await runAgentTask({ task: "count", model, browser });

  // 2 browser + 1 done = 3 tool calls across 2 steps.
  assert.equal(result.toolCalls, 3);
  assert.equal(result.usage.inputTokens, 150);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.totalTokens, 180);
});

test("runAgentTask reports zeroed usage when the model omits a usage block", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([{ text: "hi", toolCalls: [] }]);
  const result = await runAgentTask({ task: "x", model, browser });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(result.toolCalls, 0);
});

test("runAgentTask treats a prose reply (no tool call) as the answer", async () => {
  const browser = fakeBrowser();
  const model = scriptedModel([{ text: "Paris is the capital.", toolCalls: [] }]);
  const result = await runAgentTask({ task: "capital of France?", model, browser });
  assert.equal(result.answer, "Paris is the capital.");
  assert.equal(result.reason, "answered");
  assert.equal(result.ok, true);
});

test("runAgentTask stops at maxSteps without a done", async () => {
  const browser = fakeBrowser({ runs: Array(5).fill({ ok: true, result: "x", artifacts: [] }) });
  const model = scriptedModel(
    Array(5).fill({ text: "", toolCalls: [{ id: "c", name: "browser", input: { code: "1" } }] }),
  );
  const result = await runAgentTask({ task: "loop", model, browser, maxSteps: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "max-steps");
  assert.equal(result.steps, 3);
  assert.equal(browser.calls.run.length, 3);
});

test("login tool is offered only with a vault and runs fillCredential", async () => {
  const withVault = fakeBrowser({ vault: {} });
  const model = scriptedModel([
    { text: "", toolCalls: [{ id: "l1", name: "login", input: { passwordSelector: "#pw", username: "alice" } }] },
    { text: "", toolCalls: [{ id: "d1", name: "done", input: { answer: "in" } }] },
  ]);
  await runAgentTask({ task: "log in", model, browser: withVault });
  assert.equal(withVault.calls.fill.length, 1);
  assert.equal(withVault.calls.fill[0].passwordSelector, "#pw");
  // The tool list handed to the model included login.
  assert.ok(model.seen[0].tools.some((t) => t.name === "login"));

  const noVault = fakeBrowser({ vault: null });
  const model2 = scriptedModel([{ text: "no", toolCalls: [] }]);
  await runAgentTask({ task: "x", model: model2, browser: noVault });
  assert.ok(!model2.seen[0].tools.some((t) => t.name === "login"));
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

test("resolveModel maps names, passes objects through, rejects unknown", () => {
  const custom = { name: "mine", complete: async () => ({ text: "", toolCalls: [] }) };
  assert.equal(resolveModel(custom), custom);
  assert.equal(resolveModel("claude", {}).name, "claude");
  assert.throws(() => resolveModel("mistral-large"), /Unknown model/);
});

test("resolveModel accepts a bare model id and infers the backend from its prefix", () => {
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

  // An explicit --model-id wins over the id passed as the model.
  const pinned = resolveModel("gpt-5.6-luna", { apiKey: "k", model: "gpt-override" });
  assert.equal(pinned.modelId, "gpt-override");
});

test("openaiModel translates the transcript and parses tool calls", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
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
          usage: { prompt_tokens: 42, completion_tokens: 8 },
        };
      },
    };
  };
  const model = openaiModel({ baseURL: "https://api.example/v1/", model: "m1", apiKey: "k", fetchImpl });
  const out = await model.complete({
    system: "SYS",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok", toolCalls: [{ id: "a1", name: "browser", input: { code: "x" } }] },
      { role: "tool", results: [{ id: "a1", name: "browser", content: "obs" }] },
    ],
    tools: [{ name: "browser", description: "d", parameters: { type: "object" } }],
  });

  assert.equal(captured.url, "https://api.example/v1/chat/completions");
  assert.equal(captured.body.model, "m1");
  assert.equal(captured.body.messages[0].role, "system");
  assert.equal(captured.body.messages[0].content, "SYS");
  assert.equal(captured.body.messages[2].tool_calls[0].function.name, "browser");
  assert.equal(captured.body.messages[3].role, "tool");
  assert.equal(captured.body.tools[0].type, "function");
  assert.equal(out.text, "working");
  assert.equal(out.toolCalls[0].name, "browser");
  assert.deepEqual(out.toolCalls[0].input, { code: "return 1" });
  assert.equal(out.toolCalls[0].id, "call_1"); // synthesized
  // prompt_/completion_tokens are normalized to input/output.
  assert.deepEqual(out.usage, { inputTokens: 42, outputTokens: 8 });
});

test("openaiModel surfaces HTTP errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async text() { return "no auth"; } });
  const model = openaiModel({ baseURL: "https://x/v1", model: "m", apiKey: "k", fetchImpl });
  await assert.rejects(model.complete({ system: "s", messages: [], tools: [] }), /401.*no auth/s);
});

test("claudeModel maps to the Anthropic shape and parses content", async () => {
  let captured;
  const client = {
    messages: {
      async create(req) {
        captured = req;
        return {
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "t1", name: "done", input: { answer: "A" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 30, cache_read_input_tokens: 12, output_tokens: 5 },
        };
      },
    },
  };
  const model = claudeModel({ client, model: "claude-test" });
  const out = await model.complete({
    system: "SYS",
    messages: [
      { role: "user", text: "hi" },
      { role: "tool", results: [{ id: "x", name: "browser", content: "obs" }] },
    ],
    tools: [{ name: "done", description: "finish", parameters: { type: "object" } }],
  });

  assert.equal(captured.model, "claude-test");
  assert.equal(captured.system, "SYS");
  assert.equal(captured.tools[0].input_schema.type, "object");
  assert.equal(captured.messages[1].content[0].type, "tool_result");
  assert.equal(out.text, "sure");
  assert.equal(out.toolCalls[0].name, "done");
  assert.deepEqual(out.toolCalls[0].input, { answer: "A" });
  // Cached input tokens fold into the input total (30 + 12), output passes through.
  assert.deepEqual(out.usage, { inputTokens: 42, outputTokens: 5 });
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
    'data: {"type":"response.completed","response":{"status":"completed"}}',
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
