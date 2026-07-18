#!/usr/bin/env node
// BetterWright command-line interface (Node).
//
//   betterwright setup            install the managed Cloak browser
//   betterwright doctor           report runtime readiness
//   betterwright run <file|-|-c>  execute a Playwright snippet
//   betterwright repl             run blank-line-separated snippets from stdin
//   betterwright exec <task>      run a task with BetterWright's own agent loop
//   betterwright auth --login <p> OAuth sign-in for a model backend (codex|grok)
//   betterwright skill            print paste-ready agent instructions
//   betterwright skills [list|show]  read on-demand site/provider knowledge packs
//   betterwright mcp              serve the MCP stdio server (needs the MCP SDK)
//
// run/repl flags: --headed, network flags (--block-private-network,
// --block-loopback, --allow-host/--block-host), and --stealth (isolated-world
// driver that evades main-world automation detection; needs patchright-core).

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { doctorReport, resolveCloakDir, resolveCoreDir } from "../src/doctor.mjs";
import { agentSystemPrompt, BetterWright, NetworkPolicy } from "../src/index.mjs";

const require = createRequire(import.meta.url);

function policyFromFlags(flags) {
  // Private networks and loopback are open by default; --block-private-network
  // / --block-loopback re-harden. The --allow-* flags are accepted no-ops.
  return new NetworkPolicy({
    allowLoopback: !flags.has("--block-loopback"),
    allowPrivateNetwork: !flags.has("--block-private-network"),
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

async function cmdDoctor() {
  const report = await doctorReport();
  for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(20)} ${value}`);
  console.log(report.ready ? "\nBetterWright is ready." : "\nNot ready. Run `betterwright setup`.");
  return report.ready ? 0 : 1;
}

async function cmdSetup(flags) {
  if (flags.has("--chromium")) {
    console.error(
      "The stock Chromium fallback was removed. BetterWright setup installs only managed CloakBrowser.",
    );
    return 1;
  }
  const core = resolveCoreDir();
  if (!core) {
    console.error(
      "playwright-core is not installed next to betterwright. If you installed " +
        "from npm this should not happen; otherwise `npm install betterwright`.",
    );
    return 1;
  }
  const cloakDir = resolveCloakDir();
  if (!cloakDir) {
    console.error("cloakbrowser is not installed next to betterwright.");
    return 1;
  }
  const cloak = await import(pathToFileURL(path.join(cloakDir, "dist", "index.js")).href);
  console.log("Installing the managed CloakBrowser binary ...");
  const binary = await cloak.ensureBinary();
  console.log(`Installed ${binary}`);
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
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed"), stealthRuntimeFix: flags.has("--stealth") || undefined });
  try {
    const result = await bw.run(code);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    await bw.close();
  }
}

// A CLI-usage preamble that turns the operator guidance (which talks about
// `run()`) into a self-contained skill for any agent that can run a shell
// command.
const SKILL_PREAMBLE = `# Browser tool: BetterWright

You can operate a real, persistent web browser by running the \`betterwright\`
command. Use it whenever a task needs the live web — logging in, filling forms,
booking, buying, or reading a page an API will not give you.

Single action — pass async Playwright JavaScript; a trailing expression (or an
explicit \`return\`) is the result:

    betterwright run -c "await page.goto('https://example.com'); return page.title()"

The command prints one JSON object:
{ok, result, error, console, events, artifacts, pages, challenges, warnings, durationMs}.
\`artifacts\` lists files written during the run; screenshots appear there with a
\`path\` — open that image to actually see the page.

Multi-step task — pipe blank-line-separated snippets into one long-lived session
so open tabs and in-memory \`state\` persist between steps:

    printf '%s\\n\\n%s\\n' "await page.goto('https://site.example')" "return page.title()" | betterwright repl

Logins and cookies persist across every invocation through the on-disk profile;
open tabs and \`state\` persist only within a single \`repl\` session.

When a result lists \`skills\`, deeper site or provider knowledge matches the
open pages — read the named pack with \`betterwright skills show <name>\` before
improvising on that site. \`betterwright skills list\` shows what is available;
read the \`credential-manager\` pack before any login, signup, or checkout.

Network access is policy-guarded. Loopback and the private network are reachable
by default; add \`--block-private-network\` / \`--block-loopback\` to lock down, or
\`--allow-host <host>\` / \`--block-host <host>\` to adjust. Cloud-metadata endpoints
are always blocked.

Below, "\`run()\`" means "one \`betterwright run\` (or \`repl\`) snippet".`;

// YAML frontmatter for `skill --claude`, so the output is a complete Claude
// Code SKILL.md.
const CLAUDE_SKILL_FRONTMATTER = `---
name: browser
description: Drive a persistent, policy-guarded real web browser via the betterwright CLI. Use for any task that needs the live web — logging in, filling forms, booking, buying, or reading a page an API will not give you.
---`;

function cmdSkill(flags) {
  const body = `${SKILL_PREAMBLE}\n\n${agentSystemPrompt()}`;
  console.log(flags.has("--claude") ? `${CLAUDE_SKILL_FRONTMATTER}\n\n${body}` : body);
  return 0;
}

async function cmdRepl(flags) {
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed"), stealthRuntimeFix: flags.has("--stealth") || undefined });
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

function flagValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

// `exec <task>`: BetterWright's own agent harness (the `aside exec` shape).
// A model (Claude SDK / codex OAuth / grok OAuth) plugs into the browser-tuned
// loop and drives the task to completion. Progress notes (ending with a cost
// summary) go to stderr; the final {ok, answer, steps, reason, toolCalls,
// usage, proof} goes to stdout.
async function cmdExec(flags) {
  const { runAgentTask } = await import("../src/agent.mjs");
  const argv = process.argv;
  const task = argv.slice(3).find((token) => !token.startsWith("-"));
  if (!task) {
    console.error(
      'Usage: betterwright exec "<task>" [--model claude|codex|grok|<model-id>] [--model-id <id>] [--effort <level>] [--max-steps <n>] [--session <name>] [--headed]',
    );
    return 1;
  }
  const modelOptions = {};
  const modelId = flagValue(argv, "--model-id");
  if (modelId) modelOptions.model = modelId;
  const effort = flagValue(argv, "--effort");
  if (effort) modelOptions.effort = effort;

  let result;
  try {
    result = await runAgentTask({
      task,
      model: flagValue(argv, "--model", "claude"),
      modelOptions,
      maxSteps: Number(flagValue(argv, "--max-steps")) || undefined,
      session: flagValue(argv, "--session", "default"),
      policy: policyFromFlags(flags),
      headless: !flags.has("--headed"),
      onStep: ({ step, tool, note }) =>
        process.stderr.write(`  [${step}] ${tool}${note ? `: ${note}` : ""}\n`),
    });
  } catch (error) {
    // Config problems (missing credentials, missing SDK) read better as a plain
    // line than a stack trace.
    console.error(error?.message || String(error));
    return 1;
  }
  const { inputTokens, outputTokens, totalTokens } = result.usage;
  process.stderr.write(
    `  done in ${result.steps} step${result.steps === 1 ? "" : "s"}, ` +
      `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}, ` +
      `${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out)\n`,
  );
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        answer: result.answer,
        steps: result.steps,
        reason: result.reason,
        toolCalls: result.toolCalls,
        usage: result.usage,
        proof: result.proof,
      },
      null,
      2,
    ),
  );
  return result.ok ? 0 : 1;
}

// `auth --login codex|grok` / `auth --status`: OAuth sign-in for the built-in
// agent's model backends. Runs the provider's PKCE flow, opens the browser to
// the consent screen, and stores the tokens BetterWright's model adapter reads.
async function cmdAuth(rest) {
  const { loginProvider, loadCodexAuth, loadGrokAuth, codexAccessToken, grokAccessToken } = await import(
    "../src/auth.mjs"
  );
  const provider = flagValue(rest, "--login") || rest.find((t) => !t.startsWith("-"));

  if (rest.includes("--status")) {
    const codex = loadCodexAuth();
    const grok = loadGrokAuth();
    console.log(
      codex
        ? `codex   signed in${codex.accountId ? ` (account ${codex.accountId})` : ""}`
        : "codex   not signed in — run `betterwright auth --login codex`",
    );
    console.log(
      grok
        ? `grok    signed in${grok.accountId ? ` (account ${grok.accountId})` : ""}`
        : "grok    not signed in — run `betterwright auth --login grok`",
    );
    return codex || grok ? 0 : 1;
  }

  if (!provider) {
    console.error("Usage: betterwright auth --login codex|grok   (or --status)");
    return 1;
  }

  try {
    const result = await loginProvider({
      provider,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    // Confirm the tokens actually work by minting a fresh access token.
    if (result.provider === "codex") await codexAccessToken();
    else if (result.provider === "grok") await grokAccessToken();
    console.log(
      `Signed in to ${result.provider}${result.email ? ` as ${result.email}` : ""}. Tokens stored at ${result.file}.`,
    );
    console.log(`Run a task with: betterwright exec "<task>" --model ${result.provider}`);
    return 0;
  } catch (error) {
    console.error(error?.message || String(error));
    return 1;
  }
}

// `skills list` / `skills show <name>`: site and provider knowledge packs the
// agent reads on demand (run results hint matching packs under `skills`).
async function cmdSkills(rest) {
  const { listSkills, readSkill } = await import("../src/skills.mjs");
  const [subcommand = "list", name] = rest.filter((token) => !token.startsWith("-"));
  if (subcommand === "list") {
    for (const skill of listSkills()) {
      const marker = skill.error ? ` [broken: ${skill.error}]` : "";
      console.log(`${skill.name}\t${skill.description}${marker}`);
    }
    return 0;
  }
  if (subcommand === "show" && name) {
    const skill = readSkill(name);
    console.log(skill.body.trim());
    return 0;
  }
  console.error("Usage: betterwright skills [list | show <name>]");
  return 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((token) => token.startsWith("--")));
  const positional = rest.find((token) => !token.startsWith("-"));
  switch (command) {
    case "setup":
      return cmdSetup(flags);
    case "doctor":
      return cmdDoctor();
    case "run":
      return cmdRun(positional, flags);
    case "repl":
      return cmdRepl(flags);
    case "exec":
      return cmdExec(flags);
    case "auth":
      return cmdAuth(rest);
    case "skill":
      return cmdSkill(flags);
    case "skills":
      return cmdSkills(rest);
    case "mcp": {
      const { runMcpServer } = await import("../src/mcp-server.mjs");
      await runMcpServer();
      return 0;
    }
    case "--version":
      console.log(require("../package.json").version);
      return 0;
    default:
      console.error(
        "Usage: betterwright <setup|doctor|run|repl|exec|auth|skill|skills|mcp> [options]",
      );
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
