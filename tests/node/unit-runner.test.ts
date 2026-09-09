import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";

test("unit runner executes TypeScript sources and ignores stale compiled files", () => {
  const root = makeTempDir("betterwright-unit-runner-");
  const scripts = path.join(root, "scripts");
  const tests = path.join(root, "tests", "node");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.copyFileSync(
    new URL("../../scripts/run-unit-tests.ts", import.meta.url),
    path.join(scripts, "run-unit-tests.ts"),
  );
  fs.writeFileSync(path.join(tests, "current.test.ts"),
    'import test from "node:test"; import assert from "node:assert/strict"; const value: number = 42; test("current source test", () => assert.equal(value, 42));');
  fs.writeFileSync(path.join(tests, "current.test.js"), 'throw new Error("stale sibling compiled test ran");');
  fs.writeFileSync(path.join(tests, "stale.test.js"), 'throw new Error("stale compiled test ran");');
  fs.writeFileSync(path.join(tests, "browser.test.ts"),
    'import test from "node:test"; test("browser inclusion sentinel", () => { throw new Error("browser test included"); });');

  const env: NodeJS.ProcessEnv = { ...process.env, BETTERWRIGHT_COVERAGE: "0" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(scripts, "run-unit-tests.ts")], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /current source test/);
  assert.doesNotMatch(result.stdout + result.stderr, /stale .*compiled test ran/);

  const full = spawnSync(process.execPath, [path.join(scripts, "run-unit-tests.ts"), "--all"], {
    encoding: "utf8",
    env,
  });
  assert.notEqual(full.status, 0);
  assert.match(full.stdout + full.stderr, /browser test included/);
  assert.doesNotMatch(full.stdout + full.stderr, /stale .*compiled test ran/);

  fs.writeFileSync(path.join(tests, "source-only.test.ts"),
    'import test from "node:test"; test("source without compiled output", () => {});');
  const sourceOnly = spawnSync(process.execPath, [path.join(scripts, "run-unit-tests.ts")], {
    encoding: "utf8",
    env,
  });
  assert.equal(sourceOnly.status, 0, sourceOnly.stdout + sourceOnly.stderr);
  assert.match(sourceOnly.stdout + sourceOnly.stderr, /source without compiled output/);
});

test("full runner completes unit tests before the isolated browser phase and preserves failures", () => {
  const root = makeTempDir("betterwright-runner-phases-");
  const scripts = path.join(root, "scripts");
  const tests = path.join(root, "tests", "node");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.copyFileSync(
    new URL("../../scripts/run-unit-tests.ts", import.meta.url),
    path.join(scripts, "run-unit-tests.ts"),
  );
  const unitSource = 'import test from "node:test"; import fs from "node:fs"; test("unit phase", async () => { await new Promise(resolve => setTimeout(resolve, 150)); fs.appendFileSync("phases.log", "unit\\n"); });';
  fs.writeFileSync(path.join(tests, "unit.test.ts"), unitSource);
  fs.writeFileSync(path.join(tests, "browser.test.ts"),
    'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("browser phase", () => { assert.equal(fs.readFileSync("phases.log", "utf8"), "unit\\n"); fs.appendFileSync("phases.log", "browser\\n"); });');
  const env: NodeJS.ProcessEnv = { ...process.env, BETTERWRIGHT_COVERAGE: "0" };
  delete env.NODE_TEST_CONTEXT;
  const passed = spawnSync(process.execPath, [path.join(scripts, "run-unit-tests.ts"), "--all"], {
    encoding: "utf8",
    env,
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(fs.readFileSync(path.join(root, "phases.log"), "utf8"), "unit\nbrowser\n");

  fs.unlinkSync(path.join(root, "phases.log"));
  fs.writeFileSync(path.join(tests, "unit.test.ts"),
    unitSource.replace('fs.appendFileSync("phases.log", "unit\\n");', 'fs.appendFileSync("phases.log", "unit\\n"); throw new Error("unit failure must propagate");'));
  const failed = spawnSync(process.execPath, [path.join(scripts, "run-unit-tests.ts"), "--all"], {
    encoding: "utf8",
    env,
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /unit failure must propagate/);
  assert.equal(fs.readFileSync(path.join(root, "phases.log"), "utf8"), "unit\nbrowser\n");
});
