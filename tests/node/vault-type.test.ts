// `vault type` — keystroke delivery for windows that swallow clipboard paste.
//
// The properties that matter are negative: the secret must never appear in
// argv (so `ps` cannot collect it), never on stdout/stderr, and the command
// must not wait the real countdown in tests. spawn is injected; when a test
// needs a real stdin pipe it swaps in Node as the child so the bytes that
// leave the parent are the bytes a keystroke tool would have received.

import assert from "node:assert/strict";
import { spawn as realSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLocalCredentialVault } from "../../dist/src/vault.js";
import { runVaultCommand } from "../../dist/src/vault-cli.js";
import {
  appleScriptForType,
  DEFAULT_KEY_DELAY_MS,
  DEFAULT_TYPE_DELAY_SECONDS,
  parseKeyDelayMs,
  parseTypeDelaySeconds,
  typeIntoFocusedWindow,
  typeToolCandidates,
  windowsTypeEncodedCommand,
} from "../../dist/src/vault-type.js";

const SECRET = "p@ss--file -w0rd!\t$`\"'";
const SIMPLE_SECRET = "gh-secret-value";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-vault-type-"));
  test.after(() =>
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return home;
}

async function seed(home) {
  const vault = createLocalCredentialVault({ home });
  const github = await vault.handleRequest(
    "save",
    { username: "ada@example.com", password: SIMPLE_SECRET, label: "work" },
    "https://github.com/login",
  );
  return { vault, github };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

function fakeStdin() {
  return { end() {}, on() { return this; } };
}

function failingSpawn() {
  const child: any = new EventEmitter();
  child.stdin = fakeStdin();
  queueMicrotask(() => child.emit("error", new Error("ENOENT")));
  return child;
}

function closingSpawn(code) {
  const child: any = new EventEmitter();
  child.stdin = fakeStdin();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

/** Spawn Node to record stdin to a file — a real pipe, not a mock `end()`. */
function recordingSpawn(recordPath, calls) {
  const recorder = [
    "let d='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { d += c; });",
    "process.stdin.on('end', () => {",
    "  require('fs').writeFileSync(process.env.BW_TYPE_RECORD, d);",
    "});",
  ].join("");
  return (command, args, options) => {
    calls.push({ command, args });
    return realSpawn(process.execPath, ["-e", recorder], {
      stdio: options.stdio,
      env: { ...process.env, BW_TYPE_RECORD: recordPath },
    });
  };
}

test("type delay parsers reject nonsense and accept the documented range", () => {
  assert.equal(parseTypeDelaySeconds(undefined), DEFAULT_TYPE_DELAY_SECONDS);
  assert.equal(parseTypeDelaySeconds(""), DEFAULT_TYPE_DELAY_SECONDS);
  assert.equal(parseTypeDelaySeconds("0"), 0);
  assert.equal(parseTypeDelaySeconds("2.5"), 2.5);
  assert.throws(() => parseTypeDelaySeconds("nope"), /--delay/);
  assert.throws(() => parseTypeDelaySeconds("-1"), /--delay/);
  assert.throws(() => parseTypeDelaySeconds("121"), /--delay/);

  assert.equal(parseKeyDelayMs(undefined), DEFAULT_KEY_DELAY_MS);
  assert.equal(parseKeyDelayMs("0"), 0);
  assert.equal(parseKeyDelayMs("40"), 40);
  assert.throws(() => parseKeyDelayMs("nope"), /--key-delay/);
  assert.throws(() => parseKeyDelayMs("-1"), /--key-delay/);
  assert.throws(() => parseKeyDelayMs("1001"), /--key-delay/);
});

test("each platform's keystroke argv never carries the secret", () => {
  const linux = typeToolCandidates("linux", 40);
  assert.deepEqual(
    linux.map(([command]) => command),
    ["wtype", "ydotool", "xdotool"],
  );
  assert.deepEqual(linux[0][1], ["-d", "40", "-"]);
  assert.deepEqual(linux[1][1], ["type", "--key-delay", "40", "--file", "/dev/stdin"]);
  assert.deepEqual(linux[2][1], ["type", "--clearmodifiers", "--delay", "40", "--file", "-"]);
  for (const [, args] of linux) {
    assert.equal(args.join("\0").includes(SECRET), false);
  }

  const darwin = typeToolCandidates("darwin", 25);
  assert.deepEqual(darwin, [["osascript", []]]);

  const win = typeToolCandidates("win32", 25);
  assert.deepEqual(
    win.map(([command]) => command),
    ["powershell", "pwsh"],
  );
  for (const [, args] of win) {
    assert.ok(args.includes("-EncodedCommand"));
    assert.equal(args.join("\0").includes(SECRET), false);
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(script, /SendInput/);
    assert.match(script, /ReadToEnd/);
    assert.equal(script.includes(SECRET), false);
    assert.equal(script.includes(SIMPLE_SECRET), false);
    assert.match(script, /\b25\b/);
  }
});

test("AppleScript escapes quotes and backslashes so they stay in the string", () => {
  const nasty = 'say "hi"\\there';
  const script = appleScriptForType(nasty, 0);
  assert.match(script, /keystroke "/);
  assert.ok(script.includes('say \\"hi\\"\\\\there'), script);
  assert.equal(script.includes('say "hi"'), false);

  const paced = appleScriptForType("ab\n\t", 25);
  assert.match(paced, /keystroke return/);
  assert.match(paced, /keystroke tab/);
  assert.match(paced, /set theDelay to 0\.025/);
});

test("Windows encoded command embeds the key delay and not a secret", () => {
  const script = Buffer.from(windowsTypeEncodedCommand(40), "base64").toString("utf16le");
  assert.match(script, /TypeText\(\$raw, 40\)/);
  assert.match(script, /KEYEVENTF_UNICODE/);
  assert.equal(script.includes(SIMPLE_SECRET), false);
});

test("typeIntoFocusedWindow pipes the secret on stdin of a real child", async () => {
  const record = path.join(os.tmpdir(), `bw-type-record-${process.pid}-${Date.now()}`);
  test.after(() => fs.rmSync(record, { force: true }));
  const calls = [];
  const result = await typeIntoFocusedWindow(SECRET, {
    platform: "linux",
    keyDelayMs: 40,
    spawn: recordingSpawn(record, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tool, "wtype");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "wtype");
  assert.deepEqual(calls[0].args, ["-d", "40", "-"]);
  assert.equal(calls[0].args.join(" ").includes(SECRET), false);
  assert.equal(fs.readFileSync(record, "utf8"), SECRET);
});

test("typeIntoFocusedWindow falls through when the first tool is missing", async () => {
  const record = path.join(os.tmpdir(), `bw-type-fallback-${process.pid}-${Date.now()}`);
  test.after(() => fs.rmSync(record, { force: true }));
  const calls = [];
  let n = 0;
  const spawnFn = (command, args, options) => {
    n += 1;
    if (n === 1) return failingSpawn();
    return recordingSpawn(record, calls)(command, args, options);
  };
  const result = await typeIntoFocusedWindow(SECRET, { platform: "linux", spawn: spawnFn });
  assert.equal(result.ok, true);
  assert.equal(result.tool, "ydotool");
  assert.equal(calls[0].command, "ydotool");
  assert.equal(fs.readFileSync(record, "utf8"), SECRET);
});

test("typeIntoFocusedWindow on macOS feeds AppleScript on stdin, not argv", async () => {
  const record = path.join(os.tmpdir(), `bw-type-mac-${process.pid}-${Date.now()}`);
  test.after(() => fs.rmSync(record, { force: true }));
  const calls = [];
  const result = await typeIntoFocusedWindow(SECRET, {
    platform: "darwin",
    keyDelayMs: 0,
    spawn: recordingSpawn(record, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tool, "osascript");
  assert.deepEqual(calls[0].args, []);
  const script = fs.readFileSync(record, "utf8");
  assert.equal(script, appleScriptForType(SECRET, 0));
  assert.equal(calls[0].args.join(" ").includes(SECRET), false);
});

test("typeIntoFocusedWindow on Windows pipes the raw secret, not the script", async () => {
  const record = path.join(os.tmpdir(), `bw-type-win-${process.pid}-${Date.now()}`);
  test.after(() => fs.rmSync(record, { force: true }));
  const calls = [];
  const result = await typeIntoFocusedWindow(SECRET, {
    platform: "win32",
    keyDelayMs: 25,
    spawn: recordingSpawn(record, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tool, "powershell");
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  assert.equal(calls[0].args.join("\0").includes(SECRET), false);
  assert.equal(fs.readFileSync(record, "utf8"), SECRET);
});

test("typeIntoFocusedWindow reports a usable error when no tool exists", async () => {
  const result = await typeIntoFocusedWindow(SECRET, { platform: "linux", spawn: failingSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /wtype|ydotool|xdotool/);
  assert.match(result.error, /vault copy|vault show/);
  assert.equal(result.error.includes(SECRET), false);
});

test("a non-zero tool exit is not treated as success", async () => {
  const result = await typeIntoFocusedWindow(SECRET, {
    platform: "darwin",
    spawn: () => closingSpawn(1),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /osascript exited 1/);
  assert.match(result.error, /Not trying another/);
  assert.equal(result.error.includes(SECRET), false);
});

test("a keystroke tool that starts and exits nonzero is not retried", async () => {
  const calls = [];
  const result = await typeIntoFocusedWindow(SECRET, {
    platform: "linux",
    spawn: (command) => {
      calls.push(command);
      return closingSpawn(1);
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["wtype"]);
  assert.match(result.error, /wtype exited 1/);
  assert.match(result.error, /Not trying another/);
  assert.equal(result.error.includes(SECRET), false);
});

test("vault type types through the owner API and never prints the secret", async () => {
  const home = tempHome();
  const { github, vault } = await seed(home);
  const io = capture();
  const typed = [];
  const sleeps = [];

  assert.equal(
    await runVaultCommand(["type", github.id, "--delay", "2.5", "--key-delay", "40"], {
      home,
      ...io,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      typeIntoFocusedWindow: async (text, opts) => {
        typed.push({ text, opts });
        return { ok: true, tool: "xdotool" };
      },
    }),
    0,
  );
  assert.deepEqual(sleeps, [2500]);
  assert.equal(typed.length, 1);
  assert.equal(typed[0].text, SIMPLE_SECRET);
  assert.equal(typed[0].opts.keyDelayMs, 40);
  assert.match(io.stdout, /github\.com/);
  assert.match(io.stdout, /2\.5s/);
  assert.match(io.stdout, /focused window/);
  assert.equal(io.stdout.includes(SIMPLE_SECRET), false);
  assert.equal(io.stderr.includes(SIMPLE_SECRET), false);

  const { entries } = await vault.ownerAudit({ limit: 10 });
  const reveal = entries.find((entry) => entry.action === "owner-reveal");
  assert.ok(reveal, "type is an audited reveal");
  assert.equal(reveal.id, github.id);
  assert.equal(JSON.stringify(entries).includes(SIMPLE_SECRET), false);
});

test("vault paste is an alias for type", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const io = capture();
  let called = false;
  assert.equal(
    await runVaultCommand(["paste", github.id, "--delay", "0"], {
      home,
      ...io,
      typeIntoFocusedWindow: async (text) => {
        called = true;
        assert.equal(text, SIMPLE_SECRET);
        return { ok: true, tool: "wtype" };
      },
    }),
    0,
  );
  assert.equal(called, true);
  assert.match(io.stdout, /Typed the github\.com password/);
});

test("vault type --delay 0 skips the countdown", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const io = capture();
  const sleeps = [];
  assert.equal(
    await runVaultCommand(["type", github.id, "--delay", "0"], {
      home,
      ...io,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      typeIntoFocusedWindow: async () => ({ ok: true, tool: "wtype" }),
    }),
    0,
  );
  assert.deepEqual(sleeps, []);
  assert.doesNotMatch(io.stdout, /Focus the target window/);
});

test("vault type --json is secret-free and still waits", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const io = capture();
  const sleeps = [];
  assert.equal(
    await runVaultCommand(["type", github.id, "--json", "--delay", "1"], {
      home,
      ...io,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      typeIntoFocusedWindow: async () => ({ ok: true, tool: "wtype" }),
    }),
    0,
  );
  assert.deepEqual(sleeps, [1000]);
  const parsed = JSON.parse(io.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tool, "wtype");
  assert.equal(parsed.id, github.id);
  assert.equal(parsed.origin, "https://github.com");
  assert.equal(parsed.username, "ada@example.com");
  assert.equal("secret" in parsed, false);
  assert.equal("password" in parsed, false);
  assert.equal(io.stdout.includes(SIMPLE_SECRET), false);
  assert.doesNotMatch(io.stdout, /Focus the target window/);
});

test("a bad --delay fails before the secret is revealed", async () => {
  const home = tempHome();
  const { github, vault } = await seed(home);
  const io = capture();
  let typed = false;
  assert.equal(
    await runVaultCommand(["type", github.id, "--delay", "nope"], {
      home,
      ...io,
      typeIntoFocusedWindow: async () => {
        typed = true;
        return { ok: true, tool: "wtype" };
      },
    }),
    1,
  );
  assert.equal(typed, false);
  assert.match(io.stderr, /--delay/);
  assert.equal(io.stdout.includes(SIMPLE_SECRET), false);
  const { entries } = await vault.ownerAudit({ limit: 20 });
  assert.equal(
    entries.some((entry) => entry.action === "owner-reveal"),
    false,
    "a rejected flag must not audit a reveal",
  );
});

test("vault type never prints the secret when the keystroke tool fails", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const io = capture();
  assert.equal(
    await runVaultCommand(["type", github.id, "--delay", "0"], {
      home,
      ...io,
      spawn: failingSpawn,
    }),
    1,
  );
  assert.match(io.stderr, /No keystroke tool worked/);
  assert.equal(io.stdout.includes(SIMPLE_SECRET), false);
  assert.equal(io.stderr.includes(SIMPLE_SECRET), false);
});

test("vault type on an unknown id does not invoke the typer", async () => {
  const home = tempHome();
  await seed(home);
  const io = capture();
  let typed = false;
  assert.equal(
    await runVaultCommand(["type", "cred_missing", "--delay", "0"], {
      home,
      ...io,
      typeIntoFocusedWindow: async () => {
        typed = true;
        return { ok: true, tool: "wtype" };
      },
    }),
    1,
  );
  assert.equal(typed, false);
  assert.match(io.stderr, /No credential id/);
});

test("vault type works for an uncommitted signup password", async () => {
  const home = tempHome();
  const { vault } = await seed(home);
  const pending = await vault.handleRequest(
    "generate",
    { username: "ada@example.com" },
    "https://reddit.com/",
  );
  const revealed = await vault.ownerReveal(pending.pendingId);
  const io = capture();
  let seen = "";
  assert.equal(
    await runVaultCommand(["type", pending.pendingId, "--delay", "0"], {
      home,
      ...io,
      typeIntoFocusedWindow: async (text) => {
        seen = text;
        return { ok: true, tool: "wtype" };
      },
    }),
    0,
  );
  assert.equal(seen, revealed.secret);
  assert.match(io.stdout, /reddit\.com/);
  assert.equal(io.stdout.includes(revealed.secret), false);
});

function firstTypeTool() {
  if (process.platform === "darwin") return "osascript";
  if (process.platform === "win32") return "powershell";
  return "wtype";
}

function installFakeTypeTool(binDir, recordPath) {
  const name = firstTypeTool();
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, `${name}.cmd`),
      `@echo off\r\nmore > "${recordPath}"\r\n`,
    );
  } else {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\ncat > ${JSON.stringify(recordPath)}\n`, {
      mode: 0o755,
    });
  }
  return name;
}

test("the CLI binary types through a PATH tool and never prints the secret", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-type-bin-"));
  test.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const record = path.join(binDir, "typed.txt");
  const tool = installFakeTypeTool(binDir, record);
  const result = spawnSync(process.execPath, [cli, "vault", "type", github.id, "--delay", "0"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      BETTERWRIGHT_HOME: home,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Typed the github\.com password/);
  assert.equal(result.stdout.includes(SIMPLE_SECRET), false);
  assert.equal(result.stderr.includes(SIMPLE_SECRET), false);
  const delivered = fs.readFileSync(record, "utf8");
  if (tool === "osascript") {
    assert.equal(delivered, appleScriptForType(SIMPLE_SECRET, DEFAULT_KEY_DELAY_MS));
  } else {
    assert.equal(delivered, SIMPLE_SECRET);
  }
});

test("the CLI binary fails closed when PATH has no keystroke tool", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const result = spawnSync(process.execPath, [cli, "vault", "type", github.id, "--delay", "0"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path.join(os.tmpdir(), "betterwright-empty-path"),
      BETTERWRIGHT_HOME: home,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No keystroke tool worked/);
  assert.equal(result.stdout.includes(SIMPLE_SECRET), false);
  assert.equal(result.stderr.includes(SIMPLE_SECRET), false);
});

test("vault type --help is the usage, not a type", async () => {
  const home = tempHome();
  const io = capture();
  let typed = false;
  assert.equal(
    await runVaultCommand(["type", "--help"], {
      home,
      ...io,
      typeIntoFocusedWindow: async () => {
        typed = true;
        return { ok: true, tool: "wtype" };
      },
    }),
    0,
  );
  assert.equal(typed, false);
  assert.match(io.stdout, /type <id>/);
  assert.match(io.stdout, /paste <id>/);
});
