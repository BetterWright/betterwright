// `betterwright configure` — choose the browser backend once, for this home.
//
// The provider layer has always accepted a cloud browser, a CDP endpoint, or a
// local Chromium binary, but every launch had to say so again: a flag on
// run/repl/exec, or BETTERWRIGHT_CDP_URL exported in the right shell. This
// command writes the choice to <home>/config.json (browser-config.ts) so it
// holds for every launch, and it offers to connect once, because "saved" and
// "works" are different claims.
//
// API keys are why the interactive flow asks two questions instead of one: a
// pasted key lands in the config file (owner-only), while `keyEnv` names an
// environment variable and keeps the key out of the file entirely. Both are
// offered every time, for built-in and custom providers alike.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  type BrowserFileConfig,
  browserConfigPath,
  type CustomProviderDefinition,
  type DefaultBrowserRef,
  expandProviderChoice,
  loadBrowserConfig,
  removeCustomProvider,
  saveCustomProvider,
  saveDefaultBrowser,
} from "./browser-config.js";
import {
  BROWSER_PROVIDER_NAMES,
  browserProviderInfo,
  describeCdpUrl,
  resolveBrowserProvider,
} from "./browser-providers.js";
import { flagValue } from "./cli-flags.js";
import { type CliPaint, cliPaint, paintedError, paintedLog } from "./cli-theme.js";
import { defaultHome } from "./home.js";
import { isCallable } from "./untrusted-value.js";

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal token custom cdpUrl templates carry
const API_KEY_PLACEHOLDER = "${apiKey}";
// Long enough for a cloud provider to hand back a browser, short enough that a
// wrong endpoint fails while the user is still watching.
const CONNECT_TIMEOUT_MS = 10_000;

/** A menu row, and what picking it means. */
interface ConfigureChoice {
  kind: "managed" | "provider" | "cdp" | "local" | "add";
  label: string;
  name?: string;
  custom?: CustomProviderDefinition;
}

function hasFlag(argv, flag) {
  return argv.some((token) => token === flag || token.startsWith(`${flag}=`));
}

function trimmed(value) {
  return String(value ?? "").trim();
}

function envKeyState(env, name) {
  return trimmed(env?.[name]) ? "set" : "not set";
}

/**
 * One line describing a stored default: what it points at, and where its key
 * comes from. Never prints a key, only its source.
 */
export function describeDefaultBrowser(ref: DefaultBrowserRef, { env = process.env, custom = {} }: any = {}) {
  if (!ref) return "the managed BetterChromium fork";
  if (ref.cdpUrl) return `CDP endpoint ${describeCdpUrl(ref.cdpUrl)}`;
  if (ref.executablePath) return `local Chromium at ${ref.executablePath}`;
  const info = browserProviderInfo(ref.provider);
  const definition = custom[ref.provider];
  const label = info?.name || definition?.displayName || ref.provider;
  const keyEnv = ref.keyEnv || definition?.keyEnv || info?.keyEnv;
  let key = "";
  if (ref.apiKey || (!ref.keyEnv && definition?.apiKey)) {
    key = ", API key stored in the config file";
  } else if (keyEnv) {
    key = `, API key from ${keyEnv} (${envKeyState(env, keyEnv)})`;
  }
  return `${label} (${ref.provider}${info ? "" : ", custom"})${key}`;
}

function describeCustomProvider(name, definition: CustomProviderDefinition, env) {
  const label = definition.displayName ? `${definition.displayName} (${name})` : name;
  const key = definition.apiKey
    ? "API key stored in the config file"
    : definition.keyEnv
      ? `API key from ${definition.keyEnv} (${envKeyState(env, definition.keyEnv)})`
      : "no API key configured";
  return `${label}: ${describeCdpUrl(definition.cdpUrl)}, ${key}`;
}

function summaryLines(config, env, home) {
  const lines = [`  Config file: ${browserConfigPath(home)}`];
  lines.push(`  Default:     ${describeDefaultBrowser(config.default, { env, custom: config.custom })}`);
  const names = Object.keys(config.custom);
  if (names.length) {
    lines.push("  Custom providers:");
    for (const name of names) {
      lines.push(`    · ${describeCustomProvider(name, config.custom[name], env)}`);
    }
  }
  return lines;
}

/** A stored entry as `--json` reports it: key sources, never keys. */
interface MaskedBrowserEntry {
  provider?: string;
  cdpUrl?: string;
  executablePath?: string;
  headers?: Record<string, string>;
  displayName?: string;
  docs?: string;
  keyEnv?: string;
  keyEnvSet?: boolean;
  apiKey?: string;
}

// Copied field by field rather than spread-and-overwrite, so a field added to
// the config later cannot reach this output before someone decides it is safe.
function maskEntry(entry, env): MaskedBrowserEntry {
  const masked: MaskedBrowserEntry = {};
  if (entry.provider) masked.provider = entry.provider;
  if (entry.cdpUrl) masked.cdpUrl = entry.cdpUrl;
  if (entry.executablePath) masked.executablePath = entry.executablePath;
  if (entry.headers) masked.headers = entry.headers;
  if (entry.displayName) masked.displayName = entry.displayName;
  if (entry.docs) masked.docs = entry.docs;
  if (entry.keyEnv) {
    masked.keyEnv = entry.keyEnv;
    masked.keyEnvSet = Boolean(trimmed(env?.[entry.keyEnv]));
  }
  if (entry.apiKey) masked.apiKey = "***";
  return masked;
}

function showConfig({ home, env, log, json, paint }) {
  const config = loadBrowserConfig(home);
  if (json) {
    const custom: Record<string, MaskedBrowserEntry> = {};
    for (const [name, definition] of Object.entries(config.custom)) {
      custom[name] = maskEntry(definition, env);
    }
    log(
      JSON.stringify(
        {
          file: browserConfigPath(home),
          default: config.default ? maskEntry(config.default, env) : null,
          custom,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  log("");
  log(paint.heading("Browser backend"));
  log("");
  for (const line of summaryLines(config, env, home)) log(line);
  log("");
  log("  Change it with `betterwright configure`.");
  log("");
  return 0;
}

function assertCdpUrl(value) {
  let url: URL;
  try {
    url = new URL(trimmed(value));
  } catch {
    throw new TypeError(`Not a URL: ${value}. A CDP endpoint looks like wss://host/path.`);
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new TypeError(
      `A CDP endpoint must be a ws:// or wss:// URL; ${url.protocol}// is not one. ` +
        "Remote endpoints must use wss://; plaintext ws:// is only allowed on loopback.",
    );
  }
  return url.href;
}

// `--browser <value>`: a URL is an endpoint, an absolute path is a binary,
// anything else names a provider (saveDefaultBrowser rejects unknown names).
function defaultRefFromValue(value, { apiKey, keyEnv }): DefaultBrowserRef {
  const wanted = trimmed(value);
  if (!wanted) {
    throw new TypeError(
      "--browser needs a provider name, a wss:// CDP endpoint, or an absolute path to a Chromium binary.",
    );
  }
  // Any scheme, not just ws(s), so `--browser https://…` gets the protocol
  // error rather than "unknown provider".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(wanted)) {
    if (apiKey || keyEnv) {
      throw new TypeError("--browser-key and --key-env apply to a named provider, not a CDP endpoint.");
    }
    return { cdpUrl: assertCdpUrl(wanted) };
  }
  if (path.isAbsolute(wanted)) {
    if (apiKey || keyEnv) {
      throw new TypeError("--browser-key and --key-env apply to a named provider, not a local binary.");
    }
    if (!fs.existsSync(wanted)) throw new TypeError(`No Chromium binary at ${wanted}.`);
    return { executablePath: wanted };
  }
  const ref: DefaultBrowserRef = { provider: wanted.toLowerCase() };
  if (apiKey) ref.apiKey = apiKey;
  if (keyEnv) ref.keyEnv = keyEnv;
  return ref;
}

// The default connection test: a real CDP handshake through playwright-core,
// injectable so tests never open a socket.
async function connectOverCdp({ cdpUrl, headers, timeout }: any) {
  const { chromium } = await import("playwright-core");
  const browser = Object.keys(headers || {}).length
    ? await chromium.connectOverCDP(cdpUrl, { timeout, headers })
    : await chromium.connectOverCDP(cdpUrl, { timeout });
  try {
    return { version: browser.version() };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Resolve the configured default the way a launch would, mint a session if the
 * provider needs one, and connect. Returns 0 when the browser answered.
 */
async function testConnection({ home, env, log, fail, connect, fetchJson }) {
  const config = loadBrowserConfig(home);
  if (!config.default) {
    log("  · No default is configured, so launches use the managed BetterChromium fork.");
    return 0;
  }
  let plan;
  try {
    const expanded = expandProviderChoice(config.default, { home, env, config });
    plan = resolveBrowserProvider(expanded, { env })?.plan;
  } catch (error) {
    fail(`  ✗ ${error?.message || error}`);
    return 1;
  }
  if (!plan) {
    log("  · Nothing to connect to.");
    return 0;
  }
  if (plan.kind === "local") {
    // resolveBrowserProvider already checked the path exists and is absolute.
    log(`  ✓ Chromium binary found at ${plan.executablePath}.`);
    return 0;
  }
  log(`  · Connecting to ${plan.endpointLabel || plan.provider}…`);
  let live = plan;
  try {
    // A session-minting provider bills for this; the finally below releases it.
    if (plan.create) live = await plan.create({ fetchJson });
    const result = await connect({
      cdpUrl: live.cdpUrl,
      headers: live.headers || {},
      timeout: CONNECT_TIMEOUT_MS,
    });
    const version = trimmed(result?.version) || "connected";
    log(`  ✓ ${version}`);
    return 0;
  } catch (error) {
    // First line only: playwright-core appends a multi-line call log that
    // repeats the endpoint this command already printed.
    const detail = String(error?.message || error).split("\n")[0];
    fail(`  ✗ Could not connect: ${detail}`);
    fail("    The choice is saved but unverified.");
    return 1;
  } finally {
    if (live && live !== plan) {
      try {
        await live.end?.();
      } catch {
        /* releasing the probe session is best-effort */
      }
    }
  }
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
    },
    close() {
      rl.close();
    },
  };
}

// `confirm` is derived from `ask` when the prompter does not provide one, so a
// scripted prompter only has to answer questions in order.
async function askConfirm(prompt, question, fallback = true) {
  if (isCallable(prompt.confirm)) return prompt.confirm(question, fallback);
  const answer = trimmed(await prompt.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `));
  if (!answer) return fallback;
  return /^y(es)?$/i.test(answer);
}

function menuChoices(config: BrowserFileConfig): ConfigureChoice[] {
  const choices: ConfigureChoice[] = [
    { kind: "managed", label: "Managed BetterChromium (recommended default)" },
  ];
  for (const name of BROWSER_PROVIDER_NAMES) {
    const info = browserProviderInfo(name);
    choices.push({ kind: "provider", name, label: `${info.name} (${name})` });
  }
  for (const [name, definition] of Object.entries(config.custom)) {
    choices.push({
      kind: "provider",
      name,
      custom: definition,
      label: `${definition.displayName || name} (${name}, configured)`,
    });
  }
  choices.push({ kind: "cdp", label: "Custom CDP endpoint (any wss:// URL)" });
  choices.push({ kind: "local", label: "Your own Chromium binary (executablePath)" });
  choices.push({ kind: "add", label: "Add a custom provider…" });
  return choices;
}

/**
 * Ask where one provider's API key comes from. The environment variable is
 * offered as the default because a key named there never enters the config
 * file; pasting is the fallback for people who do not want to export anything.
 */
async function askKeySource(prompt, { log, env, label, keyEnv }) {
  log("");
  log(`  ${label} needs an API key.`);
  log("    1) Paste it now (stored in the config file, readable only by you)");
  log(`    2) Read it from an environment variable${keyEnv ? ` (${keyEnv})` : ""}`);
  const answer = trimmed(await prompt.ask("  Key [2]: ")) || "2";
  if (answer === "1") {
    // Asked with plain readline echo: raw-mode masking is a terminal
    // compatibility problem this command does not need to own.
    const key = trimmed(await prompt.ask(`  ${label} API key: `));
    if (!key) throw new TypeError("No API key entered.");
    return { apiKey: key };
  }
  if (answer !== "2") throw new TypeError(`"${answer}" is not 1 or 2.`);
  const suggestion = keyEnv || "";
  const name =
    trimmed(await prompt.ask(`  Environment variable${suggestion ? ` [${suggestion}]` : ""}: `)) ||
    suggestion;
  if (!name) throw new TypeError("No environment variable named.");
  if (!trimmed(env?.[name])) {
    log(`  ! ${name} is not set in this shell. Saved anyway; set it before the next launch.`);
  }
  return { keyEnv: name };
}

function customNeedsKey(definition: CustomProviderDefinition) {
  return (
    definition.cdpUrl.includes(API_KEY_PLACEHOLDER) ||
    Object.values(definition.headers || {}).some((value) => value.includes(API_KEY_PLACEHOLDER))
  );
}

async function chooseBuiltInProvider(prompt, choice, { home, env, log }) {
  const info = browserProviderInfo(choice.name);
  const source = await askKeySource(prompt, {
    log,
    env,
    label: info.name,
    keyEnv: info.keyEnv,
  });
  saveDefaultBrowser({ provider: choice.name, ...source }, home);
  log(`  ✓ Default browser: ${info.name} (${choice.name}).`);
  if (info.docs) log(`    Docs: ${info.docs}`);
  return true;
}

function chooseCustomProvider(choice, { home, env, log }) {
  saveDefaultBrowser({ provider: choice.name }, home);
  log(`  ✓ Default browser: ${choice.custom.displayName || choice.name} (${choice.name}).`);
  const available =
    choice.custom.apiKey || (choice.custom.keyEnv && trimmed(env?.[choice.custom.keyEnv]));
  if (customNeedsKey(choice.custom) && !available) {
    log(
      `  ! ${choice.name} has no API key available` +
        (choice.custom.keyEnv ? ` (${choice.custom.keyEnv} is not set)` : "") +
        ". Set it, or re-add the provider with a key.",
    );
  }
  return true;
}

async function chooseCdpEndpoint(prompt, { home, log }) {
  log("");
  log("  A CDP endpoint is the WebSocket a browser exposes (wss://, or ws:// on loopback).");
  const cdpUrl = assertCdpUrl(await prompt.ask("  Endpoint: "));
  saveDefaultBrowser({ cdpUrl }, home);
  log(`  ✓ Default browser: ${describeCdpUrl(cdpUrl)}`);
  return true;
}

async function chooseLocalBinary(prompt, { home, log }) {
  log("");
  const executablePath = trimmed(await prompt.ask("  Absolute path to the Chromium binary: "));
  if (!path.isAbsolute(executablePath)) {
    throw new TypeError(`${executablePath || "That"} is not an absolute path.`);
  }
  if (!fs.existsSync(executablePath)) throw new TypeError(`No file at ${executablePath}.`);
  saveDefaultBrowser({ executablePath }, home);
  log(`  ✓ Default browser: local Chromium at ${executablePath}`);
  return false; // nothing remote to connect to
}

async function addCustomProvider(prompt, { home, env, log }) {
  log("");
  log("  A custom provider is a name for a CDP connect URL.");
  log(`  Put ${API_KEY_PLACEHOLDER} where the key belongs and it is substituted at launch.`);
  const name = trimmed(await prompt.ask("  Name (lowercase, e.g. my-cloud): "));
  const cdpUrl = trimmed(await prompt.ask("  Connect URL: "));
  const definition: CustomProviderDefinition = { cdpUrl };
  if (customNeedsKey(definition)) {
    const suggestion = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    Object.assign(definition, await askKeySource(prompt, { log, env, label: name, keyEnv: suggestion }));
  }
  const saved = saveCustomProvider(name, definition, home);
  log(`  ✓ Saved the custom provider "${saved.name}".`);
  if (!(await askConfirm(prompt, `  Make ${saved.name} the default browser?`, true))) return false;
  saveDefaultBrowser({ provider: saved.name }, home);
  log(`  ✓ Default browser: ${saved.name}.`);
  return true;
}

/** The interactive menu. Returns the process exit code. */
async function configureInteractively({ home, env, log, connect, fetchJson, prompt, offerTest, paint }) {
  const io = prompt || createPrompter();
  try {
    const config = loadBrowserConfig(home);
    log("");
    log(paint.heading("Browser backend"));
    log("");
    for (const line of summaryLines(config, env, home)) log(line);
    log("");
    const choices = menuChoices(config);
    choices.forEach((choice, index) => {
      log(`  ${String(index + 1).padStart(2)}) ${choice.label}`);
    });
    log("");
    const answer = trimmed(await io.ask("  Choice (Enter to keep the current setting): "));
    if (!answer) {
      log("  · Nothing changed.");
      return 0;
    }
    const choice = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    if (!choice) {
      log(`  ✗ "${answer}" is not one of the choices above.`);
      return 1;
    }

    let remote = false;
    if (choice.kind === "managed") {
      saveDefaultBrowser(null, home);
      log("  ✓ Default browser: the managed BetterChromium fork. Launches use it again.");
    } else if (choice.kind === "provider") {
      remote = choice.custom
        ? chooseCustomProvider(choice, { home, env, log })
        : await chooseBuiltInProvider(io, choice, { home, env, log });
    } else if (choice.kind === "cdp") {
      remote = await chooseCdpEndpoint(io, { home, log });
    } else if (choice.kind === "local") {
      remote = await chooseLocalBinary(io, { home, log });
    } else {
      remote = await addCustomProvider(io, { home, env, log });
    }

    if (remote && offerTest && (await askConfirm(io, "  Test the connection now?", true))) {
      log("");
      return testConnection({ home, env, log, fail: log, connect, fetchJson });
    }
    return 0;
  } catch (error) {
    log(`  ✗ ${error?.message || error}`);
    return 1;
  } finally {
    if (!prompt) io.close();
  }
}

/**
 * `betterwright configure`. With no flags on a terminal this is the menu;
 * every flag form below works without one.
 *
 * @param {string[]} argv tokens after the subcommand
 * @param {object} options home, env, log/error sinks, and the injectable
 *   `prompt` and `connect` seams the tests drive.
 */
export async function runConfigure(argv: string[] = [], options: any = {}) {
  const home = options.home || defaultHome();
  const env = options.env || process.env;
  const paint: CliPaint = options.paint || cliPaint();
  const log = options.log || paintedLog(paint);
  const fail = options.error || paintedError(paint);
  const connect = options.connect || connectOverCdp;
  const fetchJson = options.fetchJson;

  const apiKey = flagValue(argv, "--browser-key");
  const keyEnv = flagValue(argv, "--key-env");
  if (apiKey !== undefined && keyEnv !== undefined) {
    fail(
      "Pass either --browser-key (stored in the config file) or --key-env (read from the environment), not both.",
    );
    return 1;
  }
  const browser = flagValue(argv, "--browser");
  const add = flagValue(argv, "--add");
  const remove = flagValue(argv, "--remove");
  const managed = hasFlag(argv, "--managed") || hasFlag(argv, "--reset");
  const wantsTest = hasFlag(argv, "--test");
  const wantsJson = hasFlag(argv, "--json");
  const wantsShow = hasFlag(argv, "--show");
  const acts = managed || [browser, add, remove].some((value) => value !== undefined);
  if (!acts && (apiKey !== undefined || keyEnv !== undefined)) {
    fail("--browser-key and --key-env set the key for --browser or --add; neither was given.");
    return 1;
  }

  if (!acts && !wantsTest && !wantsShow && !wantsJson) {
    if (options.prompt || process.stdin.isTTY) {
      return configureInteractively({
        home,
        env,
        log,
        connect,
        fetchJson,
        prompt: options.prompt,
        offerTest: !hasFlag(argv, "--no-test"),
        paint,
      });
    }
    return showConfig({ home, env, log, json: false, paint });
  }

  try {
    if (remove !== undefined) {
      const name = trimmed(remove).toLowerCase();
      log(
        removeCustomProvider(name, home)
          ? `✓ Removed the custom provider "${name}".`
          : `· No custom provider named "${name}".`,
      );
    }
    if (add !== undefined) {
      const cdpUrl = flagValue(argv, "--cdp-url");
      if (cdpUrl === undefined) {
        fail("--add needs --cdp-url <wss://… connect URL>.");
        return 1;
      }
      const definition: CustomProviderDefinition = { cdpUrl: trimmed(cdpUrl) };
      if (keyEnv) definition.keyEnv = keyEnv;
      if (apiKey) definition.apiKey = apiKey;
      const docs = flagValue(argv, "--docs");
      if (docs) definition.docs = docs;
      const displayName = flagValue(argv, "--display-name");
      if (displayName) definition.displayName = displayName;
      const saved = saveCustomProvider(add, definition, home);
      log(`✓ Saved the custom provider "${saved.name}" to ${saved.file}.`);
    }
    if (managed) {
      saveDefaultBrowser(null, home);
      log("✓ Default browser: the managed BetterChromium fork.");
    } else if (browser !== undefined) {
      const ref = defaultRefFromValue(browser, { apiKey, keyEnv });
      saveDefaultBrowser(ref, home);
      log(`✓ Default browser: ${describeDefaultBrowser(ref, { env, custom: loadBrowserConfig(home).custom })}`);
    }
  } catch (error) {
    fail(`✗ ${error?.message || error}`);
    return 1;
  }

  if (wantsTest) return testConnection({ home, env, log, fail, connect, fetchJson });
  if (!acts) return showConfig({ home, env, log, json: wantsJson, paint });
  return 0;
}
