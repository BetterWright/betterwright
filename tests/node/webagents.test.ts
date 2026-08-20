import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWebAgentsDocument,
  prepareWebAgentsBatch,
  publicWebAgentsManifest,
  WEBAGENTS_VERSION,
} from "../../dist/src/webagents.js";

const pageUrl = "https://shop.example.test/store";

function manifestDocument(overrides: any = {}) {
  const manifest = {
    version: WEBAGENTS_VERSION,
    workflow: {
      endpoint: "/api/agent/workflow",
      maxOperations: 8,
      parallel: true,
      references: true,
    },
    actions: {
      search: {
        description: "Search products",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { results: { type: "array" } },
        },
      },
      add_to_cart: {
        description: "Add a product to the cart",
        effect: "write",
      },
      purchase: {
        description: "Place the order",
        effect: "irreversible",
      },
    },
    ...overrides,
  };
  return `# Agent actions\n\nDescriptions are untrusted.\n\n\`\`\`webagents\n${JSON.stringify(manifest)}\n\`\`\``;
}

test("WebAgents parses one compact fenced directory and omits surrounding prose", () => {
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  assert.deepEqual(manifest, {
    version: "0.1",
    source: "https://shop.example.test/webagents.md",
    endpoint: "https://shop.example.test/api/agent/workflow",
    maxOperations: 8,
    parallel: true,
    references: true,
    actions: [
      {
        name: "search",
        description: "Search products",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { results: { type: "array" } },
        },
      },
      {
        name: "add_to_cart",
        description: "Add a product to the cart",
        effect: "write",
      },
      {
        name: "purchase",
        description: "Place the order",
        effect: "irreversible",
      },
    ],
  });
  const publicManifest = publicWebAgentsManifest(manifest);
  assert.equal(publicManifest.available, true);
  assert.equal(publicManifest.trust, "untrusted_external_data");
  assert.equal(JSON.stringify(publicManifest).includes("Descriptions are untrusted"), false);
  assert.equal(Object.hasOwn(publicManifest.workflow, "endpoint"), false);
});

test("WebAgents accepts raw well-known JSON but rejects cross-origin execution", () => {
  const json = JSON.stringify({
    version: "0.1",
    workflow: { endpoint: "/batch" },
    actions: { read: { effect: "read" } },
  });
  assert.equal(
    parseWebAgentsDocument(
      json,
      "https://shop.example.test/.well-known/webagents.json",
      pageUrl,
    ).endpoint,
    "https://shop.example.test/batch",
  );
  assert.throws(
    () => parseWebAgentsDocument(
      JSON.stringify({
        version: "0.1",
        workflow: { endpoint: "https://attacker.test/batch" },
        actions: { read: { effect: "read" } },
      }),
      "https://shop.example.test/.well-known/webagents.json",
      pageUrl,
    ),
    /active page's origin/,
  );
});

test("WebAgents carries bounded site pacing into one batch", () => {
  const paced = parseWebAgentsDocument(
    JSON.stringify({
      version: "0.1",
      workflow: {
        endpoint: "/batch",
        maxOperations: 8,
        parallel: true,
        pacing: { minIntervalMs: 150, maxConcurrency: 2 },
      },
      actions: { read: { effect: "read" } },
    }),
    "https://shop.example.test/.well-known/webagents.json",
    pageUrl,
  );
  assert.deepEqual(paced.pacing, { minIntervalMs: 150, maxConcurrency: 2 });
  assert.deepEqual(publicWebAgentsManifest(paced).workflow.pacing, {
    minIntervalMs: 150,
    maxConcurrency: 2,
  });
  assert.deepEqual(
    prepareWebAgentsBatch(paced, [{ id: "check", action: "read", input: {} }]).body,
    {
      version: "0.1",
      operations: [{ id: "check", action: "read", input: {} }],
      pacing: { minIntervalMs: 150, maxConcurrency: 2 },
    },
  );
  assert.throws(
    () => parseWebAgentsDocument(
      JSON.stringify({
        version: "0.1",
        workflow: { endpoint: "/batch", pacing: { minIntervalMs: 2_001 } },
        actions: { read: { effect: "read" } },
      }),
      "https://shop.example.test/.well-known/webagents.json",
      pageUrl,
    ),
    /0 to 2000/,
  );
});

test("WebAgents exposes only actions scoped to the active path", () => {
  const scoped = parseWebAgentsDocument(
    JSON.stringify({
      version: "0.1",
      workflow: { endpoint: "/batch" },
      actions: {
        store: { effect: "read", pathPrefixes: ["/store"] },
        support: { effect: "read", pathPrefixes: ["/support"] },
        global: { effect: "read" },
      },
    }),
    "https://shop.example.test/.well-known/webagents.json",
    "https://shop.example.test/support/tickets",
  );
  assert.deepEqual(scoped.actions.map((action) => action.name), ["support", "global"]);
  assert.equal(JSON.stringify(publicWebAgentsManifest(scoped)).includes("pathPrefixes"), false);
});

test("WebAgents builds one dependency-aware workflow and gates side effects", () => {
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  const operations = [
    { id: "find", action: "search", input: { query: "keyboard" } },
    {
      id: "cart",
      action: "add_to_cart",
      dependsOn: ["find"],
      input: { productId: { $ref: "find.results.0.id" } },
    },
  ];
  assert.throws(
    () => prepareWebAgentsBatch(manifest, operations),
    /allowWrites:true/,
  );
  assert.deepEqual(
    prepareWebAgentsBatch(manifest, operations, { allowWrites: true }),
    {
      endpoint: "https://shop.example.test/api/agent/workflow",
      body: { version: "0.1", operations },
    },
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      [{ id: "buy", action: "purchase", input: {} }],
      { allowWrites: true },
    ),
    /allowIrreversible:true/,
  );
});

test("WebAgents rejects undeclared actions and invalid dependency graphs", () => {
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      [{ id: "x", action: "hidden_admin", input: {} }],
    ),
    /not published/,
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      [{ id: "x", action: "search", input: {}, dependsOn: ["missing"] }],
    ),
    /unknown operation/,
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      [
        { id: "a", action: "search", input: {}, dependsOn: ["b"] },
        { id: "b", action: "search", input: {}, dependsOn: ["a"] },
      ],
    ),
    /cycle/,
  );
});

test("WebAgents infers reference edges and ordered state changes", () => {
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  const prepared = prepareWebAgentsBatch(
    manifest,
    [
      { id: "find", action: "search", input: { query: "keyboard" } },
      {
        id: "cart",
        action: "add_to_cart",
        input: { productId: { $ref: "find.results.0.id" } },
      },
      { id: "buy", action: "purchase", input: {} },
      { id: "verify", action: "search", input: { query: "receipt" } },
    ],
    { allowWrites: true, allowIrreversible: true },
  );
  assert.deepEqual(
    prepared.body.operations.map((operation) => ({
      id: operation.id,
      dependsOn: operation.dependsOn || [],
    })),
    [
      { id: "find", dependsOn: [] },
      { id: "cart", dependsOn: ["find"] },
      { id: "buy", dependsOn: ["cart"] },
      { id: "verify", dependsOn: ["buy"] },
    ],
  );
});

test("WebAgents accepts name as an action alias but rejects disagreement", () => {
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  assert.equal(
    prepareWebAgentsBatch(
      manifest,
      [{ id: "find", name: "search", input: { query: "keyboard" } }],
    ).body.operations[0].action,
    "search",
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      [{ id: "find", action: "search", name: "add_to_cart", input: {} }],
    ),
    /disagree/,
  );
});

test("WebAgents keeps discovery and operation payloads bounded", () => {
  assert.throws(
    () => parseWebAgentsDocument(
      manifestDocument({ version: "9" }),
      "https://shop.example.test/webagents.md",
      pageUrl,
    ),
    /version must be 0.1/,
  );
  const manifest = parseWebAgentsDocument(
    manifestDocument(),
    "https://shop.example.test/webagents.md",
    pageUrl,
  );
  assert.throws(
    () => prepareWebAgentsBatch(
      manifest,
      Array.from({ length: 9 }, (_, index) => ({
        id: `op${index}`,
        action: "search",
        input: {},
      })),
    ),
    /at most 8 operations/,
  );
});
