import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chromium } from "playwright-core";
import { BetterwrightCdpTarget } from "../../dist/src/electron-cdp.js";
import { openBetterwrightConnection } from "../../dist/src/electron-connection.js";

function fixture(backend = "backend") {
  const events = [];
  const calls = [];
  let attached = true;
  let reply = async (_method, _params, _sessionId) => ({});
  let print = async (_options) => Buffer.from("%PDF-fixture");
  const debuggerEvents = new EventEmitter();
  const debuggerApi = Object.assign(debuggerEvents, {
    isAttached: () => attached,
    attach: () => { attached = true; },
    sendCommand: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return reply(method, params, sessionId);
    },
  });
  const target = new BetterwrightCdpTarget({
    debugger: debuggerApi,
    printToPDF: async options => { calls.push({ method: "native.printToPDF", params: options }); return print(options); },
    isDestroyed: () => false,
    getTitle: () => "Fixture",
    getURL: () => "https://example.com/",
  }, message => events.push(message), undefined, "target", new Set(), backend);
  let sequence = 0;
  async function command(method, params = {}, sessionId?) {
    const id = ++sequence;
    await target.receive({ id, method, params, sessionId });
    return events.find(event => event.id === id);
  }
  async function attach() {
    const response = await command("Target.attachToTarget", { targetId: "target" });
    return response.result.sessionId;
  }
  return {
    target, events, calls, command, attach, debuggerEvents,
    reply: handler => { reply = handler; },
    print: handler => { print = handler; },
    detach: () => { attached = false; debuggerEvents.emit("detach", {}, "target closed"); },
  };
}

async function bounded(operation, timeout = 250) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("operation did not settle")), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

test("PDF stream reads and closes only a handle issued to this target", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    const pdf = (await f.command("Page.printToPDF", { transferMode: "ReturnAsStream" }, session)).result.stream;
    assert.equal(Buffer.from((await f.command("IO.read", { handle: pdf }, session)).result.data, "base64").toString(), "%PDF-fixture");
    assert.ok((await f.command("IO.read", { handle: "foreign" }, session)).error);
    assert.ok((await f.command("IO.read", { handle: pdf })).error);
    assert.ok((await f.command("IO.resolveBlob", { objectId: "object" }, session)).error);
    assert.ok((await f.command("IO.close", { handle: pdf }, session)).result);
    assert.ok((await f.command("IO.read", { handle: pdf }, session)).error);
    assert.equal(f.calls.some(call => call.method.startsWith("IO.") || call.method === "Page.printToPDF"), false);
  } finally { await f.target.dispose(false); }
});

test("stream grants cannot cross leases or child sessions and dispose closes outstanding handles", async () => {
  const f = fixture();
  const other = fixture("other-backend");
  try {
    const session = await f.attach();
    const otherSession = await other.attach();
    f.reply(async method => method === "Network.loadNetworkResource" ? { resource: { stream: "resource" } } : {});
    f.debuggerEvents.emit("message", {}, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } }, "backend");
    await f.command("Network.loadNetworkResource", { url: "https://example.com/" }, "child");
    assert.ok((await f.command("IO.read", { handle: "resource" }, session)).error);
    assert.ok((await other.command("IO.read", { handle: "resource" }, otherSession)).error);
    assert.ok((await f.command("IO.read", { handle: "resource" }, "child")).result);
    await f.target.dispose(false);
    assert.deepEqual(f.calls.filter(call => call.method === "IO.close"), [{ method: "IO.close", params: { handle: "resource" }, sessionId: "child" }]);
  } finally { await f.target.dispose(false); await other.target.dispose(false); }
});

test("unrelated result fields cannot grant IO access", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    f.reply(async () => ({ stream: "forged" }));
    await f.command("Runtime.evaluate", { expression: "0" }, session);
    assert.ok((await f.command("IO.read", { handle: "forged" }, session)).error);
  } finally { await f.target.dispose(false); }
});

for (const mode of ["debugger", "backend"]) {
  test(`${mode} detach notifies all page sessions and settles pending commands`, async () => {
    const f = fixture();
    try {
      await f.command("Target.setAutoAttach", { autoAttach: true });
      const automatic = f.events.find(event => event.method === "Target.attachedToTarget").params.sessionId;
      const explicit = await f.attach();
      let started;
      const entered = new Promise(resolve => { started = resolve; });
      f.reply(async method => {
        if (method === "Runtime.evaluate") { started(); return new Promise(() => {}); }
        return {};
      });
      const pending = f.command("Runtime.evaluate", { expression: "pending" }, explicit);
      await entered;
      if (mode === "debugger") f.detach();
      else {
        f.debuggerEvents.emit("message", {}, "Target.detachedFromTarget", { sessionId: "unrelated" });
        assert.equal(f.events.filter(event => event.method === "Target.detachedFromTarget").length, 0);
        f.debuggerEvents.emit("message", {}, "Target.detachedFromTarget", { sessionId: "backend" });
      }
      assert.deepEqual(f.events.filter(event => event.method === "Target.detachedFromTarget").map(event => event.params.sessionId).sort(), [automatic, explicit].sort());
      assert.ok(f.events.filter(event => event.method === "Target.detachedFromTarget").every(event => event.params.targetId === "target"));
      assert.ok((await bounded(pending)).error);
      await bounded(f.target.dispose(false));
      assert.equal(f.debuggerEvents.listenerCount("message"), 0);
      assert.equal(f.debuggerEvents.listenerCount("detach"), 0);
    } finally { f.detach(); await f.target.dispose(false); }
  });
}

test("Fetch response streams receive the same bounded IO grant", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    f.reply(async method => method === "Fetch.takeResponseBodyAsStream" ? { stream: "body" } : {});
    await f.command("Fetch.takeResponseBodyAsStream", { requestId: "request" }, session);
    assert.ok((await f.command("IO.read", { handle: "body" }, session)).result);
    assert.ok((await f.command("IO.close", { handle: "foreign" }, session)).error);
  } finally { await f.target.dispose(false); }
});

test("a stream returned during disposal is closed without granting access", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    let deliver;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    f.print(async () => { started(); return new Promise(resolve => { deliver = resolve; }); });
    f.reply(async method => {
      if (method === "Fetch.disable") deliver(Buffer.from("%PDF-late"));
      return {};
    });
    const printing = f.command("Page.printToPDF", { transferMode: "ReturnAsStream" }, session);
    await entered;
    await bounded(f.target.dispose(false));
    await bounded(printing);
    assert.equal(f.events.some(event => event.result?.stream), false);
    assert.ok((await f.command("IO.read", { handle: "late" }, session)).error);
  } finally { f.detach(); await f.target.dispose(false); }
});

for (const mode of ["debugger", "backend"]) {
  test(`Playwright disconnects after ${mode} revocation and can reconnect to the surviving host target`, async () => {
    let attached = true;
    let generation = 0;
    const calls = [];
    const events = new EventEmitter();
    const contents = {
      printToPDF: async options => { calls.push({ method: "native.printToPDF", params: options }); return Buffer.from("%PDF-playwright-fixture"); },
      isDestroyed: () => false,
      getTitle: () => "Fixture",
      getURL: () => "https://example.com/",
      debugger: Object.assign(events, {
        isAttached: () => attached,
        attach: () => { attached = true; },
        sendCommand: async (method, params, sessionId) => {
          calls.push({ method, params, sessionId });
          if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "target" } };
          if (method === "Target.attachToTarget") return { sessionId: `backend-${++generation}` };
          if (method === "Browser.getVersion") return { product: "Chrome/140.0.0.0", revision: "test", userAgent: "Chrome/140.0.0.0" };
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "target", url: "https://example.com/", loaderId: "loader", securityOrigin: "https://example.com", mimeType: "text/html" } } };
          return {};
        },
      }),
    };
    let connection;
    let browser;
    try {
      connection = await openBetterwrightConnection(contents);
      browser = await chromium.connectOverCDP(connection.provider.cdpUrl, { headers: connection.provider.headers, noDefaults: true, timeout: 2000 });
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      assert.equal(context.pages().length, 1);
      assert.equal((await page.pdf({ width: "6in", height: "9in", margin: { top: "0.2in" } })).toString(), "%PDF-playwright-fixture");
      const printCall = calls.find(call => call.method === "native.printToPDF");
      assert.deepEqual(printCall.params.pageSize, { width: 6, height: 9 });
      assert.ok(Math.abs(printCall.params.margins.top - 0.2) < 1e-12);
      assert.equal(calls.some(call => call.method === "Page.printToPDF"), false);
      const disconnected = new Promise(resolve => browser.once("disconnected", resolve));
      const contextClosed = new Promise(resolve => context.once("close", resolve));
      const pageClosed = new Promise(resolve => page.once("close", resolve));
      if (mode === "debugger") {
        attached = false;
        events.emit("detach", {}, "target closed");
      } else events.emit("message", {}, "Target.detachedFromTarget", { sessionId: "backend-1", targetId: "target" });
      await bounded(Promise.all([disconnected, contextClosed, pageClosed]), 2000);
      assert.equal(browser.isConnected(), false);
      assert.equal(context.pages().length, 0);
      assert.equal(page.isClosed(), true);
      const closing = connection.close();
      assert.equal(connection.close(), closing);
      await bounded(closing, 2000);
      assert.equal(events.listenerCount("message"), 0);
      assert.equal(events.listenerCount("detach"), 0);
      assert.equal(contents.isDestroyed(), false);
      assert.equal(calls.some(call => ["Page.close", "Browser.close", "Page.crash"].includes(call.method)), false);
      connection = await openBetterwrightConnection(contents);
      browser = await chromium.connectOverCDP(connection.provider.cdpUrl, { headers: connection.provider.headers, noDefaults: true, timeout: 2000 });
      assert.equal(browser.isConnected(), true);
      assert.equal(browser.contexts()[0].pages().length, 1);
      assert.equal(browser.contexts()[0].pages()[0].isClosed(), false);
    } finally {
      await browser?.close();
      await connection?.close();
    }
  });
}

test("native PDF options preserve CDP inches, margins, templates and accessibility flags", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    const response = await f.command("Page.printToPDF", {
      paperWidth: 6, paperHeight: 9, scale: 0.8, marginTop: 0.1, marginBottom: 0.2, marginLeft: 0.3, marginRight: 0.4,
      landscape: true, printBackground: true, displayHeaderFooter: true, headerTemplate: "header", footerTemplate: "footer",
      pageRanges: "1-2", preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true,
    }, session);
    assert.equal(Buffer.from(response.result.data, "base64").toString(), "%PDF-fixture");
    assert.deepEqual(f.calls.find(call => call.method === "native.printToPDF").params, {
      pageSize: { width: 6, height: 9 }, scale: 0.8, margins: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 },
      landscape: true, printBackground: true, displayHeaderFooter: true, headerTemplate: "header", footerTemplate: "footer",
      pageRanges: "1-2", preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true,
    });
    const before = f.calls.length;
    for (const invalid of [{ paperWidth: 0 }, { scale: 3 }, { marginTop: -1 }, { paperHeight: Infinity }, { landscape: "true" }, { transferMode: "bad" }, { unknownOption: true }])
      assert.ok((await f.command("Page.printToPDF", invalid, session)).error);
    f.debuggerEvents.emit("message", {}, "Target.attachedToTarget", { sessionId: "child" }, "backend");
    assert.ok((await f.command("Page.printToPDF", {}, "child")).error);
    assert.equal(f.calls.length, before);
  } finally { await f.target.dispose(false); }
});

test("native PDF streams have bounded reads, offsets, EOF and per-lease ownership", async () => {
  const f = fixture();
  const other = fixture("other");
  try {
    const session = await f.attach();
    const otherSession = await other.attach();
    f.print(async () => Buffer.alloc(70000, 65));
    const handle = (await f.command("Page.printToPDF", { transferMode: "ReturnAsStream" }, session)).result.stream;
    const first = (await f.command("IO.read", { handle, size: 1000000 }, session)).result;
    assert.equal(Buffer.from(first.data, "base64").length, 65536);
    assert.equal(first.eof, false);
    const last = (await f.command("IO.read", { handle }, session)).result;
    assert.equal(Buffer.from(last.data, "base64").length, 4464);
    assert.equal(last.eof, true);
    assert.equal((await f.command("IO.read", { handle }, session)).result.data, "");
    assert.equal(Buffer.from((await f.command("IO.read", { handle, offset: 10, size: 5 }, session)).result.data, "base64").length, 5);
    for (const invalid of [{ offset: -1 }, { size: 0 }, { offset: 1.5 }, { size: Infinity }])
      assert.ok((await f.command("IO.read", { handle, ...invalid }, session)).error);
    assert.ok((await other.command("IO.read", { handle }, otherSession)).error);
    f.debuggerEvents.emit("message", {}, "Target.attachedToTarget", { sessionId: "child" }, "backend");
    assert.ok((await f.command("IO.read", { handle }, "child")).error);
    await f.target.dispose(false);
    assert.ok((await f.command("IO.read", { handle }, session)).error);
  } finally { await f.target.dispose(false); await other.target.dispose(false); }
});

test("native PDF rejects buffers beyond the artifact limit", async () => {
  const f = fixture();
  try {
    const session = await f.attach();
    f.print(async () => Buffer.alloc(100 * 1024 * 1024 + 1));
    assert.ok((await f.command("Page.printToPDF", { transferMode: "ReturnAsStream" }, session)).error);
  } finally { await f.target.dispose(false); }
});
