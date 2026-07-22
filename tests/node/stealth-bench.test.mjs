import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildTaskPrompt,
  classifyAttempt,
  decryptTaskPayload,
  normalizeTask,
  selectTasks,
} from "../../benchmarks/stealth-bench/runner.mjs";

function encryptFixture(value, passphrase = "Stealth_Bench_V1") {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const cipher = crypto.createCipheriv("aes-128-cbc", key.subarray(16), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  const header = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), iv, ciphertext]);
  const signature = crypto.createHmac("sha256", key.subarray(0, 16)).update(header).digest();
  return Buffer.from(Buffer.concat([header, signature]).toString("base64url")).toString("base64");
}

function task(taskId, category = "Cloudflare") {
  return {
    taskId: String(taskId),
    instruction: `Complete task ${taskId}`,
    category,
    website: `https://example.com/${taskId}`,
  };
}

test("Stealth Bench Fernet payloads decrypt in memory and reject tampering", () => {
  const payload = JSON.stringify([{ task_id: 1 }]);
  const encrypted = encryptFixture(payload);
  assert.equal(decryptTaskPayload(encrypted), payload);

  const tampered = Buffer.from(encrypted, "base64");
  tampered[tampered.length - 2] ^= 1;
  assert.throws(() => decryptTaskPayload(tampered.toString("base64")), /authentication/);
});

test("Stealth Bench task normalization validates metadata", () => {
  assert.deepEqual(
    normalizeTask({
      task_id: 7,
      confirmed_task: "Click three controls.",
      category: "Akamai",
      website: "https://example.com/start",
      answer: "unused",
    }),
    {
      taskId: "7",
      instruction: "Click three controls.",
      category: "Akamai",
      website: "https://example.com/start",
    },
  );
  assert.throws(
    () => normalizeTask({ task_id: 1, confirmed_task: "x", category: "x", website: "file:///tmp/x" }),
    /HTTP or HTTPS/,
  );
});

test("Stealth Bench selection is deterministic and rejects missing IDs", () => {
  const tasks = [task(1), task(2, "Akamai"), task(3)];
  assert.deepEqual(selectTasks(tasks, { taskIds: "3,1" }).map((entry) => entry.taskId), ["1", "3"]);
  assert.deepEqual(selectTasks(tasks, { category: "akamai" }).map((entry) => entry.taskId), ["2"]);
  assert.throws(() => selectTasks(tasks, { taskIds: "99" }), /Unknown Stealth Bench task IDs/);
});

test("Stealth Bench prompt forbids CAPTCHA solving and verdicts prioritize block evidence", () => {
  const prompt = buildTaskPrompt(task(1));
  assert.match(prompt, /Do not call captcha\.solve/);
  assert.equal(classifyAttempt({ answer: "PASSED", agentOk: true }).status, "passed");
  assert.equal(
    classifyAttempt({
      answer: "PASSED",
      agentOk: true,
      observations: [{ bodyText: "Checking your browser before accessing the site" }],
    }).status,
    "blocked",
  );
  assert.equal(classifyAttempt({ answer: "FAILED: selector changed", agentOk: true }).status, "failed");
});

