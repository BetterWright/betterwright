import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createLocalCredentialVault } from "../../dist/src/vault.js";
import { runVaultCommand } from "../../dist/src/vault-cli.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const password = "synthetic master password for tests";
const origin = "https://vault.example.test";

test("master protection migrates existing records, survives restart, and revokes other instances", async () => {
  const home = makeTempDir("vault-master-");
  const vault = createLocalCredentialVault({ home });
  const other = createLocalCredentialVault({ home });
  try {
    const saved = await vault.handleRequest("save", { username: "fixture", password: "synthetic-login-secret" }, origin);
    const pending = await vault.handleRequest("generate", { username: "pending" }, origin);
    const ciphertext = fs.readFileSync(vault.paths.data);
    await vault.ownerSetupMaster(password);
    assert.equal(fs.existsSync(vault.paths.key), false);
    assert.deepEqual(fs.readFileSync(vault.paths.data), ciphertext);
    assert.equal((await vault.ownerStatus()).locked, false);
    assert.equal((await other.ownerStatus()).locked, true);
    await assert.rejects(other.ownerList(), { code: "VAULT_LOCKED" });
    await other.ownerUnlock(password);
    assert.equal((await other.ownerList()).credentials.length, 1);
    assert.equal((await other.ownerList()).pendingCredentials[0].pendingId, pending.pendingId);
    assert.equal((await other.ownerReveal(saved.id)).secret, "synthetic-login-secret");
    await vault.ownerLock();
    await assert.rejects(other.handleRequest("fill", { id: saved.id }, origin), { code: "VAULT_LOCKED" });
    await assert.rejects(other.ownerReveal(saved.id), { code: "VAULT_LOCKED" });
    await vault.ownerUnlock(password);
    await assert.rejects(vault.ownerUnlock("incorrect synthetic password"), { code: "VAULT_AUTH_FAILED" });
    assert.equal(vault.redact("synthetic-login-secret"), "[REDACTED_PASSWORD]");
    assert.equal(fs.readFileSync(path.join(vault.dir, "master-key.json"), "utf8").includes(password), false);
  } finally {
    vault.dispose(); other.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("master setup races preserve one key and rejected unlock never replaces ciphertext", async () => {
  const home = makeTempDir("vault-master-race-");
  const a = createLocalCredentialVault({ home });
  const b = createLocalCredentialVault({ home });
  try {
    const outcomes = await Promise.allSettled([a.ownerSetupMaster(password), b.ownerSetupMaster(password)]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    const before = fs.readFileSync(a.paths.data);
    await a.ownerLock();
    await assert.rejects(b.ownerUnlock("wrong synthetic password"), { code: "VAULT_AUTH_FAILED" });
    assert.deepEqual(fs.readFileSync(a.paths.data), before);
    for (const action of ["ownerUnlock", "ownerSetupMaster", "ownerReveal", "ownerLock"]) {
      await assert.rejects(a.handleRequest(action, {}, origin));
    }
  } finally {
    a.dispose(); b.dispose(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI setup confirms privately, never prints secrets, and requires a persistent unlock destination", async () => {
  const home = makeTempDir("vault-master-cli-");
  const output: string[] = [];
  const io = { home, log: (text: string) => output.push(text), error: (text: string) => output.push(text),
    readPassword: async () => password };
  try {
    assert.equal(await runVaultCommand(["setup", "--json"], io), 0);
    assert.equal(await runVaultCommand(["status", "--json"], io), 0);
    assert.equal(JSON.parse(output.at(-1)).locked, true);
    assert.equal(await runVaultCommand(["unlock"], io), 1);
    let received = false;
    assert.equal(await runVaultCommand(["unlock", "--json"], { ...io,
      unlockDaemon: async (value: string) => {
        received = value === password;
        return { configured: true, locked: false };
      },
    }), 0);
    assert.equal(received, true);
    assert.equal(output.join("\n").includes(password), false);
    assert.equal(await runVaultCommand(["setup", "plaintext-argument"], io), 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("unlock expires without removing saved data or redaction material", async () => {
  const home = makeTempDir("vault-master-expiry-");
  const vault = createLocalCredentialVault({ home, autoLockMs: 20 });
  try {
    await assert.rejects(vault.ownerSetupMaster("short"), { code: "BAD_INPUT" });
    assert.equal(fs.existsSync(vault.paths.key), false);
    await vault.handleRequest("save", { username: "fixture", password: "expiry-secret" }, origin);
    await vault.ownerSetupMaster(password);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await vault.ownerStatus()).locked, true);
    await assert.rejects(vault.ownerList(), { code: "VAULT_LOCKED" });
    assert.equal(vault.redact("expiry-secret"), "[REDACTED_PASSWORD]");
    assert.equal(fs.existsSync(vault.paths.data), true);
  } finally { vault.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("saving preferences persist, fail closed, and keep owner capture independent of agent access", async () => {
  const home = makeTempDir("vault-settings-");
  const vault = createLocalCredentialVault({ home });
  try {
    await assert.rejects(vault.ownerConfigure({ agentUse: true, offerSave: false, autosave: true }));
    await vault.ownerConfigure({ agentUse: false, offerSave: true, autosave: false });
    await assert.rejects(vault.handleRequest("list", {}, origin), { code: "VAULT_AGENT_DISABLED" });
    await vault.ownerCapture({ username: "owner", password: "captured-synthetic" }, origin);
    assert.equal((await vault.ownerList()).credentials.length, 1);
    await vault.ownerConfigure({ agentUse: true, offerSave: false, autosave: false });
    const other = createLocalCredentialVault({ home });
    assert.equal((await other.ownerSettings()).offerSave, false);
    assert.deepEqual(await other.ownerCapture({ username: "disabled", password: "not-saved" }, origin), { saved: false });
    assert.equal((await other.ownerList()).credentials.length, 1);
    other.dispose();
    const output: string[] = [];
    const io = { home, log: (text: string) => output.push(text), error: (text: string) => output.push(text) };
    assert.equal(await runVaultCommand(["settings", "offer-save", "on", "--json"], io), 0);
    assert.equal(JSON.parse(output.at(-1)).offerSave, true);
    assert.equal(await runVaultCommand(["settings", "autosave", "on", "--json"], io), 0);
    assert.equal(JSON.parse(output.at(-1)).autosave, true);
  } finally { vault.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});
