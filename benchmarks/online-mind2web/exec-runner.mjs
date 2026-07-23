#!/usr/bin/env node
// Online-Mind2Web over BetterWright's OWN agent harness (`betterwright exec`
// shape, src/agent.mjs) instead of the Pi coding agent. Reuses the Pi runner's
// dataset/manifest loading, v2 submission builder, and validator so the same
// strict local judge applies unchanged.
//
//   node benchmarks/online-mind2web/exec-runner.mjs run \
//     --tasks /path/to/Online-Mind2Web.json \
//     --manifest benchmarks/online-mind2web/full-300-current.json \
//     --output benchmarks/online-mind2web/runs/exec-v1-300 \
//     --concurrency 50
//
// Each task runs in its own child process (exec-task.mjs) with an isolated
// BetterWright home, so a crashed browser or wedged site cannot take down the
// campaign. Existing valid submissions are skipped unless --force.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildV2Submission,
  filterTasksByIds,
  loadTasks,
  tasksForManifest,
  validateV2Submission,
} from "./runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXEC_TASK = path.join(HERE, "exec-task.mjs");

export const EXEC_MODEL = "gpt-5.6-sol";
export const EXEC_EFFORT = "medium";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Consumers start staggered so a 50-wide campaign does not launch 50 Chromium
// instances in the same instant.
async function mapLimit(items, concurrency, staggerMs, worker) {
  const results = new Array(items.length);
  let next = 0;
  const consume = async (consumerIndex) => {
    await sleep(consumerIndex * staggerMs);
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, (_, i) => consume(i)),
  );
  return results;
}

async function runExecChild(task, runtimeDir, options) {
  const traceDir = path.join(runtimeDir, "trace");
  const configPath = path.join(runtimeDir, "config.json");
  const resultPath = path.join(runtimeDir, "exec-result.json");
  const config = {
    task,
    session: task.task_id,
    home: path.join(runtimeDir, "home"),
    traceDir,
    resultPath,
    transcriptPath: path.join(runtimeDir, "transcript.json"),
    model: options.model,
    effort: options.effort,
    maxDurationMs: options.agentBudgetMinutes * 60_000,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const child = spawn(process.execPath, [EXEC_TASK, configPath], {
    cwd: runtimeDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrChunks = [];
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) stderrChunks.push(Buffer.from(chunk));
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, options.timeoutMinutes * 60_000);
  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(timer);
  await stderrTask;
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  await fs.writeFile(path.join(runtimeDir, "stderr.log"), stderr);

  let execResult = null;
  try {
    execResult = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    /* missing result file — reported as failure below */
  }
  return {
    exit,
    timedOut,
    execResult,
    traceDir,
    stderrTail: stderr.trim().split("\n").slice(-40).join("\n"),
  };
}

export async function runTask(task, outputDir, options) {
  const taskDir = path.join(outputDir, "submission", task.task_id);
  const runtimeDir = path.join(outputDir, "runtime", task.task_id);
  const resultPath = path.join(taskDir, "result.json");
  if (!options.force) {
    try {
      const existing = JSON.parse(await fs.readFile(resultPath, "utf8"));
      await validateV2Submission(existing, taskDir);
      if (!String(existing.agent_final_answer || "").trim()) {
        throw new Error("Existing submission has no final answer.");
      }
      return { task_id: task.task_id, status: "skipped", finalAnswer: existing.agent_final_answer };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Invalid partial output is replaced below.
      }
    }
  }
  await fs.rm(taskDir, { recursive: true, force: true });
  await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  const startedAt = new Date();
  const run = await runExecChild(task, runtimeDir, options);
  const answer = String(run.execResult?.answer || "").trim();
  let submissionError = "";
  try {
    await buildV2Submission(task, answer, run.traceDir, taskDir);
  } catch (error) {
    submissionError = error?.message || String(error);
  }
  const status =
    run.exit.code === 0 && run.execResult?.ok && answer && !run.timedOut && !submissionError
      ? "completed"
      : "failed";
  const attempt = {
    task_id: task.task_id,
    partition: task.partition,
    harness: "betterwright-exec",
    model: options.model,
    effort: options.effort,
    status,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    process: run.exit,
    timed_out: run.timedOut,
    agent_ok: run.execResult?.ok ?? null,
    agent_reason: run.execResult?.reason ?? null,
    steps: run.execResult?.steps ?? null,
    tool_calls: run.execResult?.toolCalls ?? null,
    usage: run.execResult?.usage ?? null,
    final_answer: answer,
    submission_error: submissionError || null,
    stderr_tail: run.stderrTail,
  };
  await fs.writeFile(path.join(runtimeDir, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`);
  return { task_id: task.task_id, status, finalAnswer: answer, attempt };
}

function parseCli(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "run";
  const options = { command, force: false };
  const boolean = new Set(["force"]);
  while (args.length) {
    const token = args.shift();
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (boolean.has(key)) options[key] = true;
    else {
      if (!args.length) throw new Error(`${token} requires a value.`);
      options[key] = args.shift();
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.command !== "run") throw new Error(`Unknown command: ${cli.command}`);
  if (!cli.tasks) throw new Error("--tasks is required.");
  if (!cli.manifest) throw new Error("--manifest is required.");
  if (!cli.output) throw new Error("--output is required.");
  // The child runs with cwd = its runtime dir, so every path handed to it must
  // be absolute.
  cli.output = path.resolve(cli.output);
  const tasks = await loadTasks(cli.tasks);
  const manifest = JSON.parse(await fs.readFile(cli.manifest, "utf8"));
  let selected = tasksForManifest(tasks, manifest, cli.partition || "all");
  selected = filterTasksByIds(selected, cli.taskIds || cli.taskId);
  const options = {
    force: cli.force,
    timeoutMinutes: Number(cli.timeoutMinutes || 35),
    agentBudgetMinutes: Number(cli.agentBudgetMinutes || 30),
    model: cli.model || EXEC_MODEL,
    effort: cli.effort || EXEC_EFFORT,
  };
  const concurrency = Number(cli.concurrency || 1);
  console.log(
    `Running ${selected.length} tasks with the BetterWright exec harness, ` +
      `model=${options.model}, effort=${options.effort}, concurrency=${concurrency}`,
  );
  const counts = { completed: 0, failed: 0, skipped: 0 };
  const results = await mapLimit(selected, concurrency, 300, async (task) => {
    const result = await runTask(task, cli.output, options);
    counts[result.status] = (counts[result.status] || 0) + 1;
    const done = counts.completed + counts.failed + counts.skipped;
    console.log(
      `[${done}/${selected.length}] ${task.task_id} ${result.status}` +
        `${result.status === "failed" ? ` (${result.attempt?.agent_reason || result.attempt?.submission_error || "?"})` : ""}`,
    );
    return result;
  });
  const summary = {
    harness: "betterwright-exec",
    model: options.model,
    effort: options.effort,
    concurrency,
    counts,
    tasks: results.map(({ task_id, status, finalAnswer }) => ({ task_id, status, finalAnswer })),
  };
  await fs.writeFile(
    path.join(cli.output, "run-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(counts));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
