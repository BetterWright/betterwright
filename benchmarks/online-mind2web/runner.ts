#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PI_EXTENSION = path.join(ROOT, "dist/src/pi-extension.js");
const AGENT_PROMPT_PATH = path.join(HERE, "agent-prompt.md");

export const BENCHMARK_MODEL = "openai-codex/gpt-5.6-sol";
export const BENCHMARK_THINKING = "high";
export const SAMPLE_SCHEMA = "betterwright-online-mind2web-sample-v1";
export const SAMPLE_SEED = "betterwright-online-mind2web-v1";

const UPDATED_AFTER_MIRROR = new Set([
  "47186fac8e7c7277af01144644eb4e0b",
  "50d91eabde542906937ab4c5b6f8f23a",
  "547f5729c59d5d12a457a3ebb74c31c6",
  "78baf9dbe7c3532f7d7ef4cc22a7f065",
  "7e1047f4803237f319c004f7a7f6bccb",
  "85b284c18d7e78c9b5a9e074e7aa3b98",
  "8ae510355d978424f490798f900bfa2c",
  "b64f938af842f6a1b4489d0e49a785a7",
  "c698ff3fc0f6cbce39947c597ab5749b",
  "c94551d2b18f9ad0ab31b0bd98ca42e3",
  "fc53ddd3421411a41c1020a3fdc84ec4",
  "199be0b54a436daee74247971fc684ee",
  "1bc154377120ec15b18dbabdba49c741",
]);

type Task = Record<string, any>;

function hash(seed, value) {
  return crypto.createHash("sha256").update(`${seed}\0${value}`).digest("hex");
}

function baseTaskId(taskId) {
  return String(taskId).replace(/_\d{6}$/, "");
}

function largestRemainderQuotas(counts: Record<string, number>, total) {
  const sum = Object.values(counts).reduce((value, count) => value + count, 0);
  const exact = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [key, (total * count) / sum]),
  );
  const quotas = Object.fromEntries(
    Object.entries(exact).map(([key, value]) => [key, Math.floor(value)]),
  );
  const remaining = total - Object.values(quotas).reduce((a, b) => a + b, 0);
  const ranked = Object.keys(exact).sort(
    (a, b) => exact[b] - quotas[b] - (exact[a] - quotas[a]) || a.localeCompare(b),
  );
  for (const key of ranked.slice(0, remaining)) quotas[key] += 1;
  return quotas;
}

export function normalizeTask(input) {
  const taskId = String(input?.task_id || "").trim();
  const task = String(input?.task ?? input?.confirmed_task ?? "").trim();
  const website = String(input?.website || "").trim();
  const referenceLength = Number(input?.reference_length);
  const level = String(input?.level || "unknown").trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new TypeError(`Invalid Online-Mind2Web task_id: ${taskId || "<empty>"}`);
  }
  if (!task) throw new TypeError(`Task ${taskId} has no instruction.`);
  const url = new URL(website);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`Task ${taskId} website must use http or https.`);
  }
  if (!Number.isInteger(referenceLength) || referenceLength < 1) {
    throw new TypeError(`Task ${taskId} has an invalid reference_length.`);
  }
  return {
    task_id: taskId,
    website: url.href,
    task,
    reference_length: referenceLength,
    level,
  };
}

export async function loadTasks(filename) {
  const parsed = JSON.parse(await fs.readFile(filename, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(rows)) throw new TypeError("Task file must be an array or { tasks: [] }.");
  const tasks = rows.map(normalizeTask);
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) {
    throw new TypeError("Task file contains duplicate task IDs.");
  }
  return tasks;
}

export function createSampleManifest(
  tasks: Task[],
  options: { count?: string | number; holdoutCount?: string | number; seed?: string } = {},
) {
  const count = Number(options.count ?? 50);
  const holdoutCount = Number(options.holdoutCount ?? 15);
  const seed = String(options.seed || SAMPLE_SEED);
  if (!Number.isInteger(count) || count < 1 || count > tasks.length) {
    throw new TypeError("Sample count must be a positive integer no larger than the dataset.");
  }
  if (!Number.isInteger(holdoutCount) || holdoutCount < 1 || holdoutCount >= count) {
    throw new TypeError("Holdout count must be between 1 and sample count - 1.");
  }
  const stable = tasks.filter(
    (task) => !UPDATED_AFTER_MIRROR.has(baseTaskId(task.task_id)),
  );
  if (stable.length < count) throw new Error("Not enough unchanged tasks for the sample.");

  const byLevel = Map.groupBy(stable, (task) => task.level);
  const quotas = largestRemainderQuotas(
    Object.fromEntries([...byLevel].map(([level, rows]) => [level, rows.length])),
    count,
  );
  const selected = [];
  for (const [level, rows] of byLevel) {
    rows.sort((a, b) =>
      hash(seed, a.task_id).localeCompare(hash(seed, b.task_id)),
    );
    selected.push(...rows.slice(0, quotas[level]));
  }

  const selectedByLevel = Map.groupBy(selected, (task) => task.level);
  const holdoutQuotas = largestRemainderQuotas(
    Object.fromEntries(
      [...selectedByLevel].map(([level, rows]) => [level, rows.length]),
    ),
    holdoutCount,
  );
  const holdout = new Set();
  for (const [level, rows] of selectedByLevel) {
    rows.sort((a, b) =>
      hash(`${seed}/holdout`, a.task_id).localeCompare(
        hash(`${seed}/holdout`, b.task_id),
      ),
    );
    for (const task of rows.slice(0, holdoutQuotas[level])) {
      holdout.add(task.task_id);
    }
  }
  selected.sort((a, b) =>
    hash(seed, a.task_id).localeCompare(hash(seed, b.task_id)),
  );

  return {
    schema_version: SAMPLE_SCHEMA,
    benchmark: "Online-Mind2Web",
    count,
    seed,
    selection:
      "Difficulty-stratified SHA-256 sample from task IDs unchanged after the source mirror; order independent.",
    excluded_updated_task_bases: [...UPDATED_AFTER_MIRROR].sort(),
    partitions: {
      development: count - holdoutCount,
      holdout: holdoutCount,
    },
    tasks: selected.map((task) => ({
      task_id: task.task_id,
      level: task.level,
      partition: holdout.has(task.task_id) ? "holdout" : "development",
    })),
  };
}

export function createFullManifest(tasks) {
  const selected = [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id));
  return {
    schema_version: SAMPLE_SCHEMA,
    benchmark: "Online-Mind2Web",
    count: selected.length,
    seed: null,
    selection: "All task IDs from the pinned source snapshot, sorted by task ID.",
    excluded_updated_task_bases: [],
    partitions: {
      benchmark: selected.length,
    },
    tasks: selected.map((task) => ({
      task_id: task.task_id,
      level: task.level,
      partition: "benchmark",
    })),
  };
}

export function tasksForManifest(tasks, manifest, partition = "all") {
  if (manifest?.schema_version !== SAMPLE_SCHEMA || !Array.isArray(manifest.tasks)) {
    throw new TypeError(`Manifest must use ${SAMPLE_SCHEMA}.`);
  }
  if (!["all", "development", "holdout"].includes(partition)) {
    throw new TypeError("partition must be all, development, or holdout.");
  }
  const byId = new Map<string, Task>(tasks.map((task) => [task.task_id, task]));
  const selected = [];
  for (const entry of manifest.tasks) {
    if (partition !== "all" && entry.partition !== partition) continue;
    const task = byId.get(entry.task_id);
    if (!task) throw new Error(`Task file is missing manifest task ${entry.task_id}.`);
    selected.push({ ...task, partition: entry.partition });
  }
  return selected;
}

export function filterTasksByIds(tasks, value) {
  const ids = [
    ...new Set(
      String(value || "")
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return tasks;
  const available = new Set(tasks.map((task) => task.task_id));
  const missing = ids.filter((taskId) => !available.has(taskId));
  if (missing.length) {
    throw new Error(`Selected task IDs are not in this partition: ${missing.join(", ")}`);
  }
  const requested = new Set(ids);
  return tasks.filter((task) => requested.has(task.task_id));
}

export function buildTaskPrompt(task, now = new Date()) {
  return [
    `Task ID: ${task.task_id}`,
    `Specified starting website: ${task.website}`,
    `Current UTC date: ${now.toISOString().slice(0, 10)}`,
    "",
    "Complete this task on the live website:",
    task.task,
  ].join("\n");
}

export function assistantText(message) {
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function sanitizedValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > 20_000 ? `${value.slice(0, 20_000)}\n[truncated]` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 8) return "[max depth]";
  if (Array.isArray(value)) return value.map((item) => sanitizedValue(item, depth + 1));
  if (value.type === "image" && typeof value.data === "string") {
    return { ...value, data: `[omitted ${value.data.length} base64 chars]` };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizedValue(item, depth + 1)]),
  );
}

export function compactEvent(event) {
  if (!event || event.type === "message_update") return null;
  if (event.type === "agent_end") {
    return { type: event.type, messageCount: event.messages?.length || 0 };
  }
  if (
    [
      "session",
      "agent_start",
      "turn_start",
      "turn_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "auto_retry_start",
      "auto_retry_end",
      "compaction_start",
      "compaction_end",
    ].includes(event.type)
  ) {
    return sanitizedValue(event);
  }
  return null;
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    total[key] += Number(usage[key]) || 0;
  }
  total.cost += Number(usage.cost?.total) || 0;
}

function oneLine(value, fallback) {
  const text = String(value || fallback)
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 500);
}

export function actionForTrace(row) {
  const status = row.ok ? "SUCCESS" : "FAILED";
  if (row.action === "navigate") {
    return {
      action: `page -> NAVIGATE -> ${oneLine(row.response, "Initial navigation to the supplied benchmark website")} | ${status}`,
      action_status: status,
    };
  }
  const code = String(row.arguments?.code || "");
  const matches = ([
    ["NAVIGATE", /\.(?:goto)\s*\(|\bopenPage\s*\(/],
    ["GO_BACK", /\.goBack\s*\(/],
    ["GO_FORWARD", /\.goForward\s*\(/],
    ["REFRESH", /\.reload\s*\(/],
    ["SELECT", /\.selectOption\s*\(/],
    ["TYPE", /\.(?:fill|type)\s*\(|\bhuman\.type\s*\(/],
    ["PRESS_KEY", /\.press\s*\(|\.keyboard\.(?:press|type)\s*\(/],
    ["SCROLL", /\b(?:scrollBy|scrollTo)\s*\(|\bhuman\.scroll\s*\(|\.mouse\.wheel\s*\(/],
    ["HOVER", /\.hover\s*\(/],
    ["CLICK", /\.click\s*\(|\bhuman\.click\s*\(/],
  ] as [string, RegExp][]).filter(([, pattern]) => pattern.test(code));
  const verb = matches.length === 1 ? matches[0][0] : "WAIT";
  const fallback =
    matches.length > 1
      ? `Execute browser action batch (${matches.map(([name]) => name).join(", ")})`
      : "Inspect the current browser state";
  return {
    action: `page -> ${verb} -> ${oneLine(row.response, fallback)} | ${status}`,
    action_status: status,
  };
}

async function readJsonLines(filename) {
  let body;
  try {
    body = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return body
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export async function buildV2Submission(task, finalAnswer, traceDir, taskDir) {
  const trajectoryDir = path.join(taskDir, "trajectory");
  await fs.rm(trajectoryDir, { recursive: true, force: true });
  await fs.mkdir(trajectoryDir, { recursive: true });
  const rows = await readJsonLines(path.join(traceDir, "steps.jsonl"));
  const history = [];
  for (const row of rows) {
    if (!row.screenshot) continue;
    try {
      const extension = path.extname(row.screenshot).toLowerCase() || ".png";
      const screenshot = `${String(history.length).padStart(4, "0")}${extension}`;
      await fs.copyFile(row.screenshot, path.join(trajectoryDir, screenshot));
      const action = actionForTrace(row);
      history.push({
        step: history.length,
        screenshot,
        url: row.url || task.website,
        action: action.action,
        action_status: action.action_status,
        thought: String(row.response || "").trim() || null,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!history.length) throw new Error(`Task ${task.task_id} produced no trajectory screenshots.`);

  const answer = String(finalAnswer || "").trim();
  const previous = history.at(-1);
  const extension = path.extname(previous.screenshot).toLowerCase() || ".png";
  const finalScreenshot = `${String(history.length).padStart(4, "0")}${extension}`;
  await fs.copyFile(
    path.join(trajectoryDir, previous.screenshot),
    path.join(trajectoryDir, finalScreenshot),
  );
  history.push({
    step: history.length,
    screenshot: finalScreenshot,
    url: previous.url,
    action: `TASK_COMPLETE -> ANSWER: ${answer}`,
    action_status: null,
    thought: answer ? "Returning the final answer after the evidence audit." : null,
  });

  const result = {
    schema_version: "online-mind2web-v2",
    task: task.task,
    task_id: task.task_id,
    agent_final_answer: answer || null,
    reference_length: task.reference_length,
    action_history: history,
  };
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await validateV2Submission(result, taskDir);
  return result;
}

export async function validateV2Submission(input, taskDir) {
  const result = typeof input === "string" ? JSON.parse(await fs.readFile(input, "utf8")) : input;
  if (result.schema_version !== "online-mind2web-v2") throw new Error("Wrong schema_version.");
  if (!/^[A-Za-z0-9_-]+$/.test(result.task_id)) throw new Error("Invalid task_id.");
  if (!result.task || !Number.isInteger(result.reference_length) || result.reference_length < 1) {
    throw new Error("Invalid task or reference_length.");
  }
  if (!Array.isArray(result.action_history) || !result.action_history.length) {
    throw new Error("action_history must not be empty.");
  }
  for (const [index, step] of result.action_history.entries()) {
    if (step.step !== index) throw new Error(`Step ${index} is out of sequence.`);
    if (!("thought" in step)) throw new Error(`Step ${index} has no thought field.`);
    if (!/^(\d{4}|\d+_full_screenshot_\d+)\.(png|jpe?g|webp)$/.test(step.screenshot)) {
      throw new Error(`Step ${index} has an invalid screenshot name.`);
    }
    await fs.access(path.join(taskDir, "trajectory", step.screenshot));
    if (step.url !== null) new URL(step.url);
    if (!step.action) throw new Error(`Step ${index} has no action.`);
    if (step.action_status && !step.action.endsWith(`| ${step.action_status}`)) {
      throw new Error(`Step ${index} action status disagrees with its suffix.`);
    }
  }
  const finalAction = result.action_history.at(-1).action;
  if (!finalAction.startsWith("TASK_COMPLETE -> ANSWER:")) {
    throw new Error("Final action is not TASK_COMPLETE.");
  }
  if (result.agent_final_answer !== null) {
    const embedded = finalAction.slice("TASK_COMPLETE -> ANSWER:".length).trim();
    if (embedded !== result.agent_final_answer.trim()) {
      throw new Error("agent_final_answer disagrees with TASK_COMPLETE.");
    }
  }
  return true;
}

async function runPi(task, runtimeDir, options) {
  const traceDir = path.join(runtimeDir, "trace");
  const homeDir = path.join(runtimeDir, "home");
  const workspaceDir = path.join(runtimeDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const systemPrompt = await fs.readFile(AGENT_PROMPT_PATH, "utf8");
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--extension",
    PI_EXTENSION,
    "--no-builtin-tools",
    "--tools",
    "browser,browser_download,browser_evidence",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    BENCHMARK_MODEL,
    "--thinking",
    BENCHMARK_THINKING,
    "--system-prompt",
    systemPrompt,
    buildTaskPrompt(task, options.now),
  ];
  const env = {
    ...process.env,
    BETTERWRIGHT_DISPLAY: "0",
    BETTERWRIGHT_HOME: homeDir,
    BETTERWRIGHT_PI_AUTO_SCREENSHOT: "1",
    BETTERWRIGHT_PI_DOWNLOAD_POLICY: "allow",
    BETTERWRIGHT_PI_MAX_STEPS: String(options.maxSteps),
    BETTERWRIGHT_PI_REQUIRE_EVIDENCE: "1",
    BETTERWRIGHT_PI_SESSION: task.task_id,
    BETTERWRIGHT_PI_START_URL: task.website,
    BETTERWRIGHT_PI_TIMEOUT_SECONDS: String(options.browserTimeoutSeconds),
    BETTERWRIGHT_PI_TRACE_DIR: traceDir,
    NO_COLOR: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const child = spawn(options.piBin, args, {
    cwd: workspaceDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  let finalAnswer = "";
  let fallbackAnswer = "";
  let parseErrors = 0;
  let toolCalls = 0;
  const compact = [];

  const stdoutTask = (async () => {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }
      if (event.type === "tool_execution_start") toolCalls += 1;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = assistantText(event.message);
        if (text) fallbackAnswer = text;
        if (text && event.message.stopReason === "stop") finalAnswer = text;
        addUsage(usage, event.message.usage);
      }
      const record = compactEvent(event);
      if (record) compact.push(record);
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
  await fs.writeFile(
    path.join(runtimeDir, "events.jsonl"),
    compact.map((event) => JSON.stringify(event)).join("\n") + (compact.length ? "\n" : ""),
  );
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  await fs.writeFile(path.join(runtimeDir, "stderr.log"), stderr);
  return {
    args,
    exit,
    finalAnswer: finalAnswer || fallbackAnswer,
    parseErrors,
    stderrTail: stderr.trim().split("\n").slice(-40).join("\n"),
    timedOut,
    toolCalls,
    traceDir,
    usage,
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
  const run = await runPi(task, runtimeDir, options);
  let submissionError = "";
  try {
    await buildV2Submission(task, run.finalAnswer, run.traceDir, taskDir);
  } catch (error) {
    submissionError = error?.message || String(error);
  }
  const status =
    run.exit.code === 0 && run.finalAnswer && !run.timedOut && !submissionError
      ? "completed"
      : "failed";
  const attempt = {
    task_id: task.task_id,
    partition: task.partition,
    model: BENCHMARK_MODEL,
    thinking: BENCHMARK_THINKING,
    status,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    process: run.exit,
    timed_out: run.timedOut,
    tool_calls: run.toolCalls,
    parse_errors: run.parseErrors,
    usage: run.usage,
    final_answer: run.finalAnswer,
    submission_error: submissionError || null,
    stderr_tail: run.stderrTail,
  };
  await fs.writeFile(path.join(runtimeDir, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`);
  return { task_id: task.task_id, status, finalAnswer: run.finalAnswer, attempt };
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

function parseCli(argv): Record<string, any> {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "run";
  const options: Record<string, any> = { command, force: false };
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
  if (!cli.tasks) throw new Error("--tasks is required.");
  const tasks = await loadTasks(path.resolve(cli.tasks));
  if (cli.command === "sample") {
    const manifest = createSampleManifest(tasks, {
      count: Number(cli.count || 50),
      holdoutCount: Number(cli.holdoutCount || 15),
      seed: cli.seed || SAMPLE_SEED,
    });
    const destination = path.resolve(cli.manifest || path.join(HERE, "sample-50.json"));
    await fs.writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${manifest.count}-task manifest to ${destination}`);
    return;
  }
  if (cli.command === "full") {
    const manifest = createFullManifest(tasks);
    const destination = path.resolve(cli.manifest || path.join(HERE, "full-300.json"));
    await fs.writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${manifest.count}-task full manifest to ${destination}`);
    return;
  }
  if (!cli.manifest) throw new Error("--manifest is required.");
  const manifest = JSON.parse(await fs.readFile(path.resolve(cli.manifest), "utf8"));
  let selected = tasksForManifest(tasks, manifest, cli.partition || "all");
  if (cli.taskId && cli.taskIds) {
    throw new Error("Use either --task-id or --task-ids, not both.");
  }
  if (cli.taskId) selected = selected.filter((task) => task.task_id === cli.taskId);
  if (cli.taskIds) selected = filterTasksByIds(selected, cli.taskIds);
  if (cli.limit) selected = selected.slice(0, Number(cli.limit));
  if (!selected.length) throw new Error("No tasks matched the requested selection.");

  if (cli.command === "validate") {
    if (!cli.output) throw new Error("validate requires --output.");
    for (const task of selected) {
      const taskDir = path.join(path.resolve(cli.output), "submission", task.task_id);
      await validateV2Submission(path.join(taskDir, "result.json"), taskDir);
    }
    console.log(`Validated ${selected.length} Online-Mind2Web v2 submissions.`);
    return;
  }
  if (cli.command !== "run") throw new Error(`Unknown command: ${cli.command}`);
  if (!cli.output) throw new Error("run requires --output.");
  const outputDir = path.resolve(cli.output);
  await fs.mkdir(outputDir, { recursive: true });
  const options = {
    browserTimeoutSeconds: Number(cli.browserTimeoutSeconds || 90),
    force: cli.force,
    maxSteps: Number(cli.maxSteps || 100),
    now: new Date(),
    piBin: cli.piBin || "pi",
    timeoutMinutes: Number(cli.timeoutMinutes || 45),
  };
  const concurrency = Number(cli.concurrency || 1);
  console.log(
    `Running ${selected.length} tasks with ${BENCHMARK_MODEL}, thinking=${BENCHMARK_THINKING}, concurrency=${concurrency}`,
  );
  const results = await mapLimit(selected, concurrency, async (task, index) => {
    console.log(`[${index + 1}/${selected.length}] start ${task.task_id}: ${task.task}`);
    const result = await runTask(task, outputDir, options);
    console.log(`[${index + 1}/${selected.length}] ${result.status} ${task.task_id}`);
    return result;
  });
  const summary = {
    benchmark: "Online-Mind2Web",
    model: BENCHMARK_MODEL,
    thinking: BENCHMARK_THINKING,
    partition: cli.partition || "all",
    task_count: selected.length,
    completed: results.filter((result) => ["completed", "skipped"].includes(result.status)).length,
    failed: results.filter((result) => result.status === "failed").length,
    generated_at: new Date().toISOString(),
    tasks: results.map(({ task_id, status }) => ({ task_id, status })),
  };
  await fs.writeFile(path.join(outputDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
