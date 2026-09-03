// Host runtime identity. The project toolchain is Bun 1.4; the published
// library still loads under Node 22 when a consumer imports it from Node.
// Bun ignores NODE_OPTIONS, so worker/daemon spawns that used to inherit
// `--import` through that env var have to put the flags on argv instead.

import { fileURLToPath } from "node:url";

export const PINNED_BUN_VERSION = "1.4.0";
export const MIN_NODE_MAJOR = 22;

export function runtimeIsBun() {
  return Boolean(bunVersion());
}

export function bunVersion() {
  // SAFETY: Bun sets process.versions.bun; @types/node's ProcessVersions omits it.
  const value = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  return value ? value : null;
}

export function runtimeVersion() {
  return bunVersion() || process.versions.node;
}

export function runtimeLabel() {
  return runtimeIsBun() ? "Bun" : "Node";
}

export function runtimeSupported() {
  const bun = bunVersion();
  if (bun) return compareSemver(bun, PINNED_BUN_VERSION) >= 0;
  const major = Number(String(process.versions.node).split(".")[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

export function runtimeFix() {
  if (runtimeIsBun()) {
    return runtimeSupported()
      ? null
      : `BetterWright needs Bun ${PINNED_BUN_VERSION} or newer. Install it from https://bun.com`;
  }
  return runtimeSupported()
    ? null
    : "BetterWright needs Node 22 or newer, or Bun 1.4. Install Bun from https://bun.com";
}

export function packageAddCommand(packageName, globalInstall = false) {
  if (runtimeIsBun()) {
    return globalInstall ? `bun add -g ${packageName}` : `bun add ${packageName}`;
  }
  return globalInstall ? `npm install -g ${packageName}` : `npm install ${packageName}`;
}

/** `--import` flags from NODE_OPTIONS, as argv pairs Bun will honor. */
export function importFlagsFromNodeOptions(raw) {
  const flags = [];
  const tokens = tokenizeNodeOptions(String(raw || ""));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--import=")) {
      flags.push("--import", token.slice("--import=".length));
      continue;
    }
    if (token === "--import") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("-")) {
        flags.push("--import", next);
        i += 1;
      }
    }
  }
  return flags;
}

/**
 * Bun's `--import` resolver percent-encodes `~` in `file:` URLs, then looks
 * for a path that does not exist. Node's `pathToFileURL` encodes that
 * character, and Windows GitHub runners live under the 8.3 home `RUNNER~1`.
 * Pass the filesystem path instead; Bun preloads those.
 */
function bunImportTarget(specifier) {
  if (!specifier.startsWith("file:")) return specifier;
  try {
    const filePath = fileURLToPath(specifier);
    return process.platform === "win32" ? filePath.replaceAll("\\", "/") : filePath;
  } catch {
    return specifier;
  }
}

/** Extra execArgv Bun children need because they do not read NODE_OPTIONS. */
export function bunInheritedExecArgv(env = process.env) {
  if (!runtimeIsBun()) return [];
  const flags = importFlagsFromNodeOptions(env.NODE_OPTIONS || "");
  const mapped = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--import" && i + 1 < flags.length) {
      mapped.push("--import", bunImportTarget(flags[i + 1]));
      i += 1;
      continue;
    }
    mapped.push(flags[i]);
  }
  return mapped;
}

function tokenizeNodeOptions(raw) {
  const tokens = [];
  for (const match of String(raw).matchAll(/(?:[^\s"]+|"[^"]*")+/g)) {
    const token = match[0];
    tokens.push(
      token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
    );
  }
  return tokens;
}

function compareSemver(actual, minimum) {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function versionParts(value) {
  const core = String(value).split("-")[0];
  return core.split(".").slice(0, 3).map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}
