#!/usr/bin/env node
// BetterWright command-line interface (Node).
//
//   betterwright setup            install Chromium for the pinned Playwright
//   betterwright doctor           report runtime readiness
//   betterwright run <file|-|-c>  execute a Playwright snippet
//   betterwright repl             run blank-line-separated snippets from stdin

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { BetterWright, NetworkPolicy } from "../src/index.mjs";

const require = createRequire(import.meta.url);
const PINNED_PLAYWRIGHT_VERSION = "1.61.1";

function resolveCoreDir() {
  const override = (process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH || "").trim();
  if (override && fs.existsSync(path.join(override, "package.json"))) return override;
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

function policyFromFlags(flags) {
  return new NetworkPolicy({
    allowLoopback: flags.has("--allow-loopback"),
    allowPrivateNetwork: flags.has("--allow-private-network"),
    allowHosts: collectValues(process.argv, "--allow-host"),
    blockHosts: collectValues(process.argv, "--block-host"),
  });
}

function collectValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length - 1; i += 1)
    if (argv[i] === flag) values.push(argv[i + 1]);
  return values;
}

function cmdDoctor() {
  const core = resolveCoreDir();
  let version = null;
  let chromium = null;
  if (core) {
    try {
      version = require(path.join(core, "package.json")).version;
    } catch {
      /* ignore */
    }
    try {
      chromium = require(path.join(core, "index.js")).chromium.executablePath();
    } catch {
      /* ignore */
    }
  }
  const worker = fileURLToPath(new URL("../src/worker.mjs", import.meta.url));
  const report = {
    node: process.execPath,
    worker,
    worker_ok: fs.existsSync(worker),
    playwright_core: core,
    playwright_version: version,
    playwright_pinned: PINNED_PLAYWRIGHT_VERSION,
    chromium,
    chromium_ok: Boolean(chromium && fs.existsSync(chromium)),
  };
  report.ready = report.worker_ok && version === PINNED_PLAYWRIGHT_VERSION && report.chromium_ok;
  for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(20)} ${value}`);
  console.log(report.ready ? "\nBetterWright is ready." : "\nNot ready. Run `betterwright setup`.");
  return report.ready ? 0 : 1;
}

function cmdSetup() {
  const core = resolveCoreDir();
  if (!core) {
    console.error(
      "playwright-core is not installed next to betterwright. If you installed " +
        "from npm this should not happen; otherwise `npm install betterwright`.",
    );
    return 1;
  }
  console.log("Downloading the matching Chromium build ...");
  const result = spawnSync(
    process.execPath,
    [path.join(core, "cli.js"), "install", "chromium", "--no-shell"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) return result.status || 1;
  console.log("\nSetup complete. Run `betterwright doctor` to confirm.");
  return 0;
}

async function readSnippet(arg) {
  const codeFlagIndex = process.argv.indexOf("-c");
  if (codeFlagIndex !== -1) return process.argv[codeFlagIndex + 1] || "";
  if (!arg || arg === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(arg, "utf8");
}

async function cmdRun(arg, flags) {
  const code = await readSnippet(arg);
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed") });
  try {
    const result = await bw.run(code);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    await bw.close();
  }
}

async function cmdRepl(flags) {
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed") });
  console.log("BetterWright REPL — blank line runs a snippet, Ctrl-D quits.\n");
  const rl = readline.createInterface({ input: process.stdin });
  let buffer = [];
  try {
    for await (const line of rl) {
      if (line.trim()) {
        buffer.push(line);
        continue;
      }
      if (!buffer.length) continue;
      const result = await bw.run(buffer.join("\n"));
      buffer = [];
      console.log(JSON.stringify(result, null, 2));
    }
    if (buffer.length) console.log(JSON.stringify(await bw.run(buffer.join("\n")), null, 2));
  } finally {
    await bw.close();
  }
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((token) => token.startsWith("--")));
  const positional = rest.find((token) => !token.startsWith("-"));
  switch (command) {
    case "setup":
      return cmdSetup();
    case "doctor":
      return cmdDoctor();
    case "run":
      return cmdRun(positional, flags);
    case "repl":
      return cmdRepl(flags);
    case "--version":
      console.log(require("../package.json").version);
      return 0;
    default:
      console.error("Usage: betterwright <setup|doctor|run|repl> [options]");
      return command ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  },
);
