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
      ["browser", "browser_download", "browser_doctor"],
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
      usernameSelector: "#user",
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
      generate: true,
      usernameSelector: "#user",
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
  assert.deepEqual(LOGIN_INPUT_SCHEMA.properties.matchMode.enum, [
    "base-domain",
    "host",
    "exact-origin",
    "never",
  ]);
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
