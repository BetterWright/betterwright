import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertSameSource, dependencyIdentity, directoryIdentity, sha256, sourceIdentity } from "../navigation-context/provenance.js";
import { batchWorkloads, startBatchFixtures } from "./fixtures.js";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, candidate: { type: "string" }, output: { type: "string" },
} });
assert.ok(values.baseline && values.candidate && values.output, "Pass --baseline, --candidate, --output");
const executable = process.env.BETTERWRIGHT_CHROMIUM_PATH;
assert.ok(executable, "Set BETTERWRIGHT_CHROMIUM_PATH to a shared browser executable");
const roots = { baseline: path.resolve(values.baseline), candidate: path.resolve(values.candidate) };
const baseline = sourceIdentity(roots.baseline).head;
type Identity = ReturnType<typeof sourceIdentity> & { dependencies: Awaited<ReturnType<typeof dependencyIdentity>>; build: Awaited<ReturnType<typeof directoryIdentity>> };
const identities: Record<string, Identity> = {};
const browsers: Record<string, { run(code: string): Promise<any>; close(): Promise<void> }> = {};
const homes: string[] = [];
const samples = [];
const startedAt = new Date().toISOString();
const browserSha256 = sha256(await readFile(executable));
const harnessHash = async () => sha256(JSON.stringify(await Promise.all([
  new URL("run.ts", import.meta.url), new URL("fixtures.ts", import.meta.url),
  new URL("../navigation-context/provenance.ts", import.meta.url),
].map(async (url) => sha256(await readFile(url))))));
const harnessSha256 = await harnessHash();
const fixture = await startBatchFixtures();
try {
  for (const [variant, root] of Object.entries(roots)) {
    const source = sourceIdentity(root, baseline);
    const dependencies = await dependencyIdentity(path.join(root, "node_modules"));
    execFileSync(process.execPath, ["run", "build"], { cwd: root, stdio: "pipe" });
    assert.deepEqual(sourceIdentity(root, baseline), source);
    identities[variant] = { ...source, dependencies, build: await directoryIdentity(path.join(root, "dist")) };
    const { BetterWright } = await import(pathToFileURL(path.join(root, "dist/src/index.js")).href);
    const home = await mkdtemp(path.join(os.tmpdir(), "bw-ui-batch-"));
    homes.push(home);
    browsers[variant] = new BetterWright({ home, headless: true, vault: false });
    const warmup = await browsers[variant].run("return 'ready'");
    assert.equal(warmup.ok, true, warmup.error);
  }
  for (let repetition = -1; repetition < 10; repetition++) {
    const variants = repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const modes = repetition % 2 === 0 ? ["batch", "individual"] : ["individual", "batch"];
    for (const [workload, spec] of Object.entries(batchWorkloads)) for (const mode of modes) for (const variant of variants) {
      const browser = browsers[variant];
      let calls = 0;
      let outputChars = 0;
      const run = async (code) => {
        calls++;
        const result = await browser.run(code);
        assert.equal(result.ok, true, `${variant}/${mode}/${workload}: ${result.error}`);
        outputChars += JSON.stringify(result).length;
        return result.result;
      };
      const start = performance.now();
      const url = `${fixture.origin}/${workload}/${repetition}/${mode}`;
      await run(`await page.goto(${JSON.stringify(url)}); ${workload === "frame" ? "await page.frames()[1].getByLabel('Message').waitFor();" : ""} return controls.directory();`);
      let final;
      if (mode === "batch") {
        const result = await run(`return controls.batch(${JSON.stringify(spec.operations)}, {allowWrites:true, returnDirectory:true});`);
        final = result.results.verify.text;
      } else {
        for (const operation of spec.operations) {
          const target = operation.target;
          const root = "frameName" in target ? `page.frames().find(f => f.name() === ${JSON.stringify(target.frameName)})` : "page";
          const locator = "label" in target ? `${root}.getByLabel(${JSON.stringify(target.label)}, {exact:true})`
            : `${root}.getByRole(${JSON.stringify(target.role)}, ${JSON.stringify("name" in target ? { name: target.name, exact: true } : {})})`;
          const value = "value" in operation ? JSON.stringify(operation.value) : "";
          const code = operation.action === "read"
            ? `await ${locator}.filter({hasText:${value}}).waitFor(); return ${locator}.innerText();`
            : `await ${locator}.${operation.action === "select" ? "selectOption" : operation.action}(${value}); return 'done';`;
          final = await run(code);
        }
      }
      const elapsedMs = performance.now() - start;
      assert.equal(final, spec.expected);
      // Independent page-state check is excluded from measured time/call count.
      const observed = await browser.run(`return await ${workload === "frame" ? "page.frames()[1]" : "page"}.getByRole('status').innerText()`);
      assert.equal(observed.ok, true, observed.error);
      assert.equal(observed.result, spec.expected);
      if (repetition >= 0) samples.push({ variant, mode, workload, repetition, elapsedMs, calls, outputChars, correct: true });
    }
  }
} finally {
  for (const browser of Object.values(browsers)) await browser.close();
  await fixture.close();
  for (const home of homes) await rm(home, { recursive: true, force: true });
}
for (const [variant, root] of Object.entries(roots)) {
  const current = sourceIdentity(root, baseline);
  assert.equal(current.head, identities[variant].head);
  assertSameSource(identities[variant], current);
  assert.deepEqual(await directoryIdentity(path.join(root, "dist")), identities[variant].build);
  assert.deepEqual(await dependencyIdentity(path.join(root, "node_modules")), identities[variant].dependencies);
}
assert.equal(await harnessHash(), harnessSha256);
assert.equal(sha256(await readFile(executable)), browserSha256);
const median = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const summary = Object.fromEntries(Object.keys(batchWorkloads).map((workload) => [workload,
  Object.fromEntries(["baseline", "candidate"].map((variant) => [variant,
    Object.fromEntries(["batch", "individual"].map((mode) => {
      const rows = samples.filter((row) => row.workload === workload && row.variant === variant && row.mode === mode);
      return [mode, { medianMs: median(rows.map((r) => r.elapsedMs)), calls: rows[0].calls, medianOutputChars: median(rows.map((r) => r.outputChars)), passed: rows.length }];
    })),
  ])),
]));
await writeFile(values.output, `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
  config: { repetitions: 10, warmups: 1, alternatingOrder: true, modelRequests: 0, backgroundDelayMs: 800 },
  host: { platform: process.platform, arch: process.arch, bun: process.versions.bun },
  identities, browserSha256, harnessSha256, summary, samples,
}, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
