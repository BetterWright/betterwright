import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createPiExtension,
  PI_HANDOFF_PARAMETERS,
  PI_LOGIN_PARAMETERS,
} from "../../dist/src/pi-extension.js";

class FakePi {
  tools: Map<string, any>;
  handlers: Map<string, any>;
  messages: any[];
  activeTools: string[];

  constructor() {
    this.tools = new Map();
    this.handlers = new Map();
    this.messages = [];
    this.activeTools = [
      "read",
      "browser",
      "browser_download",
      "browser_evidence",
      "browser_handoff",
    ];
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  getActiveTools() {
    return [...this.activeTools];
  }

  setActiveTools(names) {
    this.activeTools = [...names];
  }

  sendMessage(message, options) {
    this.messages.push({ message, options });
  }
}

class FakeBrowser {
  calls: any[];
  fills: any[];
  closeCount: number;
  downloadPolicy: string;
  screenshot: any;
  startFails: boolean;
  vault: any;

  constructor({
    screenshot,
    downloadPolicy = "ask",
    startFails = false,
    vault = {},
  }: Record<string, any> = {}) {
    this.calls = [];
    this.fills = [];
    this.closeCount = 0;
    this.downloadPolicy = downloadPolicy;
    this.screenshot = screenshot;
    this.startFails = startFails;
    this.vault = vault;
  }

  async fillCredential(options) {
    this.fills.push(options);
    return {
      ok: true,
      result: { filled: ["username", "password"], submitted: true },
      pages: [{ url: "https://example.com/account", active: true }],
      artifacts: [],
    };
  }

  async run(code, options) {
    this.calls.push({ code, options });
    if (code.includes("page.goto")) {
      if (this.startFails) return { ok: false, error: "navigation failed" };
      return {
        ok: true,
        result: { url: "https://example.com/start" },
        pages: [{ url: "https://example.com/start", active: true }],
        artifacts: [],
      };
    }
    if (code.includes("screenshot(")) {
      const url = code.includes('name: "pi-start"')
        ? "https://example.com/start"
        : "https://example.com/result";
      return {
        ok: true,
        result: {
          url,
          title: "Result",
        },
        pages: [{ url, active: true }],
        artifacts: this.screenshot
          ? [{ kind: "debug", path: this.screenshot }]
          : [],
      };
    }
    return {
      ok: true,
      result: { value: 42 },
      pages: [{ url: "https://example.com/result", active: true }],
      artifacts: [],
    };
  }

  async close() {
    this.closeCount += 1;
  }
}

// Live-view-capable fake, mirroring mcp-server.test.ts's handoffBrowser().
function liveViewBrowser(overrides: Record<string, any> = {}) {
  const browser: any = new FakeBrowser({});
  browser.liveViewCalls = { start: [], stop: 0, status: 0, waits: [] };
  browser.chatQueue = [];
  browser.posted = [];
  browser.running = false;
  browser.startLiveView = async (options) => {
    browser.liveViewCalls.start.push(options);
    browser.running = true;
    return {
      ok: true,
      url: "http://127.0.0.1:7788/?t=secret",
      host: "127.0.0.1",
      port: 7788,
      token: "secret",
      interactive: true,
      viewers: 0,
    };
  };
  browser.stopLiveView = async () => {
    browser.liveViewCalls.stop += 1;
    browser.running = false;
    return { ok: true, running: false };
  };
  browser.liveViewStatus = async () => {
    browser.liveViewCalls.status += 1;
    return {
      ok: true,
      running: browser.running,
      url: "http://127.0.0.1:7788/?t=secret",
      token: "secret",
      viewers: 1,
      handoff: { active: false },
    };
  };
  browser.waitForHandoff = async (options) => {
    browser.liveViewCalls.waits.push(options);
    return { ok: true, action: "done", note: "logged in" };
  };
  browser.liveViewPostChat = async (options) => {
    browser.posted.push(options);
    return { ok: true };
  };
  browser.liveViewDrainChat = async () => ({
    ok: true,
    messages: browser.chatQueue.splice(0),
  });
  return Object.assign(browser, overrides);
}

async function until(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-pi-ext-"));
  const screenshot = path.join(dir, "browser.png");
  await fs.writeFile(screenshot, "fake png");
  return { dir, screenshot };
}

test("native Pi extension registers persistent tools and records its supplied start page", async () => {
  const { dir, screenshot } = await fixture();
  const traceDir = path.join(dir, "trace");
  const browser = new FakeBrowser({ screenshot });
  const pi = new FakePi();
  try {
    createPiExtension({
      browser,
      maxSteps: 2,
      startUrl: "https://example.com/start",
      traceDir,
    })(pi);

    assert.deepEqual([...pi.tools.keys()], [
      "browser",
      "browser_login",
      "browser_evidence",
      "browser_download",
      "browser_handoff",
    ]);
    for (const tool of pi.tools.values()) {
      assert.equal(typeof tool.renderCall, "function");
      assert.equal(typeof tool.renderResult, "function");
    }
    assert.match(pi.tools.get("browser").description, /usePage\(indexOrPageId\)/);
    assert.match(pi.tools.get("browser").description, /must not receive a Page object/);
    assert.ok(pi.handlers.has("before_agent_start"));
    assert.ok(pi.handlers.has("session_shutdown"));

    const result = await pi.tools.get("browser").execute(
      "call-1",
      { code: "return 42", note: "Checking the result" },
      new AbortController().signal,
    );

    assert.match(browser.calls[0].code, /page\.goto\("https:\/\/example\.com\/start"/);
    assert.equal(browser.calls[0].options.session, "pi");
    assert.equal(browser.calls.at(-1).options.note, "Capturing the current browser state");
    assert.equal(result.details.step, 1);
    assert.equal(result.details.budgetExhausted, false);
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /"remainingSteps": 1/);
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].mimeType, "image/png");

    const rows = (await fs.readFile(path.join(traceDir, "steps.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((row) => [row.step_num, row.action, row.url, row.ok]),
      [
        [0, "navigate", "https://example.com/start", true],
        [1, "browser", "https://example.com/result", true],
      ],
    );
    for (const row of rows) assert.equal((await fs.stat(row.screenshot)).isFile(), true);

    const prompt = pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /^base\n\n# Operating the browser/);
    await pi.handlers.get("session_shutdown")();
    assert.equal(browser.closeCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native Pi extension grounds required checklist items in proof frames", async () => {
  const { dir, screenshot } = await fixture();
  const browser = new FakeBrowser({ screenshot });
  const pi = new FakePi();
  try {
    createPiExtension({
      browser,
      maxSteps: 3,
      requireEvidence: true,
      traceDir: path.join(dir, "trace"),
    })(pi);
    await assert.rejects(
      pi.tools.get("browser").execute("call-1", { code: "return 1" }),
      /Initialize browser_evidence/,
    );
    const initialized = await pi.tools.get("browser_evidence").execute("call-2", {
      operation: "initialize",
      requirements: [
        { id: "filter", description: "Apply the exact requested filter" },
        { id: "result", description: "Show the requested result" },
      ],
    });
    assert.match(initialized.content[0].text, /"pending": \[/);

    const browsed = await pi.tools
      .get("browser")
      .execute("call-3", { code: "return 1", note: "Applying the filter" });
    assert.deepEqual(browsed.details.evidenceChecklist.pending, ["filter", "result"]);

    const proved = await pi.tools.get("browser_evidence").execute("call-4", {
      operation: "prove",
      proofs: [
        { id: "filter", evidence: "The exact filter chip is visible" },
        { id: "result", evidence: "The matching result is visible" },
      ],
    });
    assert.equal(proved.details.evidenceChecklist.ready, true);
    assert.match(proved.content[0].text, /"status": "proven"/);

    const audited = await pi.tools.get("browser_evidence").execute("call-5", {
      operation: "audit",
    });
    assert.equal(audited.details.ready, true);
    assert.match(audited.content[0].text, /All requirements have proof frames/);

    const rows = (await fs.readFile(path.join(dir, "trace", "steps.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).action, "browser_evidence");
    assert.match(rows.at(-1).response, /^PROOF filter:/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native Pi extension rejects contradictory proof and continues pending work", async () => {
  const browser = new FakeBrowser();
  const pi = new FakePi();
  createPiExtension({ browser, requireEvidence: true, autoScreenshot: false })(pi);
  const evidence = pi.tools.get("browser_evidence");
  await evidence.execute("call-1", {
    operation: "initialize",
    requirements: [
      { id: "bathrooms", description: "Bathroom filter is 2 bathrooms" },
      { id: "brand", description: "Apply the CVS Health Brand filter" },
      { id: "cart", description: "Add the requested product to the cart" },
    ],
  });
  await assert.rejects(
    evidence.execute("call-2", {
      operation: "prove",
      proofs: [{ id: "bathrooms", evidence: "The visible filter is 2+ Baths" }],
    }),
    /broader numeric value than the requirement/,
  );
  await assert.rejects(
    evidence.execute("call-3", {
      operation: "prove",
      proofs: [{ id: "brand", evidence: "The product card says CVS Health Brand" }],
    }),
    /visibly active control state/,
  );
  await assert.rejects(
    evidence.execute("call-4", {
      operation: "prove",
      proofs: [{ id: "cart", evidence: "The shopping bag is empty" }],
    }),
    /unmet or blocked state/,
  );

  pi.handlers.get("agent_end")({ messages: [] });
  pi.handlers.get("agent_end")({ messages: [] });
  pi.handlers.get("agent_end")({ messages: [] });
  assert.equal(pi.messages.length, 2);
  assert.match(pi.messages[0].message.content, /bathrooms: Bathroom filter is 2 bathrooms/);
  assert.deepEqual(pi.messages[0].options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});

test("native Pi extension enforces its browser step budget", async () => {
  const { dir, screenshot } = await fixture();
  const browser = new FakeBrowser({ screenshot });
  const pi = new FakePi();
  try {
    createPiExtension({ browser, maxSteps: 1 })(pi);
    const tool = pi.tools.get("browser");
    const first = await tool.execute("call-1", { code: "return 1" });
    assert.equal(first.details.budgetExhausted, true);
    // The live view must survive budget exhaustion: a pending handoff (or a
    // user still watching) may not be cut off with the browsing tools.
    assert.deepEqual(pi.activeTools, ["read", "browser_handoff"]);
    await assert.rejects(
      tool.execute("call-2", { code: "return 2" }),
      /step budget \(1\) is exhausted/,
    );
    assert.equal(browser.calls.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native Pi extension exposes trusted credential fill", async () => {
  const browser = new FakeBrowser({});
  const pi = new FakePi();
  createPiExtension({ browser })(pi);
  const tool = pi.tools.get("browser_login");
  assert.ok(tool, "browser_login should be registered");

  const result = await tool.execute(
    "call-1",
    {
      generate: true,
      id: "rec-1",
      currentPasswordSelector: "#old-password",
      submit: false,
      length: 20,
      matchMode: "exact-origin",
      session: "untrusted",
      // Unknown keys must be dropped before reaching fillCredential.
      note: "ignored",
    },
    new AbortController().signal,
  );

  assert.equal(browser.fills.length, 1);
  assert.deepEqual(browser.fills[0], {
    session: "pi",
    generate: true,
    id: "rec-1",
    currentPasswordSelector: "#old-password",
    length: 20,
    matchMode: "exact-origin",
    submit: false,
  });
  assert.deepEqual(PI_LOGIN_PARAMETERS.properties.matchMode.enum, [
    "base-domain",
    "host",
    "exact-origin",
    "never",
  ]);
  assert.equal(
    PI_LOGIN_PARAMETERS.properties.currentPasswordSelector.type,
    "string",
  );
  assert.ok(!PI_LOGIN_PARAMETERS.required?.includes("passwordSelector"));
  assert.equal(result.details.ok, true);
  const summary = JSON.parse(result.content[0].text);
  assert.deepEqual(summary.result.filled, ["username", "password"]);
  // The fill never runs model JavaScript.
  assert.equal(browser.calls.length, 0);

  await assert.rejects(
    tool.execute("call-2", {
      generate: true,
      matchMode: "same-site",
    }),
    /matchMode.*exact-origin/,
  );
  assert.equal(browser.fills.length, 1);
});

test("native Pi extension omits browser_login when the vault is disabled", () => {
  const browser = new FakeBrowser({ vault: null });
  const suppliedBrowserPi = new FakePi();
  createPiExtension({ browser: browser })(suppliedBrowserPi);
  assert.equal(suppliedBrowserPi.tools.has("browser_login"), false);
  assert.equal(browser.fills.length, 0);

  const browserOptionsPi = new FakePi();
  createPiExtension({ browserOptions: { vault: false } })(browserOptionsPi);
  assert.equal(browserOptionsPi.tools.has("browser_login"), false);
});

test("native Pi extension fails closed for downloads without approval UI", async () => {
  const browser = new FakeBrowser({ downloadPolicy: "ask" });
  const pi = new FakePi();
  createPiExtension({ browser })(pi);
  const tool = pi.tools.get("browser_download");

  await assert.rejects(
    tool.execute("call-1", { code: "return 1" }, undefined, undefined, {
      hasUI: false,
    }),
    /requires user approval/,
  );
  await assert.rejects(
    tool.execute("call-2", { code: "return 2" }),
    /requires user approval/,
  );
  assert.equal(browser.calls.length, 0);
});

test("native Pi extension passes explicit download approval to BetterWright", async () => {
  const browser = new FakeBrowser({ downloadPolicy: "ask" });
  const pi = new FakePi();
  createPiExtension({ browser, autoScreenshot: false })(pi);
  const tool = pi.tools.get("browser_download");

  const result = await tool.execute(
    "call-1",
    { code: "return 1", note: "Saving the report" },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: { confirm: async () => true },
    },
  );
  assert.equal(result.details.ok, true);
  assert.equal(browser.calls[0].options.approvedDownloads, true);
});

test("native Pi extension reports invalid configuration and recovers from start failures", async () => {
  assert.throws(
    () => createPiExtension({ maxSteps: 0 })(new FakePi()),
    /positive integer/,
  );
  assert.throws(
    () => createPiExtension({ startUrl: "file:///tmp/page.html" })(new FakePi()),
    /http or https/,
  );

  const { dir, screenshot } = await fixture();
  const browser = new FakeBrowser({ startFails: true, screenshot });
  const pi = new FakePi();
  const traceDir = path.join(dir, "trace");
  try {
    createPiExtension({
      browser,
      startUrl: "https://example.com",
      traceDir,
    })(pi);
    const result = await pi.tools.get("browser").execute("call-1", {
      code: "return 1",
    });
    assert.equal(result.details.ok, true);
    assert.match(result.content[0].text, /initial navigation.*failed/i);
    assert.match(result.content[0].text, /remains available for recovery/i);
    const rows = (await fs.readFile(path.join(traceDir, "steps.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows[0].ok, false);
    assert.equal((await fs.stat(rows[0].screenshot)).isFile(), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("native Pi extension shares the live view, mirrors chat both ways, and strips secrets from status", async () => {
  const browser = liveViewBrowser();
  const pi = new FakePi();
  createPiExtension({
    browser,
    autoScreenshot: false,
    chatPollMs: 5,
    liveView: { enabled: true, host: "0.0.0.0", port: 0 },
  })(pi);
  const tool = pi.tools.get("browser_handoff");
  assert.deepEqual(PI_HANDOFF_PARAMETERS.properties.action.enum, [
    "start",
    "status",
    "stop",
    "wait",
  ]);

  const started = await tool.execute("call-1", { action: "start" });
  assert.match(started.content[0].text, /Live view started: http:\/\/127\.0\.0\.1:7788\/\?t=secret/);
  assert.match(started.content[0].text, /verbatim/);
  assert.equal(browser.liveViewCalls.start[0].session, "pi");
  assert.equal(browser.liveViewCalls.start[0].interactive, true);

  // Re-issuing start re-shares the same URL (tmux reattach, lost scrollback).
  const reshared = await tool.execute("call-2", { action: "start" });
  assert.equal(browser.liveViewCalls.start.length, 2);
  assert.match(reshared.content[0].text, /t=secret/);

  // Status must never echo the capability token or URL back to the model.
  const status = await tool.execute("call-3", { action: "status" });
  assert.doesNotMatch(status.content[0].text, /secret/);
  assert.match(status.content[0].text, /"running": true/);

  // Freeform viewer chat is polled and delivered as follow-up user guidance
  // that wakes an idle agent.
  browser.chatQueue.push({ text: "use the work account", at: 1 });
  await until(() => pi.messages.length > 0);
  assert.equal(pi.messages[0].message.customType, "betterwright-live-view-chat");
  assert.match(pi.messages[0].message.content, /use the work account/);
  assert.deepEqual(pi.messages[0].options, { deliverAs: "followUp", triggerTurn: true });

  // Browser-step notes mirror into the viewer chat while the view runs.
  await pi.tools
    .get("browser")
    .execute("call-4", { code: "return 1", note: "Opening the page" });
  assert.deepEqual(browser.posted, [
    { role: "agent", text: "Opening the page", kind: "step" },
  ]);

  // Stop ends the view and the chat polling with it.
  await tool.execute("call-5", { action: "stop" });
  assert.equal(browser.liveViewCalls.stop, 1);
  browser.chatQueue.push({ text: "unheard", at: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pi.messages.length, 1);
});

test("native Pi extension requires the deployer opt-in for a non-loopback live view", async () => {
  const cases = [
    { liveView: { enabled: false, host: "0.0.0.0", port: 0 } },
    { liveView: { enabled: false, expose: "tailscale", host: "0.0.0.0", port: 0 } },
  ];
  for (const { liveView } of cases) {
    const pi = new FakePi();
    createPiExtension({ browser: liveViewBrowser(), autoScreenshot: false, liveView })(pi);
    await assert.rejects(
      pi.tools.get("browser_handoff").execute("call-1", { action: "start" }),
      /BETTERWRIGHT_LIVE_VIEW=1/,
    );
  }

  // Loopback-only exposure never needs the opt-in.
  const browser = liveViewBrowser();
  const pi = new FakePi();
  createPiExtension({
    browser,
    autoScreenshot: false,
    liveView: { enabled: false, expose: "local", host: "0.0.0.0", port: 0 },
  })(pi);
  const started = await pi.tools
    .get("browser_handoff")
    .execute("call-2", { action: "start" });
  assert.match(started.content[0].text, /Live view started/);
  assert.equal(browser.liveViewCalls.start[0].expose, "local");
});

test("native Pi extension waits for a human handoff and reports resumable outcomes", async () => {
  const browser = liveViewBrowser();
  const pi = new FakePi();
  createPiExtension({
    browser,
    autoScreenshot: false,
    chatPollMs: 5,
    liveView: { enabled: true, host: "0.0.0.0", port: 0 },
  })(pi);
  const tool = pi.tools.get("browser_handoff");

  // A wait without a running view is a usage error, not a silent hang.
  await assert.rejects(
    tool.execute("call-1", { action: "wait", reason: "MFA" }),
    /No live view is running/,
  );

  await tool.execute("call-2", { action: "start" });
  const done = await tool.execute("call-3", {
    action: "wait",
    reason: "Approve the MFA prompt",
    timeout: 60,
  });
  assert.deepEqual(browser.liveViewCalls.waits, [
    { session: "pi", prompt: "Approve the MFA prompt", timeout: 60 },
  ]);
  assert.match(done.content[0].text, /"action": "done"/);
  assert.match(done.content[0].text, /snapshot\(\{diff: true\}\)/);

  // A timeout is a normal, resumable result — never a tool error.
  browser.waitForHandoff = async () => ({ ok: true, action: "timeout", note: "" });
  const timedOut = await tool.execute("call-4", { action: "wait" });
  assert.equal(timedOut.details.ok, true);
  assert.match(timedOut.content[0].text, /wait again or continue/);

  await tool.execute("call-5", { action: "stop" });
});
