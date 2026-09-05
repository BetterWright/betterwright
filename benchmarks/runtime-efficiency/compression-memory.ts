import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { compressSnapshot } = await import(
	pathToFileURL(path.resolve(process.argv[2])).href
);
const input = Array.from(
	{ length: 4000 },
	(_, i) => `- text: Paragraph ${i} ${"ordinary text ".repeat(5)}`,
).join("\n");
compressSnapshot('- button "Ready" [ref=e1]');
global.gc();
const before = process.memoryUsage();
const cpu = process.cpuUsage();
const start = performance.now();
let output;
for (let i = 0; i < 4; i++) output = compressSnapshot(input);
const elapsedMs = performance.now() - start;
const cpuUsed = process.cpuUsage(cpu);
const peakRssKiB = process.resourceUsage().maxRSS;
global.gc();
console.log(
	JSON.stringify({
		elapsedMs,
		cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
		peakRssKiB,
		before,
		after: process.memoryUsage(),
		outputBytes: Buffer.byteLength(output),
		hash: createHash("sha256").update(output).digest("hex"),
	}),
);
