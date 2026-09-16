import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import { AD_BLOCK_CACHE_FILE } from "../../dist/src/ad-blocker.js";
import { doctorReport } from "../../dist/src/doctor.js";
import { BetterWright } from "../../dist/src/index.js";
import { followIntentDeps, runFollowIntent } from "../../dist/src/system-one.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const browserStatus = await doctorReport();
const ready = browserStatus.ready;
if (!ready && process.env.BETTERWRIGHT_REQUIRE_BROWSER) {
  throw new Error(
    `BETTERWRIGHT_REQUIRE_BROWSER is set but no browser runtime is ready (doctor browser: ${browserStatus.browser}).`,
  );
}
const opts = {
  skip: ready ? false : `browser runtime not ready (doctor browser: ${browserStatus.browser})`,
};

function tempHome() {
  const home = makeTempDir("betterwright-system-one-browser-");
  const runtime = path.join(home, "browser", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, AD_BLOCK_CACHE_FILE), PlaywrightBlocker.empty().serialize());
  return home;
}

async function listen(html: string) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: the listening event above completed a TCP bind, so address()
  // returns an AddressInfo rather than null or a pipe path string.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

test("open dialog controls are listed before the page behind them", opts, async () => {
  const site = await listen(`<!doctype html><button id="export">Export payroll CSV</button>
    <dialog id="login" open><h2>Sign in to continue</h2>
      <label>Password <input type="password"></label>
      <button>Sign in</button><button>Cancel</button>
    </dialog>`);
  const home = tempHome();
  const bw = new BetterWright({ home, headless: true });
  try {
    const directory = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      return controls.directory();
    `);
    assert.equal(directory.ok, true, directory.error);
    const names = directory.result.controls.map((control) => control.target.name || control.target.label);
    assert.ok(names.includes("Sign in"), JSON.stringify(names));
    assert.equal(directory.result.controls[0].dialog, true);
    assert.ok(directory.result.controls.find((control) => control.target.name === "Sign in").dialog);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("a dialog with more controls than the budget stays within the directory bound", opts, async () => {
  const buttons = Array.from({ length: 50 }, (_, index) => `<button>Dialog action ${index}</button>`).join("");
  const links = Array.from({ length: 30 }, (_, index) => `<a href="/l${index}">Page link ${index}</a>`).join("");
  const site = await listen(`<!doctype html>${links}<dialog open>${buttons}</dialog>`);
  const home = tempHome();
  const bw = new BetterWright({ home, headless: true });
  try {
    const directory = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      return controls.directory();
    `);
    assert.equal(directory.ok, true, directory.error);
    assert.ok(directory.result.controls.length <= 40, `directory listed ${directory.result.controls.length} controls`);
    assert.equal(directory.result.controls[0].dialog, true);
    assert.equal(directory.result.truncated, true);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("followIntent clicks a duplicate row using mocked System One answers", opts, async () => {
  const site = await listen(`<!doctype html><table>
      <tr><td>Alex Chen</td><td>Engineering</td><td><button data-who="eng">Message</button></td></tr>
      <tr><td>Alex Chen</td><td>Finance</td><td><button data-who="finance">Message</button></td></tr>
    </table><output id="oracle" role="status">No message</output>
    <script>
      document.querySelectorAll("button[data-who]").forEach((button) => {
        button.onclick = () => { document.getElementById("oracle").textContent = "Messaged " + button.dataset.who; };
      });
    </script>`);
  const home = tempHome();
  const bw = new BetterWright({ home, headless: true });
  try {
    await bw.run(`await page.goto(${JSON.stringify(site.origin)}); return page.url();`);
    const result = await runFollowIntent(
      followIntentDeps((code, options) => bw.run(code, options), async (request) => {
        const questions: any = request.questions;
        const criteria = questions.target.criteria;
        const finance = Object.keys(criteria).find((id) => String(criteria[id]).includes("Finance"));
        return {
          answers: {
            page_state: { type: "choice", choice: "listing", confidence: 1, probabilities: { listing: 1 } },
            target: {
              type: "choice",
              choice: finance,
              confidence: 1,
              probabilities: { [finance]: 1, none: 0 },
            },
            dropdown_option: { type: "choice", choice: "not_applicable", confidence: 1, probabilities: { not_applicable: 1 } },
            item_present: { type: "noul", noul: 0.9 },
          },
        };
      }, { intent: "Message Finance Alex Chen", expect: "Messaged finance", settleMs: 50 }),
      { intent: "Message Finance Alex Chen", expect: "Messaged finance", query: "Message", settleMs: 50, maxSteps: 4 },
    );
    assert.equal(result.ok, true, result.error || result.reason);
    assert.equal(result.reason, "completed");
    assert.equal(result.oracle, "Messaged finance");
  } finally {
    await bw.close();
    await site.close();
  }
});
