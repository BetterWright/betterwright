import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildJudgePrompt,
  judgeTask,
  parseJudgeResponse,
  selectEvidence,
} from "../../benchmarks/online-mind2web/judge.mjs";
import {
  actionForTrace,
  assistantText,
  BENCHMARK_MODEL,
  BENCHMARK_THINKING,
  buildTaskPrompt,
  buildV2Submission,
  compactEvent,
  createFullManifest,
  createSampleManifest,
  filterTasksByIds,
  normalizeTask,
  runTask,
  SAMPLE_SCHEMA,
  tasksForManifest,
  validateV2Submission,
} from "../../benchmarks/online-mind2web/runner.mjs";

function benchmarkTask(index, level = "medium", taskId) {
  return normalizeTask({
    task_id: taskId || index.toString(16).padStart(32, "0"),
    website: `https://example.com/${index}`,
    task: `Complete benchmark task ${index}.`,
    reference_length: 2 + (index % 10),
    level,
  });
}

test("Online-Mind2Web task normalization rejects incomplete benchmark metadata", () => {
  assert.deepEqual(benchmarkTask(1), {
    task_id: "00000000000000000000000000000001",
    website: "https://example.com/1",
    task: "Complete benchmark task 1.",
    reference_length: 3,
    level: "medium",
  });
  assert.throws(
    () => normalizeTask({ task_id: "bad/id", website: "https://example.com", task: "x", reference_length: 1 }),
    /Invalid Online-Mind2Web task_id/,
  );
  assert.throws(
    () => normalizeTask({ task_id: "abc", website: "file:///tmp/a", task: "x", reference_length: 1 }),
    /http or https/,
  );
  assert.throws(
    () => normalizeTask({ task_id: "abc", website: "https://example.com", task: "x", reference_length: 0 }),
    /reference_length/,
  );
});

test("50-task sample is deterministic, difficulty-stratified, and keeps a holdout", () => {
  const tasks = Array.from({ length: 300 }, (_, index) =>
    benchmarkTask(index + 1, index < 81 ? "easy" : index < 224 ? "medium" : "hard"),
  );
  // This task base was replaced after the public mirror and must never be sampled.
  tasks[0] = benchmarkTask(999, "easy", "547f5729c59d5d12a457a3ebb74c31c6");
  const first = createSampleManifest(tasks);
  const second = createSampleManifest([...tasks].reverse());
  assert.equal(first.schema_version, SAMPLE_SCHEMA);
  assert.equal(first.tasks.length, 50);
  assert.equal(first.partitions.development, 35);
  assert.equal(first.partitions.holdout, 15);
  assert.deepEqual(first, second);
  assert.equal(first.tasks.some((entry) => entry.task_id.startsWith("547f5729")), false);
  assert.deepEqual(
    Object.fromEntries(
      [...Map.groupBy(first.tasks, (entry) => entry.level)].map(([level, rows]) => [level, rows.length]),
    ),
    { easy: 13, medium: 24, hard: 13 },
  );
  assert.equal(first.tasks.filter((entry) => entry.partition === "holdout").length, 15);

  const holdout = tasksForManifest(tasks, first, "holdout");
  assert.equal(holdout.length, 15);
  assert.ok(holdout.every((task) => task.partition === "holdout"));
});

test("full manifest includes every task deterministically, including updated IDs", () => {
  const tasks = Array.from({ length: 300 }, (_, index) =>
    benchmarkTask(index + 1, index < 81 ? "easy" : index < 224 ? "medium" : "hard"),
  );
  tasks[0] = benchmarkTask(999, "easy", "547f5729c59d5d12a457a3ebb74c31c6");
  const first = createFullManifest(tasks);
  const second = createFullManifest([...tasks].reverse());

  assert.deepEqual(first, second);
  assert.equal(first.schema_version, SAMPLE_SCHEMA);
  assert.equal(first.count, 300);
  assert.deepEqual(first.partitions, { benchmark: 300 });
  assert.equal(first.excluded_updated_task_bases.length, 0);
  assert.ok(first.tasks.some((entry) => entry.task_id.startsWith("547f5729")));
  assert.ok(first.tasks.every((entry) => entry.partition === "benchmark"));
});

test("benchmark prompt pins the starting site, current date, and exact task", () => {
  const prompt = buildTaskPrompt(
    benchmarkTask(7),
    new Date("2026-07-14T23:59:00Z"),
  );
  assert.match(prompt, /Specified starting website: https:\/\/example\.com\/7/);
  assert.match(prompt, /Current UTC date: 2026-07-14/);
  assert.match(prompt, /Complete benchmark task 7\./);
});

test("benchmark agent policy requires exact URL-backed filters and bounded fallback", async () => {
  const prompt = await fs.readFile(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../../benchmarks/online-mind2web/agent-prompt.md",
    ),
    "utf8",
  );
  assert.match(prompt, /URL parameter for an exact filter/i);
  assert.match(prompt, /page visibly\s+renders the requested unit and value/i);
  assert.match(prompt, /you must try\s+one reputable live fallback/i);
  assert.match(prompt, /does not explicitly name the site/i);
  assert.match(prompt, /qualitative labels such as average credit/i);
  assert.match(prompt, /different site's taxonomy/i);
  assert.match(prompt, /exact ZIP\/postal code/i);
  assert.match(prompt, /compound task, keep working on every independently achievable outcome/i);
  assert.match(prompt, /fallback search may locate a current first-party detail page/i);
  assert.match(prompt, /post-action confirmation/i);
  assert.match(prompt, /initialize `browser_evidence`/i);
  assert.match(prompt, /do not finish while any item is pending/i);
});

test("benchmark task selection accepts a deterministic comma-separated subset", () => {
  const tasks = [benchmarkTask(1), benchmarkTask(2), benchmarkTask(3)];
  assert.deepEqual(
    filterTasksByIds(tasks, `${tasks[2].task_id}, ${tasks[0].task_id}`).map(
      (task) => task.task_id,
    ),
    [tasks[0].task_id, tasks[2].task_id],
  );
  assert.throws(
    () => filterTasksByIds(tasks, "missing-task"),
    /not in this partition.*missing-task/,
  );
});

test("Pi event extraction keeps final text while omitting image payloads", () => {
  assert.equal(
    assistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Final answer" },
      ],
    }),
    "Final answer",
  );
  const compact = compactEvent({
    type: "tool_execution_end",
    result: { content: [{ type: "image", data: "abcdef", mimeType: "image/png" }] },
  });
  assert.equal(compact.result.content[0].data, "[omitted 6 base64 chars]");
  assert.equal(compactEvent({ type: "message_update" }), null);
});

test("trace actions use a consistent v2 grammar and expose failures", () => {
  assert.deepEqual(
    actionForTrace({ action: "navigate", response: "Open start", ok: true }),
    {
      action: "page -> NAVIGATE -> Open start | SUCCESS",
      action_status: "SUCCESS",
    },
  );
  assert.deepEqual(
    actionForTrace({
      action: "browser",
      response: "Apply the filters",
      arguments: { code: "await page.locator('input').fill('x'); await page.locator('button').click();" },
      ok: false,
    }),
    {
      action: "page -> WAIT -> Apply the filters | FAILED",
      action_status: "FAILED",
    },
  );
});

test("trajectory conversion emits and validates Online-Mind2Web v2 output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-om2w-"));
  const trace = path.join(dir, "trace");
  const taskDir = path.join(dir, "submission", "task");
  await fs.mkdir(trace, { recursive: true });
  const first = path.join(trace, "step_0000.png");
  const second = path.join(trace, "step_0001.png");
  await fs.writeFile(first, "first");
  await fs.writeFile(second, "second");
  await fs.writeFile(
    path.join(trace, "steps.jsonl"),
    `${[
      {
        step_num: 0,
        action: "navigate",
        response: "Open the supplied site",
        screenshot: first,
        url: "https://example.com/start",
        ok: true,
      },
      {
        step_num: 1,
        action: "browser",
        response: "Open the result",
        arguments: { code: "await page.getByRole('link').click()" },
        screenshot: second,
        url: "https://example.com/result",
        ok: true,
      },
    ].map(JSON.stringify).join("\n")}\n`,
  );
  try {
    const result = await buildV2Submission(
      benchmarkTask(1),
      "The requested result is open.",
      trace,
      taskDir,
    );
    assert.equal(result.schema_version, "online-mind2web-v2");
    assert.equal(result.action_history.length, 3);
    assert.deepEqual(result.action_history.map((step) => step.step), [0, 1, 2]);
    assert.equal(result.action_history.at(-1).action, "TASK_COMPLETE -> ANSWER: The requested result is open.");
    assert.equal(await validateV2Submission(result, taskDir), true);
    assert.deepEqual((await fs.readdir(path.join(taskDir, "trajectory"))).sort(), ["0000.png", "0001.png", "0002.png"]);

    delete result.action_history[1].thought;
    await assert.rejects(validateV2Submission(result, taskDir), /no thought field/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runner invokes the pinned Pi model and produces a resumable submission", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-om2w-run-"));
  const fakePi = path.join(dir, "fake-pi.mjs");
  await fs.writeFile(
    fakePi,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
const trace = process.env.BETTERWRIGHT_PI_TRACE_DIR;
await fs.mkdir(trace, { recursive: true });
const image = path.join(trace, "step_0000.png");
await fs.writeFile(image, "png");
await fs.writeFile(path.join(trace, "steps.jsonl"), JSON.stringify({ step_num: 0, action: "navigate", response: "Open start", screenshot: image, url: process.env.BETTERWRIGHT_PI_START_URL, ok: true }) + "\\n");
console.log(JSON.stringify({ type: "session", version: 3, id: "fake" }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified result." }], stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } } }));
`,
  );
  await fs.chmod(fakePi, 0o755);
  try {
    const result = await runTask(
      { ...benchmarkTask(2), partition: "development" },
      dir,
      {
        browserTimeoutSeconds: 5,
        force: false,
        maxSteps: 3,
        now: new Date("2026-07-14T00:00:00Z"),
        piBin: fakePi,
        timeoutMinutes: 1,
      },
    );
    assert.equal(result.status, "completed");
    const attempt = JSON.parse(
      await fs.readFile(path.join(dir, "runtime", benchmarkTask(2).task_id, "attempt.json"), "utf8"),
    );
    assert.equal(attempt.model, BENCHMARK_MODEL);
    assert.equal(attempt.thinking, BENCHMARK_THINKING);
    assert.equal(attempt.usage.totalTokens, 15);

    const resumed = await runTask(
      { ...benchmarkTask(2), partition: "development" },
      dir,
      { force: false },
    );
    assert.equal(resumed.status, "skipped");

    const resultPath = path.join(
      dir,
      "submission",
      benchmarkTask(2).task_id,
      "result.json",
    );
    const incomplete = JSON.parse(await fs.readFile(resultPath, "utf8"));
    incomplete.agent_final_answer = null;
    incomplete.action_history.at(-1).action = "TASK_COMPLETE -> ANSWER: ";
    await fs.writeFile(resultPath, `${JSON.stringify(incomplete, null, 2)}\n`);
    const retried = await runTask(
      { ...benchmarkTask(2), partition: "development" },
      dir,
      {
        browserTimeoutSeconds: 5,
        force: false,
        maxSteps: 3,
        now: new Date("2026-07-14T00:00:00Z"),
        piBin: fakePi,
        timeoutMinutes: 1,
      },
    );
    assert.equal(retried.status, "completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("local judge parsing is binary and internally consistent", () => {
  assert.deepEqual(
    parseJudgeResponse(
      '{"score":100,"status":"success","reasoning":"Visible proof satisfies the task.","failed_key_points":[]}',
    ),
    {
      score: 100,
      status: "success",
      reasoning: "Visible proof satisfies the task.",
      failed_key_points: [],
    },
  );
  assert.throws(
    () =>
      parseJudgeResponse(
        '{"score":100,"status":"failure","reasoning":"x","failed_key_points":[]}',
      ),
    /disagree/,
  );
  assert.throws(() => parseJudgeResponse("Score: 100"), /JSON object/);
});

test("local judge selects distinct high-value frames and maps them into its prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-om2w-judge-"));
  const trajectory = path.join(dir, "trajectory");
  await fs.mkdir(trajectory);
  const history = [];
  for (let index = 0; index < 5; index += 1) {
    const screenshot = `${String(index).padStart(4, "0")}.png`;
    await fs.writeFile(path.join(trajectory, screenshot), index >= 3 ? "same-final" : `image-${index}`);
    history.push({
      step: index,
      screenshot,
      url: `https://example.com/${index}`,
      action:
        index === 4
          ? "TASK_COMPLETE -> ANSWER: done"
          : `page -> CLICK -> ${index === 2 ? "Apply exact price filter" : `step ${index}`} | SUCCESS`,
      action_status: index === 4 ? null : "SUCCESS",
      thought: index === 2 ? "Verify the filter result" : null,
    });
  }
  const result = {
    agent_final_answer: "done",
    action_history: history,
  };
  try {
    const evidence = await selectEvidence(result, dir, 3);
    assert.equal(evidence.length, 3);
    assert.ok(evidence.some((step) => step.step === 0));
    assert.ok(evidence.some((step) => step.step === 2));
    assert.equal(evidence.filter((step) => step.step >= 3).length, 1);
    const prompt = buildJudgePrompt(benchmarkTask(1), result, evidence);
    assert.match(prompt, /Attachment 1:/);
    assert.match(prompt, /Apply exact price filter/);
    assert.match(prompt, /Specified starting website: https:\/\/example\.com\/1/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("local judge counts a missing trajectory submission as a deterministic failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-om2w-invalid-"));
  const task = { ...benchmarkTask(9), partition: "development" };
  const runtimeDir = path.join(dir, "runtime", task.task_id);
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, "attempt.json"),
    `${JSON.stringify({
      submission_error: "Task produced no trajectory screenshots.",
      process: { code: 0, signal: null, error: null },
      timed_out: false,
    })}\n`,
  );
  try {
    const record = await judgeTask(task, dir, {
      force: false,
      maxImages: 12,
      piBin: "/does/not/run",
      timeoutMinutes: 1,
    });
    assert.equal(record.score, 0);
    assert.equal(record.status, "failure");
    assert.match(record.reasoning, /no valid Online-Mind2Web v2 submission/i);
    assert.match(record.reasoning, /no trajectory screenshots/i);

    const resumed = await judgeTask(task, dir, {
      force: false,
      maxImages: 12,
      piBin: "/does/not/run",
      timeoutMinutes: 1,
    });
    assert.equal(resumed.skipped, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
