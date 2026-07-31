// Named browser profiles: one home, several separate identities.
//
// The invariants these tests pin, in the order they matter:
//   1. Omitting `profile` changes NOTHING on disk — same profile directory,
//      same lock, same daemon socket, same transcript path. An upgrade must
//      not misplace anyone's logins.
//   2. A name can never escape `browser/profiles/`, and can never name another
//      profile's lock directory (which the lock reclaimer is entitled to
//      `rm -rf`).
//   3. Different profiles are independent everywhere it counts: lock, daemon,
//      cookie jar, exec transcript. Same profile still serializes onto the
//      ephemeral fallback exactly as the single default profile does today.
//   4. What is deliberately SHARED stays shared: vault, artifacts, runtime.
//
// The end-to-end half — real browsers, real cookie jars — lives in
// browser.test.ts, which is where this repo keeps tests that need the managed
// runtime installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBrowserFromDaemonConfig,
  daemonConfigSignature,
  daemonInfoPath,
  daemonLogPath,
  daemonProfilesInHome,
  daemonSocketPath,
  normalizeDaemonConfig,
  startSessionDaemon,
} from "../../dist/src/daemon.js";
import { connectSessionDaemon } from "../../dist/src/daemon-client.js";
import { BetterWright } from "../../dist/src/index.js";
import { profileFromEnv } from "../../dist/src/mcp-server.js";
import {
  acquireProfileLock,
  PROFILE_LOCK_SUFFIX,
  profileLockDirFor,
  releaseProfileLockDir,
} from "../../dist/src/profile-lock.js";
import {
  isReservedProfileName,
  MAX_PROFILE_NAME_LENGTH,
  profileDirFor,
  profileFileSuffix,
  profileLabel,
  resolveProfileName,
} from "../../dist/src/profile-name.js";
import {
  clearTranscript,
  loadTranscript,
  saveTranscript,
  transcriptPath,
} from "../../dist/src/session-store.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "dist", "bin", "betterwright.js");

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

test("resolveProfileName returns null when no profile is given", () => {
  assert.equal(resolveProfileName(undefined), null);
  assert.equal(resolveProfileName(null), null);
});

test("resolveProfileName accepts ordinary names and trims surrounding space", () => {
  for (const name of ["social", "review", "work-1", "a.b_c", "Social", "X", "9lives"]) {
    assert.equal(resolveProfileName(name), name);
  }
  assert.equal(resolveProfileName("  social  "), "social");
  // "console" merely starts with a reserved name; it is not itself reserved.
  assert.equal(resolveProfileName("console"), "console");
  assert.equal(resolveProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH)).length, MAX_PROFILE_NAME_LENGTH);
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
    "C:\\abs",
    "../escape",
    "..%2fescape",
    "./x",
    ".hidden",
    "-flag",
    "_leading",
    "a/../b",
    "profiles/x",
    "a b",
    "a\tb",
    "a\nb",
    "a\u0000b",
    "naïve",
    "🙂",
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
  // Only the exact device names are reserved.
  assert.equal(resolveProfileName("connect"), "connect");
  assert.equal(resolveProfileName("com10"), "com10");
});

test("resolveProfileName rejects non-strings, empties, and over-long names", () => {
  for (const bad of [5, {}, [], true, Symbol("x"), () => {}]) {
    assert.throws(() => resolveProfileName(bad), TypeError, `should reject ${String(bad)}`);
  }
  assert.throws(() => resolveProfileName("a".repeat(MAX_PROFILE_NAME_LENGTH + 1)), TypeError);
});

test("resolveProfileName rejects a trailing dot, which Windows would swallow", () => {
  // "social." and "social" are one directory on Windows and two elsewhere;
  // refuse the ambiguity rather than let a home mean two different things.
  assert.throws(() => resolveProfileName("social."), TypeError);
  assert.throws(() => resolveProfileName("a.b."), TypeError);
  assert.equal(resolveProfileName("a.b"), "a.b");
});

test("resolveProfileName rejects the lock namespace, in any case, anywhere", () => {
  // THE data-loss case: `browser/profiles/social.betterwright-lock` is where
  // profile "social" puts its lock. A profile allowed to take that name would
  // (a) make "social" fall back to a signed-out ephemeral browser and (b) be
  // deleted by the stale-lock reclaimer, cookies and all.
  for (const bad of [
    `social${PROFILE_LOCK_SUFFIX}`,
    `SOCIAL${PROFILE_LOCK_SUFFIX.toUpperCase()}`,
    `social${PROFILE_LOCK_SUFFIX}.stale-1234-deadbeef`,
    `x.BetterWright-Lock`,
    `a.betterwright-lock.b`,
  ]) {
    assert.throws(
      () => resolveProfileName(bad),
      /reserved for BetterWright's profile locks/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  // A name that merely mentions "lock" is fine.
  assert.equal(resolveProfileName("locked"), "locked");
  assert.equal(resolveProfileName("betterwright-lock"), "betterwright-lock");
});

test("no accepted name can name another profile's lock directory or tombstone", () => {
  // Property, not anecdote: for every name the validator accepts, the
  // directory it resolves to is never the lock directory (or a `.stale-…`
  // tombstone of one) belonging to any other accepted name.
  const root = path.join("home", "browser");
  const accepted = [];
  const candidates = [
    "social",
    "review",
    "a",
    "a.b",
    "a-b_c",
    "Social",
    "x".repeat(MAX_PROFILE_NAME_LENGTH),
    `social${PROFILE_LOCK_SUFFIX}`,
    `social${PROFILE_LOCK_SUFFIX}.stale-9-ff`,
    "social.",
    "../x",
  ];
  for (const name of candidates) {
    try {
      accepted.push(resolveProfileName(name));
    } catch {
      /* rejected names cannot collide with anything */
    }
  }
  assert.ok(accepted.length >= 7);
  const dirs = new Set(accepted.map((name) => profileDirFor(root, name)));
  for (const name of accepted) {
    const lockDir = profileLockDirFor(profileDirFor(root, name));
    assert.ok(!dirs.has(lockDir), `${lockDir} is reachable as a profile directory`);
    assert.ok(!dirs.has(`${lockDir}.stale-1-a`), "a tombstone path is reachable as a profile");
  }
});

test("fuzz: every hostile name is either rejected or stays inside profiles/", () => {
  const root = path.resolve("/tmp/bw-fuzz-root/browser");
  const parent = path.join(root, "profiles");
  const pieces = ["a", ".", "..", "/", "\\", "-", "_", "\u0000", " ", "%2e", "~", "*", ":", "$", "\n"];
  const names = [];
  for (const one of pieces) {
    names.push(one);
    for (const two of pieces) {
      names.push(one + two, `a${one}${two}`, `${one}a${two}`, `${one}${two}a`);
    }
  }
  names.push("....//....//etc", "..\\..\\windows", "a".repeat(500), "\u202e", "-rf");
  let accepted = 0;
  for (const name of names) {
    let dir;
    try {
      dir = profileDirFor(root, name);
    } catch (error) {
      assert.ok(error instanceof TypeError, `${JSON.stringify(name)} threw ${error}`);
      continue;
    }
    accepted += 1;
    const resolved = path.resolve(dir);
    assert.equal(
      path.dirname(resolved),
      parent,
      `${JSON.stringify(name)} escaped to ${resolved}`,
    );
    assert.ok(!path.basename(resolved).includes(PROFILE_LOCK_SUFFIX));
  }
  // A fuzz corpus that rejected everything would prove nothing.
  assert.ok(accepted > 0, "the fuzz corpus accepted no names at all");
});

// ---------------------------------------------------------------------------
// Path layout
// ---------------------------------------------------------------------------

test("profileDirFor keeps the default profile path byte-for-byte", () => {
  const root = path.join("home", "browser");
  // Exactly the value the client computed before named profiles existed.
  for (const none of [undefined, null]) {
    assert.equal(profileDirFor(root, none), path.join(root, "profile"));
  }
  assert.equal(profileDirFor(root), path.join(root, "profile"));
});

test("profileDirFor nests named profiles under profiles/<name>", () => {
  const root = path.join("home", "browser");
  assert.equal(profileDirFor(root, "social"), path.join(root, "profiles", "social"));
  assert.equal(profileDirFor(root, "review"), path.join(root, "profiles", "review"));
  assert.throws(() => profileDirFor(root, "a/b"), TypeError);
});

test("profileFileSuffix keeps default filenames bare and scopes named ones", () => {
  assert.equal(profileFileSuffix(), "");
  assert.equal(profileFileSuffix(null), "");
  assert.equal(profileFileSuffix("social"), "-social");
  assert.throws(() => profileFileSuffix("a/b"), TypeError);
  assert.equal(profileLabel(null), "default");
  assert.equal(profileLabel("social"), '"social"');
});

// ---------------------------------------------------------------------------
// Profile locks
// ---------------------------------------------------------------------------

test("the default profile uses the historical lock location", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const def = profileDirFor(browser);
  assert.equal(def, path.join(browser, "profile"));

  const lock = acquireProfileLock(def, runtime);
  try {
    assert.equal(lock.ephemeral, false);
    assert.equal(lock.profileDir, path.join(browser, "profile"));
    assert.equal(lock.lockDir, `${path.join(browser, "profile")}${PROFILE_LOCK_SUFFIX}`);
  } finally {
    releaseProfileLockDir(lock);
  }
});

test("different named profiles hold independent locks and run concurrently", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const social = profileDirFor(browser, "social");
  const review = profileDirFor(browser, "review");

  const a = acquireProfileLock(social, runtime);
  const b = acquireProfileLock(review, runtime);
  try {
    // Neither falls back: both own a persistent profile at the same time.
    assert.equal(a.ephemeral, false);
    assert.equal(b.ephemeral, false);
    assert.equal(a.profileDir, social);
    assert.equal(b.profileDir, review);
    assert.notEqual(a.lockDir, b.lockDir);
    for (const dir of [a.lockDir, b.lockDir, social, review]) assert.ok(fs.existsSync(dir));
    // Both locks live beside their profile, inside profiles/.
    assert.equal(path.dirname(a.lockDir), path.join(browser, "profiles"));
  } finally {
    releaseProfileLockDir(a);
    releaseProfileLockDir(b);
  }
});

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
    // the SHARED runtime dir — exactly how the default profile behaves today.
    assert.equal(second.ephemeral, true);
    assert.notEqual(second.profileDir, social);
    assert.ok(second.profileDir.startsWith(runtime));
    assert.match(second.warning, /temporary profile without saved logins/);
  } finally {
    releaseProfileLockDir(first);
    releaseProfileLockDir(second);
  }
});

test("many profiles lock concurrently; many claims on one profile serialize", () => {
  const browser = makeTempDir("bw-profiles-");
  const runtime = path.join(browser, "runtime");
  const spread = ["p1", "p2", "p3", "p4", "p5", "p6"].map((name) =>
    acquireProfileLock(profileDirFor(browser, name), runtime),
  );
  const contended = Array.from({ length: 4 }, () =>
    acquireProfileLock(profileDirFor(browser, "shared"), runtime),
  );
  try {
    assert.equal(spread.filter((lock) => !lock.ephemeral).length, 6);
    assert.equal(new Set(spread.map((lock) => lock.profileDir)).size, 6);
    assert.equal(contended.filter((lock) => !lock.ephemeral).length, 1);
    assert.equal(contended.filter((lock) => lock.ephemeral).length, 3);
  } finally {
    for (const lock of [...spread, ...contended]) releaseProfileLockDir(lock);
  }
});

// ---------------------------------------------------------------------------
// Client wiring
// ---------------------------------------------------------------------------

test("BetterWright scopes only the profile directory; vault, artifacts, runtime stay shared", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const def = new BetterWright({ home });
  const social = new BetterWright({ home, profile: "social" });
  const review = new BetterWright({ home, profile: "review" });
  try {
    assert.equal(def.profile, null);
    assert.equal(social.profile, "social");

    const c0 = def._workerConfig();
    const cs = social._workerConfig();
    const cr = review._workerConfig();

    assert.equal(c0.profileDir, path.join(home, "browser", "profile"));
    assert.equal(cs.profileDir, path.join(home, "browser", "profiles", "social"));
    assert.equal(cr.profileDir, path.join(home, "browser", "profiles", "review"));

    for (const key of ["runtimeDir", "artifactsDir", "downloadsDir"]) {
      assert.equal(cs[key], c0[key]);
      assert.equal(cr[key], c0[key]);
    }
    // One vault per home: a credential saved from any profile is usable from
    // every profile, which is the whole point of not scoping it.
    assert.equal(def.vault.dir, path.join(home, "vault"));
    assert.equal(social.vault.dir, def.vault.dir);
    assert.equal(review.vault.dir, def.vault.dir);
  } finally {
    await Promise.all([def.close(), social.close(), review.close()]);
  }
});

test("an existing default profile is used untouched when no name is given", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const legacy = path.join(home, "browser", "profile");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "Cookies"), "existing-login");

  const bw = new BetterWright({ home });
  try {
    assert.equal(bw._workerConfig().profileDir, legacy);
    // No migration, move, or copy: the bytes that were there are still there,
    // and nothing was created under profiles/.
    assert.equal(fs.readFileSync(path.join(legacy, "Cookies"), "utf8"), "existing-login");
    assert.equal(fs.existsSync(path.join(home, "browser", "profiles")), false);
  } finally {
    await bw.close();
  }
});

test("BetterWright rejects an invalid profile name at construction", () => {
  const home = makeTempDir("bw-profiles-home-");
  for (const bad of ["a/b", "..", "/abs", "", "con", "x.betterwright-lock", 7]) {
    assert.throws(() => new BetterWright({ home, profile: bad }), TypeError);
  }
});

// ---------------------------------------------------------------------------
// Daemon: one per (home, profile)
// ---------------------------------------------------------------------------

test("daemon paths keep their historical names for the default profile", () => {
  const home = "/tmp/bw-home";
  assert.equal(daemonSocketPath(home), path.join(home, "daemon.sock"));
  assert.equal(daemonInfoPath(home), path.join(home, "daemon.json"));
  assert.equal(daemonLogPath(home), path.join(home, "daemon.log"));
  assert.equal(daemonSocketPath(home, null), path.join(home, "daemon.sock"));
});

test("each named profile gets its own socket, info file, and log", () => {
  const home = "/tmp/bw-home";
  assert.equal(daemonSocketPath(home, "social"), path.join(home, "daemon-social.sock"));
  assert.equal(daemonInfoPath(home, "social"), path.join(home, "daemon-social.json"));
  assert.equal(daemonLogPath(home, "social"), path.join(home, "daemon-social.log"));
  const paths = new Set([
    daemonSocketPath(home),
    daemonSocketPath(home, "social"),
    daemonSocketPath(home, "review"),
  ]);
  assert.equal(paths.size, 3);
  assert.throws(() => daemonSocketPath(home, "a/b"), TypeError);
});

test("the over-long-home fallback socket stays short and distinct per profile", () => {
  const deep = `/tmp/${"nested/".repeat(20)}home`;
  const def = daemonSocketPath(deep);
  const social = daemonSocketPath(deep, "social");
  const review = daemonSocketPath(deep, "review");
  for (const socketPath of [def, social, review]) {
    // The kernel rejects an over-long sun_path with EINVAL rather than
    // truncating, so a named profile must never push it past the limit.
    assert.ok(Buffer.byteLength(socketPath) <= 100, `${socketPath} is too long`);
    assert.ok(!socketPath.startsWith(deep));
  }
  assert.equal(new Set([def, social, review]).size, 3);
  // Stable across calls, so client and daemon agree.
  assert.equal(daemonSocketPath(deep, "social"), social);
});

test("daemonProfilesInHome lists every daemon in a home, default first", () => {
  const home = makeTempDir("bw-profiles-home-");
  assert.deepEqual(daemonProfilesInHome(home), []);
  fs.writeFileSync(path.join(home, "daemon-social.json"), "{}");
  fs.writeFileSync(path.join(home, "daemon.json"), "{}");
  fs.writeFileSync(path.join(home, "daemon-review.json"), "{}");
  // Junk that this code could not have written is ignored rather than trusted.
  fs.writeFileSync(path.join(home, "daemon-.json"), "{}");
  fs.writeFileSync(path.join(home, "daemon-a b.json"), "{}");
  fs.writeFileSync(path.join(home, "daemon.log"), "");
  fs.writeFileSync(path.join(home, "notes.json"), "{}");
  assert.deepEqual(daemonProfilesInHome(home), [null, "review", "social"]);
  assert.deepEqual(daemonProfilesInHome(path.join(home, "missing")), []);
});

test("the daemon config signature carries the profile", () => {
  // The default profile's signature must stay byte-identical to the
  // pre-profiles one, so an upgrade reuses a running daemon rather than
  // dropping the call onto a locked profile and a signed-out browser.
  assert.equal(Object.hasOwn(normalizeDaemonConfig({}), "profile"), false);
  assert.equal(
    daemonConfigSignature({}),
    JSON.stringify({
      protocol: normalizeDaemonConfig({}).protocol,
      headless: true,
      policy: { allowLoopback: true, allowPrivateNetwork: true, allowHosts: [], blockHosts: [] },
      cloak: normalizeDaemonConfig({}).cloak,
    }),
  );
  assert.equal(normalizeDaemonConfig({ profile: "social" }).profile, "social");
  assert.notEqual(daemonConfigSignature({}), daemonConfigSignature({ profile: "social" }));
  assert.equal(
    daemonConfigSignature({ profile: "social" }),
    daemonConfigSignature({ profile: " social " }),
  );
  assert.throws(() => normalizeDaemonConfig({ profile: "a/b" }), TypeError);
});

test("createBrowserFromDaemonConfig builds the browser on the requested profile", async () => {
  const home = makeTempDir("bw-profiles-home-");
  process.env.BETTERWRIGHT_HOME = home;
  try {
    const def = await createBrowserFromDaemonConfig({});
    const named = await createBrowserFromDaemonConfig({ profile: "social" });
    try {
      assert.equal(def.profile, null);
      assert.equal(named.profile, "social");
      assert.equal(
        named._workerConfig().profileDir,
        path.join(home, "browser", "profiles", "social"),
      );
    } finally {
      await Promise.all([def.close(), named.close()]);
    }
  } finally {
    delete process.env.BETTERWRIGHT_HOME;
  }
});

function stubBrowser(label) {
  return {
    label,
    vault: {},
    run: async (code, options) => ({ ok: true, result: `${label}:${code}`, session: options.session }),
    closeSession: async () => ({ ok: true, closed: true, pagesClosed: 1 }),
    close: async () => {},
  };
}

test("two profiles keep separate daemons, sessions, and lifecycles in one home", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const daemons = [];
  const start = async (profile, label) => {
    const daemon = await startSessionDaemon({
      home,
      config: { profile },
      createBrowser: () => stubBrowser(label),
      emptyGraceMs: 60_000,
      // close() would otherwise call process.exit and end the test run.
      onExit: () => {},
      log: () => {},
    });
    daemons.push(daemon);
    return daemon;
  };
  try {
    const socialDaemon = await start("social", "SOCIAL");
    const reviewDaemon = await start("review", "REVIEW");
    // Two daemons, two sockets, one home — the default profile's socket is
    // untouched and free for a third.
    assert.equal(socialDaemon.socketPath, daemonSocketPath(home, "social"));
    assert.equal(reviewDaemon.socketPath, daemonSocketPath(home, "review"));
    assert.deepEqual(daemonProfilesInHome(home), ["review", "social"]);

    const connect = (profile) =>
      connectSessionDaemon({ home, profile, spawnIfNeeded: false, cliPath: "unused" });

    const social = await connect("social");
    const review = await connect("review");
    assert.ok(social.ok && review.ok, "both daemons should answer");
    assert.equal(social.hello.profile, "social");
    assert.equal(review.hello.profile, "review");
    assert.notEqual(social.hello.pid ?? 0, undefined);

    // A run goes to the daemon of its own profile, on its own browser.
    const ran = await social.channel.request(
      { op: "call", method: "run", args: ["1+1"], session: "default" },
      10_000,
    );
    assert.equal(ran.result.result, "SOCIAL:1+1");

    // Sessions are per daemon: "default" on social is invisible to review.
    const socialStatus = await social.channel.request({ op: "status" }, 10_000);
    const reviewStatus = await review.channel.request({ op: "status" }, 10_000);
    assert.deepEqual(
      socialStatus.sessions.map((entry) => entry.name),
      ["default"],
    );
    assert.deepEqual(reviewStatus.sessions, []);
    social.channel.end();
    review.channel.end();

    // Shutting one identity down leaves the other running — the interference
    // that makes "concurrent identities" real rather than nominal.
    await socialDaemon.close();
    const afterSocial = await connect("social");
    const stillReview = await connect("review");
    assert.equal(afterSocial.ok, false);
    assert.match(afterSocial.reason, /no session daemon is running for profile "social"/);
    assert.equal(stillReview.ok, true);
    assert.equal(stillReview.hello.profile, "review");
    stillReview.channel.end();
    // A clean shutdown takes its own info file with it and leaves the other's.
    assert.deepEqual(daemonProfilesInHome(home), ["review"]);
  } finally {
    for (const daemon of daemons) await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a client asking for a profile never lands on another profile's daemon", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const daemon = await startSessionDaemon({
    home,
    config: { profile: "social" },
    createBrowser: () => stubBrowser("SOCIAL"),
    emptyGraceMs: 60_000,
    // close() would otherwise call process.exit and end the test run.
    onExit: () => {},
    log: () => {},
  });
  try {
    // The default profile has no daemon here; with spawning disabled the
    // client must report that rather than reuse the "social" one.
    const asDefault = await connectSessionDaemon({ home, spawnIfNeeded: false, cliPath: "unused" });
    assert.equal(asDefault.ok, false);
    assert.match(asDefault.reason, /no session daemon is running for profile default/);

    const asSocial = await connectSessionDaemon({
      home,
      config: { profile: "social" },
      spawnIfNeeded: false,
      cliPath: "unused",
    });
    assert.equal(asSocial.ok, true, "config.profile alone should select the daemon");
    assert.equal(asSocial.hello.profile, "social");
    asSocial.channel.end();
  } finally {
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the daemon records the profile it serves in its info file", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const daemon = await startSessionDaemon({
    home,
    config: { profile: "social" },
    createBrowser: () => stubBrowser("SOCIAL"),
    emptyGraceMs: 60_000,
    // close() would otherwise call process.exit and end the test run.
    onExit: () => {},
    log: () => {},
  });
  try {
    const info = JSON.parse(fs.readFileSync(daemonInfoPath(home, "social"), "utf8"));
    assert.equal(info.profile, "social");
    assert.equal(info.socket, daemonSocketPath(home, "social"));
    assert.equal(fs.existsSync(daemonInfoPath(home)), false);
  } finally {
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exec transcripts
// ---------------------------------------------------------------------------

test("transcripts keep their historical path for the default profile", () => {
  const home = "/tmp/bw-home";
  assert.equal(
    transcriptPath(home, "default"),
    path.join(home, "sessions", "default", "transcript.json"),
  );
  assert.equal(transcriptPath(home, "default", null), transcriptPath(home, "default"));
});

test("two profiles with the same session name do not share exec history", () => {
  const home = makeTempDir("bw-profiles-home-");
  const messages = (text) => [{ role: "user", content: text }];

  saveTranscript(home, "default", messages("default work"), {}, null);
  saveTranscript(home, "default", messages("social work"), {}, "social");
  saveTranscript(home, "default", messages("review work"), {}, "review");

  assert.equal(loadTranscript(home, "default")[0].content, "default work");
  assert.equal(loadTranscript(home, "default", "social")[0].content, "social work");
  assert.equal(loadTranscript(home, "default", "review")[0].content, "review work");

  // Named profiles live in a namespace a session name can never reach: a
  // sanitized session name always starts with a letter or digit.
  assert.equal(
    transcriptPath(home, "default", "social"),
    path.join(home, "sessions", "@social", "default", "transcript.json"),
  );

  // Clearing one identity's history leaves the others alone.
  clearTranscript(home, "default", "social");
  assert.deepEqual(loadTranscript(home, "default", "social"), []);
  assert.equal(loadTranscript(home, "default")[0].content, "default work");
  assert.equal(loadTranscript(home, "default", "review")[0].content, "review work");
});

test("the daemon persists exec history under its own profile", async () => {
  const home = makeTempDir("bw-profiles-home-");
  const daemon = await startSessionDaemon({
    home,
    config: { profile: "social" },
    createBrowser: () => stubBrowser("SOCIAL"),
    emptyGraceMs: 60_000,
    // close() would otherwise call process.exit and end the test run.
    onExit: () => {},
    log: () => {},
    runTask: async ({ task }) => ({
      ok: true,
      answer: `did ${task}`,
      steps: 1,
      toolCalls: 0,
      reason: "done",
      usage: {},
      durationMs: 1,
      transcript: [{ role: "user", content: `task:${task}` }],
    }),
  });
  try {
    const outcome = await connectSessionDaemon({
      home,
      profile: "social",
      spawnIfNeeded: false,
      cliPath: "unused",
    });
    assert.equal(outcome.ok, true);
    await outcome.channel.request({ op: "exec", task: "check mail", session: "default" }, 20_000);
    outcome.channel.end();

    assert.equal(loadTranscript(home, "default", "social")[0].content, "task:check mail");
    // Nothing leaked into the default profile's history.
    assert.deepEqual(loadTranscript(home, "default"), []);
  } finally {
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MCP + CLI surfaces
// ---------------------------------------------------------------------------

test("profileFromEnv reads BETTERWRIGHT_PROFILE and validates it", () => {
  assert.equal(profileFromEnv({}), null);
  assert.equal(profileFromEnv({ BETTERWRIGHT_PROFILE: "" }), null);
  assert.equal(profileFromEnv({ BETTERWRIGHT_PROFILE: "   " }), null);
  assert.equal(profileFromEnv({ BETTERWRIGHT_PROFILE: " social " }), "social");
  assert.throws(() => profileFromEnv({ BETTERWRIGHT_PROFILE: "../escape" }), TypeError);
});

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    input: "",
    env: { ...process.env, ...env },
  });
}

test("an invalid --profile fails as one clear line, before anything launches", () => {
  const home = makeTempDir("bw-profiles-home-");
  for (const bad of ["../escape", "a/b", "con", "x.betterwright-lock"]) {
    const result = runCli(["run", "--profile", bad, "-c", "return 1"], {
      env: { BETTERWRIGHT_HOME: home },
    });
    assert.equal(result.status, 1, `${bad}: exited ${result.status}`);
    assert.match(result.stderr, /profile/i);
    // A usage error, not a crash: no stack trace, and nothing was started.
    assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.equal(fs.existsSync(path.join(home, "browser")), false);
  }
});

test("--help still answers even with an invalid --profile", () => {
  const result = runCli(["run", "--help", "--profile", "../escape"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: betterwright run/);
});

test("the CLI documents --profile where it applies", () => {
  for (const [args, pattern] of [
    [["run", "--help"], /--profile <name>/],
    [["repl", "--help"], /profile/],
    [["exec", "--help"], /--profile <name>/],
    [["close", "--help"], /--profile <name>/],
    [["view", "--help"], /--profile <name>/],
  ] as [string[], RegExp][]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args[0]} --help exited ${result.status}`);
    assert.match(result.stdout, pattern, `${args[0]} --help omits --profile`);
  }
});

test("sessions and close report per profile when no daemon is running", () => {
  const home = makeTempDir("bw-profiles-home-");
  const sessions = runCli(["sessions"], { env: { BETTERWRIGHT_HOME: home } });
  assert.equal(sessions.status, 0);
  assert.match(sessions.stdout, /No session daemon is running\./);

  const close = runCli(["close", "--profile", "social"], { env: { BETTERWRIGHT_HOME: home } });
  assert.equal(close.status, 0);
  assert.match(close.stdout, /No session daemon is running for profile "social"/);
  // Inspecting must never start a daemon, on any profile.
  assert.equal(fs.existsSync(path.join(home, "daemon-social.sock")), false);
});

test("--profile \"\" is an error, not a silent fall back to the default identity", () => {
  const home = makeTempDir("bw-profiles-home-");
  // A script passing `--profile "$IDENTITY"` with the variable unset must fail
  // rather than quietly act as the default profile.
  const result = runCli(["run", "--profile", "", "-c", "return 1"], {
    env: { BETTERWRIGHT_HOME: home },
  });
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stderr, /profile must not be empty/);
  assert.equal(fs.existsSync(path.join(home, "browser")), false);
});

test("mcp --check refuses a bad BETTERWRIGHT_PROFILE and confirms a good one", () => {
  const home = makeTempDir("bw-profiles-home-");
  const bad = runCli(["mcp", "--check"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "../escape" },
  });
  assert.notEqual(bad.status, 0);
  // The message must name the environment variable: an MCP host has no flags
  // to inspect, so "invalid profile name" alone would not locate the problem.
  assert.match(bad.stderr, /BETTERWRIGHT_PROFILE/);
  assert.doesNotMatch(bad.stdout, /The MCP server can start/);

  const good = runCli(["mcp", "--check"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "social" },
  });
  assert.match(good.stdout, /Profile "social"/);
});

test("BETTERWRIGHT_PROFILE selects the identity for the CLI too, and --profile wins", () => {
  const home = makeTempDir("bw-profiles-home-");
  // `close` needs no browser and names the profile it looked for, so it is the
  // cheapest way to observe which identity the CLI resolved.
  const fromEnv = runCli(["close"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "social" },
  });
  assert.match(fromEnv.stdout, /profile "social"/);

  const flagWins = runCli(["close", "--profile", "review"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "social" },
  });
  assert.match(flagWins.stdout, /profile "review"/);

  const blankEnv = runCli(["close"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "  " },
  });
  assert.doesNotMatch(blankEnv.stdout, /profile/);

  const badEnv = runCli(["close"], {
    env: { BETTERWRIGHT_HOME: home, BETTERWRIGHT_PROFILE: "../escape" },
  });
  assert.equal(badEnv.status, 1);
  assert.match(badEnv.stderr, /profile/);
});

test("a session name can never reach a profile's transcript namespace", () => {
  const home = "/tmp/bw-home";
  // Session names are sanitized to start with a letter or digit, so "@social"
  // is hashed rather than becoming the `@social` profile directory.
  assert.notEqual(transcriptPath(home, "@social"), transcriptPath(home, "default", "social"));
  assert.ok(!transcriptPath(home, "@social").includes(`${path.sep}@social${path.sep}`));
});

// POSIX permission bits do not exist on Windows, which reports 0o666/0o777
// regardless of the mode a directory was created with.
test("the profiles directory is created owner-only", { skip: process.platform === "win32" }, () => {
  const browser = makeTempDir("bw-profiles-");
  const lock = acquireProfileLock(profileDirFor(browser, "social"), path.join(browser, "runtime"));
  try {
    const mode = fs.statSync(path.join(browser, "profiles")).mode & 0o777;
    assert.equal(mode, 0o700, `profiles/ is ${mode.toString(8)}`);
  } finally {
    releaseProfileLockDir(lock);
  }
});
