import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { E2ECase } from "./types.js";

function isText(value: any): value is string {
  return typeof value === "string";
}

export const cases: E2ECase[] = [
  {
    id: "browser.stealth-runtime", group: "browser", title: "The optional stealth driver isolates main-world globals while preserving DOM actions", requiresBrowser: true,
    async run(ctx) {
      const doctor = await ctx.json(["doctor", "--json"]);
      if (!doctor.stealth_available) ctx.skip("The target does not have its optional stealth driver installed");
      const server = await ctx.serve((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><title>Stealth fixture</title><label>Name<input></label><script>window.e2eMainWorld="page-only";</script>');
      });
      const output = await ctx.run(`
        await page.goto(${JSON.stringify(server.origin)});
        await page.getByLabel('Name').fill('isolated');
        return {title:await page.title(),value:await page.getByLabel('Name').inputValue(),
          mainWorld:await page.evaluate(() => typeof window.e2eMainWorld),node:typeof process};
      `, { args: ["--stealth"] });
      assert.equal(output.ok, true, output.error);
      assert.deepEqual(output.result, { title: "Stealth fixture", value: "isolated", mainWorld: "undefined", node: "undefined" });
      assert.match(output.warnings.join(" "), /isolated world/);
    },
  },
  {
    id: "browser.provider-fallback", group: "browser", title: "An unavailable local CDP endpoint falls back to the managed browser with diagnostics", requiresBrowser: true,
    async run(ctx) {
      let attempts = 0;
      const unavailable = await ctx.serve((_request, response) => {
        attempts++;
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("Synthetic CDP outage");
      });
      const configured = await ctx.command(["configure", "--browser", unavailable.origin.replace("http:", "ws:"), "--browser-fallback", "managed", "--no-test"]);
      assert.equal(configured.code, 0, configured.stderr);
      assert.equal(attempts, 0);
      const output = await ctx.run("await page.setContent('<title>Fallback succeeded</title>'); return page.title();");
      assert.equal(output.ok, true, output.error);
      assert.equal(output.result, "Fallback succeeded");
      assert.ok(attempts > 0, "The primary provider must actually be attempted");
      assert.match(output.warnings.join(" "), /failed|fallback/i);
    },
  },
  {
    id: "browser.result-serialization", group: "browser", title: "Empty values, big integers, cycles, and collection caps serialize safely", requiresBrowser: true,
    async run(ctx) {
      const output = await ctx.run(`
        const circular = {label:'cycle'}; circular.self = circular;
        return {empty:[undefined,null,false,0,''],big:123456789012345678901234567890n,
          circular,items:Array.from({length:250},(_,index)=>index),locator:page.locator('body')};
      `);
      assert.equal(output.ok, true, output.error);
      assert.deepEqual(output.result.empty, [null, null, false, 0, ""]);
      assert.equal(output.result.big, "123456789012345678901234567890");
      assert.deepEqual(output.result.circular, { label: "cycle", self: "[Circular]" });
      assert.equal(output.result.items.length, 200);
      assert.equal(output.result.items[199], 199);
      assert.equal(output.result.locator.type, "Locator");
      assert.equal(JSON.stringify(output).includes("_connection"), false);
    },
  },
  {
    id: "browser.result-spill", group: "browser", title: "Oversized results spill to a bounded preview and an explicitly untrusted artifact", requiresBrowser: true,
    async run(ctx) {
      const output = await ctx.run("return 'E2E-BEGIN-'+'x'.repeat(16000)+'-E2E-END';");
      assert.equal(output.ok, true, output.error);
      assert.equal(output.result.truncated, true);
      assert.match(output.result.preview, /^E2E-BEGIN-/);
      assert.match(output.result.preview, /-E2E-END$/);
      assert.ok(output.result.preview.length < 16_000);
      const relative = path.relative(ctx.home, output.result.fullOutputPath);
      assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
      const content = await readFile(output.result.fullOutputPath, "utf8");
      assert.match(content, /<untrusted_tool_result/);
      assert.match(content, /UNTRUSTED EXTERNAL DATA/);
      assert.ok(content.includes(`E2E-BEGIN-${"x".repeat(16_000)}-E2E-END`));
      assert.match(content, /<\/untrusted_tool_result>$/);
    },
  },
  {
    id: "browser.sync-timeout", group: "browser", title: "An infinite synchronous snippet is bounded and the next command recovers", requiresBrowser: true,
    async run(ctx) {
      const output = await ctx.run("while(true) {}", { timeoutMs: 15_000 });
      assert.equal(output.ok, false);
      assert.match(output.error, /timed out|timeout/i);
      const recovered = await ctx.run("return 42;");
      assert.equal(recovered.ok, true, recovered.error);
      assert.equal(recovered.result, 42);
    },
  },
  {
    id: "browser.async-timeout-restart", group: "browser", title: "An unresolved async snippet restarts its worker without losing persistent cookies", requiresBrowser: true,
    async run(ctx) {
      const server = await ctx.serve((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><title>Restart fixture</title><link rel="icon" href="data:"><h1>Restart fixture</h1>');
      });
      const seeded = await ctx.run(`
        await page.goto(${JSON.stringify(server.origin)});
        await page.evaluate(() => {document.cookie='e2e_restart=preserved; Max-Age=3600; Path=/';});
        state.marker = 'old-worker'; return page.evaluate(() => document.cookie);
      `);
      assert.equal(seeded.ok, true, seeded.error);
      assert.match(seeded.result, /e2e_restart=preserved/);
      const failed = await ctx.run("await new Promise(() => {});", { timeoutMs: 45_000 });
      assert.equal(failed.ok, false);
      assert.match(failed.error, /timed out/i);
      const recovered = await ctx.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return {cookie:await page.evaluate(() => document.cookie),marker:state.marker ?? null,title:await page.title()};
      `);
      assert.equal(recovered.ok, true, recovered.error);
      assert.equal(recovered.result.marker, null);
      assert.equal(recovered.result.title, "Restart fixture");
      assert.match(recovered.result.cookie, /e2e_restart=preserved/);
    },
  },
  {
    id: "protocol.live-view-watch-only", group: "protocol", title: "Live view requires its token, streams frames, rejects watch-only navigation, and detaches safely", requiresBrowser: true,
    async run(ctx) {
      const initial = await ctx.run("await page.setContent('<title>Live E2E</title><h1>Live E2E</h1>'); state.marker='still here'; return page.title();", { session: "viewer" });
      assert.equal(initial.ok, true, initial.error);
      const child = ctx.start(["view", "--expose", "local", "--watch-only", "--session", "viewer", "--no-ad-block"]);
      let output = "";
      const address = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live view did not announce its address")), 20_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", () => { clearTimeout(timer); reject(new Error("Live view exited before announcing its address")); });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const matched = /Live view:\s+(http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+)/.exec(output);
          if (matched) { clearTimeout(timer); resolve(matched[1]); }
        });
      });
      ctx.redact(address);
      const url = new URL(address);
      ctx.redact(url.searchParams.get("t"));
      assert.equal((await fetch(url.origin, { signal: AbortSignal.timeout(5_000) })).status, 404);
      assert.equal((await fetch(`${url.origin}/?t=incorrect`, { signal: AbortSignal.timeout(5_000) })).status, 404);
      const page = await fetch(address, { signal: AbortSignal.timeout(5_000) });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("x-frame-options"), "DENY");
      assert.equal(page.headers.get("referrer-policy"), "no-referrer");
      assert.match(await page.text(), /canvas/);
      url.protocol = "ws:";
      url.pathname = "/ws";
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      ctx.cleanup(() => { socket.close(); });
      const messages: any[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live view did not produce a frame and a watch-only rejection")), 15_000);
        let frame = false;
        let rejected = false;
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Live-view WebSocket failed")); });
        socket.addEventListener("message", (event) => {
          try {
            if (isText(event.data)) {
              const message = JSON.parse(event.data);
              messages.push(message);
              if (message.t === "hello") {
                assert.equal(message.interactive, false);
                socket.send(JSON.stringify({ t: "navigate", url: "about:blank" }));
              }
              if (message.t === "toast" && /watch-only/.test(message.text)) rejected = true;
            } else if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) frame = true;
            if (frame && rejected) { clearTimeout(timer); resolve(); }
          } catch (error) { clearTimeout(timer); reject(error); }
        });
      });
      assert.ok(messages.some((message) => message.t === "hello"));
      socket.close();
      const closed = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Live view did not detach after SIGINT")), 10_000);
        child.once("close", (code) => { clearTimeout(timer); resolve(code); });
      });
      child.kill("SIGINT");
      assert.equal(await closed, 0);
      const preserved = await ctx.run("return {title:await page.title(),marker:state.marker};", { session: "viewer" });
      assert.equal(preserved.ok, true, preserved.error);
      assert.deepEqual(preserved.result, { title: "Live E2E", marker: "still here" });
    },
  },
];
