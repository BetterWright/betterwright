import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSession } from "../../dist/src/worker-session.js";

// None of these imports may install the process-entrypoint wiring or emit its
// ready handshake. This also catches accidental imports back into worker.js.
test("worker subsystems import without process wiring or output", () => {
  const modules = [
    "captcha-runtime", "challenge-scan", "worker-artifacts", "worker-human",
    "worker-live-view", "worker-realm", "worker-sandbox", "worker-session",
    "worker-site", "worker-snapshots",
  ].map((name) => new URL(`../../dist/src/${name}.js`, import.meta.url).href);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const events = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"];
    const before = events.map((event) => process.listenerCount(event));
    const stdinBefore = process.stdin.listenerCount("data");
    for (const url of ${JSON.stringify(modules)}) await import(url);
    const after = events.map((event) => process.listenerCount(event));
    if (JSON.stringify(before) !== JSON.stringify(after)) process.exitCode = 2;
    if (stdinBefore !== process.stdin.listenerCount("data")) process.exitCode = 3;
  `], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("session construction isolates mutable state and credential recovery", () => {
  const first = createSession("first");
  const second = createSession("second");
  first.state.counter = 1;
  first.warnings.push("first warning");
  first.openChallengeProviders.add("recaptcha");
  first.pendingCredentialOrigins.set("pending-1", "https://example.com");
  first.execution.requestId = "execute-1";
  assert.equal(Object.getPrototypeOf(first.state), null);
  assert.equal(second.state.counter, undefined);
  assert.deepEqual(second.warnings, []);
  assert.equal(second.openChallengeProviders.size, 0);
  assert.equal(second.pendingCredentialOrigins.size, 0);
  assert.equal(second.execution.requestId, null);
  assert.notEqual(first.pages, second.pages);
  assert.notEqual(first.cursor, second.cursor);
  assert.notEqual(first.captchaTargets, second.captchaTargets);
});
