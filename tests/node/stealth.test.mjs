import assert from "node:assert/strict";
import { test } from "node:test";

import { stealthDriverVersion } from "../../src/doctor.mjs";
import { BetterWright } from "../../src/index.mjs";
import { resolve } from "../../src/stealth-hooks.mjs";

// The resolve hook is the load-bearing piece: it swaps the driver for the whole
// worker process (including the Cloak wrapper's own bare import) by rewriting
// the `playwright-core` specifier to `patchright-core` before Node resolves it.
test("stealth hook redirects playwright-core to patchright-core", async () => {
  const calls = [];
  const next = (spec, ctx) => {
    calls.push(spec);
    return { url: `resolved:${spec}`, context: ctx };
  };
  assert.deepEqual(await resolve("playwright-core", { a: 1 }, next), {
    url: "resolved:patchright-core",
    context: { a: 1 },
  });
  assert.deepEqual(await resolve("playwright-core/lib/server", {}, next), {
    url: "resolved:patchright-core/lib/server",
    context: {},
  });
  assert.deepEqual(calls, ["patchright-core", "patchright-core/lib/server"]);
});

test("stealth hook leaves unrelated specifiers untouched", async () => {
  const seen = [];
  const next = (spec) => {
    seen.push(spec);
    return { url: `resolved:${spec}` };
  };
  // A near-miss substring must not be rewritten.
  await resolve("my-playwright-core-shim", {}, next);
  await resolve("node:fs", {}, next);
  await resolve("patchright-core", {}, next);
  assert.deepEqual(seen, [
    "my-playwright-core-shim",
    "node:fs",
    "patchright-core",
  ]);
});

test("stealthRuntimeFix defaults off and honors the explicit option", () => {
  const disabled = new BetterWright();
  const enabled = new BetterWright({ stealthRuntimeFix: true });
  assert.equal(disabled.stealthRuntimeFix, false);
  assert.equal(disabled._workerConfig().stealthRuntimeFix, false);
  assert.equal(enabled.stealthRuntimeFix, true);
  assert.equal(enabled._workerConfig().stealthRuntimeFix, true);
  assert.equal(
    new BetterWright({ stealthRuntimeFix: false }).stealthRuntimeFix,
    false,
  );
});

test("stealthRuntimeFix falls back to the env override", () => {
  const prev = process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
  try {
    process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX = "1";
    assert.equal(new BetterWright().stealthRuntimeFix, true);
    // An explicit option still wins over the env.
    assert.equal(
      new BetterWright({ stealthRuntimeFix: false }).stealthRuntimeFix,
      false,
    );
    process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX = "off";
    assert.equal(new BetterWright().stealthRuntimeFix, false);
  } finally {
    if (prev === undefined) delete process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
    else process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX = prev;
  }
});

test("doctor reports the optional stealth driver version when installed", () => {
  const version = stealthDriverVersion();
  // patchright-core is an optionalDependency; when present it is the pinned
  // drop-in for playwright-core 1.61.x, otherwise the probe reports null.
  assert.ok(version === null || /^\d+\.\d+\.\d+/.test(version));
});
