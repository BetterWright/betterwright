import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import test from "node:test";

import { BetterWright } from "../../dist/src/client.js";
import { makeTempDir } from "./helpers/temp-dir.mjs";

function tempHome() {
  return makeTempDir("betterwright-client-lifecycle-");
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function emitWorkerMessage(child, message) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

test("a hanging custom vault cannot hold request timeout or worker close open", async (t) => {
  const home = tempHome();
  let releaseVault;
  let vaultCall;
  let signalVaultCall;
  let signalVaultSettled;
  let resets = 0;
  const vaultCalled = new Promise((resolve) => (signalVaultCall = resolve));
  const vaultSettled = new Promise((resolve) => (signalVaultSettled = resolve));
  const vault = {
    async handleRequest(action, payload, origin) {
      vaultCall = { action, payload, origin };
      signalVaultCall();
      const result = await new Promise((resolve) => (releaseVault = resolve));
      signalVaultSettled();
      return result;
    },
    resetRedactionSecrets() {
      resets += 1;
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(async () => {
    releaseVault?.({ pendingId: vaultCall?.payload.pendingId });
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  await browser._start();
  const child = browser._process;
  // _dispatch adds a five-second worker-response grace period. A negative
  // internal-only value keeps this lifecycle regression deterministic and fast.
  const dispatched = browser._dispatch({ type: "test_noop" }, -4.9);
  const executionId = [...browser._pending.entries()].find(
    ([, pending]) => pending.child === child,
  )?.[0];
  assert.ok(executionId);
  emitWorkerMessage(child, {
    type: "rpc_request",
    id: executionId,
    requestId: "hanging-generate",
    method: "vault",
    payload: {
      action: "generate",
      origin: "https://signup.example.test",
      payload: { username: "alice@example.test" },
    },
  });
  await vaultCalled;

  const result = await within(
    dispatched,
    2_000,
    "request timeout remained blocked on the custom vault",
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.deepEqual(result.pendingCredential, {
    pendingId: vaultCall.payload.pendingId,
    origin: "https://signup.example.test",
    matchMode: "base-domain",
    username: "alice@example.test",
    label: null,
    expiresAt: null,
  });
  assert.equal(child.exitCode, 0);
  assert.equal(resets, 1);

  releaseVault({ pendingId: vaultCall.payload.pendingId });
  await within(vaultSettled, 1_000, "custom vault did not settle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    browser._pendingCredentialRecoveries.size,
    0,
    "late RPC settlement must not recreate execution-scoped recovery",
  );
  await browser.close();
  assert.equal(resets, 1, "closing an already retired generation must not reset twice");
});

test("unexpected exit resets before replacement and old events cannot reset it", async (t) => {
  const home = tempHome();
  const resetStates = [];
  const vault = {
    liveRedactionState: false,
    async handleRequest() {
      return {};
    },
    resetRedactionSecrets() {
      resetStates.push(this.liveRedactionState);
      this.liveRedactionState = false;
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(async () => {
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  await browser._start();
  const oldChild = browser._process;
  vault.liveRedactionState = true;
  const exited = once(oldChild, "exit");
  oldChild.kill("SIGKILL");
  await exited;

  await within(
    browser._start(),
    2_000,
    "replacement did not start after the old worker closed",
  );
  const replacement = browser._process;
  assert.ok(replacement);
  assert.notEqual(replacement, oldChild);
  assert.deepEqual(resetStates, [true]);

  vault.liveRedactionState = true;
  oldChild.emit("close", oldChild.exitCode, oldChild.signalCode);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    vault.liveRedactionState,
    true,
    "a repeated old-worker close must not clear replacement redaction state",
  );
  assert.deepEqual(resetStates, [true]);

  await browser.close();
  assert.deepEqual(resetStates, [true, true]);
  await browser.close();
  assert.deepEqual(resetStates, [true, true]);
});

test("replacement waits for an asynchronous redaction reset", async (t) => {
  const home = tempHome();
  let releaseFirstReset;
  let signalFirstReset;
  let resets = 0;
  const firstResetStarted = new Promise(
    (resolve) => (signalFirstReset = resolve),
  );
  const vault = {
    async handleRequest() {
      return {};
    },
    async resetRedactionSecrets() {
      resets += 1;
      if (resets !== 1) return;
      signalFirstReset();
      await new Promise((resolve) => (releaseFirstReset = resolve));
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(async () => {
    releaseFirstReset?.();
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  await browser._start();
  const oldChild = browser._process;
  const exited = once(oldChild, "exit");
  oldChild.kill("SIGKILL");
  await exited;

  const replacementStart = browser._start();
  await within(firstResetStarted, 1_000, "asynchronous reset did not start");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    browser._process,
    null,
    "replacement claimed ownership before the old reset settled",
  );

  releaseFirstReset();
  await within(
    replacementStart,
    2_000,
    "replacement did not start after asynchronous reset settled",
  );
  assert.ok(browser._process);
  assert.notEqual(browser._process, oldChild);
  assert.equal(resets, 1);

  await browser.close();
  assert.equal(resets, 2);
});

test("a rejected asynchronous redaction reset cannot reject worker shutdown", async (t) => {
  const home = tempHome();
  let resets = 0;
  const vault = {
    async handleRequest() {
      return {};
    },
    async resetRedactionSecrets() {
      resets += 1;
      throw new Error("reset failed");
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(async () => {
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  await browser._start();
  const oldChild = browser._process;
  const exited = once(oldChild, "exit");
  oldChild.kill("SIGKILL");
  await exited;

  await within(
    browser._start(),
    2_000,
    "rejected reset prevented replacement worker startup",
  );
  assert.ok(browser._process);
  assert.notEqual(browser._process, oldChild);
  assert.equal(resets, 1);

  await browser.close();
  assert.equal(resets, 2);
});

test("a throwing redact() withholds the envelope instead of leaking it", async (t) => {
  const home = tempHome();
  const vault = {
    async handleRequest() {
      return {};
    },
    resetRedactionSecrets() {},
    redact() {
      throw new Error("redaction exploded");
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(async () => {
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  await browser._start();
  const child = browser._process;
  const dispatched = browser._dispatch({ type: "test_noop" }, 30);
  const executionId = [...browser._pending.entries()].find(
    ([, pending]) => pending.child === child,
  )?.[0];
  assert.ok(executionId);
  emitWorkerMessage(child, {
    type: "result",
    id: executionId,
    ok: true,
    result: "leaked-secret-material",
    events: [{ note: "also-secret-material" }],
    pendingCredential: { pendingId: "p-1", origin: "https://signup.example.test" },
  });

  const result = await within(dispatched, 2_000, "dispatch did not settle");
  // Fail closed: none of the unredacted worker fields may survive; only the
  // documented secret-free pendingCredential is preserved so a staged
  // generated credential can still be committed or discarded.
  assert.equal(result.ok, false);
  assert.equal(result.error, "Result withheld: secret redaction failed.");
  assert.deepEqual(result.pendingCredential, {
    pendingId: "p-1",
    origin: "https://signup.example.test",
  });
  assert.ok(!JSON.stringify(result).includes("secret-material"));
});
