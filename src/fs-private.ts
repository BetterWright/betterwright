// Owner-only filesystem writes.
//
// BetterWright's home holds material that must not be world-readable: the
// encrypted credential vault, session transcripts, browser profiles carrying
// live cookies, and the live-view password hash. Every write of that material
// goes through this module so the permission bits are decided in one place.
//
// Two details are easy to get wrong and are handled here once:
//
//   - `mode` on `writeFileSync`/`mkdirSync` applies only when the entry is
//     created, and even then it is masked by the process umask. Rewriting an
//     existing file that was created too permissively would silently keep the
//     old mode, so the file helpers chmod afterwards. Directories are the
//     exception: see `mkdirPrivate`.
//   - POSIX permission bits do not exist on Windows, where `chmod` is a no-op
//     or throws depending on the filesystem. Failing there would break a
//     platform that never had the exposure in the first place, so the chmod is
//     best-effort while the write itself still propagates errors.

import fs from "node:fs";
import path from "node:path";

/** Directory mode: owner read/write/execute, nothing for group or other. */
export const PRIVATE_DIR_MODE = 0o700;

/** File mode: owner read/write, nothing for group or other. */
export const PRIVATE_FILE_MODE = 0o600;

function enforceMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort: Windows has no POSIX mode bits (see the module comment).
  }
}

/**
 * Create a directory (recursively) that only the owner can enter.
 *
 * Only directories this call creates are tightened. An existing directory keeps
 * whatever mode it already had: callers pass parents BetterWright does not own
 * — a profile's parent is wherever the user pointed it — and silently chmodding
 * one to `0700` would revoke access the user deliberately granted.
 */
export function mkdirPrivate(dir: string): void {
  const firstCreated = fs.mkdirSync(dir, {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  if (firstCreated === undefined) return;
  // `mode` is masked by the process umask, so the chmod is what actually makes
  // a new directory owner-only. Walk the whole newly-created chain, not just
  // the leaf, since every link in it is equally new and equally exposed.
  const outermost = path.resolve(firstCreated);
  let target = path.resolve(dir);
  for (;;) {
    enforceMode(target, PRIVATE_DIR_MODE);
    const parent = path.dirname(target);
    if (target === outermost || parent === target) break;
    target = parent;
  }
}

/** Write UTF-8 text to a file only the owner can read. */
export function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  enforceMode(file, PRIVATE_FILE_MODE);
}

/** Write raw bytes to a file only the owner can read. */
export function writePrivateBytes(file: string, content: NodeJS.ArrayBufferView): void {
  fs.writeFileSync(file, content, { mode: PRIVATE_FILE_MODE });
  enforceMode(file, PRIVATE_FILE_MODE);
}
