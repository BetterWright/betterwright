#!/usr/bin/env node
// One Odysseys task through BetterWright's own agent harness (src/agent.ts).
// The parent (exec-runner.ts) spawns one of these per task with an isolated home.

import fs from "node:fs";
import path from "node:path";

import { resolveModel, runAgentTask } from "../../dist/src/agent.js";
import { BetterWright } from "../../dist/src/client.js";
import { AGENT_PROMPT_PATH, buildTaskPrompt } from "./runner.js";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const {
  task,
  session,
  home,
  traceDir,
  resultPath,
  transcriptPath,
  model,
  effort,
  maxDurationMs,
  systemPromptPath,
} = config;

fs.mkdirSync(traceDir, { recursive: true });
const stepsPath = path.join(traceDir, "steps.jsonl");
let traceIndex = 0;

const browser = new BetterWright({
  home,
  vault: false,
  headless: true,
  downloadPolicy: "allow",
});
const rawRun = browser.run.bind(browser);
const traceRows = [];

function oneLine(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 500);
}

function emitRow(row) {
  fs.appendFileSync(stepsPath, `${JSON.stringify({ step: traceIndex, ...row })}\n`);
  traceIndex += 1;
  traceRows.push(row);
}

// Page-inventory tracking for evidence density: every tab the agent's step
// touched gets its own proof screenshot, not just the active tab.
let prevPages = new Map(); // pageId -> { url, closed }

function diffTouchedPages(result) {
  const next = Array.isArray(result?.pages) ? result.pages : [];
  const touched = [];
  for (const p of next) {
    if (p?.type !== "Page") continue;
    const prev = prevPages.get(p.pageId);
    if ((!prev || prev.url !== p.url) && !p.closed && p.url && p.url !== "about:blank") {
      touched.push(p);
    }
  }
  prevPages = new Map(
    next.filter((p) => p && p.type === "Page").map((p) => [p.pageId, { url: p.url, closed: p.closed }]),
  );
  return touched;
}

const MAX_EVIDENCE_PER_STEP = 5;

async function captureStepEvidence(result) {
  const touched = diffTouchedPages(result);
  if (!touched.length) return;
  const activeId = (result.pages || []).find((p) => p?.active)?.pageId || null;
  const picks = touched.filter((p) => p.pageId !== activeId).slice(0, MAX_EVIDENCE_PER_STEP);
  if (!picks.length) return;
  const stepNo = traceIndex;
  const code = [
    "const __shots = [];",
    `for (const __id of ${JSON.stringify(picks.map((p) => p.pageId))}) {`,
    "  try {",
    "    await usePage(__id);",
    `    const __s = await screenshot({ name: \`ev-${stepNo}-\${__id}\` });`,
    "    __shots.push({ pageId: __id, url: page.url(), path: __s.path });",
    "  } catch (__e) { /* tab closed mid-capture */ }",
    "}",
    activeId ? `await usePage(${JSON.stringify(activeId)}).catch(() => {});` : "",
    "return __shots;",
  ].join("\n");
  let probe;
  try {
    probe = await rawRun(code, { session, timeout: 90 });
  } catch {
    return;
  }
  if (!probe.ok || !Array.isArray(probe.result)) return;
  for (const shot of probe.result) {
    emitRow({
      action: "evidence",
      arguments: { code: `proof capture of evidence tab ${shot.pageId}` },
      ok: true,
      response: `Visual proof of evidence tab ${shot.pageId}: ${shot.url}`,
      url: shot.url,
      screenshot: shot.path,
    });
  }
}

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
  emitRow({
    action,
    arguments: { code },
    ok: Boolean(result.ok),
    response,
    url,
    screenshot,
  });
  await captureStepEvidence(result);
}

browser.run = async (code, options: Record<string, any> = {}) => {
  const result = await rawRun(code, options);
  await recordStep("run", String(code), result, options.note);
  return result;
};

// End-state capture: one proof screenshot per open tab plus a machine-readable
// tab inventory, so "leave N tabs open" rubrics are verifiable in headless.
async function captureFinalState() {
  const code = [
    "const __inv = [];",
    "for (let __i = 0; __i < pages.length; __i++) {",
    "  try {",
    "    await usePage(__i);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code sent to the browser sandbox, where the placeholder is interpolated
    "    const __s = await screenshot({ name: `final-tab-${__i}` });",
    "    __inv.push({ index: __i, url: page.url(), title: await page.title(), path: __s.path });",
    "  } catch (__e) { /* tab closed mid-capture */ }",
    "}",
    "return __inv;",
  ].join("\n");
  let probe;
  try {
    probe = await rawRun(code, { session, timeout: 120 });
  } catch {
    return [];
  }
  if (!probe.ok || !Array.isArray(probe.result)) return [];
  const inventory = probe.result;
  for (const tab of inventory) {
    emitRow({
      action: "final_tabs",
      arguments: { code: `end-state proof of open tab ${tab.index}` },
      ok: true,
      response: `End-state open tab ${tab.index}: ${tab.title || "(untitled)"} — ${tab.url}`,
      url: tab.url,
      screenshot: tab.path,
    });
  }
  return inventory.map(({ index, url, title }) => ({ index, url, title }));
}

// Finish guard, warn-only mode: audit the completed run for the two failure
// classes the judge rejects most (SERP-only evidence, missing open tabs).
// Results go to finish-audit.json + the exec result; nothing is blocked yet.
const SEARCH_HOST =
  /(^|\.)(google|bing|duckduckgo|yahoo|baidu|startpage|ecosia)\.[a-z.]+/i;
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function finishAudit({ rows, finalTabs, answer, taskText }) {
  const withUrl = rows.filter((r) => r.url);
  const searchRows = withUrl.filter((r) => SEARCH_HOST.test(r.url));
  const text = String(taskText || "");
  const countMatch = text.match(
    /(?:keep|leave)\s+(?:the\s+)?(?:exactly\s+|at least\s+|only\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[a-z-]+\s+){0,4}tabs?\s+(?:left\s+)?open/i,
  );
  const requiredTabs = countMatch
    ? Number(countMatch[1]) || NUMBER_WORDS[countMatch[1].toLowerCase()] || null
    : null;
  const genericTabReq =
    /(?:keep|leave)[^.\n]{0,120}(?:tabs?|pages)\s+(?:left\s+)?open/i.test(text) ||
    /tabs?\s+open\s+(?:in\s+)?(?:separate|individual|the\s+browser)/i.test(text);
  const reasons = [];
  if (requiredTabs != null && finalTabs.length < requiredTabs) {
    reasons.push(
      `tab_count: task asks for ~${requiredTabs} open tabs, ${finalTabs.length} open at finish`,
    );
  } else if (requiredTabs == null && genericTabReq && finalTabs.length === 0) {
    reasons.push("tab_count: task asks for tabs/pages left open, none open at finish");
  }
  const serpRatio = withUrl.length ? searchRows.length / withUrl.length : 0;
  if (withUrl.length >= 4 && serpRatio > 0.5) {
    reasons.push(
      `serp_evidence: ${searchRows.length}/${withUrl.length} trace URLs are search engines`,
    );
  }
  if (!String(answer || "").trim()) reasons.push("empty_answer");
  return {
    version: 1,
    mode: "warn",
    would_reject: reasons.length > 0,
    reasons,
    stats: {
      trace_urls: withUrl.length,
      search_host_urls: searchRows.length,
      serp_ratio: Number(serpRatio.toFixed(3)),
      required_tabs: requiredTabs,
      generic_tab_requirement: genericTabReq,
      open_tabs_at_finish: finalTabs.length,
    },
  };
}

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
          process.stderr.write(
            `[retry ${attempt + 1}] ${message.slice(0, 120)} — waiting ${Math.round(pause / 1000)}s\n`,
          );
          await new Promise((resolve) => setTimeout(resolve, pause));
          delayMs = Math.min(delayMs * 2, 120_000);
        }
      }
    },
  };
}

async function main() {
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
    "Initial navigation to the specified Odysseys starting website",
  );

  const promptPath = systemPromptPath || AGENT_PROMPT_PATH;
  const systemExtra = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
  const taskText = [
    systemExtra.trim(),
    "",
    buildTaskPrompt(task, new Date()),
  ]
    .filter(Boolean)
    .join("\n");

  let outcome;
  let agentThrew = false;
  try {
    outcome = await runAgentTask({
      task: taskText,
      model: retryingModel(resolveModel(model, { effort })),
      modelOptions: { effort },
      browser,
      session,
      maxDurationMs,
      onStep: ({ step, tool, note }) =>
        process.stderr.write(`[${step}] ${tool}${note ? `: ${note}` : ""}\n`),
    });
  } catch (error) {
    agentThrew = true;
    outcome = {
      ok: false,
      answer: "",
      reason: "error",
      error: error?.message || String(error),
      transcript: [],
    };
  }

  const finalTabs = await captureFinalState();
  const audit = finishAudit({
    rows: traceRows,
    finalTabs,
    answer: outcome.answer,
    taskText: task.task,
  });
  try {
    fs.writeFileSync(
      path.join(traceDir, "finish-audit.json"),
      `${JSON.stringify({ final_tabs: finalTabs, audit }, null, 2)}\n`,
    );
  } catch {
    /* audit is best-effort */
  }

  fs.writeFileSync(transcriptPath, `${JSON.stringify(outcome.transcript, null, 2)}\n`);
  const { transcript, ...rest } = outcome;
  fs.writeFileSync(resultPath, `${JSON.stringify({ ...rest, audit, final_tabs: finalTabs }, null, 2)}\n`);
  return agentThrew;
}

let exitCode = 0;
try {
  const agentThrew = await main();
  if (agentThrew) exitCode = 1;
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  try {
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify(
        {
          ok: false,
          answer: "",
          reason: "error",
          error: error?.message || String(error),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    /* parent reads the missing file as failure */
  }
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
process.exit(exitCode);
