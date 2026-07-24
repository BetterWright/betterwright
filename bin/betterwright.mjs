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
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatAgentUsage } from "../src/agent-usage.mjs";
import { installChromiumFork } from "../src/chromium-fork-install.mjs";
import {
  createInteractiveBrowserLifecycle,
  formatHangingText,
  makeLineReader,
  readExecTaskFromStdin,
} from "../src/cli-io.mjs";
import { defaultDaemonHome, sessionName } from "../src/daemon.mjs";
import {
  connectSessionDaemon,
  createDaemonBrowser,
  daemonDisabled,
  execTask,
} from "../src/daemon-client.mjs";
import { doctorReport, resolveCloakDir, resolveCoreDir } from "../src/doctor.mjs";
import { agentSystemPrompt, BetterWright, NetworkPolicy } from "../src/index.mjs";
import {
  clearTranscript,
  loadTranscript,
  saveTranscript,
} from "../src/session-store.mjs";
import {
  installAgentSkills,
  packageVersion,
  refreshInstalledAgentSkills,
  staleAgentSkillReport,
  staleAgentSkillTip,
  wrapClaudeSkillMarkdown,
} from "../src/skill-install.mjs";

const require = createRequire(import.meta.url);
const CLI_PATH = fileURLToPath(import.meta.url);

/**
 * Live-view options for CLI `--live-view` / `view`. Only explicit CLI/env
 * values are returned, so persisted setup choices remain authoritative. The
 * library's no-config default is loopback.
 */
function liveViewCliOptions(argv = process.argv, { required = false } = {}) {
  const has = (name) => argv.some((token) => token === name || token.startsWith(`${name}=`));
  if (!required && !has("--live-view")) return undefined;
  const out = { interactive: !has("--watch-only") };
  const hostValue = flagValue(argv, "--host", process.env.BETTERWRIGHT_LIVE_VIEW_HOST);
  const portValue = flagValue(argv, "--port", process.env.BETTERWRIGHT_LIVE_VIEW_PORT);
  const publicHostValue = flagValue(
    argv,
    "--public-host",
    process.env.BETTERWRIGHT_LIVE_VIEW_PUBLIC_HOST,
  );
  let expose = String(
    flagValue(argv, "--expose", process.env.BETTERWRIGHT_LIVE_VIEW_EXPOSE || ""),
  )
    .trim()
    .toLowerCase();
  let mode = String(
    flagValue(
      argv,
      "--live-view-mode",
      flagValue(argv, "--transport", process.env.BETTERWRIGHT_LIVE_VIEW_TRANSPORT || ""),
    ),
  )
    .trim()
    .toLowerCase();
  if (expose === "relay") {
    mode = "relay";
    expose = "";
  }
  if (["local", "lan", "tailscale"].includes(mode)) {
    expose = mode;
    mode = "direct";
  }
  if (mode && !["direct", "relay"].includes(mode)) {
    throw new Error(
      `Unknown live-view mode "${mode}"; use relay, local, lan, tailscale, or direct.`,
    );
  }
  if (hostValue != null && hostValue !== "") {
    out.host = String(hostValue);
    if (expose) {
      process.stderr.write("--host overrides --expose; ignoring --expose.\n");
      expose = "";
    }
    if (!mode) mode = "direct";
  }
  if (portValue != null && portValue !== "") out.port = Number(portValue) || 0;
  if (publicHostValue != null && publicHostValue !== "") out.publicHost = String(publicHostValue);
  if (expose) out.expose = expose;
  if (mode) out.transport = mode;
  // The password comes from config.json or env, never a flag.
  const password = String(process.env.BETTERWRIGHT_LIVE_VIEW_PASSWORD || "");
  if (password) out.password = password;
  return out;
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

async function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

const LIVE_VIEW_SETUP_MODES = new Set(["relay", "local", "lan", "tailscale"]);

async function configureLiveView(flags, { allowUnconfigured = false } = {}) {
  const { saveLiveViewSettings } = await import("../src/live-view-config.mjs");
  const {
    BETTERWRIGHT_ACCOUNT_URL,
    loadAccountConfig,
    saveAccountApiKey,
    verifyBetterWrightApiKey,
  } = await import("../src/account-config.mjs");
  const argv = process.argv;
  let mode = String(
    flagValue(
      argv,
      "--live-view-mode",
      flagValue(argv, "--transport", process.env.BETTERWRIGHT_LIVE_VIEW_TRANSPORT || ""),
    ),
  )
    .trim()
    .toLowerCase();
  if (mode === "direct") {
    mode = String(
      flagValue(argv, "--expose", process.env.BETTERWRIGHT_LIVE_VIEW_EXPOSE || "local"),
    )
      .trim()
      .toLowerCase();
  }
  const canPrompt = process.stdin.isTTY && process.stdout.isTTY && !flags.has("--non-interactive");
  if (!mode && canPrompt) {
    console.log("\nLive View sharing");
    console.log("  1  BetterWright Relay  recommended · works anywhere · hides your host IP");
    console.log("  2  This computer only  loopback, nothing shared");
    console.log("  3  Local network       reachable on the same LAN/Wi-Fi");
    console.log("  4  Tailscale network   private to your tailnet");
    console.log("  5  Decide later        keep the safe loopback default");
    const answer = await promptLine("Choose [1]: ");
    mode = ({ "": "relay", "1": "relay", "2": "local", "3": "lan", "4": "tailscale", "5": "local" })[answer] || answer;
  }
  if (!mode) return { ok: true, configured: false };
  if (!LIVE_VIEW_SETUP_MODES.has(mode)) {
    return {
      ok: false,
      error: `Unknown live-view mode "${mode}"; use relay, local, lan, or tailscale.`,
    };
  }
  if (mode === "relay") {
    const account = loadAccountConfig();
    let apiKey = account.apiKey || "";
    let persistApiKey = false;
    if (!apiKey && flags.has("--api-key-stdin")) {
      apiKey = fs.readFileSync(0, "utf8").trim();
      persistApiKey = true;
    }
    if (!apiKey && canPrompt) {
      console.log(`\nCreate a personal API key at ${BETTERWRIGHT_ACCOUNT_URL}`);
      console.log("The key is stored only in ~/.betterwright/account.json with mode 0600.");
      apiKey = String(await promptHidden("Paste BetterWright API key: ")).trim();
      persistApiKey = Boolean(apiKey);
    }
    if (!apiKey) {
      const error =
        `Managed relay requires a BetterWright account API key. Create one at ${BETTERWRIGHT_ACCOUNT_URL}, then run \`betterwright account set-key\`.`;
      return allowUnconfigured
        ? { ok: true, configured: false, mode: "local", warning: `${error} Keeping the safe local default.` }
        : { ok: false, configured: false, error };
    }
    const checked = await verifyBetterWrightApiKey(apiKey, { relayUrl: account.relayUrl });
    if (!checked.ok) {
      if (allowUnconfigured) {
        return {
          ok: true,
          configured: false,
          warning:
            `${checked.error} Browser setup completed and Live View settings were left unchanged; ` +
            "the safe no-config default is local-only.",
        };
      }
      return checked;
    }
    // A key supplied through BETTERWRIGHT_API_KEY remains environment-only;
    // only a value explicitly pasted/piped here is persisted.
    if (persistApiKey) saveAccountApiKey(apiKey, { relayUrl: account.relayUrl });
    const file = saveLiveViewSettings({ transport: "relay", expose: "local" });
    return { ok: true, configured: true, mode, file, quota: checked.quota };
  }
  const file = saveLiveViewSettings({ transport: "direct", expose: mode });
  return { ok: true, configured: true, mode, file };
}

async function cmdAccount(rest, flags) {
  const {
    BETTERWRIGHT_ACCOUNT_URL,
    accountConfigPath,
    clearAccountConfig,
    loadAccountConfig,
    maskBetterWrightApiKey,
    saveAccountApiKey,
    verifyBetterWrightApiKey,
  } = await import("../src/account-config.mjs");
  const action = firstPositional(rest) || "status";
  if (action === "logout" || action === "clear") {
    const file = clearAccountConfig();
    console.log(`BetterWright account API key removed (${file}).`);
    return 0;
  }
  if (action === "set-key" || action === "login") {
    let apiKey = String(process.env.BETTERWRIGHT_API_KEY || "").trim();
    if (!apiKey && flags.has("--api-key-stdin")) apiKey = fs.readFileSync(0, "utf8").trim();
    if (!apiKey && process.stdin.isTTY) {
      console.log(`Create a personal key at ${BETTERWRIGHT_ACCOUNT_URL}`);
      apiKey = String(await promptHidden("Paste BetterWright API key: ")).trim();
    }
    if (!apiKey) {
      console.error("No API key provided. Set BETTERWRIGHT_API_KEY or use --api-key-stdin.");
      return 1;
    }
    const account = loadAccountConfig();
    const checked = await verifyBetterWrightApiKey(apiKey, { relayUrl: account.relayUrl });
    if (!checked.ok) {
      console.error(checked.error);
      return 1;
    }
    const file = saveAccountApiKey(apiKey, { relayUrl: account.relayUrl });
    console.log(`BetterWright account connected (${file}).`);
    if (checked.quota) {
      console.log(`Managed relay: ${Math.floor(Number(checked.quota.remainingSeconds || 0) / 60)} minutes remaining this week.`);
    }
    return 0;
  }
  if (action !== "status") {
    console.error("Usage: betterwright account [status | set-key | logout]");
    return 1;
  }
  const account = loadAccountConfig();
  if (!account.apiKey) {
    console.log(`Not connected. Create a key at ${BETTERWRIGHT_ACCOUNT_URL}`);
    return 1;
  }
  console.log(`Stored key: ${maskBetterWrightApiKey(account.apiKey)} (${account.source})`);
  console.log(`Credential file: ${accountConfigPath()}`);
  const checked = await verifyBetterWrightApiKey(account.apiKey, { relayUrl: account.relayUrl });
  if (!checked.ok) {
    console.error(checked.error);
    return 1;
  }
  console.log("Relay authentication: valid");
  if (checked.quota) {
    const remaining = Math.max(0, Number(checked.quota.remainingSeconds || 0));
    console.log(`Weekly allowance: ${Math.floor(remaining / 60)} minutes remaining · resets ${checked.quota.resetAt || "next Monday UTC"}`);
  }
  return 0;
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
  if (first.length < 8) {
    console.error("Password must be at least 8 characters.");
    return 1;
  }
  const second = await promptHidden("Repeat it: ");
  if (first !== second) {
    console.error("Passwords did not match — nothing saved.");
    return 1;
  }
  const file = saveLiveViewPassword(first);
  console.log(`Live-view password saved (hashed) to ${file}.`);
  console.log(dim("Direct live views now require it. Managed relay links use their private URL capability instead."));
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
  const tip = staleAgentSkillTip(staleAgentSkillReport());
  if (tip) console.log(`\n${tip}`);
  return report.ready ? 0 : 1;
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

  const liveViewSetup = await configureLiveView(flags, { allowUnconfigured: true });
  if (!liveViewSetup.ok) {
    console.error(`\nLive View setup failed: ${liveViewSetup.error}`);
    return 1;
  }
  if (liveViewSetup.configured) {
    console.log(`\nLive View mode: ${liveViewSetup.mode || "relay"}`);
  }
  if (liveViewSetup.warning) console.log(`\n${liveViewSetup.warning}`);

  console.log("\nSetup complete. Run `betterwright doctor` to confirm.");
  if (!cloakOnly) {
    console.log(
      "On macOS arm64 / Linux x64, doctor should report browser: chromium-fork after update/setup.",
    );
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
        cleanup: async ({ closeSession = false } = {}) => {
          try {
            if (closeSession)
              await channel.request({ op: "close_session", session }, 60_000);
          } finally {
            channel.end();
          }
        },
      };
    }
    const bw = new BetterWright({
      policy: policyFromFlags(flags),
      headless: !flags.has("--headed"),
      ...cloakingFromFlags(flags),
    });
    return {
      session,
      viaDaemon: false,
      warning: `session persistence unavailable (${outcome.reason}); this browser closes when the command exits`,
      browser: bw,
      cleanup: async () => bw.close(),
    };
  }
  const bw = new BetterWright({
    policy: policyFromFlags(flags),
    headless: !flags.has("--headed"),
    ...cloakingFromFlags(flags),
  });
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

Invocations share one persistent browser session held by a background daemon:
open tabs, page state, and the in-memory \`state\` object all survive between
\`run\` calls, and logins/cookies persist through the on-disk profile. So act in
small steps — one \`run\` per action-and-observe — and simply call \`run\` again to
continue where the last call left off. The session auto-closes after ~15 idle
minutes; run \`betterwright close\` when you finish a task to end it sooner.
Need isolation for parallel work? Give each worker its own \`--session <name>\`.

To batch several steps in one process you can also pipe blank-line-separated
snippets: \`printf '%s\\n\\n%s\\n' "snippetA" "snippetB" | betterwright repl\`
(same session, same persistence).

When a result lists \`skills\`, deeper site or provider knowledge matches the
open pages — read the named pack with \`betterwright skills show <name>\` before
improvising on that site. \`betterwright skills list\` shows what is available;
read the \`credential-manager\` pack before any login, signup, or checkout.

Live view and handoff work anytime mid-session — not only at the start. When
the user asks to watch, share the browser, open a live view, take over, or
hand off (MFA, resistant CAPTCHA, a step they must do themselves), do it now
with the surface you are on; do not restart the session or claim you cannot:

1. MCP integrated mode — call \`browser_handoff\` with action "start", relay the
   URL verbatim, keep working (watch) or wait on action "status" (takeover).
2. Standalone \`betterwright exec\` / interactive console — use the \`live_view\`
   tool to open a watch URL without pausing, or \`handoff\` to pause until they
   click Done. Interactive also accepts \`/live\` anytime.
3. Integrated CLI+skill (\`betterwright run\` / \`repl\`) — snippets cannot start
   the viewer (sealed). Run \`betterwright view\` (or have the user run it): it
   attaches to the same session daemon, prints a URL for the open tabs, and
   does not close them. Relay that URL; for takeover, tell them to use Take
   control / the dock, then wait for their "done" in chat before more \`run\`s.

Optional: \`exec "<task>" --live-view\` opens the viewer at step 0. Never claim
a live view is running unless a tool or \`betterwright view\` actually returned
its URL.

Network access is policy-guarded. Loopback and the private network are reachable
by default; add \`--block-private-network\` / \`--block-loopback\` to lock down, or
\`--allow-host <host>\` / \`--block-host <host>\` to adjust. Cloud-metadata endpoints
are always blocked.

Below, "\`run()\`" means "one \`betterwright run\` (or \`repl\`) snippet", and the
"approval-gated download tool" is \`betterwright run --approve-downloads\`: one
bounded download-enabled run, used only after the user explicitly approves.`;

function cmdSkill(flags) {
  const body = agentSkillBody();
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
  "--live-view-mode",
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
  "--transport",
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
         --live-view --fresh --close --no-daemon

Repeated execs continue the same session: the browser (tabs, logins) stays
live in a background daemon and the agent remembers the prior conversation.
--fresh starts the session over; --close ends it after this task.`;
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
  // Mutable: process --live-view starts a viewer at boot; `/live` enables the
  // same path mid-session so /new /headed /headless re-open it after replace.
  let interactiveLiveView = liveViewCliOptions(argv);
  const startInteractiveLiveView = async (browser, { quiet = false } = {}) => {
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
    dim(`model ${modelLabel()} · reasoning ${reasoningLabel()} · session ${session} · ${headless ? "headless" : "headed"}`),
  );
  console.log(dim("Type a task and press Enter. Follow-ups keep the session; /new starts fresh."));
  console.log(dim("While it works, type a message and press Enter to steer its next turn."));
  console.log(dim("/help for commands, /exit or Ctrl-D to quit.\n"));

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
      const { channel } = outcome;
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
          { onStep },
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
        return 1;
      } finally {
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
    const { runAgentTask } = await import("../src/agent.mjs");
    if (fresh) clearTranscript(home, session);
    const history = fresh ? [] : loadTranscript(home, session);
    try {
      const full = await runAgentTask({
        task,
        model,
        modelOptions,
        session,
        history,
        policy: policyFromFlags(flags),
        headless: !flags.has("--headed"),
        liveView: liveViewCliOptions(argv),
        onStep,
      });
      saveTranscript(home, session, full.transcript);
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
  const outcome = await connectSessionDaemon({
    cliPath: CLI_PATH,
    spawnIfNeeded: false,
    ignoreMismatch: true,
  });
  if (!outcome.ok) {
    console.log("No session daemon is running — nothing to close.");
    return 0;
  }
  const { channel, hello } = outcome;
  try {
    if (flags.has("--all")) {
      const names = (hello.sessions || []).map((entry) => entry.name);
      for (const name of names) {
        await channel.request({ op: "close_session", session: name }, 60_000).catch(() => {});
      }
      await channel.request({ op: "shutdown" }, 10_000).catch(() => {});
      console.log(
        names.length
          ? `Closed ${names.length} session${names.length === 1 ? "" : "s"} and stopped the browser daemon.`
          : "Stopped the browser daemon (no sessions were open).",
      );
      return 0;
    }
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

async function cmdSessions() {
  const outcome = await connectSessionDaemon({
    cliPath: CLI_PATH,
    spawnIfNeeded: false,
    ignoreMismatch: true,
  });
  if (!outcome.ok) {
    console.log("No session daemon is running.");
    return 0;
  }
  const { channel, hello } = outcome;
  channel.end();
  const { dim } = styler();
  console.log(
    dim(
      `daemon pid ${hello.pid} · v${hello.version} · sessions idle out after ${formatDuration(hello.ttlMs || 0)}`,
    ),
  );
  if (!hello.sessions?.length) {
    console.log("No open sessions.");
    return 0;
  }
  for (const entry of hello.sessions) {
    console.log(
      `${entry.name.padEnd(20)} idle ${formatDuration(entry.idleMs)}${entry.inflight ? ` · ${entry.inflight} call(s) in flight` : ""}`,
    );
  }
  return 0;
}

/**
 * Foreground commands that need the persistent profile themselves (the
 * interactive console, `view`) reclaim it from an idle daemon first; a busy
 * daemon is left alone and the command falls back to an ephemeral profile
 * with the worker's usual warning.
 */
async function reclaimDaemonProfile() {
  try {
    const outcome = await connectSessionDaemon({
      cliPath: CLI_PATH,
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

/**
 * Print live-view reachability / security lines shared by daemon-attach and
 * private-browser view paths.
 */
function printLiveViewBanner(view, { dim, bold, attached = false } = {}) {
  console.log(`${bold("Live view:")} ${view.url}`);
  if (attached) {
    console.log(dim("attached to the session daemon (same tabs as run/exec)"));
  }
  if (view.transport === "relay" || view.expose === "relay") {
    const remaining = Number(view.quota?.remainingSeconds);
    console.log(
      dim(
        `who can open it: anyone with the encrypted capability link · ${view.interactive ? "interactive" : "watch-only"} · host IP hidden`,
      ),
    );
    if (Number.isFinite(remaining)) {
      console.log(
        dim(
          `managed allowance: ${Math.max(0, Math.ceil(remaining / 60))} minutes left this week` +
            (view.quota?.resetAt ? ` · resets ${view.quota.resetAt}` : ""),
        ),
      );
    }
    console.log(dim("The # fragment holds the encryption key and is never sent to the relay. Treat the whole link like a password."));
    return;
  }
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
  const browser = new BetterWright({
    policy: policyFromFlags(flags),
    headless: !flags.has("--headed"),
    ...cloakingFromFlags(flags),
  });
  try {
    const view = await browser.startLiveView({
      ...liveOpts,
      session,
    });
    if (!view.ok || !view.url) {
      console.error(view.error || "The live view failed to start.");
      return 1;
    }
    await browser.run(
      "if (page.url() === 'about:blank') await page.goto('about:blank'); 'ready'",
      { session },
    );
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

async function cmdConfigure(rest, flags) {
  const target = firstPositional(rest);
  if (target !== "live-view") {
    console.error("Usage: betterwright configure live-view [--live-view-mode relay|local|lan|tailscale]");
    return 1;
  }
  const outcome = await configureLiveView(flags);
  if (!outcome.ok) {
    console.error(outcome.error);
    return 1;
  }
  if (!outcome.configured) {
    console.error("No mode selected. Pass --live-view-mode in a non-interactive shell.");
    return 1;
  }
  console.log(`Live View mode saved: ${outcome.mode || "relay"}`);
  if (outcome.warning) console.log(outcome.warning);
  return 0;
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
        "Usage: betterwright [interactive] | <setup|update|doctor|run|repl|exec|sessions|close|models|view|account|configure|auth|skill|skills|mcp> [options]\n" +
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
    case "account":
      return cmdAccount(rest, flags);
    case "configure":
      return cmdConfigure(rest, flags);
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
      const { runMcpServer } = await import("../src/mcp-server.mjs");
      await runMcpServer();
      return 0;
    }
    case "__daemon": {
      const { runSessionDaemon } = await import("../src/daemon.mjs");
      return runSessionDaemon(process.argv);
    }
    default:
      console.error(
        "Usage: betterwright [interactive] | <setup|update|doctor|run|repl|exec|sessions|close|models|view|account|configure|auth|skill|skills|mcp> [options]\n" +
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
