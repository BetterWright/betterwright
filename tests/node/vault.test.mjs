import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  _windowsProcessIdentityForTest,
  createLocalCredentialVault,
  LocalCredentialVault,
  LocalCredentialVaultError,
} from "../../src/vault.mjs";

const EXAMPLE = "https://login.example.com";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "betterwright-vault-test-"));
  const dir = path.join(root, "vault");
  return {
    root,
    dir,
    vault: new LocalCredentialVault({ dir, ...options }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function saveLogin(vault, username, password, origin = EXAMPLE, extra = {}) {
  return vault.handleRequest("save", { username, password, ...extra }, origin);
}

async function expectNoCredential(promise) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof LocalCredentialVaultError &&
      ["NOT_FOUND", "PENDING_NOT_FOUND"].includes(error.code),
  );
}

function childSave(directory, username, { barrier = null } = {}) {
  const moduleUrl = pathToFileURL(path.resolve("src/vault.mjs")).href;
  const source = `
    import { existsSync } from "node:fs";
    import { LocalCredentialVault } from ${JSON.stringify(moduleUrl)};
    while (
      process.env.TEST_VAULT_BARRIER &&
      !existsSync(process.env.TEST_VAULT_BARRIER)
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    const vault = new LocalCredentialVault(process.env.TEST_VAULT_DIR);
    await vault.handleRequest(
      "save",
      { username: process.env.TEST_VAULT_USER, password: "child-process-secret" },
      "https://concurrent.example.com",
    );
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        TEST_VAULT_DIR: directory,
        TEST_VAULT_USER: username,
        ...(barrier ? { TEST_VAULT_BARRIER: barrier } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vault child exited ${code}: ${stderr}`));
    });
  });
}

async function createStaleLock(
  vault,
  {
    pid = 2_147_483_647,
    processIdentity = "stale-process-instance",
    ageMs = 60_000,
  } = {},
) {
  await mkdir(vault.dir, { recursive: true, mode: 0o700 });
  await mkdir(vault.paths.lock, { mode: 0o700 });
  const owner = path.join(vault.paths.lock, "owner.json");
  await writeFile(
    owner,
    `${JSON.stringify({
      pid,
      processIdentity,
      token: "known-stale-lock-token",
      createdAt: 0,
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(vault.paths.lock, 0o700);
  await chmod(owner, 0o600);
  const staleAt = new Date(Date.now() - ageMs);
  await utimes(owner, staleAt, staleAt);
  await utimes(vault.paths.lock, staleAt, staleAt);
}

async function captureCurrentProcessIdentity(context) {
  let identity;
  const vault = new LocalCredentialVault({
    dir: context.dir,
    _lockAcquiredForTest: async (lockPath) => {
      const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
      identity = owner.processIdentity;
    },
  });
  await vault.handleRequest("list", {}, EXAMPLE);
  return identity;
}

test("encrypts all records, keeps files owner-only, and returns metadata only", async () => {
  const context = await fixture();
  const password = "login-secret-very-private";
  const apiSecret = "api-token-also-very-private";
  try {
    const savedLogin = await saveLogin(context.vault, "alice@example.com", password, EXAMPLE, {
      label: "Work login",
    });
    const savedApi = await context.vault.handleRequest(
      "save",
      {
        category: "api-credential",
        label: "Build API",
        fields: { token: apiSecret, region: "us-east-1" },
        notes: "private operator note",
      },
      EXAMPLE,
    );
    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);

    for (const result of [savedLogin, savedApi, listed]) {
      const text = JSON.stringify(result);
      assert.doesNotMatch(text, /login-secret-very-private/);
      assert.doesNotMatch(text, /api-token-also-very-private/);
      assert.doesNotMatch(text, /private operator note/);
      assert.doesNotMatch(text, /"password"|"fields"|"notes"/);
    }
    const [key, ciphertext, audit] = await Promise.all([
      readFile(context.vault.paths.key),
      readFile(context.vault.paths.data, "utf8"),
      readFile(context.vault.paths.audit, "utf8"),
    ]);
    assert.equal(key.length, 32);
    assert.equal(JSON.parse(ciphertext).algorithm, "aes-256-gcm");
    for (const diskText of [ciphertext, audit]) {
      assert.doesNotMatch(diskText, /login-secret-very-private/);
      assert.doesNotMatch(diskText, /api-token-also-very-private/);
      assert.doesNotMatch(diskText, /private operator note/);
      assert.doesNotMatch(diskText, /alice@example\.com/);
    }
    for (const file of [context.vault.paths.key, context.vault.paths.data, context.vault.paths.audit]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(context.dir)).mode & 0o777, 0o700);
    for (const line of audit.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    await context.cleanup();
  }
});

test("persisted mutations succeed with a bounded warning when audit writing fails", async () => {
  const context = await fixture();
  const username = "audit-warning-user";
  const password = "audit-warning-secret";
  const makeAuditUnsafe = async () => {
    await rm(context.vault.paths.audit, { recursive: true, force: true });
    await mkdir(context.vault.paths.audit, { mode: 0o700 });
  };
  const assertSafeWarning = (result, ...secrets) => {
    assert.equal(result.auditWarning?.code, "AUDIT_WRITE_FAILED");
    const text = JSON.stringify(result.auditWarning);
    assert.ok(text.length < 256);
    for (const sensitiveValue of [context.dir, context.vault.paths.audit, ...secrets]) {
      assert.ok(!text.includes(sensitiveValue));
    }
  };
  try {
    await context.vault.handleRequest("list", {}, EXAMPLE);
    await makeAuditUnsafe();

    const saved = await saveLogin(context.vault, username, password);
    assertSafeWarning(saved, username, password);
    assert.match(saved.id, /^cred_/);

    await rm(context.vault.paths.audit, { recursive: true, force: true });
    assert.equal(
      (await new LocalCredentialVault(context.dir).handleRequest("fill", { id: saved.id }, EXAMPLE))
        .secret,
      password,
    );
    await makeAuditUnsafe();

    const generatedForCommit = await context.vault.handleRequest(
      "generate",
      { username: "pending-audit-commit" },
      EXAMPLE,
    );
    assertSafeWarning(
      generatedForCommit,
      generatedForCommit.username,
      generatedForCommit.secret,
    );
    assert.match(generatedForCommit.pendingId, /^pending_/);
    const committed = await new LocalCredentialVault(context.dir).handleRequest(
      "commit",
      { pendingId: generatedForCommit.pendingId },
      EXAMPLE,
    );
    assert.equal(committed.committed, true);
    assertSafeWarning(committed, generatedForCommit.username, generatedForCommit.secret);

    const generatedForDiscard = await context.vault.handleRequest(
      "generate",
      { username: "pending-audit-discard" },
      EXAMPLE,
    );
    assert.match(generatedForDiscard.pendingId, /^pending_/);
    const discarded = await new LocalCredentialVault(context.dir).handleRequest(
      "discard",
      { pendingId: generatedForDiscard.pendingId },
      EXAMPLE,
    );
    assert.equal(discarded.discarded, true);
    assertSafeWarning(discarded, generatedForDiscard.username, generatedForDiscard.secret);

    const afterCleanup = await context.vault.handleRequest(
      "generate",
      { username: "pending-after-audit-cleanup" },
      EXAMPLE,
    );
    assert.match(afterCleanup.pendingId, /^pending_/);
    assertSafeWarning(afterCleanup, afterCleanup.username, afterCleanup.secret);

    await rm(context.vault.paths.audit, { recursive: true, force: true });
    await context.vault.handleRequest(
      "discard",
      { pendingId: afterCleanup.pendingId },
      EXAMPLE,
    );
    const audit = await readFile(context.vault.paths.audit, "utf8");
    for (const sensitiveValue of [
      username,
      password,
      generatedForCommit.username,
      generatedForCommit.secret,
      generatedForDiscard.username,
      generatedForDiscard.secret,
      afterCleanup.username,
      afterCleanup.secret,
    ]) {
      assert.ok(!audit.includes(sensitiveValue));
    }
  } finally {
    await context.cleanup();
  }
});

test("persists across instances and explicit saves upsert the newest matching login", async () => {
  const context = await fixture();
  try {
    const first = await saveLogin(context.vault, "alice", "password-one");
    const replacement = await saveLogin(context.vault, "ALICE", "password-two", EXAMPLE, {
      label: "updated",
    });
    assert.equal(replacement.id, first.id);

    const reopened = createLocalCredentialVault(context.dir);
    const listed = await reopened.handleRequest("list", {}, EXAMPLE);
    assert.equal(listed.credentials.length, 1);
    assert.equal(listed.credentials[0].label, "updated");
    const filled = await reopened.handleRequest("fill", { username: "alice" }, EXAMPLE);
    assert.equal(filled.id, first.id);
    assert.equal(filled.secret, "password-two");
  } finally {
    await context.cleanup();
  }
});

test("detects ciphertext tampering, oversized ciphertext, and a missing key", async () => {
  const context = await fixture();
  try {
    await saveLogin(context.vault, "alice", "tamper-proof-secret");
    const original = await readFile(context.vault.paths.data);
    const envelope = JSON.parse(original.toString("utf8"));
    const index = Math.floor(envelope.ciphertext.length / 2);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, index)}${
      envelope.ciphertext[index] === "A" ? "B" : "A"
    }${envelope.ciphertext.slice(index + 1)}`;
    await writeFile(context.vault.paths.data, JSON.stringify(envelope));
    await assert.rejects(
      new LocalCredentialVault(context.dir).handleRequest("list", {}, EXAMPLE),
      /authentication failed|corrupt/i,
    );

    await writeFile(context.vault.paths.data, Buffer.alloc(6 * 1024 * 1024 + 1, 1));
    await assert.rejects(
      new LocalCredentialVault(context.dir).handleRequest("list", {}, EXAMPLE),
      /size limit/i,
    );

    await writeFile(context.vault.paths.data, original);
    await unlink(context.vault.paths.key);
    await assert.rejects(
      new LocalCredentialVault(context.dir).handleRequest("list", {}, EXAMPLE),
      (error) => error instanceof LocalCredentialVaultError && error.code === "VAULT_KEY_MISSING",
    );
  } finally {
    await context.cleanup();
  }
});

test("base-domain matching honors private suffixes, localhost tenants, and TLS downgrade safety", async () => {
  const context = await fixture();
  try {
    const web = await saveLogin(
      context.vault,
      "web",
      "web-domain-secret",
      "https://signup.example.com/register",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: web.id },
          "https://login.example.com:443/path",
        )
      ).secret,
      "web-domain-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: web.id }, "http://login.example.com"),
    );

    const local = await saveLogin(
      context.vault,
      "local",
      "local-tenant-secret",
      "http://signup.acme.localhost:4173",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: local.id },
          "http://login.acme.localhost:8888",
        )
      ).secret,
      "local-tenant-secret",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: local.id },
          "https://login.acme.localhost",
        )
      ).secret,
      "local-tenant-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: local.id }, "http://evil.localhost"),
    );
    const upgradedLocal = await saveLogin(
      context.vault,
      "local",
      "upgraded-local-secret",
      "https://login.acme.localhost",
    );
    assert.equal(upgradedLocal.id, local.id);
    assert.equal(upgradedLocal.origin, "https://login.acme.localhost");
    await expectNoCredential(
      context.vault.handleRequest(
        "fill",
        { id: local.id },
        "http://login.acme.localhost",
      ),
    );

    const privateSuffix = await saveLogin(
      context.vault,
      "private",
      "private-suffix-secret",
      "https://signup.team.github.io",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: privateSuffix.id },
          "https://login.team.github.io",
        )
      ).secret,
      "private-suffix-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "fill",
        { id: privateSuffix.id },
        "https://login.other.github.io",
      ),
    );

    const ip = await saveLogin(
      context.vault,
      "ip",
      "ip-host-secret",
      "http://127.0.0.1:3000",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: ip.id },
          "http://127.0.0.1:9000",
        )
      ).secret,
      "ip-host-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: ip.id }, "http://127.0.0.2:3000"),
    );
  } finally {
    await context.cleanup();
  }
});

test("host, exact-origin, and never match modes are enforced", async () => {
  const context = await fixture();
  try {
    const host = await saveLogin(
      context.vault,
      "host-only",
      "host-only-secret",
      "https://accounts.example.com:8443",
      { matchMode: "host" },
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: host.id },
          "https://accounts.example.com:9443",
        )
      ).secret,
      "host-only-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: host.id }, "https://login.example.com:8443"),
    );

    const exact = await saveLogin(
      context.vault,
      "exact",
      "exact-origin-secret",
      "https://exact.example.com:8443/path",
      { matchMode: "exact-origin" },
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: exact.id },
          "https://exact.example.com:8443/other",
        )
      ).secret,
      "exact-origin-secret",
    );
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: exact.id }, "https://exact.example.com"),
    );

    const never = await saveLogin(
      context.vault,
      "never",
      "never-match-secret",
      "https://never.example.com:8443/settings",
      { matchMode: "never" },
    );
    const listed = await context.vault.handleRequest("list", {}, "https://never.example.com:8443");
    assert.ok(!listed.credentials.some((record) => record.id === never.id));
    await expectNoCredential(
      context.vault.handleRequest("fill", { id: never.id }, "https://never.example.com:8443"),
    );
    await assert.rejects(
      context.vault.handleRequest(
        "update",
        { id: never.id, label: "Wrong site" },
        "https://unrelated.example.net",
      ),
      (error) => error instanceof LocalCredentialVaultError && error.code === "NOT_FOUND",
    );
    for (const wrongOrigin of [
      "https://never.example.com:9443",
      "http://never.example.com:8443",
    ]) {
      await assert.rejects(
        context.vault.handleRequest(
          "update",
          { id: never.id, label: "Wrong origin" },
          wrongOrigin,
        ),
        (error) => error instanceof LocalCredentialVaultError && error.code === "NOT_FOUND",
      );
    }
    const updatedNever = await context.vault.handleRequest(
      "update",
      { id: never.id, label: "Still managed" },
      "https://never.example.com:8443/account",
    );
    assert.equal(updatedNever.id, never.id);
    assert.equal(updatedNever.label, "Still managed");
    assert.equal(updatedNever.matchMode, "never");
    const removedNever = await context.vault.handleRequest(
      "remove",
      { id: never.id },
      "https://never.example.com:8443/credentials",
    );
    assert.equal(removedNever.removed, true);
    await assert.rejects(
      context.vault.handleRequest("list", {}, "file:///tmp/login.html"),
      /http or https/i,
    );
  } finally {
    await context.cleanup();
  }
});

test("generated passwords remain provisional but survive a vault restart", async () => {
  const context = await fixture();
  try {
    await context.vault.handleRequest("list", {}, "https://signup.example.com");
    const before = await readFile(context.vault.paths.data);
    const generated = await context.vault.handleRequest(
      "generate",
      { username: "new-user", label: "Signup", length: 32 },
      "https://signup.example.com",
    );
    assert.equal(generated.secret.length, 32);
    assert.match(generated.pendingId, /^pending_/);
    const pendingCiphertext = await readFile(context.vault.paths.data);
    assert.notDeepEqual(pendingCiphertext, before);
    assert.ok(!pendingCiphertext.includes(Buffer.from(generated.secret)));

    const reopened = new LocalCredentialVault(context.dir);
    assert.equal(
      (await reopened.handleRequest("list", {}, "https://login.example.com")).credentials.length,
      0,
    );

    await expectNoCredential(
      reopened.handleRequest("fill", { username: "new-user" }, "https://login.example.com"),
    );

    const committed = await reopened.handleRequest(
      "commit",
      { pendingId: generated.pendingId },
      "https://login.example.com",
    );
    assert.equal(committed.committed, true);
    assert.ok(!JSON.stringify(committed).includes(generated.secret));
    assert.notDeepEqual(await readFile(context.vault.paths.data), pendingCiphertext);
    assert.equal(
      (
        await new LocalCredentialVault(context.dir).handleRequest(
          "fill",
          { id: committed.id },
          "https://login.example.com",
        )
      ).secret,
      generated.secret,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "commit",
        { pendingId: generated.pendingId },
        "https://login.example.com",
      ),
    );
    const audit = await readFile(context.vault.paths.audit, "utf8");
    assert.ok(!audit.includes(generated.secret));
  } finally {
    await context.cleanup();
  }
});

test("pending generation is idempotent and recoverable by site without secrets", async () => {
  const context = await fixture();
  const origin = "https://signup.recovery.example.com";
  const pendingId = "pending_caller_supplied_recovery";
  try {
    const first = await context.vault.handleRequest(
      "generate",
      {
        pendingId,
        username: "recover-me",
        label: "Recovery test",
        matchMode: "host",
        length: 32,
      },
      origin,
    );
    const retried = await context.vault.handleRequest(
      "generate",
      {
        pendingId,
        username: "recover-me",
        label: "Recovery test",
        matchMode: "host",
        length: 32,
      },
      origin,
    );
    assert.equal(retried.pendingId, pendingId);
    assert.equal(retried.secret, first.secret);

    await assert.rejects(
      context.vault.handleRequest(
        "generate",
        {
          pendingId,
          username: "different-request",
          matchMode: "host",
          length: 32,
        },
        origin,
      ),
      (error) =>
        error instanceof LocalCredentialVaultError &&
        error.code === "PENDING_CONFLICT",
    );

    const recovered = await new LocalCredentialVault(context.dir).handleRequest(
      "list-pending",
      {},
      "https://signup.recovery.example.com/account",
    );
    assert.deepEqual(recovered.pendingCredentials, [
      {
        pendingId,
        origin,
        matchMode: "host",
        username: "recover-me",
        label: "Recovery test",
        category: "login",
        createdAt: first.createdAt,
        expiresAt: first.expiresAt,
        expired: false,
      },
    ]);
    assert.ok(!JSON.stringify(recovered).includes(first.secret));
    assert.deepEqual(
      (
        await context.vault.handleRequest(
          "list-pending",
          {},
          "https://other.example.net",
        )
      ).pendingCredentials,
      [],
    );

    await context.vault.handleRequest("discard", { pendingId }, origin);
    assert.deepEqual(
      (await context.vault.handleRequest("list-pending", {}, origin))
        .pendingCredentials,
      [],
    );
  } finally {
    await context.cleanup();
  }
});

test("post-persist generation failures carry recovery metadata", async () => {
  const pendingId = "pending_ambiguous_generation";
  const context = await fixture({
    _afterGeneratePersistForTest: async () => {
      throw Object.assign(new Error("simulated post-persist failure"), {
        code: "EIO",
      });
    },
  });
  try {
    await assert.rejects(
      context.vault.handleRequest(
        "generate",
        { pendingId, username: "ambiguous-user" },
        "https://ambiguous.example.com",
      ),
      (error) => {
        assert.equal(error.code, "EIO");
        assert.deepEqual(error.pendingCredential, {
          pendingId,
          origin: "https://ambiguous.example.com",
          matchMode: "base-domain",
          username: "ambiguous-user",
          label: null,
          category: "login",
          createdAt: error.pendingCredential.createdAt,
          expiresAt: error.pendingCredential.expiresAt,
          expired: false,
        });
        return true;
      },
    );
    const recovered = await new LocalCredentialVault(context.dir).handleRequest(
      "list-pending",
      {},
      "https://ambiguous.example.com",
    );
    assert.equal(recovered.pendingCredentials[0].pendingId, pendingId);
    await new LocalCredentialVault(context.dir).handleRequest(
      "discard",
      { pendingId },
      "https://ambiguous.example.com",
    );
  } finally {
    await context.cleanup();
  }
});

test("definitive pre-write generation failures do not invent recovery metadata", async () => {
  const pendingId = "pending_not_persisted";
  const context = await fixture({
    _beforeGeneratePersistForTest: async () => {
      throw new LocalCredentialVaultError("snapshot is too large", "VAULT_TOO_LARGE");
    },
  });
  try {
    await assert.rejects(
      context.vault.handleRequest(
        "generate",
        { pendingId },
        "https://too-large.example.com",
      ),
      (error) => {
        assert.equal(error.code, "VAULT_TOO_LARGE");
        assert.equal(error.pendingCredential, undefined);
        return true;
      },
    );
    assert.deepEqual(
      (
        await new LocalCredentialVault(context.dir).handleRequest(
          "list-pending",
          {},
          "https://too-large.example.com",
        )
      ).pendingCredentials,
      [],
    );
  } finally {
    await context.cleanup();
  }
});

test("never-match generated credentials require their exact creation origin", async () => {
  const context = await fixture();
  const origin = "https://never-pending.example.com:8443/signup";
  try {
    const generated = await context.vault.handleRequest(
      "generate",
      { username: "never-generated", matchMode: "never" },
      origin,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "commit",
        { pendingId: generated.pendingId },
        "https://never-pending.example.com:9443/signup",
      ),
    );
    const committed = await context.vault.handleRequest(
      "commit",
      { pendingId: generated.pendingId },
      "https://never-pending.example.com:8443/complete",
    );
    assert.equal(committed.matchMode, "never");
    assert.equal(committed.origin, "https://never-pending.example.com:8443");
    assert.equal(
      (
        await context.vault.handleRequest(
          "list",
          {},
          "https://never-pending.example.com:8443",
        )
      ).credentials.length,
      0,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "fill",
        { id: committed.id },
        "https://never-pending.example.com:8443",
      ),
    );

    const discarded = await context.vault.handleRequest(
      "generate",
      { username: "discard-never", matchMode: "never" },
      origin,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "discard",
        { pendingId: discarded.pendingId },
        "https://never-pending.example.com",
      ),
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "discard",
          { pendingId: discarded.pendingId },
          "https://never-pending.example.com:8443/cancel",
        )
      ).discarded,
      true,
    );
  } finally {
    await context.cleanup();
  }
});

test("committing after an HTTP-to-HTTPS redirect upgrades the generated scope", async () => {
  const context = await fixture();
  try {
    const generated = await context.vault.handleRequest(
      "generate",
      { username: "upgrade-after-signup" },
      "http://signup.acme.localhost:4173",
    );
    const committed = await context.vault.handleRequest(
      "commit",
      { pendingId: generated.pendingId },
      "https://login.acme.localhost",
    );
    assert.equal(committed.origin, "https://login.acme.localhost");
    assert.equal(
      (
        await context.vault.handleRequest(
          "fill",
          { id: committed.id },
          "https://account.acme.localhost",
        )
      ).secret,
      generated.secret,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "fill",
        { id: committed.id },
        "http://login.acme.localhost",
      ),
    );
  } finally {
    await context.cleanup();
  }
});

test("expired pending secrets require exact-ID recovery or explicit cleanup", async () => {
  const context = await fixture({ pendingTtlMs: 5_000 });
  const expiryContext = await fixture({ pendingTtlMs: 30 });
  try {
    const discarded = await context.vault.handleRequest(
      "generate",
      { username: "discard-me" },
      "https://signup.example.com",
    );
    assert.equal(
      (
        await context.vault.handleRequest(
          "discard",
          { pendingId: discarded.pendingId },
          "https://signup.example.com",
        )
      ).discarded,
      true,
    );
    await expectNoCredential(
      context.vault.handleRequest(
        "commit",
        { pendingId: discarded.pendingId },
        "https://signup.example.com",
      ),
    );

    const expired = await expiryContext.vault.handleRequest(
      "generate",
      { username: "expire-me" },
      "https://signup.example.com",
    );
    await new Promise((resolve) => setTimeout(resolve, 45));
    const reopenedExpiryVault = new LocalCredentialVault({
      dir: expiryContext.dir,
      pendingTtlMs: 30,
    });
    assert.equal(
      (await reopenedExpiryVault.handleRequest("list", {}, "https://login.example.com"))
        .credentials.length,
      0,
    );
    await expectNoCredential(
      reopenedExpiryVault.handleRequest(
        "fill",
        { username: "expire-me" },
        "https://login.example.com",
      ),
    );
    await expectNoCredential(
      reopenedExpiryVault.handleRequest(
        "commit",
        { pendingId: expired.pendingId },
        "https://other.example.net",
      ),
    );
    const recovered = await reopenedExpiryVault.handleRequest(
      "commit",
      { pendingId: expired.pendingId },
      "https://login.example.com",
    );
    assert.equal(recovered.recovered, true);
    assert.equal(
      (
        await reopenedExpiryVault.handleRequest(
          "fill",
          { id: recovered.id },
          "https://login.example.com",
        )
      ).secret,
      expired.secret,
    );

    const expiredDiscard = await reopenedExpiryVault.handleRequest(
      "generate",
      { username: "expire-and-discard" },
      "https://signup.example.com",
    );
    await new Promise((resolve) => setTimeout(resolve, 45));
    const discardedAfterExpiry = await new LocalCredentialVault({
      dir: expiryContext.dir,
      pendingTtlMs: 30,
    }).handleRequest(
      "discard",
      { pendingId: expiredDiscard.pendingId },
      "https://login.example.com",
    );
    assert.equal(discardedAfterExpiry.discarded, true);
    assert.equal(discardedAfterExpiry.expired, true);
    await expectNoCredential(
      reopenedExpiryVault.handleRequest(
        "commit",
        { pendingId: expiredDiscard.pendingId },
        "https://login.example.com",
      ),
    );

    const older = await context.vault.handleRequest(
      "generate",
      { username: "older" },
      "https://signup.example.com",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await context.vault.handleRequest(
      "generate",
      { username: "newer" },
      "https://signup.example.com",
    );
    await assert.rejects(
      context.vault.handleRequest("commit", {}, "https://login.example.com"),
      (error) => error instanceof LocalCredentialVaultError && error.code === "BAD_INPUT",
    );
    await assert.rejects(
      context.vault.handleRequest("discard", {}, "https://login.example.com"),
      /requires a pendingId/i,
    );
    const committed = await context.vault.handleRequest(
      "commit",
      { pendingId: newer.pendingId },
      "https://login.example.com",
    );
    assert.equal(committed.username, "newer");
    assert.equal(
      (
        await context.vault.handleRequest(
          "discard",
          { pendingId: older.pendingId },
          "https://login.example.com",
        )
      ).discarded,
      true,
    );

    const unbound = await context.vault.handleRequest(
      "generate",
      { username: "unbound" },
      "https://signup.example.com",
    );
    await assert.rejects(
      context.vault.handleRequest(
        "commit",
        { pendingId: unbound.pendingId, id: committed.id },
        "https://login.example.com",
      ),
      (error) => error instanceof LocalCredentialVaultError && error.code === "BAD_INPUT",
    );
    await context.vault.handleRequest(
      "discard",
      { pendingId: unbound.pendingId },
      "https://login.example.com",
    );
  } finally {
    await Promise.all([context.cleanup(), expiryContext.cleanup()]);
  }
});

test("pending capacity fails closed without evicting expired recoverable secrets", async () => {
  const context = await fixture({ pendingTtlMs: 10 });
  const pending = [];
  try {
    for (let index = 0; index < 64; index += 1) {
      pending.push(
        await context.vault.handleRequest(
          "generate",
          { username: `pending-${index}` },
          "https://signup.example.com",
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      context.vault.handleRequest(
        "generate",
        { username: "must-not-evict" },
        "https://signup.example.com",
      ),
      (error) => error instanceof LocalCredentialVaultError && error.code === "VAULT_TOO_LARGE",
    );
    assert.equal(
      (await context.vault.handleRequest("list", {}, "https://login.example.com")).credentials
        .length,
      0,
    );

    const discarded = await new LocalCredentialVault({
      dir: context.dir,
      pendingTtlMs: 10,
    }).handleRequest(
      "discard",
      { pendingId: pending[0].pendingId },
      "https://login.example.com",
    );
    assert.equal(discarded.expired, true);
    const replacement = await context.vault.handleRequest(
      "generate",
      { username: "replacement-after-cleanup" },
      "https://signup.example.com",
    );
    assert.match(replacement.pendingId, /^pending_/);

    const ciphertext = await readFile(context.vault.paths.data, "utf8");
    const audit = await readFile(context.vault.paths.audit, "utf8");
    for (const generated of [pending[0], pending.at(-1), replacement]) {
      assert.ok(!ciphertext.includes(generated.secret));
      assert.ok(!audit.includes(generated.secret));
    }
  } finally {
    await context.cleanup();
  }
});

test("committed generated rotation preserves record id, count, and omitted metadata", async () => {
  const context = await fixture();
  try {
    const saved = await saveLogin(context.vault, "rotate", "old-rotation-secret", EXAMPLE, {
      label: "Primary account",
    });
    const generated = await context.vault.handleRequest(
      "generate",
      { id: saved.id, length: 28 },
      "https://signup.example.com",
    );
    assert.equal(generated.id, saved.id);
    assert.equal(generated.username, "rotate");
    assert.equal(generated.label, "Primary account");
    assert.equal(
      (await context.vault.handleRequest("fill", { id: saved.id }, EXAMPLE)).secret,
      "old-rotation-secret",
    );

    const committed = await context.vault.handleRequest(
      "commit",
      { pendingId: generated.pendingId },
      EXAMPLE,
    );
    assert.equal(committed.id, saved.id);
    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);
    assert.equal(listed.credentials.length, 1);
    assert.equal(
      (await context.vault.handleRequest("fill", { id: saved.id }, EXAMPLE)).secret,
      generated.secret,
    );

    const override = await context.vault.handleRequest(
      "generate",
      { id: saved.id, username: "rotated-user", label: null },
      EXAMPLE,
    );
    assert.equal(override.username, "rotated-user");
    assert.equal(override.label, null);
    const overrideCommit = await context.vault.handleRequest(
      "commit",
      { pendingId: override.pendingId },
      EXAMPLE,
    );
    assert.equal(overrideCommit.id, saved.id);
    assert.equal(overrideCommit.username, "rotated-user");
    assert.equal(overrideCommit.label, null);
    assert.equal(
      (await context.vault.handleRequest("list", {}, EXAMPLE)).credentials.length,
      1,
    );
  } finally {
    await context.cleanup();
  }
});

test("rotations reject stale commits without rolling back secrets or metadata", async () => {
  const context = await fixture();
  try {
    const saved = await saveLogin(context.vault, "original-user", "original-secret", EXAMPLE, {
      label: "Original label",
    });
    const first = await context.vault.handleRequest("generate", { id: saved.id }, EXAMPLE);
    const second = await context.vault.handleRequest("generate", { id: saved.id }, EXAMPLE);

    const reopened = new LocalCredentialVault(context.dir);
    await expectNoCredential(
      reopened.handleRequest(
        "commit",
        { pendingId: second.pendingId },
        "https://other.example.net",
      ),
    );
    await reopened.handleRequest(
      "commit",
      { pendingId: second.pendingId },
      EXAMPLE,
    );
    await assert.rejects(
      context.vault.handleRequest("commit", { pendingId: first.pendingId }, EXAMPLE),
      (error) => error instanceof LocalCredentialVaultError && error.code === "STALE_PENDING",
    );
    assert.equal(
      (await context.vault.handleRequest("fill", { id: saved.id }, EXAMPLE)).secret,
      second.secret,
    );
    await context.vault.handleRequest("discard", { pendingId: first.pendingId }, EXAMPLE);

    const beforeMetadataEdit = await context.vault.handleRequest(
      "generate",
      { id: saved.id },
      EXAMPLE,
    );
    await new LocalCredentialVault(context.dir).handleRequest(
      "update",
      { id: saved.id, username: "current-user", label: "Current label" },
      EXAMPLE,
    );
    await assert.rejects(
      new LocalCredentialVault(context.dir).handleRequest(
        "commit",
        { pendingId: beforeMetadataEdit.pendingId },
        EXAMPLE,
      ),
      (error) => error instanceof LocalCredentialVaultError && error.code === "STALE_PENDING",
    );
    assert.equal(
      (await context.vault.handleRequest("fill", { id: saved.id }, EXAMPLE)).secret,
      second.secret,
    );
    await context.vault.handleRequest(
      "discard",
      { pendingId: beforeMetadataEdit.pendingId },
      EXAMPLE,
    );

    const current = await context.vault.handleRequest("generate", { id: saved.id }, EXAMPLE);
    const committed = await context.vault.handleRequest(
      "commit",
      { pendingId: current.pendingId },
      EXAMPLE,
    );
    assert.equal(committed.username, "current-user");
    assert.equal(committed.label, "Current label");
    assert.equal(
      (await context.vault.handleRequest("fill", { id: saved.id }, EXAMPLE)).secret,
      current.secret,
    );
  } finally {
    await context.cleanup();
  }
});

test("concurrent instances and processes serialize without dropping records", async () => {
  const context = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        saveLogin(
          new LocalCredentialVault(context.dir),
          `same-process-${index}`,
          `same-process-secret-${index}`,
          "https://concurrent.example.com",
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => childSave(context.dir, `child-${index}`)),
    );
    const listed = await context.vault.handleRequest(
      "list",
      {},
      "https://concurrent.example.com",
    );
    assert.equal(listed.credentials.length, 26);
    assert.equal(new Set(listed.credentials.map((record) => record.username)).size, 26);
  } finally {
    await context.cleanup();
  }
});

test("simultaneous stale-lock recovery cannot unlink a fresh writer lock", async () => {
  const context = await fixture();
  try {
    await saveLogin(
      context.vault,
      "seed",
      "seed-secret",
      "https://concurrent.example.com",
    );
    await createStaleLock(context.vault);
    const barrier = path.join(context.root, "release-children");
    const writers = Array.from({ length: 24 }, (_, index) =>
      childSave(context.dir, `stale-race-${index}`, { barrier }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(barrier, "go");
    const outcomes = await Promise.allSettled(writers);
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(
      failures.length,
      0,
      failures.map((failure) => failure.reason?.stack || String(failure.reason)).join("\n\n"),
    );

    const listed = await context.vault.handleRequest(
      "list",
      {},
      "https://concurrent.example.com",
    );
    assert.equal(listed.credentials.length, 25);
    assert.equal(new Set(listed.credentials.map((record) => record.username)).size, 25);
  } finally {
    await context.cleanup();
  }
});

test("a replaced live lock is detected without deleting its replacement", async () => {
  let entered;
  let resume;
  const lockAcquired = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeOperation = new Promise((resolve) => {
    resume = resolve;
  });
  const context = await fixture({
    staleLockMs: 100,
    _lockAcquiredForTest: async () => {
      entered();
      await resumeOperation;
    },
  });
  try {
    const operation = context.vault.handleRequest("list", {}, EXAMPLE);
    await lockAcquired;

    const displaced = `${context.vault.paths.lock}.displaced`;
    await rename(context.vault.paths.lock, displaced);
    await mkdir(context.vault.paths.lock, { mode: 0o700 });
    const replacementOwner = path.join(context.vault.paths.lock, "owner.json");
    await writeFile(
      replacementOwner,
      `${JSON.stringify({
        pid: process.pid,
        token: "replacement-lock-token",
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    resume();

    await assert.rejects(
      operation,
      (error) =>
        error instanceof LocalCredentialVaultError && error.code === "VAULT_LOCK_COMPROMISED",
    );
    assert.equal(
      JSON.parse(await readFile(replacementOwner, "utf8")).token,
      "replacement-lock-token",
    );
    assert.equal((await stat(context.vault.paths.lock)).isDirectory(), true);
  } finally {
    resume?.();
    await context.cleanup();
  }
});

test("a failed post-publish lock acquisition retires its own lock", async () => {
  let failPublish = true;
  const context = await fixture({
    _afterLockPublishForTest: async () => {
      if (failPublish) throw new Error("simulated parent sync failure");
    },
  });
  try {
    await assert.rejects(
      context.vault.handleRequest("list", {}, EXAMPLE),
      /simulated parent sync failure/,
    );
    await assert.rejects(stat(context.vault.paths.lock), { code: "ENOENT" });

    failPublish = false;
    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);
    assert.deepEqual(listed.credentials, []);
  } finally {
    await context.cleanup();
  }
});

test("a verified live owner remains serialized while heartbeat spans the stale threshold", async () => {
  let entered;
  let resume;
  const lockAcquired = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeOperation = new Promise((resolve) => {
    resume = resolve;
  });
  const context = await fixture({
    staleLockMs: 100,
    lockTimeoutMs: 2_000,
    _lockAcquiredForTest: async () => {
      entered();
      await resumeOperation;
    },
  });
  try {
    const first = saveLogin(context.vault, "heartbeat-first", "heartbeat-first-secret");
    await lockAcquired;

    let secondSettled = false;
    const second = saveLogin(
      new LocalCredentialVault({
        dir: context.dir,
        staleLockMs: 100,
        lockTimeoutMs: 2_000,
      }),
      "heartbeat-second",
      "heartbeat-second-secret",
    ).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(secondSettled, false, "a fresh heartbeat must keep the second writer waiting");

    resume();
    await Promise.all([first, second]);
    const listed = await new LocalCredentialVault(context.dir).handleRequest(
      "list",
      {},
      EXAMPLE,
    );
    assert.deepEqual(
      listed.credentials.map((record) => record.username).sort(),
      ["heartbeat-first", "heartbeat-second"],
    );
  } finally {
    resume?.();
    await context.cleanup();
  }
});

test("Windows process identity uses bounded locale-independent creation ticks", async () => {
  const calls = [];
  const systemRoot = "D:\\Windows";
  const execute = async (...args) => {
    calls.push(args);
    return { stdout: "638885440001234567\r\n" };
  };
  assert.equal(
    await _windowsProcessIdentityForTest(4242, execute, systemRoot),
    "win32:638885440001234567",
  );
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(
    command,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(args[4], /Get-Process -Id 4242 -ErrorAction Stop/);
  assert.match(args[4], /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.equal(options.timeout, 2_000);
  assert.equal(options.maxBuffer, 1_024);
  assert.equal(options.windowsHide, true);

  assert.equal(
    await _windowsProcessIdentityForTest(
      4242,
      async () => ({ stdout: "localized date" }),
      systemRoot,
    ),
    null,
  );
  assert.equal(
    await _windowsProcessIdentityForTest(
      4242,
      async () => {
        throw new Error("access denied");
      },
      systemRoot,
    ),
    null,
  );
  assert.equal(await _windowsProcessIdentityForTest(0, execute, systemRoot), null);
  assert.equal(calls.length, 1, "invalid PIDs must not launch PowerShell");

  for (const unsafeRoot of [undefined, "Windows", "\\\\server\\share", "C:\\Windows\\..\\Temp"]) {
    assert.equal(
      await _windowsProcessIdentityForTest(4242, execute, unsafeRoot),
      null,
    );
  }
  assert.equal(calls.length, 1, "unsafe system roots must not launch PowerShell");
});

test("a lock is recoverable when its live PID has a different identity", async (t) => {
  const context = await fixture({ staleLockMs: 100, lockTimeoutMs: 1_000 });
  try {
    const processIdentity = await captureCurrentProcessIdentity(context);
    if (typeof processIdentity !== "string" || !processIdentity) {
      t.skip("process identity is unavailable on this platform");
      return;
    }
    await createStaleLock(context.vault, {
      pid: process.pid,
      processIdentity: `${processIdentity}:reused`,
      ageMs: 0,
    });
    const saved = await saveLogin(context.vault, "pid-reuse", "pid-reuse-secret");
    assert.equal(saved.username, "pid-reuse");
  } finally {
    await context.cleanup();
  }
});

test("an ancient lock with a matching live process identity is never stolen", async () => {
  const context = await fixture({ staleLockMs: 100, lockTimeoutMs: 200 });
  try {
    const processIdentity = await captureCurrentProcessIdentity(context);
    await createStaleLock(context.vault, {
      pid: process.pid,
      processIdentity,
      ageMs: 5_000,
    });
    await assert.rejects(
      saveLogin(
        new LocalCredentialVault({
          dir: context.dir,
          staleLockMs: 100,
          lockTimeoutMs: 200,
        }),
        "must-wait",
        "must-wait-secret",
      ),
      (error) =>
        error instanceof LocalCredentialVaultError && error.code === "VAULT_LOCK_TIMEOUT",
    );
    const owner = JSON.parse(
      await readFile(path.join(context.vault.paths.lock, "owner.json"), "utf8"),
    );
    assert.equal(owner.processIdentity, processIdentity);
    assert.equal(owner.token, "known-stale-lock-token");
  } finally {
    await context.cleanup();
  }
});

test("an ancient live lock with missing process identity is never stolen", async () => {
  const context = await fixture({ staleLockMs: 100, lockTimeoutMs: 200 });
  try {
    await createStaleLock(context.vault, {
      pid: process.pid,
      processIdentity: null,
      ageMs: 5_000,
    });
    await assert.rejects(
      saveLogin(context.vault, "must-wait", "must-wait-secret"),
      (error) =>
        error instanceof LocalCredentialVaultError && error.code === "VAULT_LOCK_TIMEOUT",
    );
    const owner = JSON.parse(
      await readFile(path.join(context.vault.paths.lock, "owner.json"), "utf8"),
    );
    assert.equal(owner.processIdentity, null);
    assert.equal(owner.token, "known-stale-lock-token");
  } finally {
    await context.cleanup();
  }
});

test(
  "BSD lock identity stays stable across process time zones",
  {
    skip: !["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform),
  },
  async () => {
    const context = await fixture({ staleLockMs: 100, lockTimeoutMs: 250 });
    const moduleUrl = pathToFileURL(path.resolve("src/vault.mjs")).href;
    const holderSource = `
      import { LocalCredentialVault } from ${JSON.stringify(moduleUrl)};
      const vault = new LocalCredentialVault({
        dir: process.env.TEST_VAULT_DIR,
        staleLockMs: 100,
        lockTimeoutMs: 2_000,
        _lockAcquiredForTest: async () => {
          process.stdout.write("LOCKED\\n");
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        },
      });
      await vault.handleRequest("list", {}, ${JSON.stringify(EXAMPLE)});
    `;
    const holder = spawn(process.execPath, ["--input-type=module", "--eval", holderSource], {
      cwd: path.resolve("."),
      env: { ...process.env, TEST_VAULT_DIR: context.dir, TZ: "Pacific/Honolulu" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    holder.stdout.setEncoding("utf8");
    holder.stderr.setEncoding("utf8");
    let holderStderr = "";
    holder.stderr.on("data", (chunk) => {
      holderStderr += chunk;
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for lock holder: ${holderStderr}`)),
          2_000,
        );
        holder.stdout.on("data", (chunk) => {
          if (!String(chunk).includes("LOCKED")) return;
          clearTimeout(timer);
          resolve();
        });
        holder.once("error", reject);
        holder.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`lock holder exited ${code}: ${holderStderr}`));
        });
      });

      const contenderSource = `
        import { LocalCredentialVault } from ${JSON.stringify(moduleUrl)};
        const vault = new LocalCredentialVault({
          dir: process.env.TEST_VAULT_DIR,
          staleLockMs: 100,
          lockTimeoutMs: 250,
        });
        try {
          await vault.handleRequest("list", {}, ${JSON.stringify(EXAMPLE)});
          console.error("contender stole the live lock");
          process.exitCode = 2;
        } catch (error) {
          if (error?.code !== "VAULT_LOCK_TIMEOUT") {
            console.error(error?.stack || String(error));
            process.exitCode = 3;
          }
        }
      `;
      const contender = spawn(
        process.execPath,
        ["--input-type=module", "--eval", contenderSource],
        {
          cwd: path.resolve("."),
          env: { ...process.env, TEST_VAULT_DIR: context.dir, TZ: "Asia/Singapore" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let contenderStderr = "";
      contender.stderr.setEncoding("utf8");
      contender.stderr.on("data", (chunk) => {
        contenderStderr += chunk;
      });
      const [code] = await once(contender, "close");
      assert.equal(code, 0, contenderStderr);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const closed = once(holder, "close");
        holder.kill("SIGTERM");
        await closed;
      }
      await context.cleanup();
    }
  },
);

test("fill fails closed when account selection is ambiguous", async () => {
  const context = await fixture();
  try {
    const aliceOne = await saveLogin(context.vault, "alice", "alice-one-secret", EXAMPLE, {
      upsert: false,
    });
    await saveLogin(context.vault, "alice", "alice-two-secret", EXAMPLE, { upsert: false });
    const bob = await saveLogin(context.vault, "bob", "bob-secret", EXAMPLE, { upsert: false });

    await assert.rejects(
      context.vault.handleRequest("fill", {}, EXAMPLE),
      (error) =>
        error instanceof LocalCredentialVaultError && error.code === "AMBIGUOUS_CREDENTIAL",
    );
    await assert.rejects(
      context.vault.handleRequest("fill", { username: "alice" }, EXAMPLE),
      /list credentials and choose one by id/i,
    );
    assert.equal(
      (await context.vault.handleRequest("fill", { id: aliceOne.id }, EXAMPLE)).secret,
      "alice-one-secret",
    );
    assert.equal(
      (await context.vault.handleRequest("fill", { username: "bob" }, EXAMPLE)).id,
      bob.id,
    );
  } finally {
    await context.cleanup();
  }
});

test("password generation is constrained and active secrets are deeply redacted", async () => {
  const context = await fixture();
  const explicitSecret = "explicit-redaction-secret";
  const fieldSecret = "field-redaction-secret";
  try {
    await saveLogin(context.vault, "redact", explicitSecret);
    await saveLogin(context.vault, "short", "x", EXAMPLE, { upsert: false });
    await saveLogin(context.vault, "prefix", "pass", EXAMPLE, { upsert: false });
    await saveLogin(context.vault, "longer", "password123", EXAMPLE, {
      upsert: false,
    });
    await context.vault.handleRequest(
      "save",
      { category: "api-credential", fields: { token: fieldSecret } },
      EXAMPLE,
    );
    const generated = await context.vault.handleRequest(
      "generate",
      { length: 40, include_symbols: true },
      "https://signup.example.com",
    );
    assert.match(generated.secret, /[a-z]/);
    assert.match(generated.secret, /[A-Z]/);
    assert.match(generated.secret, /[0-9]/);
    assert.match(generated.secret, /[^A-Za-z0-9]/);

    const withoutSymbols = await context.vault.handleRequest(
      "generate",
      { length: 24, includeSymbols: false },
      "https://signup.example.com",
    );
    assert.match(withoutSymbols.secret, /^[A-Za-z0-9]+$/);
    assert.match(withoutSymbols.secret, /[a-z]/);
    assert.match(withoutSymbols.secret, /[A-Z]/);
    assert.match(withoutSymbols.secret, /[0-9]/);
    await assert.rejects(
      context.vault.handleRequest("generate", { length: 11 }, "https://signup.example.com"),
      /12 to 128/,
    );
    await assert.rejects(
      context.vault.handleRequest("generate", { length: 129 }, "https://signup.example.com"),
      /12 to 128/,
    );

    const original = {
      message: `password=${explicitSecret}; token=${fieldSecret}; generated=${generated.secret}`,
      nested: [{ value: explicitSecret }],
      [fieldSecret]: generated.secret,
    };
    const redacted = context.vault.redact(original);
    const redactedText = JSON.stringify(redacted);
    for (const secret of [explicitSecret, fieldSecret, generated.secret]) {
      assert.ok(!redactedText.includes(secret));
    }
    assert.match(redactedText, /REDACTED_PASSWORD/);
    assert.ok(original.message.includes(explicitSecret), "redaction does not mutate its input");
    assert.ok(!context.vault.redact("prefix:x:suffix").includes("x"));
    assert.equal(
      context.vault.redact("password123"),
      "[REDACTED_PASSWORD]",
      "longer overlapping secrets are replaced first",
    );
  } finally {
    await context.cleanup();
  }
});

test("redaction saturation fails closed without evicting older secrets", async () => {
  const context = await fixture();
  const fields = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `field-${index}`,
      `capacity-secret-${String(index).padStart(3, "0")}`,
    ]),
  );
  try {
    await context.vault.handleRequest(
      "save",
      { category: "secure-note", fields },
      EXAMPLE,
    );
    const first = fields["field-0"];
    const last = fields["field-255"];
    assert.ok(!JSON.stringify(context.vault.redact({ first, last })).includes(first));
    assert.ok(!JSON.stringify(context.vault.redact({ first, last })).includes(last));

    await assert.rejects(
      context.vault.handleRequest(
        "save",
        { category: "secure-note", fields: { next: "capacity-secret-next" } },
        EXAMPLE,
      ),
      (error) =>
        error instanceof LocalCredentialVaultError &&
        error.code === "VAULT_SECRET_CAPACITY",
    );
    assert.ok(!context.vault.redact(`still:${first}`).includes(first));

    context.vault.resetRedactionSecrets();
    const saved = await context.vault.handleRequest(
      "save",
      { category: "secure-note", fields: { next: "capacity-secret-next" } },
      EXAMPLE,
    );
    assert.equal(saved.category, "secure-note");
  } finally {
    await context.cleanup();
  }
});

test("deferToPending suppresses a capture that duplicates the generated secret", async () => {
  const context = await fixture();
  try {
    // The two-phase flow: generate types this secret into the page, and the
    // capture sensor then observes the same accepted submission.
    const generated = await context.vault.handleRequest(
      "generate",
      { username: "signup@example.com" },
      EXAMPLE,
    );

    const result = await context.vault.handleRequest(
      "save",
      {
        username: "signup@example.com",
        password: generated.secret,
        deferToPending: true,
        matchMode: "base-domain",
      },
      EXAMPLE,
    );
    assert.equal(result.deferred, true, "the in-flight generation owns this value");
    assert.equal(result.pendingId, generated.pendingId);

    // No duplicate record was written: only the pending exists.
    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);
    assert.equal(listed.credentials.length, 0);
  } finally {
    await context.cleanup();
  }
});

test("deferToPending still saves a DIFFERENT password typed during the pending window", async () => {
  const context = await fixture();
  try {
    // A generated fill that failed and was retried by hand: the submitted
    // password is not the generated secret, so it must be saved, not dropped.
    await context.vault.handleRequest("generate", { username: "user@example.com" }, EXAMPLE);

    const result = await context.vault.handleRequest(
      "save",
      {
        username: "user@example.com",
        password: "a-different-password-typed-by-hand",
        deferToPending: true,
        matchMode: "base-domain",
      },
      EXAMPLE,
    );
    assert.notEqual(result.deferred, true, "a different password is not the generation's");

    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);
    assert.equal(listed.credentials.length, 1);

    // And it is retrievable to its owner — the loss this fix prevents.
    const owned = createLocalCredentialVault(context.dir);
    const revealed = await owned.ownerReveal(listed.credentials[0].id);
    assert.equal(revealed.secret, "a-different-password-typed-by-hand");
  } finally {
    await context.cleanup();
  }
});

test("deferToPending saves normally when no generation is in flight", async () => {
  const context = await fixture();
  try {
    const result = await context.vault.handleRequest(
      "save",
      {
        username: "plain@example.com",
        password: "ordinary-login",
        deferToPending: true,
        matchMode: "base-domain",
      },
      EXAMPLE,
    );
    assert.notEqual(result.deferred, true);
    const listed = await context.vault.handleRequest("list", {}, EXAMPLE);
    assert.equal(listed.credentials.length, 1);
  } finally {
    await context.cleanup();
  }
});
