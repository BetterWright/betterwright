import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BetterWright } from "../../src/client.mjs";
import {
  _createMcpHandlersForTest,
  contentForResult,
  downloadPolicyFromEnv,
  headlessFromEnv,
  LOGIN_INPUT_SCHEMA,
  liveViewFromEnv,
  loginOptionsFromArgs,
  policyFromEnv,
} from "../../src/mcp-server.mjs";

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
  const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bw-mcp-")), "proof.png");
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
    "error",
    "pendingCredential",
    "console",
    "files",
    "pages",
    "challenges",
    "skills",
    "warnings",
    "duration_ms",
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.duration_ms, 12.3);
  assert.equal(summary.pendingCredential.pendingId, "pending-1");
  assert.equal(Object.hasOwn(summary.pendingCredential, "secret"), false);
  assert.deepEqual(summary.skills, []);
  assert.deepEqual(summary.files, [{ kind: "download", path: "/tmp/report.pdf" }]);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
});

test("liveViewFromEnv defaults to loopback direct mode and disabled remote exposure", () => {
  assert.deepEqual(liveViewFromEnv({}, {}), {
    enabled: false,
    transport: "direct",
    host: "127.0.0.1",
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
      transport: "direct",
      host: "0.0.0.0",
      port: 8484,
      publicHost: "192.168.0.2",
      expose: "tailscale",
      password: "s3cret",
      passwordHash: undefined,
    },
  );
  // A persisted relay choice is an explicit MCP authorization by itself.
  assert.deepEqual(
    liveViewFromEnv({}, { transport: "relay", expose: "local" }),
    {
      enabled: true,
      transport: "relay",
      host: "127.0.0.1",
      port: 0,
      publicHost: undefined,
      expose: "local",
      password: undefined,
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
      transport: "direct",
      host: "127.0.0.1",
      port: 7100,
      publicHost: undefined,
      expose: "lan",
      password: undefined,
      passwordHash: `sha256:${"a".repeat(64)}`,
    },
  );
});

function handoffBrowser() {
  const calls = { start: [], stop: 0, status: 0 };
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
    { session: "default", role: "agent", text: "comparing GPUs", kind: "step" },
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

test("MCP viewer chat never crosses browser, download, or login sessions", async () => {
  const browser = chatBrowser();
  browser.vault = {};
  browser.fillCredential = async (options) => ({
    ok: true,
    filled: true,
    session: options.session,
  });
  const handlers = _createMcpHandlersForTest({
    browser,
    server: {},
    downloadPolicy: "allow",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });

  await handlers.callTool({
    params: {
      name: "browser_handoff",
      arguments: { action: "start", session: "private-a" },
    },
  });
  browser.chatQueue.push({ text: "secret instruction for A", at: 9 });

  for (const [name, toolArguments] of [
    ["browser", { code: "1", session: "other-b" }],
    ["browser_download", { code: "2", session: "other-b" }],
    ["browser_login", { session: "other-b" }],
  ]) {
    const response = await handlers.callTool({
      params: { name, arguments: toolArguments },
    });
    assert.equal(response.isError, undefined);
    assert.ok(
      !response.content.some((block) =>
        /secret instruction for A/.test(block.text || ""),
      ),
      `${name} must not receive another session's chat`,
    );
  }

  const owner = await handlers.callTool({
    params: { name: "browser_login", arguments: { session: "private-a" } },
  });
  assert.ok(
    owner.content.some((block) =>
      /secret instruction for A/.test(block.text || ""),
    ),
    "the bound session should receive its own queued chat",
  );
});
