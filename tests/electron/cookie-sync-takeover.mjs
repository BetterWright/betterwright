import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { configureElectronNetwork, createElectronHostTarget } from "../../dist/src/electron.js";
import { BetterWright } from "../../dist/src/index.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-electron-cookie-takeover-"));
app.setPath("userData", path.join(home, "electron"));
configureElectronNetwork();
app.on("window-all-closed", () => {});

function cookies(name) {
  return {
    cookies: [{ name, value: "synthetic-only", domain: "example.test", path: "/", secure: true, httpOnly: true }],
    selected: 1, skipped: 0, warnings: [], source: { browser: "chrome" },
  };
}

async function check(phase) {
  const window = new BrowserWindow({ show: false, webPreferences: { partition: `bw-cookie-${phase}-${process.pid}`, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const contents = window.webContents;
  await contents.loadURL("about:blank");
  const takeover = new AbortController();
  const target = createElectronHostTarget({ contents, signal: takeover.signal, cookieImport: true });
  let connection;
  let connectionCloses = 0;
  const browser = new BetterWright({
    home: path.join(home, phase), vault: false, adBlock: false,
    hostTarget: { ...target, async connect(options) {
      connection = await target.connect(options);
      const close = connection.close.bind(connection);
      connection.close = () => { connectionCloses++; return close(); };
      return connection;
    } },
  });
  let release = () => {};
  const sendCommand = contents.debugger.sendCommand.bind(contents.debugger);
  try {
    browser._extractCookieSync = async () => cookies("before_takeover");
    const initial = await browser.syncCookies({ source: { browser: "chrome" } });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.synced, 1);
    assert.deepEqual(initial.cookieImportDomains, ["example.test"]);
    assert.equal((await contents.session.cookies.get({ name: "before_takeover" })).length, 1);

    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    if (phase === "extraction") {
      browser._extractCookieSync = async () => { entered(); await pause; return cookies("after_takeover"); };
    } else {
      browser._extractCookieSync = async () => cookies("during_dispatch");
      // Hold the real CDP reply after the write has committed, so takeover must
      // drain the command and report its potentially committed effect.
      contents.debugger.sendCommand = async (method, ...args) => {
        const result = await sendCommand(method, ...args);
        if (method === "Network.setCookies") { entered(); await pause; }
        return result;
      };
    }
    let settled = false;
    const pending = browser.syncCookies({ source: { browser: "chrome" } }).then(result => { settled = true; return result; });
    await started;
    takeover.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "operation settled before its work drained");
    release();
    const cancelled = await pending;
    assert.equal(cancelled.errorCode, "BW_ABORTED", JSON.stringify(cancelled));
    assert.equal(cancelled.effectMayHaveCommitted, phase === "dispatch");
    assert.equal(contents.isDestroyed(), false);
    assert.equal(connection.closed, true, "takeover retained the old CDP lease");
    assert.equal(connectionCloses, 1, "host teardown ran more than once");
    assert.equal(browser._process, null, "takeover retained the worker");
    const reclaimed = await createElectronHostTarget({ contents }).connect({ proxyUrl: "socks5://127.0.0.1:1" });
    await reclaimed.close();
    assert.equal((await contents.session.cookies.get({ name: "after_takeover" })).length, 0);
    if (phase === "dispatch") assert.equal((await contents.session.cookies.get({ name: "during_dispatch" })).length, 1);

    browser._extractCookieSync = async () => { throw new Error("extraction ran after takeover"); };
    const alreadyAborted = await browser.syncCookies({ source: { browser: "chrome" } });
    assert.equal(alreadyAborted.errorCode, "BW_ABORTED", JSON.stringify(alreadyAborted));
    assert.equal(alreadyAborted.effectMayHaveCommitted, false);
    console.log(`PASS real Electron Cookie Sync takeover during ${phase}, already-aborted lease, and cookie-store verification`);
  } finally {
    release();
    contents.debugger.sendCommand = sendCommand;
    await browser.close();
    window.destroy();
  }
}

async function main() {
  await app.whenReady();
  await check("extraction");
  await check("dispatch");
}
void main().then(() => {
  fs.rmSync(home, { recursive: true, force: true });
  app.quit();
}, error => {
  console.error(error);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(1);
});
