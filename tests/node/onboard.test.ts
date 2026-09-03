// `betterwright init` and the readiness report it leans on.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  doctorChecks,
  formatDoctorChecks,
  modelReadiness,
  modelSetupHint,
  preferredModelId,
} from "../../dist/src/doctor.js";
import {
  agentHostTargets,
  detectAgentHosts,
  firstRunMarkerPath,
  maybeOfferFirstRunSetup,
  runInit,
  upsertCodexInstructions,
  welcomeCardLines,
} from "../../dist/src/onboard.js";

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-init-"));
  test.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const READY_REPORT = {
  node: process.execPath,
  worker: "/x/worker.mjs",
  worker_ok: true,
  playwright_core: "/x/playwright-core",
  playwright_version: "1.61.1",
  playwright_pinned: "1.61.1",
  chromium_fork: "/x/fork/chrome",
  chromium_fork_version: "151.0.7922.108",
  chromium_fork_error: null,
  software_gpu: false,
  browser_selection_reason: "native-available",
  provider: null,
  provider_error: null,
  stealth_driver: "1.61.1",
  stealth_available: true,
  browser: "chromium-fork",
  ready: true,
};

function initHarness(home, overrides = {}) {
  const lines = [];
  const installed = [];
  return {
    lines,
    installed,
    options: {
      home,
      log: (line) => lines.push(String(line)),
      doctorReport: async () => READY_REPORT,
      installBrowser: async () => 0,
      installAgentSkills: ({ targets }) => {
        installed.push(...targets);
        return { written: targets.map((id) => path.join(home, `.${id}`, "SKILL.md")) };
      },
      skillMarkdown: () => "---\nname: browser\n---\n\nbody",
      skillBody: () => "# Browser tool: BetterWright\n\nbody",
      verify: async () => ({ ok: true, launched: true, detail: 'example.com → "Example Domain"' }),
      ...overrides,
    },
    get output() {
      return lines.join("\n");
    },
  };
}

test("init detects only the agent hosts that exist", () => {
  const home = tempHome();
  assert.deepEqual(
    detectAgentHosts(home).filter((host) => host.present),
    [],
  );

  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  const present = detectAgentHosts(home).filter((host) => host.present).map((h) => h.id);
  assert.deepEqual(present.sort(), ["claude", "codex"]);
});

test("every agent host target names a real marker and a way to wire it", () => {
  // path.join(home) normalizes the separators so the prefix check also holds
  // on Windows, where the markers come back with backslashes.
  const home = path.join("/home/example");
  for (const target of agentHostTargets("/home/example")) {
    assert.ok(target.id && target.label && target.how, `${target.id} is incomplete`);
    assert.ok(target.marker.startsWith(home));
    assert.ok(
      target.skillTarget || target.codexFile,
      `${target.id} has no way to be installed`,
    );
  }
});

test("codex instructions are written once and updated in place", () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "AGENTS.md");

  assert.equal(upsertCodexInstructions(file, "first body"), "created");
  assert.match(fs.readFileSync(file, "utf8"), /first body/);

  assert.equal(upsertCodexInstructions(file, "first body"), "unchanged");
  assert.equal(upsertCodexInstructions(file, "second body"), "updated");

  const contents = fs.readFileSync(file, "utf8");
  assert.match(contents, /second body/);
  assert.doesNotMatch(contents, /first body/);
  // Exactly one managed block, however many times init runs.
  assert.equal(contents.split("betterwright:begin").length - 1, 1);
});

test("codex instructions preserve whatever the user already wrote", () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# Mine\n\nAlways use tabs.\n");

  upsertCodexInstructions(file, "browser guidance");
  upsertCodexInstructions(file, "browser guidance v2");

  const contents = fs.readFileSync(file, "utf8");
  assert.match(contents, /Always use tabs/);
  assert.match(contents, /browser guidance v2/);
});

test("a version-stamped block is replaced across an upgrade, not stacked", () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "AGENTS.md");

  assert.equal(upsertCodexInstructions(file, "body", { version: "1.4.0" }), "created");
  assert.match(fs.readFileSync(file, "utf8"), /betterwright:begin v1\.4\.0 -->/);

  // A later version must find last version's block by prefix and replace it.
  assert.equal(upsertCodexInstructions(file, "body", { version: "1.5.0" }), "updated");
  const contents = fs.readFileSync(file, "utf8");
  assert.equal(contents.split("betterwright:begin").length - 1, 1, "one block, not two");
  assert.match(contents, /betterwright:begin v1\.5\.0 -->/);
});

test("unbalanced markers make upsert refuse rather than destroy user text", () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // An orphan begin with the user's own text after it: the old first-begin /
  // first-end splice ate everything up to a later end. Now it must refuse and
  // leave the file byte-for-byte intact.
  const original =
    "# Mine\n<!-- betterwright:begin -->\nKEEP THIS LINE\nand this one\n";
  fs.writeFileSync(file, original);
  assert.throws(() => upsertCodexInstructions(file, "body"), /not a single clean pair/);
  assert.equal(fs.readFileSync(file, "utf8"), original, "file untouched on refusal");

  // End-before-begin is equally ambiguous and equally refused.
  const reversed = "<!-- betterwright:end -->\ntext\n<!-- betterwright:begin -->\n";
  fs.writeFileSync(file, reversed);
  assert.throws(() => upsertCodexInstructions(file, "body"), /not a single clean pair/);
  assert.equal(fs.readFileSync(file, "utf8"), reversed);
});

test("init wires detected hosts, verifies, and reports ready", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  const harness = initHarness(home);

  const code = await runInit({ flags: new Set(["--yes"]), ...harness.options });

  assert.equal(code, 0);
  assert.deepEqual(harness.installed, ["claude"]);
  assert.ok(fs.existsSync(path.join(home, ".codex", "AGENTS.md")));
  assert.match(harness.output, /BetterWright is ready/);
  assert.match(harness.output, /Loaded a real page/);
});

test("init fails loudly when the browser cannot start", async () => {
  const home = tempHome();
  const harness = initHarness(home, {
    verify: async () => ({ ok: false, launched: false, detail: "worker exited" }),
  });

  const code = await runInit({ flags: new Set(["--yes"]), ...harness.options });

  assert.equal(code, 1);
  assert.match(harness.output, /could not start: worker exited/);
  assert.doesNotMatch(harness.output, /BetterWright is ready/);
});

test("init warns but does not fail when the browser starts yet the page will not load", async () => {
  const home = tempHome();
  const harness = initHarness(home, {
    // The install is fine; the network is not. Failing the whole run over a
    // dropped page load after everything is on disk misreports what happened.
    verify: async () => ({ ok: false, launched: true, detail: "net::ERR_INTERNET_DISCONNECTED" }),
  });

  const code = await runInit({ flags: new Set(["--yes"]), ...harness.options });

  assert.equal(code, 0);
  assert.match(harness.output, /could not load a test page/);
  assert.match(harness.output, /network-restricted/);
  assert.doesNotMatch(harness.output, /could not start/);
});

test("init stops when the browser install fails rather than claiming success", async () => {
  const home = tempHome();
  let verified = false;
  const harness = initHarness(home, {
    doctorReport: async () => ({ ...READY_REPORT, ready: false }),
    installBrowser: async () => 1,
    verify: async () => {
      verified = true;
      return { ok: true, detail: "unreachable" };
    },
  });

  const code = await runInit({ flags: new Set(["--yes"]), ...harness.options });

  assert.equal(code, 1);
  assert.equal(verified, false, "verification must not run after a failed install");
  assert.match(harness.output, /browser download failed/);
});

test("init skips cleanly with --skip-browser and --skip-agents", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const harness = initHarness(home, {
    installBrowser: async () => {
      throw new Error("must not install");
    },
    verify: async () => {
      throw new Error("must not verify");
    },
  });

  const code = await runInit({
    flags: new Set(["--yes", "--skip-browser", "--skip-agents"]),
    ...harness.options,
  });

  assert.equal(code, 0);
  assert.deepEqual(harness.installed, []);
  assert.match(harness.output, /Browser: skipped/);
  assert.match(harness.output, /Agent setup: skipped/);
});

test("init tells a user with no agent host what to do instead", async () => {
  const home = tempHome();
  const harness = initHarness(home);

  await runInit({ flags: new Set(["--yes"]), ...harness.options });

  assert.match(harness.output, /No agent hosts detected/);
  assert.match(harness.output, /betterwright skill --install/);
});

test("doctor checks translate a raw report into fixable lines", () => {
  const checks = doctorChecks(READY_REPORT);
  assert.ok(checks.length > 5);
  for (const check of checks) {
    assert.ok(["ok", "warn", "fail"].includes(check.status), `bad status ${check.status}`);
    assert.ok(check.group && check.label && check.detail !== undefined);
    // A problem the user is expected to act on must say how.
    if (check.status === "fail") assert.ok(check.fix, `${check.label} fails with no fix`);
  }

  const broken = doctorChecks({
    ...READY_REPORT,
    ready: false,
    playwright_version: "1.50.0",
    chromium_fork: null,
    chromium_fork_version: null,
    browser: "unavailable",
    browser_selection_reason: "native-missing",
  });
  const failures = broken.filter((check) => check.status === "fail");
  assert.ok(failures.length >= 2);
  assert.ok(failures.every((check) => check.fix));
});

test("doctor surfaces the SwiftShader fallback on GPU-less Linux", () => {
  const checks = doctorChecks({
    ...READY_REPORT,
    software_gpu: true,
    browser_selection_reason: "software-gpu",
  });
  const native = checks.find((check) => check.label === "BetterChromium");
  assert.equal(native.status, "warn");
  assert.match(native.detail, /SwiftShader/);
  assert.match(native.fix, /render device/);
});

test("doctor explains provider browsers and the missing artifact", () => {
  const checks = doctorChecks({
    ...READY_REPORT,
    provider: {
      kind: "remote",
      provider: "browserbase",
      name: "Browserbase",
      endpoint: "wss://connect.browserbase.com/***",
    },
  });
  const provider = checks.find((check) => check.label === "Provider");
  assert.equal(provider.status, "warn");
  assert.match(provider.detail, /Browserbase/);
  assert.match(provider.detail, /outside the guard proxy/);

  const unsupported = doctorChecks({
    ...READY_REPORT,
    chromium_fork: null,
    chromium_fork_version: null,
    browser: "unavailable",
    browser_selection_reason: "unsupported-platform",
  });
  const native = unsupported.find((check) => check.label === "BetterChromium");
  assert.equal(native.status, "fail");
  assert.match(native.detail, /no artifact is published/);
  assert.match(native.fix, /provider option/);
});

test("doctor output groups checks and marks each status", () => {
  const text = formatDoctorChecks(doctorChecks(READY_REPORT));
  assert.match(text, /^Runtime$/m);
  assert.match(text, /^Browser$/m);
  assert.match(text, /✓ (?:Bun|Node):/);

  const quiet = formatDoctorChecks(doctorChecks(READY_REPORT), { quiet: true });
  assert.doesNotMatch(quiet, /✓/);
});

test("the default model follows what is actually configured", () => {
  // `auth` is injected so the developer's own ~/.codex / ~/.grok sign-ins do
  // not decide the outcome — the old test silently passed or changed answer
  // depending on who ran it.
  const noAuth = { codex: false, grok: false };

  // Nothing configured: not configured, and the historical default is kept so
  // an Anthropic-path user is unaffected.
  const none = preferredModelId({ env: {}, auth: noAuth });
  assert.equal(none.configured, false);
  assert.equal(none.model, "claude-opus-4-8");

  // Codex sign-in — the sign-in the README recommends first — must resolve to
  // the codex default, not fall through to a claude id that needs an SDK the
  // user never installed. This is the regression the branch exists to fix.
  const codex = preferredModelId({ env: {}, auth: { codex: true, grok: false } });
  assert.equal(codex.configured, true);
  assert.match(codex.model, /^gpt-/);

  // A plain API key resolves through the same native adapter as a sign-in, so
  // `exec` must not refuse it.
  const key = preferredModelId({ env: { OPENAI_API_KEY: "sk-test" }, auth: noAuth });
  assert.equal(key.configured, true);
  assert.match(key.model, /^gpt-/);

  const grokKey = preferredModelId({ env: { XAI_API_KEY: "xai-test" }, auth: noAuth });
  assert.equal(grokKey.configured, true);
  assert.match(grokKey.model, /^grok-/);

  // An override is honoured.
  const override = preferredModelId({
    env: { OPENAI_API_KEY: "sk-test", BETTERWRIGHT_CODEX_MODEL: "gpt-9-custom" },
    auth: noAuth,
  });
  assert.equal(override.model, "gpt-9-custom");

  // Nothing at all → the four-route hint.
  const hint = modelSetupHint({ env: {}, auth: noAuth });
  assert.match(hint, /auth --login codex/);
  assert.match(hint, /ANTHROPIC_API_KEY/);
});

test("a usable-but-defaultless backend gets a name-one hint, not a false refusal", () => {
  const noAuth = { codex: false, grok: false };
  const env = { OPENROUTER_API_KEY: "or-test" };

  // doctor counts OpenRouter as a working backend...
  assert.ok(modelReadiness({ env, auth: noAuth }).sources.some((s) => /openrouter/.test(s)));
  // ...but there is no bare-id default for it, so exec still needs a name.
  assert.equal(preferredModelId({ env, auth: noAuth }).configured, false);

  const hint = modelSetupHint({ env, auth: noAuth });
  // The hint must not tell a user whose backend doctor just approved that
  // "no model backend is configured" — that is false and offers no route out.
  assert.doesNotMatch(hint, /No model backend is configured/);
  assert.match(hint, /openrouter\/<id>/);
});

// --- First-run onboarding gate ---------------------------------------------

const NOT_READY_REPORT = { ...READY_REPORT, chromium_fork: null, browser: "unavailable", ready: false };

function firstRunHarness(home, overrides = {}) {
  const calls = { doctor: 0, init: 0 };
  return {
    calls,
    options: {
      home,
      isTTY: true,
      version: "9.9.9",
      log: () => {},
      doctorReport: async () => {
        calls.doctor += 1;
        return NOT_READY_REPORT;
      },
      runInit: async () => {
        calls.init += 1;
        return 0;
      },
      confirm: async () => true,
      ...overrides,
    },
  };
}

function readMarker(home) {
  return JSON.parse(fs.readFileSync(firstRunMarkerPath(home), "utf8"));
}

test("first-run offer never fires without a TTY", async () => {
  const home = tempHome();
  const { calls, options } = firstRunHarness(home, { isTTY: false });
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(calls.doctor, 0);
  assert.equal(calls.init, 0);
  assert.equal(fs.existsSync(firstRunMarkerPath(home)), false);
});

test("accepted first run delegates to init and writes the marker once", async () => {
  const home = tempHome();
  const { calls, options } = firstRunHarness(home);
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(calls.init, 1);
  assert.equal(readMarker(home).setup, "completed");
  assert.equal(readMarker(home).version, "9.9.9");
  // The marker short-circuits the next launch before any doctor check.
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(calls.doctor, 1);
  assert.equal(calls.init, 1);
});

test("declining the first-run offer is remembered and never re-asked", async () => {
  const home = tempHome();
  const { calls, options } = firstRunHarness(home, { confirm: async () => false });
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(calls.init, 0);
  assert.equal(readMarker(home).setup, "declined");
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(calls.doctor, 1);
});

test("an already-ready install records the marker quietly, no prompt", async () => {
  const home = tempHome();
  let asked = false;
  const { calls, options } = firstRunHarness(home, {
    doctorReport: async () => {
      calls.doctor += 1;
      return READY_REPORT;
    },
    confirm: async () => {
      asked = true;
      return true;
    },
  });
  // The harness's calls object is created before overrides run; rebuild count.
  calls.doctor = 0;
  assert.equal(await maybeOfferFirstRunSetup(options), null);
  assert.equal(asked, false);
  assert.equal(calls.init, 0);
  assert.equal(readMarker(home).setup, "already-ready");
});

test("a failed init surfaces its exit code and leaves no marker", async () => {
  const home = tempHome();
  const { options } = firstRunHarness(home, { runInit: async () => 7 });
  assert.equal(await maybeOfferFirstRunSetup(options), 7);
  // No marker: the next launch should offer setup again.
  assert.equal(fs.existsSync(firstRunMarkerPath(home)), false);
  assert.equal(await maybeOfferFirstRunSetup({ ...options, runInit: async () => 0 }), null);
  assert.equal(readMarker(home).setup, "completed");
});

test("welcome card is a closed box with even edges and no paint bleed", () => {
  const identity = (text) => String(text);
  const paint = {
    accent: identity,
    accentBold: identity,
    bold: identity,
    dim: identity,
    heading: identity,
  };
  const lines = welcomeCardLines(paint);
  assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
  assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
  const width = lines[0].length;
  for (const line of lines) assert.equal(line.length, width, line);
  assert.ok(lines.some((line) => line.includes("Welcome to BetterWright")));
  assert.ok(lines.some((line) => line.includes("~200 MB")));
});
