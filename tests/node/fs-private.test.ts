import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  mkdirPrivate,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  writePrivate,
  writePrivateBytes,
} from "../../dist/src/fs-private.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// POSIX permission bits do not exist on Windows, where the helpers deliberately
// treat chmod as best-effort. Assert the bits only where they are meaningful.
const posix = process.platform !== "win32";

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

test("mkdirPrivate creates the full path owner-only", () => {
  const root = makeTempDir("bw-fs-private-");
  const nested = path.join(root, "a", "b", "c");
  mkdirPrivate(nested);
  assert.ok(fs.statSync(nested).isDirectory());
  if (posix) assert.equal(mode(nested), PRIVATE_DIR_MODE);
});

test("mkdirPrivate tightens every directory it creates, umask notwithstanding", () => {
  const root = makeTempDir("bw-fs-private-");
  const previous = process.umask(0o022);
  try {
    mkdirPrivate(path.join(root, "a", "b", "c"));
  } finally {
    process.umask(previous);
  }
  // `mode` is masked by the umask, so without the follow-up chmod these would
  // land as 0o755 — and the intermediate links are as exposed as the leaf.
  if (posix) {
    assert.equal(mode(path.join(root, "a")), PRIVATE_DIR_MODE);
    assert.equal(mode(path.join(root, "a", "b")), PRIVATE_DIR_MODE);
    assert.equal(mode(path.join(root, "a", "b", "c")), PRIVATE_DIR_MODE);
  }
});

test("mkdirPrivate leaves an existing directory's mode alone", () => {
  const root = makeTempDir("bw-fs-private-");
  const dir = path.join(root, "users-own-directory");
  fs.mkdirSync(dir, { mode: 0o755 });
  if (posix) fs.chmodSync(dir, 0o755);
  mkdirPrivate(dir);
  // Callers pass parents BetterWright does not own — `acquireProfileLock` hands
  // it the profile's parent, which is wherever the user pointed the profile.
  // Clamping that to 0o700 would revoke access the user deliberately granted.
  if (posix) assert.equal(mode(dir), 0o755);
});

test("writePrivate writes utf8 content owner-only", () => {
  const root = makeTempDir("bw-fs-private-");
  const file = path.join(root, "secret.json");
  writePrivate(file, '{"token":"café"}\n');
  assert.equal(fs.readFileSync(file, "utf8"), '{"token":"café"}\n');
  if (posix) assert.equal(mode(file), PRIVATE_FILE_MODE);
});

test("writePrivate tightens a file that already exists too openly", () => {
  const root = makeTempDir("bw-fs-private-");
  const file = path.join(root, "rewritten");
  fs.writeFileSync(file, "old", { mode: 0o644 });
  if (posix) fs.chmodSync(file, 0o644);
  writePrivate(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  if (posix) assert.equal(mode(file), PRIVATE_FILE_MODE);
});

test("writePrivateBytes round-trips binary content owner-only", () => {
  const root = makeTempDir("bw-fs-private-");
  const file = path.join(root, "blob.bin");
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f]);
  writePrivateBytes(file, bytes);
  assert.deepEqual(fs.readFileSync(file), bytes);
  if (posix) assert.equal(mode(file), PRIVATE_FILE_MODE);
});

test("a write failure still propagates", () => {
  const root = makeTempDir("bw-fs-private-");
  // A directory is not a writable file: the write must throw rather than be
  // swallowed by the best-effort chmod handling.
  const dir = path.join(root, "adirectory");
  mkdirPrivate(dir);
  assert.throws(() => writePrivate(dir, "nope"));
});
