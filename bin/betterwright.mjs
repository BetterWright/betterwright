#!/usr/bin/env node
// BetterWright command-line interface (Node).
//
//   betterwright                  interactive agent console (type tasks, watch
//                                 progress, answer the agent's questions)
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

import { formatAgentUsage } from "../src/agent-usage.mjs";
import { makeLineReader } from "../src/cli-io.mjs";
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

// Compact wall-clock: milliseconds under a second, otherwise seconds to 1 dp.
function formatDuration(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

// ANSI helpers that no-op when stdout is not a TTY or NO_COLOR is set.
function styler() {
  const on = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  return {
    dim: (s) => (on ? `\x1b[2m${s}\x1b[0m` : s),
    bold: (s) => (on ? `\x1b[1m${s}\x1b[0m` : s),
  };
}

const INTERACTIVE_HELP = `Commands:
  /help               show this help
  /model <name>       switch model (claude | codex | grok | a model id)
  /reasoning <level>  set reasoning effort (low | medium | high | xhigh | max)
  /headed             show the browser window (/headless to hide it again)
  /new                start a fresh session (clear memory + close open tabs)
  /clear              clear the screen
  /exit               quit (or Ctrl-D)

Anything else is a task: BetterWright drives the browser to complete it,
streams what it is doing, and asks you a question if it genuinely needs one.`;

// Bare `betterwright` (no subcommand): an interactive agent console. You type
// natural-language tasks; BetterWright's own agent loop drives the browser,
// streams each step it takes, prints the answer and what the run cost, and can
// ask you a question through the `ask` tool when it genuinely needs input. One
// browser session persists across tasks until you exit.
async function cmdInteractive(flags) {
  const { runAgentTask } = await import("../src/agent.mjs");
  const argv = process.argv;
  const { dim, bold } = styler();

  let model = flagValue(argv, "--model", "claude");
  const modelOptions = {};
  const modelId = flagValue(argv, "--model-id");
  if (modelId) modelOptions.model = modelId;
  // `--reasoning` is an alias for `--effort` (both set the reasoning effort).
  const effort = flagValue(argv, "--effort") || flagValue(argv, "--reasoning");
  if (effort) modelOptions.effort = effort;
  const session = flagValue(argv, "--session", "default");
  // Mutable so `/headed` and `/headless` can switch it (each recreates the
  // browser, since headless is fixed at construction).
  let headless = !flags.has("--headed");

  const newBrowser = () =>
    new BetterWright({
      policy: policyFromFlags(flags),
      headless,
      stealthRuntimeFix: flags.has("--stealth") || undefined,
    });
  let browser = newBrowser();
  // The running transcript, so a follow-up task remembers earlier ones. `/new`
  // clears it (and the browser) to start a clean session.
  let history = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const nextLine = makeLineReader(rl);
  rl.on("SIGINT", () => rl.close());

  const modelLabel = () => `${model}${modelOptions.model ? ` (${modelOptions.model})` : ""}`;
  const reasoningLabel = () => modelOptions.effort || "low";
  console.log(bold("BetterWright") + " — interactive agent console");
  console.log(
    dim(`model ${modelLabel()} · reasoning ${reasoningLabel()} · session ${session} · ${headless ? "headless" : "headed"}`),
  );
  console.log(dim("Type a task and press Enter. Follow-ups keep the session; /new starts fresh."));
  console.log(dim("/help for commands, /exit or Ctrl-D to quit.\n"));

  try {
    for (;;) {
      const raw = await nextLine(bold("▸ "));
      if (raw === null) break; // Ctrl-D / closed
      const task = raw.trim();
      if (!task) continue;

      if (task.startsWith("/")) {
        const [cmd, ...args] = task.slice(1).split(/\s+/);
        const arg = args.join(" ").trim();
        if (cmd === "exit" || cmd === "quit" || cmd === "q") break;
        if (cmd === "help" || cmd === "h" || cmd === "") {
          console.log(INTERACTIVE_HELP);
          continue;
        }
        if (cmd === "clear") {
          console.clear();
          continue;
        }
        if (cmd === "model") {
          if (arg) model = arg;
          console.log(dim(`model is ${modelLabel()}`));
          continue;
        }
        if (cmd === "effort" || cmd === "reasoning") {
          if (arg) modelOptions.effort = arg;
          console.log(dim(`reasoning effort is ${modelOptions.effort || "low"}`));
          continue;
        }
        if (cmd === "headed" || cmd === "headless") {
          const wantHeadless = cmd === "headless";
          if (wantHeadless === headless) {
            console.log(dim(`already ${headless ? "headless" : "headed"}`));
            continue;
          }
          // Headless is fixed at construction, so recreate the browser. The
          // on-disk profile (logins/cookies) and the conversation carry over;
          // open tabs do not.
          headless = wantHeadless;
          await browser.close();
          browser = newBrowser();
          console.log(dim(`switched to ${headless ? "headless" : "headed"} (fresh browser; you stay signed in)`));
          continue;
        }
        if (cmd === "new" || cmd === "reset") {
          await browser.close();
          browser = newBrowser();
          history = [];
          console.log(dim("started a fresh session (browser and memory cleared)"));
          continue;
        }
        console.log(dim(`unknown command /${cmd} — /help for the list`));
        continue;
      }

      let result;
      try {
        result = await runAgentTask({
          task,
          browser,
          model,
          modelOptions,
          session,
          history,
          onStep: ({ step, tool, note }) => {
            // `ask` is rendered by the askUser handler below; skip it here.
            if (tool === "ask") return;
            process.stdout.write(`${dim(`  · [${step}] ${tool}${note ? `: ${note}` : ""}`)}\n`);
          },
          askUser: async ({ question, options }) => {
            const lines = [bold(`  ? ${question}`)];
            if (options?.length)
              for (const [i, o] of options.entries()) lines.push(dim(`      ${i + 1}. ${o}`));
            console.log(lines.join("\n"));
            const ans = await nextLine("  answer ▸ ");
            return ans === null ? "" : ans.trim();
          },
        });
      } catch (error) {
        // A failed task must not kill the console — report and keep going. History
        // is left untouched so the next task still has the prior context.
        console.log(dim(`  ! ${error?.message || error}`));
        continue;
      }

      // Carry the transcript forward so the next task remembers this one.
      history = result.transcript;

      console.log(result.answer ? `\n${bold(result.answer)}` : dim("\n(no answer returned)"));
      if (result.proof) console.log(dim(`proof: ${result.proof}`));
      console.log(
        dim(
          `${result.ok ? "done" : "unfinished"} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
            `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"} · ${formatDuration(result.durationMs)} · ` +
            `${formatAgentUsage(result.usage)}\n`,
        ),
      );
    }
  } finally {
    rl.close();
    await browser.close();
  }
  console.log(dim("bye"));
  return 0;
}

// `exec <task>`: BetterWright's own agent harness (the exec shape).
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
      'Usage: betterwright exec "<task>" [--model claude|codex|grok|<model-id>] [--model-id <id>] [--effort|--reasoning <level>] [--max-steps <n>] [--session <name>] [--headed]',
    );
    return 1;
  }
  const modelOptions = {};
  const modelId = flagValue(argv, "--model-id");
  if (modelId) modelOptions.model = modelId;
  // `--reasoning` is an alias for `--effort` (both set the reasoning effort).
  const effort = flagValue(argv, "--effort") || flagValue(argv, "--reasoning");
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
  process.stderr.write(
    `  done in ${result.steps} step${result.steps === 1 ? "" : "s"}, ` +
      `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}, ` +
      `${formatDuration(result.durationMs)}, ${formatAgentUsage(result.usage)}\n`,
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
        durationMs: result.durationMs,
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
  const tokens = process.argv.slice(2);
  const flags = new Set(tokens.filter((token) => token.startsWith("--")));
  const first = tokens[0];
  // No subcommand (nothing, or only flags like `betterwright --headed`): launch
  // the interactive agent console. `--version`/`--help` are still honored.
  if (!first || first.startsWith("-")) {
    if (flags.has("--version")) {
      console.log(require("../package.json").version);
      return 0;
    }
    if (flags.has("--help") || tokens.includes("-h")) {
      console.error(
        "Usage: betterwright [interactive] | <setup|doctor|run|repl|exec|auth|skill|skills|mcp> [options]\n" +
          "Run `betterwright` with no arguments for the interactive agent console.",
      );
      return 0;
    }
    return cmdInteractive(flags);
  }
  const command = first;
  const rest = tokens.slice(1);
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
    default:
      console.error(
        "Usage: betterwright [interactive] | <setup|doctor|run|repl|exec|auth|skill|skills|mcp> [options]\n" +
          "Run `betterwright` with no arguments for the interactive agent console.",
      );
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  },
);
