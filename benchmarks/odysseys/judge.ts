#!/usr/bin/env bun
// Rubric-based Odysseys judge (paper: arXiv:2604.24964).
// Multimodal: same Pi + @screenshot pattern as Online-Mind2Web's judge.
// Each rubric item is judged separately against the trajectory + final answer.
//
//   bun benchmarks/odysseys/judge.ts \
//     --tasks benchmarks/odysseys/odysseys.json \
//     --manifest benchmarks/odysseys/full-200.json \
//     --output benchmarks/odysseys/runs/full-200 \
//     --concurrency 4

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type { UntrustedValue } from "../../types/untrusted-value.js";
import {
  filterTasksByIds,
  filterTasksByLevel,
  JUDGE_PI_MODEL,
  JUDGE_PI_THINKING,
  loadTasks,
  tasksForManifest,
} from "./runner.js";

function isString(value: UntrustedValue): value is string {
  return typeof value === "string";
}

const JUDGE_SYSTEM = `You are a strict multimodal grader for Odysseys, a long-horizon web agent benchmark.

You will be given ONE rubric requirement at a time, plus the agent final answer, action history, and selected trajectory screenshots (attached as images).

Score that single rubric only:
- score 1 if the evidence shows the requirement is satisfied
- score 0 if it is not, or if evidence is insufficient

Rules:
1. Prefer screenshots and action history over unsupported claims in the final answer.
2. Partial progress that does not meet the rubric requirement scores 0.
3. If the rubric requires keeping a page open or visual proof, the attached screenshots / trajectory must show the relevant page state.
4. For factual extraction rubrics, the final answer must contain the required facts and they must be consistent with trajectory evidence when available.
5. Do not grade other rubrics in this response.

Return exactly one JSON object with no markdown:
{"score":1,"reasoning":"Concise evidence-based rationale.","evidence":"step/url/answer quote"}
or
{"score":0,"reasoning":"Concise evidence-based rationale.","evidence":"what was missing"}`;

function actionSummary(step) {
  if (step.action.startsWith("TASK_COMPLETE")) return "TASK_COMPLETE";
  return step.action.replace(/\s+/g, " ").slice(0, 700);
}

function evidencePriority(step, total) {
  const text = `${step.action} ${step.thought || ""}`;
  let score = (step.step / Math.max(total - 1, 1)) * 100;
  if (step.action.startsWith("TASK_COMPLETE")) score += 1_000;
  if (/proof|final|verify|result|compare|summary|deliver|itinerary|open|tab/i.test(text)) score += 400;
  if (step.action_status === "SUCCESS") score += 100;
  if (step.action_status === "FAILED") score -= 200;
  return score;
}

export async function selectEvidence(result, taskDir, maxImages = 12) {
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

  for (const step of result.action_history) {
    if (await add(step)) break;
  }
  for (const { step } of candidates) {
    if (selected.length >= limit) break;
    await add(step);
  }
  return selected.sort((a, b) => a.step - b.step);
}

export function buildRubricPrompt(task, result, rubricId, rubric, evidence) {
  const actions = result.action_history
    .map((step) => `${step.step}. ${actionSummary(step)} [url=${step.url || "unknown"}]`)
    .join("\n");
  const screenshots = evidence
    .map(
      (step, index) =>
        `Attachment ${index + 1}: trajectory step ${step.step}, ${actionSummary(step)}, URL ${step.url || "unknown"}`,
    )
    .join("\n");
  return `Benchmark: Odysseys
Task ID: ${task.task_id}
Difficulty: ${task.level}
Starting website: ${task.website}

Full user task:
${task.task}

Agent final answer:
${result.agent_final_answer || "<none>"}

Rubric to grade (${rubricId}):
Requirement: ${rubric.requirement}
Verification: ${rubric.verification || "Use trajectory evidence and the final answer."}

Action history:
${actions}

Attached screenshot mapping (images are attached multimodally — inspect them):
${screenshots || "No screenshots were available."}

Grade ONLY ${rubricId} and return the required JSON object.`;
}

export function parseRubricResponse(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Judge did not return a JSON object.");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const score = Number(parsed.score);
  if (![0, 1].includes(score)) throw new Error("Rubric score must be 0 or 1.");
  if (!isString(parsed.reasoning) || !parsed.reasoning.trim()) {
    throw new Error("Judge response has no reasoning.");
  }
  return {
    score,
    reasoning: parsed.reasoning.trim(),
    evidence: String(parsed.evidence || "").trim(),
  };
}

function assistantText(message) {
  if (message?.role !== "assistant") return "";
  if (isString(message.content)) return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && isString(block.text))
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Multimodal rubric call via Pi — same @image attachment path as
 * Online-Mind2Web's local Pi @image path (gpt-5.6-luna with vision).
 */
async function invokeRubricJudge(system, userText, evidence, options) {
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
    options.model,
    "--thinking",
    options.thinking,
    "--system-prompt",
    system,
    ...evidence.map((step) => `@${step.imagePath}`),
    userText,
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
  const stdoutTask = (async () => {
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
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
  const text = response || fallback;
  if (timedOut) throw new Error("Judge timed out.");
  if (exit.error) throw new Error(exit.error);
  if (exit.code !== 0 && !text) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 400);
    throw new Error(`Judge exited ${exit.code}${stderr ? `: ${stderr}` : ""}`);
  }
  return parseRubricResponse(text);
}

async function mapLimit(items, concurrency, worker) {
  const results: any[] = Array.from({ length: items.length });
  let next = 0;
  const consume = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );
  return results;
}

// One graded rubric line in the verdict; `error` is present only when the
// judge call itself failed and the score-0 verdict records why.
interface RubricScore {
  requirement: string;
  verification: string;
  score: number;
  reasoning: string;
  evidence: string;
  error?: string;
}

export async function judgeTask(task, outputDir, options) {
  const taskDir = path.join(outputDir, "submission", task.task_id);
  const verdictPath = path.join(taskDir, "rubric-verdict.json");
  if (!options.force) {
    try {
      const existing = JSON.parse(await fs.readFile(verdictPath, "utf8"));
      if (
        existing?.schema_version === "odysseys-rubric-verdict-v1" &&
        existing.status === "judged" &&
        existing.judge_method === "pi-multimodal" &&
        existing.judge_model === options.model
      ) {
        return { task_id: task.task_id, status: "skipped", verdict: existing };
      }
    } catch {
      /* judge below */
    }
  }

  let result;
  try {
    result = JSON.parse(await fs.readFile(path.join(taskDir, "result.json"), "utf8"));
  } catch (error) {
    return {
      task_id: task.task_id,
      status: "missing_submission",
      verdict: {
        schema_version: "odysseys-rubric-verdict-v1",
        task_id: task.task_id,
        level: task.level,
        status: "missing_submission",
        perfect: 0,
        rubric_average: 0,
        rubrics: {},
        error: error?.message || String(error),
      },
    };
  }

  const evidence = await selectEvidence(result, taskDir, options.maxImages);
  const rubricScores: Record<string, RubricScore> = {};
  let sum = 0;
  let count = 0;
  for (const [rubricId, rubric] of Object.entries<any>(task.rubrics)) {
    const prompt = buildRubricPrompt(task, result, rubricId, rubric, evidence);
    let graded;
    try {
      graded = await invokeRubricJudge(JUDGE_SYSTEM, prompt, evidence, options);
    } catch (error) {
      graded = {
        score: 0,
        reasoning: `Judge error: ${error?.message || String(error)}`,
        evidence: "",
        error: error?.message || String(error),
      };
    }
    const scored: RubricScore = {
      requirement: rubric.requirement,
      verification: rubric.verification,
      score: graded.score,
      reasoning: graded.reasoning,
      evidence: graded.evidence,
    };
    if (graded.error) scored.error = graded.error;
    rubricScores[rubricId] = scored;
    sum += graded.score;
    count += 1;
  }
  const average = count ? sum / count : 0;
  const perfect = count && sum === count ? 1 : 0;
  const verdict = {
    schema_version: "odysseys-rubric-verdict-v1",
    task_id: task.task_id,
    level: task.level,
    status: "judged",
    perfect,
    rubric_average: average,
    rubric_count: count,
    rubrics_passed: sum,
    judge_model: options.model,
    judge_thinking: options.thinking,
    judge_method: "pi-multimodal",
    evidence_steps: evidence.map((step) => step.step),
    agent_final_answer: result.agent_final_answer,
    trajectory_steps: result.action_history?.length || 0,
    rubrics: rubricScores,
  };
  await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
  return { task_id: task.task_id, status: "judged", verdict };
}

// The flags this judge reads. parseCli stores every `--flag value` pair it
// receives; a flag outside this list lands untyped and is simply never read.
interface JudgeCliOptions {
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
  model?: string;
  thinking?: string;
  effort?: string;
  maxImages?: string;
  timeoutMinutes?: string;
  piBin?: string;
  concurrency?: string;
}

function parseCli(argv): JudgeCliOptions {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "judge";
  const options: JudgeCliOptions = { command, force: false };
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

function summarize(verdicts) {
  const judged = verdicts.filter((v) => v.verdict?.status === "judged");
  const n = judged.length || 1;
  const perfectRate = judged.filter((v) => v.verdict.perfect === 1).length / (judged.length || 1);
  const avg = judged.reduce((s, v) => s + (v.verdict.rubric_average || 0), 0) / n;
  const totals: Record<string, { count: number; perfect: number; rubric_sum: number }> = {};
  for (const row of judged) {
    const level = row.verdict.level || "unknown";
    totals[level] ??= { count: 0, perfect: 0, rubric_sum: 0 };
    totals[level].count += 1;
    totals[level].perfect += row.verdict.perfect;
    totals[level].rubric_sum += row.verdict.rubric_average;
  }
  const byLevel: Record<string, { count: number; perfect_rate: number; rubric_average: number }> =
    {};
  for (const [level, stats] of Object.entries(totals)) {
    byLevel[level] = {
      count: stats.count,
      perfect_rate: stats.perfect / stats.count,
      rubric_average: stats.rubric_sum / stats.count,
    };
  }
  return {
    judged: judged.length,
    missing: verdicts.filter((v) => v.status === "missing_submission").length,
    skipped: verdicts.filter((v) => v.status === "skipped").length,
    perfect_rate: perfectRate,
    rubric_average: avg,
    by_level: byLevel,
  };
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (!cli.tasks) throw new Error("--tasks is required.");
  if (!cli.manifest) throw new Error("--manifest is required.");
  if (!cli.output) throw new Error("--output is required.");
  cli.output = path.resolve(cli.output);
  const tasks = await loadTasks(cli.tasks);
  const manifest = JSON.parse(await fs.readFile(cli.manifest, "utf8"));
  let selected = tasksForManifest(tasks, manifest, cli.partition || "all");
  selected = filterTasksByLevel(selected, cli.level || cli.levels);
  selected = filterTasksByIds(selected, cli.taskIds || cli.taskId);
  const options = {
    force: cli.force,
    model: cli.model || JUDGE_PI_MODEL,
    thinking: cli.thinking || cli.effort || JUDGE_PI_THINKING,
    maxImages: Number(cli.maxImages || 12),
    timeoutMinutes: Number(cli.timeoutMinutes || 10),
    piBin: cli.piBin || "pi",
    cwd: cli.output,
  };
  const concurrency = Number(cli.concurrency || 4);
  console.log(
    `Judging ${selected.length} Odysseys tasks multimodally with ` +
      `model=${options.model}, thinking=${options.thinking}, concurrency=${concurrency}`,
  );
  const results = await mapLimit(selected, concurrency, async (task) => {
    const row = await judgeTask(task, cli.output, options);
    const avg = row.verdict?.rubric_average;
    const perfect = row.verdict?.perfect;
    console.log(
      `${task.task_id.slice(0, 12)}… ${row.status}` +
        (avg != null && row.status === "judged"
          ? ` avg=${(avg * 100).toFixed(1)}% perfect=${perfect}`
          : row.status === "skipped"
            ? ` avg=${((row.verdict?.rubric_average || 0) * 100).toFixed(1)}% perfect=${row.verdict?.perfect}`
            : ""),
    );
    return row;
  });
  // Score summary over actually-judged submissions only (ignore missing).
  const summary = {
    benchmark: "Odysseys",
    judge_model: options.model,
    judge_thinking: options.thinking,
    judge_method: "pi-multimodal",
    ...summarize(results),
    tasks: results
      .filter((row) => row.verdict?.status === "judged" || row.status === "skipped")
      .map((row) => ({
        task_id: row.task_id,
        status: row.status,
        level: row.verdict?.level,
        perfect: row.verdict?.perfect ?? null,
        rubric_average: row.verdict?.rubric_average ?? null,
      })),
  };
  await fs.writeFile(
    path.join(cli.output, "score-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        judged: summary.judged,
        perfect_rate: summary.perfect_rate,
        rubric_average: summary.rubric_average,
        by_level: summary.by_level,
      },
      null,
      2,
    ),
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
