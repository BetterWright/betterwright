#!/usr/bin/env node
// Cloaking V2 stealth report.
//
// Serves tests/fixtures/stealth-probe.html on loopback, launches the managed
// browser in headless and (when a display exists) headed mode, collects the
// per-check results, and prints a score table. With --live it also visits
// public bot-score pages and scrapes their headline verdicts.
//
// Usage:
//   node research/stealth-report.js [--live] [--headed-only|--headless-only]
//   node research/stealth-report.js --json > report.json

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BetterWright } from "../dist/src/index.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE_PAGE = path.join(ROOT, "tests", "fixtures", "stealth-probe.html");
const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const AS_JSON = args.includes("--json");
const HEADED_ONLY = args.includes("--headed-only");
const HEADLESS_ONLY = args.includes("--headless-only");
const NO_CLOAK_V2 = args.includes("--no-cloak-v2");
function flagValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}
// --upstream socks5://user:pass@host:1080 runs the whole matrix through the
// egress proxy with geo-matched identity (the IP layer); --geoip-off pins
// en-US + host timezone instead of resolving from the egress IP.
const UPSTREAM = flagValue("--upstream");
const GEOIP = UPSTREAM && !args.includes("--geoip-off");
const ONLY_SITE = flagValue("--site");

const LIVE_SITES = [
  { name: "sannysoft", url: "https://bot.sannysoft.com/", wait: 4000 },
  {
    name: "incolumitas",
    url: "https://bot.incolumitas.com/",
    wait: 16000,
    hostWait: true,
    script: `const score = await page.locator("#behavioralScore").textContent();
     const value = Number.parseFloat(score || "");
     const behavioralScore = Number.isFinite(value) ? value : null;
     return { title: await page.title(), text: JSON.stringify({ behavioralScore, classification: behavioralScore == null ? null : behavioralScore >= 0.5 ? "Human" : "Bot" }), failed: [] };`,
  },
  {
    name: "recaptcha-v3-score-democaptcha",
    url: "https://democaptcha.com/demo-form-eng/recaptcha-3-test-score.html",
    wait: 25000,
    hostWait: true,
    script: `return { title: await page.title(), text: await page.locator("#score").textContent(), failed: [] };`,
  },
  {
    name: "browserscan-bot",
    url: "https://www.browserscan.net/bot-detection",
    wait: 8000,
  },
  {
    name: "turnstile-demo",
    url: "https://2captcha.com/demo/cloudflare-turnstile",
    wait: 10000,
    script: `const solve = await captcha.solve({ timeout: 60000, maxStages: 3 });
     const token = await page.locator('[name="cf-turnstile-response"]').inputValue().catch(() => "");
     return { title: await page.title(), text: JSON.stringify({ status: solve.status, stage: solve.stage, cleared: solve.cleared, tokenIssued: token.length > 20, tokenLength: token.length }), failed: [] };`,
  },
  {
    name: "recaptcha-v2-checkbox",
    url: "https://2captcha.com/demo/recaptcha-v2",
    wait: 6000,
    // Full solver path: detect, click, and read the token Google issues.
    script: `const solve = await captcha.solve({ timeout: 60000, maxStages: 3 });
     const tokenLength = await page.evaluate(() => {
       const el = document.querySelector("[name=g-recaptcha-response]");
       return el?.value?.length ?? 0;
     });
     return { title: await page.title(), text: JSON.stringify({ status: solve.status, stage: solve.stage, cleared: solve.cleared, tokenIssued: tokenLength > 20, tokenLength }), failed: [] };`,
  },
  {
    name: "recaptcha-v3-score",
    url: "https://antcpt.com/score_detector/",
    wait: 25000,
    hostWait: true,
    script: `return { title: await page.title(), text: await page.locator(".well .col-md-6 big").textContent(), failed: [] };`,
  },
];

function serveProbe() {
  const html = fs.readFileSync(PROBE_PAGE);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  return new Promise<http.Server>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function collectProbe(browser, url) {
  const result = await browser.run(
    `await page.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: 30000 });
     await page.waitForFunction(() => window.__PROBE_RESULTS__, null, { timeout: 15000 });
     return await page.evaluate(() => window.__PROBE_RESULTS__);`,
    { timeout: 60 },
  );
  if (!result?.ok) throw new Error(`probe run failed: ${JSON.stringify(result)?.slice(0, 400)}`);
  return result.result;
}

async function collectLive(browser, site) {
  const body =
    site.script ||
    `await page.waitForTimeout(${site.wait});
     return await page.evaluate(() => {
       const text = document.body ? document.body.innerText.slice(0, 4000) : "";
       const failed = [...document.querySelectorAll("td.failed, .failed, .fail, [class*=fail]")]
         .map((el) => (el.innerText || "").trim()).filter(Boolean).slice(0, 20);
       return { title: document.title, text, failed };
     });`;
  let result;
  if (site.hostWait) {
    const navigation = await browser.run(
      `await page.goto(${JSON.stringify(site.url)}, { waitUntil: "domcontentloaded", timeout: 45000 });
       return true;`,
      { timeout: 60 },
    );
    if (!navigation?.ok) return { error: JSON.stringify(navigation)?.slice(0, 300) };
    await new Promise((resolve) => setTimeout(resolve, site.wait));
    result = await browser.run(body, { timeout: 120 });
  } else {
    result = await browser.run(
      `await page.goto(${JSON.stringify(site.url)}, { waitUntil: "domcontentloaded", timeout: 45000 });
       ${body}`,
      { timeout: 120 },
    );
  }
  if (!result?.ok) return { error: JSON.stringify(result)?.slice(0, 300) };
  return result.result;
}

function printProbe(mode, data) {
  console.log(`\n=== ${mode} — score ${data.score}/100 ===`);
  for (const check of data.checks) {
    const mark = check.status === "PASS" ? " ✓ " : check.status === "FAIL" ? " ✗ " : " ~ ";
    console.log(`${mark} ${check.name.padEnd(46)} ${check.value}`);
  }
}

async function launchAndProbe({ headless, label }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-stealth-"));
  const browser = new BetterWright({
    home,
    headless,
    cloakV2: !NO_CLOAK_V2,
    defaultTimeout: 60,
    ...(UPSTREAM ? { upstreamProxy: UPSTREAM, geoip: GEOIP } : {}),
  });
  try {
    const server = await serveProbe();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const probe = await collectProbe(browser, url);
    // Egress identity check: which IP and timezone does the stack present?
    let egress = null;
    if (UPSTREAM) {
      const ipCheck = await browser.run(
        `const response = await page.goto("http://ip-api.com/json/?fields=query,country,timezone", { timeout: 30000 });
         const body = await page.evaluate(() => document.body.innerText);
         const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
         return { egress: JSON.parse(body), browserTimezone: tz };`,
        { timeout: 60 },
      );
      egress = ipCheck?.ok ? ipCheck.result : { error: JSON.stringify(ipCheck)?.slice(0, 200) };
    }
    const live = [];
    if (LIVE) {
      for (const site of LIVE_SITES.filter(
        (candidate) => !ONLY_SITE || candidate.name === ONLY_SITE,
      )) {
        try {
          live.push({ name: site.name, ...(await collectLive(browser, site)) });
        } catch (error) {
          live.push({ name: site.name, error: error.message });
        }
      }
    }
    server.close();
    return { label, probe, egress, live };
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const runs = [];
const modes = [];
if (!HEADED_ONLY) modes.push({ headless: true, label: "headless" });
if (!HEADLESS_ONLY && os.platform() === "darwin") modes.push({ headless: false, label: "headed" });

for (const mode of modes) {
  try {
    const report = await launchAndProbe(mode);
    runs.push(report);
    if (!AS_JSON) {
      printProbe(report.label, report.probe);
      if (report.egress) {
        console.log(`\negress: ${JSON.stringify(report.egress)}`);
      }
      for (const site of report.live) {
        console.log(`\n--- live: ${site.name} ---`);
        if (site.error) console.log(`error: ${site.error}`);
        else {
          console.log(`title: ${site.title}`);
          if (site.failed?.length) console.log(`failed rows: ${site.failed.join(" | ")}`);
          else console.log(site.text.slice(0, 600));
        }
      }
    }
  } catch (error) {
    console.error(`\n=== ${mode.label} — ERROR: ${error.message} ===`);
    runs.push({ label: mode.label, error: error.message });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(runs, null, 2));
} else {
  console.log("\n=== summary ===");
  for (const run of runs) {
    console.log(
      run.probe
        ? `${run.label.padEnd(10)} ${run.probe.score}/100`
        : `${run.label.padEnd(10)} error: ${run.error}`,
    );
  }
}
