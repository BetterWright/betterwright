import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, E2ECase, E2EContext } from "./types.js";

function success(result: CommandResult) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

function failure(result: CommandResult, expected: RegExp) {
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

async function tree(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    result.push(entry.name);
    if (entry.isDirectory()) {
      result.push(...(await tree(path.join(directory, entry.name))).map((name) => `${entry.name}/${name}`));
    }
  }
  return result.sort();
}

async function stopSessions(ctx: E2EContext) {
  success(await ctx.command(["close", "--all"]));
}

export const cases: E2ECase[] = [
  {
    id: "cli-help-is-read-only",
    group: "cli",
    title: "Every documented command answers help without creating user state",
    async run(ctx) {
      const before = await tree(ctx.workDir);
      const main = success(await ctx.command(["--help"]));
      assert.match(main, /Usage: betterwright/);
      const commands = [...main.matchAll(/^ {2}([a-z]+)\s{2,}\S/gm)].map((match) => match[1]);
      assert.ok(commands.length >= 20, "The public command inventory was not found in help");
      for (const command of commands) {
        const direct = success(await ctx.command([command, "--help"], { timeoutMs: 15_000 }));
        assert.match(direct, /Usage: betterwright/, command);
        const routed = success(await ctx.command(["help", command], { timeoutMs: 15_000 }));
        assert.equal(routed, direct, `help ${command} differs from ${command} --help`);
      }
      assert.match(success(await ctx.command(["--local", "--help"])), /local setup/);
      assert.deepEqual(await tree(ctx.workDir), before);
    },
  },
  {
    id: "cli-version",
    group: "cli",
    title: "Version aliases return only a semantic version without user-state writes",
    async run(ctx) {
      const before = await tree(ctx.workDir);
      const version = success(await ctx.command(["--version"]));
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\n$/);
      assert.equal(success(await ctx.command(["-v"])), version);
      assert.equal(success(await ctx.command(["--version", "--profile", "../invalid"])), version);
      assert.deepEqual(await tree(ctx.workDir), before);
    },
  },
  {
    id: "cli-invalid-command-and-profile",
    group: "cli",
    title: "Unknown commands and unsafe profile names fail before browser startup",
    async run(ctx) {
      const before = await tree(ctx.workDir);
      failure(await ctx.command(["not-a-betterwright-command"]), /Unknown command/);
      failure(await ctx.command(["run", "-c", "return 1", "--profile", "../escape"]), /--profile:/);
      failure(await ctx.command(["sessions"], { env: { BETTERWRIGHT_PROFILE: "../escape" } }), /BETTERWRIGHT_PROFILE:/);
      assert.match(success(await ctx.command(["run", "--help", "--profile", "../escape"])), /Usage:/);
      assert.deepEqual(await tree(ctx.workDir), before);
    },
  },
  {
    id: "cli-exec-input-validation",
    group: "cli",
    title: "Exec rejects absent, whitespace-only, ambiguous, and removed inputs",
    async run(ctx) {
      failure(await ctx.command(["exec"]), /Usage: betterwright exec/);
      failure(await ctx.command(["exec", "--stdin"], { stdin: " \n\t " }), /Usage: betterwright exec/);
      failure(await ctx.command(["exec", "task", "--stdin"], { stdin: "another task" }), /either a task argument or --stdin/);
      failure(await ctx.command(["exec", "task", "--model-id", "old-name"]), /--model-id was merged into --model/);
    },
  },
  {
    id: "cli-missing-snippet-file",
    group: "cli",
    title: "A missing snippet file fails rather than reading stdin or launching a session",
    async run(ctx) {
      failure(await ctx.command(["run", path.join(ctx.workDir, "missing-snippet.js")]), /ENOENT|No such file/);
      assert.match(success(await ctx.command(["sessions"])), /No session daemon is running/);
    },
  },
  {
    id: "cli-snippet-input-modes",
    group: "cli",
    title: "Inline, file, explicit stdin, and implicit stdin execute through the public binary",
    requiresBrowser: true,
    async run(ctx) {
      const file = path.join(ctx.workDir, "cli-input-fixture.js");
      await writeFile(file, 'return { input: "file", value: 6 * 7 };\n');
      const inputs = [
        { args: ["-c", 'return { input: "inline", value: 6 * 7 };'], input: "inline", stdin: "" },
        { args: [file], input: "file", stdin: "" },
        { args: ["-"], input: "stdin", stdin: 'return { input: "stdin", value: 6 * 7 };' },
        { args: [], input: "implicit", stdin: 'return { input: "implicit", value: 6 * 7 };' },
      ];
      for (const item of inputs) {
        const output = await ctx.json(["run", ...item.args, "--session", "input-modes"], { stdin: item.stdin });
        assert.equal(output.ok, true);
        assert.deepEqual(output.result, { input: item.input, value: 42 });
      }
      await stopSessions(ctx);
    },
  },
  {
    id: "cli-repl-stdin",
    group: "cli",
    title: "REPL runs blank-line-delimited snippets and flushes a final snippet at EOF",
    requiresBrowser: true,
    async run(ctx) {
      const output = success(await ctx.command(["repl", "--session", "repl-input", "--close"], {
        stdin: 'state.value = 20;\nreturn "repl-first-marker";\n\n\nstate.value += 22;\nreturn { marker: "repl-final-marker", value: state.value };',
      }));
      assert.match(output, /BetterWright REPL/);
      const marker = output.indexOf("\n{");
      assert.ok(marker >= 0, output);
      const envelopes = output.slice(marker + 1).trim().split(/\n(?=\{)/).map((value) => JSON.parse(value));
      assert.equal(envelopes.length, 2);
      assert.equal(envelopes[0].ok, true);
      assert.equal(envelopes[0].result, "repl-first-marker");
      assert.equal(envelopes[1].ok, true);
      assert.deepEqual(envelopes[1].result, { marker: "repl-final-marker", value: 42 });
    },
  },
  {
    id: "cli-json-and-pretty",
    group: "cli",
    title: "Piped run output is compact JSON unless pretty output is requested",
    requiresBrowser: true,
    async run(ctx) {
      const args = ["run", "-c", 'return { marker: "format-check", nested: { answer: 42 } };', "--session", "format"];
      const compact = success(await ctx.command(args));
      const pretty = success(await ctx.command([...args, "--pretty"]));
      assert.equal(compact.trim().split("\n").length, 1);
      assert.match(pretty, /\n {2}"ok": true/);
      assert.equal(JSON.parse(compact).ok, true);
      assert.deepEqual(JSON.parse(pretty).result, JSON.parse(compact).result);
      await stopSessions(ctx);
    },
  },
  {
    id: "cli-snippet-error-envelope",
    group: "cli",
    title: "Snippet failures return JSON with a failing exit status and leave the session usable",
    requiresBrowser: true,
    async run(ctx) {
      const result = await ctx.run('throw new Error("cli-runtime-failure-marker")', { session: "failures" });
      assert.equal(result.ok, false);
      assert.match(JSON.stringify(result.error), /cli-runtime-failure-marker/);
      const syntax = await ctx.run("return {", { session: "failures" });
      assert.equal(syntax.ok, false);
      assert.ok(syntax.error);
      const recovered = await ctx.run("return 42", { session: "failures" });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.result, 42);
      await stopSessions(ctx);
    },
  },
  {
    id: "cli-empty-session-management",
    group: "cli",
    title: "Session inventory and close are idempotent when no daemon exists",
    async run(ctx) {
      assert.match(success(await ctx.command(["sessions"])), /No session daemon is running/);
      for (const args of [["close"], ["close", "absent"], ["close", "--all"], ["close", "--profile", "absent"]]) {
        assert.match(success(await ctx.command(args)), /nothing to close/);
      }
      assert.match(success(await ctx.command(["sessions"])), /No session daemon is running/);
    },
  },
  {
    id: "cli-session-persistence-and-close",
    group: "cli",
    title: "Named sessions retain separate state and closing one leaves its sibling intact",
    requiresBrowser: true,
    async run(ctx) {
      assert.equal((await ctx.run('state.marker = "alpha"; return state.marker', { session: "alpha-session" })).result, "alpha");
      assert.equal((await ctx.run('state.marker = "beta"; return state.marker', { session: "beta-session" })).result, "beta");
      assert.equal((await ctx.run("return state.marker", { session: "alpha-session" })).result, "alpha");
      const listed = success(await ctx.command(["sessions"]));
      assert.match(listed, /alpha-session/);
      assert.match(listed, /beta-session/);
      assert.match(success(await ctx.command(["close", "alpha-session"])), /Closed session "alpha-session"/);
      const remaining = success(await ctx.command(["sessions"]));
      assert.doesNotMatch(remaining, /alpha-session/);
      assert.match(remaining, /beta-session/);
      assert.equal((await ctx.run("return state.marker", { session: "beta-session" })).result, "beta");
      await stopSessions(ctx);
      assert.match(success(await ctx.command(["sessions"])), /No session daemon is running/);
    },
  },
  {
    id: "cli-run-close",
    group: "cli",
    title: "Run --close returns its result but does not preserve the closed session state",
    requiresBrowser: true,
    async run(ctx) {
      const first = await ctx.run('state.marker = "discard"; return 42', { session: "bounded", args: ["--close"] });
      assert.equal(first.ok, true);
      assert.equal(first.result, 42);
      const next = await ctx.run("return Object.hasOwn(state, 'marker')", { session: "bounded", args: ["--close"] });
      assert.equal(next.ok, true);
      assert.equal(next.result, false);
    },
  },
  {
    id: "cli-configure-persistence",
    group: "cli",
    title: "Configure saves and resets the browser selection across invocations without connecting",
    async run(ctx) {
      const initial = await ctx.json(["configure", "--show", "--json"]);
      assert.equal(initial.default, null);
      assert.equal(path.relative(ctx.home, initial.file).startsWith(".."), false);
      success(await ctx.command(["configure", "--browser", "wss://browser.invalid/devtools/browser/e2e", "--no-test"]));
      const saved = await ctx.json(["configure", "--show", "--json"]);
      assert.equal(saved.default.cdpUrl, "wss://browser.invalid/devtools/browser/e2e");
      const persisted = JSON.parse(await readFile(saved.file, "utf8"));
      assert.equal(persisted.browser.default.cdpUrl, saved.default.cdpUrl);
      assert.equal((await stat(saved.file)).mode & 0o077, 0);
      success(await ctx.command(["configure", "--managed"]));
      assert.equal((await ctx.json(["configure", "--show", "--json"])).default, null);
    },
  },
  {
    id: "cli-configure-key-masking",
    group: "cli",
    title: "Stored synthetic provider keys persist but never appear in configure output",
    async run(ctx) {
      const key = "e2e-synthetic-browser-key-do-not-use";
      ctx.redact(key);
      const configured = await ctx.command(["configure", "--browser", "browserbase", "--browser-key", key, "--no-test"]);
      success(configured);
      assert.equal(`${configured.stdout}${configured.stderr}`.includes(key), false);
      const shown = await ctx.command(["configure", "--show", "--json"]);
      const data = JSON.parse(success(shown));
      assert.equal(data.default.apiKey, "***");
      assert.equal(data.accounts.browserbase.apiKey, "***");
      assert.equal(`${shown.stdout}${shown.stderr}`.includes(key), false);
      assert.equal(success(await ctx.command(["configure", "--show"])).includes(key), false);
      const stored = JSON.parse(await readFile(data.file, "utf8"));
      assert.equal(stored.browser.default.apiKey === key, true);
      assert.equal((await stat(data.file)).mode & 0o077, 0);
    },
  },
  {
    id: "cli-configure-environment-and-fallbacks",
    group: "cli",
    title: "Environment key references avoid persistence and fallback order survives reload",
    async run(ctx) {
      const key = "e2e-environment-only-provider-key";
      ctx.redact(key);
      const env = { E2E_BROWSER_PROVIDER_KEY: key };
      success(await ctx.command(["configure", "--browser", "steel", "--key-env", "E2E_BROWSER_PROVIDER_KEY", "--browser-fallback", "managed", "--browser-fallback", "wss://fallback.invalid/browser", "--no-test"], { env }));
      const shown = await ctx.json(["configure", "--show", "--json"], { env });
      assert.equal(shown.default.keyEnv, "E2E_BROWSER_PROVIDER_KEY");
      assert.equal(shown.default.keyEnvSet, true);
      assert.equal(Object.hasOwn(shown.default, "apiKey"), false);
      assert.deepEqual(shown.fallbacks, [{ provider: "managed" }, { cdpUrl: "wss://fallback.invalid/browser" }]);
      assert.equal((await readFile(shown.file, "utf8")).includes(key), false);
      assert.equal((await ctx.json(["configure", "--show", "--json"], { env: { E2E_BROWSER_PROVIDER_KEY: "" } })).default.keyEnvSet, false);
      success(await ctx.command(["configure", "--clear-fallbacks"]));
      assert.deepEqual((await ctx.json(["configure", "--show", "--json"])).fallbacks, []);
    },
  },
  {
    id: "cli-configure-invalid-values",
    group: "cli",
    title: "Invalid provider configuration fails without changing the saved selection",
    async run(ctx) {
      const before = await ctx.json(["configure", "--show", "--json"]);
      failure(await ctx.command(["configure", "--browser", "https://browser.invalid"]), /CDP endpoint must be a ws:\/\/ or wss:\/\//);
      failure(await ctx.command(["configure", "--browser", "not-a-provider"]), /[Uu]nknown.*provider/);
      failure(await ctx.command(["configure", "--browser", "steel", "--browser-key", "synthetic", "--key-env", "E2E_KEY"]), /--browser-key.*--key-env|--key-env.*--browser-key/);
      assert.deepEqual(await ctx.json(["configure", "--show", "--json"]), before);
    },
  },
  {
    id: "cli-auth-status-isolated",
    group: "cli",
    title: "Auth status reports signed out from isolated homes without attempting login",
    async run(ctx) {
      const codex = path.join(ctx.home, "empty-codex");
      const grok = path.join(ctx.home, "empty-grok");
      const result = await ctx.command(["auth", "--status"], { env: { CODEX_HOME: codex, GROK_HOME: grok } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /codex\s+not signed in/);
      assert.match(result.stdout, /grok\s+not signed in/);
      assert.equal(existsSync(codex), false);
      assert.equal(existsSync(grok), false);
    },
  },
  {
    id: "cli-skills-read-only",
    group: "cli",
    title: "Skill printing, listing, and safe lookup work without installing or traversing paths",
    async run(ctx) {
      const before = await tree(ctx.home);
      assert.match(success(await ctx.command(["skill"])), /betterwright run/);
      assert.match(success(await ctx.command(["skill", "--claude"])), /^---\n/);
      const listed = success(await ctx.command(["skills", "list"]));
      const name = listed.split("\n").find((line) => /^[a-z0-9-]+\t/.test(line))?.split("\t")[0];
      assert.ok(name, "No packaged skills were listed");
      assert.ok(success(await ctx.command(["skills", "show", name])).trim().length > 50);
      const sentinel = path.join(ctx.workDir, "cli-skill-traversal.txt");
      await writeFile(sentinel, "CLI_SKILL_TRAVERSAL_MUST_NOT_BE_READ");
      for (const target of ["../cli-skill-traversal.txt", sentinel, "missing-e2e-skill"]) {
        const result = await ctx.command(["skills", "show", target]);
        assert.equal(result.code, 1);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CLI_SKILL_TRAVERSAL_MUST_NOT_BE_READ/);
      }
      assert.deepEqual(await tree(ctx.home), before);
    },
  },
  {
    id: "cli-vault-terminal-required",
    group: "cli",
    title: "Vault setup and unlock refuse piped master passwords without creating credentials",
    async run(ctx) {
      for (const action of ["setup", "unlock"]) {
        const result = await ctx.command(["vault", action], { stdin: "not-a-real-password\nnot-a-real-password\n" });
        failure(result, /terminal is required for master-password entry/);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not-a-real-password/);
      }
      const status = await ctx.json(["vault", "status", "--json"]);
      assert.equal(status.configured, false);
      const entries = await tree(ctx.home);
      assert.equal(entries.some((entry) => /(?:^|\/)(?:vault\.enc|master-key\.json)$/.test(entry)), false);
    },
  },
  {
    id: "cli-cookie-validation-only",
    group: "cli",
    title: "Cookie commands reject invalid arguments before inspecting source cookie stores",
    async run(ctx) {
      const invalid = [
        ["browsers", "unexpected"],
        ["profiles"],
        ["sync"],
        ["sync", "chrome"],
        ["sync", "chrome", "--all", "--domain", "example.invalid"],
        ["sync", "chrome", "--domain", "--all"],
      ];
      for (const args of invalid) {
        const result = await ctx.command(["cookies", ...args, "--json"]);
        assert.equal(result.code, 1);
        const body = JSON.parse(result.stdout);
        assert.equal(body.ok, false);
        assert.match(body.error, /Usage:|requires|takes no positional/);
      }
      assert.match(success(await ctx.command(["sessions"])), /No session daemon is running/);
    },
  },
  {
    id: "cli-doctor-structured-prerequisites",
    group: "cli",
    title: "Doctor returns structured prerequisites and exit status tracks reported readiness",
    async run(ctx) {
      const result = await ctx.command(["doctor", "--json"]);
      const report = JSON.parse(result.stdout);
      assert.equal(result.code, report.ready ? 0 : 1);
      assert.equal(report.worker_ok, true);
      assert.equal(report.playwright_version, report.playwright_pinned);
      assert.ok([true, false].includes(report.provider_ready));
      assert.ok(report.runtime);
      assert.ok(report.runtime_version);
      assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
      for (const check of report.checks) {
        assert.ok(check.group && check.label);
        assert.ok(["ok", "warn", "fail"].includes(check.status), JSON.stringify(check));
        assert.equal(Object.hasOwn(check, "detail"), true);
      }
      const output = await ctx.command(["doctor", "--quiet"]);
      assert.ok(output.code === 0 || output.code === 1);
      assert.match(output.stdout, /ready|Not ready/);
    },
  },
];
