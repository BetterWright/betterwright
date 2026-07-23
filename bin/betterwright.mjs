#!/usr/bin/env node
// BetterWright command-line interface (Node).
//
//   betterwright                  interactive agent console (type tasks, watch
//                                 progress, answer the agent's questions)
//   betterwright setup            install Chromium fork (mac/linux) + Cloak fallback
//   betterwright update           download/refresh the Chromium fork (switches from Cloak)
//   betterwright doctor           report runtime readiness
//   betterwright run <file|-|-c>  execute a Playwright snippet
//   betterwright repl             run blank-line-separated snippets from stdin
//   betterwright exec <task>      run a task with BetterWright's own agent loop
//   betterwright models           list models from OpenAI-compatible endpoints
//   betterwright view             live web view of the browser (watch/take over)
//   betterwright auth --login <p> OAuth sign-in for a model backend (codex|grok)
//   betterwright skill            print paste-ready agent instructions
//                                 (--claude: SKILL.md to stdout; --install:
//                                 write ~/.claude/skills/browser/SKILL.md)
//   betterwright skills [list|show]  read on-demand site/provider knowledge packs
//   betterwright mcp              serve the MCP stdio server (needs the MCP SDK)
//
// run/repl flags: --headed, network flags (--block-private-network,
// --block-loopback, --allow-host/--block-host), and --stealth (isolated-world
// driver that evades main-world automation detection; needs patchright-core).
// run only: --approve-downloads (one bounded download-enabled run).

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { formatAgentUsage } from "../src/agent-usage.mjs";
import { installChromiumFork } from "../src/chromium-fork-install.mjs";
import {
  createInteractiveBrowserLifecycle,
  formatHangingText,
  makeLineReader,
  readExecTaskFromStdin,
} from "../src/cli-io.mjs";
import { doctorReport, resolveCloakDir, resolveCoreDir } from "../src/doctor.mjs";
import { agentSystemPrompt, BetterWright, NetworkPolicy } from "../src/index.mjs";
import { defaultLiveViewListen, guessLanHost } from "../src/live-view.mjs";

const require = createRequire(import.meta.url);

/**
 * Live-view options for CLI `--live-view` / `view`.
 * Always defaults to LAN-reachable bind + publicHost (never localhost unless
 * explicitly requested). Override with `--host` / env.
 */
function liveViewCliOptions(argv = process.argv, { required = false } = {}) {
  const flags = new Set(argv.filter((token) => token.startsWith("--")));
  if (!required && !flags.has("--live-view")) return undefined;
  const lan = defaultLiveViewListen();
  const host = String(
    flagValue(argv, "--host", process.env.BETTERWRIGHT_LIVE_VIEW_HOST || lan.host),
  );
  const port = Number(
    flagValue(argv, "--port", process.env.BETTERWRIGHT_LIVE_VIEW_PORT || 0),
  ) || 0;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const wildcard = host === "0.0.0.0" || host === "::" || host === "";
  const publicHost = String(
    flagValue(
      argv,
      "--public-host",
      process.env.BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST ||
        (loopback ? host : wildcard ? lan.publicHost || guessLanHost() : host),
    ),
  );
  // One-word hosting presets; an explicit --host wins over --expose (and over
  // an expose preset stored in config.json, hence the explicit empty string).
  let expose = String(
    flagValue(argv, "--expose", process.env.BETTERWRIGHT_LIVE_VIEW_EXPOSE || ""),
  )
    .trim()
    .toLowerCase();
  if (expose && flags.has("--host")) {
    process.stderr.write("--host overrides --expose; ignoring --expose.\n");
    expose = "";
  }
  // The password comes from config.json (`betterwright view --set-password`)
  // or the env var — never a flag, so it stays out of shell history and ps.
  const password = String(process.env.BETTERWRIGHT_LIVE_VIEW_PASSWORD || "");
  return {
    host,
    port,
    publicHost,
    interactive: !flags.has("--watch-only"),
    ...(expose || flags.has("--host") ? { expose } : {}),
    ...(password ? { password } : {}),
  };
}

/** Prompt on the TTY with echo suppressed (for --set-password). */
async function promptHidden(question) {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (text) => {
      if (!muted) write?.(text);
    };
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

/** `view --set-password` / `--clear-password`: manage the stored password hash. */
async function cmdViewPassword(flags) {
  const { saveLiveViewPassword, liveViewConfigPath } = await import("../src/live-view-config.mjs");
  const { dim } = styler();
  if (flags.has("--clear-password")) {
    const file = saveLiveViewPassword(null);
    console.log(`Live-view password cleared (${file}).`);
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error("--set-password needs an interactive terminal.");
    return 1;
  }
  const first = await promptHidden("New live-view password: ");
  if (first.length < 4) {
    console.error("Password must be at least 4 characters.");
    return 1;
  }
  const second = await promptHidden("Repeat it: ");
  if (first !== second) {
    console.error("Passwords did not match — nothing saved.");
    return 1;
  }
  const file = saveLiveViewPassword(first);
  console.log(`Live-view password saved (hashed) to ${file}.`);
  console.log(dim("Every live view (view, exec --live-view, MCP handoffs) now requires it."));
  console.log(dim(`Config path: ${liveViewConfigPath()} — remove with \`betterwright view --clear-password\`.`));
  return 0;
}

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

// Cloaking V2 flags shared by run/repl/agent. On by default; --no-cloak-v2
// disables the coherent-identity layer. --upstream-proxy chains an egress
// proxy through the policy guard (the IP layer); --geoip aligns locale and
// timezone with the egress IP unless --locale/--timezone pin them explicitly.
function cloakingFromFlags(flags) {
  return {
    cloakV2: !flags.has("--no-cloak-v2"),
    upstreamProxy: flagValue(process.argv, "--upstream-proxy") || undefined,
    geoip: flags.has("--geoip"),
    locale: flagValue(process.argv, "--locale") || undefined,
    timezone: flagValue(process.argv, "--timezone") || undefined,
    headedInvisible: flags.has("--headed-invisible"),
    platform: flagValue(process.argv, "--platform") || undefined,
    stealthRuntimeFix: flags.has("--stealth") || undefined,
  };
}

async function cmdDoctor() {
  const report = await doctorReport();
  for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(20)} ${value}`);
  console.log(report.ready ? "\nBetterWright is ready." : "\nNot ready. Run `betterwright setup`.");
  return report.ready ? 0 : 1;
}

async function installCloakBrowser() {
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
  return 0;
}

/** Download the Chromium fork so discovery prefers it over Cloak. */
async function cmdUpdate(flags) {
  if (flags.has("--cloak-only")) {
    console.error(
      "`betterwright update` installs the Chromium fork. Use `betterwright setup --cloak-only` for CloakBrowser alone.",
    );
    return 1;
  }
  const result = await installChromiumFork({ force: flags.has("--force") });
  if (result.skipped) {
    console.log(result.skipped);
    console.log("On this platform, keep using `betterwright setup` for CloakBrowser.");
    return 0;
  }
  console.log(
    "\nUpdate complete. BetterWright will use the Chromium fork by default.",
  );
  console.log("Run `betterwright doctor` to confirm (browser: chromium-fork).");
  console.log(
    "Tip: use a dedicated BETTERWRIGHT_HOME if you still need Cloak on this machine —",
  );
  console.log(
    "fork and Cloak share the default profile and are not interchangeable.",
  );
  return 0;
}

async function cmdSetup(flags) {
  if (flags.has("--chromium")) {
    console.error(
      "The stock Chromium fallback was removed. Use `betterwright update` for the Chromium fork, or `betterwright setup` for managed CloakBrowser.",
    );
    return 1;
  }

  const cloakOnly = flags.has("--cloak-only");
  if (!cloakOnly) {
    const result = await installChromiumFork({ force: flags.has("--force") });
    if (result.skipped) {
      console.log(result.skipped);
    } else if (!result.alreadyInstalled) {
      console.log(
        "Chromium fork installed. Discovery will prefer it over CloakBrowser.",
      );
    }
  } else {
    console.log("Skipping Chromium fork (--cloak-only).");
  }

  const cloakCode = await installCloakBrowser();
  if (cloakCode !== 0) return cloakCode;

  console.log("\nSetup complete. Run `betterwright doctor` to confirm.");
  if (!cloakOnly) {
    console.log(
      "On macOS arm64 / Linux x64, doctor should report browser: chromium-fork after update/setup.",
    );
  }
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
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed"), ...cloakingFromFlags(flags) });
  try {
    // One bounded download-enabled run; the skill instructs agents to get
    // explicit user approval before passing this (MCP/Pi elicit instead).
    const result = await bw.run(
      code,
      flags.has("--approve-downloads") ? { approvedDownloads: true } : undefined,
    );
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

The user can watch the browser live (and take over for MFA or tough steps). If
your host exposes a handoff or live-view tool (MCP \`browser_handoff\`, Pi), use
that — start it first, relay its URL to the user verbatim (it embeds the access
token), then keep working. From the plain CLI, snippets cannot start the viewer
(sealed by design); when the user asks for a live view:
- delegate the whole task to \`betterwright exec "<task>" --live-view\`, which
  prints the watch URL as it starts; or
- have the user run \`betterwright view\` themselves for a hands-on session with
  the same logged-in profile — but not while a \`repl\` session is active: the
  profile has a single holder, and the second process gets a blank ephemeral one.
Never claim a live view is running unless one of these actually produced a URL.

Network access is policy-guarded. Loopback and the private network are reachable
by default; add \`--block-private-network\` / \`--block-loopback\` to lock down, or
\`--allow-host <host>\` / \`--block-host <host>\` to adjust. Cloud-metadata endpoints
are always blocked.

Below, "\`run()\`" means "one \`betterwright run\` (or \`repl\`) snippet", and the
"approval-gated download tool" is \`betterwright run --approve-downloads\`: one
bounded download-enabled run, used only after the user explicitly approves.`;

// YAML frontmatter for `skill --claude`, so the output is a complete Claude
// Code SKILL.md.
const CLAUDE_SKILL_FRONTMATTER = `---
name: browser
description: Drive a persistent, policy-guarded real web browser via the betterwright CLI. Use for any task that needs the live web — logging in, filling forms, booking, buying, or reading a page an API will not give you.
---`;

function cmdSkill(flags) {
  const body = `${SKILL_PREAMBLE}\n\n${agentSystemPrompt()}`;
  if (flags.has("--install")) {
    // Claude Code personal skill: ~/.claude/skills/browser/SKILL.md. The file
    // is generated (not vendored) so it always matches this CLI's version —
    // rerun after `betterwright update` or an npm upgrade.
    const dir = path.join(os.homedir(), ".claude", "skills", "browser");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, `${CLAUDE_SKILL_FRONTMATTER}\n\n${body}\n`);
    console.log(`Installed ${file}`);
    console.log(
      "Claude Code picks it up automatically. Rerun this after upgrading " +
        "betterwright; for other agents, `betterwright skill` prints the same " +
        "instructions to paste anywhere.",
    );
    return 0;
  }
  console.log(flags.has("--claude") ? `${CLAUDE_SKILL_FRONTMATTER}\n\n${body}` : body);
  return 0;
}

async function cmdRepl(flags) {
  const bw = new BetterWright({ policy: policyFromFlags(flags), headless: !flags.has("--headed"), ...cloakingFromFlags(flags) });
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
  if (index !== -1 && index + 1 < argv.length) return argv[index + 1];
  const assigned = argv.find((token) => token.startsWith(`${flag}=`));
  return assigned ? assigned.slice(flag.length + 1) : fallback;
}

const VALUE_FLAGS = new Set([
  "--allow-host",
  "--api-key-env",
  "--base-url",
  "--block-host",
  "--effort",
  "--endpoint",
  "--expose",
  "--host",
  "--locale",
  "--model",
  "--model-id",
  "--platform",
  "--port",
  "--protocol",
  "--provider",
  "--public-host",
  "--reasoning",
  "--session",
  "--timezone",
  "--upstream-proxy",
]);

function firstPositional(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) return token;
    if (!token.includes("=") && VALUE_FLAGS.has(token)) index += 1;
  }
  return undefined;
}

function modelEndpointOptions(argv) {
  const baseURL =
    flagValue(argv, "--base-url") ||
    flagValue(argv, "--endpoint") ||
    undefined;
  return {
    ...(baseURL ? { baseURL } : {}),
    ...(flagValue(argv, "--api-key-env")
      ? { apiKeyEnv: flagValue(argv, "--api-key-env") }
      : {}),
    ...(flagValue(argv, "--protocol")
      ? { protocol: flagValue(argv, "--protocol") }
      : {}),
    ...(argv.includes("--allow-insecure-model-endpoint")
      ? { allowInsecureEndpoint: true }
      : {}),
  };
}

function modelCliSelection(argv) {
  const model =
    flagValue(
      argv,
      "--model",
      process.env.BETTERWRIGHT_MODEL || "claude-opus-4-8",
    ) || "";
  const modelOptions = modelEndpointOptions(argv);
  const effort = flagValue(argv, "--effort") || flagValue(argv, "--reasoning");
  if (effort) modelOptions.effort = effort;
  return { model, modelOptions };
}

function removedModelFlagMessage(argv) {
  if (flagValue(argv, "--provider") !== undefined) {
    return "--provider was removed. Put the source in --model only when needed, for example --model ollama/qwen3:8b.";
  }
  if (flagValue(argv, "--model-id") !== undefined) {
    return "--model-id was merged into --model. Use --model <id>.";
  }
  return "";
}

const MODEL_ENDPOINT_SOURCES = new Set([
  "openrouter",
  "ollama",
  "vllm",
  "custom",
]);

function modelSource(value) {
  const source = String(value || "")
    .trim()
    .toLowerCase();
  if (!source) return "";
  if (MODEL_ENDPOINT_SOURCES.has(source)) return source;
  throw new Error(
    `Unknown model source "${value}". Use openrouter, ollama, vllm, or a custom --base-url.`,
  );
}

async function loadModelCatalog(
  listEndpointModels,
  nativeModelCatalog,
  options = {},
) {
  const requested = modelSource(options.source);
  const sources = requested
    ? [requested]
    : options.modelOptions?.baseURL
      ? ["custom"]
      : [
          "ollama",
          "vllm",
          ...(process.env.OPENROUTER_API_KEY ? ["openrouter"] : []),
        ];
  const settled = await Promise.all(
    sources.map(async (source) => {
      try {
        const result = await listEndpointModels({
          source,
          ...(source === "custom" ? options.modelOptions : {
            apiKeyEnv: options.modelOptions?.apiKeyEnv,
            allowInsecureEndpoint:
              options.modelOptions?.allowInsecureEndpoint,
          }),
          ...(options.quick
            ? {
                signal: AbortSignal.timeout(
                  source === "openrouter" ? 3_000 : 750,
                ),
              }
            : {}),
        });
        return {
          source,
          models: result.models,
          baseURL: result.baseURL,
        };
      } catch (error) {
        return {
          source,
          models: [],
          error: error?.message || String(error),
        };
      }
    }),
  );
  const entries = settled.flatMap((result) =>
    result.models.map((model) => ({ source: result.source, model })),
  );
  if (!requested && !options.modelOptions?.baseURL) {
    entries.unshift(...nativeModelCatalog());
  }
  return { entries, sources: settled };
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
  /endpoint <url>     use a custom OpenAI-compatible base URL
  /models [source]    list available models (optionally one source)
  /model <id>         switch model; use source/id only to disambiguate
  /reasoning <level>  set reasoning effort (low | medium | high | xhigh | max)
  /headed             show the browser window (/headless to hide it again)
  /new                start a fresh session (clear memory + close open tabs)
  /clear              clear the screen
  /exit               quit (or Ctrl-D)

Anything else is a task: BetterWright drives the browser to complete it,
streams what it is doing, and asks you a question if it genuinely needs one.

While a task is running, type a plain-text message and press Enter to steer
the next model turn. Slash commands wait until the active task finishes.`;

const EXEC_USAGE = `Usage: betterwright exec "<task>" [options]
       printf '%s\\n' 'find options under $4000' | betterwright exec --stdin [options]

Shell note: double quotes still expand \`$\`. Use single quotes for literal prices:
  betterwright exec 'find options under $4000'

Options: --stdin --model <id|source/id> --base-url <url> --api-key-env <name>
         --protocol chat|responses --effort <level> --session <name> --headed
         --live-view`;
const MODELS_USAGE =
  "Usage: betterwright models [openrouter|ollama|vllm] [--base-url <url>] [--api-key-env <name>] [--json]";

// Bare `betterwright` (no subcommand): an interactive agent console. You type
// natural-language tasks; BetterWright's own agent loop drives the browser,
// streams each step it takes, prints the answer and what the run cost, and can
// ask you a question through the `ask` tool when it genuinely needs input. One
// browser session persists across tasks until you exit.
async function cmdInteractive(flags) {
  const {
    listEndpointModels,
    modelSelectionChoices,
    nativeModelCatalog,
    runAgentTask,
  } = await import("../src/agent.mjs");
  const argv = process.argv;
  const { dim, bold } = styler();
  const removedFlag = removedModelFlagMessage(argv);
  if (removedFlag) {
    console.error(removedFlag);
    return 1;
  }

  const selection = modelCliSelection(argv);
  let model = selection.model;
  const modelOptions = selection.modelOptions;
  const session = flagValue(argv, "--session", "default");
  // Mutable so `/headed` and `/headless` can switch it (each recreates the
  // browser, since headless is fixed at construction).
  let headless = !flags.has("--headed");

  const newBrowser = () =>
    new BetterWright({
      policy: policyFromFlags(flags),
      headless,
      ...cloakingFromFlags(flags),
    });
  const interactiveLiveView = liveViewCliOptions(argv);
  const browsers = createInteractiveBrowserLifecycle({
    createBrowser: newBrowser,
    startBrowser: async (browser) => {
      if (!interactiveLiveView) return;
      try {
        const view = await browser.startLiveView({
          session,
          ...interactiveLiveView,
        });
        if (view?.ok && view.url) {
          console.log(`\n  ${bold("▶ Watch live:")} ${view.url}\n`);
          return;
        }
        console.log(dim(`  ! live view failed to start: ${view?.error || "no URL returned"}`));
      } catch (error) {
        console.log(dim(`  ! live view failed to start: ${error?.message || error}`));
      }
    },
  });
  // The running transcript, so a follow-up task remembers earlier ones. `/new`
  // clears it (and the browser) to start a clean session.
  let history = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const nextLine = makeLineReader(rl);
  rl.on("SIGINT", () => rl.close());
  let taskRunning = false;

  const clearInputPrompt = () => {
    if (!process.stdout.isTTY) return;
    const rows = Math.max(0, Number(rl.getCursorPos?.().rows) || 0);
    for (let row = 0; row <= rows; row += 1) {
      readline.clearLine(process.stdout, 0);
      if (row < rows) readline.moveCursor(process.stdout, 0, -1);
    }
    readline.cursorTo(process.stdout, 0);
  };
  const showSteeringPrompt = () => {
    if (!taskRunning || !process.stdout.isTTY) return;
    rl.setPrompt(dim("steer ▸ "));
    rl.prompt(true);
  };
  const writeInteractive = (
    prefix,
    text,
    style = (value) => value,
  ) => {
    if (taskRunning) clearInputPrompt();
    const wrapped = formatHangingText(prefix, text, {
      columns: process.stdout.columns || 100,
    });
    process.stdout.write(
      `${wrapped.split("\n").map((line) => style(line)).join("\n")}\n`,
    );
    showSteeringPrompt();
  };
  const beginTaskInput = () => {
    taskRunning = true;
    showSteeringPrompt();
  };
  const endTaskInput = () => {
    clearInputPrompt();
    taskRunning = false;
  };

  const modelLabel = () => model || "(choose a model)";
  const reasoningLabel = () => modelOptions.effort || "model default";
  console.log(`${bold("BetterWright")} — interactive agent console`);
  console.log(
    dim(`model ${modelLabel()} · reasoning ${reasoningLabel()} · session ${session} · ${headless ? "headless" : "headed"}`),
  );
  console.log(dim("Type a task and press Enter. Follow-ups keep the session; /new starts fresh."));
  console.log(dim("While it works, type a message and press Enter to steer its next turn."));
  console.log(dim("/help for commands, /exit or Ctrl-D to quit.\n"));

  try {
    // The console owns one viewer for the lifetime of this browser session.
    // Start it before accepting the first task; runAgentTask only attaches to
    // the already-running view and therefore cannot churn its URL per message.
    await browsers.start();
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
        if (cmd === "endpoint") {
          if (!arg) {
            console.log(dim(`endpoint is ${modelOptions.baseURL || "(not set)"}`));
            continue;
          }
          if (["clear", "off", "none"].includes(arg.toLowerCase())) {
            delete modelOptions.baseURL;
            console.log(dim("custom endpoint cleared"));
            continue;
          }
          modelOptions.baseURL = arg;
          console.log(dim(`custom endpoint is ${arg} · model is ${modelLabel()}`));
          continue;
        }
        if (cmd === "models") {
          try {
            const catalog = await loadModelCatalog(
              listEndpointModels,
              nativeModelCatalog,
              {
                source: arg,
                modelOptions,
                quick: !arg,
              },
            );
            const choices = modelSelectionChoices(catalog.entries);
            if (!choices.length) {
              console.log(dim("no available models found"));
            } else {
              console.log(choices.map((choice) => choice.selector).join("\n"));
            }
            for (const source of catalog.sources) {
              if (source.error) {
                console.log(dim(`${source.source}: unavailable (${source.error})`));
              }
            }
          } catch (error) {
            console.log(dim(`could not list models: ${error?.message || error}`));
          }
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
          await browsers.replace();
          console.log(dim(`switched to ${headless ? "headless" : "headed"} (fresh browser; you stay signed in)`));
          continue;
        }
        if (cmd === "new" || cmd === "reset") {
          await browsers.replace();
          history = [];
          console.log(dim("started a fresh session (browser and memory cleared)"));
          continue;
        }
        console.log(dim(`unknown command /${cmd} — /help for the list`));
        continue;
      }

      let result;
      const steering = [];
      beginTaskInput();
      const stopSteeringCapture = nextLine.capture((line) => {
        const message = String(line || "").trim();
        if (!message) return;
        if (message.startsWith("/")) {
          writeInteractive(
            "  ↳ ",
            "command queued until the active task finishes",
            dim,
          );
          return false;
        }
        steering.push(message);
        writeInteractive(
          "  ↳ ",
          "steering queued for the next model turn",
          dim,
        );
      });
      try {
        result = await runAgentTask({
          task,
          browser: browsers.browser,
          model,
          modelOptions,
          session,
          history,
          drainSteering: () => steering.splice(0, steering.length),
          liveView: liveViewCliOptions(process.argv),
          onStep: ({ step, tool, note, url }) => {
            // `ask` is rendered by the askUser handler below; skip it here.
            if (tool === "ask") return;
            // Live-view / handoff URLs are for the human — print them loud,
            // not as a dim progress line.
            if (url && (tool === "handoff" || tool === "liveView")) {
              writeInteractive(
                tool === "handoff"
                  ? "  ▶ The agent needs your hands: "
                  : "  ▶ Watch live: ",
                url,
                bold,
              );
              if (tool === "handoff" && note)
                writeInteractive("    ", note, dim);
              return;
            }
            if (tool === "liveView" && note) {
              writeInteractive("  ! ", note, dim);
              return;
            }
            writeInteractive(
              `  · [${step}] ${tool}${note ? ": " : ""}`,
              note || "",
              dim,
            );
          },
          askUser: async ({ question, options }) => {
            writeInteractive("  ? ", question, bold);
            if (options?.length) {
              for (const [i, option] of options.entries())
                writeInteractive(`      ${i + 1}. `, option, dim);
            }
            const ans = await nextLine("  answer ▸ ");
            showSteeringPrompt();
            return ans === null ? "" : ans.trim();
          },
        });
      } catch (error) {
        // A failed task must not kill the console — report and keep going. History
        // is left untouched so the next task still has the prior context.
        writeInteractive("  ! ", error?.message || error, dim);
        continue;
      } finally {
        stopSteeringCapture();
        endTaskInput();
      }

      // Carry the transcript forward so the next task remembers this one.
      history = result.transcript;

      process.stdout.write("\n");
      writeInteractive(
        "",
        result.answer || "(no answer returned)",
        result.answer ? bold : dim,
      );
      if (result.proof) writeInteractive("proof: ", result.proof, dim);
      writeInteractive(
        "",
        `${result.ok ? "done" : `unfinished (${result.reason || "unknown"})`} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
          `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"} · ${formatDuration(result.durationMs)} · ` +
          formatAgentUsage(result.usage),
        dim,
      );
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
    await browsers.close();
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
  if (flags.has("--help")) {
    console.log(EXEC_USAGE);
    return 0;
  }
  const removedFlag = removedModelFlagMessage(argv);
  if (removedFlag) {
    console.error(removedFlag);
    return 1;
  }
  const positionalTask = firstPositional(argv.slice(3));
  if (flags.has("--stdin") && positionalTask) {
    console.error("Pass either a task argument or --stdin, not both.");
    return 1;
  }
  const task = flags.has("--stdin")
    ? readExecTaskFromStdin()
    : positionalTask;
  if (!task?.trim()) {
    console.error(EXEC_USAGE);
    return 1;
  }
  const { model, modelOptions } = modelCliSelection(argv);

  let result;
  try {
    result = await runAgentTask({
      task,
      model,
      modelOptions,
      session: flagValue(argv, "--session", "default"),
      policy: policyFromFlags(flags),
      headless: !flags.has("--headed"),
      // --live-view starts the viewer at step 0 so the whole run can be
      // watched; without it the handoff tool still starts one on demand.
      // Host/port come from --host / env (default 0.0.0.0 + LAN publicHost).
      liveView: liveViewCliOptions(argv),
      onStep: ({ step, tool, note, url }) => {
        if (url && (tool === "handoff" || tool === "liveView")) {
          process.stderr.write(`\n  ▶ ${tool === "handoff" ? "HANDOFF" : "LIVE VIEW"}: ${url}\n`);
          if (tool === "handoff") process.stderr.write(`    ${note}\n\n`);
          return;
        }
        if (tool === "liveView" && note) {
          process.stderr.write(`  ! ${note}\n`);
          return;
        }
        process.stderr.write(`  [${step}] ${tool}${note ? `: ${note}` : ""}\n`);
      },
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

async function cmdModels(flags) {
  const {
    listEndpointModels,
    modelSelectionChoices,
    nativeModelCatalog,
  } = await import("../src/agent.mjs");
  if (flags.has("--help")) {
    console.log(MODELS_USAGE);
    return 0;
  }
  const removedFlag = removedModelFlagMessage(process.argv);
  if (removedFlag) {
    console.error(removedFlag);
    return 1;
  }
  try {
    const source = firstPositional(process.argv.slice(3));
    const modelOptions = modelEndpointOptions(process.argv);
    const catalog = await loadModelCatalog(
      listEndpointModels,
      nativeModelCatalog,
      {
        source,
        modelOptions,
        quick: !source && !modelOptions.baseURL,
      },
    );
    const models = modelSelectionChoices(catalog.entries);
    if (flags.has("--json")) {
      console.log(JSON.stringify({ models, sources: catalog.sources }, null, 2));
      return 0;
    }
    for (const item of catalog.sources) {
      if (item.error) {
        process.stderr.write(`${item.source}: unavailable (${item.error})\n`);
      }
    }
    if (!models.length) {
      console.error("No available models found.");
      return 1;
    }
    console.log(models.map((model) => model.selector).join("\n"));
    return 0;
  } catch (error) {
    console.error(error?.message || String(error));
    return 1;
  }
}

// `view`: open a live, token-gated web view of this BetterWright browser and
// hold it until Ctrl-C. This launches (or reuses) this process's own managed
// browser — it is the remote-desktop shape: warm up logins by hand, drive a
// headless VPS browser from your laptop, or watch what a later `exec` in the
// same process would do. To watch an agent run live, prefer
// `betterwright exec --live-view` / the interactive console, which stream the
// agent's own browser.
async function cmdView(flags) {
  if (flags.has("--set-password") || flags.has("--clear-password")) {
    return cmdViewPassword(flags);
  }
  const argv = process.argv;
  const { dim, bold } = styler();
  // Same host resolution as `exec --live-view` so view/exec behave alike.
  const liveOpts = liveViewCliOptions(argv, { required: true });
  const browser = new BetterWright({
    policy: policyFromFlags(flags),
    headless: !flags.has("--headed"),
    ...cloakingFromFlags(flags),
  });
  try {
    const view = await browser.startLiveView({
      ...liveOpts,
      session: flagValue(argv, "--session", "default"),
    });
    if (!view.ok || !view.url) {
      console.error(view.error || "The live view failed to start.");
      return 1;
    }
    // Give the viewer something to show before the first human navigation.
    await browser.run("if (page.url() === 'about:blank') await page.goto('about:blank'); 'ready'");
    console.log(`${bold("Live view:")} ${view.url}`);
    const reach =
      view.expose === "tailscale"
        ? "devices on your tailnet (Tailscale)"
        : view.expose === "local"
          ? "only this machine (bring your own tunnel)"
          : "devices on your local network";
    console.log(
      dim(
        `who can open it: ${reach} · ${view.interactive ? "interactive" : "watch-only"} · ` +
          (view.passwordProtected
            ? "password required"
            : "no password (set one with `betterwright view --set-password`)"),
      ),
    );
    if (view.expose === "local" || ["127.0.0.1", "localhost", "::1"].includes(view.host)) {
      console.log(dim(`tunnel it:  ssh -L ${view.port}:127.0.0.1:${view.port} <this-host>`));
      console.log(dim(`       or:  cloudflared tunnel --url http://127.0.0.1:${view.port}`));
    }
    console.log(dim("The URL embeds a capability token — treat it like a password. Ctrl-C to stop."));
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return 0;
  } finally {
    await browser.close();
  }
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
    const model =
      result.provider === "codex"
        ? process.env.BETTERWRIGHT_CODEX_MODEL || "gpt-5.6-sol"
        : process.env.BETTERWRIGHT_GROK_MODEL ||
          process.env.XAI_MODEL ||
          "grok-4.3";
    console.log(`Run a task with: betterwright exec "<task>" --model ${model}`);
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
        "Usage: betterwright [interactive] | <setup|update|doctor|run|repl|exec|models|view|auth|skill|skills|mcp> [options]\n" +
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
    case "update":
      return cmdUpdate(flags);
    case "doctor":
      return cmdDoctor();
    case "run":
      return cmdRun(positional, flags);
    case "repl":
      return cmdRepl(flags);
    case "exec":
      return cmdExec(flags);
    case "models":
      return cmdModels(flags);
    case "view":
      return cmdView(flags);
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
        "Usage: betterwright [interactive] | <setup|update|doctor|run|repl|exec|models|view|auth|skill|skills|mcp> [options]\n" +
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
