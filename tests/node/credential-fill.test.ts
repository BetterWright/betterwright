import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  collectCredentialFrameDetections,
  disposeCredentialFrameDetections,
  probePinnedCredentialOrigin,
} from "../../dist/src/credential-target-scan.js";
import { cloakRuntime } from "../../dist/src/doctor.js";
import { BetterWright, NetworkPolicy } from "../../dist/src/index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ready = (await cloakRuntime()).installed;
const opts = { skip: ready ? false : "browser runtime not installed" };
// This integration suite gates on the CloakBrowser binary specifically, so
// select the same backend for the workers it launches. Otherwise a supported
// host with no BetterChromium artifact would run instead of skipping, then
// fail before reaching the credential behavior under test.
const previousChromiumRoot = process.env.BETTERWRIGHT_CHROMIUM_ROOT;
if (ready) process.env.BETTERWRIGHT_CHROMIUM_ROOT = "off";
test.after(() => {
  if (previousChromiumRoot === undefined) {
    delete process.env.BETTERWRIGHT_CHROMIUM_ROOT;
  } else {
    process.env.BETTERWRIGHT_CHROMIUM_ROOT = previousChromiumRoot;
  }
});

function tempHome() {
  return makeTempDir("betterwright-credential-test-");
}

test("frame detection disposes earlier handles before propagating a later scan failure", async () => {
  const disposed = [];
  const frames = [
    { id: "first", isDetached: () => false },
    { id: "second", isDetached: () => false },
    { id: "failing", isDetached: () => false },
  ];
  await assert.rejects(
    collectCredentialFrameDetections({
      frames,
      requestedAction: "fill",
      originForFrame: async (frame) => `https://${frame.id}.example`,
      detectInFrame: async (frame) => {
        if (frame.id === "failing") throw new Error("frame scan failed");
        return {
          async dispose() {
            disposed.push(frame.id);
            if (frame.id === "first") throw new Error("dispose failed");
          },
        };
      },
    }),
    /frame scan failed/,
  );
  assert.deepEqual(disposed.sort(), ["first", "second"]);
});

test("frame detection tolerates origin lookup failure after a frame detaches", async () => {
  const disposed = [];
  const frames = [
    { id: "ready", isDetached: () => false },
    { id: "detached", isDetached: () => true },
  ];
  const { detections, unresponsive } = await collectCredentialFrameDetections({
    frames,
    requestedAction: "fill",
    originForFrame: async (frame) => {
      if (frame.id === "detached") throw new Error("frame was detached");
      return `https://${frame.id}.example`;
    },
    detectInFrame: async (frame) => ({
      async dispose() {
        disposed.push(frame.id);
      },
    }),
  });
  assert.equal(detections.length, 1);
  assert.equal(detections[0].origin, "https://ready.example");
  assert.deepEqual(unresponsive, []);
  await disposeCredentialFrameDetections(detections);
  assert.deepEqual(disposed, ["ready"]);
});

test("a wedged frame is skipped instead of stalling the whole scan", async () => {
  const disposed = [];
  const frames = [
    { id: "wedged", url: () => "https://wedged.example/widget", isDetached: () => false },
    { id: "form", url: () => "https://form.example/login", isDetached: () => false },
  ];
  let releaseWedged;
  const wedged = new Promise((resolve) => {
    releaseWedged = resolve;
  });
  const started = Date.now();
  const { detections, unresponsive } = await collectCredentialFrameDetections({
    frames,
    requestedAction: "fill",
    originForFrame: async (frame) => `https://${frame.id}.example`,
    detectInFrame: async (frame) => {
      // The wedged frame's evaluate never settles on its own, exactly as a
      // frame with a blocked execution context behaves.
      if (frame.id === "wedged") return wedged;
      return {
        id: frame.id,
        async dispose() {
          disposed.push(frame.id);
        },
      };
    },
    probeMs: 40,
    budgetMs: 400,
  });
  assert.ok(Date.now() - started < 300, "the scan gave up on the wedged frame");
  assert.deepEqual(unresponsive, ["https://wedged.example/widget"]);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].id, "form");

  // The abandoned probe must still clean up after itself when it finally lands.
  releaseWedged({
    async dispose() {
      disposed.push("wedged");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed, ["wedged"]);
});

test("the scan budget bounds a page full of wedged frames", async () => {
  const frames = Array.from({ length: 12 }, (_, index) => ({
    id: `f${index}`,
    url: () => `https://f${index}.example/`,
    isDetached: () => false,
  }));
  const started = Date.now();
  const { detections, unresponsive } = await collectCredentialFrameDetections({
    frames,
    requestedAction: "fill",
    originForFrame: async (frame) => `https://${frame.id}.example`,
    detectInFrame: () => new Promise(() => {}),
    probeMs: 40,
    budgetMs: 120,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `the scan honoured its budget (took ${elapsed}ms)`);
  assert.equal(detections.length, 0);
  assert.equal(unresponsive.length, frames.length);
});

test("explicit target origin validation is bounded when its frame stops responding", async () => {
  let originProbed = false;
  const started = Date.now();
  const result = await probePinnedCredentialOrigin({
    inspectDocument: () => new Promise(() => {}),
    originForFrame: async () => {
      originProbed = true;
      return "https://form.example";
    },
    probeMs: 40,
    budgetMs: 120,
  });
  assert.ok(Date.now() - started < 300, "explicit validation honoured its deadline");
  assert.deepEqual(result, {
    timedOut: true,
    phase: "initial document validation",
  });
  assert.equal(originProbed, false, "a timed-out document probe stops later validation work");
});

test("explicit target origin validation preserves both document checks", async () => {
  const documents = ["https://form.example/signup", "https://form.example/signup"];
  const result = await probePinnedCredentialOrigin({
    inspectDocument: async () => documents.shift(),
    originForFrame: async () => "https://form.example",
    probeMs: 40,
    budgetMs: 120,
  });
  assert.deepEqual(result, {
    timedOut: false,
    documentUrlBefore: "https://form.example/signup",
    origin: "https://form.example",
    documentUrlAfter: "https://form.example/signup",
  });
});

async function fixtureServer() {
  const pages = new Map();
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const route = pages.get(new URL(request.url, "http://fixture").pathname);
    const body = typeof route === "function" ? route(request, response) : route;
    if (!response.writableEnded) response.end(body ?? "not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    pages,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("fillCredential validates non-object options without starting a worker", async () => {
  const bw = new BetterWright();
  const result = await bw.fillCredential(null);
  assert.equal(result.ok, false);
  assert.match(result.error, /options must be an object/);
  const generated = await bw.generateAndFillCredential({
    matchMode: "same-site",
  });
  assert.equal(generated.ok, false);
  assert.match(generated.error, /matchMode.*exact-origin/);
  const rotation = await bw.generateAndFillCredential({
    id: "login-1",
    matchMode: "host",
  });
  assert.equal(rotation.ok, false);
  assert.match(rotation.error, /cannot be changed.*existing credential/i);
  assert.equal(bw._process, null);
  await bw.close();
});

test("host vault RPC retains pending origins and fails closed at capacity", async () => {
  const calls = [];
  let generation = 0;
  let failFinalization = true;
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload, origin });
      if (action === "generate") {
        const pendingId = `pending-${generation}`;
        generation += 1;
        return { pendingId };
      }
      if (
        action === "commit" &&
        payload.pendingId === "pending-0" &&
        failFinalization
      ) {
        failFinalization = false;
        throw new Error("transient commit failure");
      }
      if (
        action === "commit" &&
        origin === "https://redirected.example"
      ) {
        throw Object.assign(new Error("pending credential not at current origin"), {
          code: "PENDING_NOT_FOUND",
        });
      }
      if (action === "commit" && payload.pendingId === "pending-1") {
        throw Object.assign(new Error("pending credential expired"), {
          code: "PENDING_NOT_FOUND",
        });
      }
      return { committed: true, pendingId: payload.pendingId };
    },
  };
  const bw = new BetterWright({ vault });
  const responses = [];
  bw._send = (message) => responses.push(message);

  for (let index = 0; index < 100; index += 1) {
    await bw._serviceRpc({
      requestId: `generate-${index}`,
      method: "vault",
      payload: {
        action: "generate",
        origin: `https://site-${index}.example`,
        payload: {},
      },
    });
  }
  assert.equal(generation, 100);
  assert.ok(responses.every((response) => response.ok === true));

  await bw._serviceRpc({
    requestId: "at-capacity",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://overflow.example",
      payload: {},
    },
  });
  assert.equal(generation, 100, "the vault is not called when tracking is full");
  assert.equal(responses.at(-1).ok, false);
  assert.match(responses.at(-1).error, /pending finalization \(limit 100\)/);

  const finalize = async (requestId) => {
    await bw._serviceRpc({
      requestId,
      method: "vault",
      payload: {
        action: "commit",
        origin: "https://redirected.example",
        payload: { pendingId: "pending-0" },
      },
    });
  };
  await finalize("commit-failed");
  assert.equal(responses.at(-1).ok, false);
  assert.equal(calls.at(-1).origin, "https://redirected.example");
  await bw._serviceRpc({
    requestId: "still-at-capacity",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://still-full.example",
      payload: {},
    },
  });
  assert.equal(generation, 100, "a transient failure keeps its tracked slot");
  const beforeRetry = calls.length;
  await finalize("commit-retried");
  assert.equal(responses.at(-1).ok, true);
  assert.deepEqual(
    calls.slice(beforeRetry).map(({ origin }) => origin),
    ["https://redirected.example", "https://site-0.example"],
  );

  await bw._serviceRpc({
    requestId: "after-finalize",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://replacement.example",
      payload: {},
    },
  });
  assert.equal(generation, 101, "successful finalization frees one tracked slot");
  assert.equal(responses.at(-1).ok, true);

  await bw._serviceRpc({
    requestId: "expired-pending",
    method: "vault",
    payload: {
      action: "commit",
      origin: "https://redirected.example",
      payload: { pendingId: "pending-1" },
    },
  });
  assert.equal(responses.at(-1).ok, false);
  assert.equal(calls.at(-1).origin, "https://site-1.example");
  await bw._serviceRpc({
    requestId: "after-expiry",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://after-expiry.example",
      payload: {},
    },
  });
  assert.equal(
    generation,
    102,
    "a definitive PENDING_NOT_FOUND frees the stale tracked slot",
  );
  assert.equal(responses.at(-1).ok, true);
  await bw.close();
});

test("host finalization tries an upgraded HTTPS origin before tracked HTTP fallback", async () => {
  const calls = [];
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload, origin });
      if (action === "generate") return { pendingId: "pending-upgrade" };
      if (action === "commit" && origin === "https://signup.example") {
        return { committed: true, pendingId: payload.pendingId };
      }
      throw Object.assign(new Error("pending credential not found"), {
        code: "PENDING_NOT_FOUND",
      });
    },
  };
  const bw = new BetterWright({ vault });
  const responses = [];
  bw._send = (message) => responses.push(message);

  await bw._serviceRpc({
    requestId: "generate-http",
    method: "vault",
    payload: {
      action: "generate",
      origin: "http://signup.example",
      payload: {},
    },
  });
  await bw._serviceRpc({
    requestId: "commit-https",
    method: "vault",
    payload: {
      action: "commit",
      origin: "https://signup.example",
      payload: { pendingId: "pending-upgrade" },
    },
  });

  assert.equal(responses.at(-1).ok, true);
  assert.deepEqual(
    calls.map(({ action, origin }) => ({ action, origin })),
    [
      { action: "generate", origin: "http://signup.example" },
      { action: "commit", origin: "https://signup.example" },
    ],
  );
  assert.equal(bw._pendingCredentialOrigins.has("pending-upgrade"), false);
  await bw.close();
});

test("pending recovery keeps form metadata and is delivered once", async () => {
  const vault = {
    async handleRequest() {
      return {
        pendingId: "pending-recovery",
        origin: "https://saved-scope.example",
        matchMode: "host",
        username: "",
        label: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
  };
  const bw = new BetterWright({ vault });
  bw._send = () => {};
  await bw._serviceRpc({
    id: "outer-1",
    requestId: "generate-recovery",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://form.example",
      payload: { username: "fallback", label: "fallback" },
    },
  });

  const failure = bw._attachPendingCredentialRecovery("outer-1", {
    ok: false,
    error: "field disappeared",
  });
  assert.deepEqual(failure.pendingCredential, {
    pendingId: "pending-recovery",
    origin: "https://form.example",
    matchMode: "host",
    username: "",
    label: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(
    bw._attachPendingCredentialRecovery("outer-1", { ok: false }).pendingCredential,
    undefined,
  );
  await bw.close();
});

test("host allocates a recoverable pending id before an ambiguous generate failure", async () => {
  let proposedPendingId = "";
  const vault = {
    async handleRequest(action, payload) {
      assert.equal(action, "generate");
      proposedPendingId = String(payload.pendingId || "");
      assert.match(proposedPendingId, /^pending_/);
      throw new Error("ambiguous storage failure");
    },
  };
  const bw = new BetterWright({ vault });
  const responses = [];
  bw._send = (message) => responses.push(message);

  await bw._serviceRpc({
    id: "outer-ambiguous",
    requestId: "generate-ambiguous",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://signup.example",
      payload: { username: "recoverable" },
    },
  });

  assert.equal(responses.at(-1).ok, false);
  assert.equal(responses.at(-1).pendingCredential.pendingId, proposedPendingId);
  assert.equal(
    bw._pendingCredentialOrigins.get(proposedPendingId),
    "https://signup.example",
  );
  assert.equal(
    bw._pendingCredentialRecoveries.get("outer-ambiguous").pendingId,
    proposedPendingId,
  );
  await bw.close();
});

test("vault-reported rotation recovery replaces provisional host metadata", async () => {
  const recovery = {
    pendingId: "pending_rotation_recovery",
    origin: "https://accounts.example",
    matchMode: "exact-origin",
    username: "rotation@example.com",
    label: "Primary",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const vault = {
    async handleRequest(_action, payload) {
      assert.match(String(payload.pendingId), /^pending_/);
      throw Object.assign(new Error("post-persist rotation failure"), {
        code: "EIO",
        pendingCredential: recovery,
      });
    },
  };
  const bw = new BetterWright({ vault });
  const responses = [];
  bw._send = (message) => responses.push(message);

  await bw._serviceRpc({
    id: "outer-rotation",
    requestId: "generate-rotation",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://accounts.example",
      payload: { id: "credential-1" },
    },
  });

  assert.equal(responses.at(-1).ok, false);
  assert.deepEqual(responses.at(-1).pendingCredential, recovery);
  assert.deepEqual(
    bw._pendingCredentialRecoveries.get("outer-rotation"),
    recovery,
  );
  assert.equal(
    bw._pendingCredentialOrigins.get(recovery.pendingId),
    recovery.origin,
  );
  await bw.close();
});

for (const failureCode of ["VAULT_KEY_INVALID", "VAULT_SECRET_CAPACITY"]) {
  test(`definitive ${failureCode} generate failures do not retain recovery slots`, async () => {
  const vault = {
    async handleRequest() {
      throw Object.assign(new Error("definitive pre-persist failure"), {
        code: failureCode,
      });
    },
  };
  const bw = new BetterWright({ vault });
  const responses = [];
  bw._send = (message) => responses.push(message);

  await bw._serviceRpc({
    id: "outer-definitive",
    requestId: "generate-definitive",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://signup.example",
      payload: {},
    },
  });

  assert.equal(responses.at(-1).ok, false);
  assert.equal(responses.at(-1).code, failureCode);
  assert.equal(responses.at(-1).pendingCredential, undefined);
  assert.equal(bw._pendingCredentialOrigins.size, 0);
  assert.equal(bw._pendingCredentialRecoveries.size, 0);
  await bw.close();
  });
}

test("worker exit resolves only requests owned by that child", async () => {
  const bw = new BetterWright({ vault: false });
  const oldChild = {};
  const replacementChild = {};
  const results = [];
  const addPending = (id, child) => {
    bw._pending.set(id, {
      child,
      done(result) {
        bw._pending.delete(id);
        results.push({ id, result });
      },
    });
  };
  addPending("old-request", oldChild);
  addPending("replacement-request", replacementChild);

  bw._resolvePendingForWorkerExit(oldChild);

  assert.deepEqual(results.map(({ id }) => id), ["old-request"]);
  assert.equal(bw._pending.has("replacement-request"), true);
  bw._pending.delete("replacement-request");
  await bw.close();
});

test("dispatch timeout attaches recovery after its child close work", async () => {
  const bw = new BetterWright({ vault: false });
  const child = {};
  const recovery = {
    pendingId: "pending-timeout",
    origin: "https://form.example",
    matchMode: "exact-origin",
    username: null,
    label: "signup",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  bw._process = child;
  let sent;
  bw._send = (message, target) => {
    assert.equal(target, child);
    sent = message;
  };
  bw.close = async ({ child: target, preservePending }) => {
    assert.equal(target, child);
    assert.equal(preservePending, true);
    bw._pendingCredentialRecoveries.set(sent.id, recovery);
  };

  const result = await bw._dispatch({ type: "execute" }, -5);

  assert.equal(result.ok, false);
  assert.deepEqual(result.pendingCredential, recovery);
  assert.equal(bw._pendingCredentialRecoveries.size, 0);
});

test("semantic credential detection and pending credential plumbing", opts, async (t) => {
  const loginSecret = "login-secret-never-returned";
  const frameSecret = "frame-secret-never-returned";
  const generatedSecret = "generated-secret-never-returned";
  const calls = [];
  const pendingOrigins = new Map();
  let iframeOrigin = "";
  let nextPendingId = null;
  let killWorkerAfterGenerate = false;
  let navigationRace = null;
  let generationGate = null;
  let omitGeneratedSecret = false;
  let bw;
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload, origin });
      if (action === "list-pending") {
        return {
          pendingCredentials: [...pendingOrigins.entries()]
            .filter(([, savedOrigin]) => savedOrigin === origin)
            .map(([pendingId, savedOrigin]) => ({
              pendingId,
              origin: savedOrigin,
              matchMode: "base-domain",
              username: null,
              label: null,
              category: "login",
              createdAt: "2029-12-31T23:59:00.000Z",
              expiresAt: "2030-01-01T00:00:00.000Z",
              expired: false,
            })),
        };
      }
      if (action === "list") return { credentials: [] };
      if (action === "save") {
        return {
          id: "saved-test-record",
          origin,
          matchMode: payload.matchMode || "base-domain",
          username: payload.username || "",
          label: payload.label || null,
          category: payload.category || "login",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        };
      }
      if (action === "update") {
        return {
          id: String(payload.id || "saved-test-record"),
          origin,
          matchMode: payload.matchMode || "base-domain",
          username: payload.username || "",
          label: payload.label || null,
          category: payload.category || "secure-note",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:01:00.000Z",
        };
      }
      if (action === "fill") {
        if (navigationRace?.action === action && navigationRace.origin === origin) {
          const race = navigationRace;
          race.vaultStartedResolve();
          race.gateOpen = true;
          await race.destinationLoaded;
        }
        return {
          id: "login-1",
          username:
            origin === iframeOrigin ? "framed@example.com" : "alice@example.com",
          secret: origin === iframeOrigin ? frameSecret : loginSecret,
        };
      }
      if (action === "generate") {
        if (generationGate) {
          const gate = generationGate;
          generationGate = null;
          gate.startedResolve();
          await gate.release;
        }
        if (navigationRace?.action === action && navigationRace.origin === origin) {
          const race = navigationRace;
          race.vaultStartedResolve();
          race.gateOpen = true;
          await race.destinationLoaded;
        }
        const pendingId =
          nextPendingId ||
          (origin === iframeOrigin ? "pending-frame-1" : "pending-1");
        nextPendingId = null;
        pendingOrigins.set(pendingId, origin);
        const generated = {
          id: payload.id || "new-1",
          pending: true,
          pendingId,
          origin,
          matchMode: payload.matchMode || "base-domain",
          username: Object.hasOwn(payload, "username") ? payload.username : "",
          label: Object.hasOwn(payload, "label") ? payload.label : null,
          expiresAt: "2030-01-01T00:00:00.000Z",
          secret: generatedSecret,
        };
        if (omitGeneratedSecret) {
          omitGeneratedSecret = false;
          delete generated.secret;
        }
        if (killWorkerAfterGenerate) {
          killWorkerAfterGenerate = false;
          const worker = bw?._process;
          if (worker) {
            const exited = once(worker, "exit");
            // SIGKILL, not SIGTERM: this simulates the worker dying mid-RPC,
            // and a graceful SIGTERM shutdown closes Chromium first — slow
            // enough on a loaded runner to race the client's execute timeout
            // and fail the test with the timeout error instead of exit.
            worker.kill("SIGKILL");
            await exited;
          }
        }
        return generated;
      }
      if (action === "commit") {
        const expectedOrigin = pendingOrigins.get(payload.pendingId);
        if (expectedOrigin && expectedOrigin !== origin)
          throw Object.assign(new Error("pending credential origin mismatch"), {
            code: "PENDING_NOT_FOUND",
          });
        pendingOrigins.delete(payload.pendingId);
        return { committed: true, pendingId: payload.pendingId, secret: generatedSecret };
      }
      if (action === "discard") {
        const expectedOrigin = pendingOrigins.get(payload.pendingId);
        if (expectedOrigin && expectedOrigin !== origin)
          throw Object.assign(new Error("pending credential origin mismatch"), {
            code: "PENDING_NOT_FOUND",
          });
        pendingOrigins.delete(payload.pendingId);
        return { discarded: true, pendingId: payload.pendingId, secret: generatedSecret };
      }
      throw new Error(`unexpected vault action: ${action}`);
    },
  };
  const server = await fixtureServer();
  const frameServer = await fixtureServer();
  iframeOrigin = frameServer.origin;
  server.pages.set(
    "/login",
    `<!doctype html><form onsubmit="event.preventDefault(); window.submits=(window.submits||0)+1">
      <label>Email <input id="login-user" type="email" autocomplete="username"></label>
      <label>Password <input id="login-password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>`,
  );
  server.pages.set(
    "/ambiguous",
    `<!doctype html>
      <form><label>Account A <input autocomplete="username"></label><input type="password" autocomplete="current-password"><button>Sign in</button></form>
      <form><label>Account B <input autocomplete="username"></label><input type="password" autocomplete="current-password"><button>Sign in</button></form>`,
  );
  server.pages.set(
    "/password-only",
    `<!doctype html><form><label>Password <input id="only-password" type="password" autocomplete="current-password"></label><button>Continue</button></form>`,
  );
  server.pages.set(
    "/non-username",
    `<!doctype html><form>
      <label>Display name <input id="display-name" autocomplete="name" value="Visible name"></label>
      <label>Security answer <input id="security-answer" value="First school"></label>
      <label>Password <input id="semantic-password" type="password" autocomplete="current-password"></label>
      <button>Continue</button>
    </form>`,
  );
  server.pages.set(
    "/change",
    `<!doctype html><form>
      <label>Current password <input id="current" type="password" autocomplete="current-password"></label>
      <label>New password <input id="new" type="password" autocomplete="new-password"></label>
      <label>Confirm new password <input id="confirm" type="password" autocomplete="new-password"></label>
      <button>Change password</button>
    </form>`,
  );
  server.pages.set(
    "/ambiguous-change",
    `<!doctype html>
      <form id="primary-change">
        <label>Current password <input id="primary-current" type="password"></label>
        <label>New password <input id="primary-new" type="password"></label>
        <label>Confirm password <input id="primary-confirm" type="password"></label>
        <button>Change password</button>
      </form>
      <form id="decoy-change">
        <label>Current password <input id="decoy-current" type="password"></label>
        <label>New password <input id="decoy-new" type="password"></label>
        <label>Confirm password <input id="decoy-confirm" type="password"></label>
        <button>Change password</button>
      </form>`,
  );
  server.pages.set(
    "/explicit",
    `<!doctype html><form onsubmit="event.preventDefault(); window.explicitSubmitted=true">
      <label>User <input id="explicit-user"></label><label>Password <input id="explicit-password" type="password"></label><button id="explicit-submit">Go</button>
    </form>`,
  );
  server.pages.set(
    "/never-settling-blur",
    `<!doctype html><form>
      <label>User <input id="blur-user"></label><label>Password <input id="blur-password" type="password"></label>
    </form><script>
      document.querySelector('#blur-password').blur = () => new Promise(() => {});
    </script>`,
  );
  server.pages.set(
    "/explicit-race-source",
    `<!doctype html><form>
      <input id="race-user"><input id="race-password" type="password"><input id="race-confirm" type="password"><button id="race-submit">Submit</button>
    </form><script>
      const poll = async () => {
        const response = await fetch('/explicit-race-gate', {cache: 'no-store'});
        if ((await response.text()) === 'go') {
          location.replace(${JSON.stringify(`${frameServer.origin}/explicit-race-destination`)});
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    </script>`,
  );
  server.pages.set("/explicit-race-gate", () =>
    navigationRace?.gateOpen ? "go" : "wait",
  );
  frameServer.pages.set(
    "/explicit-race-destination",
    `<!doctype html><form onsubmit="event.preventDefault(); window.raceSubmits=(window.raceSubmits||0)+1">
      <input id="race-user"><input id="race-password" type="password"><input id="race-confirm" type="password"><button id="race-submit">Submit</button>
    </form><script>
      window.secretCharacters = 0;
      document.addEventListener('beforeinput', (event) => {
        window.secretCharacters += String(event.data || '').length;
      });
      fetch('/explicit-race-loaded', {cache: 'no-store'});
    </script>`,
  );
  frameServer.pages.set("/explicit-race-loaded", () => {
    navigationRace?.destinationLoadedResolve();
    return "ok";
  });
  server.pages.set(
    "/signup",
    `<!doctype html><form>
      <label>Email <input id="signup-user" type="email" autocomplete="username"></label>
      <label>Create password <input id="signup-password" type="password" autocomplete="new-password"></label>
      <label>Confirm password <input id="signup-confirm" type="password" autocomplete="new-password"></label>
      <button type="submit">Create account</button>
    </form>`,
  );
  server.pages.set(
    "/prefilled-signup",
    `<!doctype html><form>
      <label>Email <input id="prefilled-user" type="email" autocomplete="username" value="prefilled@example.com"></label>
      <label>Create password <input id="prefilled-password" type="password" autocomplete="new-password"></label>
      <label>Confirm password <input id="prefilled-confirm" type="password" autocomplete="new-password"></label>
      <button type="submit">Create account</button>
    </form>`,
  );
  frameServer.pages.set(
    "/frame-login",
    `<!doctype html><form onsubmit="event.preventDefault(); window.submits=(window.submits||0)+1">
      <label>Email <input id="frame-user" type="email" autocomplete="username"></label>
      <label>Password <input id="frame-password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>`,
  );
  frameServer.pages.set(
    "/frame-login-2",
    `<!doctype html><form>
      <label>Email <input type="email" autocomplete="username"></label>
      <label>Password <input type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>`,
  );
  frameServer.pages.set(
    "/frame-signup",
    `<!doctype html><form>
      <label>Email <input id="frame-signup-user" type="email" autocomplete="username" value="framed-signup@example.com"></label>
      <label>Create password <input id="frame-signup-password" type="password" autocomplete="new-password"></label>
      <label>Confirm password <input id="frame-signup-confirm" type="password" autocomplete="new-password"></label>
      <button type="submit">Create account</button>
    </form>`,
  );
  server.pages.set(
    "/iframe-host",
    `<!doctype html><main>Host shell</main><iframe id="login-frame" src="${frameServer.origin}/frame-login"></iframe>`,
  );
  server.pages.set(
    "/iframe-ambiguous",
    `<!doctype html><iframe src="${frameServer.origin}/frame-login"></iframe><iframe src="${frameServer.origin}/frame-login-2"></iframe>`,
  );
  server.pages.set(
    "/iframe-signup-host",
    `<!doctype html><iframe src="${frameServer.origin}/frame-signup"></iframe>`,
  );
  server.pages.set(
    "/opaque-iframe",
    `<!doctype html><iframe sandbox srcdoc="<form><input type='password' autocomplete='current-password'><button>Sign in</button></form>"></iframe>`,
  );
  server.pages.set(
    "/opaque-http-iframe",
    `<!doctype html><iframe sandbox="allow-forms allow-scripts" src="${frameServer.origin}/frame-login"></iframe>`,
  );
  server.pages.set(
    "/shadow-login",
    `<!doctype html><credential-login></credential-login><script>
      const root = document.querySelector('credential-login').attachShadow({mode: 'open'});
      root.innerHTML = '<form><label>Email <input id="shadow-user" type="email" autocomplete="username"></label><label>Password <input id="shadow-password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>';
      root.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.shadowSubmits = (window.shadowSubmits || 0) + 1;
      });
    </script>`,
  );
  server.pages.set(
    "/shadow-ambiguous",
    `<!doctype html>
      <form><label>Email <input type="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label><button>Sign in</button></form>
      <credential-login></credential-login>
      <script>
        const root = document.querySelector('credential-login').attachShadow({mode: 'open'});
        root.innerHTML = '<form><label>Email <input type="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label><button>Sign in</button></form>';
      </script>`,
  );

  bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  const visit = async (pathname) => {
    const result = await bw.run(
      `await page.goto(${JSON.stringify(`${server.origin}${pathname}`)}); return page.url();`,
    );
    assert.equal(result.ok, true, result.error);
  };
  const armNavigationRace = (action) => {
    let vaultStartedResolve;
    let destinationLoadedResolve;
    const vaultStarted = new Promise((resolve) => {
      vaultStartedResolve = resolve;
    });
    const destinationLoaded = new Promise((resolve) => {
      destinationLoadedResolve = resolve;
    });
    navigationRace = {
      action,
      destinationLoaded,
      destinationLoadedResolve,
      gateOpen: false,
      origin: server.origin,
      vaultStartedResolve,
    };
    return vaultStarted;
  };

  try {
    await t.test("detects autocomplete fields and submits only when requested", async () => {
      await visit("/login");
      const inspection = await bw.run("return credentials.inspect();");
      assert.equal(inspection.ok, true, inspection.error);
      assert.equal(inspection.result.status, "ready");
      assert.equal(inspection.result.fields.username.autocomplete, "username");
      assert.equal(
        inspection.result.fields.password.autocomplete,
        "current-password",
      );
      assert.ok(!JSON.stringify(inspection).includes(loginSecret));

      const filled = await bw.fillCredential({});
      assert.equal(filled.ok, true, filled.error);
      assert.deepEqual(filled.result.filled, ["username", "password"]);
      assert.equal(filled.result.submitted, false);
      assert.ok(!JSON.stringify(filled).includes(loginSecret));
      const state = await bw.run(`return page.evaluate(() => ({
        username: document.querySelector('#login-user').value,
        passwordLength: document.querySelector('#login-password').value.length,
        submits: window.submits || 0,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "alice@example.com",
        passwordLength: loginSecret.length,
        submits: 0,
      });

      const submitted = await bw.fillCredential({ submit: true });
      assert.equal(submitted.ok, true, submitted.error);
      assert.equal(submitted.result.submitted, true);
      const submitCount = await bw.run(
        "return page.evaluate(() => window.submits || 0);",
      );
      assert.equal(submitCount.ok, true, submitCount.error);
      assert.equal(submitCount.result, 1);
    });

    await t.test("redacts short, overlapping, and object-key secrets", async () => {
      await visit("/login");
      const result = await bw.run(`
        const nested = 'nested-custom-vault-token';
        const note = 'custom-vault-save-note';
        const updated = 'updated-custom-vault-token';
        const updatedNote = 'custom-vault-update-note';
        await credentials.save({username:'short', password:'x'});
        await credentials.save({username:'prefix', password:'pass'});
        await credentials.save({username:'longer', password:'password123'});
        await credentials.save({
          category: 'secure-note',
          fields: {auth: {tokens: [nested]}},
          notes: note,
        });
        await credentials.update({
          id: 'saved-test-record',
          fields: {auth: {tokens: [updated]}},
          notes: updatedNote,
        });
        console.log(nested, note, updated, updatedNote);
        return {
          ['password123']: 'wrapped:password123',
          short: 'prefix:x:suffix',
          mapped: new Map([['password123', 'password123']]),
          [nested]: note,
          nested: {updated, updatedNote},
        };
      `);
      assert.equal(result.ok, true, result.error);
      const text = JSON.stringify(result.result);
      const envelope = JSON.stringify(result);
      for (const secret of [
        "x",
        "pass",
        "password123",
        "nested-custom-vault-token",
        "custom-vault-save-note",
        "updated-custom-vault-token",
        "custom-vault-update-note",
      ]) {
        assert.ok(!text.includes(secret), `result must redact ${secret}`);
        assert.ok(!envelope.includes(secret), `envelope must redact ${secret}`);
      }
      assert.match(text, /REDACTED_PASSWORD/);
    });

    await t.test("joins unawaited credential work to its browser execution", async () => {
      await visit("/signup");
      nextPendingId = "pending-detached-task";
      let releaseGeneration;
      let startedResolve;
      const started = new Promise((resolve) => {
        startedResolve = resolve;
      });
      generationGate = {
        release: new Promise((resolve) => {
          releaseGeneration = resolve;
        }),
        startedResolve,
      };

      let firstSettled = false;
      const first = bw
        .run(`
          void credentials.list().then(() =>
            credentials.generateAndFill({
              username: 'detached@example.com',
              passwordSelector: '#signup-password',
            })
          );
          return 'script-finished';
        `)
        .finally(() => {
          firstSettled = true;
        });
      await started;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        firstSettled,
        false,
        "the execution must wait for its detached credential task",
      );

      releaseGeneration();
      const firstResult = await first;
      assert.equal(firstResult.ok, false);
      assert.match(firstResult.error, /recovery metadata was not returned/i);
      assert.deepEqual(firstResult.pendingCredential, {
        pendingId: "pending-detached-task",
        origin: server.origin,
        matchMode: "base-domain",
        username: "detached@example.com",
        label: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.equal(bw._pendingCredentialRecoveries.size, 0);

      const unrelated = await bw.run("throw new Error('unrelated later failure');");
      assert.equal(unrelated.ok, false);
      assert.match(unrelated.error, /unrelated later failure/);
      assert.equal(unrelated.pendingCredential, undefined);
      assert.equal(bw._pendingCredentialRecoveries.size, 0);

      const discarded = await bw.discardGeneratedCredential({
        pendingId: "pending-detached-task",
      });
      assert.equal(discarded.ok, true, discarded.error);
    });

    await t.test(
      "fails ignored credential rejection while preserving an explicit catch",
      async () => {
        await visit("/signup");
        const handled = await bw.run(`
          try {
            await credentials.save({});
          } catch (error) {
            return {caught: String(error.message)};
          }
        `);
        assert.equal(handled.ok, true, handled.error);
        assert.match(handled.result.caught, /credentials\.save requires/i);

        nextPendingId = "pending-ignored-rejection";
        omitGeneratedSecret = true;
        const ignored = await bw.run(`
          void credentials.generateAndFill({
            username: 'ignored@example.com',
            passwordSelector: '#signup-password',
          });
          return 'script-finished';
        `);
        assert.equal(ignored.ok, false);
        assert.match(
          ignored.error,
          /unhandled credential operation.*did not return a credential/i,
        );
        assert.deepEqual(ignored.pendingCredential, {
          pendingId: "pending-ignored-rejection",
          origin: server.origin,
          matchMode: "base-domain",
          username: "ignored@example.com",
          label: null,
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        assert.equal(bw._pendingCredentialRecoveries.size, 0);

        const unrelated = await bw.run("return 'unrelated-success';");
        assert.equal(unrelated.ok, true, unrelated.error);
        assert.equal(unrelated.result, "unrelated-success");
        assert.equal(unrelated.pendingCredential, undefined);

        const discarded = await bw.discardGeneratedCredential({
          pendingId: "pending-ignored-rejection",
        });
        assert.equal(discarded.ok, true, discarded.error);
      },
    );

    await t.test("rejects cyclic credential writes without poisoning later RPCs", async () => {
      await visit("/login");
      const result = await bw.run(`
        const secret = 'cyclic-custom-vault-token';
        const fields = {token: secret};
        fields.self = fields;
        let cycleError = '';
        try {
          await credentials.save({category: 'secure-note', fields});
        } catch (error) {
          cycleError = String(error.message);
        }
        const saved = await credentials.save({
          category: 'secure-note',
          fields: {token: secret},
        });
        return {cycleError, saved, secret};
      `);
      assert.equal(result.ok, true, result.error);
      assert.match(result.result.cycleError, /circular|json/i);
      assert.equal(result.result.saved.id, "saved-test-record");
      assert.ok(!JSON.stringify(result).includes("cyclic-custom-vault-token"));
    });

    await t.test("restarts instead of evicting secrets at redaction capacity", async () => {
      await visit("/login");
      const worker = bw._process;
      const result = await bw.run(`
        const escaped = 'worker-capacity-secret-999';
        const fields = Object.fromEntries(Array.from(
          {length: 201},
          (_, index) => [
            'field-' + index,
            'worker-capacity-secret-' + String(index).padStart(3, '0'),
          ],
        ));
        try {
          await credentials.save({category:'secure-note', fields});
        } catch {}
        console.log(escaped);
        return {[escaped]: escaped};
      `);
      assert.equal(result.ok, false);
      assert.match(result.error, /redaction capacity/i);
      assert.ok(!JSON.stringify(result).includes("worker-capacity-secret-000"));
      assert.ok(!JSON.stringify(result).includes("worker-capacity-secret-999"));
      assert.equal(result.console, undefined);
      assert.equal(bw._process, null);
      assert.notEqual(worker.exitCode, null);

      await visit("/login");
      assert.ok(bw._process);
      assert.notEqual(bw._process, worker);
    });

    await t.test("refuses multiple visible login forms before fetching a secret", async () => {
      await visit("/ambiguous");
      const before = calls.length;
      const result = await bw.fillCredential({});
      assert.equal(result.ok, false);
      assert.match(result.error, /ambiguous|multiple visible credential forms/i);
      assert.equal(calls.length, before);
    });

    await t.test("fills and submits a login form in an open shadow root", async () => {
      await visit("/shadow-login");
      const inspection = await bw.run("return credentials.inspect();");
      assert.equal(inspection.ok, true, inspection.error);
      assert.equal(inspection.result.status, "ready");
      assert.equal(inspection.result.fields.username.autocomplete, "username");
      assert.equal(
        inspection.result.fields.password.autocomplete,
        "current-password",
      );

      const filled = await bw.fillCredential({ submit: true });
      assert.equal(filled.ok, true, filled.error);
      assert.deepEqual(filled.result.filled, ["username", "password"]);
      assert.equal(filled.result.submitted, true);
      assert.ok(!JSON.stringify(filled).includes(loginSecret));
      const state = await bw.run(`return page.evaluate(() => {
        const root = document.querySelector('credential-login').shadowRoot;
        return {
          username: root.querySelector('#shadow-user').value,
          passwordLength: root.querySelector('#shadow-password').value.length,
          submits: window.shadowSubmits || 0,
        };
      });`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "alice@example.com",
        passwordLength: loginSecret.length,
        submits: 1,
      });
    });

    await t.test("treats light and open-shadow credential forms as ambiguous", async () => {
      await visit("/shadow-ambiguous");
      const before = calls.length;
      const result = await bw.fillCredential({});
      assert.equal(result.ok, false);
      assert.match(result.error, /ambiguous|multiple visible credential forms/i);
      assert.equal(calls.length, before);
    });

    await t.test("fills and submits the only cross-origin iframe form", async () => {
      await visit("/iframe-host");
      const inspection = await bw.run("return credentials.inspect();");
      assert.equal(inspection.ok, true, inspection.error);
      assert.equal(inspection.result.status, "ready");
      assert.equal(inspection.result.frameOrigin, frameServer.origin);
      const before = calls.length;
      const result = await bw.fillCredential({ submit: true });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.submitted, true);
      assert.deepEqual(result.result.filled, ["username", "password"]);
      assert.ok(!JSON.stringify(result).includes(frameSecret));
      assert.ok(!JSON.stringify(result).includes(loginSecret));
      assert.deepEqual(calls.slice(before).map(({ action, origin }) => ({ action, origin })), [
        { action: "fill", origin: frameServer.origin },
      ]);
      const state = await bw.run(`
        const frame = page.frames().find(item => item.url().endsWith('/frame-login'));
        return {
          username: await frame.locator('#frame-user').inputValue(),
          passwordLength: await frame.locator('#frame-password').evaluate(element => element.value.length),
          submits: await frame.evaluate(() => window.submits || 0),
        };
      `);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "framed@example.com",
        passwordLength: frameSecret.length,
        submits: 1,
      });
    });

    await t.test("finalizes generated credentials at their recorded origin after navigation", async () => {
      for (const [method, action, resultKey] of [
        ["commitGenerated", "commit", "committed"],
        ["discardGenerated", "discard", "discarded"],
      ]) {
        await visit("/signup");
        const pendingId = `pending-cross-origin-${action}`;
        nextPendingId = pendingId;
        const generated = await bw.generateAndFillCredential({
          passwordSelector: "#signup-password",
        });
        assert.equal(generated.ok, true, generated.error);
        assert.equal(generated.result.pendingId, pendingId);

        const navigated = await bw.run(
          `await page.goto(${JSON.stringify(`${frameServer.origin}/frame-login`)}); return page.url();`,
        );
        assert.equal(navigated.ok, true, navigated.error);
        const before = calls.length;
        const finalized = await bw.run(
          `return credentials.${method}({pendingId: ${JSON.stringify(pendingId)}});`,
        );
        assert.equal(finalized.ok, true, finalized.error);
        assert.equal(finalized.result[resultKey], true);
        assert.deepEqual(
          calls
            .slice(before)
            .filter((call) => call.action === action)
            .map(({ origin }) => origin),
          [server.origin],
        );
      }
    });

    await t.test("fails closed when host and worker pending origins disagree", async () => {
      await visit("/signup");
      const pendingId = "pending-origin-mismatch";
      nextPendingId = pendingId;
      const generated = await bw.generateAndFillCredential({
        passwordSelector: "#signup-password",
      });
      assert.equal(generated.ok, true, generated.error);

      bw._pendingCredentialOrigins.set(pendingId, frameServer.origin);
      const before = calls.length;
      const mismatched = await bw.commitGeneratedCredential({ pendingId });
      assert.equal(mismatched.ok, false);
      assert.match(mismatched.error, /origin does not match/i);
      assert.equal(
        calls.slice(before).some(({ action }) => action === "commit"),
        false,
      );

      bw._pendingCredentialOrigins.set(pendingId, server.origin);
      const discarded = await bw.discardGeneratedCredential({ pendingId });
      assert.equal(discarded.ok, true, discarded.error);
    });

    await t.test("finalizes iframe generation after worker restart and navigation", async () => {
      await visit("/iframe-signup-host");
      const before = calls.length;
      const generated = await bw.generateAndFillCredential({
        matchMode: "exact-origin",
      });
      assert.equal(generated.ok, true, generated.error);
      assert.equal(generated.result.pendingId, "pending-frame-1");
      assert.deepEqual(generated.result.filled, ["password", "confirmPassword"]);
      assert.ok(!JSON.stringify(generated).includes(generatedSecret));
      const generateCall = calls.slice(before).find(({ action }) => action === "generate");
      assert.equal(generateCall.origin, frameServer.origin);
      assert.equal(generateCall.payload.matchMode, "exact-origin");

      const state = await bw.run(`
        const frame = page.frames().find(item => item.url().endsWith('/frame-signup'));
        return {
          username: await frame.locator('#frame-signup-user').inputValue(),
          passwordLength: await frame.locator('#frame-signup-password').evaluate(element => element.value.length),
          confirmationMatches: await frame.evaluate(() =>
            document.querySelector('#frame-signup-password').value ===
            document.querySelector('#frame-signup-confirm').value
          ),
        };
      `);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "framed-signup@example.com",
        passwordLength: generatedSecret.length,
        confirmationMatches: true,
      });

      const worker = bw._process;
      assert.ok(worker, "generation should have a live worker");
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
      await visit("/signup");

      const beforeCommit = calls.length;
      const committed = await bw.commitGeneratedCredential({
        pendingId: generated.result.pendingId,
      });
      assert.equal(committed.ok, true, committed.error);
      assert.equal(committed.result.committed, true);
      const commitCall = calls.findLast(({ action }) => action === "commit");
      assert.equal(commitCall.origin, frameServer.origin);
      assert.deepEqual(
        calls
          .slice(beforeCommit)
          .filter(({ action }) => action === "commit")
          .map(({ origin }) => origin),
        [frameServer.origin],
      );
    });

    await t.test("refuses credential forms in multiple frames without vault access", async () => {
      await visit("/iframe-ambiguous");
      const before = calls.length;
      const result = await bw.fillCredential({});
      assert.equal(result.ok, false);
      assert.match(result.error, /ambiguous|multiple frames/i);
      assert.equal(calls.length, before);
    });

    await t.test("does not assign parent origin to an opaque sandboxed frame", async () => {
      await visit("/opaque-iframe");
      const before = calls.length;
      const result = await bw.fillCredential({});
      assert.equal(result.ok, false);
      assert.match(result.error, /not-found|no visible enabled/i);
      assert.equal(calls.length, before);
    });

    await t.test("does not trust the URL of an opaque sandboxed frame", async () => {
      await visit("/opaque-http-iframe");
      const before = calls.length;
      const result = await bw.fillCredential({});
      assert.equal(result.ok, false);
      assert.match(result.error, /not-found|no visible enabled/i);
      assert.equal(calls.length, before);
    });

    await t.test("fills password-only steps and avoids new-password fields", async () => {
      await visit("/password-only");
      const passwordOnly = await bw.fillCredential({});
      assert.equal(passwordOnly.ok, true, passwordOnly.error);
      assert.deepEqual(passwordOnly.result.filled, ["password"]);

      await visit("/change");
      const changed = await bw.fillCredential({});
      assert.equal(changed.ok, true, changed.error);
      const lengths = await bw.run(`return page.evaluate(() => ({
        current: document.querySelector('#current').value.length,
        next: document.querySelector('#new').value.length,
        confirm: document.querySelector('#confirm').value.length,
      }));`);
      assert.equal(lengths.ok, true, lengths.error);
      assert.deepEqual(lengths.result, {
        current: loginSecret.length,
        next: 0,
        confirm: 0,
      });
    });

    await t.test("does not treat arbitrary nearby text fields as usernames", async () => {
      await visit("/non-username");
      const result = await bw.fillCredential({});
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.result.filled, ["password"]);
      const state = await bw.run(`return page.evaluate(() => ({
        displayName: document.querySelector('#display-name').value,
        securityAnswer: document.querySelector('#security-answer').value,
        passwordLength: document.querySelector('#semantic-password').value.length,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        displayName: "Visible name",
        securityAnswer: "First school",
        passwordLength: loginSecret.length,
      });
    });

    await t.test("rotation fills current and generated secrets into distinct fields", async () => {
      await visit("/change");
      const before = calls.length;
      const result = await bw.generateAndFillCredential({ id: "login-1" });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.result.filled, [
        "currentPassword",
        "password",
        "confirmPassword",
      ]);
      assert.ok(!JSON.stringify(result).includes(loginSecret));
      assert.ok(!JSON.stringify(result).includes(generatedSecret));
      const rotationCalls = calls.slice(before);
      assert.deepEqual(
        rotationCalls.map(({ action }) => action),
        ["fill", "generate"],
      );
      assert.deepEqual(rotationCalls[0].payload, { id: "login-1" });
      assert.equal(rotationCalls[0].origin, server.origin);
      assert.equal(rotationCalls[1].payload.id, "login-1");
      assert.ok(!Object.hasOwn(rotationCalls[1].payload, "username"));
      assert.ok(!Object.hasOwn(rotationCalls[1].payload, "label"));
      const state = await bw.run(`return page.evaluate(() => ({
        currentLength: document.querySelector('#current').value.length,
        newLength: document.querySelector('#new').value.length,
        confirmationMatches:
          document.querySelector('#new').value ===
          document.querySelector('#confirm').value,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        currentLength: loginSecret.length,
        newLength: generatedSecret.length,
        confirmationMatches: true,
      });

      const beforeInvalidRotation = calls.length;
      const invalidHostRotation = await bw.generateAndFillCredential({
        id: "login-1",
        matchMode: "host",
      });
      assert.equal(invalidHostRotation.ok, false);
      assert.match(
        invalidHostRotation.error,
        /cannot be changed.*existing credential/i,
      );
      assert.equal(calls.length, beforeInvalidRotation);

      const invalidSandboxRotation = await bw.run(
        "return credentials.generateAndFill({id:'login-1',matchMode:'host'});",
      );
      assert.equal(invalidSandboxRotation.ok, false);
      assert.match(
        invalidSandboxRotation.error,
        /cannot be changed.*existing credential/i,
      );
      assert.equal(calls.length, beforeInvalidRotation);
    });

    await t.test("explicit selectors disambiguate every password role during rotation", async () => {
      for (const surface of ["host", "sandbox"]) {
        await visit("/ambiguous-change");
        const pendingId = `pending-explicit-rotation-${surface}`;
        nextPendingId = pendingId;
        const options = {
          id: "login-1",
          currentPasswordSelector: "#primary-current",
          passwordSelector: "#primary-new",
          confirmPasswordSelector: "#primary-confirm",
        };
        const before = calls.length;
        const result =
          surface === "host"
            ? await bw.generateAndFillCredential(options)
            : await bw.run(
                `return credentials.generateAndFill(${JSON.stringify(options)});`,
              );
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.pendingId, pendingId);
        assert.deepEqual(result.result.filled, [
          "currentPassword",
          "password",
          "confirmPassword",
        ]);
        assert.deepEqual(
          calls.slice(before).map(({ action, origin }) => ({ action, origin })),
          [
            { action: "fill", origin: server.origin },
            { action: "generate", origin: server.origin },
          ],
        );

        const state = await bw.run(`return page.evaluate(() => ({
          currentLength: document.querySelector('#primary-current').value.length,
          newLength: document.querySelector('#primary-new').value.length,
          confirmationMatches:
            document.querySelector('#primary-new').value ===
            document.querySelector('#primary-confirm').value,
          decoyLengths: [
            document.querySelector('#decoy-current').value.length,
            document.querySelector('#decoy-new').value.length,
            document.querySelector('#decoy-confirm').value.length,
          ],
        }));`);
        assert.equal(state.ok, true, state.error);
        assert.deepEqual(state.result, {
          currentLength: loginSecret.length,
          newLength: generatedSecret.length,
          confirmationMatches: true,
          decoyLengths: [0, 0, 0],
        });
        const discarded = await bw.discardGeneratedCredential({ pendingId });
        assert.equal(discarded.ok, true, discarded.error);
      }

      await visit("/change");
      const beforeInvalidFill = calls.length;
      const invalidFill = await bw.fillCredential({
        currentPasswordSelector: "#current",
        passwordSelector: "#new",
      });
      assert.equal(invalidFill.ok, false);
      assert.match(invalidFill.error, /only available when generating/i);
      assert.equal(calls.length, beforeInvalidFill);

      const duplicateRotation = await bw.generateAndFillCredential({
        id: "login-1",
        currentPasswordSelector: "#current",
        passwordSelector: "#current",
        confirmPasswordSelector: "#confirm",
      });
      assert.equal(duplicateRotation.ok, false);
      assert.match(duplicateRotation.error, /detached|document changed/i);
      assert.equal(calls.length, beforeInvalidFill);
    });

    await t.test("retains explicit selector compatibility", async () => {
      await visit("/explicit");
      const result = await bw.fillCredential({
        usernameSelector: "#explicit-user",
        passwordSelector: "#explicit-password",
        submitSelector: "#explicit-submit",
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.submitted, true);
      const state = await bw.run(`return page.evaluate(() => ({
        username: document.querySelector('#explicit-user').value,
        passwordLength: document.querySelector('#explicit-password').value.length,
        submitted: window.explicitSubmitted === true,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "alice@example.com",
        passwordLength: loginSecret.length,
        submitted: true,
      });

      await visit("/explicit");
      const snapshot = await bw.run("return snapshot({interactive:true});");
      assert.equal(snapshot.ok, true, snapshot.error);
      const passwordRef = snapshot.result.match(
        /textbox "Password" \[ref=(e\d+)\]/,
      )?.[1];
      const submitRef = snapshot.result.match(/button "Go" \[ref=(e\d+)\]/)?.[1];
      assert.ok(passwordRef && submitRef, snapshot.result);
      const byRef = await bw.fillCredential({
        usernameSelector: "#explicit-user",
        passwordSelector: `aria-ref=${passwordRef}`,
        submitSelector: `aria-ref=${submitRef}`,
      });
      assert.equal(byRef.ok, true, byRef.error);
      assert.equal(byRef.result.submitted, true);
    });

    await t.test(
      "a page-defined never-settling blur cannot restart the worker after a credential fill",
      { timeout: 10_000 },
      async () => {
        await visit("/never-settling-blur");
        const started = Date.now();
        const result = await bw.fillCredential({
          usernameSelector: "#blur-user",
          passwordSelector: "#blur-password",
        });
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.result.filled, ["username", "password"]);
        assert.ok(Date.now() - started < 5_000, "credential blur used bounded browser input");
        const state = await bw.run(`return page.evaluate(() => ({
          username: document.querySelector('#blur-user').value,
          passwordLength: document.querySelector('#blur-password').value.length,
        }));`);
        assert.equal(state.ok, true, state.error);
        assert.deepEqual(state.result, {
          username: "alice@example.com",
          passwordLength: loginSecret.length,
        });
      },
    );

    await t.test(
      "pins explicit targets and origin before a delayed vault lookup",
      { timeout: 20_000 },
      async () => {
        await visit("/explicit-race-source");
        const vaultStarted = armNavigationRace("fill");
        try {
          const before = calls.length;
          const filling = bw.fillCredential({
            usernameSelector: "#race-user",
            passwordSelector: "#race-password",
            confirmPasswordSelector: "#race-confirm",
            submitSelector: "#race-submit",
          });
          await vaultStarted;
          const result = await filling;
          assert.equal(result.ok, false);
          assert.match(result.error, /attached|detached|document|execution context/i);
          assert.deepEqual(
            calls
              .slice(before)
              .filter(({ action }) => action === "fill")
              .map(({ origin }) => origin),
            [server.origin],
          );

          const state = await bw.run(`return page.evaluate(() => ({
            origin: location.origin,
            username: document.querySelector('#race-user').value,
            password: document.querySelector('#race-password').value,
            confirmation: document.querySelector('#race-confirm').value,
            secretCharacters: window.secretCharacters,
            submits: window.raceSubmits || 0,
          }));`);
          assert.equal(state.ok, true, state.error);
          assert.deepEqual(state.result, {
            origin: frameServer.origin,
            username: "",
            password: "",
            confirmation: "",
            secretCharacters: 0,
            submits: 0,
          });
        } finally {
          navigationRace = null;
        }
      },
    );

    await t.test("omits absent signup metadata and preserves a prefilled username", async () => {
      await visit("/prefilled-signup");
      const before = calls.length;
      const result = await bw.generateAndFillCredential({});
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.result.filled, ["password", "confirmPassword"]);
      const generateCall = calls.slice(before).find(({ action }) => action === "generate");
      assert.ok(generateCall);
      assert.ok(!Object.hasOwn(generateCall.payload, "username"));
      assert.ok(!Object.hasOwn(generateCall.payload, "label"));
      const beforeSandboxGenerate = calls.length;
      const sandboxGenerated = await bw.run(
        "return credentials.generateAndFill({label:null,matchMode:'exact-origin'});",
      );
      assert.equal(sandboxGenerated.ok, true, sandboxGenerated.error);
      const sandboxGenerateCall = calls
        .slice(beforeSandboxGenerate)
        .find(({ action }) => action === "generate");
      assert.ok(sandboxGenerateCall);
      assert.ok(!Object.hasOwn(sandboxGenerateCall.payload, "username"));
      assert.equal(Object.hasOwn(sandboxGenerateCall.payload, "label"), true);
      assert.equal(sandboxGenerateCall.payload.label, null);
      assert.equal(sandboxGenerateCall.payload.matchMode, "exact-origin");
      const beforeInvalidMatchMode = calls.length;
      const invalidMatchMode = await bw.run(
        "return credentials.generateAndFill({matchMode:'same-site'});",
      );
      assert.equal(invalidMatchMode.ok, false);
      assert.match(invalidMatchMode.error, /matchMode.*exact-origin/);
      assert.equal(calls.length, beforeInvalidMatchMode);
      const state = await bw.run(`return page.evaluate(() => ({
        username: document.querySelector('#prefilled-user').value,
        passwordLength: document.querySelector('#prefilled-password').value.length,
        confirmationMatches:
          document.querySelector('#prefilled-password').value ===
          document.querySelector('#prefilled-confirm').value,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "prefilled@example.com",
        passwordLength: generatedSecret.length,
        confirmationMatches: true,
      });
      assert.ok(!JSON.stringify(result).includes(generatedSecret));
    });

    await t.test("returns pending recovery when host or sandbox filling fails after generation", async () => {
      await visit("/explicit-race-source");
      nextPendingId = "pending-host-recovery";
      const hostVaultStarted = armNavigationRace("generate");
      const hostFilling = bw.generateAndFillCredential({
        username: "",
        label: null,
        matchMode: "exact-origin",
        passwordSelector: "#race-password",
        submitSelector: "#race-submit",
      });
      await hostVaultStarted;
      const hostFailure = await hostFilling;
      navigationRace = null;
      assert.equal(hostFailure.ok, false);
      assert.deepEqual(hostFailure.pendingCredential, {
        pendingId: "pending-host-recovery",
        origin: server.origin,
        matchMode: "exact-origin",
        username: "",
        label: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.ok(!JSON.stringify(hostFailure).includes(generatedSecret));
      assert.equal(
        bw._pendingCredentialOrigins.get("pending-host-recovery"),
        server.origin,
      );
      assert.equal(bw._pendingCredentialRecoveries.size, 0);
      const discardedHost = await bw.discardGeneratedCredential({
        pendingId: "pending-host-recovery",
      });
      assert.equal(discardedHost.ok, true, discardedHost.error);

      await visit("/explicit-race-source");
      nextPendingId = "pending-sandbox-recovery";
      const sandboxVaultStarted = armNavigationRace("generate");
      const sandboxFilling = bw.run(`
        return credentials.generateAndFill({
          username: '',
          label: null,
          matchMode: 'host',
          passwordSelector: '#race-password',
          submitSelector: '#race-submit',
        });
      `);
      await sandboxVaultStarted;
      const sandboxFailure = await sandboxFilling;
      navigationRace = null;
      assert.equal(sandboxFailure.ok, false);
      assert.deepEqual(sandboxFailure.pendingCredential, {
        pendingId: "pending-sandbox-recovery",
        origin: server.origin,
        matchMode: "host",
        username: "",
        label: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.ok(!JSON.stringify(sandboxFailure).includes(generatedSecret));
      const discardedSandbox = await bw.discardGeneratedCredential({
        pendingId: "pending-sandbox-recovery",
      });
      assert.equal(discardedSandbox.ok, true, discardedSandbox.error);
    });

    await t.test("fails closed before a second generation in one execution", async () => {
      await visit("/signup");
      nextPendingId = "pending-single-generation";
      const before = calls.length;
      const result = await bw.run(`
        const [first, second] = await Promise.allSettled([
          credentials.generateAndFill({
            passwordSelector: '#signup-password',
          }),
          credentials.generateAndFill({
            passwordSelector: '#signup-password',
          }),
        ]);
        return {
          pendingId: first.status === 'fulfilled' ? first.value.pendingId : null,
          secondError:
            second.status === 'rejected'
              ? String(second.reason?.message || second.reason)
              : '',
        };
      `);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.pendingId, "pending-single-generation");
      assert.match(result.result.secondError, /only one credential may be generated/i);
      assert.equal(
        calls.slice(before).filter(({ action }) => action === "generate").length,
        1,
      );
      const discarded = await bw.discardGeneratedCredential({
        pendingId: "pending-single-generation",
      });
      assert.equal(discarded.ok, true, discarded.error);
    });

    await t.test("does not recover a credential finalized before a later failure", async () => {
      for (const action of ["commitGenerated", "discardGenerated"]) {
        await visit("/signup");
        nextPendingId = `pending-finalized-${action}`;
        const result = await bw.run(`
          const generated = await credentials.generateAndFill({
            passwordSelector: '#signup-password',
          });
          await credentials.${action}({pendingId: generated.pendingId});
          throw new Error('failure after finalization');
        `);
        assert.equal(result.ok, false);
        assert.match(result.error, /failure after finalization/);
        assert.equal(result.pendingCredential, undefined);
        assert.equal(
          bw._pendingCredentialRecoveries.size,
          0,
          `${action} clears host recovery metadata`,
        );
        assert.equal(
          bw._pendingCredentialOrigins.has(`pending-finalized-${action}`),
          false,
        );
      }
    });

    await t.test("recovers pending metadata when the worker exits after generation RPC", async () => {
      await visit("/signup");
      nextPendingId = "pending-worker-exit";
      killWorkerAfterGenerate = true;
      const result = await bw.generateAndFillCredential({
        username: "exit@example.com",
        label: "",
        matchMode: "host",
        passwordSelector: "#signup-password",
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /worker exited unexpectedly/i);
      assert.deepEqual(result.pendingCredential, {
        pendingId: "pending-worker-exit",
        origin: server.origin,
        matchMode: "host",
        username: "exit@example.com",
        label: "",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.ok(!JSON.stringify(result).includes(generatedSecret));
      assert.equal(bw._pendingCredentialRecoveries.size, 0);
      assert.equal(
        bw._pendingCredentialOrigins.get("pending-worker-exit"),
        server.origin,
      );

      await visit("/signup");
      const discarded = await bw.discardGeneratedCredential({
        pendingId: "pending-worker-exit",
      });
      assert.equal(discarded.ok, true, discarded.error);
      assert.equal(
        bw._pendingCredentialOrigins.has("pending-worker-exit"),
        false,
      );
    });

    await t.test("detects signup confirmation and returns only pending metadata", async () => {
      await visit("/signup");
      const inspection = await bw.run("return credentials.inspect({generate:true});");
      assert.equal(inspection.result.status, "ready");
      assert.equal(
        inspection.result.fields.password.autocomplete,
        "new-password",
      );
      assert.equal(
        inspection.result.fields.confirmPassword.autocomplete,
        "new-password",
      );

      const result = await bw.generateAndFillCredential({
        id: "rotate-1",
        username: "new@example.com",
      });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.result.filled, [
        "username",
        "password",
        "confirmPassword",
      ]);
      assert.equal(result.result.pending, true);
      assert.equal(result.result.pendingId, "pending-1");
      assert.ok(!JSON.stringify(result).includes(generatedSecret));
      const generateCall = calls.findLast((call) => call.action === "generate");
      assert.equal(generateCall.payload.id, "rotate-1");
      const state = await bw.run(`return page.evaluate(() => ({
        username: document.querySelector('#signup-user').value,
        passwordLength: document.querySelector('#signup-password').value.length,
        confirmationMatches:
          document.querySelector('#signup-password').value ===
          document.querySelector('#signup-confirm').value,
      }));`);
      assert.equal(state.ok, true, state.error);
      assert.deepEqual(state.result, {
        username: "new@example.com",
        passwordLength: generatedSecret.length,
        confirmationMatches: true,
      });

      const hostPending = await bw.listPendingCredentials();
      assert.equal(hostPending.ok, true, hostPending.error);
      assert.deepEqual(
        hostPending.result.map(({ pendingId }) => pendingId),
        ["pending-1"],
      );
      const sandboxPending = await bw.run(
        "return credentials.listPending();",
      );
      assert.equal(sandboxPending.ok, true, sandboxPending.error);
      assert.deepEqual(
        sandboxPending.result.map(({ pendingId }) => pendingId),
        ["pending-1"],
      );
      assert.ok(!JSON.stringify(hostPending).includes(generatedSecret));
      assert.ok(!JSON.stringify(sandboxPending).includes(generatedSecret));

      const beforeMissingPendingId = calls.length;
      const missingHostId = await bw.commitGeneratedCredential({});
      assert.equal(missingHostId.ok, false);
      assert.match(missingHostId.error, /pendingId/);
      const missingSandboxId = await bw.run(
        "return credentials.discardGenerated({});",
      );
      assert.equal(missingSandboxId.ok, false);
      assert.match(missingSandboxId.error, /pendingId/);
      assert.equal(calls.length, beforeMissingPendingId);

      const committed = await bw.commitGeneratedCredential({
        pendingId: "pending-1",
      });
      assert.equal(committed.ok, true, committed.error);
      assert.equal(committed.result.committed, true);
      assert.ok(!JSON.stringify(committed).includes(generatedSecret));
      const discarded = await bw.discardGeneratedCredential({
        pendingId: "pending-2",
      });
      assert.equal(discarded.ok, true, discarded.error);
      assert.equal(discarded.result.discarded, true);
      assert.ok(!JSON.stringify(discarded).includes(generatedSecret));

      const sandboxed = await bw.run(`return {
        committed: await credentials.commitGenerated({pendingId: 'pending-3'}),
        discarded: await credentials.discardGenerated({pendingId: 'pending-4'}),
      };`);
      assert.equal(sandboxed.ok, true, sandboxed.error);
      assert.equal(sandboxed.result.committed.committed, true);
      assert.equal(sandboxed.result.discarded.discarded, true);
      assert.ok(!JSON.stringify(sandboxed).includes(generatedSecret));
    });
  } finally {
    await bw.close();
    await frameServer.close();
    await server.close();
  }
});
