// Named browser profiles inside one BetterWright home.
//
// A home has always held exactly one persistent browser profile at
// `browser/profile`, and that stays the default, byte-for-byte: an existing
// install keeps its logins with no migration and no move. A caller that needs
// two *separate identities* in one home — a work account and a personal one, a
// posting account and a reading account — passes a profile name. Each name is
// an independent persistent profile at `browser/profiles/<name>` with its own
// cookie jar, its own lock, and (see daemon.ts) its own session daemon.
//
// This is not the same axis as `--session`. Sessions are concurrent lanes
// inside ONE browser sharing ONE cookie jar; profiles are separate cookie jars
// in separate browsers. Parallel work as the same identity wants sessions;
// different identities want profiles.
//
// The name becomes a path segment, a lock-directory basename, and a socket
// filename, so it is validated hard against an allowlist rather than a
// blocklist: anything that could contain a separator, "..", or an absolute
// path would let a caller read or lock a directory outside `browser/profiles/`.

import path from "node:path";

import { PROFILE_LOCK_SUFFIX } from "./profile-lock.js";

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
// filesystem treats specially. The cap keeps the nested profile path, the lock
// directory beside it, and the per-profile socket filename all short.
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_PROFILE_NAME_LENGTH = 64;

/** The label a message uses for a profile: the name, or "default". */
export function profileLabel(name?: unknown) {
  const resolved = typeof name === "string" && name ? name : null;
  return resolved ? `"${resolved}"` : "default";
}

/** A profile name that collides with a Windows reserved device name. */
export function isReservedProfileName(name: string) {
  return RESERVED_NAMES.has(String(name).toLowerCase());
}

/**
 * Validate and normalize a profile name.
 *
 * Returns `null` for "no name given" (`undefined`, `null`, or a name-shaped
 * empty string is an error rather than a silent default — see below); the
 * caller then uses the historical `browser/profile`. A name that is *present
 * but invalid* throws a `TypeError`, so a bad name fails loudly at
 * construction instead of silently becoming a surprising path.
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
    throw new TypeError(
      `profile must be a string (received ${typeof name}); omit it for the default profile.`,
    );
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new TypeError("profile must not be empty; omit it for the default profile.");
  }
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new TypeError(
      `profile must be at most ${MAX_PROFILE_NAME_LENGTH} characters (received ${trimmed.length}).`,
    );
  }
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new TypeError(
      `invalid profile name ${JSON.stringify(name)}: use letters, digits, ` +
        '".", "-", or "_", starting with a letter or digit (no path ' +
        'separators, "..", or absolute paths).',
    );
  }
  // Windows drops trailing dots and spaces from filenames, so "social." and
  // "social" would be one directory there and two here. Reject the ambiguity
  // rather than let a home mean different things on different platforms.
  if (trimmed.endsWith(".")) {
    throw new TypeError(
      `invalid profile name ${JSON.stringify(trimmed)}: it must not end with ".".`,
    );
  }
  // The profile lock is a *sibling* of the profile directory
  // (`<profile>.betterwright-lock`, plus `.stale-…` tombstones while a dead
  // lock is being reclaimed), and both live inside `browser/profiles/`. A name
  // carrying that marker would therefore point one profile's data directory at
  // another profile's lock: the second profile would silently fall back to a
  // signed-out ephemeral browser, and the lock reclaimer would eventually
  // `rm -rf` the first profile's cookies. Keep the two namespaces disjoint.
  if (trimmed.toLowerCase().includes(PROFILE_LOCK_SUFFIX)) {
    throw new TypeError(
      `invalid profile name ${JSON.stringify(trimmed)}: ` +
        `"${PROFILE_LOCK_SUFFIX}" is reserved for BetterWright's profile locks.`,
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
  if (resolved === null) return path.join(root, "profile");
  const parent = path.join(root, "profiles");
  const dir = path.join(parent, resolved);
  // Belt and braces: validation already makes escape impossible, so a failure
  // here means the allowlist regressed. Fail loudly rather than operate on a
  // directory outside the home.
  if (path.dirname(path.resolve(dir)) !== path.resolve(parent)) {
    throw new TypeError(`invalid profile name ${JSON.stringify(resolved)}: resolves outside ${parent}.`);
  }
  return dir;
}

/**
 * The filename infix that scopes a per-home artifact to a profile: "" for the
 * default profile (so `daemon.sock`, `daemon.json`, and `daemon.log` keep
 * their historical names) and `-<name>` for a named one. Safe as a filename
 * component for exactly the reasons the name itself is.
 */
export function profileFileSuffix(name?: unknown): string {
  const resolved = resolveProfileName(name);
  return resolved === null ? "" : `-${resolved}`;
}
