// Runtime resolution and readiness reporting shared by the CLI (`betterwright
// doctor`) and the MCP server's `browser_doctor` tool.
//
// The pinned versions here are the single Node-side source of truth;
// scripts/check-versions.mjs verifies them against package.json in CI.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadCodexAuth, loadGrokAuth } from "./auth.mjs";
import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  resolveChromiumForkBinary,
} from "./chromium-fork.mjs";
import { forkFontsDir } from "./fork-identity.mjs";
import { defaultHome } from "./home.mjs";
import { optionalPeerAvailable } from "./optional-peer.mjs";
import { staleAgentSkillReport } from "./skill-install.mjs";

const require = createRequire(import.meta.url);

export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";
export const PINNED_CLOAKBROWSER_VERSION = "0.4.10";

/** Version of the optional patchright-core stealth driver, or null if absent. */
export function stealthDriverVersion() {
  try {
    return require("patchright-core/package.json").version;
  } catch {
    return null;
  }
}

export function resolveCoreDir() {
  const override = (process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH || "").trim();
  if (override && fs.existsSync(path.join(override, "package.json"))) return override;
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

export function resolveCloakDir() {
  const override = (process.env.BETTERWRIGHT_CLOAKBROWSER_PATH || "").trim();
  if (override && fs.existsSync(path.join(override, "package.json"))) return override;
  try {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.resolve("cloakbrowser"))),
      "..",
    );
  } catch {
    return null;
  }
}

export async function cloakRuntime() {
  const dir = resolveCloakDir();
  const noBinary = { binaryVersion: null, tier: null, binary: null, installed: false };
  if (!dir) return { dir: null, version: null, ...noBinary };
  let version = null;
  try {
    version = require(path.join(dir, "package.json")).version;
  } catch {
    /* reported below */
  }
  try {
    const cloak = await import(pathToFileURL(path.join(dir, "dist", "index.js")).href);
    const info = cloak.binaryInfo();
    return {
      dir,
      version,
      binaryVersion: info.version || null,
      tier: info.tier || null,
      binary: info.binaryPath,
      installed: Boolean(info.installed),
    };
  } catch {
    return { dir, version, ...noBinary };
  }
}

/** Build the readiness report `betterwright doctor` prints. */
export async function doctorReport() {
  const core = resolveCoreDir();
  const cloak = await cloakRuntime();
  let version = null;
  if (core) {
    try {
      version = require(path.join(core, "package.json")).version;
    } catch {
      /* ignore */
    }
  }
  const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  const workerOk = fs.existsSync(worker);
  const cloakOk = cloak.version === PINNED_CLOAKBROWSER_VERSION && cloak.installed;
  const stealth = stealthDriverVersion();
  let chromiumFork = null;
  let chromiumForkError = null;
  try {
    chromiumFork = resolveChromiumForkBinary();
  } catch (error) {
    chromiumForkError = error instanceof Error ? error.message : String(error);
  }
  const browser = chromiumFork ? "chromium-fork" : "cloak";
  const chromiumForkFonts = chromiumFork ? forkFontsDir(chromiumFork) : null;
  const chromiumForkFontsWarning =
    chromiumFork && !chromiumForkFonts
      ? "fork binary has no fonts/ttf beside it; host fontconfig will leak (Linux tell). Deploy the macOS-metric font bundle next to chrome."
      : null;
  const ready =
    workerOk &&
    version === PINNED_PLAYWRIGHT_VERSION &&
    (chromiumFork ? true : cloakOk) &&
    !chromiumForkError;
  return {
    node: process.execPath,
    worker,
    worker_ok: workerOk,
    playwright_core: core,
    playwright_version: version,
    playwright_pinned: PINNED_PLAYWRIGHT_VERSION,
    cloakbrowser: cloak.dir,
    cloakbrowser_version: cloak.version,
    cloakbrowser_pinned: PINNED_CLOAKBROWSER_VERSION,
    cloakbrowser_binary_version: cloak.binaryVersion,
    cloakbrowser_binary_tier: cloak.tier,
    cloakbrowser_binary: cloak.binary,
    cloakbrowser_ok: cloakOk,
    chromium_fork: chromiumFork,
    chromium_fork_version: chromiumFork ? BETTERWRIGHT_CHROMIUM_VERSION : null,
    chromium_fork_error: chromiumForkError,
    chromium_fork_fonts: chromiumForkFonts,
    chromium_fork_fonts_warning: chromiumForkFontsWarning,
    stealth_driver: stealth,
    stealth_available: Boolean(stealth),
    browser,
    ready,
  };
}

// --- Human-readable readiness ---------------------------------------------
//
// doctorReport() above is the machine shape: a flat dictionary of resolved
// paths and versions, which `--json` still prints verbatim and the MCP
// browser_doctor tool returns. It is a poor thing to hand a person, though —
// it says `cloakbrowser_ok false` where what they need to know is "run
// betterwright setup". The checks below translate the same facts, plus the
// integration state doctorReport() has no reason to carry, into a grouped
// report where every failure names its fix.

// Deliberately `optionalPeerAvailable` and not a bare `require.resolve`: the
// latter only looks next to this file, so a global BetterWright never sees a
// project-local @anthropic-ai/sdk. The model adapter loads that peer via
// `importOptionalPeer`, which does look, and a report that disagrees with the
// loader tells the user to install a package they already installed — and,
// once `exec` started gating on this answer, refused to run a configuration
// that worked.
const moduleAvailable = optionalPeerAvailable;

/**
 * Which model backends could serve `betterwright exec` without more setup.
 *
 * `auth` is injectable so this is testable without the developer's own
 * ~/.codex and ~/.grok sign-ins deciding the answer.
 */
export function modelReadiness({ env = process.env, auth = null } = {}) {
  const codex = auth ? Boolean(auth.codex) : Boolean(loadCodexAuth());
  const grok = auth ? Boolean(auth.grok) : Boolean(loadGrokAuth());
  const sources = [];
  if (codex) sources.push("codex (signed in)");
  if (grok) sources.push("grok (signed in)");
  if (env.ANTHROPIC_API_KEY && moduleAvailable("@anthropic-ai/sdk")) {
    sources.push("claude (ANTHROPIC_API_KEY)");
  }
  if (env.OPENROUTER_API_KEY) sources.push("openrouter (OPENROUTER_API_KEY)");
  if (env.XAI_API_KEY || env.GROK_API_KEY) sources.push("grok (API key)");
  if (env.OPENAI_API_KEY) sources.push("codex (OPENAI_API_KEY)");
  const anthropicKeyNoSdk =
    Boolean(env.ANTHROPIC_API_KEY) && !moduleAvailable("@anthropic-ai/sdk");
  return { sources, anthropicKeyNoSdk };
}

/**
 * The model id to use when the user named none.
 *
 * The old default was a fixed `claude-opus-4-8`, which needs both an API key
 * and the optional @anthropic-ai/sdk peer. A new user who signed in with
 * `auth --login codex` — the sign-in the README recommends first — therefore
 * hit "@anthropic-ai/sdk is not installed" on their first task, with a working
 * backend sitting right there. Prefer whatever is actually configured, and
 * fall back to the historical default so behaviour is unchanged for anyone who
 * has the Anthropic path set up.
 *
 * @returns {{model: string, reason: string, configured: boolean}}
 */
export function preferredModelId({ env = process.env, auth = null } = {}) {
  const codex = auth ? Boolean(auth.codex) : Boolean(loadCodexAuth());
  const grok = auth ? Boolean(auth.grok) : Boolean(loadGrokAuth());
  if (env.ANTHROPIC_API_KEY && moduleAvailable("@anthropic-ai/sdk")) {
    return { model: "claude-opus-4-8", reason: "ANTHROPIC_API_KEY", configured: true };
  }
  if (codex) {
    return {
      model: env.BETTERWRIGHT_CODEX_MODEL || "gpt-5.6-sol",
      reason: "signed in with `auth --login codex`",
      configured: true,
    };
  }
  if (grok) {
    return {
      model: env.BETTERWRIGHT_GROK_MODEL || env.XAI_MODEL || "grok-4.3",
      reason: "signed in with `auth --login grok`",
      configured: true,
    };
  }
  // A bare `gpt-…`/`grok-…` id resolves to the native codex/grok adapter, and
  // those adapters accept a plain API key as readily as an OAuth sign-in. Not
  // honouring the key here is what made `exec` refuse a setup that worked.
  if (env.OPENAI_API_KEY) {
    return {
      model: env.BETTERWRIGHT_CODEX_MODEL || "gpt-5.6-sol",
      reason: "OPENAI_API_KEY",
      configured: true,
    };
  }
  if (env.XAI_API_KEY || env.GROK_API_KEY) {
    return {
      model: env.BETTERWRIGHT_GROK_MODEL || env.XAI_MODEL || "grok-4.3",
      reason: "XAI_API_KEY",
      configured: true,
    };
  }
  // OpenRouter, Ollama, and vLLM have no bare-id default — a model there has
  // to be named `source/id` — so they are usable but cannot supply a default.
  return { model: "claude-opus-4-8", reason: "default", configured: false };
}

/** One line telling the user how to get a usable model, or null when fine. */
export function modelSetupHint({ env = process.env, auth = null } = {}) {
  if (preferredModelId({ env, auth }).configured) return null;
  const { sources } = modelReadiness({ env, auth });
  if (sources.length) {
    // doctor just told this user their backends are fine, and they are — the
    // gap is only that these sources have no default id. Saying "no model
    // backend is configured" here would be false and would leave them stuck.
    return (
      `A model backend is available (${sources.join(", ")}), but those sources have no default model id.\n` +
      "  Name one:  --model openrouter/<id>   (or ollama/<id>, vllm/<id>)\n" +
      "  List them: betterwright models"
    );
  }
  return (
    "No model backend is configured yet, so a task cannot run.\n" +
    "  Sign in:  betterwright auth --login codex     (a ChatGPT/Codex subscription)\n" +
    "        or:  betterwright auth --login grok\n" +
    "        or:  export ANTHROPIC_API_KEY=… && npm install -g @anthropic-ai/sdk\n" +
    "  Local:    run Ollama, then --model ollama/<id>   (see `betterwright models`)"
  );
}

/**
 * Group the report, the installed agent integrations, and model/vault state
 * into `{group, label, status, detail, fix}` rows.
 * @param {object} report a doctorReport() result
 */
export function doctorChecks(report, { home = defaultHome(), env = process.env } = {}) {
  const checks = [];
  const add = (group, label, status, detail, fix) =>
    checks.push({ group, label, status, detail, ...(fix ? { fix } : {}) });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(
    "Runtime",
    "Node",
    nodeMajor >= 22 ? "ok" : "fail",
    `v${process.versions.node}`,
    nodeMajor >= 22 ? null : "BetterWright needs Node 22+. Install it from https://nodejs.org",
  );
  add(
    "Runtime",
    "Playwright",
    report.playwright_version === report.playwright_pinned ? "ok" : "fail",
    report.playwright_version
      ? `${report.playwright_version} (pinned ${report.playwright_pinned})`
      : "not installed",
    report.playwright_version === report.playwright_pinned
      ? null
      : "Reinstall betterwright so its pinned playwright-core matches.",
  );
  add("Runtime", "Worker", report.worker_ok ? "ok" : "fail", report.worker, report.worker_ok ? null : "The package looks incomplete — reinstall betterwright.");

  if (report.chromium_fork) {
    add("Browser", "Chromium fork", "ok", `${report.chromium_fork_version} — the default on this platform`);
    if (report.chromium_fork_fonts_warning) {
      add("Browser", "Fork fonts", "warn", report.chromium_fork_fonts_warning);
    }
  } else if (report.chromium_fork_error) {
    add("Browser", "Chromium fork", "fail", report.chromium_fork_error, "Run `betterwright update`, or unset BETTERWRIGHT_CHROMIUM_PATH/ROOT.");
  } else {
    add("Browser", "Chromium fork", "warn", "not installed — using CloakBrowser", "Run `betterwright update` for the fork (macOS arm64 / Linux x64 only).");
  }
  add(
    "Browser",
    "CloakBrowser",
    report.cloakbrowser_ok ? "ok" : report.chromium_fork ? "warn" : "fail",
    report.cloakbrowser_ok
      ? `${report.cloakbrowser_binary_version} (${report.cloakbrowser_binary_tier})` +
        (report.cloakbrowser_binary ? ` — ${report.cloakbrowser_binary}` : "")
      : "binary not installed",
    report.cloakbrowser_ok ? null : "Run `betterwright setup` to download it.",
  );
  add("Browser", "In use", report.ready ? "ok" : "fail", report.browser, report.ready ? null : "Run `betterwright setup`.");
  // Optional isolated-world stealth driver. Reported here (not only in --json)
  // because the docs point users at `doctor` to check it before turning on
  // `stealthRuntimeFix`.
  add(
    "Browser",
    "Stealth driver",
    report.stealth_available ? "ok" : "warn",
    report.stealth_available
      ? `patchright-core ${report.stealth_driver} (enable with --stealth)`
      : "not installed — --stealth / stealthRuntimeFix unavailable",
    report.stealth_available ? null : "Optional: npm install patchright-core",
  );

  const stale = staleAgentSkillReport({ home: os.homedir() });
  const installed = [];
  for (const relative of [
    [".claude/skills/browser/SKILL.md", "Claude Code"],
    [".agents/skills/browser/SKILL.md", "Agent Skills"],
    [".cursor/skills/browser/SKILL.md", "Cursor"],
  ]) {
    if (fs.existsSync(path.join(os.homedir(), relative[0]))) installed.push(relative[1]);
  }
  const codexFile = path.join(os.homedir(), ".codex", "AGENTS.md");
  if (fs.existsSync(codexFile)) {
    try {
      // Match the managed marker, not the bare word: a file that says
      // "don't use betterwright" is not an install.
      if (/<!-- betterwright:begin/.test(fs.readFileSync(codexFile, "utf8"))) {
        installed.push("Codex");
      }
    } catch {
      /* unreadable is not a failure of ours */
    }
  }
  add(
    "Agent integration",
    "Installed for",
    installed.length ? (stale.length ? "warn" : "ok") : "warn",
    installed.length ? installed.join(", ") : "no agent host wired up yet",
    installed.length
      ? stale.length
        ? "A skill file is from an older version — run `betterwright skill --install`."
        : null
      : "Run `betterwright init` to wire up the agents on this machine.",
  );
  add(
    "Agent integration",
    "MCP SDK",
    moduleAvailable("@modelcontextprotocol/sdk/package.json") ? "ok" : "warn",
    moduleAvailable("@modelcontextprotocol/sdk/package.json")
      ? "available — `betterwright mcp` can serve"
      : "not installed (only needed for the MCP path)",
    moduleAvailable("@modelcontextprotocol/sdk/package.json")
      ? null
      : "npm install -g @modelcontextprotocol/sdk",
  );

  const models = modelReadiness({ env });
  add(
    "Built-in agent",
    "Model backends",
    models.sources.length ? "ok" : "warn",
    models.sources.length ? models.sources.join(", ") : "none configured",
    models.sources.length
      ? null
      : "Only needed for `betterwright exec`. Run `betterwright auth --login codex`, or set ANTHROPIC_API_KEY.",
  );
  if (models.anthropicKeyNoSdk) {
    add(
      "Built-in agent",
      "Anthropic SDK",
      "warn",
      "ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed",
      "npm install -g @anthropic-ai/sdk",
    );
  }

  const vaultData = path.join(home, "vault", "vault.enc");
  add(
    "Credentials",
    "Vault",
    "ok",
    fs.existsSync(vaultData)
      ? `${path.join(home, "vault")} — read it with \`betterwright vault list\``
      : "no passwords saved yet (it fills itself as you log in)",
  );

  return checks;
}

const STATUS_MARK = { ok: "✓", warn: "!", fail: "✗" };

/** Render doctorChecks() rows as the text `betterwright doctor` prints. */
export function formatDoctorChecks(checks, { quiet = false } = {}) {
  const lines = [];
  let group = null;
  for (const check of checks) {
    if (quiet && check.status === "ok") continue;
    if (check.group !== group) {
      group = check.group;
      if (lines.length) lines.push("");
      lines.push(group);
    }
    lines.push(`  ${STATUS_MARK[check.status]} ${`${check.label}:`.padEnd(16)} ${check.detail}`);
    if (check.fix) lines.push(`      → ${check.fix}`);
  }
  return lines.join("\n");
}
