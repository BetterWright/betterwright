import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CaseResult,
  createContext,
  isolatedEnvironment,
  parseOptions,
  reportExitCode,
  runCase,
  selectCases,
} from "../e2e/harness.js";
import type { E2ECase } from "../e2e/types.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const fixture = fileURLToPath(new URL("./fixtures/e2e-target.ts", import.meta.url));

function options() {
  return parseOptions(["--binary", process.execPath, "--binary-arg", fixture]);
}

function sampleCase(id = "test.case"): E2ECase {
  return { id, group: "cli", title: id, async run() {} };
}

test("E2E options default to the PATH binary and support an explicit launcher", () => {
  assert.equal(parseOptions([]).binary, "betterwright");
  assert.equal(parseOptions(["./bin/custom"]).binary, path.resolve("./bin/custom"));
  const parsed = parseOptions(["--binary", "bun", "--binary-arg", "--preload", "--binary-arg", "guard.ts", "--group", "cli", "--group", "security", "--require-all"]);
  assert.deepEqual(parsed.binaryArgs, ["--preload", "guard.ts"]);
  assert.deepEqual(parsed.groups, ["cli", "security"]);
  assert.equal(parsed.requireAll, true);
});

test("E2E options reject typos, missing values, duplicate targets and invalid deadlines", () => {
  for (const args of [
    ["--typo"], ["--binary"], ["--report", "--list"], ["first", "second"],
    ["first", "--binary", "second"], ["--group", "missing"], ["--timeout", "NaN"],
    ["--timeout", "0"], ["--timeout", "1.5"], ["--case-timeout", "3600001"],
  ]) assert.throws(() => parseOptions(args), undefined, args.join(" "));
});

test("E2E selection cannot silently pass with zero tests or duplicate IDs", () => {
  assert.throws(() => selectCases([], options()), /empty successful run/);
  assert.throws(() => selectCases([sampleCase(), sampleCase()], options()), /Duplicate/);
  assert.throws(() => selectCases([sampleCase("../escape")], options()), /Invalid/);
  const parsed = options();
  parsed.filter = "second";
  assert.deepEqual(selectCases([sampleCase(), sampleCase("test.second")], parsed).map((entry) => entry.id), ["test.second"]);
  parsed.groups = ["security"];
  assert.throws(() => selectCases([sampleCase("test.second")], parsed), /No test cases/);
});

test("E2E environments isolate user state and do not inherit credentials or preload hooks", () => {
  const root = makeTempDir("bw-e2e-env-");
  const env = isolatedEnvironment(root);
  assert.equal(env.HOME, path.join(root, "user"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.BETTERWRIGHT_HOME, path.join(root, "betterwright"));
  assert.notEqual(env.HOME, os.homedir());
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "BETTERWRIGHT_MODEL", "BETTERWRIGHT_CDP_URL", "BETTERWRIGHT_PROFILE"]) {
    assert.equal(env[name], undefined, `${name} must not be inherited`);
  }
});

test("E2E commands pass literal argv and stdin without a shell", async () => {
  const root = makeTempDir("bw-e2e-command-");
  const harness = createContext(options(), root);
  try {
    const value = await harness.context.json(["echo", "a b", 'quote"value', "$(touch should-not-exist)", "雪"], {
      stdin: "line one\nline two\n",
      env: { E2E_EXTRA: "extra" },
    });
    assert.deepEqual(value.args, ["a b", 'quote"value', "$(touch should-not-exist)", "雪"]);
    assert.equal(value.stdin, "line one\nline two\n");
    assert.equal(value.cwd, root);
    assert.equal(value.extra, "extra");
    assert.equal(value.home, path.join(root, "user"));
    assert.equal(fs.existsSync(path.join(root, "should-not-exist")), false);
  } finally { await harness.dispose(); }
});

test("E2E command status, output bounds, and deadlines fail honestly", async () => {
  const harness = createContext(options(), makeTempDir("bw-e2e-errors-"));
  try {
    const failure = await harness.context.command(["fail"]);
    assert.equal(failure.code, 7);
    await assert.rejects(harness.context.json(["fail"]), /intentional target failure/);
    await assert.rejects(harness.context.command(["hang"], { timeoutMs: 100 }), /exceeded 100ms/);
    await assert.rejects(harness.context.command(["flood"]), /output limit/);
    assert.equal((await harness.context.command(["--version"])).code, 0);
  } finally { await harness.dispose(); }
});

test("E2E run validates JSON and the exit-code/envelope contract", async () => {
  const harness = createContext(options(), makeTempDir("bw-e2e-envelope-"));
  try {
    assert.equal((await harness.context.run("success")).result, 42);
    assert.equal((await harness.context.run("failure")).ok, false);
    await assert.rejects(harness.context.run("wrong-exit"), /nonzero exit/);
    await assert.rejects(harness.context.run("malformed"), /did not return JSON/);
  } finally { await harness.dispose(); }
});

test("E2E cleanup closes only its home and prevents late commands", async () => {
  const root = makeTempDir("bw-e2e-cleanup-");
  const harness = createContext(options(), root);
  await harness.context.command(["touch-home"]);
  const server = await harness.context.serve((_request, response) => response.end("fixture"));
  assert.equal(await (await fetch(server.origin)).text(), "fixture");
  await harness.dispose();
  assert.equal(fs.readFileSync(path.join(root, "closed.txt"), "utf8"), "close --all");
  await assert.rejects(fetch(server.origin));
  await assert.rejects(harness.context.command(["--version"]), /disposed/);
});

test("E2E cases redact diagnostics, distinguish skips and fail cleanup errors", async () => {
  const root = makeTempDir("bw-e2e-cases-");
  const failed = await runCase({ ...sampleCase(), async run(context) {
    context.redact("synthetic-secret-for-test");
    throw new Error("failure includes synthetic-secret-for-test");
  } }, options(), root);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "failure includes [redacted]");
  const skipped = await runCase({ ...sampleCase(), async run(context) { context.skip("encoder unavailable"); } }, options(), root);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "encoder unavailable");
  const cleanup = await runCase({ ...sampleCase(), async run(context) {
    await context.command(["touch-home"]);
    fs.writeFileSync(path.join(context.workDir, "fail-cleanup"), "1");
  } }, options(), root);
  assert.equal(cleanup.status, "failed");
  assert.match(cleanup.error, /Cleanup failed/);
  assert.ok(cleanup.workDir);
});

test("E2E whole-case deadline and interruption cannot report a pass", async () => {
  const root = makeTempDir("bw-e2e-deadline-");
  const config = options();
  config.caseTimeoutMs = 100;
  const timedOut = await runCase({ ...sampleCase(), async run(context) { await context.command(["hang"]); } }, config, root);
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error, /Case exceeded/);
  const controller = new AbortController();
  controller.abort();
  const interrupted = await runCase(sampleCase(), config, root, controller.signal);
  assert.equal(interrupted.status, "failed");
});

test("E2E exit status rejects failures, all-skipped runs, and strict partial coverage", () => {
  const result = (status: CaseResult["status"]): CaseResult => ({ id: status, group: "cli", title: status, status, durationMs: 0 });
  assert.equal(reportExitCode([], false), 1);
  assert.equal(reportExitCode([result("passed")], false), 0);
  assert.equal(reportExitCode([result("failed")], false), 1);
  assert.equal(reportExitCode([result("skipped")], false), 1);
  assert.equal(reportExitCode([result("passed"), result("skipped")], false), 0);
  assert.equal(reportExitCode([result("passed"), result("skipped")], true), 1);
  assert.equal(reportExitCode([{ ...result("passed"), id: "preflight.binary" }, result("skipped")], false), 1);
});

test("E2E executable writes a complete machine-readable passing report", async () => {
  const root = makeTempDir("bw-e2e-report-");
  const report = path.join(root, "report.json");
  const runner = fileURLToPath(new URL("../e2e/run.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [runner,
    "--binary", process.execPath, "--binary-arg", fixture,
    "--filter", "cli-version", "--require-all", "--report", report,
  ], { timeout: 30_000, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.outcome, "passed");
  assert.equal(parsed.selectedCases, 1);
  assert.equal(parsed.target.version, "0.0.0-e2e-fixture");
  assert.deepEqual(parsed.summary, { passed: 2, failed: 0, skipped: 0 });
  assert.ok(parsed.untested.length > 0);
  assert.match(result.stdout, /2 passed, 0 failed, 0 skipped/);
});

test("E2E executable reports an unavailable target as failure, not all-skipped success", async () => {
  const root = makeTempDir("bw-e2e-unavailable-");
  const report = path.join(root, "report.json");
  const runner = fileURLToPath(new URL("../e2e/run.ts", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [runner,
    "--binary", path.join(root, "missing-betterwright"),
    "--filter", "cli-version", "--report", report,
  ], { timeout: 30_000 }));
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.outcome, "failed");
  assert.deepEqual(parsed.summary, { passed: 0, failed: 1, skipped: 1 });
  assert.match(parsed.results[0].error, /ENOENT/);
  assert.equal(parsed.results[1].reason, "Target binary preflight failed");
});
