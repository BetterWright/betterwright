#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compressSnapshot } from "../../dist/src/snapshot.js";
import { isCallable } from "../../dist/src/untrusted-value.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const baselinePath = flag("--baseline");
if (!baselinePath) {
  throw new Error("Pass --baseline /path/to/baseline/dist/src/snapshot.js. Optional --output file and --verify-only.");
}
const baselineFile = path.resolve(baselinePath);
const { compressSnapshot: baseline } = await import(pathToFileURL(baselineFile).href);
assert.ok(isCallable(baseline), "baseline must export compressSnapshot");
const candidateFile = fileURLToPath(new URL("../../dist/src/snapshot.js", import.meta.url));
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let verified = 0;
function compare(tree: string, urls = false) {
  const expected = baseline(tree, { urls });
  const actual = compressSnapshot(tree, { urls });
  assert.equal(actual, expected, `snapshot equivalence case ${verified}, urls=${urls}, input=${JSON.stringify(tree)}`);
  verified += 1;
}

const values = ["", '""', " ", '" "', "x", '"\\u0061"', '"a: b"', '"unterminated', '"line\\nend"', "☃"];
function enumerate(prefix: string[], remaining: number) {
  if (prefix.length) {
    compare(prefix.map((value) => `- text: ${value}`).join("\n"));
    compare([
      '- article "Notes" [ref=e1]:',
      ...prefix.map((value) => `  - paragraph: ${value}`),
      '  - button "Save" [ref=e2]',
      ...prefix.map((value) => `  - text: ${value}`),
    ].join("\n"));
  }
  if (remaining) {
    for (const value of values) enumerate([...prefix, value], remaining - 1);
  }
}
enumerate([], 4);

let seed = 0x51a7c0de;
function random(maximum: number) {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return seed % maximum;
}
for (let sample = 0; sample < 500; sample += 1) {
  const lines = ['- main [ref=e1]:'];
  for (let index = 0, length = 1 + random(50); index < length; index += 1) {
    const value = values[random(values.length)];
    switch (random(5)) {
      case 0:
        lines.push(`  - text: ${value}`, "    opaque child");
        break;
      case 1:
        lines.push(`  - paragraph: ${value}`);
        break;
      case 2:
        lines.push("  - generic:", `    - text: ${value}`, `    - text: ${values[random(values.length)]}`);
        break;
      case 3:
        lines.push(`  - link "Docs ${index}" [ref=e${index + 2}]:`, '    - /url: "https://example.test/docs"');
        break;
      default:
        lines.push(`  - text: ${value}`);
    }
  }
  compare(lines.join("\n"));
  compare(lines.join("\n"), true);
}

const paragraph = "long paragraph ".repeat(5);
const fixtures = [40, 1_000, 2_000, 4_000].map((count) => ({
  name: `paragraphs-${count}`,
  input: Array.from({ length: count }, () => `- text: ${paragraph}`).join("\n"),
}));
fixtures.push({
  name: "interactive-100",
  input: Array.from({ length: 100 }, (_, index) => `- button "Action ${index}" [ref=e${index + 1}]`).join("\n"),
});
for (const fixture of fixtures) compare(fixture.input);

const samples = [];
if (!args.includes("--verify-only")) {
  for (const fixture of fixtures) {
    for (let warmup = 0; warmup < 2; warmup += 1) {
      baseline(fixture.input);
      compressSnapshot(fixture.input);
    }
    const before: number[] = [];
    const after: number[] = [];
    const measure = (compress, target: number[]) => {
      const start = performance.now();
      const output = compress(fixture.input);
      target.push(performance.now() - start);
      return output;
    };
    for (let sample = 0; sample < 7; sample += 1) {
      const actual = sample % 2
        ? [measure(compressSnapshot, after), measure(baseline, before)]
        : [measure(baseline, before), measure(compressSnapshot, after)];
      assert.equal(actual[0], actual[1], `timed output equality for ${fixture.name}`);
    }
    const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    samples.push({
      name: fixture.name,
      inputChars: fixture.input.length,
      outputChars: compressSnapshot(fixture.input).length,
      baselineMs: before,
      candidateMs: after,
      baselineMedianMs: median(before),
      candidateMedianMs: median(after),
      speedup: median(before) / median(after),
    });
  }
}
const result = {
  schema: "betterwright-snapshot-compression-v1",
  recordedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()[0]?.model,
  baseline: { file: baselineFile, sha256: hash(baselineFile) },
  candidate: { file: candidateFile, sha256: hash(candidateFile) },
  verifiedCases: verified,
  samples,
};
const output = `${JSON.stringify(result, null, 2)}\n`;
const destination = flag("--output");
if (destination) fs.writeFileSync(path.resolve(destination), output);
process.stdout.write(output);
