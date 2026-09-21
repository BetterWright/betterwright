#!/usr/bin/env bun

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cases as browserCases } from "./browser-cases.js";
import { cases as cliCases } from "./cli-cases.js";
import { type CaseResult, parseOptions, reportExitCode, runCase, selectCases } from "./harness.js";
import { cases as lifecycleCases } from "./lifecycle-cases.js";
import { cases as protocolCases } from "./protocol-cases.js";
import { cases as securityCases } from "./security-cases.js";
import type { E2ECase } from "./types.js";

const usage = `Usage: bun tests/e2e/run.ts [binary] [options]

Runs isolated black-box E2E checks against betterwright on PATH or a supplied executable.
No imports from the target's source or dist directory; no real profiles or credentials.

  --binary <path>       executable (default: betterwright)
  --binary-arg <arg>    prepend an argument; repeat for a Bun/Node launcher
  --group <name>        cli | browser | security | protocol | recording; repeatable
  --filter <text>       match a case ID or title (case-sensitive)
  --list                list selected cases without launching the binary
  --report <path>       JSON report (default: .tmp/e2e-report.json)
  --timeout <ms>        command deadline (default: 45000)
  --case-timeout <ms>   whole-case deadline (default: 180000)
  --require-all         fail if any selected case is skipped
  --keep-work           retain isolated homes and artifacts for diagnosis
  --help                show this help

Examples:
  bun tests/e2e/run.ts
  bun tests/e2e/run.ts /absolute/path/to/betterwright
  bun tests/e2e/run.ts --binary bun --binary-arg "$PWD/dist/bin/betterwright.js"

Install the target's managed browser beforehand. BETTERWRIGHT_CHROMIUM_PATH/ROOT
and BETTERWRIGHT_FFMPEG_PATH are honored. No installers or paid services run.
This suite covers local binary behavior, not every possible input or external integration.
`;

const untested = [
  "Real cloud-browser providers, paid API billing, provider credentials, and remote network policy boundaries.",
  "Real model quality, OAuth/MFA flows, external CAPTCHA services, and third-party website behavior.",
  "Local model downloads, GPU inference, installer/update downloads, and interactive onboarding.",
  "Electron host attachment, OS clipboard/keystroke injection, and native personal-browser cookie extraction.",
  "Every SDK/package-export contract and every OS/browser/version combination; retain the existing unit, type, and platform suites.",
];

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const selected = selectCases([...cliCases, ...browserCases, ...securityCases, ...protocolCases, ...lifecycleCases], options);
  if (options.list) {
    for (const entry of selected) console.log(`${entry.id}\t${entry.group}\t${entry.title}`);
    console.log(`${selected.length} cases`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bw-e2e-"));
  const results: CaseResult[] = [];
  const startedAt = new Date().toISOString();
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let targetVersion = "";
  const saveReport = (complete: boolean) => {
    const summary = {
      passed: results.filter((entry) => entry.status === "passed").length,
      failed: results.filter((entry) => entry.status === "failed").length,
      skipped: results.filter((entry) => entry.status === "skipped").length,
    };
    const report = {
      schemaVersion: 1,
      target: { binary: options.binary, version: targetVersion },
      platform: { os: process.platform, arch: process.arch },
      startedAt,
      updatedAt: new Date().toISOString(),
      complete,
      outcome: !complete ? "incomplete" : summary.failed ? "failed" : summary.skipped ? "partial" : "passed",
      interrupted: abort.signal.aborted,
      selectedCases: selected.length,
      requireAll: options.requireAll,
      summary,
      untested,
      results,
    };
    fs.mkdirSync(path.dirname(options.report), { recursive: true, mode: 0o700 });
    const temporary = `${options.report}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, options.report);
    return summary;
  };
  const execute = async (entry: E2ECase) => {
    const result = await runCase(entry, options, root, abort.signal);
    results.push(result);
    console.log(`${result.status.toUpperCase().padEnd(7)} ${entry.id} (${result.durationMs}ms)`);
    if (result.error || result.reason) console.log(`        ${result.error || result.reason}`);
    saveReport(false);
    return result.status === "passed";
  };
  try {
    console.log(`Testing ${options.binary}: ${selected.length} selected cases`);
    const targetReady = await execute({
      id: "preflight.binary",
      group: "cli",
      title: "Target binary starts and reports its version",
      async run(context) {
        const result = await context.command(["--version"]);
        assert.equal(result.code, 0, "Target --version must succeed");
        assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/);
        targetVersion = result.stdout.trim();
      },
    });
    let browserReady = false;
    if (targetReady && selected.some((entry) => entry.requiresBrowser) && !abort.signal.aborted) {
      browserReady = await execute({
        id: "preflight.browser",
        group: "browser",
        title: "Target launches its browser and executes a snippet",
        async run(context) {
          const result = await context.run("return 6 * 7;", { args: ["--no-daemon", "--close"] });
          assert.equal(result.ok, true, result.error || "Install the target's managed browser before running this suite");
          assert.equal(result.result, 42);
        },
      });
    }
    for (const entry of selected) {
      const reason = abort.signal.aborted ? "Run interrupted" : !targetReady
        ? "Target binary preflight failed" : entry.requiresBrowser && !browserReady
          ? "Browser preflight failed; see preflight.browser" : null;
      if (reason) {
        results.push({ id: entry.id, group: entry.group, title: entry.title, status: "skipped", reason, durationMs: 0 });
        console.log(`SKIPPED ${entry.id}: ${reason}`);
      } else {
        await execute(entry);
      }
    }
    const summary = saveReport(!abort.signal.aborted);
    console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
    console.log(`Report: ${options.report}`);
    console.log("Scope: deterministic local binary checks. Untested external/platform integrations are listed in the report.");
    if (options.keepWork || results.some((entry) => entry.workDir)) console.log(`Retained work: ${root}`);
    process.exitCode = abort.signal.aborted ? 130 : reportExitCode(results, options.requireAll);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (!options.keepWork && !results.some((entry) => entry.workDir)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
