import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  browserConfigPath,
  configuredProviderChain,
  expandProviderChainOption,
  expandProviderChoice,
  loadBrowserConfig,
  saveBrowserFallbacks,
  saveCustomProvider,
  saveDefaultBrowser,
  saveProviderAccount,
} from "../../dist/src/browser-config.js";
import {
  cookieSyncConsentTarget,
  providerPlanLabel,
  providerResolutionPlans,
  resolveBrowserProvider,
  runProviderChain,
} from "../../dist/src/browser-providers.js";
import { daemonConfigSignature, normalizeDaemonConfig } from "../../dist/src/daemon.js";
import { isCallable } from "../../dist/src/untrusted-value.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(browserConfigPath(home), JSON.stringify(config));
}

test("a provider array resolves to an ordered plan chain", () => {
  const env = {};
  const resolution = resolveBrowserProvider(
    [
      { cdpUrl: "wss://a.example.com/connect" },
      "managed",
      { cdpUrl: "wss://b.example.com/connect" },
    ],
    { env },
  );
  const plans = providerResolutionPlans(resolution);
  assert.equal(plans.length, 3);
  assert.equal(plans[0].provider, "cdp");
  assert.equal(plans[1].kind, "managed");
  assert.equal(plans[2].provider, "cdp");
  assert.match(plans[0].cdpUrl, /a\.example\.com/);
  assert.match(plans[2].cdpUrl, /b\.example\.com/);
});

test("a single-element array collapses to a single plan", () => {
  const resolution = resolveBrowserProvider(
    [{ cdpUrl: "wss://only.example.com" }],
    { env: {} },
  );
  assert.equal(resolution.plan.kind, "remote");
  assert.equal(resolution.plans, undefined);
});

test("chain elements reject the shapes a single choice rejects", () => {
  for (const bad of [[], [null], [["nested"]], [42], [{ provider: "cdp", cdpUrl: "wss://x" }]]) {
    assert.throws(
      () => resolveBrowserProvider(bad, { env: {} }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  // A null entry must not fall back to the env shorthand.
  assert.throws(
    () =>
      resolveBrowserProvider([null], {
        env: { BETTERWRIGHT_CDP_URL: "wss://env.example.com" },
      }),
    TypeError,
  );
});

test("an unresolvable entry is skipped, not a veto of the chain", () => {
  // A missing binary or a bad scheme mid-chain must not fail the survivors.
  const resolution = resolveBrowserProvider(
    [
      { executablePath: "/definitely/not/installed/chromium" },
      { cdpUrl: "https://not-a-websocket.example.com" },
      "managed",
    ],
    { env: {} },
  );
  const plans = providerResolutionPlans(resolution);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "managed");
  assert.equal(resolution.notes.length, 2);
  assert.match(resolution.notes[0], /provider\[0\] skipped: .*does not exist/);
  assert.match(resolution.notes[1], /provider\[1\] skipped: .*ws/);
});

test("a chain where nothing resolves names every entry's failure", () => {
  let error;
  try {
    resolveBrowserProvider(
      [
        { executablePath: "/definitely/not/installed/chromium" },
        { provider: "not-a-provider" },
      ],
      { env: {} },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof TypeError);
  assert.match(error.message, /provider\[0\]: .*does not exist/);
  assert.match(error.message, /provider\[1\]: .*Unknown browser provider/);
});

test('"managed" names the managed fork as a provider and chain entry', () => {
  const single = resolveBrowserProvider({ provider: "managed" }, { env: {} });
  assert.equal(single.plan.kind, "managed");
  assert.equal(single.plan.provider, "managed");
  const chain = resolveBrowserProvider(["managed", { cdpUrl: "wss://x.example.com" }], {
    env: {},
  });
  assert.equal(providerResolutionPlans(chain)[0].kind, "managed");
});

test("providerPlanLabel names every candidate kind without credentials", () => {
  const env = {};
  assert.equal(providerPlanLabel(null), "managed BetterChromium fork");
  const plans = providerResolutionPlans(
    resolveBrowserProvider(
      [
        { cdpUrl: "wss://user:secret@cdp.example.com/conn?apiKey=sekret" },
        "managed",
        { provider: "browserless", apiKey: "bl-key" },
      ],
      { env },
    ),
  );
  const [cdp, managed, named] = plans.map((plan) => providerPlanLabel(plan));
  assert.match(cdp, /cdp\.example\.com/);
  assert.doesNotMatch(cdp, /secret|sekret|user/);
  assert.equal(managed, "managed BetterChromium fork");
  assert.equal(named, "browserless");
});

test("runProviderChain tries candidates in order and returns the winner", async () => {
  const seen = [];
  const { result, failures } = await runProviderChain(
    [{ kind: "remote", provider: "a", warnings: [] }, null, { kind: "remote", provider: "b", warnings: [] }],
    async (candidate) => {
      seen.push(providerPlanLabel(candidate));
      if (candidate?.provider === "a") throw new Error("quota exceeded");
      return `won:${providerPlanLabel(candidate)}`;
    },
  );
  assert.deepEqual(seen, ["a", "managed BetterChromium fork"]);
  assert.equal(result, "won:managed BetterChromium fork");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, "a");
  assert.match(String(failures[0].error.message), /quota exceeded/);
});

test("runProviderChain rethrows a single candidate's error verbatim", async () => {
  const sentinel = new TypeError("the original message");
  await assert.rejects(
    runProviderChain([{ kind: "remote", provider: "only", warnings: [] }], async () => {
      throw sentinel;
    }),
    (error) => error === sentinel,
  );
});

test("runProviderChain aggregates every failure when the chain is exhausted", async () => {
  await assert.rejects(
    runProviderChain(
      [
        { kind: "remote", provider: "first", warnings: [] },
        { kind: "remote", provider: "second", warnings: [] },
      ],
      async (candidate) => {
        throw new Error(`${candidate.provider} is down\nwith a second line`);
      },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Every browser provider in the chain failed/);
      assert.match(error.message, /first: first is down/);
      assert.match(error.message, /second: second is down/);
      // Only the first line of each error is carried into the aggregate.
      assert.doesNotMatch(error.message, /second line/);
      return true;
    },
  );
});

test("a minted session's armed end call reaches the provider's stop API", async () => {
  // The worker arms plan.end before connecting and fires it when the connect
  // fails — this walks that exact sequence against the fetchJson seam so the
  // release is observable without a real provider account.
  const calls = [];
  const fetchJson = async (url, request) => {
    calls.push(`${request.method} ${url}`);
    if (request.method === "POST" && url.endsWith("/browsers")) {
      return { session_id: "sess-1", cdp_ws_url: "ws://127.0.0.1:1/dead" };
    }
    if (request.method === "DELETE") return {};
    throw new Error(`unexpected provider call ${request.method} ${url}`);
  };
  const { plan } = resolveBrowserProvider(
    { provider: "kernel", apiKey: "k" },
    { env: {} },
  );
  const live = await plan.create({ fetchJson });
  assert.equal(live.sessionId, "sess-1");
  assert.ok(isCallable(live.end), "a minted session must carry its release call");
  await live.end();
  assert.deepEqual(calls, [
    "POST https://api.onkernel.com/browsers",
    "DELETE https://api.onkernel.com/browsers/sess-1",
  ]);
});

test("a malformed mint response releases the billed session before failing", async () => {
  // The provider minted a session but returned no usable CDP endpoint — the
  // armed release must fire inside create() so a chain advance leaves nothing
  // running.
  const calls = [];
  const fetchJson = async (url, request) => {
    calls.push(`${request.method} ${url}`);
    if (request.method === "POST" && url.endsWith("/browsers")) {
      return { session_id: "sess-1", cdp_ws_url: "" };
    }
    if (request.method === "DELETE") return {};
    throw new Error(`unexpected provider call ${request.method} ${url}`);
  };
  const { plan } = resolveBrowserProvider(
    { provider: "kernel", apiKey: "k" },
    { env: {} },
  );
  await assert.rejects(() => plan.create({ fetchJson }), /CDP WebSocket URL/);
  assert.deepEqual(calls, [
    "POST https://api.onkernel.com/browsers",
    "DELETE https://api.onkernel.com/browsers/sess-1",
  ]);
});

test("cookieSyncConsentTarget names every remote candidate in a chain", () => {
  const env = {};
  assert.equal(
    cookieSyncConsentTarget(
      [
        { provider: "browserless", apiKey: "k" },
        { cdpUrl: "wss://cdp.example.com/x" },
        "managed",
      ],
      { env },
    ),
    "provider:browserless+cdp:cdp.example.com",
  );
  // A local-only chain needs no consent.
  assert.equal(
    cookieSyncConsentTarget(["managed"], { env }),
    null,
  );
  // Single-provider targets are unchanged.
  assert.equal(
    cookieSyncConsentTarget({ cdpUrl: "wss://solo.example.com" }, { env }),
    "cdp:solo.example.com",
  );
});

test("expandProviderChainOption expands entries and skips the bad ones", () => {
  const home = makeTempDir("bw-chain-expand-");
  saveCustomProvider(
    "mine",
    { cdpUrl: "wss://connect.example.com?apiKey=${apiKey}", keyEnv: "MINE_KEY" },
    home,
  );
  const { provider, notes } = expandProviderChainOption(
    [
      { provider: "mine" },
      "managed",
      { provider: "bogus" },
      { cdpUrl: "wss://direct.example.com" },
      null,
    ],
    { home, env: { MINE_KEY: "sk-1" } },
  );
  assert.deepEqual(provider, [
    { cdpUrl: "wss://connect.example.com?apiKey=sk-1" },
    { provider: "managed" },
    { cdpUrl: "wss://direct.example.com" },
  ]);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /provider\[2\] skipped: .*Unknown browser provider/);
  assert.match(notes[1], /provider\[4\] skipped: .*provider chain entries/);
});

test("expandProviderChainOption throws only when no entry survives", () => {
  const home = makeTempDir("bw-chain-allbad-");
  // A one-element array rethrows that entry's own error.
  assert.throws(
    () => expandProviderChainOption([{ provider: "bogus" }], { home, env: {} }),
    /Unknown browser provider/,
  );
  // Several bad entries collapse into one error naming each.
  let error;
  try {
    expandProviderChainOption([{ provider: "bogus" }, null], { home, env: {} });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof TypeError);
  assert.match(error.message, /provider\[0\]: .*Unknown browser provider/);
  assert.match(error.message, /provider\[1\]: .*provider chain entries/);
  // A single survivor collapses to a single provider, notes intact.
  const { provider, notes } = expandProviderChainOption(
    [{ provider: "bogus" }, "managed"],
    { home, env: {} },
  );
  assert.deepEqual(provider, { provider: "managed" });
  assert.equal(notes.length, 1);
});

test("an explicit provider array skips a bad entry into launch notes", async () => {
  const { BetterWright } = await import("../../dist/src/client.js");
  const home = makeTempDir("bw-chain-client-");
  const bw = new BetterWright({
    home,
    vault: false,
    provider: [{ provider: "bogus" }, "managed"],
  });
  try {
    assert.deepEqual(bw.provider, { provider: "managed" });
    assert.equal(bw.providerChainNotes.length, 1);
    assert.match(bw.providerChainNotes[0], /provider\[0\] skipped.*bogus/);
  } finally {
    await bw.close();
  }
});

test("expandProviderChoice fills a built-in's key from a connected account", () => {
  const home = makeTempDir("bw-chain-account-");
  saveProviderAccount("kernel", { apiKey: "kern_saved" }, home);
  assert.deepEqual(
    expandProviderChoice({ provider: "kernel" }, { home, env: {} }),
    { provider: "kernel", apiKey: "kern_saved" },
  );
  // An explicit apiKey still wins over the account.
  assert.deepEqual(
    expandProviderChoice(
      { provider: "kernel", apiKey: "flag_key" },
      { home, env: {} },
    ),
    { provider: "kernel", apiKey: "flag_key" },
  );
  // The account's own keyEnv indirection resolves too.
  saveProviderAccount("steel", { keyEnv: "STEEL_TEST_KEY" }, home);
  assert.deepEqual(
    expandProviderChoice("steel", { home, env: { STEEL_TEST_KEY: "env_key" } }),
    { provider: "steel", apiKey: "env_key" },
  );
  assert.deepEqual(
    expandProviderChoice("steel", { home, env: {} }),
    { provider: "steel" },
  );
});

test("loadBrowserConfig sanitizes the fallbacks list", () => {
  const home = makeTempDir("bw-chain-load-");
  writeConfig(home, {
    browser: {
      fallbacks: [
        { provider: "kernel" },
        { provider: "two", cdpUrl: "wss://bad.example" },
        "not-a-record",
        { cdpUrl: "wss://ok.example" },
      ],
    },
  });
  assert.deepEqual(loadBrowserConfig(home).fallbacks, [
    { provider: "kernel" },
    { cdpUrl: "wss://ok.example" },
  ]);
  writeConfig(home, { browser: { fallbacks: "not-an-array" } });
  assert.equal(loadBrowserConfig(home).fallbacks, undefined);
});

test("saveBrowserFallbacks round-trips, validates, and clears", () => {
  const home = makeTempDir("bw-chain-save-");
  saveBrowserFallbacks([{ provider: "managed" }, { cdpUrl: "wss://x.example" }], home);
  assert.deepEqual(loadBrowserConfig(home).fallbacks, [
    { provider: "managed" },
    { cdpUrl: "wss://x.example" },
  ]);
  assert.throws(
    () => saveBrowserFallbacks([{ provider: "nope" }], home),
    /Unknown provider/,
  );
  assert.throws(
    () => saveBrowserFallbacks([{ provider: "a", cdpUrl: "wss://b" }], home),
    /exactly one of/,
  );
  saveBrowserFallbacks(null, home);
  assert.equal(loadBrowserConfig(home).fallbacks, undefined);
  // The unrelated sections survive.
  saveDefaultBrowser({ provider: "steel" }, home);
  saveBrowserFallbacks([], home);
  assert.equal(loadBrowserConfig(home).fallbacks, undefined);
  assert.equal(loadBrowserConfig(home).default.provider, "steel");
});

test("configuredProviderChain orders default then fallbacks", () => {
  const home = makeTempDir("bw-chain-order-");
  saveCustomProvider(
    "mine",
    { cdpUrl: "wss://connect.example.com?apiKey=${apiKey}", apiKey: "k" },
    home,
  );
  saveDefaultBrowser({ cdpUrl: "wss://default.example" }, home);
  saveBrowserFallbacks([{ provider: "mine" }, { provider: "managed" }], home);
  const { provider, notes } = configuredProviderChain({ home, env: {} });
  assert.deepEqual(provider, [
    { cdpUrl: "wss://default.example" },
    { cdpUrl: "wss://connect.example.com?apiKey=k" },
    { provider: "managed" },
  ]);
  assert.deepEqual(notes, []);
});

test("configuredProviderChain puts the managed fork first without a default", () => {
  const home = makeTempDir("bw-chain-nodefault-");
  saveBrowserFallbacks([{ cdpUrl: "wss://after.example" }], home);
  const { provider } = configuredProviderChain({ home, env: {} });
  assert.deepEqual(provider, [
    { provider: "managed" },
    { cdpUrl: "wss://after.example" },
  ]);
});

test("configuredProviderChain skips a dead fallback with a note", () => {
  const home = makeTempDir("bw-chain-skip-");
  writeConfig(home, {
    browser: {
      fallbacks: [
        { provider: "ghost" }, // neither built-in nor custom
        { provider: "kernel" }, // no key anywhere — cannot resolve
        { cdpUrl: "wss://good.example" },
      ],
    },
  });
  const { provider, notes } = configuredProviderChain({ home, env: {} });
  assert.deepEqual(provider, [
    { provider: "managed" },
    { cdpUrl: "wss://good.example" },
  ]);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /Skipped a browser fallback \(provider ghost\)/);
  assert.match(notes[1], /Skipped a browser fallback \(provider kernel\)/);
});

test("a broken configured default still throws, not degrades to a fallback", () => {
  const home = makeTempDir("bw-chain-default-");
  writeConfig(home, {
    browser: {
      default: { provider: "ghost" },
      fallbacks: [{ cdpUrl: "wss://good.example" }],
    },
  });
  assert.throws(
    () => configuredProviderChain({ home, env: {} }),
    /Unknown browser provider/,
  );
});

test("the daemon signature covers every chain candidate", () => {
  const single = daemonConfigSignature({
    browser: { provider: { provider: "kernel", apiKey: "k1" } },
  });
  const chain = daemonConfigSignature({
    browser: {
      provider: [{ provider: "kernel", apiKey: "k1" }, { provider: "managed" }],
    },
  });
  const other = daemonConfigSignature({
    browser: {
      provider: [{ provider: "kernel", apiKey: "k1" }, { cdpUrl: "wss://x.example" }],
    },
  });
  assert.notEqual(single, chain);
  assert.notEqual(chain, other);
  // Non-record chain elements normalize out rather than breaking the config.
  const normalized = normalizeDaemonConfig({
    browser: {
      provider: [{ provider: "kernel", apiKey: "k1" }, 42, null],
    },
  });
  assert.deepEqual(normalized.browser.provider, [{ provider: "kernel", apiKey: "k1" }]);
});

test("the daemon signature tracks configured fallbacks", async () => {
  const { daemonConfigFromFlags } = await import("../../dist/bin/cli-main.js");
  const home = makeTempDir("bw-daemon-chain-");
  const argv = ["bun", "betterwright", "run", "-c", "return 1"];
  const flags = new Set();
  const sig = () =>
    daemonConfigSignature(daemonConfigFromFlags(flags, { argv, home, env: {} }));

  const base = sig();
  saveBrowserFallbacks([{ provider: "managed" }], home);
  const withManaged = sig();
  saveBrowserFallbacks(
    [{ provider: "managed" }, { cdpUrl: "wss://fb.example.com/connect" }],
    home,
  );
  const extended = sig();
  saveBrowserFallbacks(null, home);
  assert.equal(sig(), base);

  assert.notEqual(base, withManaged);
  assert.notEqual(withManaged, extended);

  // BETTERWRIGHT_CDP_URL wins over the configured chain.
  const envSig = daemonConfigSignature(
    daemonConfigFromFlags(flags, {
      argv,
      home,
      env: { BETTERWRIGHT_CDP_URL: "wss://env.example.com/connect" },
    }),
  );
  assert.match(envSig, /env\.example\.com/);
  assert.notEqual(envSig, base);

  // An explicit --browser flag still wins over both.
  saveBrowserFallbacks([{ provider: "managed" }], home);
  const flagged = daemonConfigSignature(
    daemonConfigFromFlags(flags, {
      argv: ["bun", "betterwright", "run", "--browser", "kernel", "-c", "x"],
      home,
      env: { BETTERWRIGHT_CDP_URL: "wss://env.example.com/connect" },
    }),
  );
  assert.match(flagged, /kernel/);
  assert.doesNotMatch(flagged, /env\.example\.com/);
});

test("doctor ready follows the whole configured chain", async () => {
  const { doctorReport } = await import("../../dist/src/doctor.js");
  const home = makeTempDir("bw-doctor-chain-");
  const saved = {
    home: process.env.BETTERWRIGHT_HOME,
    chromium: process.env.BETTERWRIGHT_CHROMIUM_PATH,
    cdp: process.env.BETTERWRIGHT_CDP_URL,
  };
  // A nonexistent explicit path makes the managed fork report missing.
  process.env.BETTERWRIGHT_HOME = home;
  process.env.BETTERWRIGHT_CHROMIUM_PATH = "/definitely/not/installed/BetterChromium";
  delete process.env.BETTERWRIGHT_CDP_URL;
  try {
    // Remote-only default: launch attaches to the endpoint, so ready stands
    // even with the managed fork absent.
    saveDefaultBrowser({ cdpUrl: "wss://endpoint.example.com/connect" }, home);
    assert.equal((await doctorReport()).ready, true);

    // Managed-only chain with the fork missing: not ready.
    saveDefaultBrowser({ provider: "managed" }, home);
    assert.equal((await doctorReport()).ready, false);

    // A resolvable remote fallback rescues the same missing-fork setup — and
    // the fork's missing binary downgrades to a warning so the check list
    // agrees with ready (cmdDoctor exits on any fail row).
    saveBrowserFallbacks([{ cdpUrl: "wss://fallback.example.com/connect" }], home);
    const report = await doctorReport();
    assert.equal(report.ready, true);
    const { doctorChecks } = await import("../../dist/src/doctor.js");
    const checks = doctorChecks(report);
    const forkRow = checks.find((check) => check.label === "BetterChromium");
    assert.equal(forkRow.status, "warn");
    assert.deepEqual(
      checks.filter((check) => check.status === "fail").map((check) => check.label),
      [],
    );
  } finally {
    if (saved.home === undefined) delete process.env.BETTERWRIGHT_HOME;
    else process.env.BETTERWRIGHT_HOME = saved.home;
    if (saved.chromium === undefined) delete process.env.BETTERWRIGHT_CHROMIUM_PATH;
    else process.env.BETTERWRIGHT_CHROMIUM_PATH = saved.chromium;
    if (saved.cdp === undefined) delete process.env.BETTERWRIGHT_CDP_URL;
    else process.env.BETTERWRIGHT_CDP_URL = saved.cdp;
  }
});

test("a managed ref carrying a conflicting endpoint fails validation", () => {
  const home = makeTempDir("bw-managed-conflict-");
  // Expansion passes the conflict through instead of silently reducing it to
  // managed — the worker's exactly-one-of check then rejects it.
  const expanded = expandProviderChoice(
    { provider: "managed", cdpUrl: "wss://x.example.com" },
    { home, env: {} },
  );
  assert.throws(
    () => resolveBrowserProvider(expanded, { env: {} }),
    /exactly one of/,
  );
  // In a chain the conflicting entry is a skipped candidate, not a veto.
  const resolution = resolveBrowserProvider(
    [{ provider: "managed", cdpUrl: "wss://x.example.com" }, "managed"],
    { env: {} },
  );
  const plans = providerResolutionPlans(resolution);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "managed");
  assert.match(resolution.notes[0], /provider\[0\] skipped: .*exactly one of/);
});

test("configured skip notes ride the daemon config into the browser", async () => {
  const { daemonConfigFromFlags } = await import("../../dist/bin/cli-main.js");
  const { createBrowserFromDaemonConfig } = await import("../../dist/src/daemon.js");
  const home = makeTempDir("bw-daemon-notes-");
  // A fallback whose custom provider was removed after saving is skipped with
  // a note by configuredProviderChain.
  saveCustomProvider(
    "gone",
    { cdpUrl: "wss://gone.example.com?apiKey=${apiKey}", apiKey: "k" },
    home,
  );
  saveBrowserFallbacks([{ provider: "gone" }], home);
  const configPath = browserConfigPath(home);
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete written.browser.custom;
  fs.writeFileSync(configPath, JSON.stringify(written));

  const argv = ["bun", "betterwright", "run", "-c", "return 1"];
  const config = daemonConfigFromFlags(new Set(), { argv, home, env: {} });
  assert.equal(config.browser.providerChainNotes.length, 1);
  assert.match(config.browser.providerChainNotes[0], /Skipped a browser fallback/);
  // The notes are part of the normalized signature too.
  const sig = daemonConfigSignature(config);
  assert.match(sig, /Skipped a browser fallback/);

  const savedHome = process.env.BETTERWRIGHT_HOME;
  process.env.BETTERWRIGHT_HOME = home;
  try {
    const bw = await createBrowserFromDaemonConfig(config);
    try {
      assert.ok(
        bw.providerChainNotes.some((note) => /Skipped a browser fallback/.test(note)),
        `expected the config note on the daemon browser, got ${JSON.stringify(bw.providerChainNotes)}`,
      );
    } finally {
      await bw.close();
    }
  } finally {
    if (savedHome === undefined) delete process.env.BETTERWRIGHT_HOME;
    else process.env.BETTERWRIGHT_HOME = savedHome;
  }
});
