import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = path.resolve(process.argv[2] || "dist/src/index.js");
const mode = process.argv[3] || "actions";
const { BetterWright, NetworkPolicy } = await import(
	pathToFileURL(target).href
);
const ticks = Number(
	execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
);
function sample() {
	const all = [];
	for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
		try {
			const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const s = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
			all.push({
				pid: Number(pid),
				ppid: Number(s[1]),
				cpuMs: ((Number(s[11]) + Number(s[12])) * 1000) / ticks,
				threads: Number(s[17]),
				name: raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")),
			});
		} catch {}
	}
	const ids = new Set([process.pid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const p of all)
			if (ids.has(p.ppid) && !ids.has(p.pid)) {
				ids.add(p.pid);
				changed = true;
			}
	}
	const processes = all
		.filter((p) => ids.has(p.pid))
		.map((p) => {
			try {
				const text = fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8");
				return {
					...p,
					pssKiB: Number(text.match(/^Pss:\s+(\d+)/m)[1]),
					rssKiB: Number(text.match(/^Rss:\s+(\d+)/m)[1]),
				};
			} catch {
				return { ...p, pssKiB: 0, rssKiB: 0 };
			}
		});
	return {
		at: performance.now(),
		cpuMs: processes.reduce((n, p) => n + p.cpuMs, 0),
		pssMiB: processes.reduce((n, p) => n + p.pssKiB, 0) / 1024,
		rssMiB: processes.reduce((n, p) => n + p.rssKiB, 0) / 1024,
		processes,
	};
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-efficiency-"));
const server = http.createServer((req, res) => {
	if (req.url !== "/") {
		res.writeHead(404).end();
		return;
	}
	res.setHeader("content-type", "text/html");
	res.end(
		'<title>Efficiency fixture</title><button>Ready</button><canvas width="640" height="360"></canvas>',
	);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
// SAFETY: listen uses a TCP port, so the bound address is AddressInfo.
const address = server.address() as AddressInfo;
const bw = new BetterWright({
	home,
	headless: true,
	vault: false,
	parkBackgroundPages: true,
	policy: new NetworkPolicy({ allowLoopback: true }),
});
const run = async (code) => {
	const r = await bw.run(code);
	assert.equal(r.ok, true, r.error);
	return r;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phases = [];
try {
	await run(
		`await page.goto('http://127.0.0.1:${address.port}/');return page.title()`,
	);
	if (mode === "actions") {
		for (let i = 0; i < 30; i++) await run("return 1");
		const before = sample();
		const start = performance.now();
		for (let i = 0; i < 1000; i++) await run("return 1");
		const elapsedMs = performance.now() - start;
		const after = sample();
		phases.push({
			name: "1000-actions",
			elapsedMs,
			cpuMs: after.cpuMs - before.cpuMs,
			before,
			after,
		});
	} else {
		await run(
			`await page.evaluate(()=>{const c=document.querySelector('canvas').getContext('2d');let n=0;function f(){c.fillStyle='white';c.fillRect(0,0,640,360);c.fillStyle='blue';c.fillRect(n++%600,30,40,100);requestAnimationFrame(f)}f()})`,
		);
		await sleep(1500);
		for (let cycle = 0; cycle < 3; cycle++) {
			const idle = sample();
			await sleep(2000);
			const idleEnd = sample();
			phases.push({
				name: "parked",
				cycle,
				cpuMs: idleEnd.cpuMs - idle.cpuMs,
				elapsedMs: idleEnd.at - idle.at,
				before: idle,
				after: idleEnd,
			});
			const started = await run(
				mode === "recording-hd"
					? "return recording.start()"
					: "return recording.start({maxWidth:640,maxHeight:360})",
			);
			const before = sample();
			await sleep(5000);
			const after = sample();
			const bytesBeforeStop = fs.statSync(started.result.path).size;
			const stopped = await run("return recording.stop()");
			phases.push({
				name: "recording",
				cycle,
				cpuMs: after.cpuMs - before.cpuMs,
				elapsedMs: after.at - before.at,
				before,
				after,
				status: stopped.result,
				bytesBeforeStop,
			});
			await sleep(1500);
		}
		phases.push({ name: "after-stop", after: sample() });
	}
	console.log(
		JSON.stringify({ target, mode, node: process.version, phases }, null, 2),
	);
} finally {
	await bw.close();
	await new Promise((r) => server.close(r));
	fs.rmSync(home, { recursive: true, force: true });
}
