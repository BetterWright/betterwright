#!/usr/bin/env node
// Shared Odysseys dataset helpers + trajectory submission builder.
// Rubric scoring lives in judge.mjs.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_PROMPT_PATH = path.join(HERE, "agent-prompt.md");
export const SAMPLE_SCHEMA = "betterwright-odysseys-sample-v1";
export const SUBMISSION_SCHEMA = "odysseys-betterwright-v1";
export const BENCHMARK_MODEL = "gpt-5.6-sol";
export const BENCHMARK_EFFORT = "high";
/** Pi model id for the multimodal rubric judge. */
export const JUDGE_PI_MODEL = "openai-codex/gpt-5.6-luna";
export const JUDGE_PI_THINKING = "high";

export function normalizeTask(input) {
  const taskId = String(input?.task_id || "").trim();
  const task = String(input?.task ?? input?.confirmed_task ?? "").trim();
  const website = String(input?.website || "https://www.google.com").trim();
  const referenceLength = Number(input?.reference_length || 1);
  const level = String(input?.level || "unknown").trim().toLowerCase();
  const rubrics = input?.rubrics && typeof input.rubrics === "object" ? input.rubrics : {};
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new TypeError(`Invalid Odysseys task_id: ${taskId || "<empty>"}`);
  }
  if (!task) throw new TypeError(`Task ${taskId} has no instruction.`);
  const url = new URL(website);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`Task ${taskId} website must use http or https.`);
  }
  if (!Number.isInteger(referenceLength) || referenceLength < 1) {
    throw new TypeError(`Task ${taskId} has an invalid reference_length.`);
  }
  const rubricEntries = Object.entries(rubrics).map(([id, value]) => {
    const requirement = String(value?.requirement || "").trim();
    const verification = String(value?.verification || "").trim();
    if (!requirement) throw new TypeError(`Task ${taskId} rubric ${id} has no requirement.`);
    return { id, requirement, verification };
  });
  if (!rubricEntries.length) throw new TypeError(`Task ${taskId} has no rubrics.`);
  return {
    task_id: taskId,
    website: url.href,
    task,
    confirmed_task: task,
    reference_length: referenceLength,
    level,
    rubrics: Object.fromEntries(
      rubricEntries.map((entry) => [
        entry.id,
        { requirement: entry.requirement, verification: entry.verification },
      ]),
    ),
    rubric_ids: rubricEntries.map((entry) => entry.id),
    categories: Array.isArray(input?.categories) ? input.categories.map(String) : [],
    num_categories: Number(input?.num_categories) || 0,
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

export function createFullManifest(tasks) {
  const selected = [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id));
  return {
    schema_version: SAMPLE_SCHEMA,
    benchmark: "Odysseys",
    count: selected.length,
    seed: null,
    selection: "All task IDs from the pinned Odysseys snapshot, sorted by task ID.",
    partitions: { benchmark: selected.length },
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
  if (!["all", "benchmark", "development", "holdout"].includes(partition)) {
    throw new TypeError("partition must be all, benchmark, development, or holdout.");
  }
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
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

export function filterTasksByLevel(tasks, value) {
  const levels = new Set(
    String(value || "")
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!levels.size) return tasks;
  return tasks.filter((task) => levels.has(task.level));
}

export function buildTaskPrompt(task, now = new Date()) {
  const rubricLines = Object.entries(task.rubrics || {})
    .map(([id, rubric]) => `- ${id}: ${rubric.requirement}`)
    .join("\n");
  return [
    `Task ID: ${task.task_id}`,
    `Difficulty: ${task.level}`,
    `Specified starting website: ${task.website}`,
    `Current UTC date: ${now.toISOString().slice(0, 10)}`,
    "",
    "Complete this long-horizon multi-site web task on the live Internet:",
    task.task,
    "",
    "Success criteria (satisfy every item; leave visual proof in tabs when asked):",
    rubricLines,
  ].join("\n");
}

function oneLine(value, fallback = "") {
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
      action: `page -> NAVIGATE -> ${oneLine(row.response, "Initial navigation")} | ${status}`,
      action_status: status,
    };
  }
  if (row.action === "evidence") {
    return {
      action: `EVIDENCE_CAPTURE -> ${oneLine(row.response, "tab proof")} | ${status}`,
      action_status: status,
    };
  }
  if (row.action === "final_tabs") {
    return {
      action: `END_STATE_TAB -> ${oneLine(row.response, "open tab at finish")} | ${status}`,
      action_status: status,
    };
  }
  const code = String(row.arguments?.code || "");
  const matches = [
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
  ].filter(([, pattern]) => pattern.test(code));
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

export async function buildSubmission(task, finalAnswer, traceDir, taskDir, meta = {}) {
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
  if (!history.length) {
    throw new Error(`Task ${task.task_id} produced no trajectory screenshots.`);
  }

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
    thought: answer ? "Returning the final deliverable." : null,
  });

  const result = {
    schema_version: SUBMISSION_SCHEMA,
    benchmark: "Odysseys",
    task: task.task,
    task_id: task.task_id,
    website: task.website,
    level: task.level,
    agent_final_answer: answer || null,
    reference_length: task.reference_length,
    rubrics: task.rubrics,
    action_history: history,
    meta: {
      model: meta.model || null,
      effort: meta.effort || null,
      steps: meta.steps ?? null,
      tool_calls: meta.toolCalls ?? null,
      usage: meta.usage || null,
      duration_ms: meta.durationMs ?? null,
      agent_ok: meta.agentOk ?? null,
      agent_reason: meta.agentReason ?? null,
      finish_audit: meta.finishAudit ?? null,
    },
  };
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await validateSubmission(result, taskDir);
  return result;
}

export async function validateSubmission(input, taskDir) {
  const result = typeof input === "string" ? JSON.parse(await fs.readFile(input, "utf8")) : input;
  if (result.schema_version !== SUBMISSION_SCHEMA) throw new Error("Wrong schema_version.");
  if (!/^[A-Za-z0-9_-]+$/.test(result.task_id)) throw new Error("Invalid task_id.");
  if (!result.task) throw new Error("Missing task text.");
  if (!result.rubrics || typeof result.rubrics !== "object") throw new Error("Missing rubrics.");
  if (!Array.isArray(result.action_history) || !result.action_history.length) {
    throw new Error("action_history must not be empty.");
  }
  for (const [index, step] of result.action_history.entries()) {
    if (step.step !== index) throw new Error(`Step ${index} is out of sequence.`);
    if (!("thought" in step)) throw new Error(`Step ${index} has no thought field.`);
    if (!/^(\d{4})\.(png|jpe?g|webp)$/.test(step.screenshot)) {
      throw new Error(`Step ${index} has an invalid screenshot name.`);
    }
    await fs.access(path.join(taskDir, "trajectory", step.screenshot));
    if (step.url !== null) new URL(step.url);
    if (!step.action) throw new Error(`Step ${index} has no action.`);
  }
  const finalAction = result.action_history.at(-1).action;
  if (!finalAction.startsWith("TASK_COMPLETE -> ANSWER:")) {
    throw new Error("Final action is not TASK_COMPLETE.");
  }
  return true;
}

export function hashDigest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
