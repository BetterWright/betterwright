import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_PATHS = ["src", "bin", "types"];
export const SOURCE_PATHS = [...RUNTIME_PATHS, "scripts", "package.json", "bun.lock", ".bun-version", "tsconfig.json", "tsconfig.tools.json", "SKILL.md"];
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function sourceIdentity(root: string, baselineHead?: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root });
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  const baseline = baselineHead ?? head;
  assert.match(baseline, /^[a-f0-9]{40}$/i, "The baseline must be an immutable commit ID");
  git(["cat-file", "-e", `${baseline}^{commit}`]);
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...SOURCE_PATHS]).toString().trim();
  assert.equal(dirty, "", `Commit or remove changed source/build inputs before benchmarking:\n${dirty}`);
  return {
    head,
    baselineHead: baseline,
    // Tree entries include every committed input, including added files. This
    // stays stable when a later commit only publishes benchmark measurements.
    sourceTreeSha256: sha256(git(["ls-tree", "-r", "-z", head, "--", ...SOURCE_PATHS])),
    diffSha256: sha256(git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", baseline, head, "--", ...RUNTIME_PATHS])),
  };
}

export type SourceIdentity = ReturnType<typeof sourceIdentity>;

export function assertSameSource(recorded: SourceIdentity, current: SourceIdentity) {
  assert.equal(current.baselineHead, recorded.baselineHead, "The declared baseline changed");
  assert.equal(current.sourceTreeSha256, recorded.sourceTreeSha256, "Source/build inputs differ from the measured revision");
  assert.equal(current.diffSha256, recorded.diffSha256, "The committed runtime difference changed");
}

export async function directoryIdentity(root: string) {
  const files: Array<[string, string]> = [];
  async function visit(relative: string) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else {
        assert.ok(entry.isFile(), `Expected a regular build artifact: ${name}`);
        files.push([name, sha256(await readFile(path.join(root, name)))]);
      }
    }
  }
  await visit("");
  return { sha256: sha256(JSON.stringify(files)), fileCount: files.length };
}


// Fingerprint what the build/runtime actually load, including linked package
// contents. The lockfile alone cannot detect local edits inside node_modules.
export async function dependencyIdentity(root: string) {
  const entries: Array<[string, string, string]> = [];
  const visited = new Set<string>();
  async function visit(file: string, relative: string) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      entries.push(["link", relative, await readlink(file)]);
      await visit(await realpath(file), `${relative}/@target`);
    } else if (info.isDirectory()) {
      const resolved = await realpath(file);
      if (visited.has(resolved)) return;
      visited.add(resolved);
      for (const name of (await readdir(file)).sort()) {
        await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
      }
    } else {
      assert.ok(info.isFile(), `Unsupported installed dependency entry: ${relative}`);
      entries.push(["file", relative, sha256(await readFile(file))]);
    }
  }
  await visit(await realpath(root), "");
  return { sha256: sha256(JSON.stringify(entries)), fileCount: entries.filter(([kind]) => kind === "file").length };
}
