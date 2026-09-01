// `betterwright boxes` — start, list, show, and stop cloud browser sessions.
//
// Six of the built-in providers expose a real session lifecycle (create /
// list / get / stop) over REST. The other three allocate a browser only for
// the duration of a WebSocket connection, so this command refuses start/stop
// there and tells the user to connect instead.
//
// Credentials come from `configure --connect` (or a named default with a
// key), then the provider's well-known environment variable. Keys are never
// printed: CDP URLs go through describeCdpUrl, and `--json` masks nothing
// extra because the payload never includes the key.

import {
  loadBrowserConfig,
  resolveConnectedProvider,
} from "./browser-config.js";
import {
  BROWSER_PROVIDER_NAMES,
  browserProviderInfo,
  createProviderSession,
  describeCdpUrl,
  getProviderSession,
  listProviderSessions,
  REST_BROWSER_PROVIDER_NAMES,
  stopProviderSession,
} from "./browser-providers.js";
import { flagValue, positionalArgs } from "./cli-flags.js";
import { BOXES_USAGE } from "./cli-help.js";
import { type CliPaint, cliPaint, paintedError, paintedLog } from "./cli-theme.js";
import { defaultHome } from "./home.js";

function trimmed(value) {
  return String(value ?? "").trim();
}

function hasFlag(argv, flag) {
  return argv.some((token) => token === flag || token.startsWith(`${flag}=`));
}

function restProviders() {
  return REST_BROWSER_PROVIDER_NAMES;
}

function requireRestProviderName(name) {
  const info = browserProviderInfo(name);
  if (info?.lifecycle === "rest") return info;
  if (info) {
    throw new Error(
      `${info.name} has no managed sessions to start or stop. ` +
        "Its browsers exist only for the duration of a WebSocket connection.",
    );
  }
  throw new TypeError(`Unknown browser provider "${name}".`);
}

function connectedRestProviders(config, env) {
  const named = new Set(Object.keys(config.accounts));
  if (config.default?.provider && BROWSER_PROVIDER_NAMES.includes(config.default.provider)) {
    named.add(config.default.provider);
  }
  for (const name of restProviders()) {
    const info = browserProviderInfo(name);
    if (info?.keyEnv && trimmed(env?.[info.keyEnv])) named.add(name);
  }
  return restProviders().filter((name) => named.has(name));
}

function pickProvider(argv, extra, { home, env, needOne }) {
  const flagged = trimmed(flagValue(argv, "--browser"));
  if (flagged) return flagged.toLowerCase();
  const positional = trimmed(extra);
  if (positional) return positional.toLowerCase();
  const config = loadBrowserConfig(home);
  const defaultName = config.default?.provider;
  if (defaultName && restProviders().includes(defaultName)) return defaultName;
  const connected = connectedRestProviders(config, env);
  if (connected.length === 1) return connected[0];
  if (!needOne && connected.length > 1) return "";
  const rest = restProviders().join(", ");
  throw new TypeError(
    connected.length
      ? `Say which provider with --browser (${connected.join(", ")}).`
      : `No connected REST provider. Connect one with \`betterwright configure --connect <name>\` ` +
          `(REST lifecycle: ${rest}).`,
  );
}

function credentialFor(name, argv, { home, env }) {
  return resolveConnectedProvider(name, {
    home,
    env,
    apiKey: flagValue(argv, "--browser-key"),
    keyEnv: flagValue(argv, "--key-env"),
  });
}

function printBox(log, box, { json }) {
  if (json) return;
  const info = browserProviderInfo(box.provider);
  const label = info?.name || box.provider;
  log(`${box.id}`);
  log(`  provider  ${label} (${box.provider})`);
  if (box.status) log(`  status    ${box.status}`);
  if (box.liveViewUrl) log(`  live      ${box.liveViewUrl}`);
  if (box.endpointLabel) log(`  cdp       ${box.endpointLabel}`);
  else if (box.cdpUrl) log(`  cdp       ${describeCdpUrl(box.cdpUrl)}`);
}

interface BoxesJsonRow {
  provider: string;
  id: string;
  status?: string;
  liveViewUrl?: string;
  cdpUrl?: string;
}

function jsonBox(box): BoxesJsonRow {
  const row: BoxesJsonRow = { provider: box.provider, id: box.id };
  if (box.status) row.status = box.status;
  if (box.liveViewUrl) row.liveViewUrl = box.liveViewUrl;
  if (box.endpointLabel) row.cdpUrl = box.endpointLabel;
  else if (box.cdpUrl) row.cdpUrl = describeCdpUrl(box.cdpUrl);
  return row;
}

async function cmdList(argv, extra, io) {
  const json = hasFlag(argv, "--json");
  const status = flagValue(argv, "--status");
  const named = trimmed(flagValue(argv, "--browser")) || trimmed(extra);
  const providers = named
    ? [pickProvider(argv, extra, { home: io.home, env: io.env, needOne: true })]
    : connectedRestProviders(loadBrowserConfig(io.home), io.env);
  if (named) requireRestProviderName(providers[0]);
  if (!named && !providers.length) {
    const provider = pickProvider(argv, extra, { home: io.home, env: io.env, needOne: true });
    providers.push(provider);
  }
  const boxes = [];
  for (const provider of providers) {
    const cred = credentialFor(provider, argv, io);
    const found = await listProviderSessions(provider, {
      apiKey: cred.apiKey,
      status,
      fetchJson: io.fetchJson,
    });
    boxes.push(...found);
  }
  if (json) {
    io.log(JSON.stringify({ boxes: boxes.map(jsonBox) }, null, 2));
    return 0;
  }
  if (!boxes.length) {
    io.log("No boxes.");
    return 0;
  }
  for (const box of boxes) {
    printBox(io.log, box, { json: false });
    io.log("");
  }
  return 0;
}

async function cmdStart(argv, extra, io) {
  const json = hasFlag(argv, "--json");
  const provider = pickProvider(argv, extra, { home: io.home, env: io.env, needOne: true });
  const info = requireRestProviderName(provider);
  const cred = credentialFor(provider, argv, io);
  const box = await createProviderSession(provider, {
    apiKey: cred.apiKey,
    fetchJson: io.fetchJson,
  });
  if (json) {
    io.log(JSON.stringify(jsonBox(box), null, 2));
    return 0;
  }
  io.log(`✓ Started ${info.name} box ${box.id}.`);
  printBox(io.log, box, { json: false });
  io.log(`  stop      betterwright boxes stop ${box.id} --browser ${provider}`);
  if (box.id) {
    io.log(
      `  attach    betterwright run --browser ${provider} --session-id ${box.id} -c "return page.url()"`,
    );
  }
  return 0;
}

async function cmdShow(argv, extra, io) {
  const json = hasFlag(argv, "--json");
  const id = trimmed(extra);
  if (!id) {
    io.fail("Usage: betterwright boxes show <id> [--browser <name>]");
    return 1;
  }
  const provider = pickProvider(argv, "", { home: io.home, env: io.env, needOne: true });
  requireRestProviderName(provider);
  const cred = credentialFor(provider, argv, io);
  const box = await getProviderSession(provider, id, {
    apiKey: cred.apiKey,
    fetchJson: io.fetchJson,
  });
  if (json) {
    io.log(JSON.stringify(jsonBox(box), null, 2));
    return 0;
  }
  printBox(io.log, box, { json: false });
  return 0;
}

async function cmdStop(argv, extra, io) {
  const json = hasFlag(argv, "--json");
  const id = trimmed(extra);
  if (!id) {
    io.fail("Usage: betterwright boxes stop <id> [--browser <name>]");
    return 1;
  }
  const provider = pickProvider(argv, "", { home: io.home, env: io.env, needOne: true });
  requireRestProviderName(provider);
  const cred = credentialFor(provider, argv, io);
  const stopped = await stopProviderSession(provider, id, {
    apiKey: cred.apiKey,
    fetchJson: io.fetchJson,
  });
  if (json) {
    io.log(JSON.stringify({ stopped: true, ...stopped }, null, 2));
    return 0;
  }
  io.log(`✓ Stopped ${stopped.provider} box ${stopped.id}.`);
  return 0;
}

/**
 * `betterwright boxes`. Tests inject `home`, `env`, `log`/`error`, and
 * `fetchJson` so a full start/list/stop pass never opens a socket.
 */
export async function runBoxesCommand(argv: string[] = [], options: any = {}) {
  const home = options.home || defaultHome();
  const env = options.env || process.env;
  const paint: CliPaint = options.paint || cliPaint();
  const log = options.log || paintedLog(paint);
  const fail = options.error || paintedError(paint);
  const fetchJson = options.fetchJson;
  const io = { home, env, log, fail, fetchJson };

  const positionals = positionalArgs(argv);
  const command = trimmed(positionals[0]).toLowerCase();
  const extra = positionals[1];
  if (!command) {
    fail(BOXES_USAGE);
    return 1;
  }

  try {
    if (command === "list") return await cmdList(argv, extra, io);
    if (command === "start") return await cmdStart(argv, extra, io);
    if (command === "show") return await cmdShow(argv, extra, io);
    if (command === "stop") return await cmdStop(argv, extra, io);
    fail(`Unknown boxes command "${command}".\n\n${BOXES_USAGE}`);
    return 1;
  } catch (error) {
    fail(`✗ ${error?.message || error}`);
    return 1;
  }
}
