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
  assert.equal(new BetterWright().stealthRuntimeFix, false);
  assert.equal(
    new BetterWright({ stealthRuntimeFix: true }).stealthRuntimeFix,
    true,
  );
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

test("stealthRuntimeFix auto-enables in attach mode when the driver is present", async () => {
  const driverPresent = stealthDriverVersion() !== null;
  const prevEnv = process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
  const prevCdp = process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
  delete process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
  delete process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
  const made = [];
  const mk = (opts) => {
    const bw = new BetterWright(opts);
    made.push(bw);
    return bw;
  };
  try {
    // Managed browser (no attach): never auto-enabled.
    const managed = mk({ connectOverCdp: "" });
    assert.equal(managed.stealthRuntimeFix, false);
    assert.equal(managed.stealthAutoAttach, false);

    // Attach mode drives a stock Chrome, so the fix is defaulted on when the
    // optional driver is installed (and left off when it is not).
    const attached = mk({ connectOverCdp: "http://127.0.0.1:9222" });
    assert.equal(attached.stealthRuntimeFix, driverPresent);
    assert.equal(attached.stealthAutoAttach, driverPresent);

    // An explicit opt-out wins even in attach mode: no auto-enable.
    const optOut = mk({
      connectOverCdp: "http://127.0.0.1:9222",
      stealthRuntimeFix: false,
    });
    assert.equal(optOut.stealthRuntimeFix, false);
    assert.equal(optOut.stealthAutoAttach, false);

    // An explicit env decision is also respected verbatim (no auto-enable).
    process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX = "0";
    const envOff = mk({ connectOverCdp: "http://127.0.0.1:9222" });
    assert.equal(envOff.stealthRuntimeFix, false);
    assert.equal(envOff.stealthAutoAttach, false);
  } finally {
    for (const bw of made) await bw.close();
    if (prevEnv === undefined) delete process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
    else process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX = prevEnv;
    if (prevCdp === undefined) delete process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
    else process.env.BETTERWRIGHT_CONNECT_OVER_CDP = prevCdp;
  }
});

test("doctor reports the optional stealth driver version when installed", () => {
  const version = stealthDriverVersion();
  // patchright-core is an optionalDependency; when present it is the pinned
  // drop-in for playwright-core 1.61.x, otherwise the probe reports null.
  assert.ok(version === null || /^\d+\.\d+\.\d+/.test(version));
});
