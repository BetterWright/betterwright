#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  assistantText,
  BENCHMARK_MODEL,
  BENCHMARK_THINKING,
  filterTasksByIds,
  loadTasks,
  tasksForManifest,
} from "./runner.js";

const JUDGE_SYSTEM_PROMPT = `You are a strict multimodal evaluator of an Online-Mind2Web browser trajectory.

Judge whether the agent achieved every explicit requirement in the user's task. Treat the action history and attached screenshots as evidence; do not trust unsupported claims in the final answer.

Evaluation contract:
1. Extract every explicit constraint, filter, sort, comparison, action, and requested datum from the task.
2. Required filters or options must visibly take effect. A search query containing the words is not enough when the site exposes dedicated controls.
3. Ranking terms such as cheapest, closest, earliest, latest, highest-rated, most popular, or most viewed must be grounded in the site's metric, sort, or a complete comparison of relevant candidates.
4. Numeric, date, duration, quantity, unit, and location constraints must match exactly. A broader or narrower range fails.
5. Tasks that require opening, displaying, adding, submitting, or changing state pass only when the resulting state is evidenced.
6. An empty or not-found result can pass when the correct action and exact constraints were applied.
7. The attempt must begin at the specified benchmark website. A reputable fallback may satisfy an information-only task only when the start site was genuinely inaccessible and the task itself did not explicitly require that site.
8. If any explicit key point lacks credible evidence, score failure. Scores are binary only.

Return exactly one JSON object with no markdown:
{"score":100,"status":"success","reasoning":"Concise evidence-based rationale.","failed_key_points":[]}
or
{"score":0,"status":"failure","reasoning":"Concise evidence-based rationale.","failed_key_points":["missing requirement"]}`;

function actionSummary(step) {
  if (step.action.startsWith("TASK_COMPLETE")) return "TASK_COMPLETE";
  return step.action.replace(/\s+/g, " ").slice(0, 700);
}

function evidencePriority(step, total) {
  const text = `${step.action} ${step.thought || ""}`;
  let score = (step.step / Math.max(total - 1, 1)) * 100;
  if (step.action.startsWith("TASK_COMPLETE")) score += 1_000;
  if (
    /proof|final|verify|result|display|filter|sort|select|compare|cheapest|closest|earliest|latest|highest|lowest|most |cart|submit|forecast|report/i.test(
      text,
    )
  )
    score += 500;
  if (step.action_status === "SUCCESS") score += 100;
  if (step.action_status === "FAILED") score -= 200;
  return score;
}

export async function selectEvidence(result, taskDir, maxImages = 8) {
  const limit = Math.max(0, Math.floor(Number(maxImages) || 0));
  if (!limit) return [];
  const candidates = result.action_history
    .map((step) => ({ step, priority: evidencePriority(step, result.action_history.length) }))
    .sort((a, b) => b.priority - a.priority || b.step.step - a.step.step);
  const selected = [];
  const seen = new Set();

  async function add(step) {
    const imagePath = path.join(taskDir, "trajectory", step.screenshot);
    let body;
    try {
      body = await fs.readFile(imagePath);
    } catch {
      return false;
    }
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (seen.has(digest)) return false;
    seen.add(digest);
    selected.push({ ...step, imagePath });
    return true;
  }

  // Keep the first valid frame so the judge can verify the required starting
  // site and any access failure that justifies a later fallback.
  for (const step of result.action_history) {
    if (await add(step)) break;
  }
  for (const { step } of candidates) {
    if (selected.length >= limit) break;
    await add(step);
  }
  return selected.sort((a, b) => a.step - b.step);
}

export function buildJudgePrompt(task, result, evidence) {
  const actions = result.action_history
    .map(
      (step) =>
        `${step.step}. ${actionSummary(step)} [url=${step.url || "unknown"}]`,
    )
    .join("\n");
  const screenshots = evidence
    .map(
      (step, index) =>
        `Attachment ${index + 1}: trajectory step ${step.step}, ${actionSummary(step)}, URL ${step.url || "unknown"}`,
    )
    .join("\n");
  return `Benchmark task ID: ${task.task_id}
Specified starting website: ${task.website}
User task: ${task.task}

Agent final answer:
${result.agent_final_answer || "<none>"}

Action history:
${actions}

Attached screenshot mapping:
${screenshots || "No screenshots were available."}

Apply the binary evaluation contract to every explicit key point and return the required JSON object.`;
}

export function parseJudgeResponse(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Judge did not return a JSON object.");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const status = String(parsed.status || "").toLowerCase();
  const score = Number(parsed.score);
  if (![0, 100].includes(score)) throw new Error("Judge score must be 0 or 100.");
  if (![
    [0, "failure"],
    [100, "success"],
  ].some(([expectedScore, expectedStatus]) => score === expectedScore && status === expectedStatus)) {
    throw new Error("Judge score and status disagree.");
  }
  if (typeof parsed.reasoning !== "string" || !parsed.reasoning.trim()) {
    throw new Error("Judge response has no reasoning.");
  }
  if (!Array.isArray(parsed.failed_key_points)) {
    throw new Error("Judge response has no failed_key_points array.");
  }
  return {
    score,
    status,
    reasoning: parsed.reasoning.trim(),
    failed_key_points: parsed.failed_key_points.map(String),
  };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    total[key] += Number(usage[key]) || 0;
  }
  total.cost += Number(usage.cost?.total) || 0;
}

async function invokeJudge(task, result, evidence, options) {
  const prompt = buildJudgePrompt(task, result, evidence);
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-tools",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    BENCHMARK_MODEL,
    "--thinking",
    BENCHMARK_THINKING,
    "--system-prompt",
    JUDGE_SYSTEM_PROMPT,
    ...evidence.map((step) => `@${step.imagePath}`),
    prompt,
  ];
  const child = spawn(options.piBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let response = "";
  let fallback = "";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  const stdoutTask = (async () => {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = assistantText(event.message);
        if (text) fallback = text;
        if (text && event.message.stopReason === "stop") response = text;
        addUsage(usage, event.message.usage);
      }
    }
  })();
  const stderrChunks = [];
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) stderrChunks.push(Buffer.from(chunk));
  })();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, options.timeoutMinutes * 60_000);
  const exit = await new Promise<{ code: number | null; signal: string | null; error: string | null }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(timer);
  await Promise.all([stdoutTask, stderrTask]);
  return {
    exit,
    response: response || fallback,
    stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
    timedOut,
    usage,
  };
}

export async function judgeTask(task, outputDir, options) {
  const taskDir = path.join(outputDir, "submission", task.task_id);
  const runtimeDir = path.join(outputDir, "runtime", task.task_id);
  const judgePath = path.join(runtimeDir, "judge.json");
  if (!options.force) {
    try {
      const existing = JSON.parse(await fs.readFile(judgePath, "utf8"));
      if ([0, 100].includes(existing.score)) return { ...existing, skipped: true };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Replace malformed partial output below.
      }
    }
  }
  let result;
  try {
    result = JSON.parse(await fs.readFile(path.join(taskDir, "result.json"), "utf8"));
  } catch (error) {
    let attempt = null;
    try {
      attempt = JSON.parse(
        await fs.readFile(path.join(runtimeDir, "attempt.json"), "utf8"),
      );
    } catch {
      // The invalid-submission record below remains self-contained.
    }
    const detail =
      attempt?.submission_error ||
      error?.message ||
      "No valid result.json was produced.";
    const now = new Date().toISOString();
    const record = {
      task_id: task.task_id,
      partition: task.partition,
      score: 0,
      status: "failure",
      reasoning: `The attempt produced no valid Online-Mind2Web v2 submission: ${detail}`,
      failed_key_points: [
        "Produce a valid result.json with at least one trajectory screenshot.",
      ],
      judge_model: BENCHMARK_MODEL,
      judge_thinking: BENCHMARK_THINKING,
      method:
        "BetterWright deterministic invalid-submission check; not official human evaluation",
      evidence: [],
      raw_response: "",
      parse_error: null,
      process: attempt?.process || null,
      timed_out: attempt?.timed_out === true,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      },
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      stderr_tail: String(attempt?.stderr_tail || ""),
    };
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(judgePath, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }
  const evidence = await selectEvidence(result, taskDir, options.maxImages);
  const startedAt = new Date();
  const run = await invokeJudge(task, result, evidence, {
    cwd: runtimeDir,
    piBin: options.piBin,
    timeoutMinutes: options.timeoutMinutes,
  });
  let verdict = null;
  let parseError = "";
  try {
    verdict = parseJudgeResponse(run.response);
  } catch (error) {
    parseError = error?.message || String(error);
  }
  const record = {
    task_id: task.task_id,
    partition: task.partition,
    score: verdict?.score ?? null,
    status: verdict?.status || "judge_error",
    reasoning: verdict?.reasoning || "",
    failed_key_points: verdict?.failed_key_points || [],
    judge_model: BENCHMARK_MODEL,
    judge_thinking: BENCHMARK_THINKING,
    method: "BetterWright local strict multimodal judge; not official human evaluation",
    evidence: evidence.map((step) => ({
      step: step.step,
      screenshot: step.screenshot,
      action: actionSummary(step),
      url: step.url,
    })),
    raw_response: run.response,
    parse_error: parseError || null,
    process: run.exit,
    timed_out: run.timedOut,
    usage: run.usage,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    stderr_tail: run.stderr.split("\n").slice(-40).join("\n"),
  };
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(judgePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

function parseCli(argv) {
  const options: Record<string, any> = { force: false };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "force") options.force = true;
    else {
      if (!args.length) throw new Error(`${token} requires a value.`);
      options[key] = args.shift();
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  for (const required of ["tasks", "manifest", "output"]) {
    if (!cli[required]) throw new Error(`--${required} is required.`);
  }
  const tasks = await loadTasks(path.resolve(cli.tasks));
  const manifest = JSON.parse(await fs.readFile(path.resolve(cli.manifest), "utf8"));
  let selected = tasksForManifest(tasks, manifest, cli.partition || "all");
  if (cli.taskId && cli.taskIds) {
    throw new Error("Use either --task-id or --task-ids, not both.");
  }
  if (cli.taskId) selected = selected.filter((task) => task.task_id === cli.taskId);
  if (cli.taskIds) selected = filterTasksByIds(selected, cli.taskIds);
  if (cli.limit) selected = selected.slice(0, Number(cli.limit));
  if (!selected.length) throw new Error("No tasks matched the requested selection.");
  const outputDir = path.resolve(cli.output);
  const options = {
    force: cli.force,
    maxImages: Number(cli.maxImages || 12),
    piBin: cli.piBin || "pi",
    timeoutMinutes: Number(cli.timeoutMinutes || 10),
  };
  const concurrency = Number(cli.concurrency || 1);
  console.log(
    `Judging ${selected.length} tasks with ${BENCHMARK_MODEL}, thinking=${BENCHMARK_THINKING}, maxImages=${options.maxImages}`,
  );
  const records = await mapLimit(selected, concurrency, async (task, index) => {
    console.log(`[${index + 1}/${selected.length}] judge ${task.task_id}`);
    const record = await judgeTask(task, outputDir, options);
    console.log(`[${index + 1}/${selected.length}] ${record.status} ${task.task_id}`);
    return record;
  });
  const judged = records.filter((record) => [0, 100].includes(record.score));
  const passed = judged.filter((record) => record.score === 100).length;
  const summary = {
    benchmark: "Online-Mind2Web",
    method: "BetterWright local strict multimodal judge; not official human evaluation",
    judge_model: BENCHMARK_MODEL,
    judge_thinking: BENCHMARK_THINKING,
    partition: cli.partition || "all",
    requested_tasks: selected.length,
    judged_tasks: judged.length,
    passed,
    failed: judged.length - passed,
    judge_errors: records.length - judged.length,
    pass_rate: judged.length ? passed / judged.length : null,
    generated_at: new Date().toISOString(),
    tasks: records.map((record) => ({
      task_id: record.task_id,
      score: record.score,
      status: record.status,
    })),
  };
  await fs.writeFile(path.join(outputDir, "score-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { JUDGE_SYSTEM_PROMPT };
