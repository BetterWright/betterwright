// `--help` must never be the thing that does the thing.
//
// Before the help router existed, `betterwright setup --help` downloaded a
// 200 MB browser, `run --help` blocked forever reading stdin, `close --help`
// closed your session, and `skill --help` printed the whole agent skill. These
// tests pin the fix: every command answers help quickly, on stdout, with
// exit 0, and without side effects.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMAND_SUMMARIES, helpFor, MAIN_USAGE, wantsHelp } from "../../dist/src/cli-help.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");

function runCli(args, { timeout = 20_000, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout,
    // No stdin: a command that tries to read it would hang and be killed,
    // which is exactly the regression this file guards.
    input: "",
    env: { ...process.env, ...env },
  });
}

// Commands whose help is provided elsewhere but must still be reachable.
const HELP_COMMANDS = COMMAND_SUMMARIES.map(([name]) => name);

for (const command of HELP_COMMANDS) {
  test(`\`${command} --help\` explains without acting`, () => {
    const result = runCli([command, "--help"]);
    assert.equal(result.status, 0, `${command} --help exited ${result.status}: ${result.stderr}`);
    assert.equal(result.signal, null, `${command} --help was killed (it blocked or hung)`);
    assert.match(result.stdout, /Usage: betterwright/, `${command} --help printed no usage`);
    assert.match(
      result.stdout,
      new RegExp(`betterwright ${command}\\b`),
      `${command} --help does not name its own command`,
    );
  });
}

test("-h is accepted wherever --help is", () => {
  for (const command of ["doctor", "run", "vault", "skill"]) {
    const result = runCli([command, "-h"]);
    assert.equal(result.status, 0, `${command} -h exited ${result.status}`);
    assert.match(result.stdout, /Usage: betterwright/);
  }
});

test("`setup --help` does not download a browser", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-help-"));
  try {
    const result = runCli(["setup", "--help"], { env: { BETTERWRIGHT_HOME: home } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Installing the managed/);
    // Nothing at all should have been created in a fresh home.
    assert.equal(fs.existsSync(path.join(home, "chromium")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("`run --help` returns instead of blocking on stdin", () => {
  const result = runCli(["run", "--help"], { timeout: 10_000 });
  assert.equal(result.signal, null, "run --help hung and had to be killed");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /betterwright run -c/);
});

test("`skill --help` prints help, not the nine-kilobyte skill body", () => {
  const result = runCli(["skill", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: betterwright skill/);
  assert.doesNotMatch(result.stdout, /# Browser tool: BetterWright/);
  assert.ok(result.stdout.length < 2000, "help should be short");
});

test("bare --help and `help <command>` both work", () => {
  const bare = runCli(["--help"]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /betterwright init/);

  const routed = runCli(["help", "vault"]);
  assert.equal(routed.status, 0);
  assert.match(routed.stdout, /Usage: betterwright vault/);

  const bareHelp = runCli(["help"]);
  assert.equal(bareHelp.status, 0);
  assert.match(bareHelp.stdout, /Usage: betterwright <command>/);
});

test("an unknown command names itself and lists the real ones", () => {
  const result = runCli(["frobnicate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command "frobnicate"/);
  assert.match(result.stderr, /betterwright init/);
});

test("every advertised command has help that names it", () => {
  for (const [command] of COMMAND_SUMMARIES) {
    const text = helpFor(command);
    assert.ok(text, `${command} has no help`);
    if (text !== MAIN_USAGE) {
      assert.match(text, new RegExp(`betterwright ${command}\\b`));
    }
  }
});

test("main usage lists every command exactly once", () => {
  for (const [command] of COMMAND_SUMMARIES) {
    const occurrences = MAIN_USAGE.split("\n").filter((line) =>
      line.startsWith(`  ${command} `),
    );
    assert.equal(occurrences.length, 1, `${command} should appear once in the command list`);
  }
});

test("wantsHelp only matches flag forms, so task text is never swallowed", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--session", "x", "--help"]), true);
  // A task that merely contains the word must still run.
  assert.equal(wantsHelp(["help me find a flight"]), false);
  assert.equal(wantsHelp(["show", "cred_1"]), false);
});
