#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-package-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    const details = options.capture ? `${result.stdout || ""}${result.stderr || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`);
  }
  return result.stdout || "";
}

// True only for addresses that reach the public internet. Anything reserved for
// local, private, documentation, or cloud-metadata use is expected in our docs.
function isRoutableIpv4(literal) {
  const octets = literal.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255))
    return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  // RFC 5737 documentation ranges.
  if (a === 192 && b === 0 && octets[2] === 2) return false;
  if (a === 198 && b === 51 && octets[2] === 100) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  return true;
}

function npm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

try {
  const output = npm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
    { capture: true },
  );
  const packed = JSON.parse(output)[0];
  const paths = new Set(packed.files.map((entry) => entry.path));
  const required = [
    "LICENSE",
    "README.md",
    "SETUP.md",
    "bin/betterwright.mjs",
    "src/index.mjs",
    "src/vault.mjs",
    "src/worker.mjs",
    "types/index.d.ts",
    "types/vault.d.ts",
    "types/captcha-solver.d.ts",
    "types/challenges.d.ts",
    "types/policy.d.ts",
    "types/prompt.d.ts",
    "types/pi.d.ts",
    "types/pi-extension.d.ts",
    "types/worker.d.ts",
    "types/agent.d.ts",
    "types/auth.d.ts",
    "types/client.d.ts",
    "types/common.d.ts",
    "types/mcp-server.d.ts",
    "types/public.d.ts",
    "types/skills.d.ts",
  ];
  const missing = required.filter((name) => !paths.has(name));
  if (missing.length) throw new Error(`npm tarball is missing: ${missing.join(", ")}`);

  // `internal/` and handoff/research notes are written for us, not for users:
  // they carry session context, competitor research, and operator IPs. Keeping
  // them out of the tarball is enforced here because `files` uses a docs glob.
  const forbidden = [...paths].filter((name) =>
    /(^|\/)(node_modules|tests|artifacts|internal|\.betterwright)(\/|$)/.test(name) ||
    /(^|\/)(HANDOFF-|.*-handoff\.md$)/.test(name),
  );
  if (forbidden.length) throw new Error(`npm tarball contains private/dev files: ${forbidden.join(", ")}`);

  // v1.1.4 shipped an internal handoff note carrying an operator's residential
  // egress IP. Prose is where that kind of thing leaks, so every shipped .md is
  // scanned for routable IPv4 literals; loopback, private, CGNAT, link-local,
  // and the documented cloud-metadata addresses are all legitimate in our docs.
  const leaks = [];
  for (const name of paths) {
    if (!name.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(root, name), "utf8");
    for (const [literal] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (isRoutableIpv4(literal)) leaks.push(`${name}: ${literal}`);
    }
  }
  if (leaks.length)
    throw new Error(`npm tarball leaks routable IP addresses:\n- ${leaks.join("\n- ")}`);

  if (packed.size > 1_000_000) throw new Error(`npm tarball is unexpectedly large: ${packed.size} bytes`);

  const tarball = path.join(temp, packed.filename);
  const installRoot = path.join(temp, "install");
  fs.mkdirSync(installRoot);
  fs.writeFileSync(
    path.join(installRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: installRoot },
  );

  const installed = JSON.parse(
    fs.readFileSync(path.join(installRoot, "node_modules", "betterwright", "package.json"), "utf8"),
  );
  if (installed.scripts?.postinstall) throw new Error("published package must not have a postinstall script");

  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        "const root = await import('betterwright');",
        "const policy = await import('betterwright/policy');",
        "const prompt = await import('betterwright/prompt');",
        "const pi = await import('betterwright/pi');",
        "const piExtension = await import('betterwright/pi-extension');",
        "const mcp = await import('betterwright/mcp-server');",
        "const vault = await import('betterwright/vault');",
        "if (typeof root.BetterWright !== 'function') throw new Error('missing BetterWright');",
        "if (typeof root.LocalCredentialVault !== 'function') throw new Error('missing LocalCredentialVault');",
        "if (typeof mcp.runMcpServer !== 'function') throw new Error('missing MCP server export');",
        "if (typeof policy.NetworkPolicy !== 'function') throw new Error('missing policy export');",
        "if (typeof prompt.agentSystemPrompt !== 'function') throw new Error('missing prompt export');",
        "if (typeof pi.piImageContent !== 'function') throw new Error('missing Pi export');",
        "if (typeof piExtension.default !== 'function') throw new Error('missing Pi extension');",
        "if (typeof vault.createLocalCredentialVault !== 'function') throw new Error('missing vault export');",
        // The owner-only reads are a supported surface now; a missing method
        // means `betterwright vault` would be broken in the published package.
        "const v = vault.createLocalCredentialVault({ home: '/tmp/betterwright-package-vault' });",
        "for (const m of ['ownerList', 'ownerReveal', 'ownerRemove', 'ownerAudit']) {",
        "  if (typeof v[m] !== 'function') throw new Error('missing vault.' + m);",
        "}",
      ].join("\n"),
    ],
    { cwd: installRoot },
  );

  fs.writeFileSync(
    path.join(installRoot, "consumer.ts"),
    [
      "import { BetterWright, LocalCredentialVault, NetworkPolicy, type RunResult } from 'betterwright';",
      "import type { NetworkDecision } from 'betterwright/policy';",
      "import type { PiImageContentBlock } from 'betterwright/pi';",
      "import createPiExtension from 'betterwright/pi-extension';",
      "import type { Guardrails } from 'betterwright/prompt';",
      "import { METADATA_RESOLVER_RULES } from 'betterwright/worker';",
      "import { runMcpServer } from 'betterwright/mcp-server';",
      "import { createLocalCredentialVault, type VaultRevealedRecord } from 'betterwright/vault';",
      "const policy = new NetworkPolicy();",
      "const browser = new BetterWright({ policy, browser: 'cloak' });",
      "const vault = new LocalCredentialVault({ home: '/tmp/betterwright-package-types' });",
      "const owned = createLocalCredentialVault({ home: '/tmp/betterwright-package-types' });",
      "const revealed: Promise<VaultRevealedRecord> = owned.ownerReveal('cred_1');",
      "const noVault = new BetterWright({ vault: false });",
      "const result: Promise<RunResult<string>> = browser.run<string>('return page.title()');",
      "const decision: NetworkDecision = policy.check('https://example.com');",
      "const blocks: PiImageContentBlock[] = [];",
      "const guardrails: Guardrails = { passwordManager: '1Password' };",
      "void [result, decision, blocks, guardrails, createPiExtension, METADATA_RESOLVER_RULES, runMcpServer, vault, noVault];",
    ].join("\n"),
  );
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  run(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ],
    { cwd: installRoot },
  );

  const bin = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "betterwright.cmd" : "betterwright",
  );
  const versionOutput = run(bin, ["--version"], { cwd: installRoot, capture: true }).trim();
  if (versionOutput !== installed.version) {
    throw new Error(`CLI reported ${versionOutput}, package is ${installed.version}`);
  }

  // The raw field names live in `--json`; the default output is prose for a
  // person. Assert against the machine shape so wording can change freely.
  const doctor = spawnSync(bin, ["doctor", "--json"], {
    cwd: installRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (![0, 1].includes(doctor.status)) throw new Error("doctor exited unexpectedly");
  let report;
  try {
    report = JSON.parse(doctor.stdout);
  } catch {
    throw new Error(`doctor --json did not emit JSON:\n${doctor.stdout}${doctor.stderr}`);
  }
  for (const field of ["cloakbrowser_binary_version", "cloakbrowser_binary_tier"]) {
    if (!(field in report)) throw new Error(`doctor did not report ${field}`);
  }
  if (!Array.isArray(report.checks) || !report.checks.length) {
    throw new Error("doctor --json did not include its readiness checks");
  }

  // The human path must still work, and must still name the fix when it fails.
  const doctorText = spawnSync(bin, ["doctor"], {
    cwd: installRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (![0, 1].includes(doctorText.status)) throw new Error("doctor exited unexpectedly");
  if (!/BetterWright is ready\.|Not ready/.test(doctorText.stdout)) {
    throw new Error(`doctor gave no verdict:\n${doctorText.stdout}`);
  }

  // `--help` must never be the thing that does the thing: `setup --help` used
  // to download a browser and `run --help` blocked on stdin forever.
  for (const command of ["setup", "update", "run", "close", "view", "skill", "vault"]) {
    const help = spawnSync(bin, [command, "--help"], {
      cwd: installRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 20_000,
      input: "",
      env: process.env,
    });
    if (help.status !== 0 || help.signal) {
      throw new Error(`\`${command} --help\` exited ${help.status}/${help.signal}`);
    }
    if (!help.stdout.includes("Usage: betterwright")) {
      throw new Error(`\`${command} --help\` printed no usage`);
    }
  }

  console.log(
    `package smoke test passed: ${packed.filename}, ${packed.files.length} files, ${packed.size} bytes`,
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
