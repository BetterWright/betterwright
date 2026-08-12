#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  CHROMIUM_FORK_RELEASE_TAG,
} from "../../dist/src/chromium-fork.js";
import { BetterWright, codexModel, runAgentTask } from "../../dist/src/index.js";

export const DATASET_NAME = "Stealth_Bench_V1";
export const PINNED_DATASET_SHA256 =
  "d9a842e6cf924929b25b39d1d96b6aa9eb89e05fe942598dfda85bf468d7cfda";

const execFileAsync = promisify(execFile);

const BLOCK_PATTERN =
  /\b(?:access denied|are you human|automated queries|bot detected|captcha|challenge-platform|checking your browser|cloudflare ray id|datadome|enable javascript and cookies|just a moment|perimeterx|press and hold|request blocked|security check|temporarily blocked|verify you are human|verify your identity|unusual traffic)\b/i;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function resolveBenchmarkBinary(value?) {
  const binary = String(value || "").trim();
  if (!binary) {
    throw new Error(
      "--binary is required; Stealth Bench only runs the BetterChromium.",
    );
  }
  if (!path.isAbsolute(binary)) throw new Error("--binary must be an absolute path.");
  let stat;
  try {
    stat = await fs.stat(binary);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`--binary was not found: ${binary}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`--binary must point to a file: ${binary}`);
  try {
    await fs.access(binary, fs.constants.X_OK);
  } catch {
    throw new Error(`--binary is not executable: ${binary}`);
  }
  return binary;
}

export function sanitizeEgressMetadata(upstreamProxy?) {
  if (!upstreamProxy) return { type: "direct" };
  const parsed = new URL(upstreamProxy);
  if (!new Set(["http:", "socks5:"]).has(parsed.protocol)) {
    throw new Error("--upstream-proxy must be an http:// or socks5:// URL.");
  }
  return {
    type: "upstream_proxy",
    protocol: parsed.protocol.slice(0, -1),
    hostname: parsed.hostname,
    port: parsed.port || null,
    authenticated: Boolean(parsed.username || parsed.password),
  };
}

export async function benchmarkBinaryMetadata(
  binary,
  options: { probeVersion?: (binary: string) => Promise<string> } = {},
) {
  const bytes = await fs.readFile(binary);
  const probeVersion =
    options.probeVersion ||
    (async (filename) => {
      const { stdout, stderr } = await execFileAsync(filename, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      return `${stdout}${stderr}`.trim();
    });
  const reportedVersion = await probeVersion(binary);
  const versionMatch = reportedVersion.match(/(?:Chromium|Chrome)\s+(\d+(?:\.\d+){3})/i);
  const chromiumVersion = versionMatch?.[1];
  const acceptedVersions = new Set([BETTERWRIGHT_CHROMIUM_VERSION, "150.0.7871.129"]);
  if (!chromiumVersion || !acceptedVersions.has(chromiumVersion)) {
    throw new Error(
      `--binary must report the candidate BetterChromium ${BETTERWRIGHT_CHROMIUM_VERSION} or preserved baseline 150.0.7871.129; got ${reportedVersion || "no version"}.`,
    );
  }
  return {
    name: "BetterChromium",
    chromium_version: chromiumVersion,
    build: chromiumVersion === BETTERWRIGHT_CHROMIUM_VERSION
      ? CHROMIUM_FORK_RELEASE_TAG
      : "preserved-chromium-150-baseline",
    reported_version: reportedVersion,
    path: binary,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
  };
}

export function configureForkEnvironment(binary, env = process.env) {
  env.BETTERWRIGHT_CHROMIUM_PATH = binary;
  delete env.BETTERWRIGHT_CHROMIUM_ROOT;
  delete env.CLOAKBROWSER_BINARY_PATH;
}

function decodedFernetToken(encryptedText) {
  const outer = Buffer.from(String(encryptedText).trim(), "base64");
  const token = Buffer.from(outer.toString("ascii"), "base64url");
  if (token.length < 73 || token[0] !== 0x80) {
    throw new Error("Stealth Bench task file is not a valid Fernet token.");
  }
  return token;
}

export function decryptTaskPayload(encryptedText, passphrase = DATASET_NAME) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const token = decodedFernetToken(encryptedText);
  const signed = token.subarray(0, -32);
  const signature = token.subarray(-32);
  const expected = crypto
    .createHmac("sha256", key.subarray(0, 16))
    .update(signed)
    .digest();
  if (!crypto.timingSafeEqual(signature, expected)) {
    throw new Error("Stealth Bench task file failed authentication.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key.subarray(16),
    token.subarray(9, 25),
  );
  return Buffer.concat([
    decipher.update(token.subarray(25, -32)),
    decipher.final(),
  ]).toString("utf8");
}

export function normalizeTask(input) {
  const taskId = String(input?.task_id ?? "").trim();
  const instruction = String(input?.confirmed_task ?? "").trim();
  const category = String(input?.category ?? "").trim();
  const websiteInput = String(input?.website ?? "").trim();
  const website = new URL(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(websiteInput)
      ? websiteInput
      : `https://${websiteInput}`,
  );
  if (!/^\d+$/.test(taskId)) throw new TypeError(`Invalid Stealth Bench task ID: ${taskId}`);
  if (!instruction) throw new TypeError(`Stealth Bench task ${taskId} has no instruction.`);
  if (!category) throw new TypeError(`Stealth Bench task ${taskId} has no category.`);
  if (!new Set(["http:", "https:"]).has(website.protocol)) {
    throw new TypeError(`Stealth Bench task ${taskId} must use HTTP or HTTPS.`);
  }
  return { taskId, instruction, category, website: website.href };
}

export async function loadStealthTasks(filename, options: { allowUnpinned?: boolean } = {}) {
  const encrypted = await fs.readFile(filename);
  const digest = sha256(encrypted);
  if (!options.allowUnpinned && digest !== PINNED_DATASET_SHA256) {
    throw new Error(
      `Unknown Stealth Bench dataset ${digest}; pass --allow-unpinned to run it intentionally.`,
    );
  }
  const parsed = JSON.parse(decryptTaskPayload(encrypted.toString("utf8")));
  if (!Array.isArray(parsed)) throw new TypeError("Stealth Bench task payload must be an array.");
  const tasks = parsed.map(normalizeTask);
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new TypeError("Stealth Bench task payload contains duplicate task IDs.");
  }
  const categories = Object.fromEntries(
    [...Map.groupBy(tasks, (task) => task.category)]
      .map(([category, rows]): [string, number] => [category, rows.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return { tasks, metadata: { name: DATASET_NAME, sha256: digest, count: tasks.length, categories } };
}

export function selectTasks(
  tasks,
  options: { taskIds?: string; category?: string; limit?: string | number } = {},
) {
  let selected = [...tasks];
  if (options.taskIds) {
    const ids = new Set(
      String(options.taskIds)
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const available = new Set(tasks.map((task) => task.taskId));
    const missing = [...ids].filter((taskId) => !available.has(taskId));
    if (missing.length) throw new Error(`Unknown Stealth Bench task IDs: ${missing.join(", ")}`);
    selected = selected.filter((task) => ids.has(task.taskId));
  }
  if (options.category) {
    const category = String(options.category).toLowerCase();
    selected = selected.filter((task) => task.category.toLowerCase() === category);
  }
  if (options.limit !== undefined) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer.");
    selected = selected.slice(0, limit);
  }
  if (!selected.length) throw new Error("No Stealth Bench tasks matched the selection.");
  return selected;
}

export function buildTaskPrompt(task) {
  return [
    `Stealth Bench task ${task.taskId}.`,
    `Start at ${task.website}`,
    "",
    task.instruction,
    "",
    "This run measures whether the browser reaches and operates the site without anti-bot intervention.",
    "Do not call captcha.solve, click a CAPTCHA, or work around an access-denied page.",
    "Do not capture screenshots. Use DOM text and challenge metadata only.",
    "Return PASSED only after completing the requested steps without a challenge.",
    "Return BLOCKED when an anti-bot, CAPTCHA, security check, or access-denied page prevents completion.",
    "Return FAILED only for a non-anti-bot failure. Keep the final reason brief.",
  ].join("\n");
}

function textFromObservation(observation) {
  return [
    observation?.title,
    observation?.bodyText,
    ...(observation?.warnings || []),
    ...(observation?.challenges || []).map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyAttempt({ answer, observations = [], agentOk = false }) {
  const normalizedAnswer = String(answer || "").trim();
  const observationText = observations.map(textFromObservation).join("\n");
  const challengeCount = observations.reduce(
    (count, observation) => count + (observation?.challenges?.length || 0),
    0,
  );
  if (/^BLOCKED\b/i.test(normalizedAnswer) || challengeCount || BLOCK_PATTERN.test(observationText)) {
    return { status: "blocked", challengeCount };
  }
  if (agentOk && /^PASSED\b/i.test(normalizedAnswer)) {
    return { status: "passed", challengeCount: 0 };
  }
  return { status: "failed", challengeCount: 0 };
}

async function finalObservation(browser, session) {
  const result = await browser.run(
    `const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
return { url: page.url(), title: await page.title(), bodyText: bodyText.slice(0, 4000) };`,
    { session, note: "Inspect final benchmark state", timeout: 15 },
  );
  const returned = result?.value && typeof result.value === "object" ? result.value : {};
  return {
    url: returned.url || result?.pages?.find((page) => page.active)?.url || null,
    title: returned.title || null,
    bodyText: returned.bodyText || "",
    challenges: result?.challenges || [],
    warnings: result?.warnings || [],
  };
}

export async function runTask(
  task,
  options: {
    headless?: boolean;
    timeoutMs?: number;
    upstreamProxy?: string;
    model?: string;
    effort?: string;
    onStep?: (event: any) => void;
  } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `betterwright-stealth-${task.taskId}-`));
  const session = `stealth-${task.taskId}-${crypto.randomUUID()}`;
  const observations = [];
  const browser = new BetterWright({
    home,
    headless: options.headless,
    vault: false,
    credentialCapture: false,
    downloadPolicy: "deny",
    stealthRuntimeFix: false,
    ...(options.upstreamProxy ? { upstreamProxy: options.upstreamProxy, geoip: true } : {}),
  });
  const originalRun = browser.run.bind(browser);
  browser.run = async (...args) => {
    const source = String(args[0] || "");
    if (/\bscreenshot\s*\(/i.test(source)) {
      throw new Error("Screenshots are disabled for Stealth Bench.");
    }
    if (/\bcaptcha\s*\.\s*solve\s*\(/i.test(source)) {
      throw new Error("CAPTCHA solving is disabled for Stealth Bench.");
    }
    const result = await originalRun(...args);
    if (result?.screenshots?.length || result?.artifacts?.some((item) => item?.kind === "screenshot")) {
      throw new Error("Stealth Bench produced a forbidden screenshot artifact.");
    }
    observations.push({
      challenges: result?.challenges || [],
      warnings: result?.warnings || [],
    });
    return result;
  };
  const startedAt = new Date();
  try {
    const result = await runAgentTask({
      task: buildTaskPrompt(task),
      browser,
      session,
      model: codexModel({ model: options.model || "gpt-5.6-sol", effort: options.effort || "high" }),
      maxDurationMs: options.timeoutMs,
      onStep: options.onStep,
    });
    observations.push(await finalObservation(browser, session));
    const verdict = classifyAttempt({
      answer: result.answer,
      observations,
      agentOk: result.ok,
    });
    return {
      task_id: task.taskId,
      category: task.category,
      website: task.website,
      mode: options.headless ? "headless" : "headed",
      status: verdict.status,
      challenge_count: verdict.challengeCount,
      agent_reason: result.reason,
      answer_sha256: sha256(result.answer || ""),
      steps: result.steps,
      tool_calls: result.toolCalls,
      duration_ms: result.durationMs,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      final_url: observations.at(-1)?.url || null,
    };
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
}

function parseCli(argv): Record<string, any> {
  const options: Record<string, any> = {};
  const boolean = new Set(["allowUnpinned"]);
  const args = [...argv];
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

function parseMode(value) {
  if (value === "headless") return true;
  if (value === "headed") return false;
  throw new Error("--mode must be headed or headless.");
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (!cli.dataset) throw new Error("--dataset is required.");
  if (!cli.output) throw new Error("--output is required.");
  const headless = parseMode(cli.mode || "headless");
  const binary = await resolveBenchmarkBinary(cli.binary);
  configureForkEnvironment(binary);
  const browserMetadata = await benchmarkBinaryMetadata(binary);
  const egress = sanitizeEgressMetadata(cli.upstreamProxy);
  const loaded = await loadStealthTasks(path.resolve(cli.dataset), {
    allowUnpinned: cli.allowUnpinned,
  });
  const selected = selectTasks(loaded.tasks, {
    taskIds: cli.taskIds,
    category: cli.category,
    limit: cli.limit,
  });
  const timeoutMs = Number(cli.timeoutMinutes || 10) * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("--timeout-minutes must be positive.");
  }
  const records = [];
  for (const [index, task] of selected.entries()) {
    console.log(`[${index + 1}/${selected.length}] ${task.taskId} ${task.category} ${headless ? "headless" : "headed"}`);
    const taskStarted = Date.now();
    let record;
    try {
      record = await runTask(task, {
        headless,
        timeoutMs,
        upstreamProxy: cli.upstreamProxy,
        model: cli.model,
        effort: cli.effort,
        onStep: ({ step, tool, note }) => console.log(`  step ${step} ${tool}: ${note || ""}`),
      });
    } catch (error) {
      const message = String(error?.message || error || "unknown task failure");
      record = {
        task_id: task.taskId,
        category: task.category,
        website: task.website,
        mode: headless ? "headless" : "headed",
        status: BLOCK_PATTERN.test(message) ? "blocked" : "failed",
        challenge_count: BLOCK_PATTERN.test(message) ? 1 : 0,
        agent_reason: "runner_error",
        error_sha256: sha256(message),
        duration_ms: Date.now() - taskStarted,
        started_at: new Date(taskStarted).toISOString(),
        finished_at: new Date().toISOString(),
        final_url: null,
      };
    }
    records.push(record);
    console.log(`  ${record.status} (${Math.round(record.duration_ms / 1000)}s)`);
  }
  const passed = records.filter((record) => record.status === "passed").length;
  const output = {
    benchmark: DATASET_NAME,
    dataset: loaded.metadata,
    browser: browserMetadata,
    mode: headless ? "headless" : "headed",
    model: cli.model || "gpt-5.6-sol",
    effort: cli.effort || "high",
    egress,
    run_controls: {
      timeout_minutes: timeoutMs / 60_000,
      allow_unpinned_dataset: cli.allowUnpinned === true,
      requested_task_ids: cli.taskIds || null,
      requested_category: cli.category || null,
      requested_limit: cli.limit === undefined ? null : Number(cli.limit),
      selected_task_ids: selected.map((task) => task.taskId),
      isolated_profile_per_task: true,
      concurrency: 1,
      geoip_from_upstream: Boolean(cli.upstreamProxy),
      screenshots: "disabled",
      captcha_solving: "disabled",
      captcha_clicking: "prohibited",
      plaintext_task_persistence: "disabled",
      downloads: "denied",
      credential_capture: "disabled",
    },
    task_count: records.length,
    passed,
    blocked: records.filter((record) => record.status === "blocked").length,
    failed: records.filter((record) => record.status === "failed").length,
    pass_rate: records.length ? passed / records.length : null,
    generated_at: new Date().toISOString(),
    tasks: records,
  };
  const destination = path.resolve(cli.output);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

