import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { assertSameSource, directoryIdentity, sha256, sourceIdentity } from "../../benchmarks/navigation-context/provenance.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function repository() {
  const root = makeTempDir("bw-benchmark-provenance-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Benchmark test");
  git("config", "user.email", "benchmark@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(root, "empty-hooks"));
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  write("src/runtime.ts", "export const value = 1;\n");
  const baseline = commit();
  return { root, git, write, commit, baseline };
}

test("benchmark provenance includes committed additions and the baseline-to-candidate difference", () => {
  const repo = repository();
  const baseline = sourceIdentity(repo.root);
  repo.write("src/new-helper.ts", "export const helper = true;\n");
  const candidateHead = repo.commit();
  const candidate = sourceIdentity(repo.root, repo.baseline);
  assert.equal(candidate.head, candidateHead);
  assert.equal(candidate.baselineHead, repo.baseline);
  assert.notEqual(candidate.sourceTreeSha256, baseline.sourceTreeSha256);
  assert.equal(candidate.diffSha256, sha256(execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", repo.baseline, candidateHead, "--", "src", "bin", "types"], { cwd: repo.root })));
  assert.notEqual(candidate.diffSha256, sha256(""));
});

test("benchmark provenance rejects unstaged, staged, untracked and ignored source inputs", () => {
  const repo = repository();
  repo.write("src/runtime.ts", "changed\n");
  assert.throws(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  repo.git("add", ".");
  assert.throws(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  repo.commit();
  repo.write("src/untracked.ts", "untracked\n");
  assert.throws(() => sourceIdentity(repo.root), /changed source\/build inputs/);
  repo.write(".gitignore", "src/ignored.ts\n");
  repo.commit();
  repo.write("src/ignored.ts", "ignored\n");
  assert.throws(() => sourceIdentity(repo.root), /changed source\/build inputs/);
});

test("publishing results preserves measured source identity, but later runtime edits do not", () => {
  const repo = repository();
  const measured = sourceIdentity(repo.root, repo.baseline);
  repo.write("benchmarks/results.json", "{}\n");
  repo.commit();
  const published = sourceIdentity(repo.root, repo.baseline);
  assert.notEqual(published.head, measured.head);
  assertSameSource(measured, published);
  repo.write("src/runtime.ts", "export const value = 2;\n");
  repo.commit();
  assert.throws(() => assertSameSource(measured, sourceIdentity(repo.root, repo.baseline)), /differ from the measured revision/);
});

test("build fingerprint covers artifacts beyond the worker entrypoint", async () => {
  const repo = repository();
  repo.write("dist/src/worker.js", "import './helper.js';\n");
  repo.write("dist/src/helper.js", "export const helper = 1;\n");
  const before = await directoryIdentity(path.join(repo.root, "dist"));
  repo.write("dist/src/helper.js", "export const helper = 2;\n");
  const after = await directoryIdentity(path.join(repo.root, "dist"));
  assert.equal(before.fileCount, 2);
  assert.notEqual(after.sha256, before.sha256);
});
