// Probe: which filesystem operations the vault lock relies on actually work
// on Windows, and with which error codes they fail.
//
// Run on a windows-latest runner (a throwaway workflow works); it prints one
// PROBE line per question. The vault's Windows branches in `src/vault.ts`
// were written against this probe's output — the hypotheses it was built to
// test, later confirmed by the CI run recorded below:
//
//   - A directory cannot be renamed while a handle is open to a file inside
//     it. This is why the lock's lease handle must not be open across the
//     publish and retire renames — and why 43 vault tests failed with EPERM
//     at `rename('vault.lock.candidate.…' -> 'vault.lock')`.
//   - After closing the handle, the same rename succeeds — the fix is an
//     ordering change, not a different mechanism.
//   - `handle.stat()` and `fs.stat()` must agree on dev+ino for the same
//     file, or `verifyLockOwnership`'s identity check cannot work on NTFS.
//
// Recorded output — pasted verbatim from the probe's first CI run
// (windows-latest, Node v22.23.1, GitHub Actions run 30625390611,
// 2026-07-31). If you re-run the probe and see different output, update
// this block; these lines are the evidence the Windows branches cite.
//
//   PROBE rename-dir-with-open-child-handle: EPERM
//   PROBE rename-dir-after-close: ok
//   PROBE rename-dir-onto-existing-empty-dir: EPERM
//   PROBE rename-file-over-existing-file: ok
//   PROBE rename-file-over-open-destination: EPERM
//   PROBE open-directory-read: ok
//   PROBE handle-vs-path-stat-identity: dev=true ino=true
//   PROBE rm-dir-with-open-child-handle: ok
//   PROBE utimes-via-open-handle: ok
//
// Two of these deserve a note beyond the lock fix they motivated:
//   - `rm` of a directory tree succeeds even with an open child handle
//     (NTFS POSIX-delete semantics); only *renaming* the directory is
//     blocked. Cleanup paths need no reordering.
//   - Replacing a file whose destination is concurrently open for reading
//     fails with EPERM, so `atomicWrite` can race a concurrent reader on
//     Windows. The vault's readers hold files open only momentarily
//     (readBoundedFile closes in `finally`), so retrying writes there is
//     left until evidence says otherwise.

import fs from "node:fs";
import { open, rename, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bw-fs-probe-"));
const report = (name, outcome) => console.log(`PROBE ${name}: ${outcome}`);
const codeOf = (error) => error?.code || String(error);

async function probe(name, body) {
  try {
    report(name, (await body()) ?? "ok");
  } catch (error) {
    report(name, codeOf(error));
  }
}

// 1. The vault lock's publish rename: a directory with an open child handle.
await probe("rename-dir-with-open-child-handle", async () => {
  const dir = path.join(root, "locked");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "owner.json"), "{}");
  const handle = await open(path.join(dir, "owner.json"), "r+");
  try {
    await rename(dir, path.join(root, "locked-renamed"));
  } finally {
    await handle.close();
  }
});

// 2. The same rename after the handle closes — the proposed fix.
await probe("rename-dir-after-close", async () => {
  const dir = path.join(root, "closed");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "owner.json"), "{}");
  const handle = await open(path.join(dir, "owner.json"), "r+");
  await handle.close();
  await rename(dir, path.join(root, "closed-renamed"));
});

// 3. Publish colliding with an existing lock: dir onto existing empty dir.
await probe("rename-dir-onto-existing-empty-dir", async () => {
  const src = path.join(root, "src-dir");
  const dst = path.join(root, "dst-dir");
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  await rename(src, dst);
});

// 4. atomicWrite's replace: file over an existing closed file.
await probe("rename-file-over-existing-file", async () => {
  const src = path.join(root, "a.tmp");
  const dst = path.join(root, "a.dat");
  fs.writeFileSync(src, "new");
  fs.writeFileSync(dst, "old");
  await rename(src, dst);
});

// 5. atomicWrite racing a reader: file over an existing OPEN file.
await probe("rename-file-over-open-destination", async () => {
  const src = path.join(root, "b.tmp");
  const dst = path.join(root, "b.dat");
  fs.writeFileSync(src, "new");
  fs.writeFileSync(dst, "old");
  const reader = await open(dst, "r");
  try {
    await rename(src, dst);
  } finally {
    await reader.close();
  }
});

// 6. syncDirectory's open(dir, "r") — which code does Windows produce?
await probe("open-directory-read", async () => {
  const handle = await open(root, "r");
  await handle.close();
});

// 7. verifyLockOwnership's identity check: handle.stat vs path stat.
await probe("handle-vs-path-stat-identity", async () => {
  const file = path.join(root, "ident.json");
  fs.writeFileSync(file, "{}");
  const handle = await open(file, "r+");
  try {
    const [h, p] = [await handle.stat(), await stat(file)];
    return `dev=${h.dev === p.dev} ino=${h.ino === p.ino}`;
  } finally {
    await handle.close();
  }
});

// 8. Test cleanup: rm -r of a directory with an open child handle.
await probe("rm-dir-with-open-child-handle", async () => {
  const dir = path.join(root, "rm-target");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "pin.txt"), "x");
  const handle = await open(path.join(dir, "pin.txt"), "r");
  try {
    await rm(dir, { recursive: true });
  } finally {
    await handle.close();
  }
});

// 9. The heartbeat's lease renewal against a path with an open handle.
await probe("utimes-via-open-handle", async () => {
  const file = path.join(root, "beat.json");
  fs.writeFileSync(file, "{}");
  const handle = await open(file, "r+");
  try {
    const now = new Date();
    await handle.utimes(now, now);
    await utimes(file, now, now);
  } finally {
    await handle.close();
  }
});

fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
