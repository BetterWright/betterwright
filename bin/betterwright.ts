#!/usr/bin/env node
// BetterWright command-line interface (Node).
//
//   betterwright                  interactive agent console (type tasks, watch
//                                 progress, answer the agent's questions)
//   betterwright setup            install Chromium fork (mac/linux) + Cloak fallback
//   betterwright update           download/refresh the Chromium fork (switches from Cloak)
//   betterwright doctor           report runtime readiness
//   betterwright run <file|-|-c>  execute a Playwright snippet in the
//                                 persistent session (tabs/state survive calls)
//   betterwright repl             run blank-line-separated snippets from stdin
//   betterwright exec <task>      run a task with BetterWright's own agent loop
//                                 (repeat execs continue the same session)
//   betterwright sessions         list live sessions in the background daemon
//   betterwright close [name]     close a session (--all: everything + daemon)
//   betterwright models           list models from OpenAI-compatible endpoints
//   betterwright view             live web view (attaches to the session daemon
//                                 mid-session when one is running; anytime)
//   betterwright auth --login <p> OAuth sign-in for a model backend (codex|grok)
//   betterwright skill            print paste-ready agent instructions
//                                 (--claude: SKILL.md to stdout; --install:
//                                 write Claude + Agent Skills dirs; --all: +Cursor)
//   betterwright skills [list|show]  read on-demand site/provider knowledge packs
//   betterwright mcp              serve the MCP stdio server (needs the MCP SDK)
//
// run/repl flags: --headed, network flags (--block-private-network,
// --block-loopback, --allow-host/--block-host), and --stealth (isolated-world
// driver that evades main-world automation detection; needs patchright-core).
// run only: --approve-downloads (one bounded download-enabled run).
//
// run/repl/exec share a persistent browser held by a background session
// daemon (spawned on first use, exits when its last session closes): open
// tabs, page state, and the repl `state` object survive between invocations,
// keyed by --session (default "default"). --fresh forgets exec history,
// --close ends the session after the call, --no-daemon forces the old
// one-shot behavior.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatAgentUsage } from "../src/agent-usage.js";
import { installChromiumFork } from "../src/chromium-fork-install.js";
import { collectValues, firstPositional, flagValue } from "../src/cli-flags.js";
import { helpFor, MAIN_USAGE, wantsHelp } from "../src/cli-help.js";
import {
  createInteractiveBrowserLifecycle,
  formatHangingText,
  makeLineReader,
  readExecTaskFromStdin,
} from "../src/cli-io.js";
import {
  daemonLogPath,
  daemonProfilesInHome,
  defaultDaemonHome,
  sessionName,
} from "../src/daemon.js";
import {
  connectSessionDaemon,
  createDaemonBrowser,
  daemonDisabled,
  execTask,
  interruptSession,
} from "../src/daemon-client.js";
import {
  doctorChecks,
  doctorReport,
  formatDoctorChecks,
  modelSetupHint,
  preferredModelId,
  resolveCloakDir,
  resolveCoreDir,
} from "../src/doctor.js";
import { defaultLiveViewListen, guessLanHost } from "../src/live-view.js";
import { profileLabel, resolveProfileName } from "../src/profile-name.js";
// `agentSystemPrompt` comes from the light prompt module, not index.js, which
// would drag the whole browser/worker/vault graph in just to print a skill.
import { agentSystemPrompt } from "../src/prompt.js";
import {
  clearTranscript,
  loadTranscript,
  saveTranscript,
} from "../src/session-store.js";
import {
  installAgentSkills,
  packageVersion,
  parseGeneratedBy,
  refreshInstalledAgentSkills,
  resolveSkillInstallPaths,
  wrapClaudeSkillMarkdown,
} from "../src/skill-install.js";

const require = createRequire(import.meta.url);
const CLI_PATH = fileURLToPath(import.meta.url);

/**
 * Live-view options for CLI `--live-view` / `view`.
 * Always defaults to LAN-reachable bind + publicHost (never localhost unless
 * explicitly requested). Override with `--host` / env.
 */
function liveViewCliOptions(argv = process.argv, { required = false }: any = {}) {
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
  return new Promise<string>((resolve) => {
    const rl: any = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
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
  const { saveLiveViewPassword, liveViewConfigPath } = await import("../src/live-view-config.js");
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

// The browser stack (BetterWright, NetworkPolicy, and everything client.ts
// pulls) is loaded on first use, not at startup. Memoized so repeated
// constructions in one process (e.g. the interactive console's /new) import
// once.
let browserModulePromise: Promise<typeof import("../src/index.js")> | null = null;
function browserModule() {
  browserModulePromise ??= import("../src/index.js");
  return browserModulePromise;
}

function policyOptionsFromFlags(flags) {
  // Private networks and loopback are open by default; --block-private-network
  // / --block-loopback re-harden. The --allow-* flags are accepted no-ops.
  return {
    allowLoopback: !flags.has("--block-loopback"),
    allowPrivateNetwork: !flags.has("--block-private-network"),
    allowHosts: collectValues(process.argv, "--allow-host"),
    blockHosts: collectValues(process.argv, "--block-host"),
  };
}

async function policyFromFlags(flags) {
  const { NetworkPolicy } = await browserModule();
  return new NetworkPolicy(policyOptionsFromFlags(flags));
}

/** Construct a local (non-daemon) BetterWright, loading the stack on demand. */
async function makeBrowser(flags, { headless }: any = {}) {
  const { BetterWright, NetworkPolicy } = await browserModule();
  return new BetterWright({
    policy: new NetworkPolicy(policyOptionsFromFlags(flags)),
    headless: headless ?? !flags.has("--headed"),
    ...(cliProfile() ? { profile: cliProfile() } : {}),
    ...cloakingFromFlags(flags),
  });
}

// The named browser profile for this invocation. `--profile <name>` selects a
// separate identity: its own cookie jar at `browser/profiles/<name>`, its own
// profile lock, and its own session daemon, so two identities run at once
// without either being signed out. Omitting it keeps the single default
// profile. Parsed from argv once and validated up front in main(), so this
// cannot throw at a call site; every browser, daemon, and transcript path in
// this file goes through it, which is what keeps the in-process fallback on
// the same identity the daemon would have used.
let cliProfileCache: string | null | undefined;
function cliProfile(): string | null {
  if (cliProfileCache === undefined) {
    const raw = flagValue(process.argv, "--profile");
    // `--profile ""` is a mistake, not a request for the default profile: a
    // script passing an unset `--profile "$IDENTITY"` must fail loudly rather
    // than quietly act as the wrong identity. Only an absent flag defaults —
    // and then BETTERWRIGHT_PROFILE, the same variable the MCP server reads,
    // so a host that runs both surfaces acts as one identity in both (and
    // `betterwright view` attaches to the browser its MCP server is driving).
    const fromEnv = String(process.env.BETTERWRIGHT_PROFILE || "").trim() || undefined;
    cliProfileCache = resolveProfileName(
      raw === undefined || raw === null ? fromEnv : raw,
    );
  }
  return cliProfileCache;
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

async function cmdDoctor(flags) {
  const report = await doctorReport();
  if (flags.has("--json")) {
    console.log(JSON.stringify({ ...report, checks: doctorChecks(report) }, null, 2));
    return report.ready ? 0 : 1;
  }
  const checks = doctorChecks(report);
  const quiet = flags.has("--quiet");
  const text = formatDoctorChecks(checks, { quiet });
  if (text) console.log(text);
  const problems = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  console.log("");
  if (report.ready && !problems.length) {
    console.log(
      warnings.length
        ? `BetterWright is ready. ${warnings.length} optional thing${warnings.length === 1 ? "" : "s"} above ${warnings.length === 1 ? "is" : "are"} not set up.`
        : "BetterWright is ready.",
    );
  } else {
    console.log("Not ready — fix the ✗ lines above, then run `betterwright doctor` again.");
  }
  return report.ready && !problems.length ? 0 : 1;
}

// `init`: the guided path from nothing to a working browser.
async function cmdInit(flags) {
  const { runInit } = await import("../src/onboard.js");
  // `flags` only carries `--`-prefixed tokens; accept `-y` as an alias for
  // `--yes` so it is not silently ignored on a TTY.
  const initFlags = new Set(flags);
  if (process.argv.includes("-y")) initFlags.add("--yes");
  return runInit({
    flags: initFlags,
    version: packageVersion(),
    doctorReport,
    installAgentSkills,
    skillMarkdown: agentSkillMarkdown,
    skillBody: agentSkillBody,
    installBrowser: () => cmdSetup(flags, { quiet: true }),
    // A real navigation through the real worker: the step that distinguishes
    // "the files are on disk" from "this actually works". Separate a browser
    // that would not launch (a real install failure) from a page that would
    // not load (offline), so init fails only on the former.
    verify: async () => {
      const bw = await makeBrowser(flags, { headless: true });
      let launched = false;
      try {
        const probe = await bw.run("return 1 + 1");
        launched = probe.ok && probe.result === 2;
        if (!launched) {
          return { ok: false, launched: false, detail: probe.error || "worker did not start" };
        }
        const result = await bw.run(
          "await page.goto('https://example.com'); return page.title()",
        );
        return result.ok && result.result === "Example Domain"
          ? { ok: true, launched: true, detail: `example.com → "${result.result}"`, warnings: result.warnings }
          : {
              ok: false,
              launched: true,
              detail: result.error || `unexpected title ${JSON.stringify(result.result)}`,
              warnings: result.warnings,
            };
      } catch (error) {
        return { ok: false, launched, detail: error?.message || String(error) };
      } finally {
        await bw.close().catch(() => {});
      }
    },
  });
}

/** Generated agent-skill body (preamble + operator guidance), no frontmatter. */
function agentSkillBody() {
  return `${SKILL_PREAMBLE}\n\n${agentSystemPrompt()}`;
}

/** Full Claude-form SKILL.md (frontmatter + stamp + body). */
function agentSkillMarkdown() {
  return wrapClaudeSkillMarkdown(agentSkillBody(), { version: packageVersion() });
}

/** After setup/update: rewrite only skill files already installed. */
function refreshAgentSkillsQuietly() {
  try {
    const { refreshed } = refreshInstalledAgentSkills({
      markdown: agentSkillMarkdown(),
      targets: "all",
    });
    if (refreshed.length) {
      console.log(
        `Refreshed ${refreshed.length} agent skill file(s) to betterwright@${packageVersion()}.`,
      );
      for (const file of refreshed) console.log(`  ${file}`);
    }
  } catch (error) {
    console.log(
      `Could not refresh agent skill files: ${error?.message || error}`,
    );
  }
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
  refreshAgentSkillsQuietly();
  return 0;
}

async function cmdSetup(flags, { quiet = false }: any = {}) {
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

  // `init` reports its own progress and next steps, so it suppresses ours
  // rather than telling the user to run doctor in the middle of a flow that
  // is about to verify the browser itself.
  if (!quiet) {
    console.log("\nSetup complete. Run `betterwright doctor` to confirm.");
    if (!cloakOnly) {
      console.log(
        "On macOS arm64 / Linux x64 / Windows x64, doctor should report browser: chromium-fork after update/setup.",
      );
    }
  }
  refreshAgentSkillsQuietly();
  return 0;
}

async function readSnippet(arg) {
  const codeFlagIndex = process.argv.indexOf("-c");
  if (codeFlagIndex !== -1) return process.argv[codeFlagIndex + 1] || "";
  if (!arg || arg === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(arg, "utf8");
}

// The browser-shaping options for the session daemon, from the same flags the
// in-process paths use. The daemon builds its NetworkPolicy/BetterWright from
// this object AND derives the compatibility signature from it, so flags and
// signature can never disagree.
function daemonConfigFromFlags(flags) {
  return {
    headless: !flags.has("--headed"),
    // Selects which daemon to talk to (one per profile per home), not merely
    // how it is configured — see connectSessionDaemon.
    profile: cliProfile(),
    policy: {
      allowLoopback: !flags.has("--block-loopback"),
      allowPrivateNetwork: !flags.has("--block-private-network"),
      allowHosts: collectValues(process.argv, "--allow-host"),
      blockHosts: collectValues(process.argv, "--block-host"),
    },
    cloak: cloakingFromFlags(flags),
  };
}

/**
 * Get a browser for run/repl: the session daemon's persistent session when
 * possible (spawning the daemon on first use), a private in-process
 * BetterWright otherwise — with a warning explaining why persistence is off.
 */
async function acquireRunBrowser(flags) {
  const session = sessionName(flagValue(process.argv, "--session", "default"));
  if (!daemonDisabled(flags)) {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
      config: daemonConfigFromFlags(flags),
    });
    if (outcome.ok) {
      const { channel } = outcome;
      return {
        session,
        viaDaemon: true,
        warning: "",
        browser: createDaemonBrowser(channel, { session }),
        cleanup: async ({ closeSession = false }: any = {}) => {
          try {
            if (closeSession)
              await channel.request({ op: "close_session", session }, 60_000);
          } finally {
            channel.end();
          }
        },
      };
    }
    const bw = await makeBrowser(flags);
    return {
      session,
      viaDaemon: false,
      warning: `session persistence unavailable (${outcome.reason}); this browser closes when the command exits`,
      browser: bw,
      cleanup: async () => bw.close(),
    };
  }
  const bw = await makeBrowser(flags);
  return {
    session,
    viaDaemon: false,
    warning: "",
    browser: bw,
    cleanup: async () => bw.close(),
  };
}

async function cmdRun(arg, flags) {
  const code = await readSnippet(arg);
  const acquired = await acquireRunBrowser(flags);
  try {
    // One bounded download-enabled run; the skill instructs agents to get
    // explicit user approval before passing this (MCP/Pi elicit instead).
    const result = await acquired.browser.run(code, {
      session: acquired.session,
      ...(flags.has("--approve-downloads") ? { approvedDownloads: true } : {}),
    });
    if (acquired.viaDaemon) result.session = acquired.session;
    if (acquired.warning)
      result.warnings = [...(result.warnings || []), acquired.warning];
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    await acquired.cleanup({ closeSession: flags.has("--close") });
  }
}

// A CLI-usage preamble that turns the operator guidance (which talks about
// `run()`) into a self-contained skill for any agent that can run a shell
// command.
const SKILL_PREAMBLE = `# Browser tool: BetterWright

Operate a real, persistent web browser with the \`betterwright\` command whenever a task needs the live web. Pass async Playwright JavaScript; a trailing expression (or explicit \`return\`) is the result:

    betterwright run -c "await page.goto('https://example.com'); return page.title()"

It prints one JSON object {ok, result, error, console, events, artifacts, pages, challenges, warnings, durationMs}; \`artifacts\` lists files written during the run — screenshots there have a \`path\`; open that image to actually see the page.

Invocations share one persistent session (background daemon): open tabs, page state, and the in-memory \`state\` object survive between \`run\` calls; logins/cookies persist in the on-disk profile. Act in small steps — one \`run\` per action-and-observe — and call \`run\` again to continue. The session auto-closes after ~15 idle minutes; run \`betterwright close\` when you finish to end it sooner; give parallel workers their own \`--session <name>\` (same logins, own tabs), or \`--profile <name>\` when a run needs a different signed-in identity (own cookie jar). Batch steps in one process by piping blank-line-separated snippets: \`printf '%s\\n\\n%s\\n' "snippetA" "snippetB" | betterwright repl\` (same session).

Surface details for "Live view and handoff" below: \`browser_handoff\` action "start" opens it, "status" waits for takeover Done; \`live_view\` watches without pausing, \`handoff\` pauses until they click Done; interactive accepts \`/live\`; \`exec "<task>" --live-view\` opens the viewer at step 0; \`betterwright view\` prints a URL for the open tabs without closing them (takeover: Take control / the handoff action bar; the viewer also has its own tabs, address bar, and back/forward).

Network access is policy-guarded: loopback and the private network are reachable by default; \`--block-private-network\` / \`--block-loopback\` lock down; \`--allow-host <host>\` / \`--block-host <host>\` adjust. Cloud-metadata endpoints are always blocked. Below, "\`run()\`" means "one \`betterwright run\` (or \`repl\`) snippet"; the "approval-gated download tool" is \`betterwright run --approve-downloads\`: one bounded download-enabled run, used only after the user explicitly approves.

\`betterwright vault\` is the user's own command for reading their saved passwords, not a tool for you. Never run \`vault show --reveal\` (or its \`vault get\` alias), \`vault copy\`, or \`vault rm\`: a stored password must not enter your context or be deleted on your initiative, and fill happens inside the browser without one. \`betterwright vault list\` is metadata-only and fine when the user asks what is saved. When they want a password themselves, tell them to run \`betterwright vault copy <id>\` — it reaches their clipboard without either of us seeing it.`;

function cmdSkill(flags) {
  const body = agentSkillBody();
  if (flags.has("--status")) {
    // "Did the install actually land, and is it current?" was previously only
    // answerable by finding the file yourself and reading its frontmatter.
    const current = packageVersion();
    let any = false;
    for (const dest of resolveSkillInstallPaths({ targets: "all" })) {
      if (!fs.existsSync(dest.file)) {
        console.log(`  —  ${dest.label.padEnd(14)} not installed  ${dest.file}`);
        continue;
      }
      any = true;
      const installed = parseGeneratedBy(fs.readFileSync(dest.file, "utf8"));
      const stale = installed !== current;
      console.log(
        `  ${stale ? "!" : "✓"}  ${dest.label.padEnd(14)} ${installed ? `v${installed}` : "unstamped"}${stale ? ` (this package is v${current})` : ""}  ${dest.file}`,
      );
    }
    // Codex is wired through a marker block in ~/.codex/AGENTS.md, not a skill
    // file, so it is reported the same way but read from its own stamp. init
    // writes it; it belongs in the same status view as the skill hosts.
    const codexFile = path.join(os.homedir(), ".codex", "AGENTS.md");
    if (fs.existsSync(codexFile)) {
      const text = fs.readFileSync(codexFile, "utf8");
      const marker = text.match(/<!-- betterwright:begin(?: v([0-9][^ ]*))? -->/);
      if (marker) {
        any = true;
        const installed = marker[1] || null;
        const stale = installed !== current;
        console.log(
          `  ${stale ? "!" : "✓"}  ${"Codex".padEnd(14)} ${installed ? `v${installed}` : "unstamped"}${stale ? ` (this package is v${current})` : ""}  ${codexFile}`,
        );
      } else {
        console.log(`  —  ${"Codex".padEnd(14)} not installed  ${codexFile}`);
      }
    }
    console.log("");
    console.log(
      any
        ? "Refresh with `betterwright skill --install`."
        : "Install with `betterwright init` (recommended) or `betterwright skill --install`.",
    );
    return 0;
  }
  if (flags.has("--install")) {
    // Generated (not vendored) so it always matches this CLI version. Writes
    // Claude Code + Agent Skills dirs by default; --all also writes Cursor.
    // setup/update refresh any of these that already exist — no npm postinstall.
    const targets = flags.has("--all") ? "all" : "default";
    const markdown = agentSkillMarkdown();
    const { written } = installAgentSkills({ markdown, targets });
    for (const file of written) console.log(`Installed ${file}`);
    console.log(
      `Stamped betterwright@${packageVersion()}. ` +
        "Hosts that load ~/.claude/skills or ~/.agents/skills pick it up " +
        "automatically. After npm upgrades, re-run this (or `betterwright setup` / " +
        "`update`, which refresh already-installed skill files). " +
        "For paste-anywhere agents: `betterwright skill`.",
    );
    return 0;
  }
  console.log(flags.has("--claude") ? agentSkillMarkdown().trimEnd() : body);
  return 0;
}

async function cmdRepl(flags) {
  const acquired = await acquireRunBrowser(flags);
  const runSnippet = (code) =>
    acquired.browser.run(code, { session: acquired.session });
  console.log(
    acquired.viaDaemon
      ? `BetterWright REPL — blank line runs a snippet, Ctrl-D quits. Session "${acquired.session}" persists afterwards (betterwright close to end it).\n`
      : "BetterWright REPL — blank line runs a snippet, Ctrl-D quits.\n",
  );
  if (acquired.warning) process.stderr.write(`  ! ${acquired.warning}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  let buffer = [];
  try {
    for await (const line of rl) {
      if (line.trim()) {
        buffer.push(line);
        continue;
      }
      if (!buffer.length) continue;
      const result = await runSnippet(buffer.join("\n"));
      buffer = [];
      console.log(JSON.stringify(result, null, 2));
    }
    if (buffer.length) console.log(JSON.stringify(await runSnippet(buffer.join("\n")), null, 2));
  } finally {
    await acquired.cleanup({ closeSession: flags.has("--close") });
  }
  return 0;
}

function modelEndpointOptions(argv): Record<string, any> {
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
      process.env.BETTERWRIGHT_MODEL || preferredModelId().model,
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

async function loadModelCatalog(
  listEndpointModels,
  nativeModelCatalog,
  options: any = {},
) {
  // Loaded here rather than at module top so a plain `betterwright run` never
  // pulls the model-source layer. `models`/`exec` — the only callers — already
  // import agent.ts, so this hits its module cache.
  const { discoveryTimeoutMs, endpointDiscoverySources, endpointSourceName } =
    await import("../src/agent.js");
  // Blank means "no source requested" (list everything); any other value must
  // be a name agent.ts itself recognizes, so the accepted spellings and the
  // error wording cannot drift from `--model source/id` parsing.
  const raw = String(options.source || "").trim();
  const requested = raw ? endpointSourceName(raw) : "";
  const sources = requested
    ? [requested]
    : options.modelOptions?.baseURL
      ? ["custom"]
      : endpointDiscoverySources();
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
            ? { signal: AbortSignal.timeout(discoveryTimeoutMs(source)) }
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
  /live [stop]        open a live view now (anytime), or /live stop to close it
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
         --profile <name> --live-view --fresh --close --no-daemon

Repeated execs continue the same session: the browser (tabs, logins) stays
live in a background daemon and the agent remembers the prior conversation.
--fresh starts the session over; --close ends it after this task.

--profile <name> acts as a different identity: its own cookies, its own daemon,
its own conversation history. Two profiles run at once, each stays signed in.
Use --session for parallel work as the same identity.`;

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
  } = await import("../src/agent.js");
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

  const newBrowser = () => makeBrowser(flags, { headless });
  // Mutable: process --live-view starts a viewer at boot; `/live` enables the
  // same path mid-session so /new /headed /headless re-open it after replace.
  let interactiveLiveView = liveViewCliOptions(argv);
  const startInteractiveLiveView = async (browser, { quiet = false }: any = {}) => {
    const opts = interactiveLiveView || liveViewCliOptions(process.argv, { required: true });
    try {
      const view = await browser.startLiveView({
        session,
        ...opts,
      });
      if (view?.ok && view.url) {
        if (!quiet || !view.alreadyRunning) {
          console.log(`\n  ${bold("▶ Watch live:")} ${view.url}\n`);
        }
        interactiveLiveView = opts;
        return view;
      }
      console.log(dim(`  ! live view failed to start: ${view?.error || "no URL returned"}`));
    } catch (error) {
      console.log(dim(`  ! live view failed to start: ${error?.message || error}`));
    }
    return null;
  };
  const browsers = createInteractiveBrowserLifecycle({
    createBrowser: newBrowser,
    startBrowser: async (browser) => {
      if (!interactiveLiveView) return;
      await startInteractiveLiveView(browser);
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
    dim(
      `model ${modelLabel()} · reasoning ${reasoningLabel()} · session ${session}` +
        `${cliProfile() ? ` · profile ${profileLabel(cliProfile())}` : ""} · ${headless ? "headless" : "headed"}`,
    ),
  );
  console.log(dim("Type a task and press Enter. Follow-ups keep the session; /new starts fresh."));
  console.log(dim("While it works, type a message and press Enter to steer its next turn."));
  console.log(dim("/help for commands, /exit or Ctrl-D to quit.\n"));
  // The console is the most inviting entry point, so it is the worst place to
  // discover only after typing a task that no model is reachable. Say so up
  // front; the user can still get in and fix it with /model or /endpoint.
  if (!flagValue(argv, "--model") && !process.env.BETTERWRIGHT_MODEL && !modelOptions.baseURL) {
    const hint = modelSetupHint();
    if (hint) console.log(`${hint}\n`);
  }

  try {
    // The console needs the persistent profile itself: take it back from an
    // idle session daemon (left by earlier run/exec calls) before launching.
    const reclaim = await reclaimDaemonProfile();
    if (reclaim.closedSessions) {
      console.log(
        dim(`closed ${reclaim.closedSessions} idle background session(s) to reuse the saved profile`),
      );
    } else if (reclaim.busy) {
      console.log(
        dim("a background session is mid-task; this console gets a temporary profile (betterwright close --all to reclaim)"),
      );
    }
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
        if (cmd === "live" || cmd === "view") {
          const sub = (arg || "").trim().toLowerCase();
          if (sub === "stop" || sub === "off" || sub === "close") {
            try {
              await browsers.browser.stopLiveView?.();
              interactiveLiveView = undefined;
              console.log(dim("live view stopped"));
            } catch (error) {
              console.log(dim(`could not stop live view: ${error?.message || error}`));
            }
            continue;
          }
          await startInteractiveLiveView(browsers.browser);
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
        if (!message) return undefined;
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
        return undefined;
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
  const argv = process.argv;
  if (wantsHelp(argv.slice(3))) {
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
  // Fail here, with the four ways to fix it, rather than several seconds later
  // inside the model adapter with "@anthropic-ai/sdk is not installed".
  const explicitModel =
    flagValue(argv, "--model") !== undefined ||
    Boolean(process.env.BETTERWRIGHT_MODEL) ||
    Boolean(modelOptions.baseURL);
  if (!explicitModel) {
    const hint = modelSetupHint();
    if (hint) {
      console.error(hint);
      return 1;
    }
  }
  const session = sessionName(flagValue(argv, "--session", "default"));
  const fresh = flags.has("--fresh");
  const home = defaultDaemonHome();
  const onStep = ({ step, tool, note, url }) => {
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
  };

  let result;
  if (!daemonDisabled(flags)) {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
      config: daemonConfigFromFlags(flags),
    });
    if (outcome.ok) {
      let channel = outcome.channel;
      // Ctrl-C stops the agent instead of orphaning it: the run lives in the
      // daemon, so abandoning the CLI would leave it working (and spending)
      // with nobody watching. The second Ctrl-C gives up waiting.
      let interrupting = false;
      const onSigint = () => {
        if (interrupting) {
          process.stderr.write("\n  ! giving up on the interrupt; the run may still be stopping\n");
          process.exit(130);
        }
        interrupting = true;
        process.stderr.write("\n  ! stopping the run — the transcript is kept, so you can resume it\n");
        void interruptSession(channel, session, { wait: false });
      };
      process.on("SIGINT", onSigint);
      try {
        // The agent loop runs in the daemon, so the conversation and the
        // browser session both persist for the next exec in this session.
        result = await execTask(
          channel,
          {
            task,
            model,
            modelOptions,
            session,
            fresh,
            // --live-view starts the viewer at step 0 so the whole run can be
            // watched; without it the handoff tool still starts one on demand.
            liveView: liveViewCliOptions(argv),
          },
          {
            onStep,
            onNotice: (note) => process.stderr.write(`  ! ${note}\n`),
            // The run belongs to the daemon, not to this socket. If the pipe
            // breaks mid-task, get back to the same run rather than losing it.
            reconnect: async () => {
              const again = await connectSessionDaemon({
                cliPath: CLI_PATH,
                config: daemonConfigFromFlags(flags),
                spawnIfNeeded: false,
                ignoreMismatch: true,
              });
              if (!again.ok) return null;
              channel = again.channel;
              return channel;
            },
          },
        );
        if (flags.has("--close")) {
          await channel
            .request({ op: "close_session", session }, 60_000)
            .catch(() => {});
        }
      } catch (error) {
        // Config problems (missing credentials, missing SDK) read better as a
        // plain line than a stack trace.
        console.error(error?.message || String(error));
        if (/connection closed|did not answer/i.test(String(error?.message || ""))) {
          console.error(`  the daemon's log may say why: ${daemonLogPath(home, cliProfile())}`);
        }
        return 1;
      } finally {
        process.off("SIGINT", onSigint);
        channel.end();
      }
    } else {
      process.stderr.write(
        `  ! session persistence unavailable (${outcome.reason}); running one-shot\n`,
      );
    }
  }
  if (!result) {
    // No daemon (disabled or unavailable): one-shot browser, exactly the
    // pre-daemon behavior — but the transcript still persists on disk, so
    // the next exec resumes the conversation even without live tabs.
    const { runAgentTask } = await import("../src/agent.js");
    if (fresh) clearTranscript(home, session, cliProfile());
    const history = fresh ? [] : loadTranscript(home, session, cliProfile());
    const policy = await policyFromFlags(flags);
    try {
      const full = await runAgentTask({
        task,
        model,
        modelOptions,
        session,
        history,
        policy,
        headless: !flags.has("--headed"),
        // The same identity the daemon would have used, so a one-shot exec
        // sees the same logins instead of silently acting as the default.
        ...(cliProfile() ? { profile: cliProfile() } : {}),
        liveView: liveViewCliOptions(argv),
        onStep,
      });
      saveTranscript(home, session, full.transcript, {}, cliProfile());
      const { transcript: _transcript, ...summary } = full;
      result = { ...summary, session, resumedMessages: history.length };
    } catch (error) {
      console.error(error?.message || String(error));
      return 1;
    }
  }
  process.stderr.write(
    `  done in ${result.steps} step${result.steps === 1 ? "" : "s"}, ` +
      `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}, ` +
      `${formatDuration(result.durationMs)}, ${formatAgentUsage(result.usage)}` +
      (result.resumedMessages
        ? ` · resumed session "${result.session}" (${result.resumedMessages} prior messages)`
        : "") +
      "\n",
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
        session: result.session,
      },
      null,
      2,
    ),
  );
  return result.ok ? 0 : 1;
}

// `close [--session <name> | --all]` / `sessions`: manage the session daemon.
// Management ops talk to whatever daemon is running (any version/config) and
// never spawn one.
async function cmdClose(flags, rest) {
  // `--all` means the whole home — every profile's daemon. Anything narrower
  // targets the profile this invocation selected, so closing one identity's
  // session never disturbs another's.
  if (flags.has("--all")) {
    const daemons = await connectRunningDaemons(defaultDaemonHome());
    if (!daemons.length) {
      console.log("No session daemon is running — nothing to close.");
      return 0;
    }
    let closedSessions = 0;
    for (const { profile, channel, hello } of daemons) {
      try {
        const names = (hello.sessions || []).map((entry) => entry.name);
        for (const name of names) {
          await channel.request({ op: "close_session", session: name }, 60_000).catch(() => {});
        }
        await channel.request({ op: "shutdown" }, 10_000).catch(() => {});
        closedSessions += names.length;
        if (daemons.length > 1) {
          console.log(
            `Profile ${profileLabel(hello.profile ?? profile)}: closed ${names.length} session${names.length === 1 ? "" : "s"}.`,
          );
        }
      } finally {
        channel.end();
      }
    }
    const daemonWord = `${daemons.length} browser daemon${daemons.length === 1 ? "" : "s"}`;
    console.log(
      closedSessions
        ? `Closed ${closedSessions} session${closedSessions === 1 ? "" : "s"} and stopped ${daemonWord}.`
        : `Stopped ${daemonWord} (no sessions were open).`,
    );
    return 0;
  }
  const outcome = await connectSessionDaemon({
    cliPath: CLI_PATH,
    profile: cliProfile(),
    spawnIfNeeded: false,
    ignoreMismatch: true,
  });
  if (!outcome.ok) {
    console.log(
      cliProfile()
        ? `No session daemon is running for profile ${profileLabel(cliProfile())} — nothing to close.`
        : "No session daemon is running — nothing to close.",
    );
    return 0;
  }
  const { channel } = outcome;
  try {
    const positional = rest.filter((token) => !token.startsWith("-"));
    const session = sessionName(
      flagValue(process.argv, "--session", positional[0] || "default"),
    );
    const closed = await channel.request({ op: "close_session", session }, 60_000);
    console.log(
      closed?.closed
        ? `Closed session "${session}"${closed.pagesClosed ? ` (${closed.pagesClosed} tab${closed.pagesClosed === 1 ? "" : "s"})` : ""}.`
        : `Session "${session}" was not open.`,
    );
    return 0;
  } finally {
    channel.end();
  }
}

/**
 * Every profile that might have a daemon in this home: the ones that left an
 * info file, plus the profile this invocation asked for (it may be starting
 * up, or its info file may have been cleaned away). Default first, no repeats.
 */
function daemonProfilesToInspect(home) {
  const found = daemonProfilesInHome(home);
  const wanted = cliProfile();
  const all = [...found, ...(found.includes(wanted) ? [] : [wanted])];
  return [...new Set(all)].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
}

/** Connect to each profile's daemon in this home; skip the ones not running. */
async function connectRunningDaemons(home) {
  const connected = [];
  for (const profile of daemonProfilesToInspect(home)) {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
      profile,
      spawnIfNeeded: false,
      ignoreMismatch: true,
    });
    if (outcome.ok) connected.push({ profile, ...outcome });
  }
  return connected;
}

async function cmdSessions() {
  const home = defaultDaemonHome();
  // Sessions is a home-wide inventory: a daemon per profile means "what is
  // running here" has to look at all of them, or a named profile's live
  // sessions would be invisible and look like a leak.
  const daemons = await connectRunningDaemons(home);
  if (!daemons.length) {
    console.log("No session daemon is running.");
    return 0;
  }
  const { dim } = styler();
  for (const { profile, channel, hello } of daemons) {
    channel.end();
    console.log(
      dim(
        `daemon pid ${hello.pid} · v${hello.version} · profile ${profileLabel(hello.profile ?? profile)} · ` +
          `up ${formatDuration(hello.uptimeMs || 0)} · ` +
          `${hello.runs?.active || 0} run(s) active of ${hello.runs?.started || 0} started · ` +
          `sessions idle out after ${formatDuration(hello.ttlMs || 0)}`,
      ),
    );
    if (!hello.sessions?.length) {
      console.log("No open sessions.");
      continue;
    }
    for (const entry of hello.sessions) {
      const marks = [
        entry.running ? `running (${entry.watchers} watcher${entry.watchers === 1 ? "" : "s"})` : "",
        entry.inflight ? `${entry.inflight} call(s) in flight` : "",
      ].filter(Boolean);
      console.log(
        `${entry.name.padEnd(20)} idle ${formatDuration(entry.idleMs)}${marks.length ? ` · ${marks.join(" · ")}` : ""}`,
      );
    }
  }
  return 0;
}

/**
 * Foreground commands that need the persistent profile themselves (the
 * interactive console, `view`) reclaim it from an idle daemon first; a busy
 * daemon is left alone and the command falls back to an ephemeral profile
 * with the worker's usual warning.
 */
// Take the persistent profile back from an idle daemon before launching a
// private browser on it. Scoped to the profile this invocation wants: a daemon
// holding a *different* profile owns a different lock and a different cookie
// jar, so shutting it down would close another identity's live sessions for no
// benefit at all.
async function reclaimDaemonProfile() {
  try {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
      profile: cliProfile(),
      spawnIfNeeded: false,
      ignoreMismatch: true,
    });
    if (!outcome.ok) return { reclaimed: true, closedSessions: 0 };
    const { channel, hello } = outcome;
    const sessions = Array.isArray(hello.sessions) ? hello.sessions : [];
    if (sessions.some((entry) => entry.inflight > 0)) {
      channel.end();
      return { reclaimed: false, busy: true };
    }
    for (const entry of sessions) {
      await channel
        .request({ op: "close_session", session: entry.name }, 60_000)
        .catch(() => {});
    }
    await channel.request({ op: "shutdown" }, 10_000).catch(() => {});
    channel.end();
    return { reclaimed: true, closedSessions: sessions.length };
  } catch {
    return { reclaimed: true, closedSessions: 0 };
  }
}

async function cmdModels(flags) {
  const {
    listEndpointModels,
    modelSelectionChoices,
    nativeModelCatalog,
  } = await import("../src/agent.js");
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

/**
 * Print live-view reachability / security lines shared by daemon-attach and
 * private-browser view paths.
 */
function printLiveViewBanner(view, { dim, bold, attached = false }: any = {}) {
  console.log(`${bold("Live view:")} ${view.url}`);
  if (attached) {
    console.log(dim("attached to the session daemon (same tabs as run/exec)"));
  }
  // Which identity is on screen — invisible otherwise, and the reason a viewer
  // may be looking at a signed-out browser they did not expect.
  if (cliProfile()) console.log(dim(`profile ${profileLabel(cliProfile())}`));
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
  console.log(
    dim(
      attached
        ? "The URL embeds a capability token — treat it like a password. Ctrl-C detaches (session stays up)."
        : "The URL embeds a capability token — treat it like a password. Ctrl-C to stop.",
    ),
  );
}

// `view`: open a live, token-gated web view and hold it until Ctrl-C.
// Prefer attaching to the session daemon when one is (or can be) running so
// mid-session `view` shows the same tabs as `run`/`exec`/`skill` agents —
// without reclaiming the profile or starting a blank ephemeral browser.
// Fallback: private in-process browser (remote-desktop warm-up shape).
async function cmdView(flags) {
  if (flags.has("--set-password") || flags.has("--clear-password")) {
    return cmdViewPassword(flags);
  }
  const argv = process.argv;
  const { dim, bold } = styler();
  // Same host resolution as `exec --live-view` so view/exec behave alike.
  const liveOpts = liveViewCliOptions(argv, { required: true });
  const session = flagValue(argv, "--session", "default");

  // Daemon attach first (unless --no-daemon): works while a session is mid-task.
  if (!daemonDisabled(flags)) {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
      config: daemonConfigFromFlags(flags),
      spawnIfNeeded: true,
    });
    if (outcome.ok) {
      const browser = createDaemonBrowser(outcome.channel, { session });
      let startedHere = false;
      try {
        const view = await browser.startLiveView({
          ...liveOpts,
          session,
        });
        if (!view?.ok || !view.url) {
          console.error(view?.error || "The live view failed to start.");
          return 1;
        }
        startedHere = !view.alreadyRunning;
        // Nudge a blank tab so the canvas is not empty on first open.
        await browser.run(
          "if (page.url() === 'about:blank') await page.goto('about:blank'); 'ready'",
        );
        printLiveViewBanner(view, { dim, bold, attached: true });
        await new Promise((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        return 0;
      } finally {
        // Leave a pre-existing viewer alone; stop only one we opened so Ctrl-C
        // does not yank a URL the agent already handed the human mid-task.
        if (startedHere) {
          try {
            await browser.stopLiveView();
          } catch {
            /* best effort */
          }
        }
        await browser.close();
      }
    }
  }

  // Private browser fallback: reclaim idle daemon profile when possible.
  const reclaim = await reclaimDaemonProfile();
  if (reclaim.busy) {
    console.log(
      dim("a background session is mid-task; this view gets a temporary profile (betterwright close --all to reclaim)"),
    );
  }
  const browser = await makeBrowser(flags);
  try {
    const view = await browser.startLiveView({
      ...liveOpts,
      session,
    });
    if (!view.ok || !view.url) {
      console.error(view.error || "The live view failed to start.");
      return 1;
    }
    await browser.run("if (page.url() === 'about:blank') await page.goto('about:blank'); 'ready'");
    printLiveViewBanner(view, { dim, bold, attached: false });
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
    "../src/auth.js"
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
  const { listSkills, readSkill } = await import("../src/skills.js");
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
  // A bad `--profile` should read as one clear line before anything launches,
  // not as a TypeError stack from inside a browser constructor. Help and
  // --version still answer, so `--help` never depends on valid flags.
  if (!wantsHelp(tokens) && !flags.has("--version")) {
    try {
      cliProfile();
    } catch (error) {
      // Name where the bad value came from: an MCP host debugging a server
      // that will not start needs to know it is the environment, not a flag.
      const source =
        flagValue(process.argv, "--profile") === undefined ? "BETTERWRIGHT_PROFILE" : "--profile";
      console.error(`${source}: ${error?.message || error}`);
      return 1;
    }
  }
  // No subcommand (nothing, or only flags like `betterwright --headed`): launch
  // the interactive agent console. `--version`/`--help` are still honored.
  if (!first || first.startsWith("-")) {
    if (flags.has("--version") || tokens.includes("-v")) {
      console.log(require("../../package.json").version);
      return 0;
    }
    if (wantsHelp(tokens)) {
      console.log(MAIN_USAGE);
      return 0;
    }
    return cmdInteractive(flags);
  }
  const command = first;
  const rest = tokens.slice(1);
  const positional = firstPositional(rest);
  // Asking a command what it does must never be the thing that does it:
  // `setup --help` used to download a browser and `run --help` blocked on
  // stdin forever. Help is resolved before any command runs.
  //
  // `exec` and `vault` are excluded because they own their own help text —
  // exec's lives beside its flag parsing, vault's beside its subcommands.
  if (wantsHelp(rest) && !["exec", "vault"].includes(command)) {
    console.log(helpFor(command));
    return 0;
  }
  if (command === "help") {
    // `exec` and `vault` keep their help beside their own argument parsing, so
    // route to them rather than duplicating the text in the help table.
    if (positional === "vault") {
      const { VAULT_USAGE } = await import("../src/vault-cli.js");
      console.log(VAULT_USAGE);
      return 0;
    }
    if (positional === "exec") {
      console.log(EXEC_USAGE);
      return 0;
    }
    console.log(positional ? helpFor(positional) : MAIN_USAGE);
    return 0;
  }
  switch (command) {
    case "init":
      return cmdInit(flags);
    case "setup":
      return cmdSetup(flags);
    case "update":
      return cmdUpdate(flags);
    case "doctor":
      return cmdDoctor(flags);
    case "vault": {
      const { runVaultCommand } = await import("../src/vault-cli.js");
      return runVaultCommand(rest);
    }
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
    case "close":
      return cmdClose(flags, rest);
    case "sessions":
      return cmdSessions();
    case "mcp": {
      // `--check` answers "why does my MCP client show no BetterWright tools?"
      // without needing the client: the two things that actually fail are a
      // missing SDK and a missing browser, and both are checkable here.
      if (flags.has("--check")) {
        const { mcpSdkAvailable } = await import("../src/onboard.js");
        const { profileFromEnv } = await import("../src/mcp-server.js");
        const sdk = await mcpSdkAvailable();
        console.log(sdk.ok ? "  ✓ MCP SDK available" : `  ✗ ${sdk.error}`);
        const report = await doctorReport();
        console.log(
          report.ready
            ? `  ✓ Browser ready (${report.browser})`
            : "  ✗ Browser not installed — run `betterwright setup`",
        );
        // An invalid BETTERWRIGHT_PROFILE already failed in main(), before any
        // of this ran. Confirm the valid one, so a client showing a signed-out
        // browser can be traced to the identity it was told to use.
        const profile = profileFromEnv();
        if (profile) console.log(`  ✓ Profile "${profile}"`);
        const ok = sdk.ok && report.ready;
        console.log("");
        console.log(
          ok
            ? "The MCP server can start. Register it with:\n  claude mcp add betterwright -- npx betterwright mcp"
            : "Fix the ✗ lines above, then re-run `betterwright mcp --check`.",
        );
        return ok ? 0 : 1;
      }
      const { runMcpServer } = await import("../src/mcp-server.js");
      await runMcpServer();
      return 0;
    }
    case "__daemon": {
      const { runSessionDaemon } = await import("../src/daemon.js");
      return runSessionDaemon(process.argv);
    }
    default:
      console.error(`Unknown command "${command}".\n\n${MAIN_USAGE}`);
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
