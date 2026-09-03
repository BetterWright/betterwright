// AgentBatch without a browser: plan validation, the snippet every surface
// generates, and the executor driven through a fake page. The managed-browser
// suite (browser.test.ts) covers the real Playwright behavior.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_BATCH_ACTIONS,
  AGENT_BATCH_PROTOCOL,
  agentBatchCode,
  agentBatchRunTimeoutSeconds,
  agentBatchTimeoutSeconds,
  executeAgentBatch,
  MAX_AGENT_BATCH_STEPS,
  normalizeAgentBatch,
  renderAgentBatchAnswer,
} from "../../dist/src/agent-batch.js";
import { locatorFor, parseTarget } from "../../dist/src/batch-targets.js";

const labels = { subject: 'test step "x"', fields: "test" };

test("normalizeAgentBatch assigns ids, defaults, and keeps only each action's fields", () => {
  const plan = normalizeAgentBatch(
    [
      { action: "goto", url: "https://example.com/" },
      { id: "q", action: "fill", target: { label: "Search" }, value: "keyboard" },
      { action: "press", key: "Enter", target: { label: "Search" } },
      { action: "read", target: { role: "heading", name: "Results" }, expect: "Results" },
    ],
    { allowWrites: true },
  );
  assert.deepEqual(plan.steps.map((step) => step.id), ["s1", "q", "s3", "s4"]);
  assert.equal(plan.steps[0].url, "https://example.com/");
  assert.equal(plan.steps[0].timeoutMs, undefined);
  assert.deepEqual(plan.steps[1].target, { method: "label", value: "Search", exact: false });
  assert.equal(plan.steps[2].key, "Enter");
  assert.equal(plan.steps[3].expect, "Results");
  assert.deepEqual(plan.options, {
    allowWrites: true,
    allowIrreversible: false,
    allowPasswords: false,
    observe: "snapshot",
    proof: false,
    settleMs: 1_000,
    minIntervalMs: 0,
  });
});

test("normalizeAgentBatch rejects malformed batches with the step and field named", () => {
  const rejects = (steps, options, pattern) =>
    assert.throws(() => normalizeAgentBatch(steps, options), pattern);
  rejects([], undefined, /non-empty array/);
  rejects("goto", undefined, /non-empty array/);
  rejects(new Array(MAX_AGENT_BATCH_STEPS + 1).fill({ action: "reload" }), undefined, /at most 100 steps/);
  rejects([{ action: "teleport" }], undefined, /unsupported action "teleport"/);
  rejects([{ action: "click", target: { css: "a" }, selector: "b" }], { allowWrites: true }, /does not accept "selector"/);
  rejects([{ action: "click", target: { css: "a" } }], undefined, /allowWrites:true/);
  rejects([{ action: "goto", url: "https://a.test", irreversible: true }], undefined, /allowIrreversible:true/);
  rejects([{ action: "fill", value: "x" }], { allowWrites: true }, /requires a target/);
  rejects([{ action: "fill", target: { css: "a", label: "b" }, value: "x" }], { allowWrites: true }, /exactly one of ref, role/);
  rejects([{ action: "click", target: { ref: "button" } }], { allowWrites: true }, /invalid aria ref/);
  rejects([{ action: "click", target: { css: "a", nth: 500 } }], { allowWrites: true }, /nth must be an integer/);
  rejects([{ action: "wait" }], undefined, /exactly one of target, url, text, or ms/);
  rejects([{ action: "wait", url: "/done", state: "hidden" }], undefined, /state applies only with a target/);
  rejects([{ action: "wait", ms: 60_000 }], undefined, /ms must be an integer from 0 to 10000/);
  rejects([{ action: "scroll" }], undefined, /needs a target or a non-zero dx\/dy/);
  rejects([{ action: "scroll", target: { css: "a" }, dy: 10 }], undefined, /either a target or dx\/dy/);
  rejects([{ action: "read", target: { css: "a" }, all: true, expect: "x" }], undefined, /cannot combine all and expect/);
  rejects([{ action: "select", target: { css: "a" }, value: [] }], { allowWrites: true }, /string or a bounded string array/);
  rejects([{ action: "dialog", response: "maybe" }], { allowWrites: true }, /response must be one of accept, dismiss/);
  rejects([{ action: "goto", url: "https://a.test", waitUntil: "soon" }], undefined, /waitUntil must be one of/);
  rejects([{ action: "screenshot", kind: "selfie" }], undefined, /kind must be one of proof, question, debug/);
  rejects([{ action: "usePage" }], undefined, /page must be a string/);
  rejects([{ id: "same", action: "reload" }, { id: "same", action: "reload" }], undefined, /duplicated/);
  rejects([{ id: "1st", action: "reload" }], undefined, /invalid id/);
  rejects([{ action: "reload", timeoutMs: 10 }], undefined, /timeoutMs must be an integer from 100 to 60000/);
  rejects([{ action: "reload" }], { observe: "loudly" }, /observe must be one of/);
  rejects([{ action: "reload" }], { settleMs: 9_000 }, /settleMs must be an integer from 0 to 5000/);
  rejects([{ action: "reload" }], "fast", /options must be an object/);
  rejects([{ action: "reload" }], { answer: "" }, /answer must not be empty/);
  rejects([{ action: "reload" }], { answer: "x".repeat(4_001) }, /answer exceeds 4000 characters/);
  assert.equal(normalizeAgentBatch([{ action: "reload" }], { answer: "Done: {s1.url}" }).options.answer, "Done: {s1.url}");
});

test("renderAgentBatchAnswer fills placeholders from step results and refuses unknown ones", () => {
  const results: any = [
    { id: "flash", action: "read", ok: true, tag: "div", text: "You logged in!", value: "" },
    { id: "where", action: "url", ok: true, url: "https://a.test/secure", title: "Secure" },
    { id: "count", action: "read", ok: true, tag: "span", text: "", value: "3", checked: true },
    { id: "items", action: "read", ok: true, count: 2, items: [] },
  ];
  assert.equal(renderAgentBatchAnswer("Message: {flash}", results), "Message: You logged in!");
  assert.equal(renderAgentBatchAnswer("At {where} ({where.title})", results), "At https://a.test/secure (Secure)");
  // {id} falls through text → value → url; explicit fields reach any scalar.
  assert.equal(renderAgentBatchAnswer("{count} / {count.checked} / {items.count}", results), "3 / true / 2");
  assert.equal(renderAgentBatchAnswer("No placeholders", results), "No placeholders");
  assert.throws(() => renderAgentBatchAnswer("{missing}", results), /names a step this batch did not run/);
  // Malformed brace groups are refused, never kept as literal answer text.
  for (const malformed of ["{1price}", "{step.1}", "{}", "{flash.text.tag}", "{ flash }"]) {
    assert.throws(() => renderAgentBatchAnswer(`Total: ${malformed}`, results), /must be \{stepId\} or \{stepId\.field\}/, malformed);
  }
  // A lone brace is not a placeholder and stays literal.
  assert.equal(renderAgentBatchAnswer("Set {flash} in {braces", results), "Set You logged in! in {braces");
  assert.throws(() => renderAgentBatchAnswer("{items}", results), /has no value; step "items" \(read\) produced count, items/);
  assert.throws(() => renderAgentBatchAnswer("{flash.items}", results), /has no value/);
});

test("a batch with answer finishes with finalAnswer only when every step succeeded", async () => {
  const page = fakePage({
    "role:status:": [{ tag: "div", text: "Created Ada" }],
    "role:button:Missing": [],
  });
  const done = await executeAgentBatch(
    fakeHost(page),
    [{ id: "verify", action: "read", target: { role: "status" } }],
    { observe: "none", answer: "Status now reads: {verify}" },
  );
  assert.equal(done.ok, true);
  assert.equal(done.finalAnswer, "Status now reads: Created Ada");
  assert.equal(done.answerError, undefined);

  const broken = await executeAgentBatch(
    fakeHost(page),
    [{ id: "verify", action: "read", target: { role: "status" } }],
    { observe: "none", answer: "{nope}" },
  );
  assert.equal(broken.ok, true);
  assert.equal(broken.finalAnswer, undefined);
  assert.match(broken.answerError, /names a step this batch did not run/);

  for (const malformed of ["Price: {1price}", "{verify.1}"]) {
    const unfilled = await executeAgentBatch(
      fakeHost(page),
      [{ id: "verify", action: "read", target: { role: "status" } }],
      { observe: "none", answer: malformed },
    );
    assert.equal(unfilled.ok, true);
    assert.equal(unfilled.finalAnswer, undefined, `${malformed} must not become an answer`);
    assert.match(unfilled.answerError, /must be \{stepId\} or \{stepId\.field\}/);
  }

  const stopped = await executeAgentBatch(
    fakeHost(page),
    [
      { id: "verify", action: "read", target: { role: "status" } },
      { id: "go", action: "click", target: { role: "button", name: "Missing" }, timeoutMs: 100 },
    ],
    { allowWrites: true, observe: "none", answer: "Status: {verify}" },
  );
  assert.equal(stopped.ok, false);
  assert.equal(stopped.finalAnswer, undefined, "a stopped batch never renders an answer");
  assert.equal(stopped.answerError, undefined);
});

test("every advertised action has a field table and round-trips through validation", () => {
  const samples = {
    goto: { url: "https://a.test/" },
    back: {},
    forward: {},
    reload: { waitUntil: "domcontentloaded" },
    click: { target: { role: "button", name: "Go" } },
    dblclick: { target: { css: "#x" } },
    hover: { target: { text: "Menu" } },
    fill: { target: { label: "Name" }, value: "Ada" },
    type: { target: { placeholder: "Search" }, value: "abc", append: true },
    press: { key: "Escape" },
    select: { target: { label: "Plan" }, value: ["pro"] },
    check: { target: { label: "Terms" } },
    uncheck: { target: { label: "Terms" } },
    scroll: { dy: 400 },
    wait: { text: "Saved" },
    read: { target: { testId: "total" }, attribute: "data-cents" },
    url: { expect: "/done" },
    snapshot: { interactive: false, ref: "e3", maxChars: 5_000 },
    screenshot: { kind: "proof", fullPage: true },
    openPage: { url: "https://b.test/" },
    usePage: { page: 0 },
    closePage: {},
    dialog: { response: "accept", promptText: "yes" },
    overlays: {},
  };
  assert.deepEqual(Object.keys(samples).sort(), [...AGENT_BATCH_ACTIONS].sort());
  const plan = normalizeAgentBatch(
    Object.entries(samples).map(([action, fields]) => ({ action, ...fields })),
    { allowWrites: true },
  );
  assert.equal(plan.steps.length, AGENT_BATCH_ACTIONS.length);
  assert.deepEqual(plan.steps.find((step) => step.action === "select").values, ["pro"]);
  assert.deepEqual(plan.steps.find((step) => step.action === "snapshot").snapshot, {
    interactive: false,
    ref: "e3",
    maxChars: 5_000,
  });
  assert.deepEqual(plan.steps.find((step) => step.action === "screenshot").screenshot, {
    kind: "proof",
    fullPage: true,
  });
  assert.equal(plan.steps.find((step) => step.action === "wait").text, "Saved");
  assert.equal(plan.steps.find((step) => step.action === "scroll").dy, 400);
});

test("a batch's default run timeout grows with its steps and stays bounded", () => {
  // One step (the spec call) keeps the surface's own default.
  assert.equal(agentBatchTimeoutSeconds(1, 30), 30);
  assert.equal(agentBatchTimeoutSeconds(1, 120), 120);
  // Every step gets its 10 s action budget on top of a 15 s base.
  assert.equal(agentBatchTimeoutSeconds(5, 30), 65);
  assert.equal(agentBatchTimeoutSeconds(20, 30), 215);
  // Ten minutes is the ceiling, and junk counts as one step.
  assert.equal(agentBatchTimeoutSeconds(100, 30), 600);
  assert.equal(agentBatchTimeoutSeconds(0, 30), 30);
  assert.equal(agentBatchTimeoutSeconds(Number.NaN, 45), 45);
  // Read off tool arguments, a spec call counts as one step.
  assert.equal(agentBatchRunTimeoutSeconds({ url: "https://a.test/" }, 120), 120);
  assert.equal(agentBatchRunTimeoutSeconds({ steps: new Array(12).fill({ action: "reload" }) }, 120), 135);
  assert.equal(agentBatchRunTimeoutSeconds({ steps: "junk" }, 30), 30);
});

test("goto and openPage refuse a URL that does not parse", () => {
  assert.throws(() => normalizeAgentBatch([{ action: "goto", url: "not a url" }]), /url must be an absolute URL/);
  assert.throws(() => normalizeAgentBatch([{ action: "openPage", url: "/relative" }]), /url must be an absolute URL/);
  assert.equal(normalizeAgentBatch([{ action: "goto", url: "about:blank" }]).steps[0].url, "about:blank");
});

test("parseTarget accepts frame-qualified refs and the aria-ref= prefix", () => {
  assert.equal(parseTarget({ ref: "f1e3" }, labels).value, "f1e3");
  assert.equal(parseTarget({ ref: "aria-ref=e12" }, labels).value, "aria-ref=e12");
  assert.deepEqual(parseTarget({ role: "button", name: "Go", exact: true, nth: 1, frameName: "pay" }, labels), {
    method: "role",
    value: "button",
    name: "Go",
    exact: true,
    nth: 1,
    frameName: "pay",
  });
  assert.throws(() => parseTarget({ css: "a", frameName: "x", frameUrlIncludes: "y" }, labels), /cannot combine/);
});

test("agentBatchCode turns {url} into a goto step and guards its JSON literal", () => {
  assert.equal(
    agentBatchCode({ url: " https://example.com/form " }),
    'return agentBatch([{"action":"goto","url":"https://example.com/form"}], {});',
  );
  const code = agentBatchCode({
    steps: [{ action: "fill", target: { label: "Name" }, value: "Ada Lovelace" }],
    allowWrites: true,
    observe: "diff",
    proof: true,
    session: "ignored",
  });
  assert.match(code, /^return agentBatch\(\[/);
  assert.match(code, /\\u2028/);
  assert.doesNotMatch(code, /\u2028/);
  assert.match(code, /\{"allowWrites":true,"observe":"diff","proof":true\}\);$/);
  assert.match(
    agentBatchCode({ steps: [{ action: "url" }], answer: "Landed on {s1}" }),
    /\{"answer":"Landed on \{s1\}"\}\);$/,
  );
  assert.doesNotMatch(code, /session/);
  assert.throws(() => agentBatchCode({ url: "https://a.test", steps: [] }), /either url or steps/);
  assert.throws(() => agentBatchCode({}), /requires url or a non-empty steps array/);
  assert.throws(() => agentBatchCode({ steps: [{ action: "click", target: { css: "a" } }] }), /allowWrites:true/);
});

// A fake Playwright page: locators resolve against a tiny element table, and
// every call is recorded so a test can assert what the executor asked for.
function fakeLocator(page, elements, path) {
  const first = () => elements[0];
  return {
    first: () => fakeLocator(page, elements.slice(0, 1), `${path}.first()`),
    nth: (index) => fakeLocator(page, elements.slice(index, index + 1), `${path}.nth(${index})`),
    count: async () => elements.length,
    waitFor: async (options) => {
      page.calls.push(["waitFor", path, options]);
      if (!elements.length) throw new Error(`Timeout waiting for ${path}`);
    },
    click: async () => {
      page.calls.push(["click", path]);
      first().onClick?.();
    },
    dblclick: async () => page.calls.push(["dblclick", path]),
    hover: async () => page.calls.push(["hover", path]),
    fill: async (value) => {
      page.calls.push(["fill", path, value]);
      first().value = value;
    },
    clear: async () => {
      page.calls.push(["clear", path]);
      first().value = "";
    },
    pressSequentially: async (value) => {
      page.calls.push(["type", path, value]);
      first().value = `${first().value || ""}${value}`;
    },
    press: async (key) => page.calls.push(["press", path, key]),
    selectOption: async (values) => {
      page.calls.push(["select", path, values]);
      return values;
    },
    check: async () => {
      page.calls.push(["check", path]);
      first().checked = true;
    },
    uncheck: async () => {
      page.calls.push(["uncheck", path]);
      first().checked = false;
    },
    scrollIntoViewIfNeeded: async () => page.calls.push(["scrollIntoView", path]),
    getAttribute: async (name) => first().attributes?.[name] ?? null,
    evaluate: async (fn, arg) => {
      // The two evaluate callbacks the executor uses read the element's
      // password-ness and its reading; mirror them on the fake element.
      const element = first();
      if (fn.length === 1) return element.password === true;
      return {
        tag: element.tag || "div",
        text: String(element.text || "").slice(0, arg),
        value: element.password ? "[redacted]" : element.value,
        checked: element.checked,
        disabled: element.disabled,
        ariaLabel: element.ariaLabel,
      };
    },
  };
}

function fakePage(elements: Record<string, any[]>, url = "https://site.test/start") {
  const page: any = {
    calls: [],
    listeners: new Map(),
    _url: url,
    url: () => page._url,
    title: async () => "Fake page",
    frames: () => [page],
    name: () => "",
    on: (event, listener) => page.listeners.set(event, listener),
    off: (event) => page.listeners.delete(event),
    waitForLoadState: async () => {},
    goto: async (target) => {
      page.calls.push(["goto", target]);
      page._url = target;
      return { status: () => 200 };
    },
    goBack: async () => page.calls.push(["back"]),
    goForward: async () => page.calls.push(["forward"]),
    reload: async () => page.calls.push(["reload"]),
    keyboard: { press: async (key) => page.calls.push(["keyboard", key]) },
    mouse: { wheel: async (dx, dy) => page.calls.push(["wheel", dx, dy]) },
    getByText: (text) => fakeLocator(page, elements[`text:${text}`] || [], `text:${text}`),
    getByRole: (role, options) => fakeLocator(page, elements[`role:${role}:${options?.name ?? ""}`] || [], `role:${role}`),
    getByLabel: (label) => fakeLocator(page, elements[`label:${label}`] || [], `label:${label}`),
    getByPlaceholder: (text) => fakeLocator(page, elements[`placeholder:${text}`] || [], `placeholder:${text}`),
    getByTestId: (id) => fakeLocator(page, elements[`testId:${id}`] || [], `testId:${id}`),
    locator: (selector) => fakeLocator(page, elements[selector] || [], selector),
  };
  return page;
}

function fakeHost(page) {
  const host: any = {
    snapshots: [],
    screenshots: [],
    observedPages: [],
    dialogs: [],
    navigations: [],
    currentPage: async () => page,
    pageId: () => "page-1",
    snapshot: async (options) => {
      host.snapshots.push(options);
      return `page page-1 ${page.url()} "Fake page"\n- button "Go" [ref=e1]`;
    },
    screenshot: async (options) => {
      host.screenshots.push(options);
      return { kind: options.kind, path: `/tmp/${options.kind}.png`, media: `MEDIA:/tmp/${options.kind}.png` };
    },
    assertNavigationUrl: (url) => {
      host.navigations.push(url);
      if (url.startsWith("ftp:")) throw new Error("Browser navigation scheme is not available: ftp:");
    },
    openPage: async () => page,
    usePage: async () => page,
    closePage: async () => ({ closed: true, pageId: "page-1" }),
    dismissOverlays: async () => ({ dismissed: [{ kind: "cookie", label: "Reject all" }] }),
    armDialog: (response, promptText) => host.dialogs.push([response, promptText]),
    disarmDialog: () => host.dialogs.push(["disarm"]),
    observed: (observedPage) => host.observedPages.push(observedPage),
  };
  return host;
}

test("executeAgentBatch runs steps in order, reads results, and ends with a spec snapshot", async () => {
  const status = { tag: "div", text: "Waiting" };
  const page = fakePage({
    "label:Name": [{ tag: "input", value: "" }],
    "role:button:Create": [{ tag: "button", text: "Create", onClick: () => { status.text = "Created Ada"; } }],
    "role:status:": [status],
    "input[type=password]": [{ tag: "input", password: true, value: "hunter2" }],
  });
  const host = fakeHost(page);
  const result = await executeAgentBatch(
    host,
    [
      { action: "goto", url: "https://site.test/form" },
      { id: "name", action: "fill", target: { label: "Name" }, value: "Ada" },
      { id: "submit", action: "click", target: { role: "button", name: "Create" } },
      { id: "verify", action: "read", target: { role: "status" }, expect: "Created" },
      { id: "secret", action: "read", target: { css: "input[type=password]" }, attribute: "value" },
      { action: "url", expect: "/form" },
    ],
    { allowWrites: true, proof: true },
  );
  assert.equal(result.protocol, AGENT_BATCH_PROTOCOL);
  assert.equal(result.ok, true);
  assert.equal(result.completed, 6);
  assert.equal(result.total, 6);
  assert.equal(result.failed, undefined);
  assert.deepEqual(result.steps.map((step) => [step.id, step.ok]), [
    ["s1", true],
    ["name", true],
    ["submit", true],
    ["verify", true],
    ["secret", true],
    ["s6", true],
  ]);
  assert.equal(result.steps[0].status, 200);
  assert.equal(result.steps[1].filled, 3);
  assert.equal(result.steps[3].text, "Created Ada");
  // A password field never reads back, not even through its value attribute.
  assert.equal(result.steps[4].value, "[redacted]");
  assert.equal(result.steps[4].attribute, "[redacted]");
  assert.ok(!JSON.stringify(result).includes("hunter2"));
  assert.equal(result.steps[5].url, "https://site.test/form");
  assert.deepEqual(result.page, { id: "page-1", url: "https://site.test/form", title: "Fake page" });
  assert.match(result.snapshot, /\[ref=e1\]/);
  assert.deepEqual(host.snapshots, [{ interactive: true, diff: false }]);
  assert.equal(result.proof.kind, "proof");
  assert.deepEqual(host.navigations, ["https://site.test/form"]);
  assert.equal(host.observedPages.length, 1);
  assert.ok(result.durationMs >= 0);
  // Steps ran back to back: no pacing calls, and the fill went straight in.
  assert.deepEqual(
    page.calls.filter((call) => ["goto", "fill", "click"].includes(call[0])).map((call) => call[0]),
    ["goto", "fill", "click"],
  );
});

test("a failed step stops the batch, keeps completed work, and still observes the page", async () => {
  const page = fakePage({
    "label:Name": [{ tag: "input", value: "" }],
    "role:button:Save": [{ tag: "button" }, { tag: "button" }],
  });
  const host = fakeHost(page);
  const result = await executeAgentBatch(
    host,
    [
      { id: "name", action: "fill", target: { label: "Name" }, value: "Ada" },
      { id: "save", action: "click", target: { role: "button", name: "Save" } },
      { id: "after", action: "read", target: { label: "Name" } },
    ],
    { allowWrites: true, proof: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.completed, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, {
    index: 1,
    id: "save",
    action: "click",
    error: 'AgentBatch step "save" target matched 2 elements; use a more precise target or nth.',
  });
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].ok, false);
  assert.match(result.snapshot, /page page-1/);
  // No proof of a task that did not finish.
  assert.equal(result.proof, undefined);
  assert.equal(host.screenshots.length, 0);
});

test("optional steps may fail without stopping, and observe:none skips the final snapshot", async () => {
  const page = fakePage({
    "role:button:Accept cookies": [],
    "text:Welcome": [{ tag: "h1", text: "Welcome back" }],
  });
  const host = fakeHost(page);
  const result = await executeAgentBatch(
    host,
    [
      { id: "cookies", action: "click", target: { role: "button", name: "Accept cookies" }, optional: true, timeoutMs: 100 },
      { id: "welcome", action: "wait", text: "Welcome" },
      { id: "shot", action: "screenshot", kind: "debug" },
    ],
    { allowWrites: true, observe: "none" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
  assert.equal(result.steps[0].ok, false);
  assert.match(result.steps[0].error, /Timeout/);
  assert.equal(result.steps[1].waited, "text");
  assert.equal(result.steps[2].screenshot.kind, "debug");
  assert.equal(result.snapshot, undefined);
  assert.equal(host.snapshots.length, 0);
  assert.equal(host.observedPages.length, 0);
});

test("password fields refuse fill and type unless the task supplied the password", async () => {
  const page = fakePage({
    "label:Password": [{ tag: "input", password: true, value: "" }],
  });
  const blocked = await executeAgentBatch(
    fakeHost(page),
    [{ id: "pw", action: "type", target: { label: "Password" }, value: "task-secret" }],
    { allowWrites: true, observe: "none" },
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.failed.error, /cannot type a password field/);
  assert.ok(!JSON.stringify(blocked).includes("task-secret"));
  assert.ok(!page.calls.some((call) => call[0] === "type"));

  const allowed = await executeAgentBatch(
    fakeHost(page),
    [{ id: "pw", action: "fill", target: { label: "Password" }, value: "task-secret" }],
    { allowWrites: true, allowPasswords: true, observe: "none" },
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.steps[0].filled, 11);
  assert.ok(!JSON.stringify(allowed).includes("task-secret"));
});

test("navigation steps pass every URL through the host's policy check", async () => {
  const page = fakePage({});
  const host = fakeHost(page);
  const result = await executeAgentBatch(
    host,
    [
      { id: "bad", action: "goto", url: "ftp://files.test/" },
      { id: "never", action: "reload" },
    ],
    { observe: "none" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.failed.id, "bad");
  assert.match(result.failed.error, /scheme is not available/);
  assert.deepEqual(host.navigations, ["ftp://files.test/"]);
  assert.ok(!page.calls.some((call) => call[0] === "goto" || call[0] === "reload"));
});

test("page, dialog, overlay, scroll, and select steps route through the host and page", async () => {
  const page = fakePage({
    "label:Plan": [{ tag: "select", value: "free" }],
    "#list": [{ tag: "ul" }],
    "li": [{ tag: "li", text: "one" }, { tag: "li", text: "two" }, { tag: "li", text: "three" }],
  });
  const host = fakeHost(page);
  const result = await executeAgentBatch(
    host,
    [
      { action: "dialog", response: "accept", promptText: "ok" },
      { action: "overlays" },
      { action: "select", target: { label: "Plan" }, value: "pro" },
      { action: "scroll", target: { css: "#list" } },
      { action: "scroll", dy: 800 },
      { action: "read", target: { css: "li" }, all: true },
      { action: "press", key: "Escape" },
      { action: "openPage", url: "https://site.test/other" },
      { action: "usePage", page: "page-1" },
      { action: "closePage" },
      { action: "back" },
    ],
    { allowWrites: true, observe: "diff", minIntervalMs: 1 },
  );
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  // The arm is dropped when the batch ends, so no later dialog inherits it.
  assert.deepEqual(host.dialogs, [["accept", "ok"], ["disarm"]]);
  assert.deepEqual(result.steps[1].dismissed, [{ kind: "cookie", label: "Reject all" }]);
  assert.deepEqual(result.steps[2].selected, ["pro"]);
  assert.equal(result.steps[3].scrolled, "target");
  assert.deepEqual(result.steps[4].scrolled, { dx: 0, dy: 800 });
  assert.equal(result.steps[5].count, 3);
  assert.deepEqual(result.steps[5].items.map((item) => item.text), ["one", "two", "three"]);
  assert.equal(result.steps[6].pressed, "Escape");
  assert.equal(result.steps[7].pageId, "page-1");
  assert.equal(result.steps[9].closed, true);
  assert.ok(page.calls.some((call) => call[0] === "keyboard" && call[1] === "Escape"));
  assert.ok(page.calls.some((call) => call[0] === "wheel" && call[2] === 800));
  assert.ok(page.calls.some((call) => call[0] === "back"));
  assert.deepEqual(host.snapshots, [{ interactive: true, diff: true }]);
});

test("an armed dialog response is cleared when the batch ends, even after a failure", async () => {
  const page = fakePage({ "role:button:Missing": [] });
  const host = fakeHost(page);
  const stopped = await executeAgentBatch(
    host,
    [
      { action: "dialog", response: "dismiss" },
      { action: "click", target: { role: "button", name: "Missing" }, timeoutMs: 100 },
    ],
    { allowWrites: true, observe: "none" },
  );
  assert.equal(stopped.ok, false);
  assert.deepEqual(host.dialogs, [["dismiss", undefined], ["disarm"]]);

  // A batch that armed nothing leaves the session's dialog state alone: a
  // response a snippet armed before calling the batch is still the snippet's.
  const untouched = fakeHost(page);
  await executeAgentBatch(untouched, [{ action: "reload" }], { observe: "none" });
  assert.deepEqual(untouched.dialogs, []);
});

test("a read with expect polls until the text arrives and fails with the last text seen", async () => {
  const status = { tag: "div", text: "Working" };
  const page = fakePage({ "role:status:": [status] });
  setTimeout(() => {
    status.text = "Finished";
  }, 120);
  const result = await executeAgentBatch(
    fakeHost(page),
    [{ id: "done", action: "read", target: { role: "status" }, expect: "Finished" }],
    { observe: "none" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].text, "Finished");

  status.text = "Working";
  const late = await executeAgentBatch(
    fakeHost(page),
    [{ id: "done", action: "read", target: { role: "status" }, expect: "Finished", timeoutMs: 150 }],
    { observe: "none" },
  );
  assert.equal(late.ok, false);
  assert.match(late.failed.error, /did not show expected text\/value "Finished" within 150ms; last text was "Working"/);
});

test("a snapshot failure is reported beside the batch outcome instead of hiding it", async () => {
  const page = fakePage({});
  const host = fakeHost(page);
  host.snapshot = async () => {
    throw new Error("Snapshot is 30000 chars, over the 10000 limit.");
  };
  const result = await executeAgentBatch(host, [{ action: "reload" }]);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot, undefined);
  assert.match(result.observeError, /over the 10000 limit/);
  assert.equal(host.observedPages.length, 0);
});

test("locatorFor scopes a target to exactly one frame", () => {
  const frames = [
    { url: () => "https://site.test/", name: () => "", getByLabel: () => "main" },
    { url: () => "https://pay.test/embed", name: () => "billing", getByLabel: () => "billing" },
  ];
  const page = { frames: () => frames, getByLabel: () => "page" };
  assert.equal(locatorFor(page, parseTarget({ label: "Card", frameName: "billing" }, labels), labels), "billing");
  assert.equal(locatorFor(page, parseTarget({ label: "Card", frameUrlIncludes: "pay.test" }, labels), labels), "billing");
  assert.equal(locatorFor(page, parseTarget({ label: "Card" }, labels), labels), "page");
  assert.throws(
    () => locatorFor(page, parseTarget({ label: "Card", frameUrlIncludes: "test" }, labels), labels),
    /frame matched 2 frames/,
  );
});
