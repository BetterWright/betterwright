import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { UntrustedValue } from "../../src/untrusted-value.js";
import { startFixtures, workloads } from "./fixtures.js";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, candidate: { type: "string" }, output: { type: "string" },
} });
assert.ok(values.baseline && values.candidate && values.output, "Pass --baseline, --candidate (built packages), and --output");
assert.ok(process.env.BETTERWRIGHT_CHROMIUM_PATH, "Set BETTERWRIGHT_CHROMIUM_PATH to the shared browser executable");
const roots = { baseline: path.resolve(values.baseline), candidate: path.resolve(values.candidate) };
const fixture = await startFixtures();
const browsers: Record<string, { run(code: string): Promise<any>; close(): Promise<void> }> = {};
const homes: string[] = [];
const samples = [];
const repetitions = 10;
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const promptHashes: Record<string, string> = {};
const identities = {};
const startedAt = new Date().toISOString();

try {
  for (const [variant, root] of Object.entries(roots)) {
    promptHashes[variant] = sha256(await readFile(path.join(root, "SKILL.md")));
    identities[variant] = {
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      diffSha256: sha256(execFileSync("git", ["diff", "--", "src", "bin", "types"], { cwd: root })),
      workerSha256: sha256(await readFile(path.join(root, "dist/src/worker.js"))),
    };
    const { BetterWright } = await import(pathToFileURL(path.join(root, "dist/src/index.js")).href);
    const home = await mkdtemp(path.join(os.tmpdir(), "bw-navigation-context-"));
    homes.push(home);
    browsers[variant] = new BetterWright({ home, headless: true, vault: false });
    const warmup = await browsers[variant].run("return 'ready'");
    assert.equal(warmup.ok, true, warmup.error);
  }
  assert.equal(promptHashes.baseline, promptHashes.candidate, "Native skill must be unchanged");
  for (let repetition = -1; repetition < repetitions; repetition++) {
    // Alternate which build runs first. The first pair is an unrecorded warmup.
    const order = repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const [workload, spec] of Object.entries(workloads)) {
      const results: Record<string, UntrustedValue> = {};
      for (const variant of order) {
        const route = "route" in spec ? spec.route : workload;
        // Unique pathnames re-arm automatic discovery equally for every sample.
        const url = `${fixture.origin}/${route}/${workload}/${repetition}`;
        const start = performance.now();
        const result = await browsers[variant].run(`await page.goto(${JSON.stringify(url)}); ${spec.code}`);
        const elapsedMs = performance.now() - start;
        assert.equal(result.ok, true, `${variant}/${workload}: ${result.error}`);
        if (spec.expected !== null) assert.deepEqual(result.result, spec.expected, workload);
        results[variant] = result.result;
        // cmdRun's actual pipe serialization: pretty on the baseline, compact
        // on the candidate. The CLI integration test verifies these formats.
        const pipe = JSON.stringify(result, null, variant === "baseline" ? 2 : undefined);
        if (repetition >= 0) samples.push({
          variant, workload, repetition, elapsedMs,
          compactEnvelopeChars: JSON.stringify(result).length,
          pipedEnvelopeChars: pipe.length,
          automaticUIChars: result.ui ? JSON.stringify(result.ui).length : 0,
          result: result.result,
        });
      }
      assert.deepEqual(results.candidate, results.baseline, `${workload} result parity`);
    }
  }
} finally {
  for (const browser of Object.values(browsers)) await browser.close();
  await fixture.close();
  for (const home of homes) await rm(home, { recursive: true, force: true });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const summary = Object.fromEntries(Object.keys(workloads).map((workload) => [workload,
  Object.fromEntries(Object.keys(roots).map((variant) => {
    const selected = samples.filter((sample) => sample.workload === workload && sample.variant === variant);
    return [variant, {
      medianMs: median(selected.map((sample) => sample.elapsedMs)),
      medianPipedChars: median(selected.map((sample) => sample.pipedEnvelopeChars)),
      medianCompactChars: median(selected.map((sample) => sample.compactEnvelopeChars)),
      resultParity: true,
    }];
  })),
]));
await writeFile(values.output, `${JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, bun: process.versions.bun },
  browserSha256: sha256(await readFile(process.env.BETTERWRIGHT_CHROMIUM_PATH)),
  fixtureSha256: sha256(await readFile(new URL("fixtures.ts", import.meta.url))),
  config: { repetitions, warmupPairs: 1, defaultOptions: true, pipedSerializationSimulated: true, deferredResourceMs: 800, promptsUnchanged: true },
  identities, promptHashes, summary, samples,
}, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
