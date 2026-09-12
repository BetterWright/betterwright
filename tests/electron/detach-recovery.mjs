import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { configureElectronNetwork, createElectronHostTarget } from "../../dist/src/electron.js";
import { BetterWright, NetworkPolicy } from "../../dist/src/index.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-native-detach-"));
app.setPath("userData", path.join(home, "electron"));
configureElectronNetwork();
const watchdog = setTimeout(() => { console.error("Native detach test exceeded 60s"); app.exit(1); }, 60_000);
let window;
let server;
let browser;
const connections = [];

async function main() {
  await app.whenReady();
  server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<label>Name<input></label><button onclick="document.body.dataset.saves=String(Number(document.body.dataset.saves||0)+1)">Save</button>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  window = new BrowserWindow({ show: false, webPreferences: { partition: `bw-detach-${process.pid}`, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const contents = window.webContents;
  await contents.loadURL("about:blank");
  const target = createElectronHostTarget({ contents });
  browser = new BetterWright({ home, vault: false, adBlock: false, parkBackgroundPages: false,
    policy: new NetworkPolicy({ allowLoopback: true }),
    hostTarget: { ...target, async connect(options) { const connection = await target.connect(options); connections.push(connection); return connection; } },
  });
  const run = async code => {
    const result = await browser.run(code, { timeout: 10 });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  };
  const detach = async () => {
    const connection = connections.at(-1);
    contents.debugger.detach();
    await connection.close();
    assert.equal(connection.closed, true);
    assert.equal(contents.isDestroyed(), false);
  };
  await run(`await page.goto(${JSON.stringify(url)}); await page.getByRole('button', {name:'Save'}).click();`);
  await detach();
  assert.equal(connections.length, 1);
  assert.equal(await contents.executeJavaScript("document.body.dataset.saves"), "1");
  // No delay: the next stdin command must not race the worker's CDP close event.
  assert.equal(await run("return await page.locator('body').getAttribute('data-saves');"), "1");
  assert.equal(connections.length, 2);
  console.log("PASS idle native detach, immediate explicit run, no action replay");

  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const onConsole = details => {
    if (details.message === "bw-pending-detach-ready") started();
  };
  contents.on("console-message", onConsole);
  const pending = browser.run("await page.evaluate(() => { console.log('bw-pending-detach-ready'); return new Promise(() => {}); });", { timeout: 20 });
  try { await ready; } finally { contents.removeListener("console-message", onConsole); }
  await detach();
  const interrupted = await pending;
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted));
  assert.equal(connections.length, 2);
  assert.equal(await contents.executeJavaScript("document.body.dataset.saves"), "1");
  await run("await page.getByRole('button', {name:'Save'}).click();");
  assert.equal(connections.length, 3);
  assert.equal(await contents.executeJavaScript("document.body.dataset.saves"), "2");
  assert.equal(contents.isDestroyed(), false);
  console.log("PASS pending evaluate interrupted, result preserved, next explicit run reconnects once");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
  clearTimeout(watchdog);
  app.exit(process.exitCode || 0);
});
