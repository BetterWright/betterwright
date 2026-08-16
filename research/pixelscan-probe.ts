#!/usr/bin/env node
// PixelScan evaluation of the managed BetterChromium fork.
//
// Launches the fork through the normal BetterWright stack and opens
// pixelscan.net, waits for the scan to compute, then dumps the full report
// text plus the raw consistency signals PixelScan cross-references, so the
// exact "inconsistent fingerprint" drivers are visible.
//
// Usage:
//   DISPLAY=:99 node research/pixelscan-probe.js            # headed on Xorg
//   node research/pixelscan-probe.js --headless             # headless

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BetterWright } from "../dist/src/index.js";

const args = process.argv.slice(2);
const HEADLESS = args.includes("--headless");
const NO_GPU = args.includes("--no-gpu");

if (!NO_GPU) {
  process.env.__EGL_VENDOR_LIBRARY_FILENAMES =
    "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";
  process.env.__GLX_VENDOR_LIBRARY_NAME = "nvidia";
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-pixelscan-"));
const browser = new BetterWright({
  home,
  headless: HEADLESS,
  launchIdentity: true,
  defaultTimeout: 90,
  chromiumArgs: NO_GPU
    ? []
    : [
        "--enable-gpu",
        "--use-gl=angle",
        "--use-angle=gl-egl",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
      ],
});

try {
  const result = await browser.run(
    `await page.goto("https://pixelscan.net/", {
       waitUntil: "domcontentloaded",
       timeout: 60000,
     });
     // PixelScan runs its checks automatically on load; give it time to finish.
     await page.waitForTimeout(20000);
     // Try to expand any "details"/"show more" controls so the full report text
     // is in the DOM, then let any revealed content settle.
     try {
       const buttons = await page.$$("button, a, [role=button]");
       for (const b of buttons) {
         const t = ((await b.innerText().catch(() => "")) || "").toLowerCase();
         if (/detail|more|expand|show|why|inconsist/.test(t)) {
           await b.click().catch(() => {});
         }
       }
     } catch {}
     await page.waitForTimeout(4000);
     await page.evaluate(() => window.scrollTo(0, 0));
     const shot = await screenshot({ kind: "debug", fullPage: true });
     return await page.evaluate((shotPath) => {
       const text = (el) => (el ? (el.innerText || "").trim() : "");
       const body = document.body ? document.body.innerText : "";
       // Collect likely verdict/flag elements by scanning for status keywords.
       const flagged = [];
       const kw = /inconsist|suspicious|fail|mask|mismatch|leak|bot|automat|headless|anomal|risk|warn/i;
       for (const el of document.querySelectorAll("*")) {
         if (el.children.length === 0) {
           const t = text(el);
           if (t && t.length < 200 && kw.test(t)) flagged.push(t);
         }
       }
       const lower = body.toLowerCase();
       const verdict = /\\b(inconsistent|consistent|suspicious|trustworthy|bot|human|masked|natural)\\b/.test(lower)
         ? (body.match(/[^\\n]*(inconsistent|consistent|suspicious|trustworthy|masked|natural)[^\\n]*/i) || [""])[0]
         : "";
       return {
         title: document.title,
         url: location.href,
         screenshotPath: shotPath,
         verdictLine: verdict.trim().slice(0, 300),
         // Raw signals PixelScan cross-references for consistency.
         signals: {
           userAgent: navigator.userAgent,
           platform: navigator.platform,
           uaDataPlatform: (navigator.userAgentData && navigator.userAgentData.platform) || null,
           uaDataMobile: (navigator.userAgentData && navigator.userAgentData.mobile) || null,
           uaDataBrands: (navigator.userAgentData && navigator.userAgentData.brands) || null,
           webdriver: navigator.webdriver,
           languages: navigator.languages,
           language: navigator.language,
           timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
           timezoneOffset: new Date().getTimezoneOffset(),
           hardwareConcurrency: navigator.hardwareConcurrency,
           deviceMemory: navigator.deviceMemory,
           screen: [screen.width, screen.height],
           avail: [screen.availWidth, screen.availHeight],
           outer: [window.outerWidth, window.outerHeight],
           inner: [window.innerWidth, window.innerHeight],
           devicePixelRatio: window.devicePixelRatio,
           colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
           touchPoints: navigator.maxTouchPoints,
           webglVendor: (() => {
             try {
               const gl = document.createElement("canvas").getContext("webgl");
               if (!gl) return "no-context";
               const ext = gl.getExtension("WEBGL_debug_renderer_info");
               return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
             } catch (e) { return "error:" + e.message; }
           })(),
           webglRenderer: (() => {
             try {
               const gl = document.createElement("canvas").getContext("webgl");
               if (!gl) return "no-context";
               const ext = gl.getExtension("WEBGL_debug_renderer_info");
               return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
             } catch (e) { return "error:" + e.message; }
           })(),
         },
         flagged: [...new Set(flagged)].slice(0, 60),
         fullBody: body,
       };
     }, shot.path);`,
    { timeout: 120 },
  );
  if (!result?.ok) {
    console.error("run failed:", JSON.stringify(result)?.slice(0, 800));
    process.exitCode = 1;
  } else {
    const { fullBody, ...rest } = result.result || {};
    console.log(JSON.stringify(rest, null, 2));
    console.log("=== full body ===");
    console.log(fullBody);
    if (result.result?.screenshotPath) {
      const target = "/tmp/bw-pixelscan/pixelscan.png";
      fs.mkdirSync("/tmp/bw-pixelscan", { recursive: true });
      fs.copyFileSync(result.result.screenshotPath, target);
      console.log("screenshot copied to:", target);
    }
  }
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
