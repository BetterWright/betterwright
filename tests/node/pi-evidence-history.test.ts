import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPiExtension } from "../../dist/src/pi-extension.js";

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-history-"));
  const screenshot = path.join(dir, "proof.png");
  await fs.writeFile(screenshot, "fixture image");
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const browser = {
    downloadPolicy: "allow", screenshot, fail: false, calls: 0,
    async run(code) {
      this.calls += 1;
      return { ok: !this.fail, error: this.fail ? "synthetic screenshot failure" : undefined,
        result: 42, warnings: ["keep this warning"], pages: [{ active: true, url: "https://example.test/fixture" }],
        artifacts: code.includes("screenshot(") && this.screenshot ? [{ kind: "proof", path: this.screenshot }] : [] };
    },
    async close() {},
  };
  createPiExtension({ browser, autoScreenshot: false, ...options })({
    registerTool: tool => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
  });
  t.after(async () => { await handlers.get("session_shutdown")(); await fs.rm(dir, { recursive: true, force: true }); });
  const call = params => tools.get("browser_evidence").execute("evidence", params);
  return { dir, tools, handlers, browser, call };
}

const requirements = [{ id: "fixture", description: "Show exactly 2 visible markers" }];
const proofs = [{ id: "fixture", evidence: "The frame shows exactly 2 visible markers" }];
const text = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("Pi defaults stay bounded across large evidence histories and history reads are paged and read-only", async t => {
  const { call, tools, browser } = await fixture(t);
  const sizes: number[][] = [];
  for (let index = 0; index <= 120; index += 1) {
    const initialized = await call({ operation: "initialize", name: `journey-${index}`, requirements });
    const browsed = await tools.get("browser").execute("browse", { code: "return 42" });
    const downloaded = await tools.get("browser_download").execute("download", { code: "return 42" });
    const proven = await call({ operation: "prove", proofs: [{ id: "fixture", evidence: `${proofs[0].evidence} ${"e".repeat(2048)}` }] });
    const audited = await call({ operation: "audit" });
    const results = [initialized, browsed, downloaded, proven, audited];
    sizes.push(results.map(result => Buffer.byteLength(text(result))));
    for (const result of results) assert.doesNotMatch(text(result), /archivedChecklists|journey--1/);
    const envelope = JSON.parse(text(proven));
    assert.equal(envelope.pi.evidenceChecklist.ready, true);
    assert.equal(envelope.pi.evidenceChecklist.currentChecklist.audited, false);
    assert.equal(proven.content.filter(block => block.type === "image").length, 1);
    assert.deepEqual(envelope.warnings, ["keep this warning"]);
    assert.equal(audited.details.archivedCount, index);
  }
  for (let column = 0; column < sizes[0].length; column += 1) {
    assert.ok(Math.abs(sizes.at(-1)[column] - sizes[0][column]) < 100, JSON.stringify(sizes));
  }
  const before = await call({ operation: "get", name: "journey-120" });
  const calls = browser.calls;
  const firstPage = await call({ operation: "list" });
  assert.equal(firstPage.details.checklists.length, 20);
  assert.equal(firstPage.details.nextOffset, 20);
  assert.equal(firstPage.details.total, 121);
  assert.doesNotMatch(text(firstPage), /requirements|proofArtifacts|eeeeeeee/);
  const lastPage = await call({ operation: "list", offset: 119, limit: 100 });
  assert.deepEqual(lastPage.details.checklists.map(item => item.name), ["journey-119", "journey-120"]);
  assert.equal(lastPage.details.checklists.at(-1).current, true);
  assert.equal(lastPage.details.nextOffset, null);
  assert.deepEqual((await call({ operation: "list", offset: 121 })).details.checklists, []);
  const old = await call({ operation: "get", name: "journey-0" });
  assert.ok(old.details.checklist.requirements[0].evidence.length > 2048);
  assert.equal(old.details.checklist.audited, true);
  old.details.checklist.requirements[0].evidence = "external mutation";
  assert.notEqual((await call({ operation: "get", name: "journey-0" })).details.checklist.requirements[0].evidence, "external mutation");
  await assert.rejects(call({ operation: "get", name: "unknown" }), /Unknown checklist/);
  await assert.rejects(call({ operation: "get" }), /exact checklist name/);
  for (const page of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }]) {
    await assert.rejects(call({ operation: "list", ...page }), /offset.*limit/);
  }
  await assert.rejects(call({ operation: "initialize", name: "journey-0", requirements }), /already in use/);
  assert.deepEqual(await call({ operation: "get", name: "journey-120" }), before);
  assert.equal(browser.calls, calls);
});

test("Pi retains original proof links after worker eviction, reports missing copies, and removes session copies at shutdown", async t => {
  const { call, browser, handlers } = await fixture(t);
  await call({ operation: "initialize", name: "first", requirements });
  const proven = await call({ operation: "prove", proofs });
  const artifact = proven.details.evidenceChecklist.requirements[0].proofArtifacts[0];
  assert.equal(artifact.originalPath, browser.screenshot);
  assert.notEqual(artifact.path, artifact.originalPath);
  assert.equal(await fs.readFile(artifact.path, "utf8"), "fixture image");
  if (process.platform !== "win32") assert.equal((await fs.stat(artifact.path)).mode & 0o777, 0o600);
  await call({ operation: "audit" });
  await call({ operation: "initialize", name: "second", requirements });
  await fs.rm(browser.screenshot);
  assert.equal((await call({ operation: "get", name: "first" })).details.checklist.requirements[0].proofArtifacts[0].available, true);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await fs.chmod(artifact.path, 0o000);
    await assert.rejects(fs.readFile(artifact.path), /EACCES/);
    assert.equal((await call({ operation: "get", name: "first" })).details.checklist.requirements[0].proofArtifacts[0].available, false);
    await fs.chmod(artifact.path, 0o600);
  }
  await fs.rm(artifact.path);
  assert.equal((await call({ operation: "get", name: "first" })).details.checklist.requirements[0].proofArtifacts[0].available, false);
  const directory = path.dirname(artifact.path);
  await handlers.get("session_shutdown")();
  await assert.rejects(fs.stat(directory), /ENOENT/);
});

test("Pi rejected, missing, oversized and failed screenshot proofs remain pending and unaudited", async t => {
  const { call, browser, dir } = await fixture(t);
  await call({ operation: "initialize", name: "pending", requirements });
  await assert.rejects(call({ operation: "prove", proofs: [{ id: "fixture", evidence: "The marker failed" }] }), /proof rejected/);
  for (const kind of ["failed", "missing", "oversized", "unreadable"]) {
    browser.fail = kind === "failed";
    browser.screenshot = kind === "missing" ? "" : path.join(dir, `${kind}.png`);
    if (kind === "oversized") await fs.writeFile(browser.screenshot, Buffer.alloc(2_500_001));
    const result = await call({ operation: "prove", proofs });
    assert.equal(result.details.ok, false, kind);
    assert.match(result.details.error, /screenshot/i);
    const audited = await call({ operation: "audit" });
    assert.equal(audited.details.ready, false);
    assert.equal(audited.details.currentChecklist.audited, false);
    assert.deepEqual(audited.details.pending, ["fixture"]);
  }
});

test("Pi history and audit remain available after the browser budget, and new proof invalidates audit", async t => {
  const { call, tools } = await fixture(t, { maxSteps: 2 });
  assert.deepEqual((await call({ operation: "list" })).details.checklists, []);
  await call({ operation: "initialize", name: "budget", requirements });
  await call({ operation: "prove", proofs });
  assert.equal((await call({ operation: "audit" })).details.currentChecklist.audited, true);
  const again = await call({ operation: "prove", proofs });
  assert.equal(again.details.evidenceChecklist.currentChecklist.audited, false);
  assert.equal((await call({ operation: "audit" })).details.currentChecklist.audited, true);
  assert.equal((await call({ operation: "get", name: "budget" })).details.checklist.ready, true);
  await assert.rejects(tools.get("browser").execute("exhausted", { code: "return 42" }), /budget/);
});
