import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
      ["browser", "browser_download", "browser_handoff", "browser_doctor"],
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

// The MCP tool list is re-sent on every request, so its size is permanent
// context overhead for every user of the server. This pins both halves of the
// bargain struck when descriptions were compressed on 2026-07-25 and again
// for 1.9.8 (8,670 → 5,521; 1.9.7 grew to 5,873; now <5,350 collapsed chars):
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
  const size = JSON.stringify(tools).replace(/\s+/g, " ").length;
  assert.ok(size < 5_350, `MCP tool list grew to ${size} collapsed characters`);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const text = (name) => byName[name].description.replace(/\s+/g, " ");

  // Reading and acting: the ref protocol is unusable if any of these literals
  // is paraphrased away.
  for (const literal of [
    "Plan then batch",
    "getByRole/getByLabel/getByText",
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
  // Challenge limits are safety rules, not advice.
  assert.match(text("browser"), /three distinct challenge types/);
  assert.match(text("browser"), /Replacement photo grids are the same stage/);
  assert.match(text("browser"), /Never duplicate a submission, purchase, or message/);
  assert.match(text("browser"), /webmcp\.tools\(\)\/webmcp\.invoke\(\)/);
  assert.match(text("browser"), /autosubmit requires explicit opt-in/);

  // Downloads are gated; both escape hatches must stay discoverable.
  assert.match(text("browser_download"), /approval first/);
  assert.match(text("browser_download"), /BETTERWRIGHT_DOWNLOAD_POLICY=allow/);
  assert.match(text("browser_download"), /deny/);

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

test("browser_download ask-mode elicits then runs with trusted approval", async () => {
  const browser = downloadBrowser();
  const elicitations = [];
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      getClientCapabilities() {
        return { elicitation: { form: {} } };
      },
      async elicitInput(params) {
        elicitations.push(params);
        return { action: "accept", content: { approved: true } };
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { note: "Save the report" });
  assert.equal(response.isError, undefined);
  assert.equal(JSON.parse(response.content[0].text).result, "saved");
  assert.equal(elicitations.length, 1);
  assert.match(elicitations[0].message, /Save the report/);
  assert.deepEqual(elicitations[0].requestedSchema.required, ["approved"]);
  assert.deepEqual(browser.runs, [
    { code: "return 1", options: { session: "default", note: "Save the report", approvedDownloads: true } },
  ]);
});

test("browser_download ask-mode does not treat model-supplied flags as approval", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers, { approvedDownloads: true, approved: true });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /cannot present download approval/);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=allow/);
  assert.match(response.content[0].text, /Conversation text is not a trusted approval channel/);
  assert.equal(browser.runs.length, 0);
});

test("browser_download ask-mode blocks when elicitInput throws, with config guidance", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      getClientCapabilities() {
        return { elicitation: { form: {} } };
      },
      async elicitInput() {
        throw new Error("Client does not support form elicitation.");
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=allow/);
  assert.equal(browser.runs.length, 0);
});

test("browser_download ask-mode treats empty elicitation:{} as form support", async () => {
  const browser = downloadBrowser();
  const requests = [];
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      getClientCapabilities() {
        return { elicitation: {} };
      },
      async elicitInput() {
        throw new Error("Client does not support form elicitation.");
      },
      async request(payload) {
        requests.push(payload);
        return { action: "accept", content: { approved: true } };
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "elicitation/create");
  assert.equal(requests[0].params.mode, "form");
  assert.equal(browser.runs[0].options.approvedDownloads, true);
});

test("browser_download ask-mode URL-only clients fail closed", async () => {
  const browser = downloadBrowser();
  let elicited = 0;
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      getClientCapabilities() {
        return { elicitation: { url: {} } };
      },
      async elicitInput() {
        elicited += 1;
        return { action: "accept", content: { approved: true } };
      },
    },
    downloadPolicy: "ask",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=allow/);
  assert.equal(elicited, 0);
  assert.equal(browser.runs.length, 0);
});

test("browser_download declined elicitation does not run", async () => {
  const browser = downloadBrowser();
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        return { action: "accept", content: { approved: false } };
      },
    },
    downloadPolicy: "ask",
  });

  const declined = await callDownload(handlers);
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /declined or cancelled/);
  assert.equal(browser.runs.length, 0);

  const cancelled = await _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        return { action: "cancel" };
      },
    },
    downloadPolicy: "ask",
  }).callTool({
    params: { name: "browser_download", arguments: { code: "return 1" } },
  });
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content[0].text, /declined or cancelled/);
  assert.equal(browser.runs.length, 0);
});

test("browser_download allow-mode skips elicitation and grants the run", async () => {
  const browser = downloadBrowser();
  let elicited = 0;
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        elicited += 1;
        throw new Error("should not elicit when policy is allow");
      },
    },
    downloadPolicy: "allow",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, undefined);
  assert.equal(elicited, 0);
  assert.equal(browser.runs[0].options.approvedDownloads, true);
});

test("browser_download deny-mode refuses before elicitation", async () => {
  const browser = downloadBrowser();
  let elicited = 0;
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {
      async elicitInput() {
        elicited += 1;
        return { action: "accept", content: { approved: true } };
      },
    },
    downloadPolicy: "deny",
  });

  const response = await callDownload(handlers);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=deny/);
  assert.equal(elicited, 0);
  assert.equal(browser.runs.length, 0);
});

test("ordinary browser tool never sets approvedDownloads", async () => {
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

async function connectDownloadServer({ downloadPolicy, clientCapabilities, onElicit = null }) {
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
  if (onElicit) {
    client.setRequestHandler(sdk.types.ElicitRequestSchema, onElicit);
  }
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

test("MCP protocol roundtrip: a form-capable host approves browser_download", async () => {
  const session = await connectDownloadServer({
    downloadPolicy: "ask",
    clientCapabilities: { elicitation: { form: {} } },
    onElicit: async (request) => {
      assert.match(request.params.message, /Save the image/);
      return { action: "accept", content: { approved: true } };
    },
  });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1", note: "Save the image" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).result, "saved");
    assert.equal(session.browser.runs[0].options.approvedDownloads, true);
  } finally {
    await session.close();
  }
});

test("MCP protocol roundtrip: a host without elicitation gets config guidance", async () => {
  const session = await connectDownloadServer({
    downloadPolicy: "ask",
    clientCapabilities: {},
  });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /BETTERWRIGHT_DOWNLOAD_POLICY=allow/);
    assert.equal(session.browser.runs.length, 0);
  } finally {
    await session.close();
  }
});

test("MCP protocol roundtrip: empty elicitation:{} still presents form approval", async () => {
  const session = await connectDownloadServer({
    downloadPolicy: "ask",
    clientCapabilities: { elicitation: {} },
    onElicit: async () => ({ action: "accept", content: { approved: true } }),
  });
  try {
    const result = await session.client.callTool({
      name: "browser_download",
      arguments: { code: "return 1" },
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(session.browser.runs[0].options.approvedDownloads, true);
  } finally {
    await session.close();
  }
});


