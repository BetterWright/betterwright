import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  invokeWebMCPTool,
  listWebMCPTools,
  WEBMCP_FEATURE_SWITCH,
} from "../../dist/src/webmcp.js";

class FakeCDP extends EventEmitter {
  calls: Array<{ method: string; params?: any }> = [];
  detached = false;
  handlers: Record<string, (session: FakeCDP, params?: any) => any>;

  constructor(handlers: Record<string, (session: FakeCDP, params?: any) => any> = {}) {
    super();
    this.handlers = handlers;
  }

  async send(method, params?) {
    this.calls.push(params === undefined ? { method } : { method, params });
    return this.handlers[method]?.(this, params) ?? {};
  }

  async detach() {
    this.detached = true;
  }
}

const page = {};
const deps = (session) => ({ newCDPSession: async () => session });

function registeredTool(overrides: any = {}) {
  return {
    name: "search",
    description: "Search the current site",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    annotations: {
      readOnly: true,
      untrustedContent: true,
      autosubmit: false,
    },
    frameId: "frame-main",
    backendNodeId: 42,
    stackTrace: { callFrames: [{ url: "https://example.test/app.js" }] },
    ...overrides,
  };
}

test("WebMCP discovery returns a fresh, bounded public descriptor", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      cdp.emit("WebMCP.toolsAdded", {
        tools: [registeredTool(), registeredTool({ name: "removed" })],
      });
      cdp.emit("WebMCP.toolsRemoved", {
        tools: [{ name: "removed", frameId: "frame-main" }],
      });
    },
  });

  const tools = await listWebMCPTools(page, { ...deps(session), timeout: 1 });
  assert.deepEqual(tools, [
    {
      name: "search",
      description: "Search the current site",
      trust: "untrusted_external_data",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      annotations: {
        readOnly: true,
        untrustedContent: true,
        autosubmit: false,
      },
      frameId: "frame-main",
      backendNodeId: 42,
    },
  ]);
  assert.equal(session.listenerCount("WebMCP.toolsAdded"), 0);
  assert.equal(session.listenerCount("WebMCP.toolsRemoved"), 0);
  assert.equal(session.detached, true);
});

test("WebMCP discovery observes delayed registration for the full requested window", async () => {
  let delayed;
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      delayed = setTimeout(() => {
        cdp.emit("WebMCP.toolsAdded", { tools: [registeredTool()] });
      }, 15);
    },
  });

  try {
    const tools = await listWebMCPTools(page, { ...deps(session), timeout: 30 });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "search");
    assert.equal(session.detached, true);
  } finally {
    clearTimeout(delayed);
  }
});

test("WebMCP invocation discovers, disambiguates, invokes, and labels page output", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      cdp.emit("WebMCP.toolsAdded", { tools: [registeredTool()] });
    },
    "WebMCP.invokeTool": (cdp, params) => {
      queueMicrotask(() => {
        cdp.emit("WebMCP.toolResponded", {
          invocationId: "invocation-1",
          status: "Completed",
          output: { query: params.input.query, results: 3 },
        });
      });
      return { invocationId: "invocation-1" };
    },
  });

  const result = await invokeWebMCPTool(
    page,
    "search",
    { query: "BetterWright" },
    { discoveryTimeout: 1, timeout: 100 },
    deps(session),
  );
  assert.deepEqual(result, {
    tool: {
      name: "search",
      description: "Search the current site",
      trust: "untrusted_external_data",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      annotations: {
        readOnly: true,
        untrustedContent: true,
        autosubmit: false,
      },
      frameId: "frame-main",
      backendNodeId: 42,
    },
    invocationId: "invocation-1",
    status: "Completed",
    output: { query: "BetterWright", results: 3 },
    trust: "untrusted_external_data",
  });
  assert.deepEqual(
    session.calls.find((call) => call.method === "WebMCP.invokeTool"),
    {
      method: "WebMCP.invokeTool",
      params: {
        frameId: "frame-main",
        toolName: "search",
        input: { query: "BetterWright" },
      },
    },
  );
  assert.equal(session.listenerCount("WebMCP.toolResponded"), 0);
  assert.equal(session.detached, true);
});

test("WebMCP autosubmit tools require a deliberate per-call opt-in", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      cdp.emit("WebMCP.toolsAdded", {
        tools: [registeredTool({ annotations: { autosubmit: true } })],
      });
    },
  });

  await assert.rejects(
    invokeWebMCPTool(
      page,
      "search",
      {},
      { discoveryTimeout: 1 },
      deps(session),
    ),
    /allowAutosubmit:true/,
  );
  assert.equal(
    session.calls.some((call) => call.method === "WebMCP.invokeTool"),
    false,
  );
});

test("same-named frame tools fail closed until the caller supplies frameId", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      cdp.emit("WebMCP.toolsAdded", {
        tools: [
          registeredTool(),
          registeredTool({ frameId: "frame-child" }),
        ],
      });
    },
  });

  await assert.rejects(
    invokeWebMCPTool(
      page,
      "search",
      {},
      { discoveryTimeout: 1 },
      deps(session),
    ),
    /multiple frames.*frameId/,
  );
});

test("a timed-out invocation is canceled before its CDP session is detached", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": (cdp) => {
      cdp.emit("WebMCP.toolsAdded", { tools: [registeredTool()] });
    },
    "WebMCP.invokeTool": () => ({ invocationId: "invocation-slow" }),
  });

  await assert.rejects(
    invokeWebMCPTool(
      page,
      "search",
      {},
      { discoveryTimeout: 1, timeout: 1 },
      deps(session),
    ),
    /timed out after 1ms/,
  );
  const canceled = session.calls.find(
    (call) => call.method === "WebMCP.cancelInvocation",
  );
  assert.deepEqual(canceled, {
    method: "WebMCP.cancelInvocation",
    params: { invocationId: "invocation-slow" },
  });
  assert.equal(session.detached, true);
});

test("WebMCP rejects non-object inputs and explains unsupported attached browsers", async () => {
  const session = new FakeCDP({
    "WebMCP.enable": () => {
      throw new Error("Protocol error (WebMCP.enable): Method not found");
    },
  });
  await assert.rejects(
    listWebMCPTools(page, { ...deps(session), timeout: 1 }),
    new RegExp(WEBMCP_FEATURE_SWITCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  await assert.rejects(
    invokeWebMCPTool(page, "search", ["not", "an", "object"], {}, deps(new FakeCDP())),
    /input must be a JSON object/,
  );
});
