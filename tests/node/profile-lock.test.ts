import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireProfileLock,
  profileLockDirFor,
  profileLockHeldByUs,
  releaseProfileLockDir,
  touchProfileLock,
} from "../../dist/src/profile-lock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function makeRoot() {
  const root = makeTempDir("bw-profile-lock-");
  return {
    root,
    profileDir: path.join(root, "profile"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function writeOwner(profileDir, owner, { ageMs = 0 } = {}) {
  const lockDir = profileLockDirFor(profileDir);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const ownerFile = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(ownerFile, then, then);
    fs.utimesSync(lockDir, then, then);
  }
  return ownerFile;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

test("acquires a fresh lock and releases it", () => {
  const { profileDir, runtimeDir } = makeRoot();
  const lock = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(lock.ephemeral, false);
  assert.equal(lock.profileDir, profileDir);
  assert.ok(fs.existsSync(lock.ownerFile));
  const owner = JSON.parse(fs.readFileSync(lock.ownerFile, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.token);
  assert.ok(Number.isFinite(owner.leaseMs));
  assert.ok(profileLockHeldByUs(lock));
  releaseProfileLockDir(lock);
  assert.equal(fs.existsSync(lock.lockDir), false);
});

test("falls back to an ephemeral profile while a live owner heartbeats", () => {
  const { profileDir, runtimeDir } = makeRoot();
  const first = acquireProfileLock(profileDir, runtimeDir);
  const second = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(second.ephemeral, true);
  assert.notEqual(second.profileDir, profileDir);
  assert.match(second.warning, /pid \d+/);
  assert.match(second.warning, /reclaim the saved profile/);
  releaseProfileLockDir(first);
});

test("reclaims a lock whose owner pid is dead on this host", async () => {
  const { profileDir, runtimeDir } = makeRoot();
  writeOwner(profileDir, {
    pid: await deadPid(),
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  });
  const lock = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(lock.ephemeral, false);
  assert.equal(lock.profileDir, profileDir);
  releaseProfileLockDir(lock);
});

test("reclaims a stale-heartbeat lock even when the pid is alive (pid reuse)", () => {
  // Windows recycles pids quickly, so a hard-killed worker's pid often points
  // at an unrelated live process. The heartbeat lease is the tiebreaker.
  const { profileDir, runtimeDir } = makeRoot();
  writeOwner(
    profileDir,
    {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: "someone-else",
      leaseMs: 60_000,
    },
    { ageMs: 10 * 60_000 },
  );
  const lock = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(lock.ephemeral, false);
  assert.equal(lock.profileDir, profileDir);
  releaseProfileLockDir(lock);
});

test("never steals a legacy-format lock with a live pid, no matter how old", () => {
  const { profileDir, runtimeDir } = makeRoot();
  writeOwner(
    profileDir,
    {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    },
    { ageMs: 24 * 60 * 60_000 },
  );
  const lock = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(lock.ephemeral, true);
});

test("keeps a corrupt lock briefly, then reclaims it after the stale window", () => {
  const { profileDir, runtimeDir } = makeRoot();
  const lockDir = profileLockDirFor(profileDir);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockDir, "owner.json"), "{not json");

  const young = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(young.ephemeral, true);

  const then = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(lockDir, "owner.json"), then, then);
  fs.utimesSync(lockDir, then, then);
  const reclaimed = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(reclaimed.ephemeral, false);
  releaseProfileLockDir(reclaimed);
});

test("touchProfileLock refreshes the lease and detects theft", () => {
  const { profileDir, runtimeDir } = makeRoot();
  const lock = acquireProfileLock(profileDir, runtimeDir);
  const then = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock.ownerFile, then, then);
  assert.equal(touchProfileLock(lock), true);
  assert.ok(Date.now() - fs.statSync(lock.ownerFile).mtimeMs < 60_000);

  fs.writeFileSync(
    lock.ownerFile,
    JSON.stringify({ ...lock.owner, token: "thief" }),
  );
  assert.equal(touchProfileLock(lock), false);
  assert.equal(profileLockHeldByUs(lock), false);
  // Releasing must not delete a lock we no longer own.
  releaseProfileLockDir(lock);
  assert.equal(fs.existsSync(lock.lockDir), true);
});

test("degrades to the persistent profile unlocked when the lock cannot be created", (t) => {
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    t.skip("permission simulation is a no-op for root");
    return;
  }
  const { root, profileDir, runtimeDir } = makeRoot();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o500);
  t.after(() => fs.chmodSync(root, 0o700));
  const lock = acquireProfileLock(profileDir, runtimeDir);
  assert.equal(lock.ephemeral, false);
  assert.equal(lock.profileDir, profileDir);
  assert.equal(lock.lockDir, null);
  assert.match(lock.warning, /Could not create the browser profile lock/);
});
