#!/usr/bin/env bun
// Headless-tell diagnostic: dump the exact browser signals CreepJS's
// headless-likeness heuristic reads, so we can see which ones are flagging.
//
//   xvfb-run -a bun research/headless-tells.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BetterWright } from "../dist/src/index.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-tells-"));
const browser = new BetterWright({ home, headless: false, defaultTimeout: 60 });

const TELLS = `
const out = {};
const nav = navigator;
out["navigator.webdriver"] = nav.webdriver;
out["window.chrome present"] = !!window.chrome;
out["window.chrome.csi"] = !!(window.chrome && window.chrome.csi);
out["window.chrome.loadTimes"] = !!(window.chrome && window.chrome.loadTimes);
out["navigator.plugins.length"] = nav.plugins.length;
out["navigator.plugins names"] = [...nav.plugins].map((p) => p.name);
out["navigator.languages"] = nav.languages;
out["navigator.hardwareConcurrency"] = nav.hardwareConcurrency;
out["navigator.deviceMemory"] = nav.deviceMemory;
out["navigator.platform"] = nav.platform;
out["navigator.vendor"] = nav.vendor;
out["navigator.maxTouchPoints"] = nav.maxTouchPoints;
out["navigator.pdfViewerEnabled"] = nav.pdfViewerEnabled;
out["window.outerWidth/innerWidth"] = window.outerWidth + "/" + window.innerWidth;
out["window.outerHeight/innerHeight"] = window.outerHeight + "/" + window.innerHeight;
out["screen.colorDepth"] = screen.colorDepth;
out["Notification.permission"] = (typeof Notification !== "undefined") ? Notification.permission : "n/a";
// WebGL renderer / vendor — the biggest headless tell of all.
try {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    out["webgl UNMASKED_RENDERER"] = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "no dbg ext";
    out["webgl UNMASKED_VENDOR"] = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "no dbg ext";
    out["webgl RENDERER"] = gl.getParameter(gl.RENDERER);
    out["webgl VENDOR"] = gl.getParameter(gl.VENDOR);
  } else {
    out["webgl"] = "context null";
  }
} catch (error) {
  out["webgl"] = "error: " + error.message;
}
// Headless-only tells CreepJS probes.
out["navigator.connection.rtt"] = nav.connection ? nav.connection.rtt : "n/a";
out["chrome.runtime"] = !!(window.chrome && window.chrome.runtime);
out["Function.prototype.toString proxy leak"] = /\\{\\s*\\[native code\\]\\s*\\}/.test(Function.prototype.toString.toString());
// Permissions API quirk: headless used to resolve notifications as denied-instantly.
try {
  const perm = await navigator.permissions.query({ name: "notifications" });
  out["permissions.notifications.state"] = perm.state;
} catch (error) {
  out["permissions.notifications"] = "error: " + error.message;
}
// Plugins/mimetypes headless absence.
out["navigator.mimeTypes.length"] = nav.mimeTypes.length;
// UA-CH.
try {
  const uaData = await nav.userAgentData.getHighEntropyValues(["platform", "platformVersion", "model", "uaFullVersion"]);
  out["userAgentData"] = JSON.stringify(uaData);
} catch (error) {
  out["userAgentData"] = "error: " + error.message;
}
return out;
`;

try {
  const result = await browser.run(
    `await page.goto("https://bot.sannysoft.com/", { waitUntil: "load", timeout: 30000 }).catch(() => {});
     return await page.evaluate(async () => { ${TELLS} });`,
    { timeout: 90 },
  );
  if (!result?.ok) {
    console.error("run failed:", JSON.stringify(result)?.slice(0, 600));
    process.exitCode = 1;
  } else {
    for (const [key, value] of Object.entries(result.result)) {
      console.log(`${key.padEnd(42)} ${JSON.stringify(value)}`);
    }
  }
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
