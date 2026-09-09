import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { connectSessionDaemon } from "../../dist/src/daemon-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const cli = path.resolve("dist/bin/betterwright.js");

function command(home: string, args: string[], prompts: Array<[string, string]> = []) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(prompts.length ? "/usr/bin/expect" : process.execPath,
      prompts.length ? ["-f", "-"] : [cli, ...args],
      { env: { ...process.env, BETTERWRIGHT_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const safe = prompts.reduce((text, [, value]) => text.replaceAll(value, "[redacted]"), output);
      reject(new Error(`CLI ${args[1]} timed out: ${safe}`));
    }, 30000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
    if (prompts.length) {
      // Synthetic test input goes through a real PTY, never through CLI flags.
      child.stdin.end([
        "set timeout 20",
        `spawn -noecho {${process.execPath}} {${cli}} ${args.map((arg) => `{${arg}}`).join(" ")}`,
        ...prompts.flatMap(([label, value]) => [
          `expect {\n-exact {${label}} {}\ntimeout { exit 124 }\neof { exit 125 }\n}`,
          `send -- ${JSON.stringify(`${value}\r`)}`,
        ]),
        "expect {\neof {}\ntimeout { exit 124 }\n}",
        "exit [lindex [wait] 3]",
      ].join("\n") + "\n");
    } else {
      child.stdin.end();
    }
  });
}

test("CLI hidden setup and unlock reach the real daemon without echoing the master password", {
  skip: process.platform !== "darwin" ? "macOS terminal integration" : false,
  timeout: 60000,
}, async () => {
  const home = makeTempDir("vault-cli-e2e-");
  const password = "synthetic-terminal-master-password";
  try {
    const setup = await command(home, ["vault", "setup"], [["Master password:", password], ["Confirm master password:", password]]);
    assert.equal(setup.code, 0, setup.output);
    assert.equal(setup.output.includes(password), false, "terminal must not echo password entry");
    const locked = await command(home, ["vault", "status", "--json"]);
    assert.equal(JSON.parse(locked.output).locked, true);
    const unlock = await command(home, ["vault", "unlock"], [["Master password:", password]]);
    assert.equal(unlock.code, 0, unlock.output);
    assert.equal(unlock.output.includes(password), false);
    assert.match(unlock.output, /unlocked/);
    const status = await command(home, ["vault", "status", "--json"]);
    assert.equal(JSON.parse(status.output).locked, false);
    const lock = await command(home, ["vault", "lock", "--json"]);
    assert.equal(lock.code, 0, lock.output);
    assert.equal(JSON.parse(lock.output).locked, true);
    const after = await command(home, ["vault", "status", "--json"]);
    assert.equal(JSON.parse(after.output).locked, true);
    const refused = await command(home, ["vault", "unlock"]);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /terminal is required/);
  } finally {
    const daemon = await connectSessionDaemon({ home, spawnIfNeeded: false, ignoreMismatch: true });
    if (daemon.ok) {
      try { await daemon.channel.request({ op: "shutdown" }); }
      finally { daemon.channel.end(); }
    }
  }
});
