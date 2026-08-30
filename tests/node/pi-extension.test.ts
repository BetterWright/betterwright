import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createPiExtension,
  PI_LOGIN_PARAMETERS,
} from "../../dist/src/pi-extension.js";
import { isCallable } from "../../dist/src/untrusted-value.js";

class FakePi {
  tools: Map<string, any>;
  handlers: Map<string, any>;
  messages: any[];
  activeTools: string[];

  constructor() {
    this.tools = new Map();
    this.handlers = new Map();
    this.messages = [];
    this.activeTools = ["read", "browser", "browser_download", "browser_evidence"];
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
  proofUrls: string[];

  constructor({
    screenshot,
    downloadPolicy = "ask",
    startFails = false,
    vault = {},
    proofUrls = [],
  }: {
    screenshot?: string;
    downloadPolicy?: string;
    startFails?: boolean;
    vault?: Record<string, never> | null;
    proofUrls?: string[];
  } = {}) {
    this.calls = [];
    this.fills = [];
    this.closeCount = 0;
    this.downloadPolicy = downloadPolicy;
    this.screenshot = screenshot;
    this.startFails = startFails;
    this.vault = vault;
    this.proofUrls = [...proofUrls];
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
        : code.includes('name: "pi-evidence"') && this.proofUrls.length
          ? this.proofUrls.shift()
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
    ]);
    for (const tool of pi.tools.values()) {
      assert.ok(isCallable(tool.renderCall));
      assert.ok(isCallable(tool.renderResult));
    }
    assert.match(pi.tools.get("browser").description, /usePage\(indexOrPageId\)/);
    assert.match(pi.tools.get("browser").description, /must not receive a Page object/);
    assert.match(pi.tools.get("browser").description, /page\/context are restricted wrappers/);
    assert.match(pi.tools.get("browser").description, /routing is unavailable/);
    assert.match(pi.tools.get("browser").description, /page\.addInitScript before navigation/);
    assert.match(pi.tools.get("browser").description, /page\.setContent/);
    assert.match(pi.tools.get("browser").description, /host-served local fixture/);
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


test("native Pi extension retains sequential named evidence checklists", async () => {
  const browser = new FakeBrowser({
    proofUrls: [
      "https://example.com/search?journey=first",
      "https://example.com/cart?journey=second",
    ],
  });
  const pi = new FakePi();
  createPiExtension({ browser, requireEvidence: true, autoScreenshot: false })(pi);
  const evidence = pi.tools.get("browser_evidence");

  const first = await evidence.execute("call-1", {
    operation: "initialize",
    name: "find-product",
    requirements: [{ id: "first-result", description: "Show the first result" }],
  });
  assert.equal(first.details.currentChecklist.name, "find-product");
  await evidence.execute("call-2", {
    operation: "prove",
    proofs: [{ id: "first-result", evidence: "The first result is visible" }],
  });
  const firstAudit = await evidence.execute("call-3", { operation: "audit" });
  assert.equal(firstAudit.details.currentChecklist.audited, true);

  const second = await evidence.execute("call-4", {
    operation: "initialize",
    name: "add-to-cart",
    requirements: [{ id: "cart", description: "Add the result to the cart" }],
  });
  assert.equal(second.details.currentChecklist.name, "add-to-cart");
  assert.equal(second.details.archivedChecklists.length, 1);
  await evidence.execute("call-5", {
    operation: "prove",
    proofs: [{ id: "cart", evidence: "The cart shows the requested result" }],
  });
  const finalAudit = await evidence.execute("call-6", { operation: "audit" });

  assert.equal(finalAudit.details.initialized, true);
  assert.equal(finalAudit.details.ready, true);
  assert.deepEqual(finalAudit.details.pending, []);
  assert.equal(finalAudit.details.archivedChecklists.length, 1);
  const archived = finalAudit.details.archivedChecklists[0];
  assert.equal(archived.name, "find-product");
  assert.equal(archived.ready, true);
  assert.equal(archived.audited, true);
  assert.deepEqual(archived.requirements[0], {
    id: "first-result",
    description: "Show the first result",
    status: "proven",
    evidence: "The first result is visible",
    proofStep: 1,
    proofUrl: "https://example.com/search?journey=first",
  });
  assert.equal(finalAudit.details.currentChecklist.name, "add-to-cart");
  assert.equal(finalAudit.details.currentChecklist.audited, true);
  assert.deepEqual(finalAudit.details.currentChecklist.requirements[0], {
    id: "cart",
    description: "Add the result to the cart",
    status: "proven",
    evidence: "The cart shows the requested result",
    proofStep: 2,
    proofUrl: "https://example.com/cart?journey=second",
  });
});

test("native Pi extension rejects replacing incomplete or unaudited checklists", async () => {
  const browser = new FakeBrowser();
  const pi = new FakePi();
  createPiExtension({ browser, requireEvidence: true, autoScreenshot: false })(pi);
  const evidence = pi.tools.get("browser_evidence");
  const requirements = [{ id: "result", description: "Show the requested result" }];

  const initialized = await evidence.execute("call-1", {
    operation: "initialize",
    requirements,
  });
  assert.equal(initialized.details.currentChecklist.name, "checklist-1");
  await assert.rejects(
    evidence.execute("call-2", {
      operation: "initialize",
      name: "replacement",
      requirements,
    }),
    /cannot replace a pending checklist/,
  );

  await evidence.execute("call-3", {
    operation: "prove",
    proofs: [{ id: "result", evidence: "The requested result is visible" }],
  });
  await assert.rejects(
    evidence.execute("call-4", {
      operation: "initialize",
      name: "replacement",
      requirements,
    }),
    /cannot replace a ready checklist before it has been audited/,
  );
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
    assert.deepEqual(pi.activeTools, ["read"]);
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
