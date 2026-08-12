// `betterwright init` and the readiness report it leans on.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  doctorChecks,
  formatDoctorChecks,
  missingForkFontsWarning,
  modelReadiness,
  modelSetupHint,
  preferredModelId,
} from "../../dist/src/doctor.js";
import {
  agentHostTargets,
  detectAgentHosts,
  runInit,
  upsertCodexInstructions,
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
  cloakbrowser: "/x/cloakbrowser",
  cloakbrowser_version: "0.4.10",
  cloakbrowser_pinned: "0.4.10",
  cloakbrowser_binary_version: "145.0.0.0",
  cloakbrowser_binary_tier: "free",
  cloakbrowser_binary: "/x/chrome",
  cloakbrowser_ok: true,
  chromium_fork: "/x/fork/chrome",
  chromium_fork_version: "150.0.0.0",
  chromium_fork_error: null,
  cloak_fallback: null,
  browser_selection_reason: "native-available",
  chromium_fork_fonts: "/x/fork/fonts",
  chromium_fork_fonts_warning: null,
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
    cloakbrowser_ok: false,
    browser: "cloak",
  });
  const failures = broken.filter((check) => check.status === "fail");
  assert.ok(failures.length >= 2);
  assert.ok(failures.every((check) => check.fix));
});

test("doctor only warns about missing fork font bundles on Linux", () => {
  const chromiumFork = "/x/fork/chrome";
  assert.match(
    missingForkFontsWarning({
      chromiumFork,
      chromiumForkFonts: null,
      platform: "linux",
    }),
    /fontconfig/,
  );
  assert.equal(
    missingForkFontsWarning({
      chromiumFork,
      chromiumForkFonts: null,
      platform: "win32",
    }),
    null,
  );
  assert.equal(
    missingForkFontsWarning({
      chromiumFork,
      chromiumForkFonts: null,
      platform: "darwin",
    }),
    null,
  );
  assert.equal(
    missingForkFontsWarning({
      chromiumFork,
      chromiumForkFonts: "/x/fork/fonts",
      platform: "linux",
    }),
    null,
  );
});

test("doctor explains the automatic compatibility backend on unsupported hosts", () => {
  const checks = doctorChecks({
    ...READY_REPORT,
    chromium_fork: null,
    chromium_fork_version: null,
    cloak_fallback: "unsupported-platform",
    browser_selection_reason: "unsupported-platform",
    browser: "cloak",
  });
  const native = checks.find((check) => check.label === "BetterChromium");
  const cloak = checks.find((check) => check.label === "CloakBrowser");
  assert.equal(native.status, "warn");
  assert.match(native.detail, /no artifact is published/);
  assert.match(cloak.detail, /automatic compatibility backend/);
});

test("doctor explains the WebGL-compatible fallback on GPU-less Linux", () => {
  const checks = doctorChecks({
    ...READY_REPORT,
    cloak_fallback: "gpu-unavailable",
    browser_selection_reason: "render-device-unavailable",
    browser: "cloak",
  });
  const native = checks.find((check) => check.label === "BetterChromium");
  const cloak = checks.find((check) => check.label === "CloakBrowser");
  assert.equal(native.status, "warn");
  assert.match(native.detail, /no accessible Linux render device/);
  assert.match(native.detail, /WebGL remains available/);
  assert.match(cloak.detail, /automatic compatibility backend/);
});

test("doctor makes forced backend selection and its tradeoff explicit", () => {
  const nativeChecks = doctorChecks({
    ...READY_REPORT,
    browser_selection_reason: "forced-chromium-fork",
  });
  const native = nativeChecks.find((check) => check.label === "BetterChromium");
  assert.equal(native.status, "warn");
  assert.match(native.detail, /BETTERWRIGHT_BACKEND=chromium-fork/);
  assert.match(native.fix, /Verify WebGL/);

  const cloakChecks = doctorChecks({
    ...READY_REPORT,
    chromium_fork: null,
    chromium_fork_version: null,
    browser: "cloak",
    cloak_fallback: "explicit",
    browser_selection_reason: "forced-cloak",
  });
  const cloak = cloakChecks.find((check) => check.label === "BetterChromium");
  assert.equal(cloak.status, "warn");
  assert.match(cloak.detail, /BETTERWRIGHT_BACKEND=cloak/);
  assert.match(cloak.fix, /Unset BETTERWRIGHT_BACKEND/);
});

test("doctor output groups checks and marks each status", () => {
  const text = formatDoctorChecks(doctorChecks(READY_REPORT));
  assert.match(text, /^Runtime$/m);
  assert.match(text, /^Browser$/m);
  assert.match(text, /✓ Node:/);

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
