// Named browser profiles inside one BetterWright home.
//
// A home has always held exactly one persistent profile at `browser/profile`.
// That is still the default, byte-for-byte: an existing install keeps using
// that directory with no migration. A caller that wants more than one
// logged-in identity in the same home passes a profile *name*; each name is an
// independent persistent profile at `browser/profiles/<name>` with the same
// internal layout and, via `profileLockDirFor`, its own sibling lock. Only the
// profile directory and its lock are scoped — the vault, artifacts, the
// CloakBrowser binary cache, and the session-daemon socket stay shared across
// profiles, so a credential saved once is reachable from every profile.
//
// The name becomes a path segment and a lock-directory basename, so it is
// validated hard: a value that could contain a path separator, "..", or an
// absolute path would let a caller read or lock a directory outside
// `browser/profiles/`. Validation is an allowlist rather than a blocklist for
// exactly that reason.

import path from "node:path";

// Names Windows reserves for character devices regardless of extension. A
// profile directory named for one is unusable there, so reject them on every
// platform to keep a home portable between operating systems.
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// Deliberately strict allowlist: an ASCII letter or digit first — so "..", a
// leading ".", and a leading "-" are all rejected — then letters, digits, dot,
// dash, or underscore. No path separators, no whitespace, nothing a shell or
// filesystem treats specially. The cap keeps the nested profile path (and the
// `<name>.betterwright-lock` directory beside it) comfortably short.
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_PROFILE_NAME_LENGTH = 64;

/** A profile name that collides with a Windows reserved device name. */
export function isReservedProfileName(name: string) {
  return RESERVED_NAMES.has(String(name).toLowerCase());
}

/**
 * Validate and normalize a profile name.
 *
 * Returns `null` for "no name given" (`undefined` or `null`); the caller then
 * uses the default `browser/profile`. Any name that is *present but invalid*
 * throws a `TypeError`, so a bad name is a clear failure at construction rather
 * than a surprising path — or a path-traversal — later.
 *
 * Case sensitivity follows the filesystem: the name is used verbatim as a
 * directory segment, so "Social" and "social" are two profiles on a
 * case-sensitive volume (typical Linux) and one on a case-insensitive volume
 * (default macOS, Windows). BetterWright does not fold case itself, because
 * doing so would rename directories out from under an existing install.
 */
export function resolveProfileName(name: unknown): string | null {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string") {
    throw new TypeError("profile must be a string.");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new TypeError("profile must not be empty.");
  }
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new TypeError(
      `profile must be at most ${MAX_PROFILE_NAME_LENGTH} characters.`,
    );
  }
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new TypeError(
      `invalid profile name ${JSON.stringify(name)}: use letters, digits, ` +
        '".", "-", or "_", starting with a letter or digit (no path ' +
        'separators, "..", or absolute paths).',
    );
  }
  if (isReservedProfileName(trimmed)) {
    throw new TypeError(
      `profile name ${JSON.stringify(trimmed)} is reserved by the operating system.`,
    );
  }
  return trimmed;
}

/**
 * The persistent profile directory for a browser root (`<home>/browser`).
 *
 *  - No name (`undefined`/`null`): the historical default `<root>/profile`,
 *    unchanged so existing logins keep working.
 *  - A validated name: `<root>/profiles/<name>`, a sibling tree with the same
 *    internal layout and, through `profileLockDirFor`, its own lock.
 *
 * Throws `TypeError` on an invalid name (see {@link resolveProfileName}).
 */
export function profileDirFor(root: string, name?: unknown): string {
  const resolved = resolveProfileName(name);
  return resolved === null
    ? path.join(root, "profile")
    : path.join(root, "profiles", resolved);
}
