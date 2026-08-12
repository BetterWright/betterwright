import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  benchmarkBinaryMetadata,
  buildTaskPrompt,
  configureForkEnvironment,
  resolveBenchmarkBinary,
  sanitizeEgressMetadata,
} from "../../benchmarks/stealth-bench/runner.js";
import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  CHROMIUM_FORK_RELEASE_TAG,
} from "../../dist/src/chromium-fork.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("benchmark binary is required, absolute, present, and executable", async () => {
  await assert.rejects(resolveBenchmarkBinary(), /--binary is required/);
  await assert.rejects(
    resolveBenchmarkBinary("relative/chrome"),
    /absolute path/,
  );
  await assert.rejects(
    resolveBenchmarkBinary("/definitely/missing/betterwright-chrome"),
    /not found/,
  );

  const root = makeTempDir("bw-stealth-bench-");
  await assert.rejects(resolveBenchmarkBinary(root), /point to a file/);
  const binary = path.join(root, "chrome");
  fs.writeFileSync(binary, "fork bytes", { mode: 0o755 });
  assert.equal(await resolveBenchmarkBinary(binary), binary);
});

test("fork environment selects only the requested BetterChromium", () => {
  const env = {
    BETTERWRIGHT_CHROMIUM_PATH: "/old/chromium",
    BETTERWRIGHT_CHROMIUM_ROOT: "/old/chromium-root",
    CLOAKBROWSER_BINARY_PATH: "/old/cloak",
  };
  configureForkEnvironment("/opt/betterwright/chrome", env);
  assert.deepEqual(env, {
    BETTERWRIGHT_CHROMIUM_PATH: "/opt/betterwright/chrome",
  });
});

test("binary metadata records exact build and content hash", async () => {
  const root = makeTempDir("bw-stealth-meta-");
  const binary = path.join(root, "chrome");
  fs.writeFileSync(binary, "fork bytes", { mode: 0o755 });
  const metadata = await benchmarkBinaryMetadata(binary, {
    probeVersion: async () => `Chromium ${BETTERWRIGHT_CHROMIUM_VERSION}`,
  });
  assert.equal(metadata.chromium_version, BETTERWRIGHT_CHROMIUM_VERSION);
  assert.equal(metadata.build, CHROMIUM_FORK_RELEASE_TAG);
  assert.equal(
    metadata.reported_version,
    `Chromium ${BETTERWRIGHT_CHROMIUM_VERSION}`,
  );
  assert.equal(
    metadata.sha256,
    "aee2b872275f04489736e3aa2b58ff584e564c27de373552ccfa3968202714b2",
  );
  assert.equal(metadata.size_bytes, 10);
  await assert.rejects(
    benchmarkBinaryMetadata(binary, {
      probeVersion: async () => "Chromium 149.0.0.0",
    }),
    /must report the candidate BetterChromium/,
  );
});

test("egress metadata omits credentials, path, query, and fragment", () => {
  assert.deepEqual(sanitizeEgressMetadata(), { type: "direct" });
  const metadata = sanitizeEgressMetadata(
    "socks5://alice:secret@proxy.example:1080/private?token=value#hidden",
  );
  assert.deepEqual(metadata, {
    type: "upstream_proxy",
    protocol: "socks5",
    hostname: "proxy.example",
    port: "1080",
    authenticated: true,
  });
  assert.doesNotMatch(
    JSON.stringify(metadata),
    /alice|secret|private|token|hidden|value/,
  );
  assert.throws(
    () => sanitizeEgressMetadata("https://proxy.example"),
    /http:\/\/ or socks5:\/\//,
  );
});

test("task prompt prohibits CAPTCHA interaction and screenshots", () => {
  const prompt = buildTaskPrompt({
    taskId: "1",
    website: "https://example.com/",
    instruction: "Visit",
    category: "test",
  });
  assert.match(prompt, /Do not call captcha\.solve, click a CAPTCHA/);
  assert.match(prompt, /Do not capture screenshots/);
});
