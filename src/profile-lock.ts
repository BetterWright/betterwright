// Cross-process advisory lock for the persistent browser profile.
//
// The lock is a sibling directory of the profile (`<profile>.betterwright-lock`)
// holding an `owner.json` lease. The owning worker refreshes the lease mtime on
// a heartbeat, so a lock left behind by a hard-killed process expires on its
// own even when the recorded pid has been recycled — Windows reuses pids
// aggressively, so "a process with that pid is alive" proves nothing there.
// Chromium's own profile singleton remains the final authority; this lock only
// exists to fail over to an ephemeral profile with a useful warning instead of
// a raw Chromium launch error.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirPrivate } from "./fs-private.js";

export const PROFILE_LOCK_STALE_MS = 60_000;
export const PROFILE_LOCK_HEARTBEAT_MS = 15_000;

// Codes a sandbox or Windows ACL produces when it refuses a write outside the
// allowed workspace. These must degrade gracefully, never fail the launch.
const PERMISSION_CODES = new Set(["EPERM", "EACCES", "EROFS", "ENOTSUP"]);

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// The lock lives beside the profile it guards, so this marker is reserved in
// any directory that holds profiles: `src/profile-name.ts` rejects profile
// names containing it, which keeps a named profile's data directory from ever
// landing on another profile's lock (or on a `.stale-…` tombstone of one).
export const PROFILE_LOCK_SUFFIX = ".betterwright-lock";

export function profileLockDirFor(profileDir) {
  return `${profileDir}${PROFILE_LOCK_SUFFIX}`;
}

function readOwner(ownerFile) {
  const raw = fs.readFileSync(ownerFile, "utf8");
  if (raw.length > 4096) throw new Error("oversized profile lock owner file");
  return JSON.parse(raw);
}

// Decide whether an existing lock directory may be reclaimed.
//  - Lease-bearing owner (0.9.6+): reclaimable when its heartbeat went stale,
//    even if some process now wears the recorded pid (pid reuse), or when the
//    pid is dead on this host.
//  - Legacy owner (<= 0.9.5, no lease): reclaimable only when its pid is dead
//    on this host — a live legacy holder never heartbeats, so age proves nothing.
//  - Missing/corrupt owner file: reclaimable once the lock directory itself is
//    old enough that this cannot be a lock another process is mid-creating.
function inspectExistingLock(lockDir, ownerFile, staleMs) {
  let owner = null;
  let ownerMtimeMs = null;
  try {
    owner = readOwner(ownerFile);
    ownerMtimeMs = fs.statSync(ownerFile).mtimeMs;
  } catch {
    owner = null;
  }
  if (!owner || typeof owner !== "object" || !owner.hostname) {
    try {
      const dirMtimeMs = fs.statSync(lockDir).mtimeMs;
      return { reclaimable: Date.now() - dirMtimeMs >= staleMs, owner: null };
    } catch {
      return { reclaimable: true, owner: null };
    }
  }
  const sameHost = owner.hostname === os.hostname();
  if (sameHost && !processAlive(Number(owner.pid))) {
    return { reclaimable: true, owner };
  }
  const holderHeartbeats = Number.isFinite(Number(owner.leaseMs));
  const age = ownerMtimeMs === null ? Infinity : Date.now() - ownerMtimeMs;
  if (holderHeartbeats && age >= staleMs) return { reclaimable: true, owner };
  return { reclaimable: false, owner };
}

// Atomic rename means competing recoverers cannot both recursively delete the
// same directory. Returns null on success (or when another process already
// recovered it); returns the error when Windows refuses because a handle in
// the directory is still open — the caller retries or falls back, never crashes.
function reclaimStaleLock(lockDir) {
  const staleDir = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockDir, staleDir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return error;
  }
  try {
    fs.rmSync(staleDir, { recursive: true, force: true });
  } catch {
    /* an emptied-later tombstone is inert; never block acquisition on it */
  }
  return null;
}

function ephemeralFallback(runtimeDir, priorOwner, lockDir, blockedReason) {
  let ephemeral;
  try {
    mkdirPrivate(runtimeDir);
    ephemeral = fs.mkdtempSync(path.join(runtimeDir, "ephemeral-profile-"));
  } catch (error) {
    throw new Error(
      `BetterWright could not create a temporary browser profile under ${runtimeDir} ` +
        `(${error?.code || error}). If a sandbox restricts file writes, allow ` +
        "writes to this directory, or close the BetterWright process that owns " +
        "the persistent profile.",
    );
  }
  try {
    fs.chmodSync(ephemeral, 0o700);
  } catch {
    /* best effort on Windows */
  }
  const ownerText = priorOwner
    ? `pid ${priorOwner.pid || "?"} on ${priorOwner.hostname || "another host"}`
    : "another BetterWright process";
  const warning = blockedReason
    ? `The browser profile lock at ${lockDir} could not be acquired or recovered ` +
      `(${blockedReason}); using an isolated temporary profile without saved logins. ` +
      "If no other BetterWright browser is running, delete that directory to " +
      "restore the saved profile."
    : `Another BetterWright process owns the persistent browser profile (${ownerText}); ` +
      "using an isolated temporary profile without saved logins. If that process " +
      "is a leftover from an earlier session, close it and relaunch to reclaim " +
      "the saved profile; a lock left by a crashed process expires on its own " +
      "within about a minute.";
  return {
    profileDir: ephemeral,
    lockDir: null,
    ownerFile: null,
    owner: priorOwner,
    ephemeral: true,
    warning,
  };
}

// Windows sandboxes (and locked-down ACLs) can allow writes inside an existing
// profile directory while refusing to create new siblings next to it. Losing
// the advisory lock must not lose the user's saved logins: continue on the
// persistent profile and let Chromium's own singleton reject true concurrency.
function unlockedFallback(profileDir, lockDir, error) {
  try {
    mkdirPrivate(profileDir);
  } catch {
    /* the browser launch surfaces the real error if the profile is unusable */
  }
  return {
    profileDir,
    lockDir: null,
    ownerFile: null,
    owner: null,
    ephemeral: false,
    warning:
      `Could not create the browser profile lock at ${lockDir} ` +
      `(${error?.code || error}), which usually means a sandbox restricts ` +
      "writes there. Continuing with the persistent profile; the browser's " +
      "own profile lock still prevents concurrent use.",
  };
}

export function acquireProfileLock(profileDir, runtimeDir, options: any = {}) {
  const staleMs = Math.max(
    Number(options.staleMs) || PROFILE_LOCK_STALE_MS,
    1_000,
  );
  const lockDir = profileLockDirFor(profileDir);
  const ownerFile = path.join(lockDir, "owner.json");
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    token: crypto.randomBytes(16).toString("hex"),
    leaseMs: staleMs,
  };
  try {
    mkdirPrivate(path.dirname(profileDir));
  } catch {
    /* if the parent is truly unusable, the attempts below surface it */
  }

  let blocked = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (PERMISSION_CODES.has(error?.code)) {
          return unlockedFallback(profileDir, lockDir, error);
        }
        throw error;
      }
      const existing = inspectExistingLock(lockDir, ownerFile, staleMs);
      if (!existing.reclaimable) {
        return ephemeralFallback(runtimeDir, existing.owner, lockDir, null);
      }
      blocked = reclaimStaleLock(lockDir);
      continue;
    }
    try {
      fs.writeFileSync(ownerFile, JSON.stringify(owner), {
        encoding: "utf8",
        mode: 0o600,
      });
      mkdirPrivate(profileDir);
      return { profileDir, lockDir, ownerFile, owner, ephemeral: false, warning: "" };
    } catch (error) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (PERMISSION_CODES.has(error?.code)) {
        return unlockedFallback(profileDir, lockDir, error);
      }
      throw error;
    }
  }
  return ephemeralFallback(
    runtimeDir,
    null,
    lockDir,
    blocked ? `stale lock cleanup failed: ${blocked.code || blocked}` : "lock contention",
  );
}

export function profileLockHeldByUs(lock) {
  if (!lock?.ownerFile || !lock.owner?.token) return false;
  try {
    return readOwner(lock.ownerFile)?.token === lock.owner.token;
  } catch {
    return false;
  }
}

// Refresh the lease so other processes keep seeing a live owner. Returns false
// once the lock is no longer ours (stolen after a stall, or deleted) so the
// caller can stop heartbeating a file it no longer owns.
export function touchProfileLock(lock) {
  if (!profileLockHeldByUs(lock)) return false;
  try {
    const now = new Date();
    fs.utimesSync(lock.ownerFile, now, now);
    return true;
  } catch {
    return false;
  }
}

export function releaseProfileLockDir(lock) {
  if (!lock?.lockDir) return;
  if (!profileLockHeldByUs(lock)) return;
  try {
    fs.rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    /* a leftover lock with a dead pid expires on its own */
  }
}
