import assert from "node:assert/strict";
import test from "node:test";
import { endpointModel, listEndpointModels, resolveModel, resolveModelSelection, runAgentTask } from "../../dist/src/agent.js";
import { modelReadiness, modelSetupHint, preferredModelId } from "../../dist/src/doctor.js";

const tool = { name: "browser", description: "Read a page", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const call = { id: "cerebras-call-1", name: "browser", input: { code: "return page.title()" } };
const image = { mimeType: "image/png", data: "c3ludGhldGlj" };
function completion(content = "done") { return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] }); }

test("Cerebras selects its endpoint and auth without changing opaque model IDs", async () => {
  assert.throws(() => endpointModel({ source: "cerebras", model: "qwen-3.8-27b", apiKey: "" }), /Cerebras needs an API key.*CEREBRAS_API_KEY/);
  assert.throws(() => endpointModel({ source: "cerebras", model: "qwen-3.8-27b", apiKey: "test", protocol: "responses" }), /Cerebras uses Chat Completions/);
  assert.throws(() => endpointModel({ source: "cerebras", model: "qwen-3.8-27b", apiKey: "test", baseURL: "http://remote.example/v1" }), /Refusing to send.*plain HTTP/);
  let calls = 0;
  const model = resolveModel("CeReBrAs/qwen-3.8-27b", { apiKey: "cerebras-test", effort: "low", fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.cerebras.ai/v1/chat/completions"); assert.equal(init.headers.authorization, "Bearer cerebras-test");
    assert.equal(init.headers["HTTP-Referer"], undefined); assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "qwen-3.8-27b"); assert.equal(body.max_completion_tokens, 4096); assert.equal(body.max_tokens, undefined);
    assert.equal(body.reasoning_effort, "low"); assert.equal(body.parallel_tool_calls, undefined); assert.equal(body.response_format, undefined);
    assert.equal(body.tools[0].function.name, "browser"); assert.equal(body.tool_choice, "auto");
    return completion();
  } });
  assert.equal(model.name, "cerebras");
  await model.complete({ system: "SYS", messages: [{ role: "user", text: "Read" }], tools: [tool] });
  assert.equal(calls, 1);
});

test("Cerebras catalog uses public listing without auth and preserves custom endpoint routes", async () => {
  for (const [apiKey, baseURL, expected] of [
    ["", undefined, "https://api.cerebras.ai/public/v1/models"],
    ["test-key", undefined, "https://api.cerebras.ai/v1/models"],
    ["", "https://cerebras.example/v1", "https://cerebras.example/v1/models"],
  ]) {
    const result = await listEndpointModels({ source: "cerebras", apiKey, baseURL, fetchImpl: async (url, init) => {
      assert.equal(url, expected); assert.equal(init.headers.authorization, apiKey ? `Bearer ${apiKey}` : undefined);
      return Response.json({ data: [{ id: "qwen-3.8-27b" }, { id: "gpt-oss-120b" }] });
    } });
    assert.deepEqual(result.models, ["qwen-3.8-27b", "gpt-oss-120b"]);
  }
});

test("Cerebras preserves reasoning and sends screenshots after all tool replies", async () => {
  const second = { ...call, id: "cerebras-call-2" };
  const model = endpointModel({ source: "cerebras", model: "qwen-3.8-27b", apiKey: "test", fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages.map(m => m.role), ["system", "user", "assistant", "tool", "tool", "user"]);
    assert.equal(body.messages[2].reasoning, "I should read the page first.");
    assert.equal(body.messages[3].content, "First observation"); assert.equal(body.messages[4].content, "Second observation");
    assert.equal(body.messages[3].tool_call_id, call.id); assert.equal(body.messages[4].tool_call_id, second.id);
    assert.deepEqual(body.messages[5].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } });
    return Response.json({ choices: [{ message: { content: "Observed", reasoning: "The evidence matches." }, finish_reason: "stop" }] });
  } });
  const result = await model.complete({ system: "SYS", tools: [tool], messages: [
    { role: "user", text: "Read" }, { role: "assistant", text: "", toolCalls: [call, second], reasoning: "I should read the page first." },
    { role: "tool", results: [{ id: call.id, name: call.name, content: "First observation", images: [image] }, { id: second.id, name: second.name, content: "Second observation" }] },
  ] });
  assert.equal(result.text, "Observed"); assert.equal(result.reasoning, "The evidence matches.");
});

test("Cerebras GPT OSS receives DOM observations without unsupported images", async () => {
  const model = endpointModel({ source: "cerebras", model: "gpt-oss-120b", apiKey: "test", fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.messages[2].content, "DOM result");
    assert.match(body.messages[3].content, /does not support vision/);
    assert.ok(!JSON.stringify(body).includes("data:image"));
    return completion();
  } });
  await model.complete({ system: "SYS", tools: [], messages: [
    { role: "assistant", text: "", toolCalls: [call] }, { role: "tool", results: [{ id: call.id, name: call.name, content: "DOM result", images: [image] }] },
  ] });
});

test("Cerebras drives the harness tool loop and retains reasoning across turns", async () => {
  let requests = 0, browserCalls = 0;
  const model = endpointModel({ source: "cerebras", model: "qwen-3.8-27b", apiKey: "test", fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (++requests === 1) return Response.json({ choices: [{ message: { content: null, reasoning: "Read the title.", tool_calls: [
      { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } },
    ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    assert.equal(body.messages.find(m => m.role === "assistant").reasoning, "Read the title.");
    assert.match(body.messages.find(m => m.role === "tool").content, /Synthetic title/);
    return completion("Synthetic title");
  } });
  const browser = { vault: null, async run() { browserCalls++; return { ok: true, result: "Synthetic title", artifacts: [] }; }, async close() {} };
  const result = await runAgentTask({ model, browser, task: "Read the page title", liveView: false });
  assert.equal(result.ok, true); assert.equal(result.answer, "Synthetic title"); assert.equal(browserCalls, 1); assert.equal(requests, 2);
  assert.equal(result.transcript.find(m => m.role === "assistant").reasoning, "Read the title.");
});

test("Cerebras-only configuration supplies a qualified default and discovery uses its key", async () => {
  const auth = { codex: false, grok: false }, env = { CEREBRAS_API_KEY: "test" };
  assert.ok(modelReadiness({ env, auth }).sources.includes("cerebras (CEREBRAS_API_KEY)"));
  assert.equal(preferredModelId({ env, auth }).model, "cerebras/qwen-3.8-27b");
  assert.equal(modelSetupHint({ env, auth }), null);
  assert.equal(preferredModelId({ env: { ...env, BETTERWRIGHT_CEREBRAS_MODEL: "gpt-oss-120b" }, auth }).model, "cerebras/gpt-oss-120b");
  const saved = process.env.CEREBRAS_API_KEY;
  try {
    process.env.CEREBRAS_API_KEY = "test";
    const model = await resolveModelSelection("qwen-3.8-27b", { fetchImpl: async url => Response.json({ data: String(url).includes("api.cerebras.ai") ? [{ id: "qwen-3.8-27b" }] : [] }) });
    assert.equal(model.name, "cerebras"); assert.equal(model.modelId, "qwen-3.8-27b");
  } finally { if (saved === undefined) delete process.env.CEREBRAS_API_KEY; else process.env.CEREBRAS_API_KEY = saved; }
});
