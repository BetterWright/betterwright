#!/usr/bin/env bun
// Head-to-head: BetterWright's built-in agent harness (`betterwright exec`) vs
// a reference browser agent's own CLI, both plugged into the SAME model
// (codex / gpt-5.6-sol) at the SAME reasoning effort (low). Matching the model
// isolates the AGENT SCAFFOLD — the observe/act/verify loop — which is the thing
// this benchmark measures. The browser runtime itself was already at parity in
// benchmarks/browser-agent-headtohead.
//
//   REFERENCE_CLI=<cli> bun benchmarks/exec-headtohead/run.ts \
//     [--only <substr>] [--timeout <ms>] [--raw <file>]
//
// The comparison CLI is not vendored and not named here. Set REFERENCE_CLI to a
// CLI installed on your own machine that takes
// `<cli> exec -m <provider/model> --effort <e> "<task>"`; the script exits with
// an explanation if it is unset. Only the BetterWright column is reproducible
// from this repository, which is why REPORT.md is a development case study
// rather than a benchmark.
//
// Writes an aggregate results.json next to this file: per-scenario outcome,
// timings, turn counts, and BetterWright token usage. Agent answers, model
// transcripts, and local artifact paths are deliberately NOT persisted there —
// pass `--raw <file>` to dump them to a path of your choosing while debugging.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UntrustedValue } from "../../types/untrusted-value.js";

function isFiniteNumber(value: UntrustedValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MODEL = "gpt-5.6-sol";
const EFFORT = "low";
const REFERENCE_CLI = process.env.REFERENCE_CLI;

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : null;
};
const only = flag("--only");
const RAW_OUT = flag("--raw");
const TIMEOUT_MS = flag("--timeout") !== null ? Number(flag("--timeout")) : 150_000;

if (!REFERENCE_CLI) {
  process.stderr.write(
    "REFERENCE_CLI is not set.\n\n" +
      "This comparison needs a second agent CLI that this repository does not ship\n" +
      "and does not name. Set REFERENCE_CLI to one installed on your own machine\n" +
      'that accepts `<cli> exec -m <provider/model> --effort <e> "<task>"`:\n\n' +
      "  REFERENCE_CLI=your-cli bun benchmarks/exec-headtohead/run.ts\n",
  );
  process.exit(1);
}

// Varied scenarios, escalating from a trivial baseline to multi-step,
// multi-tab, form interaction, and synthesis.
const TASKS = [
  {
    id: "baseline-title",
    scenario: "Trivial baseline",
    task: "Go to https://example.com and tell me the exact page title.",
  },
  {
    id: "hn-top",
    scenario: "Single extract (dynamic)",
    task: "Go to news.ycombinator.com and tell me the title and points of the current #1 story.",
  },
  {
    id: "wikipedia-fact",
    scenario: "Static lookup",
    task: "On Wikipedia, what is the height of the Eiffel Tower in metres (including antennas)?",
  },
  {
    id: "github-release",
    scenario: "Multi-step navigation",
    task: "Go to the GitHub repository microsoft/playwright and tell me the tag name of its latest release.",
  },
  {
    id: "compare-heights",
    scenario: "Multi-tab compare",
    task: "Which is taller: the Eiffel Tower or the Statue of Liberty (ground to torch)? Give both heights and the answer.",
  },
  {
    id: "hn-top3",
    scenario: "Read + synthesize",
    task: "Go to news.ycombinator.com and list the titles of the top 3 stories, in order.",
  },
  {
    id: "wiki-search",
    scenario: "Form / search interaction",
    task: "Use the search box on wikipedia.org to search for 'Playwright (software)', open the article, and give me the first sentence.",
  },
  {
    id: "compare-3way",
    scenario: "Multi-tab compare (3-way)",
    task: "Which of these is tallest: Burj Khalifa, Shanghai Tower, or Merdeka 118? Give all three heights in metres and name the tallest.",
  },
  {
    id: "table-extract",
    scenario: "Large-table extraction",
    task: "On the Wikipedia article 'List of tallest buildings', what is the 5th tallest building in the world and its height in metres?",
  },
  {
    id: "pagination",
    scenario: "Pagination",
    task: "Go to news.ycombinator.com, navigate to the second page of stories (the 'More' link), and tell me the title of the first story on that second page.",
  },
  {
    id: "cross-site-hop",
    scenario: "Deep multi-hop (cross-site)",
    task: "Find the current LTS version of Node.js from nodejs.org, then on the GitHub nodejs/node releases page find that version's release and tell me its release date.",
  },
  {
    id: "form-fill",
    scenario: "Form fill + submit",
    task: "Go to https://httpbin.org/forms/post, enter customer name 'Ada Lovelace', telephone '555-0100', pick pizza size Large, submit the form, and tell me what value the response JSON shows for 'custname'.",
  },
  {
    id: "saucedemo-checkout",
    scenario: "Complex: login + cart + checkout flow",
    task: "Go to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce' (public demo credentials). Add the two cheapest products to the cart, proceed to checkout with first name 'John', last name 'Doe', zip '12345', and tell me the item total (before tax) shown on the checkout overview page.",
  },
  {
    id: "hn-aggregate",
    scenario: "Complex: aggregate + compute over 10 items",
    task: "On news.ycombinator.com, take the top 10 stories: compute the SUM of their points, and tell me which single story has the highest points along with its percentage share of that sum (1 decimal place).",
  },
  {
    id: "wiki-population-gap",
    scenario: "Complex: table rows + arithmetic",
    task: "On the Wikipedia article 'List of countries and dependencies by population', identify the 3rd and 4th most populous countries and compute the difference between their populations (approximate, in millions).",
  },
];

// Fairness: BetterWright has no subagents, so the reference agent must not use
// its child-session/subagent machinery either. There is no CLI flag for this,
// so it is enforced at the prompt level.
const NO_SUBAGENTS =
  " Important: do everything yourself in this single session — do not spawn subagents, child sessions, or parallel agent sessions.";

// Strip ANSI SGR sequences (ESC [ … m). The ESC byte is built from its char
// code so there is no literal control character in the source.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function stripAnsi(s) {
  return s.replace(ANSI, "");
}

interface ProcessRun {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

function run(cmd, args, { cwd }: { cwd?: string } = {}): Promise<ProcessRun> {
  return new Promise<ProcessRun>((resolve) => {
    const start = Date.now();
    // stdin = ignore so children that read stdin get EOF instead of blocking on
    // an open, dataless pipe.
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - start, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), elapsedMs: Date.now() - start, timedOut });
    });
  });
}

function lastMeaningfulLine(text) {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
}

async function runBetterwright(task) {
  const r = await run(
    "node",
    ["dist/bin/betterwright.js", "exec", task, "--model", "codex", "--effort", EFFORT, "--max-steps", "16"],
    { cwd: REPO },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    // non-JSON (error) — leave null
  }
  return {
    elapsedMs: r.elapsedMs,
    timedOut: r.timedOut,
    ok: parsed?.ok ?? false,
    steps: parsed?.steps ?? null,
    toolCalls: parsed?.toolCalls ?? null,
    usage: parsed?.usage ?? null,
    answer: parsed?.answer ?? lastMeaningfulLine(r.stderr) ?? "",
    proof: parsed?.proof ?? null,
    raw: r.stdout.slice(0, 4000),
  };
}

async function runReference(task) {
  const r = await run(REFERENCE_CLI, ["exec", "-m", `openai-codex/${MODEL}`, "--effort", EFFORT, task + NO_SUBAGENTS]);
  // Count `repl(` invocations as a rough step proxy for the reference agent.
  const steps = (stripAnsi(r.stdout).match(/^\s*repl\(/gm) || []).length || null;
  return {
    elapsedMs: r.elapsedMs,
    timedOut: r.timedOut,
    ok: r.code === 0 && !r.timedOut,
    steps,
    answer: lastMeaningfulLine(r.stdout),
    raw: stripAnsi(r.stdout).slice(-4000),
  };
}

// results.json is a published artifact, so it carries outcomes and numbers
// only. Answers, transcripts (`raw`) and local artifact paths (`proof`) stay in
// memory for the live stderr log and go to disk only via `--raw`.
function publicTask(task, bw, reference) {
  const num = (v) => (isFiniteNumber(v) ? v : null);
  return {
    id: task.id,
    scenario: task.scenario,
    betterwright: {
      elapsed_ms: num(bw.elapsedMs),
      completed: bw.ok === true,
      timed_out: bw.timedOut === true,
      model_turns: num(bw.steps),
      tool_calls: num(bw.toolCalls),
      tokens: bw.usage
        ? {
            input: num(bw.usage.inputTokens),
            output: num(bw.usage.outputTokens),
            cache_read: num(bw.usage.cacheReadTokens),
            cache_write: num(bw.usage.cacheWriteTokens),
            context_end: num(bw.usage.context),
          }
        : null,
    },
    reference: {
      elapsed_ms: num(reference.elapsedMs),
      completed: reference.ok === true,
      timed_out: reference.timedOut === true,
      repl_blocks: num(reference.steps),
    },
  };
}

function elapsedStats(values) {
  const v = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return {
    count: v.length,
    median_ms: v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2),
    mean_ms: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
    min_ms: v[0],
    max_ms: v[v.length - 1],
  };
}

function buildResults(tasks) {
  const totalTokens = (key) => tasks.reduce((sum, t) => sum + (t.betterwright.tokens?.[key] ?? 0), 0);
  return {
    schema_version: "betterwright-exec-headtohead-public-results-v1",
    comparison: "betterwright exec vs an unnamed reference agent CLI",
    result_kind: "single recorded run of the 15-scenario battery",
    reproducible: false,
    scenarios_defined_in: "run.ts",
    agent: { model: MODEL, effort: EFFORT },
    measurement: {
      betterwright_elapsed_ms: "wall clock of one `betterwright exec` child process",
      reference_elapsed_ms: "wall clock of one reference-CLI child process",
      completed:
        "the harness returned an answer without erroring or timing out; NOT a correctness judgement",
      betterwright_model_turns: "true model-turn count reported by the agent",
      reference_repl_blocks:
        "count of `repl(` calls seen in stdout, a proxy for turns; null when not visible",
      timeout_ms: TIMEOUT_MS,
    },
    summary: {
      scenarios: tasks.length,
      betterwright: {
        completed: tasks.filter((t) => t.betterwright.completed).length,
        timed_out: tasks.filter((t) => t.betterwright.timed_out).length,
        elapsed: elapsedStats(tasks.map((t) => t.betterwright.elapsed_ms)),
      },
      reference: {
        completed: tasks.filter((t) => t.reference.completed).length,
        timed_out: tasks.filter((t) => t.reference.timed_out).length,
        elapsed: elapsedStats(tasks.map((t) => t.reference.elapsed_ms)),
      },
      betterwright_faster_on: tasks.filter(
        (t) =>
          t.betterwright.elapsed_ms !== null &&
          t.reference.elapsed_ms !== null &&
          t.betterwright.elapsed_ms < t.reference.elapsed_ms,
      ).length,
      betterwright_tokens_total: {
        input: totalTokens("input"),
        output: totalTokens("output"),
        cache_read: totalTokens("cache_read"),
        cache_write: totalTokens("cache_write"),
      },
    },
    tasks,
    privacy: {
      contains_agent_answers: false,
      contains_agent_transcripts: false,
      contains_screenshots: false,
      contains_local_paths: false,
    },
    notes: [
      "This is a development case study, not a benchmark: the reference agent is unnamed and is not vendored, so only the BetterWright column can be reproduced from this repository.",
      "`completed` records that a harness finished and returned something. Correctness was assessed by hand and is tabulated in REPORT.md, not here.",
      "One run per scenario per side. LLM latency variance is large on interactive scenarios; single-run timings are not significant on their own.",
      "Reference `repl_blocks` and BetterWright `model_turns` count different things and are not directly comparable.",
    ],
  };
}

async function main() {
  const selected = only ? TASKS.filter((t) => t.id.includes(only) || t.scenario.includes(only)) : TASKS;
  const tasks = [];
  const raw = [];
  for (const t of selected) {
    process.stderr.write(`\n### ${t.id} — ${t.scenario}\n`);
    process.stderr.write("  betterwright… ");
    const bw = await runBetterwright(t.task);
    process.stderr.write(`${(bw.elapsedMs / 1000).toFixed(1)}s ${bw.ok ? "ok" : "FAIL"} (${bw.steps} steps)\n`);
    process.stderr.write(`    answer: ${String(bw.answer).replace(/\s+/g, " ").slice(0, 160)}\n`);
    process.stderr.write("  reference…… ");
    const reference = await runReference(t.task);
    process.stderr.write(
      `${(reference.elapsedMs / 1000).toFixed(1)}s ${reference.ok ? "ok" : "FAIL"} (${reference.steps} steps)\n`,
    );
    process.stderr.write(`    answer: ${String(reference.answer).replace(/\s+/g, " ").slice(0, 160)}\n`);

    tasks.push(publicTask(t, bw, reference));
    raw.push({ ...t, betterwright: bw, reference });
    // Rewritten after every scenario so an interrupted run still leaves a
    // readable partial result.
    fs.writeFileSync(
      path.join(HERE, "results.json"),
      `${JSON.stringify(buildResults(tasks), null, 2)}\n`,
    );
    if (RAW_OUT) {
      fs.writeFileSync(path.resolve(RAW_OUT), `${JSON.stringify({ model: MODEL, effort: EFFORT, results: raw }, null, 2)}\n`);
    }
  }
  process.stderr.write("\nDone. results.json written.\n");
  if (RAW_OUT) {
    process.stderr.write(`Raw transcripts written to ${path.resolve(RAW_OUT)} — do not commit them.\n`);
  }
  process.stderr.write("Correctness is not machine-scored; score the answers above by hand.\n");
}

main();
