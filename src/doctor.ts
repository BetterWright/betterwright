// Runtime resolution and readiness reporting shared by the CLI (`betterwright
// doctor`) and the MCP server's `browser_doctor` tool.
//
// The pinned versions here are the single source of truth;
// scripts/check-versions.ts verifies them against package.json in CI.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCodexAuth, loadGrokAuth } from "./auth.js";
import { configuredDefaultProvider } from "./browser-config.js";
import { browserProviderInfo, resolveBrowserProvider } from "./browser-providers.js";
import { chromiumNeedsSoftwareGpu } from "./browser-runtime.js";
import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  resolveChromiumForkBinary,
  selectManagedBrowserBackend,
} from "./chromium-fork.js";
import { defaultHome } from "./home.js";
import { installHint, optionalPeerAvailable } from "./optional-peer.js";
import {
  runtimeFix,
  runtimeLabel,
  runtimeSupported,
  runtimeVersion,
} from "./runtime.js";
import { staleAgentSkillReport } from "./skill-install.js";

const require = createRequire(import.meta.url);

export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";

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

/** Build the readiness report `betterwright doctor` prints. */
export async function doctorReport() {
  const core = resolveCoreDir();
  let version = null;
  if (core) {
    try {
      version = require(path.join(core, "package.json")).version;
    } catch {
      /* ignore */
    }
  }
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const workerOk = fs.existsSync(worker);
  const stealth = stealthDriverVersion();
  let chromiumFork = null;
  let chromiumForkError = null;
  try {
    chromiumFork = resolveChromiumForkBinary();
  } catch (error) {
    chromiumForkError = error instanceof Error ? error.message : String(error);
  }
  const softwareGpu = chromiumNeedsSoftwareGpu();
  const browserSelection = selectManagedBrowserBackend({
    chromiumFork,
    softwareGpu,
  });
  const browser = chromiumForkError ? "unavailable" : browserSelection.browser;
  let provider = null;
  let providerError = null;
  try {
    // The same ladder a launch walks: the env shorthand (which
    // resolveBrowserProvider reads itself), then the default persisted by
    // `betterwright configure`. A configured default whose key is missing
    // throws here and is reported as the provider problem it is.
    const configured = String(process.env.BETTERWRIGHT_CDP_URL || "").trim()
      ? undefined
      : configuredDefaultProvider();
    const resolved = resolveBrowserProvider(configured ?? undefined);
    if (resolved?.plan) {
      const plan = resolved.plan;
      provider = plan.provider
        ? {
            kind: plan.kind,
            provider: plan.provider,
            endpoint: plan.endpointLabel || null,
            ...browserProviderInfo(plan.provider),
          }
        : { kind: plan.kind, executablePath: plan.executablePath || null };
    }
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error);
  }
  const ready =
    workerOk &&
    version === PINNED_PLAYWRIGHT_VERSION &&
    (provider ? !providerError : browser === "chromium-fork" && !chromiumForkError);
  return {
    node: process.execPath,
    runtime: runtimeLabel(),
    runtime_version: runtimeVersion(),
    worker,
    worker_ok: workerOk,
    playwright_core: core,
    playwright_version: version,
    playwright_pinned: PINNED_PLAYWRIGHT_VERSION,
    chromium_fork: chromiumFork,
    chromium_fork_version: chromiumFork ? BETTERWRIGHT_CHROMIUM_VERSION : null,
    chromium_fork_error: chromiumForkError,
    software_gpu: softwareGpu,
    browser_selection_reason: browserSelection.selectionReason,
    provider,
    provider_error: providerError,
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
// it says `chromium_fork null` where what they need to know is "run
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
export function modelReadiness({ env = process.env, auth = null }: any = {}) {
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
export function preferredModelId({ env = process.env, auth = null }: any = {}) {
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
export function modelSetupHint({ env = process.env, auth = null }: any = {}) {
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
    `        or:  export ANTHROPIC_API_KEY=… && ${installHint("@anthropic-ai/sdk")}\n` +
    "  Local:    run Ollama, then --model ollama/<id>   (see `betterwright models`)"
  );
}

/**
 * Group the report, the installed agent integrations, and model/vault state
 * into `{group, label, status, detail, fix}` rows.
 * @param {object} report a doctorReport() result
 */
export function doctorChecks(
  report,
  { home = defaultHome(), env = process.env }: any = {},
) {
  const checks: Array<{
    group: string;
    label: string;
    status: string;
    detail: string;
    fix?: string;
  }> = [];
  const add = (group: string, label: string, status: string, detail: string, fix?: string) => {
    const check: (typeof checks)[number] = { group, label, status, detail };
    if (fix) check.fix = fix;
    checks.push(check);
  };

  add(
    "Runtime",
    runtimeLabel(),
    runtimeSupported() ? "ok" : "fail",
    `v${runtimeVersion()}`,
    runtimeFix() || undefined,
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

  if (report.provider) {
    const provider = report.provider;
    add(
      "Browser",
      "Provider",
      provider.kind === "remote" ? "warn" : "ok",
      provider.kind === "remote"
        ? `${provider.name || provider.provider} (remote CDP${provider.endpoint ? ` — ${provider.endpoint}` : ""}) — outside the guard proxy`
        : `custom local Chromium — ${provider.executablePath}`,
      provider.kind === "remote"
        ? "Remote page traffic cannot be network-policy enforced; see docs/browser-providers.md."
        : null,
    );
  } else if (report.provider_error) {
    add("Browser", "Provider", "fail", report.provider_error);
  }

  if (report.chromium_fork) {
    add(
      "Browser",
      "BetterChromium",
      report.software_gpu ? "warn" : "ok",
      `BetterChromium ${report.chromium_fork_version} — ${report.chromium_fork}` +
        (report.software_gpu
          ? " (no accessible Linux render device; WebGL falls back to SwiftShader)"
          : ""),
      report.software_gpu
        ? "Expose a read/write /dev/dri render device for hardware WebGL."
        : null,
    );
  } else if (report.chromium_fork_error) {
    add(
      "Browser",
      "BetterChromium",
      "fail",
      report.chromium_fork_error,
      "Run `betterwright setup`, or unset BETTERWRIGHT_CHROMIUM_PATH/ROOT.",
    );
  } else if (report.browser_selection_reason === "unsupported-platform") {
    add(
      "Browser",
      "BetterChromium",
      "fail",
      "no artifact is published for this platform",
      "Use the provider option to bring your own or a cloud browser — docs/browser-providers.md.",
    );
  } else if (!report.provider) {
    add(
      "Browser",
      "BetterChromium",
      "fail",
      "not installed",
      "Run `betterwright setup`.",
    );
  }
  add("Browser", "In use", report.ready ? "ok" : "fail",
    report.provider
      ? `provider:${report.provider.provider || report.provider.kind}`
      : report.browser,
    report.ready ? null : "Run `betterwright setup`, or configure a provider (docs/browser-providers.md).");
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
    report.stealth_available ? null : `Optional: ${installHint("patchright-core")}`,
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
      : installHint("@modelcontextprotocol/sdk"),
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
      installHint("@anthropic-ai/sdk"),
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

const STATUS_COLOR = { ok: "accent", warn: "yellow", fail: "red" };

/**
 * Render doctorChecks() rows as the text `betterwright doctor` prints.
 * `paint` (a CliPaint from cli-theme.ts) is optional so callers that want
 * plain text — tests, files, pipes — pass nothing and get the same bytes
 * as always.
 */
export function formatDoctorChecks(checks, { quiet = false, paint = null }: any = {}) {
  const tint = (color, text) => (paint ? paint[color](text) : text);
  const lines = [];
  let group = null;
  for (const check of checks) {
    if (quiet && check.status === "ok") continue;
    if (check.group !== group) {
      group = check.group;
      if (lines.length) lines.push("");
      lines.push(tint("bold", group));
    }
    lines.push(
      `  ${tint(STATUS_COLOR[check.status], STATUS_MARK[check.status])} ${`${check.label}:`.padEnd(16)} ${check.detail}`,
    );
    if (check.fix) lines.push(tint("dim", `      → ${check.fix}`));
  }
  return lines.join("\n");
}
