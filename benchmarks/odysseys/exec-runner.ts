#!/usr/bin/env bun
// Odysseys full-campaign runner over BetterWright's own agent harness.
//
//   bun benchmarks/odysseys/exec-runner.ts run \
//     --tasks benchmarks/odysseys/odysseys.json \
//     --manifest benchmarks/odysseys/full-200.json \
//     --output benchmarks/odysseys/runs/full-200 \
//     --model gpt-5.6-sol --effort high \
//     --concurrency 8
//
// Existing valid submissions are skipped unless --force.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_EFFORT,
  BENCHMARK_MODEL,
  buildSubmission,
  filterTasksByIds,
  filterTasksByLevel,
  loadTasks,
  tasksForManifest,
  validateSubmission,
} from "./runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXEC_TASK = path.join(HERE, "exec-task.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, concurrency, staggerMs, worker) {
  const results: any[] = Array.from({ length: items.length });
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
    systemPromptPath: options.systemPromptPath,
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
  const exit = await new Promise<{ code: number | null; signal: string | null; error: string | null }>((resolve) => {
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
    /* missing result file */
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
      await validateSubmission(existing, taskDir);
      if (!String(existing.agent_final_answer || "").trim()) {
        throw new Error("Existing submission has no final answer.");
      }
      return {
        task_id: task.task_id,
        level: task.level,
        status: "skipped",
        finalAnswer: existing.agent_final_answer,
      };
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
    await buildSubmission(task, answer, run.traceDir, taskDir, {
      model: options.model,
      effort: options.effort,
      steps: run.execResult?.steps,
      toolCalls: run.execResult?.toolCalls,
      usage: run.execResult?.usage,
      durationMs: run.execResult?.durationMs ?? Date.now() - startedAt.getTime(),
      agentOk: run.execResult?.ok,
      agentReason: run.execResult?.reason,
      finishAudit: run.execResult?.audit ?? null,
    });
  } catch (error) {
    submissionError = error?.message || String(error);
  }
  const status =
    run.exit.code === 0 && run.execResult?.ok && answer && !run.timedOut && !submissionError
      ? "completed"
      : "failed";
  const attempt = {
    task_id: task.task_id,
    level: task.level,
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
    finish_audit: run.execResult?.audit ?? null,
    steps: run.execResult?.steps ?? null,
    tool_calls: run.execResult?.toolCalls ?? null,
    usage: run.execResult?.usage ?? null,
    final_answer: answer,
    submission_error: submissionError || null,
    stderr_tail: run.stderrTail,
  };
  await fs.writeFile(path.join(runtimeDir, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`);
  // Append-friendly progress log for long campaigns.
  await fs.appendFile(
    path.join(outputDir, "progress.jsonl"),
    `${JSON.stringify({
      ts: attempt.finished_at,
      task_id: task.task_id,
      level: task.level,
      status,
      duration_ms: attempt.duration_ms,
      steps: attempt.steps,
      reason: attempt.agent_reason || attempt.submission_error || null,
    })}\n`,
  );
  return { task_id: task.task_id, level: task.level, status, finalAnswer: answer, attempt };
}

// The flags this runner reads. parseCli stores every `--flag value` pair it
// receives; a flag outside this list lands untyped and is simply never read.
interface RunCliOptions {
  command: string;
  force: boolean;
  tasks?: string;
  manifest?: string;
  output?: string;
  partition?: string;
  level?: string;
  levels?: string;
  taskIds?: string;
  taskId?: string;
  timeoutMinutes?: string;
  agentBudgetMinutes?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  concurrency?: string;
  staggerMs?: string;
}

function parseCli(argv): RunCliOptions {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "run";
  const options: RunCliOptions = { command, force: false };
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
  cli.output = path.resolve(cli.output);
  await fs.mkdir(cli.output, { recursive: true });
  const tasks = await loadTasks(cli.tasks);
  const manifest = JSON.parse(await fs.readFile(cli.manifest, "utf8"));
  let selected = tasksForManifest(tasks, manifest, cli.partition || "all");
  selected = filterTasksByLevel(selected, cli.level || cli.levels);
  selected = filterTasksByIds(selected, cli.taskIds || cli.taskId);
  const options = {
    force: cli.force,
    timeoutMinutes: Number(cli.timeoutMinutes || 100),
    agentBudgetMinutes: Number(cli.agentBudgetMinutes || 90),
    model: cli.model || BENCHMARK_MODEL,
    effort: cli.effort || BENCHMARK_EFFORT,
    systemPromptPath: path.resolve(cli.systemPrompt || path.join(HERE, "agent-prompt.md")),
  };
  // Default 8-wide. Each task holds its own Chromium and isolated home, so
  // memory scales with concurrency; in our runs a single host ran out of memory
  // at 20-wide. Raise it only after measuring peak RSS under load.
  const concurrency = Number(cli.concurrency || 8);
  const staggerMs = Number(cli.staggerMs || 600);
  console.log(
    `Odysseys: running ${selected.length} tasks with BetterWright exec, ` +
      `model=${options.model}, effort=${options.effort}, concurrency=${concurrency}, ` +
      `agentBudget=${options.agentBudgetMinutes}m, timeout=${options.timeoutMinutes}m`,
  );
  const counts = { completed: 0, failed: 0, skipped: 0 };
  const byLevel: Record<string, { completed: number; failed: number; skipped: number }> = {};
  const results = await mapLimit(selected, concurrency, staggerMs, async (task) => {
    const result = await runTask(task, cli.output, options);
    counts[result.status] = (counts[result.status] || 0) + 1;
    byLevel[task.level] ??= { completed: 0, failed: 0, skipped: 0 };
    byLevel[task.level][result.status] = (byLevel[task.level][result.status] || 0) + 1;
    const done = counts.completed + counts.failed + counts.skipped;
    console.log(
      `[${done}/${selected.length}] ${task.level} ${task.task_id.slice(0, 12)}… ${result.status}` +
        `${result.status === "failed" ? ` (${result.attempt?.agent_reason || result.attempt?.submission_error || "?"})` : ""}`,
    );
    return result;
  });
  const summary = {
    harness: "betterwright-exec",
    benchmark: "Odysseys",
    model: options.model,
    effort: options.effort,
    concurrency,
    agent_budget_minutes: options.agentBudgetMinutes,
    timeout_minutes: options.timeoutMinutes,
    counts,
    by_level: byLevel,
    tasks: results.map(({ task_id, level, status, finalAnswer }) => ({
      task_id,
      level,
      status,
      finalAnswer: finalAnswer ? `${String(finalAnswer).slice(0, 200)}…` : "",
    })),
  };
  await fs.writeFile(path.join(cli.output, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ counts, by_level: byLevel }));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
