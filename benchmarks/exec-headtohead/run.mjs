#!/usr/bin/env node
// Head-to-head: BetterWright's built-in agent harness (`betterwright exec`) vs
// a reference browser agent's own CLI, both plugged into the SAME model
// (codex / gpt-5.6-sol) at the SAME reasoning effort (low). Matching the model
// isolates the AGENT SCAFFOLD — the observe/act/verify loop — which is the thing
// this benchmark measures. The browser runtime itself was already at parity in
// benchmarks/browser-agent-headtohead.
//
//   node benchmarks/exec-headtohead/run.mjs [--only <substr>] [--timeout <ms>]
//
// Writes results.json next to this file; REPORT.md is authored from it.
//
// The comparison CLI is named by REFERENCE_CLI (default "reference-agent"); it
// is expected to take `<cli> exec -m <provider/model> --effort <e> "<task>"`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MODEL = "gpt-5.6-sol";
const EFFORT = "low";
const REFERENCE_CLI = process.env.REFERENCE_CLI || "reference-agent";

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex !== -1 ? argv[onlyIndex + 1] : null;
const timeoutIndex = argv.indexOf("--timeout");
const TIMEOUT_MS = timeoutIndex !== -1 ? Number(argv[timeoutIndex + 1]) : 150_000;

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

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
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
    ["bin/betterwright.mjs", "exec", task, "--model", "codex", "--effort", EFFORT, "--max-steps", "16"],
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

async function main() {
  const tasks = only ? TASKS.filter((t) => t.id.includes(only) || t.scenario.includes(only)) : TASKS;
  const results = [];
  for (const t of tasks) {
    process.stderr.write(`\n### ${t.id} — ${t.scenario}\n`);
    process.stderr.write("  betterwright… ");
    const bw = await runBetterwright(t.task);
    process.stderr.write(`${(bw.elapsedMs / 1000).toFixed(1)}s ${bw.ok ? "ok" : "FAIL"} (${bw.steps} steps)\n`);
    process.stderr.write("  reference…… ");
    const reference = await runReference(t.task);
    process.stderr.write(
      `${(reference.elapsedMs / 1000).toFixed(1)}s ${reference.ok ? "ok" : "FAIL"} (${reference.steps} steps)\n`,
    );
    results.push({ ...t, betterwright: bw, reference });
    fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ model: MODEL, effort: EFFORT, results }, null, 2));
  }
  process.stderr.write("\nDone. results.json written.\n");
}

main();
