import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import type { CommandOptions, E2ECase, E2EContext } from "./types.js";

async function mcp(ctx: E2EContext, options: CommandOptions = {}) {
  const child = ctx.start(["mcp"], options);
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let stderr = "";
  let protocolFailure: Error | null = null;
  const fail = (error: Error) => {
    protocolFailure = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error(`MCP stdout contains non-JSON output: ${line.slice(0, 500)}`));
      return;
    }
    if (message.jsonrpc !== "2.0") {
      fail(new Error(`Invalid JSON-RPC response: ${line.slice(0, 500)}`));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message);
  });
  child.once("error", fail);
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      if (pending.size) fail(new Error(`MCP exited with ${code} before responding: ${stderr}`));
      lines.close();
      resolve(code);
    });
  });
  const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    if (protocolFailure) { reject(protocolFailure); return; }
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`MCP is no longer running: ${stderr}`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out: ${stderr}`));
    }, options.timeoutMs ?? 45_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method: string) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };
  const close = async () => {
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP did not exit after stdin EOF: ${stderr}`)), 15_000);
        }),
      ]);
      assert.equal(code, 0, stderr);
      if (protocolFailure) throw protocolFailure;
    } finally {
      clearTimeout(timer);
    }
  };
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "betterwright-binary-e2e", version: "1.0.0" },
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  notify("notifications/initialized");
  return { request, close, initialized: initialized.result };
}

function toolResult(reply: any) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.ok(Array.isArray(reply.result?.content), JSON.stringify(reply));
  return reply.result;
}

function envelope(reply: any) {
  const result = toolResult(reply);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const text = result.content.find((item: any) => item.type === "text")?.text;
  assert.ok(text, "MCP tool response did not include text content");
  return JSON.parse(text);
}

export const cases: E2ECase[] = [
  {
    id: "protocol-mcp-initialize-and-tools",
    group: "protocol",
    title: "MCP negotiates capabilities, lists public tools, and shuts down cleanly at EOF",
    async run(ctx) {
      const client = await mcp(ctx);
      assert.equal(client.initialized.serverInfo.name, "betterwright");
      assert.match(client.initialized.serverInfo.version, /^\d+\.\d+\.\d+/);
      assert.equal(client.initialized.protocolVersion, "2024-11-05");
      assert.ok(client.initialized.capabilities.tools);
      const reply = await client.request("tools/list");
      assert.equal(reply.error, undefined);
      const tools = reply.result.tools;
      const names = tools.map((tool: any) => tool.name);
      assert.equal(new Set(names).size, names.length);
      for (const name of ["browser", "browser_batch", "browser_download", "browser_record", "browser_handoff", "browser_doctor", "browser_login"]) {
        assert.ok(names.includes(name), `MCP did not advertise ${name}`);
      }
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.ok(tool.description.length > 10);
      }
      const doctor = envelope(await client.request("tools/call", { name: "browser_doctor", arguments: {} }));
      assert.equal(doctor.worker_ok, true);
      assert.equal(doctor.playwright_version, doctor.playwright_pinned);
      assert.ok([true, false].includes(doctor.ready));
      await client.close();
    },
  },
  {
    id: "protocol-mcp-invalid-requests",
    group: "protocol",
    title: "MCP returns JSON-RPC errors for unknown methods and invalid request parameters",
    async run(ctx) {
      const client = await mcp(ctx);
      const unknown = await client.request("e2e/unknown-method");
      assert.equal(unknown.error.code, -32601);
      assert.ok(unknown.error.message);
      const malformed = await client.request("tools/call", { name: 42 });
      assert.ok(Number.isInteger(malformed.error.code) && malformed.error.code < 0);
      assert.ok(malformed.error.message);
      assert.equal(malformed.result, undefined);
      const missing = await client.request("tools/call", {});
      assert.ok(Number.isInteger(missing.error.code) && missing.error.code < 0);
      assert.ok(missing.error.message);
      assert.equal(missing.result, undefined);
      const healthy = await client.request("tools/list");
      assert.ok(healthy.result.tools.length > 0);
      await client.close();
    },
  },
  {
    id: "protocol-mcp-invalid-tools",
    group: "protocol",
    title: "MCP tool validation rejects unknown tools and contradictory batch or recording arguments",
    async run(ctx) {
      const client = await mcp(ctx);
      const invalid = [
        { name: "missing-e2e-tool", arguments: {}, expected: /Unknown tool/ },
        { name: "browser_batch", arguments: {}, expected: /requires url/ },
        { name: "browser_batch", arguments: { discover: true, operations: [] }, expected: /either discovery or operations/ },
        { name: "browser_batch", arguments: { query: "Save", operations: [] }, expected: /query requires/ },
        { name: "browser_record", arguments: { action: "invalid" }, expected: /action must be/ },
        { name: "browser_record", arguments: { action: "stop", fps: 24 }, expected: /options apply only to start and restart/ },
      ];
      for (const item of invalid) {
        const result = toolResult(await client.request("tools/call", { name: item.name, arguments: item.arguments }));
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, item.expected);
      }
      await client.close();
    },
  },
  {
    id: "protocol-mcp-browser-roundtrip",
    group: "protocol",
    title: "MCP executes browser code against a local page and retains state across calls",
    requiresBrowser: true,
    async run(ctx) {
      const server = await ctx.serve((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>MCP local fixture</title><h1>Protocol page</h1><button>Read only</button>");
      });
      const client = await mcp(ctx);
      const opened = envelope(await client.request("tools/call", {
        name: "browser",
        arguments: { code: `await page.goto(${JSON.stringify(server.origin)}); state.counter = 40; return { title: await page.title(), count: state.counter };`, session: "mcp-roundtrip" },
      }));
      assert.equal(opened.ok, true);
      assert.deepEqual(opened.result, { title: "MCP local fixture", count: 40 });
      const next = envelope(await client.request("tools/call", {
        name: "browser",
        arguments: { code: "state.counter += 2; return { count: state.counter, title: await page.title() };", session: "mcp-roundtrip" },
      }));
      assert.equal(next.ok, true);
      assert.deepEqual(next.result, { count: 42, title: "MCP local fixture" });
      const discovery = envelope(await client.request("tools/call", {
        name: "browser_batch", arguments: { discover: true, session: "mcp-roundtrip" },
      }));
      assert.equal(discovery.ok, true);
      assert.match(JSON.stringify(discovery.result), /Read only/);
      await client.close();
    },
  },
  {
    id: "protocol-mcp-browser-failure-recovery",
    group: "protocol",
    title: "MCP carries browser failures in run envelopes and accepts the next tool call",
    requiresBrowser: true,
    async run(ctx) {
      const client = await mcp(ctx);
      const failed = envelope(await client.request("tools/call", {
        name: "browser", arguments: { code: 'throw new Error("mcp-runtime-failure-marker")', session: "mcp-errors" },
      }));
      assert.equal(failed.ok, false);
      assert.match(JSON.stringify(failed.error), /mcp-runtime-failure-marker/);
      const recovered = envelope(await client.request("tools/call", {
        name: "browser", arguments: { code: "return 42", session: "mcp-errors" },
      }));
      assert.equal(recovered.ok, true);
      assert.equal(recovered.result, 42);
      await client.close();
    },
  },
  {
    id: "protocol-mcp-download-deny",
    group: "protocol",
    title: "MCP denies browser_download even when tool arguments claim approval",
    async run(ctx) {
      const client = await mcp(ctx, { env: { BETTERWRIGHT_DOWNLOAD_POLICY: "deny" } });
      const result = toolResult(await client.request("tools/call", {
        name: "browser_download", arguments: { code: 'throw new Error("must-not-execute")', approved: true, approvedDownloads: true },
      }));
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
      assert.doesNotMatch(result.content[0].text, /must-not-execute/);
      await client.close();
    },
  },
  {
    id: "protocol-exec-local-model-roundtrip",
    group: "protocol",
    title: "Exec calls a local OpenAI-compatible mock, executes its browser tool, and returns the answer",
    requiresBrowser: true,
    async run(ctx) {
      const requests: any[] = [];
      let pageVisits = 0;
      const server = await ctx.serve(async (request, response) => {
        if (request.url === "/page") {
          pageVisits++;
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<!doctype html><title>Agent mock page</title><main>Local protocol evidence: 42</main>");
          return;
        }
        if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
          response.writeHead(404);
          response.end("Unexpected fixture route");
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const parsed = JSON.parse(body);
        requests.push(parsed);
        const message = requests.length === 1
          ? { role: "assistant", content: "Read the local page.", tool_calls: [{
            id: "e2e-browser-call", type: "function", function: {
              name: "browser",
              arguments: JSON.stringify({ code: `await page.goto(${JSON.stringify(`http://${request.headers.host}/page`)}); return { title: await page.title(), evidence: await page.locator("main").innerText() };` }),
            },
          }] }
          : { role: "assistant", content: "The local page reports 42." };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `e2e-completion-${requests.length}`, object: "chat.completion", model: "e2e-model",
          choices: [{ index: 0, message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
      const result = await ctx.json([
        "exec", "--stdin", "--model", "e2e-model", "--base-url", `${server.origin}/v1`,
        "--protocol", "chat", "--no-daemon", "--session", "mock-agent",
      ], { stdin: "Read the local fixture and report its numeric evidence.", timeoutMs: 90_000 });
      assert.equal(result.ok, true);
      assert.equal(result.answer, "The local page reports 42.");
      assert.equal(result.session, "mock-agent");
      assert.equal(result.reason, "answered");
      assert.equal(result.toolCalls, 1);
      assert.equal(result.steps, 2);
      assert.equal(requests.length, 2);
      assert.ok(pageVisits >= 1);
      assert.equal(requests[0].model, "e2e-model");
      assert.ok(requests[0].tools.some((tool: any) => tool.function.name === "browser"));
      assert.ok(requests[0].messages.some((message: any) => message.role === "user" && message.content.includes("numeric evidence")));
      const replay = requests[1].messages.find((message: any) => message.role === "tool" && message.tool_call_id === "e2e-browser-call");
      assert.ok(replay, "The browser tool result was not sent back to the model");
      assert.match(replay.content, /Agent mock page/);
      assert.match(replay.content, /Local protocol evidence: 42/);
    },
  },
  {
    id: "protocol-exec-local-model-failures",
    group: "protocol",
    title: "Exec reports HTTP and non-JSON model failures from a local endpoint without claiming success",
    async run(ctx) {
      const requests: string[] = [];
      const server = await ctx.serve((request, response) => {
        requests.push(request.url || "");
        request.resume();
        if (request.url === "/http/chat/completions") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "e2e-unauthorized-marker" }));
        } else {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<html>not a model response</html>");
        }
      });
      for (const route of ["http", "non-json"]) {
        const result = await ctx.command([
          "exec", "Report fixture evidence", "--model", "e2e-model", "--base-url", `${server.origin}/${route}`,
          "--protocol", "chat", "--no-daemon", "--session", `model-failure-${route}`,
        ]);
        assert.equal(result.code, 1, result.stdout || result.stderr);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.match(output, route === "http" ? /401|e2e-unauthorized-marker/ : /non-JSON chat response/);
        if (result.stdout.trim()) assert.equal(JSON.parse(result.stdout).ok, false);
      }
      assert.ok(requests.includes("/http/chat/completions"));
      assert.ok(requests.includes("/non-json/chat/completions"));
    },
  },
];
