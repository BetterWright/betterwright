import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { BetterWright } from "../../dist/src/index.js";
import {
  acquireProfileLock,
  profileLockDirFor,
  releaseProfileLockDir,
} from "../../dist/src/profile-lock.js";
import {
  isReservedProfileName,
  MAX_PROFILE_NAME_LENGTH,
  profileDirFor,
  resolveProfileName,
} from "../../dist/src/profile-name.js";
import { makeTempDir } from "./helpers/temp-dir.mjs";

// --- Name validation -------------------------------------------------------

test("resolveProfileName returns null when no profile is given", () => {
  assert.equal(resolveProfileName(undefined), null);
  assert.equal(resolveProfileName(null), null);
});

test("resolveProfileName accepts ordinary names and trims surrounding space", () => {
  for (const name of ["social", "review", "work-1", "a.b_c", "Social", "X"]) {
    assert.equal(resolveProfileName(name), name);
  }
  assert.equal(resolveProfileName("  social  "), "social");
  // "console" merely starts with a reserved name; it is not itself reserved.
  assert.equal(resolveProfileName("console"), "console");
});

test("resolveProfileName rejects traversal, separators, and absolute paths", () => {
  for (const bad of [
    "",
    "   ",
    "..",
    ".",
    "a/b",
    "a\\b",
    "/abs",
    "../escape",
    "./x",
    ".hidden",
    "-flag",
    "a/../b",
    "profiles/x",
    "a b",
    "a\tb",
    "a\u0000b",
  ]) {
    assert.throws(
      () => resolveProfileName(bad),
      TypeError,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test("resolveProfileName rejects OS-reserved device names on every platform", () => {
  for (const bad of ["con", "CON", "nul", "Nul", "com1", "LPT9", "aux", "prn"]) {
    assert.ok(isReservedProfileName(bad));
    assert.throws(() => resolveProfileName(bad), TypeError);
  }
});

test("resolveProfileName rejects non-strings and over-long names", () => {
  assert.throws(() => resolveProfileName(5), TypeError);
  assert.throws(() => resolveProfileName({}), TypeError);
  assert.throws(
    () => resolveProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH + 1)),
    TypeError,
  );
  assert.equal(
    resolveProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH)).length,
    MAX_PROFILE_NAME_LENGTH,
  );
});

// --- Path layout -----------------------------------------------------------

test("profileDirFor keeps the default profile path byte-for-byte", () => {
  const root = path.join("home", "browser");
  // Exactly the value the client computed before named profiles existed.
  assert.equal(profileDirFor(root), path.join(root, "profile"));
  assert.equal(profileDirFor(root, undefined), path.join(root, "profile"));
  assert.equal(profileDirFor(root, null), path.join(root, "profile"));
});

test("profileDirFor nests named profiles under profiles/<name>", () => {
  const root = path.join("home", "browser");
  assert.equal(profileDirFor(root, "social"), path.join(root, "profiles", "social"));
  assert.equal(profileDirFor(root, "review"), path.join(root, "profiles", "review"));
  assert.throws(() => profileDirFor(root, "a/b"), TypeError);
});

// --- Lock behaviour: default unchanged -------------------------------------

test("the default profile uses the historical lock location", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const def = profileDirFor(browser);
  assert.equal(def, path.join(browser, "profile"));

  const lock = acquireProfileLock(def, runtime);
  try {
    assert.equal(lock.ephemeral, false);
    assert.equal(lock.profileDir, path.join(browser, "profile"));
    assert.equal(lock.lockDir, profileLockDirFor(path.join(browser, "profile")));
  } finally {
    releaseProfileLockDir(lock);
  }
});

// --- Lock behaviour: concurrent DIFFERENT profiles -------------------------

test("different named profiles hold independent locks and run concurrently", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const social = profileDirFor(browser, "social");
  const review = profileDirFor(browser, "review");
  assert.equal(social, path.join(browser, "profiles", "social"));

  const a = acquireProfileLock(social, runtime);
  const b = acquireProfileLock(review, runtime);
  try {
    // Neither falls back: both own their own persistent profile at once, so a
    // logged-in "social" and a logged-in "review" run side by side.
    assert.equal(a.ephemeral, false);
    assert.equal(b.ephemeral, false);
    assert.equal(a.profileDir, social);
    assert.equal(b.profileDir, review);
    assert.notEqual(a.lockDir, b.lockDir);
    assert.ok(fs.existsSync(a.lockDir));
    assert.ok(fs.existsSync(b.lockDir));
    assert.ok(fs.existsSync(social));
    assert.ok(fs.existsSync(review));
  } finally {
    releaseProfileLockDir(a);
    releaseProfileLockDir(b);
  }
});

// --- Lock behaviour: concurrent SAME profile -------------------------------

test("the same named profile still serializes with the ephemeral fallback", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const social = profileDirFor(browser, "social");

  const first = acquireProfileLock(social, runtime);
  const second = acquireProfileLock(social, runtime);
  try {
    assert.equal(first.ephemeral, false);
    assert.equal(first.profileDir, social);
    // The contended second instance gets an isolated ephemeral profile under
    // the SHARED runtime dir — exactly how the default profile behaves today,
    // so a named profile is never corrupted by concurrent same-name use.
    assert.equal(second.ephemeral, true);
    assert.notEqual(second.profileDir, social);
    assert.ok(second.profileDir.startsWith(runtime));
    assert.match(second.warning, /temporary profile without saved logins/);
  } finally {
    releaseProfileLockDir(first);
    releaseProfileLockDir(second);
  }
});

// --- Client layer: shared vs scoped ----------------------------------------

test("BetterWright scopes only the profile directory; vault, artifacts, runtime stay shared", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const def = new BetterWright({ home });
  const social = new BetterWright({ home, profile: "social" });
  const review = new BetterWright({ home, profile: "review" });
  try {
    const c0 = def._workerConfig();
    const cs = social._workerConfig();
    const cr = review._workerConfig();

    // Default is byte-for-byte the historical path; names nest under profiles/.
    assert.equal(c0.profileDir, path.join(home, "browser", "profile"));
    assert.equal(cs.profileDir, path.join(home, "browser", "profiles", "social"));
    assert.equal(cr.profileDir, path.join(home, "browser", "profiles", "review"));
    assert.notEqual(cs.profileDir, cr.profileDir);

    // Everything else is shared across profiles.
    for (const key of ["runtimeDir", "artifactsDir", "downloadsDir"]) {
      assert.equal(cs[key], c0[key]);
      assert.equal(cr[key], c0[key]);
    }
    // The vault is shared: same encrypted store regardless of profile, so a
    // credential saved once is reachable from every profile.
    assert.equal(def.vault.dir, path.join(home, "vault"));
    assert.equal(social.vault.dir, def.vault.dir);
    assert.equal(review.vault.dir, def.vault.dir);
  } finally {
    await def.close();
    await social.close();
    await review.close();
  }
});

test("BetterWright rejects an invalid profile name at construction", () => {
  const home = makeTempDir("bw-profiles-home-");
  for (const bad of ["a/b", "..", "/abs", "", "con"]) {
    assert.throws(() => new BetterWright({ home, profile: bad }), TypeError);
  }
});
