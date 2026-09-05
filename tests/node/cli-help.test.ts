// `--help` must never be the thing that does the thing.
//
// Before the help router existed, `betterwright setup --help` downloaded a
// 200 MB browser, `run --help` blocked forever reading stdin, `close --help`
// closed your session, and `skill --help` printed the whole agent skill. These
// tests pin the fix: every command answers help quickly, on stdout, with
// exit 0, and without side effects.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMAND_SUMMARIES, helpFor, MAIN_USAGE, wantsHelp } from "../../dist/src/cli-help.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");

function runCli(args, { timeout = 20_000, env = {}, entrypoint = cli } = {}) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [entrypoint, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      env: { ...process.env, ...env },
    }, (_error, stdout, stderr) => {
      resolve({ status: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    // Close stdin so a command that reads it cannot wait for more input.
    child.stdin?.end();
  });
}

test("CLI test subprocesses close stdin and preserve nonzero exit output", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-cli-helper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "eof.mjs");
  fs.writeFileSync(entrypoint, `process.stdin.on("end", () => {
    process.stdout.write("stdin closed");
    process.stderr.write("expected failure");
    process.exitCode = 7;
  });
  process.stdin.resume();`);
  const result = await runCli([], { entrypoint });
  assert.deepEqual(result, { status: 7, signal: null, stdout: "stdin closed", stderr: "expected failure" });
});

test("CLI test subprocesses are killed at their deadline", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-cli-helper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "hang.mjs");
  fs.writeFileSync(entrypoint, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const result = await runCli([], { entrypoint, timeout: 200 });
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
});

// Commands whose help is provided elsewhere but must still be reachable.
const HELP_COMMANDS = COMMAND_SUMMARIES.map(([name]) => name);

for (const command of HELP_COMMANDS) {
  test(`\`${command} --help\` explains without acting`, async () => {
    const result = await runCli([command, "--help"]);
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

test("-h is accepted wherever --help is", async () => {
  for (const command of ["doctor", "run", "vault", "skill"]) {
    const result = await runCli([command, "-h"]);
    assert.equal(result.status, 0, `${command} -h exited ${result.status}`);
    assert.match(result.stdout, /Usage: betterwright/);
  }
});

test("`setup --help` does not download a browser", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-help-"));
  try {
    const result = await runCli(["setup", "--help"], { env: { BETTERWRIGHT_HOME: home } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Installing the managed/);
    // Nothing at all should have been created in a fresh home.
    assert.equal(fs.existsSync(path.join(home, "chromium")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("`run --help` returns instead of blocking on stdin", async () => {
  const result = await runCli(["run", "--help"], { timeout: 10_000 });
  assert.equal(result.signal, null, "run --help hung and had to be killed");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /betterwright run -c/);
});

test("`skill --help` prints help, not the nine-kilobyte skill body", async () => {
  const result = await runCli(["skill", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: betterwright skill/);
  assert.doesNotMatch(result.stdout, /# Browser tool: BetterWright/);
  assert.ok(result.stdout.length < 2000, "help should be short");
});

test("vault help names copy and type as the secret-delivery paths", async () => {
  const result = await runCli(["vault", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /copy <id>/);
  assert.match(result.stdout, /type <id>/);
  assert.match(result.stdout, /paste <id>/);
  assert.match(result.stdout, /--delay/);
  assert.match(result.stdout, /--key-delay/);
});

test("bare --help and `help <command>` both work", async () => {
  const bare = await runCli(["--help"]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /betterwright init/);

  const routed = await runCli(["help", "vault"]);
  assert.equal(routed.status, 0);
  assert.match(routed.stdout, /Usage: betterwright vault/);

  const bareHelp = await runCli(["help"]);
  assert.equal(bareHelp.status, 0);
  assert.match(bareHelp.stdout, /Usage: betterwright <command>/);
});

test("an unknown command names itself and lists the real ones", async () => {
  const result = await runCli(["frobnicate"]);
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

test("boxes help names REST providers and the connect-only ones", () => {
  const text = helpFor("boxes");
  assert.match(text, /betterwright boxes/);
  assert.match(text, /kernel/);
  assert.match(text, /browser-use/);
  assert.match(text, /Browserless, Bright Data, and Oxylabs/);
  assert.match(text, /configure --connect/);
});

test("Cookie Sync help names its local and cloud security gates", () => {
  const text = helpFor("cookies");
  assert.match(text, /cookies browsers/);
  assert.match(text, /cookies profiles/);
  assert.match(text, /cookies sync/);
  assert.match(text, /--allow-app-bound/);
  assert.match(text, /--allow-cloud <target>/);
  assert.match(text, /provider:browserbase/);
});

test("Cookie Sync CLI rejects unsafe selector shapes before opening a browser", async () => {
  const missingScope = await runCli(["cookies", "sync", "chrome", "--json"]);
  assert.equal(missingScope.status, 1);
  assert.match(missingScope.stdout, /requires either --all or one or more --domain/);

  const swallowedFlag = await runCli([
    "cookies",
    "sync",
    "chrome",
    "--domain",
    "--all",
    "--json",
  ]);
  assert.equal(swallowedFlag.status, 1);
  assert.match(swallowedFlag.stdout, /--domain requires a value/);

  const missingProfile = await runCli([
    "cookies",
    "sync",
    "chrome",
    "--all",
    "--source-profile",
    "--json",
  ]);
  assert.equal(missingProfile.status, 1);
  assert.match(missingProfile.stdout, /--source-profile requires a value/);

  const oneShotCloud = await runCli([
    "cookies",
    "sync",
    "chrome",
    "--all",
    "--browser",
    "wss://cloud.example.test/devtools/browser/fixture",
    "--allow-cloud",
    "cdp:cloud.example.test",
    "--no-daemon",
    "--json",
  ]);
  assert.equal(oneShotCloud.status, 1);
  assert.match(oneShotCloud.stdout, /requires the session daemon/);

  const oneShotSession = await runCli([
    "cookies",
    "sync",
    "firefox",
    "--all",
    "--include-session",
    "--no-daemon",
    "--json",
  ]);
  assert.equal(oneShotSession.status, 1);
  assert.match(oneShotSession.stdout, /session cookies remain usable/);
});

test("wantsHelp only matches flag forms, so task text is never swallowed", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--session", "x", "--help"]), true);
  // A task that merely contains the word must still run.
  assert.equal(wantsHelp(["help me find a flight"]), false);
  assert.equal(wantsHelp(["show", "cred_1"]), false);
});

test("mcp help registers the server with bunx, not npx", async () => {
  assert.match(helpFor("mcp"), /bunx betterwright mcp/);
  assert.doesNotMatch(helpFor("mcp"), /\bnpx betterwright\b/);
  const result = await runCli(["mcp", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bunx betterwright mcp/);
});

test("the daemon child is the thin CLI router, not a silent cli-main export", () => {
  const source = fs.readFileSync(path.join(root, "bin", "cli-main.ts"), "utf8");
  assert.match(source, /new URL\("\.\/betterwright\.js", import\.meta\.url\)/);
  assert.doesNotMatch(
    source,
    /const CLI_PATH = fileURLToPath\(import\.meta\.url\)/,
  );
});

test("cli-main.js still dispatches when executed as the main module", async () => {
  const cliMain = path.join(root, "dist", "bin", "cli-main.js");
  const result = await runCli(["--version"], { entrypoint: cliMain });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("record help documents capture limits, artifact paths, and daemon requirements", async () => {
  const result = await runCli(["record", "--help"]);
  assert.equal(result.status, 0);
  for (const expected of ["--fps", "--max-duration <s>", "BETTERWRIGHT_FFMPEG_PATH", "filename, not a path", "session daemon"]) {
    assert.ok(result.stdout.includes(expected), `record help is missing ${expected}`);
  }
});

test("record rejects invalid commands before creating a session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-record-errors-"));
  try {
    for (const [args, expected] of [
      [["record", "start", "--no-daemon"], /persistent session/],
      [["record", "restart", "--close"], /persistent session/],
      [["record", "start", "../demo.webm"], /filename/],
      [["record", "start", "C:\\demo.webm"], /filename/],
      [["record", "start", "demo.avi"], /filename/],
      [["record", "start", "--fps", "61"], /--fps requires/],
      [["record", "start", "--fps"], /--fps requires/],
      [["record", "start", "--max-duration", "0"], /--max-duration requires/],
      [["record", "stop", "--fps", "60"], /start\/restart/],
      [["record", "status", "demo.webm"], /filename/],
      [["record", "unknown"], /Usage: betterwright record/],
      [["record", "start", "one.webm", "two.webm"], /Usage: betterwright record/],
    ] satisfies [string[], RegExp][]) {
      const result = await runCli(args, { env: { BETTERWRIGHT_HOME: home } });
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, expected);
    }
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
