// Caller-supplied Chromium switches.
//
// BetterWright builds its own launch argument list (fingerprint seed, WebRTC
// proxy boundary, locale/timezone/platform masking) and that list is
// load-bearing: it is what keeps the managed browser's identity coherent and
// every connection on the guard proxy. But it left no room for the
// host-specific switches that have nothing to do with identity. GPU-less Linux
// hosts use the managed CloakBrowser compatibility backend so WebGL stays
// available.
//
// PRECEDENCE. Chromium's base::CommandLine parses argv left to right into a
// map, so a repeated switch is won by the LAST occurrence. Appending caller
// switches after the managed ones therefore does NOT make BetterWright's own
// switches win — it makes them lose. Two rules restore the intended ordering:
//
//   1. Switches BetterWright owns are reserved and rejected outright, with an
//      error naming the supported alternative. These are the ones that decide
//      where traffic goes (proxy), who can drive the browser (remote
//      debugging), which profile is opened, and what identity is presented.
//   2. A switch that merely collides with one already in the managed list, or
//      is common compatibility boilerplate that would break the selected
//      backend, is dropped and reported back. The caller learns it was ignored
//      rather than getting an upgrade-time launch failure or different
//      behavior than they asked for.
//
// Everything else is appended last and takes effect.

/**
 * Switches BetterWright sets or depends on. A caller who overrides one of
 * these does not get a tuned browser, they get a broken guarantee, so these
 * fail loudly instead of being quietly dropped.
 *
 * Matching is by switch name, plus the `--fingerprint*` family by prefix
 * because CloakBrowser and the native fork share that flag namespace.
 */
const RESERVED = Object.freeze({
  // Every connection must stay on the local guard proxy: that is where network
  // policy, DNS-rebinding validation, and the credential boundary are applied.
  "--proxy-server": "network egress is controlled by the `upstreamProxy` option",
  "--proxy-pac-url": "network egress is controlled by the `upstreamProxy` option",
  "--proxy-bypass-list": "the guard proxy must see every connection",
  "--no-proxy-server": "the guard proxy must see every connection",
  "--winhttp-proxy-resolver": "the guard proxy must see every connection",
  // An open debugging channel is an unpoliced second driver for the browser.
  "--remote-debugging-port": "BetterWright owns the browser control channel",
  "--remote-debugging-pipe": "BetterWright owns the browser control channel",
  "--remote-debugging-address": "BetterWright owns the browser control channel",
  "--remote-allow-origins": "BetterWright owns the browser control channel",
  // The profile directory is held under a lock keyed to this exact path.
  "--user-data-dir": "the profile directory is managed and lock-protected",
  "--profile-directory": "the profile directory is managed and lock-protected",
  // Identity coherence is the point of the managed browser.
  "--lang": "use the `locale` option",
  "--bw-timezone": "use the `timezone` option",
  // Headless is resolved from the `headless` option and must not desync from
  // the viewport and window-geometry decisions made alongside it.
  "--headless": "use the `headless` option",
});

// Common Chromium boilerplate that cannot take effect safely but also should
// not turn an otherwise compatible pre-existing configuration into a hard
// launch failure. Unlike RESERVED, these switches survive normalization and
// are dropped by mergeChromiumArgs so the result can carry a clear warning.
const DROP_WITH_WARNING = Object.freeze({
  "--disable-software-rasterizer":
    "the managed browser must retain its WebGL software fallback",
});

const RESERVED_PREFIXES = Object.freeze([
  ["--fingerprint", "use the `locale`, `timezone`, and `platform` options"],
]);

/** The switch name of an argument: everything before the first `=`. */
function switchName(arg) {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}

function reservedReason(name) {
  if (Object.hasOwn(RESERVED, name)) return RESERVED[name];
  for (const [prefix, reason] of RESERVED_PREFIXES) {
    if (name === prefix || name.startsWith(`${prefix}-`)) return reason;
  }
  return null;
}

/**
 * Split a `BETTERWRIGHT_CHROMIUM_ARGS` string into individual switches.
 *
 * Whitespace-separated, with single or double quotes to keep a value that
 * contains spaces together (`--host-rules="MAP * 127.0.0.1"`). Quotes are
 * stripped; there is no escape character, because no Chromium switch value
 * needs one and a half-supported escape syntax is worse than none.
 */
export function parseChromiumArgs(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let started = false;
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) {
    throw new TypeError(
      `Unterminated ${quote === '"' ? "double" : "single"} quote in Chromium arguments: ${text}`,
    );
  }
  if (started) args.push(current);
  return args;
}

/**
 * Validate caller-supplied switches, rejecting anything malformed or reserved.
 *
 * @param {string[]|string} input switches, or a raw string to parse first
 * @param {string} source label used in error messages, e.g. an env var name
 * @returns {string[]} the accepted switches, in caller order
 */
export function normalizeChromiumArgs(input, source = "chromiumArgs") {
  const list = typeof input === "string" ? parseChromiumArgs(input) : input;
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new TypeError(`${source} must be an array of strings or a string.`);
  }
  const accepted = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new TypeError(`${source} entries must be strings; received ${typeof entry}.`);
    }
    const arg = entry.trim();
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      throw new TypeError(
        `${source} entries must be Chromium switches starting with "--"; received ${JSON.stringify(arg)}.`,
      );
    }
    const name = switchName(arg);
    if (!/^--[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(name)) {
      throw new TypeError(`${source} contains a malformed switch name: ${JSON.stringify(arg)}.`);
    }
    const reason = reservedReason(name);
    if (reason) {
      throw new TypeError(
        `${name} is reserved by BetterWright and cannot be overridden — ${reason}.`,
      );
    }
    accepted.push(arg);
  }
  return accepted;
}

/**
 * Resolve caller switches from the client option and the environment.
 * Both may be set; the option is applied first, then the environment, so a
 * host-level `BETTERWRIGHT_CHROMIUM_ARGS` can add to (but never silently
 * contradict — collisions are dropped by {@link mergeChromiumArgs}) the
 * program's own list.
 */
export function resolveChromiumArgs(option, env = process.env) {
  return [
    ...normalizeChromiumArgs(option ?? [], "chromiumArgs"),
    ...normalizeChromiumArgs(
      env?.BETTERWRIGHT_CHROMIUM_ARGS ?? "",
      "BETTERWRIGHT_CHROMIUM_ARGS",
    ),
  ];
}

/**
 * Append caller switches to the managed list, dropping any that collide.
 *
 * A collision is dropped rather than appended because Chromium resolves
 * duplicates last-wins: appending would override the managed value, which is
 * exactly backwards. Dropped names are returned so the caller can be told.
 *
 * @param {string[]} managedArgs BetterWright's own switches
 * @param {string[]} extraArgs validated caller switches
 * @returns {{args: string[], ignored: string[]}}
 */
export function mergeChromiumArgs(managedArgs, extraArgs) {
  const args = [...managedArgs];
  const ignored = [];
  const taken = new Set(managedArgs.map(switchName));
  for (const arg of extraArgs) {
    const name = switchName(arg);
    if (Object.hasOwn(DROP_WITH_WARNING, name) || taken.has(name)) {
      if (!ignored.includes(name)) ignored.push(name);
      continue;
    }
    taken.add(name);
    args.push(arg);
  }
  return { args, ignored };
}

/** Human-readable note for switches that were dropped. */
export function chromiumArgsWarning(ignored) {
  if (!ignored?.length) return "";
  const compatibility = ignored.filter((name) =>
    Object.hasOwn(DROP_WITH_WARNING, name)
  );
  const duplicates = ignored.filter((name) =>
    !Object.hasOwn(DROP_WITH_WARNING, name)
  );
  const notes = [];
  if (compatibility.length) {
    notes.push(
      `Ignored Chromium ${compatibility.length === 1 ? "switch" : "switches"} ${compatibility.join(", ")}: ` +
        compatibility.map((name) => DROP_WITH_WARNING[name]).join("; ") + ".",
    );
  }
  if (duplicates.length) {
    notes.push(
      `Ignored Chromium ${duplicates.length === 1 ? "switch" : "switches"} ${duplicates.join(", ")}: ` +
        "already set by BetterWright, whose value takes precedence.",
    );
  }
  return notes.join(" ");
}
