import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "bin", "betterwright.mjs");

function runCli(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [name, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("models command lists actual native model ids without a provider flag", () => {
  const result = runCli(["models"], {
    BETTERWRIGHT_MODEL_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /claude-opus-4-8/);
  assert.match(result.stdout, /gpt-/);
  assert.match(result.stdout, /grok-/);
  assert.doesNotMatch(result.stdout, /^(?:claude|codex|grok)$/m);
});

test("model command help is specific and successful", () => {
  const models = runCli(["models", "--help"]);
  const exec = runCli(["exec", "--help"]);

  assert.equal(models.status, 0);
  assert.match(models.stdout, /betterwright models.*openrouter\|ollama\|vllm/s);
  assert.doesNotMatch(models.stdout, /--provider/);
  assert.equal(exec.status, 0);
  assert.match(exec.stdout, /betterwright exec.*--base-url/s);
  assert.match(exec.stdout, /single quotes.*\$4000/s);
  assert.match(exec.stdout, /betterwright exec --stdin/);
  assert.doesNotMatch(exec.stdout, /--provider|--model-id/);
});

test("exec rejects ambiguous task argument plus stdin mode", () => {
  const result = runCli(["exec", "find options under $4000", "--stdin"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /either a task argument or --stdin/);
});

test("removed provider flag points users to the model-first syntax", () => {
  const result = runCli(
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

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--provider was removed.*--model ollama\/qwen3:8b/s);
});

test("OpenRouter CLI points to the expected key without exposing key flags", () => {
  const result = runCli(
    [
      "exec",
      "inspect example.com",
      "--model=openrouter/vendor/model",
    ],
    { OPENROUTER_API_KEY: undefined },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OpenRouter needs an API key.*OPENROUTER_API_KEY/s);
});

test("model-id flag is folded into the primary model selector", () => {
  const result = runCli([
    "exec",
    "inspect example.com",
    "--model-id",
    "gpt-5.6-sol",
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model-id was merged into --model/);
});
