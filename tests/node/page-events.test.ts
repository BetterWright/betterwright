import assert from "node:assert/strict";
import test from "node:test";

import {
  createSnippetPageEvents,
  isSnippetPageEventMethod,
  MAX_SNIPPET_PAGE_LISTENERS,
  SNIPPET_PAGE_EVENTS,
  snippetPageEventError,
} from "../../dist/src/page-events.js";

class FakePage {
  listeners = new Map();

  on(event, fn) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  off(event, fn) {
    const list = (this.listeners.get(event) || []).filter((handler) => handler !== fn);
    this.listeners.set(event, list);
    return this;
  }

  emit(event, payload) {
    for (const handler of [...(this.listeners.get(event) || [])]) handler(payload);
  }
}

test("only Page event methods are treated as the snippet-safe surface", () => {
  assert.equal(isSnippetPageEventMethod("Page", "on"), true);
  assert.equal(isSnippetPageEventMethod("Page", "once"), true);
  assert.equal(isSnippetPageEventMethod("Page", "off"), true);
  assert.equal(isSnippetPageEventMethod("Page", "addListener"), true);
  assert.equal(isSnippetPageEventMethod("Page", "removeListener"), true);
  assert.equal(isSnippetPageEventMethod("Page", "removeAllListeners"), false);
  assert.equal(isSnippetPageEventMethod("Page", "prependListener"), false);
  assert.equal(isSnippetPageEventMethod("Page", "route"), false);
  assert.equal(isSnippetPageEventMethod("BrowserContext", "on"), false);
  assert.equal(isSnippetPageEventMethod("Request", "on"), false);
  assert.equal(isSnippetPageEventMethod("Frame", "on"), false);
});

test("the dispatcher rejects every Playwright event except console and pageerror", () => {
  const events = createSnippetPageEvents();
  const page = new FakePage();
  const listener = () => {};
  for (const event of [
    "request",
    "response",
    "requestfailed",
    "dialog",
    "download",
    "popup",
    "close",
    "crash",
    "websocket",
    "filechooser",
  ]) {
    assert.throws(
      () => events.dispatch(page, "on", event, listener, (value) => value),
      /can only listen for console and pageerror/,
    );
  }
  assert.throws(
    () => events.dispatch(page, "on", "console", "not-a-function", (value) => value),
    /listener must be a function/,
  );
  assert.equal(page.listeners.size, 0);
  assert.deepEqual([...SNIPPET_PAGE_EVENTS], ["console", "pageerror"]);
});

test("console and pageerror listeners adopt payloads and support once/off", () => {
  const events = createSnippetPageEvents();
  const page = new FakePage();
  const seen = [];
  const adopt = (payload) => ({ adopted: payload });
  const listener = (payload) => seen.push(payload);

  events.dispatch(page, "on", "console", listener, adopt);
  page.emit("console", "first");
  assert.deepEqual(seen, [{ adopted: "first" }]);
  assert.equal(page.listeners.get("console")?.length, 1);

  events.dispatch(page, "off", "console", listener, adopt);
  page.emit("console", "ignored");
  assert.deepEqual(seen, [{ adopted: "first" }]);
  assert.equal(page.listeners.get("console")?.length, 0);

  events.dispatch(page, "once", "pageerror", listener, adopt);
  page.emit("pageerror", "boom");
  page.emit("pageerror", "again");
  assert.deepEqual(seen, [{ adopted: "first" }, { adopted: "boom" }]);
  assert.equal(page.listeners.get("pageerror")?.length, 0);
});

test("addListener aliases on and a throwing listener does not stop siblings", () => {
  const events = createSnippetPageEvents();
  const page = new FakePage();
  const seen = [];
  events.dispatch(page, "addListener", "console", () => {
    throw new Error("listener failed");
  }, (value) => value);
  events.dispatch(page, "on", "console", (value) => seen.push(value), (value) => value);
  page.emit("console", "kept");
  assert.deepEqual(seen, ["kept"]);
});

test("detachAll removes the worker-owned dispatcher and ignores later emits", () => {
  const events = createSnippetPageEvents();
  const page = new FakePage();
  const seen = [];
  events.dispatch(page, "on", "console", (value) => seen.push(value), (value) => value);
  events.detachAll();
  page.emit("console", "after");
  assert.deepEqual(seen, []);
  assert.equal(page.listeners.get("console")?.length, 0);
  assert.equal(events.size, 0);
});

test("the per-run listener cap is enforced and detachAll resets it", () => {
  const events = createSnippetPageEvents();
  const page = new FakePage();
  for (let index = 0; index < MAX_SNIPPET_PAGE_LISTENERS; index += 1) {
    events.dispatch(page, "on", "console", () => {}, (value) => value);
  }
  assert.throws(
    () => events.dispatch(page, "on", "console", () => {}, (value) => value),
    /listener limit/,
  );
  events.detachAll();
  events.dispatch(page, "on", "pageerror", () => {}, (value) => value);
  assert.equal(events.size, 1);
  assert.equal(
    snippetPageEventError("on", "request").message.includes("request"),
    true,
  );
});
