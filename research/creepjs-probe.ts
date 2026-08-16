#!/usr/bin/env node
// CreepJS evaluation of the managed BetterChromium fork.
//
// Launches the fork through the normal BetterWright stack (guard proxy,
// launch identity, no OS masquerade) and opens abrahamjuliot.github.io/creepjs,
// then scrapes the trust score, "lies" totals, and section text, and saves a
// screenshot of the verdict area.
//
// Usage:
//   xvfb-run -a node research/creepjs-probe.js            # headed under Xvfb
//   node research/creepjs-probe.js --headless             # headless

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BetterWright } from "../dist/src/index.js";

const args = process.argv.slice(2);
const HEADLESS = args.includes("--headless");
// --no-gpu simulates a GPU-less host: no NVIDIA EGL/GLX forcing and no GPU
// launch flags, so Chromium falls back to its software rasterizer. Default
// (omitted) targets a host with a real GPU.
const NO_GPU = args.includes("--no-gpu");
// --software forces the software rasterizer even on a GPU host, to exercise
// the fork's GPU-less spoof path under a display that does have a GPU.
const FORCE_SOFTWARE = args.includes("--software");

// Force the NVIDIA EGL/GLX vendor so Chromium's GL context binds to the RTX
// 4090 instead of Mesa's llvmpipe software rasterizer under the X display.
if (!NO_GPU) {
  process.env.__EGL_VENDOR_LIBRARY_FILENAMES =
    "/usr/share/glvnd/egl_vendor.d/10_nvidia.json";
  process.env.__GLX_VENDOR_LIBRARY_NAME = "nvidia";
}

function flagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-creepjs-"));
const browser = new BetterWright({
  home,
  headless: HEADLESS,
  launchIdentity: true,
  defaultTimeout: 90,
  // On a GPU host, bind the real GPU via EGL. On a GPU-less host (--no-gpu)
  // pass nothing and let the fork's software-renderer path run.
  chromiumArgs: FORCE_SOFTWARE
    ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : NO_GPU
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
    `await page.goto("https://abrahamjuliot.github.io/creepjs/", {
       waitUntil: "domcontentloaded",
       timeout: 60000,
     });
     // Give CreepJS's staged computation time to fill in; the page sometimes
     // never finishes on a blocked network, so don't gate on its verdict.
     await page.waitForTimeout(60000);
     await page.evaluate(() => window.scrollTo(0, 0));
     const shot = await screenshot({ kind: "debug", fullPage: true });
     return await page.evaluate((shotPath) => {
       const body = document.body ? document.body.innerText : "";
       // Pull the headless/automation section's individual check rows. CreepJS
       // renders each detector as a labelled row; the "like headless" figure is
       // a weighted blend of these, so we need the per-check truth values.
       const headlessSection = [...document.querySelectorAll("*")]
         .filter((el) => {
           const cls = String(el.className || "");
           return (cls.includes("headless") || cls.includes("stealth") || cls.includes("automation")) && el.children.length;
         })
         .map((el) => (el.innerText || "").trim())
         .filter(Boolean)
         .slice(0, 10);
       // Automation tells CreepJS looks for across the whole document.
       const lower = body.toLowerCase();
       const tells = {};
       for (const probe of ["webdriver", "cdc_", "__webdriver", "domautomation", "phantom", "selenium"]) {
         const idx = lower.indexOf(probe);
         if (idx !== -1) tells[probe] = body.slice(Math.max(0, idx - 20), idx + 40).split(String.fromCharCode(10)).join(" ").trim();
       }
       return {
         title: document.title,
         bodyLength: body.length,
         screenshotPath: shotPath,
         webdriver: navigator.webdriver,
         plugins: navigator.plugins.length,
         languages: navigator.languages,
         hasChrome: Boolean(window.chrome),
         webglRenderer: (() => {
           try {
             const c = document.createElement("canvas");
             const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
             if (!gl) return "no-context";
             const ext = gl.getExtension("WEBGL_debug_renderer_info");
             return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
           } catch (e) { return "error:" + e.message; }
         })(),
         headlessSection,
         tells,
         detectors: {
           webdriver: navigator.webdriver === true,
           // The 16 likeHeadless booleans from CreepJS's headless module, each
           // reproduced so the rating math is transparent.
           noChrome: !("chrome" in window),
           noPlugins: navigator.plugins.length === 0,
           noMimeTypes: Object.keys({ ...navigator.mimeTypes }).length === 0,
           notificationIsDenied: ("Notification" in window) && Notification.permission === "denied",
           prefersLightColor: matchMedia("(prefers-color-scheme: light)").matches,
           pdfIsDisabled: ("pdfViewerEnabled" in navigator) && navigator.pdfViewerEnabled === false,
           noTaskbar: screen.height === screen.availHeight && screen.width === screen.availWidth,
           hasVvpScreenRes:
             (window.innerWidth === screen.width && window.outerHeight === screen.height) ||
             (("visualViewport" in window) && visualViewport.width === screen.width && visualViewport.height === screen.height),
           noWebShare: !("share" in navigator) || !("canShare" in navigator),
           noContentIndex: !("ContentIndexProvider" in window),
           noContactsManager: !("contacts" in navigator) && !("ContactsManager" in window),
           hasKnownBgColor: (() => {
             const el = document.createElement("div");
             el.setAttribute("style", "background-color: ActiveText");
             document.body.appendChild(el);
             const bg = getComputedStyle(el).backgroundColor;
             document.body.removeChild(el);
             return bg === "rgb(255, 0, 0)";
           })(),
           screenVsOuter: [screen.width, screen.height, screen.availWidth, screen.availHeight],
           outerDimensions: [window.outerWidth, window.outerHeight],
           innerDimensions: [window.innerWidth, window.innerHeight],
           devicePixelRatio: window.devicePixelRatio,
           connectionRtt: (navigator.connection && navigator.connection.rtt),
           downlinkMax: (navigator.connection && navigator.connection.downlinkMax),
           hardwareConcurrency: navigator.hardwareConcurrency,
           deviceMemory: navigator.deviceMemory,
           notificationPerm: (typeof Notification !== "undefined" ? Notification.permission : "n/a"),
         },
         fullBody: body,
       };
     }, shot.path);`,
    { timeout: 180 },
  );
  if (!result?.ok) {
    console.error("run failed:", JSON.stringify(result)?.slice(0, 800));
    process.exitCode = 1;
  } else {
    const { fullBody, ...rest } = result.result || {};
    console.log(JSON.stringify(rest, null, 2));
    console.log("=== full body ===");
    console.log(fullBody);
    // The artifact lives under the per-run home (removed below); copy it out.
    if (result.result?.screenshotPath) {
      const target = "/tmp/bw-creepjs/creepjs.png";
      fs.mkdirSync("/tmp/bw-creepjs", { recursive: true });
      fs.copyFileSync(result.result.screenshotPath, target);
      console.log("screenshot copied to:", target);
    }
  }
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
