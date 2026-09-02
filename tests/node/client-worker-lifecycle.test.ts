// Worker lifecycle from the client's side: what a caller sees when the
// worker restarts, dies at boot, or hangs at boot. None of these need the
// managed browser — the worker prints its ready handshake before any launch.

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { BetterWright, BrowserError } from "../../dist/src/index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function alive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/** Point every worker this test spawns at a boot hook, restoring the env after. */
function bootHook(t, home, source) {
  const hook = path.join(home, "boot-hook.mjs");
  fs.writeFileSync(hook, source);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(hook).href}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
}

test("a restart close keeps the browser open: a call from another lane waits for the replacement worker", async (t) => {
  const home = makeTempDir("bw-restart-race-");
  const browser = new BetterWright({ home, headless: true, vault: false });
  t.after(() => browser.close().catch(() => {}));

  await browser._prepare();
  const first = browser._process;
  assert.ok(alive(first));

  // Exactly what the execution-timeout path does — take the worker down as a
  // restart — while a call from another session lands mid-teardown. It used
  // to be told "This browser has been closed."; it must wait instead.
  const restarting = browser.close({ child: first, preservePending: true, restart: true });
  const config = await browser._prepare();
  await restarting;

  assert.ok(config.profileDir);
  assert.equal(browser._closed, false);
  assert.ok(alive(browser._process));
  assert.notEqual(browser._process, first);
  assert.equal(alive(first), false);
});

test("a final close still refuses new work", async () => {
  const home = makeTempDir("bw-final-close-");
  const browser = new BetterWright({ home, headless: true, vault: false });
  await browser._prepare();
  await browser.close();
  assert.equal(browser._closed, true);
  await assert.rejects(() => browser.run("return 1"), /This browser has been closed/);
});

test("a worker that dies before its handshake fails the call at once, with its stderr", async (t) => {
  const home = makeTempDir("bw-worker-boot-crash-");
  bootHook(t, home, 'throw new Error("boot failure marker 7f3a");\n');
  const browser = new BetterWright({ home, headless: true, vault: false });
  t.after(() => browser.close().catch(() => {}));

  const started = Date.now();
  await assert.rejects(
    () => browser.run("return 1"),
    (error: any) =>
      error instanceof BrowserError &&
      /exited before it was ready/.test(error.message) &&
      /boot failure marker 7f3a/.test(error.message),
  );
  assert.ok(Date.now() - started < 10_000, "must not wait for the start timeout");
  assert.equal(browser._process, null);
});

test("a worker that never answers is killed at the start timeout instead of staying attached", async (t) => {
  const home = makeTempDir("bw-worker-boot-hang-");
  // A live interval keeps the process up; the unsettled await stops the
  // worker entrypoint from ever running, so no handshake is printed.
  bootHook(t, home, "setInterval(() => {}, 1000);\nawait new Promise(() => {});\n");
  const previous = process.env.BETTERWRIGHT_WORKER_START_TIMEOUT_MS;
  process.env.BETTERWRIGHT_WORKER_START_TIMEOUT_MS = "1500";
  t.after(() => {
    if (previous === undefined) delete process.env.BETTERWRIGHT_WORKER_START_TIMEOUT_MS;
    else process.env.BETTERWRIGHT_WORKER_START_TIMEOUT_MS = previous;
  });
  const browser = new BetterWright({ home, headless: true, vault: false });
  t.after(() => browser.close().catch(() => {}));

  const pending = browser.run("return 1");
  while (!browser._process) await new Promise((resolve) => setTimeout(resolve, 10));
  const child = browser._process;
  const exited = once(child, "exit");
  await assert.rejects(pending, /did not start within 2s/);
  // The hung child is gone, and nothing is left attached for the next call
  // to trust.
  await exited;
  assert.equal(alive(child), false);
  assert.equal(browser._process, null);
});

test("writing to a worker that is going down never escapes as an uncaught error", async (t) => {
  const home = makeTempDir("bw-worker-epipe-");
  const browser = new BetterWright({ home, headless: true, vault: false });
  t.after(() => browser.close().catch(() => {}));
  await browser._prepare();
  const child = browser._process;
  // The deterministic half: the stream has an error listener at all.
  assert.ok(child.stdin.listenerCount("error") >= 1);

  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));

  // Kill the worker and keep writing until the client notices. Writes that
  // land after the process is dead but before its exit event runs are the
  // ones that raise EPIPE on stdin.
  child.kill("SIGKILL");
  const closed = once(child, "close");
  const padding = "x".repeat(64 * 1024);
  while (child.exitCode === null && child.signalCode === null) {
    try {
      browser._send({ type: "test_noop", padding }, child);
    } catch (error) {
      assert.match(String(error?.message), /worker is not running/);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(uncaught, []);
});

test("a vault whose redact() returns a non-envelope withholds the result instead of crashing the call", async (t) => {
  const home = makeTempDir("bw-redact-garbage-");
  const vault = {
    async handleRequest() {
      return {};
    },
    redact() {
      return undefined;
    },
  };
  const browser = new BetterWright({ home, headless: true, vault });
  t.after(() => browser.close().catch(() => {}));
  await browser._prepare();
  const status = await browser.liveViewStatus();
  assert.deepEqual(status, {
    ok: false,
    error: "Result withheld: secret redaction failed.",
  });
});
