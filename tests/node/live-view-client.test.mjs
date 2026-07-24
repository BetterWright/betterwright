import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveAccountApiKey } from "../../src/account-config.mjs";
import { BetterWright } from "../../src/client.mjs";
import { saveLiveViewSettings } from "../../src/live-view-config.mjs";

function mockClient(home, options = {}) {
  const browser = new BetterWright({ home, vault: false, ...options });
  const messages = [];
  browser._prepare = async () => ({ mocked: true });
  browser._dispatch = async (message) => {
    messages.push(message);
    if (message.type !== "live_view_start") return { ok: true };
    const session = String(message.options.session || "default");
    return {
      ok: true,
      running: true,
      transport: message.options.transport,
      expose: message.options.expose,
      host: message.options.host,
      port: 4321,
      token: "local-token",
      url: "http://127.0.0.1:4321/?t=local-token",
      session,
    };
  };
  return { browser, messages };
}

test("client construction fails closed on an invalid explicit environment key", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-key-"));
  const previous = process.env.BETTERWRIGHT_API_KEY;
  try {
    saveAccountApiKey(`bw_live_${"a".repeat(16)}_${"b".repeat(43)}`, { home });
    process.env.BETTERWRIGHT_API_KEY = "invalid-explicit-key";
    assert.throws(
      () => new BetterWright({ home, vault: false }),
      /refusing to fall back/i,
    );
  } finally {
    if (previous === undefined) delete process.env.BETTERWRIGHT_API_KEY;
    else process.env.BETTERWRIGHT_API_KEY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("explicit direct bind options beat a persisted relay and remain idempotent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-client-"));
  try {
    saveLiveViewSettings({ transport: "relay", expose: "local" }, home);
    const { browser, messages } = mockClient(home);

    await browser.startLiveView({ host: "127.0.0.1", session: "private-a" });
    assert.equal(messages[0].options.transport, "direct");
    assert.equal(messages[0].options.session, "private-a");
    assert.equal(messages[0].options.host, "127.0.0.1");
    assert.equal(messages[0].options.expose, undefined);

    await browser.startLiveView();
    assert.equal(messages[1].options.transport, "direct");
    assert.equal(messages[1].options.session, "private-a");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("constructor host defaults override a lower persisted exposure preset", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-constructor-"));
  try {
    saveLiveViewSettings({ transport: "relay", expose: "local" }, home);
    const { browser, messages } = mockClient(home, {
      liveView: { host: "0.0.0.0" },
    });
    await browser.startLiveView({ session: "constructor" });
    assert.equal(messages[0].options.transport, "direct");
    assert.equal(messages[0].options.host, "0.0.0.0");
    assert.equal(messages[0].options.expose, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("browser.liveView mutations remain explicit compatibility overrides", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-mutable-"));
  try {
    saveLiveViewSettings({ transport: "relay", expose: "local" }, home);
    const { browser, messages } = mockClient(home);
    browser.liveView.host = "127.0.0.1";
    browser.liveView.port = 6789;

    await browser.startLiveView({ session: "mutable" });
    assert.equal(messages[0].options.transport, "direct");
    assert.equal(messages[0].options.host, "127.0.0.1");
    assert.equal(messages[0].options.port, 6789);
    assert.equal(messages[0].options.expose, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("removed file settings do not stick in the mutable Live View surface", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-refresh-"));
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ liveView: { transport: "direct", port: 7100 } }),
    );
    const { browser, messages } = mockClient(home);
    fs.rmSync(path.join(home, "config.json"));

    await browser.startLiveView();
    assert.equal(messages[0].options.port, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("terminal worker events clear only the matching client restore state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-ended-"));
  try {
    const { browser } = mockClient(home);
    const child = {};
    browser._process = child;
    browser._liveViewRestore = {
      options: { transport: "relay", session: "private-a", relayRestore: {} },
      generation: 1,
    };

    assert.equal(
      browser._handleLiveViewEnded({ session: "other-b" }, child),
      false,
    );
    assert.ok(browser._liveViewRestore);
    assert.equal(
      browser._handleLiveViewEnded({ session: "private-a" }, child),
      true,
    );
    assert.equal(browser._liveViewRestore, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("omitted chat and human-turn sessions use the currently bound Live View session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-live-chat-"));
  try {
    const { browser, messages } = mockClient(home);
    await browser.startLiveView({ session: "private-a" });
    browser._process = { exitCode: null };

    await browser.liveViewPostChat({ text: "step" });
    await browser.liveViewDrainChat();
    const posted = messages.find((message) => message.type === "live_view_chat_post");
    const drained = messages.find((message) => message.type === "live_view_chat_drain");
    assert.equal(posted.sessionId, "private-a");
    assert.equal(drained.sessionId, "private-a");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
