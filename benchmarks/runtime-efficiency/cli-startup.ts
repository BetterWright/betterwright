import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const cli = process.argv[2] || "dist/bin/betterwright.js";
for (const runtime of ["node"]) {
	for (const args of [["--version"], ["--help"], ["run", "--help"]]) {
		const samples = [];
		for (let i = 0; i < 12; i++) {
			const t = performance.now();
			const r = spawnSync(runtime, [cli, ...args], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(r.stderr);
			if (i > 1) samples.push(performance.now() - t);
		}
		samples.sort((a, b) => a - b);
		console.log(
			JSON.stringify({
				runtime,
				args,
				p50: samples[4],
				p95: samples[9],
				samples,
			}),
		);
	}
}
