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
    "src/worker.mjs",
    "types/index.d.ts",
    "types/chrome.d.ts",
    "types/captcha-solver.d.ts",
    "types/challenges.d.ts",
    "types/policy.d.ts",
    "types/prompt.d.ts",
    "types/pi.d.ts",
    "types/pi-extension.d.ts",
    "types/worker.d.ts",
  ];
  const missing = required.filter((name) => !paths.has(name));
  if (missing.length) throw new Error(`npm tarball is missing: ${missing.join(", ")}`);

  const forbidden = packed.files
    .map((entry) => entry.path)
    .filter((name) => /(^|\/)(node_modules|tests|artifacts|\.betterwright)(\/|$)/.test(name));
  if (forbidden.length) throw new Error(`npm tarball contains private/dev files: ${forbidden.join(", ")}`);
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
        "const chrome = await import('betterwright/chrome');",
        "const policy = await import('betterwright/policy');",
        "const prompt = await import('betterwright/prompt');",
        "const pi = await import('betterwright/pi');",
        "const piExtension = await import('betterwright/pi-extension');",
        "const mcp = await import('betterwright/mcp-server');",
        "if (typeof root.BetterWright !== 'function') throw new Error('missing BetterWright');",
        "if (typeof mcp.runMcpServer !== 'function') throw new Error('missing MCP server export');",
        "if (typeof chrome.ensureChromeCdp !== 'function') throw new Error('missing chrome export');",
        "if (typeof policy.NetworkPolicy !== 'function') throw new Error('missing policy export');",
        "if (typeof prompt.agentSystemPrompt !== 'function') throw new Error('missing prompt export');",
        "if (typeof pi.piImageContent !== 'function') throw new Error('missing Pi export');",
        "if (typeof piExtension.default !== 'function') throw new Error('missing Pi extension');",
      ].join("\n"),
    ],
    { cwd: installRoot },
  );

  fs.writeFileSync(
    path.join(installRoot, "consumer.ts"),
    [
      "import { BetterWright, NetworkPolicy, type RunResult } from 'betterwright';",
      "import { chromeExecutableCandidates } from 'betterwright/chrome';",
      "import type { NetworkDecision } from 'betterwright/policy';",
      "import type { PiImageContentBlock } from 'betterwright/pi';",
      "import createPiExtension from 'betterwright/pi-extension';",
      "import type { Guardrails } from 'betterwright/prompt';",
      "import { METADATA_RESOLVER_RULES } from 'betterwright/worker';",
      "import { runMcpServer } from 'betterwright/mcp-server';",
      "const policy = new NetworkPolicy();",
      "const browser = new BetterWright({ policy, browser: 'cloak' });",
      "const result: Promise<RunResult<string>> = browser.run<string>('return page.title()');",
      "const decision: NetworkDecision = policy.check('https://example.com');",
      "const blocks: PiImageContentBlock[] = [];",
      "const guardrails: Guardrails = { passwordManager: '1Password' };",
      "void [result, decision, blocks, guardrails, createPiExtension, chromeExecutableCandidates(), METADATA_RESOLVER_RULES, runMcpServer];",
    ].join("\n"),
  );
  const typescript = path.join(root, "node_modules", "typescript", "bin", "tsc");
  run(
    process.execPath,
    [
      typescript,
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

  const doctor = spawnSync(bin, ["doctor"], {
    cwd: installRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (![0, 1].includes(doctor.status)) throw new Error("doctor exited unexpectedly");
  const doctorOutput = `${doctor.stdout || ""}${doctor.stderr || ""}`;
  for (const field of ["cloakbrowser_binary_version", "cloakbrowser_binary_tier"]) {
    if (!doctorOutput.includes(field)) throw new Error(`doctor did not report ${field}`);
  }

  console.log(
    `package smoke test passed: ${packed.filename}, ${packed.files.length} files, ${packed.size} bytes`,
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
