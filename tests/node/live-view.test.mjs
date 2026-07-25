import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createLiveViewServer, guessTailscaleHost } from "../../dist/src/live-view.js";
import { liveViewHtml, liveViewLoginHtml } from "../../dist/src/live-view-html.js";
import { makeTempDir } from "./helpers/temp-dir.mjs";

function fakePage(url = "https://example.com/") {
  const listeners = new Map();
  return {
    _url: url,
    isClosed: () => false,
    url() {
      return this._url;
    },
    title: async () => "Example",
    on(event, handler) {
      listeners.set(event, handler);
    },
    off(event) {
      listeners.delete(event);
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
  };
}

function fakeCdp(respond = {}) {
  const calls = [];
  const handlers = new Map();
  return {
    calls,
    on(event, handler) {
      handlers.set(event, handler);
    },
    async send(method, params) {
      calls.push({ method, params });
      return typeof respond[method] === "function" ? respond[method](params) : respond[method];
    },
    async detach() {
      calls.push({ method: "detach" });
    },
    emitFrame(data, metadata) {
      handlers.get("Page.screencastFrame")?.({
        data: data.toString("base64"),
        metadata,
        sessionId: 7,
      });
    },
  };
}

function makeServer({ pages, cdp, newCDPSession, preferredPage, html, loginHtml } = {}) {
  const activity = [];
  const pageList = pages || [{ id: "page-1", page: fakePage(), sessionId: "default", active: true }];
  const session = cdp || fakeCdp();
  const server = createLiveViewServer({
    html: html || (() => "<!doctype html><title>viewer</title>"),
    loginHtml,
    listPages: () => pageList,
    preferredPage: preferredPage || (() => null),
    newCDPSession: newCDPSession || (async () => session),
    onHumanActivity: (page) => activity.push(page),
  });
  return { server, cdp: session, pages: pageList, activity };
}

async function startedServer(options = {}) {
  const parts = makeServer(options);
  const info = await parts.server.start({
    host: "127.0.0.1",
    port: 0,
    interactive: options.interactive !== false,
  });
  assert.ok(info.ok && info.url && info.token);
  return { ...parts, info };
}

function connect(info) {
  const base = new URL(info.url);
  const client = new WebSocket(`ws://${base.host}/ws?t=${info.token}`);
  client.binaryType = "arraybuffer";
  return once(client, "open").then(() => client);
}

function nextMessage(client, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 2_000);
    const onMessage = (event) => {
      let value = event.data;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          return;
        }
      } else {
        value = Buffer.from(value);
      }
      if (!predicate(value)) return;
      clearTimeout(timer);
      client.removeEventListener("message", onMessage);
      resolve(value);
    };
    client.addEventListener("message", onMessage);
  });
}

test("HTTP requests require the exact token; the page never caches", async () => {
  const { server, info } = await startedServer();
  try {
    const good = await fetch(info.url);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(good.headers.get("referrer-policy"), "no-referrer");
    assert.match(await good.text(), /viewer/);

    const base = new URL(info.url);
    for (const bad of ["", "?t=wrong", `?t=${info.token.slice(0, -2)}`]) {
      const response = await fetch(`http://${base.host}/${bad}`);
      assert.equal(response.status, 404);
    }
    const wrongPath = await fetch(`http://${base.host}/other?t=${info.token}`);
    assert.equal(wrongPath.status, 404);
  } finally {
    await server.stop();
  }
});

// Every other test stubs `html` to stay focused on the protocol; these two
// serve the real 40KB viewer/login templates from live-view-html.mjs so a
// broken template (unbalanced script, leaked template literal, missing WS
// bootstrap) can no longer ship green.
function assertWellFormedPage(body) {
  const opens = (body.match(/<script/g) || []).length;
  const closes = (body.match(/<\/script>/g) || []).length;
  assert.ok(opens > 0, "the page must carry its inline client script");
  assert.equal(opens, closes, "unbalanced <script> tags would kill the client JS");
  assert.ok(!body.includes("${"), "a leftover template placeholder reached the browser");
  assert.match(body, /<title>BetterWright — Live View<\/title>/);
}

test("the real viewer page serves intact and bootstraps the websocket", async () => {
  const { server, info } = await startedServer({ html: liveViewHtml });
  try {
    const response = await fetch(info.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await response.text();
    assertWellFormedPage(body);
    // The client must reconnect to /ws with the capability token it was
    // served under — without this string the viewer renders but never paints.
    assert.ok(body.includes("/ws?t="), "viewer must carry the WS bootstrap");
  } finally {
    await server.stop();
  }
});

test("the real login page serves intact and posts back to /login", async () => {
  const { server } = makeServer({ html: liveViewHtml, loginHtml: liveViewLoginHtml });
  try {
    const info = await server.start({
      host: "127.0.0.1",
      port: 0,
      password: "hunter22",
    });
    const gate = await fetch(info.url);
    assert.equal(gate.status, 200);
    const body = await gate.text();
    assertWellFormedPage(body);
    // The gate must be the branded login form, not the viewer: a password
    // field posting to /login, and none of the viewer's WS machinery.
    assert.match(body, /<form[^>]*method="post"/);
    assert.match(body, /name="password"/);
    assert.ok(body.includes('"/login?t="'), "the form must target /login with the token");
    assert.ok(!body.includes("/ws?t="), "the locked gate must not leak the viewer bootstrap");

    // After authenticating, the same URL serves the real viewer.
    const base = new URL(info.url);
    const login = await fetch(`http://${base.host}/login?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter22",
      redirect: "manual",
    });
    const cookie = String(login.headers.get("set-cookie")).split(";")[0];
    const page = await fetch(info.url, { headers: { cookie } });
    const viewer = await page.text();
    assertWellFormedPage(viewer);
    assert.ok(viewer.includes("/ws?t="));
  } finally {
    await server.stop();
  }
});

test("WS upgrade enforces token and same-host origin", async () => {
  const { server, info } = await startedServer();
  try {
    const base = new URL(info.url);
    // Wrong token: connection must fail.
    const badToken = new WebSocket(`ws://${base.host}/ws?t=nope`);
    const badTokenResult = await new Promise((resolve) => {
      badToken.addEventListener("open", () => resolve("open"), { once: true });
      badToken.addEventListener("error", () => resolve("error"), { once: true });
      badToken.addEventListener("close", () => resolve("error"), { once: true });
    });
    assert.equal(badTokenResult, "error");

    // Good token connects and receives hello state.
    const client = await connect(info);
    const hello = await nextMessage(client, (message) => message.t === "hello");
    assert.equal(hello.interactive, true);
    client.close();
  } finally {
    await server.stop();
  }
});

test("screencast frames broadcast as binary; meta announces dimensions", async () => {
  const { server, info, cdp } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    // Wait until the fake screencast attach happened.
    const deadline = Date.now() + 2_000;
    while (!cdp.calls.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const start = cdp.calls.find((call) => call.method === "Page.startScreencast");
    assert.equal(start.params.format, "jpeg");

    const metaPromise = nextMessage(client, (message) => message.t === "meta");
    const framePromise = nextMessage(client, (message) => Buffer.isBuffer(message));
    cdp.emitFrame(Buffer.from("jpeg-bytes"), { deviceWidth: 1440, deviceHeight: 900 });
    const meta = await metaPromise;
    assert.equal(meta.deviceWidth, 1440);
    assert.equal(meta.deviceHeight, 900);
    assert.deepEqual([...(await framePromise)], [...Buffer.from("jpeg-bytes")]);
    // Every frame is acked regardless of viewer backpressure.
    assert.ok(cdp.calls.some((call) => call.method === "Page.screencastFrameAck"));
    client.close();
  } finally {
    await server.stop();
  }
});

test("interactive input dispatches through CDP and reports human activity", async () => {
  const { server, info, cdp, activity, pages } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    client.send(
      JSON.stringify({
        t: "input",
        kind: "mouse",
        type: "mousePressed",
        x: 100.5,
        y: 60,
        button: "left",
        buttons: 1,
        clickCount: 1,
      }),
    );
    client.send(
      JSON.stringify({ t: "input", kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a" }),
    );
    client.send(JSON.stringify({ t: "input", kind: "insertText", text: "pasted" }));
    const deadline = Date.now() + 2_000;
    while (
      !cdp.calls.some((call) => call.method === "Input.insertText") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));

    const mouse = cdp.calls.find((call) => call.method === "Input.dispatchMouseEvent");
    assert.equal(mouse.params.type, "mousePressed");
    assert.equal(mouse.params.x, 100.5);
    assert.equal(mouse.params.button, "left");
    const keyboard = cdp.calls.find((call) => call.method === "Input.dispatchKeyEvent");
    assert.equal(keyboard.params.key, "a");
    assert.equal(keyboard.params.windowsVirtualKeyCode, 65);
    assert.equal(keyboard.params.text, "a");
    const insert = cdp.calls.find((call) => call.method === "Input.insertText");
    assert.equal(insert.params.text, "pasted");
    assert.ok(activity.includes(pages[0].page));
    client.close();
  } finally {
    await server.stop();
  }
});

test("watch-only servers reject input server-side", async () => {
  const { server, info, cdp } = await startedServer({ interactive: false });
  try {
    const client = await connect(info);
    const hello = await nextMessage(client, (message) => message.t === "hello");
    assert.equal(hello.interactive, false);
    client.send(
      JSON.stringify({ t: "input", kind: "mouse", type: "mousePressed", x: 1, y: 1, button: "left" }),
    );
    const toast = await nextMessage(client, (message) => message.t === "toast");
    assert.match(toast.text, /watch-only/);
    assert.ok(!cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));
    client.close();
  } finally {
    await server.stop();
  }
});

test("handoff resolves on the viewer's done (and forces input on watch-only)", async () => {
  const { server, info, cdp } = await startedServer({ interactive: false });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    const outcome = server.beginHandoff("Approve the MFA prompt", { timeoutMs: 60_000 });
    const state = await nextMessage(client, (message) => message.t === "state");
    assert.equal(state.agent, "handoff");
    assert.equal(state.interactive, true);
    assert.equal(state.handoff.prompt, "Approve the MFA prompt");

    // Input is allowed during the handoff even on a watch-only server.
    client.send(
      JSON.stringify({ t: "input", kind: "mouse", type: "mousePressed", x: 5, y: 5, button: "left" }),
    );
    const deadline = Date.now() + 2_000;
    while (
      !cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));

    client.send(JSON.stringify({ t: "done", note: "approved it" }));
    assert.deepEqual(await outcome, { action: "done", note: "approved it" });
    client.close();
  } finally {
    await server.stop();
  }
});

test("handoff cancel and timeout resolve distinctly; only one handoff at a time", async () => {
  const { server, info } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");

    const first = server.beginHandoff("step one", { timeoutMs: 60_000 });
    await assert.rejects(
      () => server.beginHandoff("step two", { timeoutMs: 60_000 }),
      /already in progress/,
    );
    client.send(JSON.stringify({ t: "cancel", note: "not now" }));
    assert.deepEqual(await first, { action: "cancel", note: "not now" });

    const timed = server.beginHandoff("step three", { timeoutMs: 50 });
    assert.deepEqual(await timed, { action: "timeout", note: "" });
    client.close();
  } finally {
    await server.stop();
  }
});

test("stop resolves a pending handoff as cancel and says bye to viewers", async () => {
  const { server, info } = await startedServer();
  const client = await connect(info);
  await nextMessage(client, (message) => message.t === "hello");
  const pending = server.beginHandoff("stopping soon", { timeoutMs: 60_000 });
  const bye = nextMessage(client, (message) => message.t === "bye");
  await server.stop();
  assert.equal((await pending).action, "cancel");
  assert.equal((await bye).reason, "stopped");
  assert.equal(server.status().running, false);
});

test("start is idempotent and reports alreadyRunning; status counts viewers", async () => {
  const { server, info } = await startedServer();
  try {
    const again = await server.start({ host: "127.0.0.1", port: 0 });
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.url, info.url);
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    assert.equal(server.status().viewers, 1);
    client.close();
  } finally {
    await server.stop();
  }
});

test("stop releases the listener even when CDP teardown hangs", async () => {
  // A dead browser transport: Page.stopScreencast never settles. stop() must
  // still close the server promptly instead of leaking the worker.
  const cdp = fakeCdp({ "Page.stopScreencast": () => new Promise(() => {}) });
  const { server, info } = await startedServer({ cdp });
  const client = await connect(info);
  await nextMessage(client, (message) => message.t === "hello");
  const deadline = Date.now() + 2_000;
  while (!cdp.calls.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));

  const began = Date.now();
  await server.stop();
  assert.ok(Date.now() - began < 5_000, "stop() must not hang on CDP teardown");
  assert.equal(server.status().running, false);
  await assert.rejects(() => fetch(info.url));
});

test("tab previews use native scale, are cached, and broadcast as per-tab deltas", async () => {
  const shot = Buffer.from("tiny-thumb").toString("base64");
  const cdp = fakeCdp({
    "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
    "Page.captureScreenshot": { data: shot },
  });
  const pages = [
    { id: "page-1", page: fakePage("https://one.example/"), sessionId: "default", active: true },
    { id: "page-2", page: fakePage("https://two.example/"), sessionId: "default", active: false },
  ];
  const { server, info } = await startedServer({ pages, cdp });
  try {
    const client = await connect(info);
    const thumbMessages = [];
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const value = JSON.parse(event.data);
        if (value.t === "thumb") thumbMessages.push(value);
      } catch {
        /* binary or partial */
      }
    });
    const tabsMessage = await nextMessage(
      client,
      (value) => value.t === "tabs" && value.tabs.length === 2,
    );
    // The tab list carries no pixels; thumbnails arrive as separate deltas.
    assert.ok(tabsMessage.tabs.every((tab) => tab.thumb === undefined));
    // The delta can share a TCP chunk with the tabs message, so poll the
    // collector instead of racing a late-attached listener.
    const deadline = Date.now() + 2_000;
    while (thumbMessages.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const thumb = thumbMessages[0];
    // Never capture the streamed tab: doing so can perturb its live surface.
    assert.equal(thumb.id, "page-2");
    assert.equal(thumb.thumb, `data:image/jpeg;base64,${shot}`);
    const capture = cdp.calls.find((call) => call.method === "Page.captureScreenshot");
    assert.equal(capture.params.format, "jpeg");
    // A scaled screenshot can leave Chromium's page surface at that scale,
    // making a later live screencast collapse to 320px.
    assert.equal(capture.params.clip.scale, 1);

    // A forced refresh reuses the cached preview: native-scale captures are
    // intentionally bounded to one per background stint.
    const before = thumbMessages.length;
    const capturesBefore = cdp.calls.filter(
      (call) => call.method === "Page.captureScreenshot",
    ).length;
    client.send(JSON.stringify({ t: "refresh" }));
    await nextMessage(client, (value) => value.t === "tabs");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(thumbMessages.length, before);
    assert.equal(
      cdp.calls.filter((call) => call.method === "Page.captureScreenshot").length,
      capturesBefore,
    );
    client.close();
  } finally {
    await server.stop();
  }
});

test("a background preview cannot collapse a later live stream to 320x192", async () => {
  const page1 = fakePage("https://one.example/");
  const page2 = fakePage("https://two.example/");
  const pages = [
    { id: "page-1", page: page1, sessionId: "default", active: true },
    { id: "page-2", page: page2, sessionId: "default", active: false },
  ];
  const surfaces = new Map([
    [page1, { width: 1280, height: 768 }],
    [page2, { width: 1280, height: 768 }],
  ]);
  const sessions = [];
  const shot = Buffer.from("preview").toString("base64");
  const newCDPSession = async (page) => {
    const surface = surfaces.get(page);
    const cdp = fakeCdp({
      "Page.getLayoutMetrics": {
        cssLayoutViewport: { clientWidth: surface.width, clientHeight: surface.height },
      },
      "Page.captureScreenshot": (params) => {
        // Model Chromium's problematic retained capture surface.
        surface.width = Math.round(params.clip.width * params.clip.scale);
        surface.height = Math.round(params.clip.height * params.clip.scale);
        return { data: shot };
      },
    });
    sessions.push({ page, cdp });
    return cdp;
  };
  const { server, info } = await startedServer({ pages, newCDPSession });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    const previewDeadline = Date.now() + 2_000;
    while (
      !sessions.some(
        ({ page, cdp }) =>
          page === page2 &&
          cdp.calls.some((call) => call.method === "Page.captureScreenshot"),
      ) &&
      Date.now() < previewDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(surfaces.get(page2), { width: 1280, height: 768 });

    client.send(JSON.stringify({ t: "tab", id: "page-2" }));
    await nextMessage(
      client,
      (message) =>
        message.t === "tabs" &&
        message.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
    );
    const live = sessions.findLast(
      ({ page, cdp }) =>
        page === page2 &&
        cdp.calls.some((call) => call.method === "Page.startScreencast"),
    );
    assert.ok(live);
    const metaPromise = nextMessage(
      client,
      (message) => message.t === "meta" && message.pageId === "page-2",
    );
    live.cdp.emitFrame(Buffer.from("full-frame"), {
      deviceWidth: surfaces.get(page2).width,
      deviceHeight: surfaces.get(page2).height,
    });
    const meta = await metaPromise;
    assert.equal(meta.deviceWidth, 1280);
    assert.equal(meta.deviceHeight, 768);
    client.close();
  } finally {
    await server.stop();
  }
});

test("a connecting viewer immediately receives the latest frame", async () => {
  const { server, info, cdp } = await startedServer();
  try {
    const first = await connect(info);
    await nextMessage(first, (message) => message.t === "hello");
    const deadline = Date.now() + 2_000;
    while (!cdp.calls.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const framePromise = nextMessage(first, (message) => Buffer.isBuffer(message));
    cdp.emitFrame(Buffer.from("frame-one"), { deviceWidth: 1280, deviceHeight: 800 });
    await framePromise;

    // No new page damage, yet the second viewer paints instantly.
    const second = await connect(info);
    const replay = await nextMessage(second, (message) => Buffer.isBuffer(message));
    assert.deepEqual([...replay], [...Buffer.from("frame-one")]);
    first.close();
    second.close();
  } finally {
    await server.stop();
  }
});

test("hidden viewers skip frames and repaint from the latest on return", async () => {
  const { server, info, cdp } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    const deadline = Date.now() + 2_000;
    while (!cdp.calls.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));

    const binaries = [];
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") binaries.push(Buffer.from(event.data));
    });
    client.send(JSON.stringify({ t: "vis", hidden: true }));
    // The refresh round-trip proves the server processed the vis message.
    client.send(JSON.stringify({ t: "refresh" }));
    await nextMessage(client, (message) => message.t === "tabs");
    assert.equal(binaries.length, 0);

    cdp.emitFrame(Buffer.from("hidden-frame"), { deviceWidth: 1280, deviceHeight: 800 });
    client.send(JSON.stringify({ t: "vis", hidden: false }));
    const replay = await nextMessage(client, (message) => Buffer.isBuffer(message));
    assert.deepEqual([...replay], [...Buffer.from("hidden-frame")]);
    // Exactly one delivery: the frame was skipped while hidden, replayed once.
    assert.equal(binaries.length, 1);
    client.close();
  } finally {
    await server.stop();
  }
});

test("tab switch starts the new screencast before stopping the old one", async () => {
  const log = [];
  let counter = 0;
  const newCDPSession = async () => {
    const session = fakeCdp();
    counter += 1;
    const index = counter;
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      log.push({ session: index, method });
      return send(method, params);
    };
    return session;
  };
  const pages = [
    { id: "page-1", page: fakePage("https://one.example/"), sessionId: "default", active: true },
    { id: "page-2", page: fakePage("https://two.example/"), sessionId: "default", active: false },
  ];
  const { server, info } = await startedServer({ pages, newCDPSession });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    const deadline = Date.now() + 2_000;
    while (!log.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const firstStart = log.find((call) => call.method === "Page.startScreencast");

    client.send(JSON.stringify({ t: "tab", id: "page-2" }));
    const switched = await nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
    );
    assert.ok(switched);
    const secondStartIndex = log.findIndex(
      (call) => call.method === "Page.startScreencast" && call.session !== firstStart.session,
    );
    const oldStopIndex = log.findIndex(
      (call) => call.method === "Page.stopScreencast" && call.session === firstStart.session,
    );
    assert.ok(secondStartIndex >= 0, "the new tab's screencast must start");
    assert.ok(oldStopIndex >= 0, "the old tab's screencast must stop");
    assert.ok(
      secondStartIndex < oldStopIndex,
      "the old stream must keep painting until the new one is live",
    );
    client.close();
  } finally {
    await server.stop();
  }
});

test("followPreferred streams a newly preferred tab without a strip click", async () => {
  const page1 = fakePage("https://one.example/");
  const page2 = fakePage("https://two.example/");
  const pages = [
    { id: "page-1", page: page1, sessionId: "default", active: true },
  ];
  let preferred = page1;
  const { server, info } = await startedServer({
    pages,
    preferredPage: () => preferred,
  });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    // Drain the initial tabs broadcast before mutating preferred.
    client.send(JSON.stringify({ t: "refresh" }));
    await nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-1" && tab.streaming),
    );

    // Agent openPage: new tab becomes preferred (session.currentId).
    pages.push({ id: "page-2", page: page2, sessionId: "default", active: true });
    pages[0].active = false;
    preferred = page2;
    const followed = nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
    );
    await server.followPreferred();
    assert.ok(await followed, "live view must auto-stream the agent's new tab");
    client.close();
  } finally {
    await server.stop();
  }
});

test("followPreferred does not yank a human-selected background tab", async () => {
  const page1 = fakePage("https://one.example/");
  const page2 = fakePage("https://two.example/");
  const pages = [
    { id: "page-1", page: page1, sessionId: "default", active: true },
    { id: "page-2", page: page2, sessionId: "default", active: false },
  ];
  const preferred = page1;
  const { server, info } = await startedServer({
    pages,
    preferredPage: () => preferred,
  });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");

    // Human inspects the other tab via the strip.
    client.send(JSON.stringify({ t: "tab", id: "page-2" }));
    await nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
    );

    // Preferred is still page-1 (agent has not moved). A follow tick must not
    // pull the stream back.
    await server.followPreferred();
    client.send(JSON.stringify({ t: "refresh" }));
    const tabs = await nextMessage(client, (message) => message.t === "tabs");
    assert.ok(
      tabs.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
      "human-selected tab must stay streamed until preferred changes",
    );
    assert.ok(tabs.tabs.some((tab) => tab.id === "page-1" && !tab.streaming));
    client.close();
  } finally {
    await server.stop();
  }
});

test("followPreferred re-follows when the agent moves after a human inspect", async () => {
  const page1 = fakePage("https://one.example/");
  const page2 = fakePage("https://two.example/");
  const page3 = fakePage("https://three.example/");
  const pages = [
    { id: "page-1", page: page1, sessionId: "default", active: true },
    { id: "page-2", page: page2, sessionId: "default", active: false },
  ];
  let preferred = page1;
  const { server, info } = await startedServer({
    pages,
    preferredPage: () => preferred,
  });
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");

    client.send(JSON.stringify({ t: "tab", id: "page-2" }));
    await nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-2" && tab.streaming),
    );

    // Agent opens yet another tab and focuses it.
    pages.push({ id: "page-3", page: page3, sessionId: "default", active: true });
    pages[0].active = false;
    preferred = page3;
    const followed = nextMessage(
      client,
      (message) =>
        message.t === "tabs" && message.tabs.some((tab) => tab.id === "page-3" && tab.streaming),
    );
    await server.followPreferred();
    assert.ok(await followed, "agent focus change must override a prior human inspect");
    client.close();
  } finally {
    await server.stop();
  }
});

test("viewport hints shrink the screencast to the largest viewer window", async () => {
  const { server, info, cdp } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    let deadline = Date.now() + 2_000;
    while (!cdp.calls.some((call) => call.method === "Page.startScreencast") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const first = cdp.calls.find((call) => call.method === "Page.startScreencast");
    assert.equal(first.params.maxWidth, 1440);

    client.send(JSON.stringify({ t: "view", px: 600 }));
    deadline = Date.now() + 2_000;
    while (
      !cdp.calls.some(
        (call) => call.method === "Page.startScreencast" && call.params.maxWidth === 640,
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const resized = cdp.calls.filter((call) => call.method === "Page.startScreencast").pop();
    // 600px rounds up to the next 160px bucket; never larger than configured.
    assert.equal(resized.params.maxWidth, 640);
    assert.equal(resized.params.maxHeight, 640);
    client.close();
  } finally {
    await server.stop();
  }
});

test("agent state changes broadcast to connected viewers", async () => {
  const { server, info } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");
    const driving = nextMessage(client, (message) => message.t === "state");
    server.setAgentState("driving");
    assert.equal((await driving).agent, "driving");
  } finally {
    await server.stop();
  }
});

test("chat queues freeform human messages and mirrors agent posts", async () => {
  const { server, info } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");

    const agentLine = nextMessage(client, (message) => message.t === "chat" && message.message);
    server.postChat({ role: "agent", text: "Navigating to login…", kind: "browser" });
    const posted = await agentLine;
    assert.equal(posted.message.role, "agent");
    assert.equal(posted.message.text, "Navigating to login…");
    assert.equal(posted.message.kind, "browser");

    const humanLine = nextMessage(client, (message) => message.t === "chat" && message.message?.role === "you");
    client.send(JSON.stringify({ t: "chat", text: "use the work account" }));
    assert.equal((await humanLine).message.text, "use the work account");

    const drained = server.drainHumanMessages();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].text, "use the work account");
    assert.equal(server.drainHumanMessages().length, 0);
    assert.equal(server.status().pendingChat, 0);
  } finally {
    await server.stop();
  }
});

test("ask resolves from chat text or option chips; only one ask at a time", async () => {
  const { server, info } = await startedServer();
  try {
    const client = await connect(info);
    await nextMessage(client, (message) => message.t === "hello");

    const pending = server.beginAsk("Which account?", {
      options: ["work", "personal"],
      timeoutMs: 60_000,
    });
    const state = await nextMessage(
      client,
      (message) => message.t === "state" && message.ask?.active,
    );
    assert.equal(state.ask.question, "Which account?");
    assert.deepEqual(state.ask.options, ["work", "personal"]);

    await assert.rejects(
      () => server.beginAsk("second?", { timeoutMs: 60_000 }),
      /already in progress/,
    );

    // Freeform chat during ask answers it (does not queue as guidance).
    client.send(JSON.stringify({ t: "chat", text: "work" }));
    assert.deepEqual(await pending, { action: "answer", answer: "work" });
    assert.equal(server.drainHumanMessages().length, 0);

    const timed = server.beginAsk("still there?", { timeoutMs: 50 });
    assert.deepEqual(await timed, { action: "timeout", answer: "" });
  } finally {
    await server.stop();
  }
});

test("guessTailscaleHost finds the CGNAT range and only that", () => {
  assert.equal(
    guessTailscaleHost({
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false }],
      tailscale0: [{ family: "IPv4", address: "100.101.32.7", internal: false }],
    }),
    "100.101.32.7",
  );
  assert.equal(
    guessTailscaleHost({
      eth0: [
        { family: "IPv4", address: "100.63.0.1", internal: false }, // below range
        { family: "IPv4", address: "100.128.0.1", internal: false }, // above range
        { family: "IPv6", address: "fd7a::1", internal: false },
      ],
    }),
    "",
  );
});

test("expose presets: local binds loopback; unknown modes fail fast", async () => {
  const { server } = makeServer();
  try {
    const info = await server.start({ expose: "local", port: 0 });
    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.expose, "local");
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await server.stop();
  }
  const { server: bad } = makeServer();
  await assert.rejects(() => bad.start({ expose: "ngrok" }), /Unknown live-view expose mode/);
});

test("password gate: login page, wrong password, session cookie, WS auth", async () => {
  const { server } = makeServer();
  try {
    const info = await server.start({
      host: "127.0.0.1",
      port: 0,
      password: "hunter22",
    });
    assert.equal(info.passwordProtected, true);
    assert.ok(!("password" in info), "status must never echo the password");
    const base = new URL(info.url);

    // Unauthenticated: token alone now serves the login gate, not the viewer.
    const gate = await fetch(info.url);
    assert.equal(gate.status, 200);
    const gateBody = await gate.text();
    assert.match(gateBody, /password/i);
    assert.doesNotMatch(gateBody, /viewer/);

    // The WebSocket requires the session too.
    const wsResult = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${base.host}/ws?t=${info.token}`);
      ws.addEventListener("open", () => resolve("open"), { once: true });
      ws.addEventListener("error", () => resolve("error"), { once: true });
      ws.addEventListener("close", () => resolve("error"), { once: true });
    });
    assert.equal(wsResult, "error");

    // Wrong password: redirected back with the failure flag, no cookie.
    const wrong = await fetch(`http://${base.host}/login?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=nope",
      redirect: "manual",
    });
    assert.equal(wrong.status, 303);
    assert.match(wrong.headers.get("location"), /auth=failed/);
    assert.equal(wrong.headers.get("set-cookie"), null);

    // Right password: session cookie, and the viewer page loads with it.
    const login = await fetch(`http://${base.host}/login?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter22",
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie = String(login.headers.get("set-cookie"));
    assert.match(cookie, /bw_lv_sess=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const sessionCookie = cookie.split(";")[0];
    const page = await fetch(info.url, { headers: { cookie: sessionCookie } });
    assert.match(await page.text(), /viewer/);

    // Authenticated WebSocket: raw handshake carrying the cookie succeeds.
    const net = await import("node:net");
    const nodeCrypto = await import("node:crypto");
    const socket = net.connect(base.port, "127.0.0.1");
    await once(socket, "connect");
    const key = nodeCrypto.randomBytes(16).toString("base64");
    socket.write(
      `GET /ws?t=${info.token} HTTP/1.1\r\nHost: ${base.host}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Cookie: ${sessionCookie}\r\n\r\n`,
    );
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    const deadline = Date.now() + 2_000;
    while (!Buffer.concat(chunks).toString().includes("101") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(Buffer.concat(chunks).toString(), /101 Switching Protocols/);
    socket.destroy();
  } finally {
    await server.stop();
  }
});

test("a stored sha256 passwordHash gates exactly like a plaintext password", async () => {
  const crypto = await import("node:crypto");
  const hash = `sha256:${crypto.createHash("sha256").update("hunter22").digest("hex")}`;
  const { server } = makeServer();
  try {
    const info = await server.start({ host: "127.0.0.1", port: 0, passwordHash: hash });
    assert.equal(info.passwordProtected, true);
    const base = new URL(info.url);
    assert.match(await (await fetch(info.url)).text(), /password/i);
    const login = await fetch(`http://${base.host}/login?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter22",
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    assert.match(String(login.headers.get("set-cookie")), /bw_lv_sess=/);
  } finally {
    await server.stop();
  }
  const { server: malformed } = makeServer();
  await assert.rejects(
    () => malformed.start({ host: "127.0.0.1", port: 0, passwordHash: "md5:nope" }),
    /Invalid live-view passwordHash/,
  );
});

test("live-view config file round-trips a hashed password and sanitizes input", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadLiveViewConfig, saveLiveViewPassword, hashLiveViewPassword } = await import(
    "../../dist/src/live-view-config.js"
  );
  const home = makeTempDir("bw-cfg-");

  assert.deepEqual(loadLiveViewConfig(home), {}); // no file yet

  // Save preserves unrelated config keys and never leaves plaintext behind.
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ other: { keep: true }, liveView: { expose: "tailscale", password: "old-plain" } }),
  );
  const file = saveLiveViewPassword("hunter22", home);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.other.keep, true);
  assert.equal(written.liveView.expose, "tailscale");
  assert.equal(written.liveView.password, undefined);
  assert.equal(written.liveView.passwordHash, hashLiveViewPassword("hunter22"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const loaded = loadLiveViewConfig(home);
  assert.deepEqual(loaded, {
    expose: "tailscale",
    passwordHash: hashLiveViewPassword("hunter22"),
  });

  // Clearing removes the hash but keeps the rest.
  saveLiveViewPassword(null, home);
  assert.deepEqual(loadLiveViewConfig(home), { expose: "tailscale" });

  // Unknown/garbage keys never pass through.
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ liveView: { expose: "LAN ", passwordHash: "nope", evil: 1, port: "abc" } }),
  );
  assert.deepEqual(loadLiveViewConfig(home), { expose: "lan" });
});

test("password gate rate-limits repeated failures and rejects short passwords", async () => {
  const { server } = makeServer();
  await assert.rejects(
    () => server.start({ host: "127.0.0.1", port: 0, password: "abc" }),
    /at least 4 characters/,
  );
  const { server: gated } = makeServer();
  try {
    const info = await gated.start({ host: "127.0.0.1", port: 0, password: "hunter22" });
    const base = new URL(info.url);
    const attempt = () =>
      fetch(`http://${base.host}/login?t=${info.token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=wrong",
        redirect: "manual",
      });
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 303);
    // Attempt 11 from the same address is locked out — even with the right password.
    const locked = await fetch(`http://${base.host}/login?t=${info.token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=hunter22",
      redirect: "manual",
    });
    assert.equal(locked.status, 429);
  } finally {
    await gated.stop();
  }
});

test("reconnect receives chat history", async () => {
  const { server, info } = await startedServer();
  try {
    server.postChat({ role: "agent", text: "step one", kind: "browser" });
    const client = await connect(info);
    const history = await nextMessage(
      client,
      (message) => message.t === "chat" && Array.isArray(message.messages),
    );
    assert.ok(history.messages.some((line) => line.text === "step one"));
    client.close();
  } finally {
    await server.stop();
  }
});

test("a silent stop skips the bye so viewers fall into reconnect", async () => {
  const { server, info } = await startedServer();
  const client = await connect(info);
  await nextMessage(client, (message) => message.t === "hello");
  let sawBye = false;
  client.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      if (JSON.parse(event.data).t === "bye") sawBye = true;
    } catch {
      /* binary/partial */
    }
  });
  const closed = once(client, "close");
  await server.stop({ notify: false });
  await closed;
  assert.equal(sawBye, false, "worker teardown must not announce a terminal end");
  assert.equal(server.status().running, false);
});

test("a pinned token and port revive the original URL after a worker restart", async () => {
  const first = await startedServer();
  const { url, token, port } = first.info;
  await first.server.stop({ notify: false }); // the old worker going down

  // A fresh server instance (the replacement worker) revives with the pinned
  // listen address — the URL the agent already relayed keeps working.
  const revivedParts = makeServer();
  const revived = await revivedParts.server.start({
    host: "127.0.0.1",
    port,
    token,
    interactive: true,
  });
  try {
    assert.equal(revived.ok, true);
    assert.equal(revived.url, url);
    assert.equal(revived.token, token);
    const client = await connect(revived);
    await nextMessage(client, (message) => message.t === "hello");
    client.close();
  } finally {
    await revivedParts.server.stop();
  }
});

test("a garbage token option is ignored and a fresh one is minted", async () => {
  const parts = makeServer();
  const info = await parts.server.start({
    host: "127.0.0.1",
    port: 0,
    token: "short",
  });
  try {
    assert.equal(info.ok, true);
    assert.notEqual(info.token, "short");
    assert.ok(info.token.length >= 24);
  } finally {
    await parts.server.stop();
  }
});
