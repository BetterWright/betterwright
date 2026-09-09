import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoveryTimeoutMs,
  endpointDiscoverySources,
  endpointSourceName,
} from "../../dist/src/agent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");

// Async execFile, closed stdin, SIGKILL at a deadline. spawnSync can sit
// until the 120s bun test timeout under parallel workers (see #164 and
// oven-sh/bun#37849), which is what failed Worker copies in sync on 2.5.2.
function runCli(args, envOverrides = {}, timeout = 20_000) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    const env = { ...process.env, ...envOverrides };
    for (const [name, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[name];
    }
    const child = execFile(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      env,
    }, (_error, stdout, stderr) => {
      resolve({ status: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    child.stdin?.end();
  });
}

function assertCliExited(result, status, label) {
  assert.equal(result.signal, null, `${label} hung and had to be killed`);
  assert.equal(result.status, status, `${label} exited ${result.status}: ${result.stderr}`);
}

test("models command lists actual native model ids without a provider flag", async () => {
  const result = await runCli(["models"], {
    BETTERWRIGHT_MODEL_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
  });

  assertCliExited(result, 0, "models");
  assert.match(result.stdout, /claude-opus-4-8/);
  assert.match(result.stdout, /gpt-/);
  assert.match(result.stdout, /grok-/);
  assert.doesNotMatch(result.stdout, /^(?:claude|codex|grok)$/m);
});

test("model command help is specific and successful", async () => {
  const models = await runCli(["models", "--help"]);
  const exec = await runCli(["exec", "--help"]);

  assertCliExited(models, 0, "models --help");
  assert.match(models.stdout, /betterwright models/);
  assert.match(models.stdout, /openrouter \| ollama \| vllm/);
  assert.doesNotMatch(models.stdout, /--provider/);
  assertCliExited(exec, 0, "exec --help");
  assert.match(exec.stdout, /betterwright exec.*--base-url/s);
  assert.match(exec.stdout, /single quotes.*\$4000/s);
  assert.match(exec.stdout, /betterwright exec --stdin/);
  assert.doesNotMatch(exec.stdout, /--provider|--model-id/);
});

test("exec rejects ambiguous task argument plus stdin mode", async () => {
  const result = await runCli(["exec", "find options under $4000", "--stdin"]);

  assertCliExited(result, 1, "exec task plus --stdin");
  assert.match(result.stderr, /either a task argument or --stdin/);
});

test("removed provider flag points users to the model-first syntax", async () => {
  const result = await runCli(
    [
      "exec",
      "--provider",
      "custom",
      "--model",
      "vendor/opaque-model",
      "inspect example.com",
    ],
    {
      BETTERWRIGHT_MODEL_BASE_URL: undefined,
      BETTERWRIGHT_MODEL_API_KEY: undefined,
    },
  );

  assertCliExited(result, 1, "removed --provider");
  assert.match(result.stderr, /--provider was removed.*--model ollama\/qwen3:8b/s);
});

test("OpenRouter CLI points to the expected key without exposing key flags", async () => {
  const result = await runCli(
    [
      "exec",
      "inspect example.com",
      "--model=openrouter/vendor/model",
    ],
    { OPENROUTER_API_KEY: undefined },
  );

  assertCliExited(result, 1, "openrouter without key");
  assert.match(result.stderr, /OpenRouter needs an API key.*OPENROUTER_API_KEY/s);
});

test("model-id flag is folded into the primary model selector", async () => {
  const result = await runCli([
    "exec",
    "inspect example.com",
    "--model-id",
    "gpt-5.6-sol",
  ]);

  assertCliExited(result, 1, "folded --model-id");
  assert.match(result.stderr, /--model-id was merged into --model/);
});

test("models rejects an unknown source with agent.ts's shared error message", async () => {
  const result = await runCli(["models", "bogus"]);

  assertCliExited(result, 1, "models bogus");
  // The CLI used to keep its own copy of this message ("...or a custom
  // --base-url.") that had drifted from the one --model parsing emits; both
  // now come from endpointSourceName.
  assert.match(
    result.stderr,
    /Unknown model source "bogus"\. Use openrouter, ollama, vllm, or custom\./,
  );
});

test("models normalizes source spellings the same way --model parsing does", async () => {
  // endpointSourceName strips [-_ ], so `cus_tom` selects the custom source
  // (which then fails fast for want of a --base-url, keeping the test
  // offline) instead of being rejected as an unknown source.
  const result = await runCli(["models", "cus_tom"], {
    BETTERWRIGHT_MODEL_BASE_URL: undefined,
  });

  assertCliExited(result, 1, "models cus_tom");
  assert.match(result.stderr, /custom: unavailable .*--base-url/s);
  assert.match(result.stderr, /No available models found\./);
});

test("source parsing and probe budgets are the agent's own exports", () => {
  assert.equal(endpointSourceName("Open-Router"), "openrouter");
  assert.equal(endpointSourceName("v_llm"), "vllm");
  assert.throws(
    () => endpointSourceName("bogus"),
    /Use openrouter, ollama, vllm, or custom\./,
  );
  // OpenRouter's probe crosses the network, so it gets more headroom than the
  // loopback runtimes.
  assert.equal(discoveryTimeoutMs("openrouter"), 3_000);
  assert.equal(discoveryTimeoutMs("ollama"), 750);
  assert.equal(discoveryTimeoutMs("vllm"), 750);
});

test("endpoint discovery probes local runtimes always and OpenRouter only with a key", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.deepEqual(endpointDiscoverySources(), ["ollama", "vllm"]);
    process.env.OPENROUTER_API_KEY = "test-key";
    assert.deepEqual(endpointDiscoverySources(), ["ollama", "vllm", "openrouter"]);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});
