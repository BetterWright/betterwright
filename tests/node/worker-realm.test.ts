import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createSnippetPageEvents } from "../../dist/src/page-events.js";
import { createWorkerRealm } from "../../dist/src/worker-realm.js";

function makeRealmOperations(overrides = {}) {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-realm-"));
  const pageIds = new WeakMap();
  let nextPage = 0;
  const operations = createWorkerRealm({
    artifactsDir: () => artifactsDir,
    hostOwnedTarget: () => false,
    hostUploadFiles: () => undefined,
    publicSearchPolicy: () => "block",
    useSetContentCompatibility: () => false,
    stopPageRecording: async () => {},
    redactText: (value) => String(value ?? "").replaceAll("secret", "[redacted]"),
    redactDeep: (value) => value,
    pageId: (page) => {
      let id = pageIds.get(page);
      if (!id) {
        id = `page-${++nextPage}`;
        pageIds.set(page, id);
      }
      return id;
    },
    pageIds,
    defaultNavigationTimeoutMs: 30_000,
    maxResponsePages: 32,
    ...overrides,
  });
  return { artifactsDir, operations, pageIds };
}

function makeContext(operations) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "worker-realm-test",
    codeGeneration: { strings: false, wasm: false },
  });
  const realm = operations.createRealm(context, createSnippetPageEvents());
  Object.assign(sandbox, operations.createUrlGlobals(realm));
  return { context, realm, sandbox };
}

function namedObject(name, members = {}) {
  return Object.assign({ constructor: { name } }, members);
}

test("worker realm imports without worker entrypoint side effects", async () => {
  let readlineCalls = 0;
  const originalOn = process.stdin.on;
  process.stdin.on = function (...args) {
    readlineCalls += 1;
    return originalOn.apply(this, args);
  };
  try {
    await import(`../../dist/src/worker-realm.js?import-safety=${Date.now()}`);
  } finally {
    process.stdin.on = originalOn;
  }
  assert.equal(readlineCalls, 0);
});

test("realm functions and URL constructors cannot recover the host Function", () => {
  const { operations } = makeRealmOperations();
  const { context, realm } = makeContext(operations);
  context.hostFunction = realm.safeFunction(() => "ok");

  assert.equal(vm.runInContext("hostFunction()", context), "ok");
  assert.throws(
    () => vm.runInContext("hostFunction.constructor('return process')()", context),
    /Code generation from strings disallowed/,
  );
  assert.throws(
    () => vm.runInContext("URL.constructor('return process')()", context),
    /Code generation from strings disallowed/,
  );
  assert.throws(
    () => vm.runInContext("Function('return process')()", context),
    /Code generation from strings disallowed/,
  );
});

test("realm URL and URLSearchParams preserve mutation and iterable semantics", () => {
  const { operations } = makeRealmOperations();
  const { context } = makeContext(operations);
  const result = vm.runInContext(`(() => {
    const url = new URL('/start?a=1&a=2', 'https://user:pass@example.com:8443/base');
    const params = url.searchParams;
    params.delete('a', '1');
    params.append('space', 'a b');
    url.pathname = '/next';
    url.search = '?x=1&x=2';
    params.set('x', '3');
    const fromMap = new URLSearchParams(new Map([['z', '9']]));
    return {
      href: url.href,
      sameParams: params === url.searchParams,
      entries: [...params],
      encoded: String(new URLSearchParams({ lone: '\\ud800', space: 'a b' })),
      map: fromMap.toString(),
      canParse: URL.canParse('https://example.com'),
      badParse: URL.parse('not a url'),
      tag: Object.prototype.toString.call(url),
    };
  })()`, context);

  assert.deepEqual(structuredClone(result), {
    href: "https://user:pass@example.com:8443/next?x=3",
    sameParams: true,
    entries: [["x", "3"]],
    encoded: "lone=%EF%BF%BD&space=a+b",
    map: "z=9",
    canParse: true,
    badParse: null,
    tag: "[object URL]",
  });
});

test("wrapped objects keep forbidden methods and sensitive headers unavailable", async () => {
  const { operations } = makeRealmOperations();
  const { context, realm } = makeContext(operations);
  const request = namedObject("Request", {
    headers: () => ({ Cookie: "secret", Accept: "text/html", "Set-Cookie": "x=secret" }),
    allHeaders: () => ({ Cookie: "secret" }),
    headerValue: () => "secret",
    url: () => "https://example.com",
  });
  context.request = operations.wrap(request, realm);

  const result = await vm.runInContext(`(async () => ({
    constructor: request.constructor,
    on: request.on,
    allHeaders: request.allHeaders,
    headerValue: request.headerValue,
    hasHeaders: 'headers' in request,
    keys: Object.keys(request),
    headers: await request.headers(),
  }))()`, context);

  assert.equal(result.constructor, undefined);
  assert.equal(result.on, undefined);
  assert.equal(result.allHeaders, undefined);
  assert.equal(result.headerValue, undefined);
  assert.equal(result.hasHeaders, true);
  assert.equal(result.keys.includes("allHeaders"), false);
  assert.equal(result.keys.includes("headerValue"), false);
  assert.equal(result.headers.Accept, "text/html");
  assert.deepEqual(Object.keys(result.headers), ["Accept"]);
});

test("wrapped navigation validates schemes, public search, host ownership, and write paths", async () => {
  let hostOwned = false;
  let publicSearchPolicy = "block";
  const { artifactsDir, operations } = makeRealmOperations({
    hostOwnedTarget: () => hostOwned,
    publicSearchPolicy: () => publicSearchPolicy,
  });
  const { realm } = makeContext(operations);
  const calls = [];
  const page = namedObject("Page", {
    goto: async (...args) => {
      calls.push(args);
      return null;
    },
    close: async () => {},
    pdf: async () => {},
  });
  const wrapped = operations.wrap(page, realm);

  assert.throws(() => wrapped.goto("file:///etc/passwd"), /scheme is not available: file:/);
  assert.throws(() => wrapped.goto("https://www.google.com/search?q=test"), /Public search-result UI automation/);
  publicSearchPolicy = "allow";
  await wrapped.goto("https://www.google.com/search?q=test");
  assert.deepEqual(calls, [[
    "https://www.google.com/search?q=test",
    { waitUntil: "domcontentloaded" },
  ]]);

  assert.throws(
    () => wrapped.pdf({ path: path.join(artifactsDir, "..", "escape.pdf") }),
    /artifactPath/,
  );
  await wrapped.pdf({ path: path.join(artifactsDir, "inside.pdf") });
  hostOwned = true;
  assert.throws(() => wrapped.close(), /Host-owned tabs/);
});

test("setContent compatibility bypasses the driver method and keeps waitUntil validation", async () => {
  let compatibility = true;
  let driverCalls = 0;
  const evaluations = [];
  const { operations } = makeRealmOperations({
    useSetContentCompatibility: () => compatibility,
  });
  const { realm } = makeContext(operations);
  const page = namedObject("Page");
  const frame = namedObject("Frame", {
    page: () => page,
    _navigationTimeout: () => 100,
    evaluate: async (_callback, argument) => {
      evaluations.push(argument);
    },
  });
  Object.assign(page, {
    mainFrame: () => frame,
    setContent: async () => {
      driverCalls += 1;
    },
  });
  const wrapped = operations.wrap(page, realm);

  await wrapped.setContent("<p>ok</p>", { waitUntil: "commit" });
  assert.equal(driverCalls, 0);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].markup, "<p>ok</p>");
  assert.equal(evaluations[0].expected, "commit");
  await assert.rejects(
    wrapped.setContent("<p>bad</p>", { waitUntil: "invalid" }),
    /Unsupported setContent waitUntil value/,
  );

  compatibility = false;
  await wrapped.setContent("<p>driver</p>");
  assert.equal(driverCalls, 1);
});

test("facades unwrap for page handles and summaries redact without exposing internals", async () => {
  const { operations, pageIds } = makeRealmOperations();
  const { realm } = makeContext(operations);
  const page = namedObject("Page", {
    evaluate: async () => "secret title",
    title: async () => "fallback",
    url: () => "https://example.com/secret",
    isClosed: () => false,
  });
  pageIds.set(page, "page-known");
  const facade = operations.wrap(page, realm);

  assert.notEqual(facade, page);
  assert.equal(operations.unwrapTarget(facade), page);
  operations.assertPageHandle(facade, "usePage");
  assert.equal(operations.findPageEntry([["page-known", page]], facade)?.[0], "page-known");
  assert.equal(operations.describePageHandle(facade), "page object page-known");
  assert.throws(
    () => operations.assertPageHandle({}, "usePage"),
    /page handle must be a page ID string, numeric index, or page object/,
  );
  assert.deepEqual(await operations.summarize(facade), {
    type: "Page",
    pageId: "page-known",
    url: "https://example.com/[redacted]",
    title: "[redacted] title",
    closed: false,
  });
});
