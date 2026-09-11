import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { assertSameSource, dependencyIdentity, directoryIdentity, sha256, sourceIdentity } from "../../benchmarks/navigation-context/provenance.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const execute = promisify(execFile);

async function repository() {
  const root = makeTempDir("bw-benchmark-provenance-");
  const git = async (...args: string[]) => (await execute("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Benchmark test");
  await git("config", "user.email", "benchmark@example.test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", path.join(root, "empty-hooks"));
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  const commit = async () => { await git("add", "."); await git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  write("src/runtime.ts", "export const value = 1;\n");
  const baseline = await commit();
  return { root, git, write, commit, baseline };
}

test("benchmark provenance includes committed additions and the baseline-to-candidate difference", async () => {
  const repo = await repository();
  const baseline = await sourceIdentity(repo.root);
  repo.write("src/new-helper.ts", "export const helper = true;\n");
  const candidateHead = await repo.commit();
  const candidate = await sourceIdentity(repo.root, repo.baseline);
  assert.equal(candidate.head, candidateHead);
  assert.equal(candidate.baselineHead, repo.baseline);
  assert.notEqual(candidate.sourceTreeSha256, baseline.sourceTreeSha256);
  assert.equal(candidate.diffSha256, sha256((await execute("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", repo.baseline, candidateHead, "--", "src", "bin", "types"], { cwd: repo.root })).stdout));
  assert.notEqual(candidate.diffSha256, sha256(""));
});

test("benchmark provenance rejects unstaged, staged, untracked and ignored source inputs", async () => {
  const repo = await repository();
  repo.write("src/runtime.ts", "changed\n");
  await assert.rejects(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  await repo.git("add", ".");
  await assert.rejects(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  await repo.commit();
  repo.write("src/untracked.ts", "untracked\n");
  await assert.rejects(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  repo.write(".gitignore", "src/ignored.ts\n");
  await repo.commit();
  repo.write("src/ignored.ts", "ignored\n");
  await assert.rejects(() => sourceIdentity(repo.root), /changed source\/build inputs/);
});

test("publishing results preserves measured source identity, but later runtime edits do not", async () => {
  const repo = await repository();
  const measured = await sourceIdentity(repo.root, repo.baseline);
  repo.write("benchmarks/results.json", "{}\n");
  await repo.commit();
  const published = await sourceIdentity(repo.root, repo.baseline);
  assert.notEqual(published.head, measured.head);
  assertSameSource(measured, published);
  repo.write("src/runtime.ts", "export const value = 2;\n");
  await repo.commit();
  const changed = await sourceIdentity(repo.root, repo.baseline);
  assert.throws(() => assertSameSource(measured, changed), /differ from the measured revision/);
});

test("build fingerprint covers artifacts beyond the worker entrypoint", async () => {
  const repo = await repository();
  repo.write("dist/src/worker.js", "import './helper.js';\n");
  repo.write("dist/src/helper.js", "export const helper = 1;\n");
  const before = await directoryIdentity(path.join(repo.root, "dist"));
  repo.write("dist/src/helper.js", "export const helper = 2;\n");
  const after = await directoryIdentity(path.join(repo.root, "dist"));
  assert.equal(before.fileCount, 2);
  assert.notEqual(after.sha256, before.sha256);
});


test("installed dependency provenance detects content edits and follows package links", async () => {
  const root = makeTempDir("bw-dependency-identity-");
  const modules = path.join(root, "node_modules");
  const linked = path.join(root, "linked-package");
  fs.mkdirSync(modules);
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, "index.js"), "export const value = 1;");
  fs.symlinkSync(linked, path.join(modules, "package"), "junction");
  const before = await dependencyIdentity(modules);
  assert.equal(before.fileCount, 1);
  assert.deepEqual(await dependencyIdentity(modules), before);
  fs.writeFileSync(path.join(linked, "index.js"), "export const value = 2;");
  assert.notEqual((await dependencyIdentity(modules)).sha256, before.sha256);
  // Linked package cycles terminate and their link identity is still recorded.
  fs.symlinkSync(modules, path.join(linked, "dependencies"), "junction");
  const cycle = await dependencyIdentity(modules);
  assert.equal(cycle.fileCount, 1);
  assert.notEqual(cycle.sha256, before.sha256);
});
