import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { AGENT_BATCH_ACTIONS, MAX_AGENT_BATCH_STEPS } from "../../dist/src/agent-batch.js";
import { BetterWright } from "../../dist/src/client.js";
import {
  _createMcpHandlersForTest,
  contentForResult,
  downloadPolicyFromEnv,
  headlessFromEnv,
  LOGIN_INPUT_SCHEMA,
  liveViewFromEnv,
  loginOptionsFromArgs,
  policyFromEnv,
  timeoutFromEnv,
} from "../../dist/src/mcp-server.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("MCP omits and rejects browser_login when the vault is disabled", async () => {
  let fillCalls = 0;
  const browser = new BetterWright({ vault: false });
  browser.fillCredential = async () => {
    fillCalls += 1;
    return { ok: true };
  };
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
  });
  try {
    const listed = await handlers.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["browser_batch", "browser", "browser_download", "browser_handoff", "browser_doctor"],
    );

    const response = await handlers.callTool({
      params: { name: "browser_login", arguments: { username: "alice" } },
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Unknown tool: browser_login/);
    assert.equal(fillCalls, 0);
  } finally {
    await browser.close();
  }
});

test("MCP advertises and dispatches browser_login when a vault is available", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: {},
      async fillCredential(options) {
        calls.push(options);
        return { ok: true, result: { filled: true } };
      },
    },
    server: {},
    downloadPolicy: "deny",
  });

  const listed = await handlers.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "browser_login"));

  const response = await handlers.callTool({
    params: { name: "browser_login", arguments: { username: "alice", submit: true } },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [
    { session: "default", generate: false, username: "alice", submit: true },
  ]);
  assert.equal(JSON.parse(response.content[0].text).result.filled, true);
});

test("loginOptionsFromArgs keeps recognized keys and drops the rest", () => {
  assert.deepEqual(
    loginOptionsFromArgs({
      passwordSelector: "#pw",
      currentPasswordSelector: "#old-pw",
      usernameSelector: "#user",
      confirmPasswordSelector: "#confirm-pw",
      submitSelector: "#go",
      id: "rec-1",
      generate: true,
      submit: true,
      length: "18",
      includeSymbols: false,
      matchMode: "exact-origin",
      code: "danger()",
      note: "ignored",
    }),
    {
      session: "default",
      passwordSelector: "#pw",
      currentPasswordSelector: "#old-pw",
      generate: true,
      usernameSelector: "#user",
      confirmPasswordSelector: "#confirm-pw",
      submitSelector: "#go",
      id: "rec-1",
      length: 18,
      includeSymbols: false,
      matchMode: "exact-origin",
      submit: true,
    },
  );
  // Defaults: session "default", generate false, no stray keys.
  assert.deepEqual(loginOptionsFromArgs({}), {
    session: "default",
    generate: false,
  });
  assert.deepEqual(loginOptionsFromArgs({ session: "work", submit: false }), {
    session: "work",
    generate: false,
    submit: false,
  });
  assert.deepEqual(LOGIN_INPUT_SCHEMA.properties.matchMode.enum, [
    "base-domain",
    "host",
    "exact-origin",
    "never",
  ]);
  assert.equal(
    LOGIN_INPUT_SCHEMA.properties.currentPasswordSelector.type,
    "string",
  );
  assert.throws(
    () => loginOptionsFromArgs({ generate: true, matchMode: "same-site" }),
    /matchMode.*exact-origin/,
  );
});

test("MCP browser_batch runs an AgentBatch in one worker round trip", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: { protocol: "agent-batch/1", ok: true, completed: 3, total: 3 } };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: {
        session: "form",
        note: "Submitting and verifying the form.",
        allowWrites: true,
        allowPasswords: true,
        proof: true,
        steps: [
          { id: "name", action: "fill", target: { label: "Name" }, value: "Ada\u2028Lovelace" },
          { id: "submit", action: "click", target: { role: "button", name: "Submit" } },
          { id: "verify", action: "read", target: { text: "Received!", exact: true }, expect: "Received!" },
        ],
      },
    },
  });

  assert.equal(response.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, "form");
  assert.equal(calls[0].options.note, "Submitting and verifying the form.");
  // Three steps fit inside the server's 120 s floor; the budget still rides
  // on the run so a long batch is never cut off by the per-call default.
  assert.equal(calls[0].options.timeout, 120);
  assert.match(calls[0].code, /^return agentBatch\(\[/);
  assert.match(calls[0].code, /"allowWrites":true/);
  assert.match(calls[0].code, /"allowPasswords":true/);
  assert.match(calls[0].code, /"proof":true/);
  // The snippet is JavaScript source: line separators must stay escaped.
  assert.match(calls[0].code, /\\u2028/);
  assert.doesNotMatch(calls[0].code, /session|note/);
  assert.equal(JSON.parse(response.content[0].text).result.protocol, "agent-batch/1");
});

test("MCP browser_batch sizes the run timeout to the batch above the server floor", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      defaultTimeout: 20,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: { protocol: "agent-batch/1", ok: true } };
      },
    },
    downloadPolicy: "deny",
  });
  const long = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: { steps: Array.from({ length: 30 }, () => ({ action: "reload" })) },
    },
  });
  assert.equal(long.isError, undefined);
  // 15 s plus 10 s per step, well above the 20 s configured floor.
  assert.equal(calls[0].options.timeout, 315);

  const spec = await handlers.callTool({
    params: { name: "browser_batch", arguments: { url: "https://example.com/" } },
  });
  assert.equal(spec.isError, undefined);
  // One step: the floor is the deployer's configured per-call timeout.
  assert.equal(calls[1].options.timeout, 25);
});

test("MCP browser_batch refuses a malformed batch before the worker round trip", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code) {
        calls.push(code);
        return { ok: true, result: { protocol: "agent-batch/1", ok: true } };
      },
    },
    downloadPolicy: "deny",
  });
  const attempt = (args) => handlers.callTool({ params: { name: "browser_batch", arguments: args } });

  const unauthorized = await attempt({
    steps: [{ id: "submit", action: "click", target: { role: "button", name: "Submit" } }],
  });
  assert.equal(unauthorized.isError, true);
  assert.match(unauthorized.content[0].text, /step "submit" \(click\) changes page state; pass allowWrites:true/);

  const unknownAction = await attempt({ steps: [{ action: "teleport" }] });
  assert.equal(unknownAction.isError, true);
  assert.match(unknownAction.content[0].text, /unsupported action "teleport"/);

  const both = await attempt({ url: "https://example.com/", steps: [{ action: "reload" }] });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /either url or steps/);

  const neither = await attempt({ note: "nothing to do" });
  assert.equal(neither.isError, true);
  assert.match(neither.content[0].text, /requires url or a non-empty steps array/);

  assert.equal(calls.length, 0);
});

test("MCP browser_batch opens a URL as the spec call, without model-authored inspection", async () => {
  const calls = [];
  const handlers = _createMcpHandlersForTest({
    browser: {
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return {
          ok: true,
          result: {
            protocol: "agent-batch/1",
            ok: true,
            snapshot: 'page page-1 https://example.com/form "Form"\n- textbox "Name" [ref=e1]',
          },
        };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser_batch",
      arguments: { url: "https://example.com/form", session: "open" },
    },
  });

  assert.equal(response.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, "open");
  assert.equal(
    calls[0].code,
    'return agentBatch([{"action":"goto","url":"https://example.com/form"}], {});',
  );
  assert.match(JSON.parse(response.content[0].text).result.snapshot, /\[ref=e1\]/);
});

// The MCP tool list is re-sent on every request, so its size is permanent
// context overhead for every user of the server. This pins both halves of the
// bargain struck when descriptions were compressed on 2026-07-25 and again
// the budget stops prose creeping back, and directive assertions stop a future
// pass from buying room by dropping a rule instead of a redundant word.
test("the advertised MCP tool list stays inside its context budget", async () => {
  const handlers = _createMcpHandlersForTest({
    browser: { vault: {} },
    server: {},
    downloadPolicy: "ask",
  });
  const { tools } = await handlers.listTools();

  // Collapse runs of whitespace: line wrapping is nearly free in characters but
  // costs a token per line, so raw length would understate a rewrap regression.
  // Raised from 7,250 on 2026-09-03 when browser_batch became AgentBatch: its
  // step schema names every action and field the executor accepts, which is
  // what lets a model finish a task in one call instead of one per click.
  const size = JSON.stringify(tools).replace(/\s+/g, " ").length;
  assert.ok(size < 9_250, `MCP tool list grew to ${size} collapsed characters`);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const text = (name) => byName[name].description.replace(/\s+/g, " ");

  // Reading and acting: the ref protocol is unusable if any of these literals
  // is paraphrased away.
  for (const literal of [
    "Default to browser_batch",
    "Never add sleeps",
    "snapshot({interactive: true})",
    "page.locator('aria-ref=eN')",
    "snapshot({diff: true})",
    "screenshot({kind: 'proof'})",
  ]) {
    assert.ok(text("browser").includes(literal), `browser lost ${literal}`);
  }
  assert.match(text("browser"), /article\/reference pages read a scoped DOM region directly/);
  assert.match(text("browser"), /inside the final verifying call/);
  assert.match(text("browser"), /Host cleanup is automatic/);
  assert.match(text("browser"), /closePage\(idOrIndex\?\)/);
  assert.match(text("browser"), /page\.on\('console'\|'pageerror', fn\)/);
  assert.match(text("browser"), /Restricted wrappers omit page\.route\/context\.route/);
  assert.match(text("browser"), /worker policy routing stays private/);
  assert.match(text("browser"), /addInitScript before goto/);
  assert.match(text("browser"), /setContent/);
  assert.match(text("browser"), /host fixture/);
  // Challenge limits are safety rules, not advice.
  assert.match(text("browser"), /three distinct challenge types/);
  assert.match(text("browser"), /Replacement photo grids are the same stage/);
  assert.match(text("browser"), /Never duplicate a submission, purchase, or message/);
  assert.match(text("browser"), /webagents\.discover\(\)/);
  assert.match(text("browser"), /webagents\.batch\(\)/);
  assert.match(text("browser"), /allowWrites:true/);
  assert.match(text("browser"), /webmcp\.tools\(\)\/webmcp\.invoke\(\)/);
  assert.match(text("browser"), /autosubmit requires explicit opt-in/);
  assert.match(text("browser"), /what steps cannot express/);
  // AgentBatch is the default: the two-call protocol, the resume rule, the
  // target vocabulary, and every authorization gate must survive edits.
  assert.match(text("browser_batch"), /the default way to browse\. Finish in the fewest calls/);
  assert.match(text("browser_batch"), /send every step in ONE call/);
  assert.match(text("browser_batch"), /set answer \(the final answer, with \{stepId\} or \{stepId\.field\} filled from step results, e\.g\. answer: "Price: \{price\}"\)/);
  assert.match(text("browser_batch"), /Use \{url\} alone only when the page is unknown/);
  assert.match(text("browser_batch"), /resume from failed\.index, never repeat a completed step/);
  assert.match(text("browser"), /Finish in the fewest calls/);
  assert.match(text("browser_batch"), /role \(\+ name\), label, text, placeholder, testId, css; ambiguity fails/);
  assert.match(text("browser_batch"), /read \{expect\} or wait \{text\|url\}/);
  assert.match(text("browser_batch"), /irreversible:true steps need allowIrreversible/);
  assert.match(text("browser_batch"), /task-supplied password needs allowPasswords, stored ones use browser_login/);
  assert.match(text("browser_batch"), /optional:true steps may fail without stopping/);
  const batchSchema = byName.browser_batch.inputSchema.properties;
  assert.deepEqual(batchSchema.steps.items.properties.action.enum, [...AGENT_BATCH_ACTIONS]);
  assert.deepEqual(batchSchema.steps.items.required, ["action"]);
  assert.equal(batchSchema.steps.maxItems, MAX_AGENT_BATCH_STEPS);
  assert.equal(batchSchema.url.type, "string");
  assert.match(batchSchema.answer.description, /\{stepId\}/);
  assert.equal(batchSchema.session.default, "default");
  assert.equal(batchSchema.allowWrites.default, false);

  // Downloads are gated to this tool; deny must stay discoverable.
  assert.match(text("browser_download"), /the browser tool cannot/);
  assert.match(text("browser_download"), /Autonomous by default/);
  assert.match(text("browser_download"), /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);

  // The whole point of browser_login is that the secret stays out of the
  // transcript, and that a generated password is not saved until verified.
  assert.match(text("browser_login"), /never enters the conversation/);
  assert.match(text("browser_login"), /\[redacted\]/);
  assert.match(text("browser_login"), /credentials\.commitGenerated\(\{pendingId\}\)/);
  assert.match(text("browser_login"), /credentials\.discardGenerated\(\{pendingId\}\)/);
  assert.match(text("browser_login"), /Typing passwords in browser code is blocked/);

  // The live-view URL is a bearer capability, and agents have historically
  // claimed a view was running without ever starting one.
  assert.match(text("browser_handoff"), /VERBATIM/);
  assert.match(text("browser_handoff"), /never log or share it/);
  assert.match(text("browser_handoff"), /never claim a live view is running without this tool's URL/i);
  assert.match(text("browser_handoff"), /userChat/);

  // Selector fields went bare to save room; this one cannot be inferred from
  // its name, so it keeps its description.
  assert.match(
    byName.browser_login.inputSchema.properties.currentPasswordSelector.description,
    /rotation/,
  );
  // A viewer that can drive the browser is a different security posture than
  // one that can only watch.
  assert.match(byName.browser_handoff.inputSchema.properties.interactive.description, /control/);
});

test("policyFromEnv is open by default and hardens via BLOCK_* vars", () => {
  const open = policyFromEnv({});
  assert.equal(open.allowLoopback, true);
  assert.equal(open.allowPrivateNetwork, true);

  const hardened = policyFromEnv({
    BETTERWRIGHT_BLOCK_LOOPBACK: "1",
    BETTERWRIGHT_BLOCK_PRIVATE_NETWORK: "1",
    BETTERWRIGHT_ALLOW_HOSTS: "a.com, b.com,,",
    BETTERWRIGHT_BLOCK_HOSTS: "ads.com",
  });
  assert.equal(hardened.allowLoopback, false);
  assert.equal(hardened.allowPrivateNetwork, false);
  assert.deepEqual(hardened.allowHosts, ["a.com", "b.com"]);
  assert.deepEqual(hardened.blockHosts, ["ads.com"]);
});

test("downloadPolicyFromEnv defaults to ask and rejects junk", () => {
  assert.equal(downloadPolicyFromEnv({}), "ask");
  assert.equal(downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "Allow" }), "allow");
  assert.throws(
    () => downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "sometimes" }),
    /must be "ask", "allow", or "deny"/,
  );
});

test("headlessFromEnv defaults to auto and honors explicit values", () => {
  assert.equal(headlessFromEnv({}), "auto");
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "0" }), false);
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "true" }), true);
});

test("timeoutFromEnv defaults to 120 seconds and rejects junk", () => {
  assert.equal(timeoutFromEnv({}), 120);
  assert.equal(timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "180" }), 180);
  assert.throws(
    () => timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "4" }),
    /must be a number of seconds >= 5/,
  );
  assert.throws(
    () => timeoutFromEnv({ BETTERWRIGHT_TIMEOUT_SECONDS: "soon" }),
    /must be a number of seconds >= 5/,
  );
});

test("contentForResult separates screenshots from file paths", async () => {
  const shot = path.join(makeTempDir("bw-mcp-"), "proof.png");
  fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
  const content = await contentForResult({
    ok: true,
    result: "Example Domain",
    console: ["hello"],
    artifacts: [
      { kind: "proof", path: shot, media: `MEDIA:${shot}` },
      { kind: "download", path: "/tmp/report.pdf" },
    ],
    pages: [{ url: "https://example.com" }],
    pendingCredential: {
      pendingId: "pending-1",
      origin: "https://example.com",
      matchMode: "host",
      username: "",
      label: null,
      secret: "generated-secret-that-must-not-leak",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    challenges: [],
    warnings: [],
    durationMs: 12.3,
  });

  assert.equal(content[0].type, "text");
  const summary = JSON.parse(content[0].text);
  assert.deepEqual(Object.keys(summary), [
    "ok",
    "result",
    "pendingCredential",
    "console",
    "files",
    "pages",
    "duration_ms",
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.duration_ms, 12.3);
  assert.equal(summary.pendingCredential.pendingId, "pending-1");
  assert.equal(Object.hasOwn(summary.pendingCredential, "secret"), false);
  assert.deepEqual(summary.files, [{ kind: "download", path: "/tmp/report.pdf" }]);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
});

test("contentForResult omits empty model-context fields", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "Example Domain",
    artifacts: [],
    durationMs: 7,
  });
  assert.equal(
    content.text,
    '{"ok":true,"result":"Example Domain","duration_ms":7}',
  );
});

test("contentForResult carries a discovered WebAgents directory", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    webagents: { available: true, protocol: "webagents/0.1" },
  });
  assert.deepEqual(JSON.parse(content.text).webagents, {
    available: true,
    protocol: "webagents/0.1",
  });
});

test("contentForResult carries a synthesized compact UI directory", async () => {
  const [content] = await contentForResult({
    ok: true,
    result: "opened",
    ui: {
      protocol: "betterwright-ui/1",
      tool: "browser_batch",
      controls: [{ target: { role: "button", name: "Submit" }, actions: ["click", "read"] }],
    },
  });
  assert.equal(JSON.parse(content.text).ui.protocol, "betterwright-ui/1");
  assert.equal(JSON.parse(content.text).ui.tool, "browser_batch");
});

test("liveViewFromEnv defaults to LAN bind and disabled remote exposure", () => {
  assert.deepEqual(liveViewFromEnv({}, {}), {
    enabled: false,
    host: "0.0.0.0",
    port: 0,
    publicHost: undefined,
    expose: undefined,
    password: undefined,
    passwordHash: undefined,
  });
  assert.deepEqual(
    liveViewFromEnv(
      {
        BETTERWRIGHT_LIVE_VIEW: "1",
        BETTERWRIGHT_LIVE_VIEW_HOST: "0.0.0.0",
        BETTERWRIGHT_LIVE_VIEW_PORT: "8484",
        BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST: "192.168.0.2",
        BETTERWRIGHT_LIVE_VIEW_EXPOSE: "Tailscale",
        BETTERWRIGHT_LIVE_VIEW_PASSWORD: "s3cret",
      },
      {},
    ),
    {
      enabled: true,
      host: "0.0.0.0",
      port: 8484,
      publicHost: "192.168.0.2",
      expose: "tailscale",
      password: "s3cret",
      passwordHash: undefined,
    },
  );
  // config.json settings apply beneath the env: env wins where both are set.
  assert.deepEqual(
    liveViewFromEnv(
      { BETTERWRIGHT_LIVE_VIEW_EXPOSE: "lan" },
      { expose: "tailscale", passwordHash: `sha256:${"a".repeat(64)}`, port: 7100 },
    ),
    {
      enabled: false,
      host: "0.0.0.0",
      port: 7100,
      publicHost: undefined,
      expose: "lan",
      password: undefined,
      passwordHash: `sha256:${"a".repeat(64)}`,
    },
  );
});

interface HandoffBrowser {
  calls: {
    start: Array<{ host: string; port: number; interactive: boolean; session: string }>;
    stop: number;
    status: number;
  };
  vault: Record<string, never> | null;
  startLiveView(options: {
    host: string;
    port: number;
    interactive: boolean;
    session: string;
  }): Promise<{
    ok: boolean;
    url: string;
    host: string;
    port: number;
    token: string;
    interactive: boolean;
    running: boolean;
  }>;
  stopLiveView(): Promise<{ ok: boolean; running: boolean }>;
  liveViewStatus(): Promise<{
    ok: boolean;
    running: boolean;
    url: string;
    token: string;
    viewers: number;
    handoff: { active: boolean };
  }>;
  chatQueue?: Array<{ text: string; at: number }>;
  posted?: Array<{ text?: string; kind?: string }>;
  runs?: Array<{ code: string; options?: { session?: string } }>;
  liveViewDrainChat?: () => Promise<{ ok: boolean; messages: Array<{ text: string; at: number }> }>;
  liveViewPostChat?: (options: { text?: string; kind?: string }) => Promise<{ ok: boolean }>;
  run?: (code: string, options?: { session?: string }) => Promise<{ ok: boolean; result: string }>;
}

function handoffBrowser(): HandoffBrowser {
  const calls: HandoffBrowser["calls"] = { start: [], stop: 0, status: 0 };
  return {
    calls,
    vault: null,
    async startLiveView(options) {
      calls.start.push(options);
      return {
        ok: true,
        url: "http://127.0.0.1:4242/?t=secret",
        host: "127.0.0.1",
        port: 4242,
        token: "secret",
        interactive: true,
        running: true,
      };
    },
    async stopLiveView() {
      calls.stop += 1;
      return { ok: true, running: false };
    },
    async liveViewStatus() {
      calls.status += 1;
      return {
        ok: true,
        running: true,
        url: "http://127.0.0.1:4242/?t=secret",
        token: "secret",
        viewers: 1,
        handoff: { active: false },
      };
    },
  };
}

test("browser_handoff start returns the URL with relay instructions", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const response = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { reason: "solve the MFA" } },
  });
  assert.equal(response.isError, undefined);
  assert.match(response.content[0].text, /http:\/\/127\.0\.0\.1:4242\/\?t=secret/);
  assert.match(response.content[0].text, /solve the MFA/);
  assert.deepEqual(browser.calls.start, [
    { host: "127.0.0.1", port: 0, interactive: true, session: "default" },
  ]);
});

test("browser_handoff refuses a non-loopback host without the env opt-in", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "0.0.0.0", port: 0 },
  });
  const refused = await handlers.callTool({
    params: { name: "browser_handoff", arguments: {} },
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /BETTERWRIGHT_LIVE_VIEW=1/);
  assert.equal(browser.calls.start.length, 0);

  const allowed = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: true, host: "0.0.0.0", port: 0 },
  });
  const response = await allowed.callTool({
    params: { name: "browser_handoff", arguments: {} },
  });
  assert.equal(response.isError, undefined);
  assert.equal(browser.calls.start.length, 1);
});

test("browser_handoff status never echoes the token or URL back to the model", async () => {
  const browser = handoffBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const response = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "status" } },
  });
  const status = JSON.parse(response.content[0].text);
  assert.equal(status.running, true);
  assert.equal(status.viewers, 1);
  assert.ok(!("token" in status));
  assert.ok(!("url" in status));

  const stop = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "stop" } },
  });
  assert.equal(JSON.parse(stop.content[0].text).running, false);
  assert.equal(browser.calls.stop, 1);
});

function chatBrowser() {
  const browser = handoffBrowser();
  browser.chatQueue = [];
  browser.posted = [];
  browser.runs = [];
  browser.liveViewDrainChat = async () => {
    const messages = browser.chatQueue.splice(0);
    return { ok: true, messages };
  };
  browser.liveViewPostChat = async (options) => {
    browser.posted.push(options);
    return { ok: true };
  };
  browser.run = async (code, options) => {
    browser.runs.push({ code, options });
    return { ok: true, result: "done" };
  };
  return browser;
}

test("viewer chat rides back on browser results while a live view runs", async () => {
  const browser = chatBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });

  // Before any live view starts, nothing is drained or posted.
  browser.chatQueue.push({ text: "too early", at: 1 });
  const quiet = await handlers.callTool({
    params: { name: "browser", arguments: { code: "1", note: "first step" } },
  });
  assert.equal(quiet.isError, undefined);
  assert.ok(!quiet.content.some((block) => /too early/.test(block.text || "")));
  assert.equal(browser.posted.length, 0);

  await handlers.callTool({ params: { name: "browser_handoff", arguments: {} } });
  browser.chatQueue.push({ text: "use the cheaper GPU", at: 2 });
  const response = await handlers.callTool({
    params: { name: "browser", arguments: { code: "2", note: "comparing GPUs" } },
  });
  assert.equal(response.isError, undefined);
  const chatBlock = response.content.find((block) =>
    /live-view chat/.test(block.text || ""),
  );
  assert.ok(chatBlock, "drained chat should be appended to the result");
  assert.match(chatBlock.text, /use the cheaper GPU/);
  assert.match(chatBlock.text, /fresh user instructions/);
  // The step note was mirrored into the viewer chat.
  assert.deepEqual(browser.posted, [
    { role: "agent", text: "comparing GPUs", kind: "step" },
  ]);
});

test("browser_handoff status carries drained viewer chat and stop ends mirroring", async () => {
  const browser = chatBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  await handlers.callTool({ params: { name: "browser_handoff", arguments: {} } });
  browser.chatQueue.push({ text: "done with MFA", at: 3 });
  const status = await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "status" } },
  });
  const parsed = JSON.parse(status.content[0].text);
  assert.deepEqual(parsed.userChat, ["done with MFA"]);
  assert.ok(!("token" in parsed));

  await handlers.callTool({
    params: { name: "browser_handoff", arguments: { action: "stop" } },
  });
  browser.chatQueue.push({ text: "gone", at: 4 });
  const after = await handlers.callTool({
    params: { name: "browser", arguments: { code: "3", note: "next" } },
  });
  assert.ok(!after.content.some((block) => /gone/.test(block.text || "")));
  assert.equal(browser.posted.length, 0);
});

function downloadBrowser() {
  const runs = [];
  return {
    vault: null,
    runs,
    async run(code, options) {
      runs.push({ code, options });
      return { ok: true, result: "saved" };
    },
  };
}

async function callDownload(handlers, args = {}) {
  return handlers.callTool({
    params: { name: "browser_download", arguments: { code: "return 1", ...args } },
  });
}

test("browser_download ask-mode grants the run without elicitation", async () => {
  const browser = downloadBrowser();
  let elicited = 0;
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        elicited += 1;
        throw new Error("MCP downloads must not wait on elicitation");
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { note: "Save the report" });
  assert.equal(response.isError, undefined);
  assert.equal(JSON.parse(response.content[0].text).result, "saved");
  assert.equal(elicited, 0);
  assert.deepEqual(browser.runs, [
    { code: "return 1", options: { session: "default", note: "Save the report", approvedDownloads: true } },
  ]);
});

test("browser_download ignores model-supplied approval flags and still grants", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { approvedDownloads: true, approved: true });
  assert.equal(response.isError, undefined);
  assert.deepEqual(browser.runs[0].options, {
    session: "default",
    note: undefined,
    approvedDownloads: true,
  });
});

test("browser_download allow-mode grants the run", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "allow",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, undefined);
  assert.equal(browser.runs[0].options.approvedDownloads, true);
});

test("browser_download deny-mode refuses before the run", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "deny",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
  assert.equal(browser.runs.length, 0);
});

test("the browser tool never sets approvedDownloads", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "ask",
  });

  const response = await handlers.callTool({
    params: {
      name: "browser",
      arguments: { code: "return 1", approvedDownloads: true },
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(browser.runs[0].options, { session: "default", note: undefined });
});

async function loadMcpSdk() {
  const [{ Client }, { Server }, { InMemoryTransport }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  return { Client, Server, InMemoryTransport, types };
}

async function connectDownloadServer({ downloadPolicy, clientCapabilities = {} }) {
  const sdk = await loadMcpSdk();
  const browser = downloadBrowser();
  const server = new sdk.Server(
    { name: "betterwright-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const handlers = _createMcpHandlersForTest({ browser, server, downloadPolicy });
  server.setRequestHandler(sdk.types.ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(sdk.types.CallToolRequestSchema, handlers.callTool);

  const client = new sdk.Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    browser,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("MCP protocol roundtrip: browser_download is autonomous without elicitation", async () => {
  const session = await connectDownloadServer({ downloadPolicy: "ask" });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1", note: "Save the image" },
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).result, "saved");
    assert.equal(session.browser.runs[0].options.approvedDownloads, true);
    assert.equal(session.browser.runs[0].options.note, "Save the image");
  } finally {
    await session.close();
  }
});

test("MCP protocol roundtrip: deny still blocks browser_download", async () => {
  const session = await connectDownloadServer({ downloadPolicy: "deny" });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
    assert.equal(session.browser.runs.length, 0);
  } finally {
    await session.close();
  }
});
