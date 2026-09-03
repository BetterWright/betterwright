import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importOptionalPeer, installHint } from "../../dist/src/optional-peer.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// Writes a loadable ESM package into <root>/node_modules/<name>.
function installFakePeer(root, name, body) {
  const dir = path.join(root, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  );
  fs.writeFileSync(path.join(dir, "index.js"), body);
  return dir;
}

function withCwd(t, dir) {
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(previous));
}

// The bug this guards: `betterwright` installed globally resolves imports from
// the npm global root and never consults the working directory, so a project
// -local `npm install @anthropic-ai/sdk` stayed invisible and the CLI insisted
// the SDK was missing however many times the user installed it.
test("an optional peer installed only in the working directory still resolves", async (t) => {
  const project = makeTempDir("bw-peer-cwd-");
  installFakePeer(project, "bw-fake-peer", "export default 'from-cwd';\n");
  withCwd(t, project);

  const loaded = await importOptionalPeer("bw-fake-peer", "The test");
  assert.equal(loaded.default, "from-cwd");
});

test("a subpath export of a working-directory peer resolves", async (t) => {
  const project = makeTempDir("bw-peer-subpath-");
  const dir = installFakePeer(project, "bw-fake-sub", "export default 'root';\n");
  fs.writeFileSync(path.join(dir, "extra.js"), "export const value = 'subpath';\n");
  withCwd(t, project);

  const loaded = await importOptionalPeer("bw-fake-sub/extra.js", "The test");
  assert.equal(loaded.value, "subpath");
});

test("a genuinely missing peer reports the install command and both search paths", async (t) => {
  const project = makeTempDir("bw-peer-missing-");
  withCwd(t, project);

  const message = await importOptionalPeer("bw-not-installed-anywhere", "The Claude model").catch(
    (e) => e.message,
  );
  assert.match(message, /The Claude model needs bw-not-installed-anywhere, which is not installed/);
  // The old text said `npm install @anthropic-ai/sdk`, which can never work for
  // a globally installed CLI; the hint must track how BetterWright was invoked.
  assert.match(message, /bun add -g bw-not-installed-anywhere/);
  assert.match(message, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// A peer that exists but throws on load is a real defect in that peer; masking
// it as "not installed" would send the user chasing a phantom install problem.
test("a peer that fails to load surfaces its own error, not an install hint", async (t) => {
  const project = makeTempDir("bw-peer-broken-");
  installFakePeer(project, "bw-broken-peer", "throw new Error('peer exploded on load');\n");
  withCwd(t, project);

  const message = await importOptionalPeer("bw-broken-peer", "The test").catch((e) => e.message);
  assert.match(message, /peer exploded on load/);
  assert.doesNotMatch(message, /not installed/);
});

test("the install hint is global for a CLI outside the working directory and local otherwise", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  assert.equal(installHint("@anthropic-ai/sdk", repoRoot), "bun add @anthropic-ai/sdk");
  assert.equal(
    installHint("@anthropic-ai/sdk", path.join(repoRoot, "..", "elsewhere")),
    "bun add -g @anthropic-ai/sdk",
  );
  // Peers are declared on the package root, so a subpath import must not leak
  // into the suggested command.
  assert.equal(
    installHint("@modelcontextprotocol/sdk/server/index.js", repoRoot),
    "bun add @modelcontextprotocol/sdk",
  );
  assert.equal(installHint("some-peer/deep/path.js", repoRoot), "bun add some-peer");
});

// BetterWright must not count as "inside" a working directory that merely
// shares a string prefix with its path — a raw startsWith would say the install
// is local and suggest a command that cannot work.
test("a working directory sharing a name prefix is treated as a global install", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const prefixOnly = repoRoot.slice(0, -3);
  assert.ok(`${repoRoot}${path.sep}src`.startsWith(prefixOnly), "test premise: raw prefix matches");
  assert.equal(installHint("x", prefixOnly), "bun add -g x");
});
