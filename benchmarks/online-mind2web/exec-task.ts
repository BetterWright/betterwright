#!/usr/bin/env node
// One Online-Mind2Web task through BetterWright's OWN agent harness (the exec
// shape, src/agent.ts) — no Pi. The parent (exec-runner.ts) spawns one of
// these per task with an isolated BetterWright home.
//
// The exec harness has no built-in trajectory recorder (that lived in the Pi
// extension), so this file adds one: it wraps browser.run so every agent step
// is followed by a trusted probe run that captures a viewport screenshot and
// the active URL, appended to trace/steps.jsonl in the exact row shape
// buildV2Submission() already consumes. The probe never runs model code.

import fs from "node:fs";
import path from "node:path";

import { resolveModel, runAgentTask } from "../../dist/src/agent.js";
import { BetterWright } from "../../dist/src/client.js";
import type { UntrustedValue } from "../../types/untrusted-value.js";
import { buildTaskPrompt } from "./runner.js";

function isString(value: UntrustedValue): value is string {
  return typeof value === "string";
}

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { task, session, home, traceDir, resultPath, transcriptPath, model, effort, maxDurationMs } =
  config;

fs.mkdirSync(traceDir, { recursive: true });
const stepsPath = path.join(traceDir, "steps.jsonl");
let traceIndex = 0;

// vault: false — benchmark tasks carry any credentials in the task text, and a
// per-task throwaway home has nothing stored anyway.
const browser = new BetterWright({
  home,
  vault: false,
  headless: true,
  downloadPolicy: "allow",
});
const rawRun = browser.run.bind(browser);

function oneLine(value) {
  if (value == null) return "";
  const text = isString(value) ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 500);
}

// Record the post-action state. A failed probe (crashed page, challenge
// interstitial) just drops the screenshot — the submission builder skips rows
// without one rather than aborting the task.
async function recordStep(action, code, result, note) {
  let screenshot = null;
  let url = null;
  try {
    const name = `trace-${String(traceIndex).padStart(4, "0")}.png`;
    const probe = await rawRun(
      `const s = await screenshot({ name: ${JSON.stringify(name)} }); return { url: page.url(), path: s.path };`,
      { session, timeout: 30 },
    );
    if (probe.ok && probe.result) {
      screenshot = probe.result.path || null;
      url = probe.result.url || null;
    }
  } catch {
    /* no screenshot for this row */
  }
  const response =
    String(note || "").trim() ||
    (result.ok ? oneLine(result.result) : oneLine(result.error || "run failed"));
  fs.appendFileSync(
    stepsPath,
    `${JSON.stringify({
      step: traceIndex,
      action,
      arguments: { code },
      ok: Boolean(result.ok),
      response,
      url,
      screenshot,
    })}\n`,
  );
  traceIndex += 1;
}

// The run options this wrapper inspects; only `note` is read here, and the
// whole object is forwarded to the real browser.run untouched.
interface TracedRunOptions {
  session?: string;
  timeout?: number;
  note?: string;
}

browser.run = async (code, options: TracedRunOptions = {}) => {
  const result = await rawRun(code, options);
  await recordStep("run", String(code), result, options.note);
  return result;
};

// At campaign concurrency the ChatGPT backend intermittently answers 429 (and
// the occasional 5xx); the codex adapter surfaces those as thrown errors with
// no retry, which would fail the whole task. Wrap complete() with jittered
// exponential backoff — the task's own maxDurationMs still bounds total time.
function retryingModel(base) {
  const retryable =
    /\((?:429|5\d\d)\)|rate limit|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|you can retry|error occurred while processing|overloaded/i;
  return {
    ...base,
    async complete(request) {
      let delayMs = 5_000;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await base.complete(request);
        } catch (error) {
          const message = String(error?.message || error);
          if (attempt >= 10 || !retryable.test(message)) throw error;
          const pause = delayMs + Math.random() * delayMs;
          process.stderr.write(`[retry ${attempt + 1}] ${message.slice(0, 120)} — waiting ${Math.round(pause / 1000)}s\n`);
          await new Promise((resolve) => setTimeout(resolve, pause));
          delayMs = Math.min(delayMs * 2, 120_000);
        }
      }
    },
  };
}

async function main() {
  // Start at the specified benchmark website, as the benchmark requires. A
  // failure here is recoverable — the row records it and the agent (whose task
  // prompt names the site) retries or reports the blocker itself.
  const startCode = `await page.goto(${JSON.stringify(task.website)}, { waitUntil: "domcontentloaded", timeout: 60000 }); return page.url();`;
  let start;
  try {
    start = await rawRun(startCode, { session, timeout: 90 });
  } catch (error) {
    start = { ok: false, error: error?.message || String(error) };
  }
  await recordStep(
    "navigate",
    startCode,
    start,
    "Initial navigation to the specified benchmark website",
  );

  const outcome = await runAgentTask({
    task: buildTaskPrompt(task, new Date()),
    model: retryingModel(resolveModel(model, { effort })),
    modelOptions: { effort },
    browser,
    session,
    maxDurationMs,
    onStep: ({ step, tool, note }) =>
      process.stderr.write(`[${step}] ${tool}${note ? `: ${note}` : ""}\n`),
  });

  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify(outcome.transcript, null, 2)}\n`,
  );
  const { transcript, ...rest } = outcome;
  fs.writeFileSync(resultPath, `${JSON.stringify(rest, null, 2)}\n`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  try {
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify({ ok: false, answer: "", reason: "error", error: error?.message || String(error) }, null, 2)}\n`,
    );
  } catch {
    /* parent reads the missing file as failure */
  }
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
process.exit(exitCode);
