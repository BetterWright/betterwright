// The owner-only vault surface (`betterwright vault`) and its reveal gate.
//
// The property that matters most here is negative: the owner methods must stay
// unreachable from `handleRequest`, which is the only entry point the worker
// RPC — and therefore model-authored browser code — can address.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { positionalArgs } from "../../dist/src/cli-flags.js";
import { createLocalCredentialVault } from "../../dist/src/vault.js";
import {
  copyToClipboard,
  resolveCredentialId,
  revealAllowed,
  runVaultCommand,
} from "../../dist/src/vault-cli.js";

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-vault-owner-"));
  test.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function seed(home) {
  const vault = createLocalCredentialVault({ home });
  const github = await vault.handleRequest(
    "save",
    { username: "ada@example.com", password: "gh-secret-value", label: "work" },
    "https://github.com/login",
  );
  const mail = await vault.handleRequest(
    "save",
    { username: "ada@example.com", password: "mail-secret-value", label: "mail" },
    "https://mail.example.com/",
  );
  return { vault, github, mail };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

test("owner list returns every record regardless of the current site", async () => {
  const home = tempHome();
  const { vault } = await seed(home);

  const { credentials } = await vault.ownerList();
  assert.equal(credentials.length, 2);
  assert.deepEqual(
    credentials.map((entry) => entry.origin).sort(),
    ["https://github.com", "https://mail.example.com"],
  );
  // Metadata only: listing must never carry a secret.
  for (const entry of credentials) {
    assert.equal(Object.hasOwn(entry, "password"), false);
    assert.equal(Object.hasOwn(entry, "secret"), false);
  }
});

test("owner list filters by query and category", async () => {
  const home = tempHome();
  const { vault } = await seed(home);

  assert.equal((await vault.ownerList({ query: "github" })).credentials.length, 1);
  assert.equal((await vault.ownerList({ query: "nothing-here" })).credentials.length, 0);
  assert.equal((await vault.ownerList({ category: "login" })).credentials.length, 2);
  assert.equal((await vault.ownerList({ category: "ssh-key" })).credentials.length, 0);
});

test("owner list filters uncommitted signups too, not just committed records", async () => {
  const home = tempHome();
  const { vault } = await seed(home);
  await vault.handleRequest("generate", { username: "ada@example.com" }, "https://reddit.com/");

  // A filtered list that still shows every pending is a lie about its own
  // filter: the reader takes the pending as a match for what they searched.
  const alpha = await vault.ownerList({ query: "github" });
  assert.equal(alpha.credentials.length, 1);
  assert.deepEqual(alpha.pendingCredentials, []);

  const reddit = await vault.ownerList({ query: "reddit" });
  assert.equal(reddit.credentials.length, 0);
  assert.equal(reddit.pendingCredentials.length, 1);
  assert.match(reddit.pendingCredentials[0].origin, /reddit\.com/);
  assert.ok(!("secret" in reddit.pendingCredentials[0]));

  // A pending is always an in-flight login, so any other category excludes it.
  assert.equal((await vault.ownerList({ category: "login" })).pendingCredentials.length, 1);
  assert.equal((await vault.ownerList({ category: "ssh-key" })).pendingCredentials.length, 0);
});

test("owner reveal returns the stored secret and audits the read", async () => {
  const home = tempHome();
  const { vault, github } = await seed(home);

  const revealed = await vault.ownerReveal(github.id);
  assert.equal(revealed.secret, "gh-secret-value");
  assert.equal(revealed.username, "ada@example.com");
  assert.equal(revealed.pending, false);

  const { entries } = await vault.ownerAudit({ limit: 10 });
  const reveal = entries.find((entry) => entry.action === "owner-reveal");
  assert.ok(reveal, "the reveal is recorded in the audit log");
  assert.equal(reveal.id, github.id);
  assert.equal(reveal.origin, "https://github.com");
  // The audit log stays metadata-only even for a read that exposed plaintext.
  assert.equal(JSON.stringify(entries).includes("gh-secret-value"), false);
});

test("owner reveal rejects an unknown id", async () => {
  const home = tempHome();
  const { vault } = await seed(home);
  await assert.rejects(() => vault.ownerReveal("cred_does-not-exist"), /No credential with id/);
});

test("owner remove deletes a record the site-scoped path could not reach", async () => {
  const home = tempHome();
  const vault = createLocalCredentialVault({ home });
  const saved = await vault.handleRequest(
    "save",
    { username: "ada", password: "x", matchMode: "never" },
    "https://gone.example/",
  );

  // `matchMode: never` keeps the record out of site-scoped listing entirely.
  const scoped = await vault.handleRequest("list", {}, "https://gone.example/");
  assert.equal(scoped.credentials.length, 0);

  const removed = await vault.ownerRemove(saved.id);
  assert.equal(removed.removed, true);
  assert.equal((await vault.ownerList()).credentials.length, 0);
});

test("owner methods are not reachable through the worker RPC", async () => {
  const home = tempHome();
  const { vault, github } = await seed(home);

  for (const action of [
    "ownerReveal",
    "owner-reveal",
    "reveal",
    "ownerList",
    "owner-list",
    "ownerRemove",
    "ownerAudit",
  ]) {
    await assert.rejects(
      () => vault.handleRequest(action, { id: github.id }, "https://github.com/"),
      /Unsupported credential vault action/,
      `handleRequest must refuse "${action}"`,
    );
  }
});

test("reveal is refused when stdout is not a terminal", () => {
  assert.equal(revealAllowed({ isTTY: true, env: {} }).ok, true);

  const piped = revealAllowed({ isTTY: false, env: {} });
  assert.equal(piped.ok, false);
  assert.match(piped.error, /not a terminal/);
  assert.match(piped.error, /vault copy/);

  assert.equal(revealAllowed({ isTTY: false, force: true, env: {} }).ok, true);
  assert.equal(
    revealAllowed({ isTTY: false, env: { BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE: "1" } }).ok,
    true,
  );
});

test("id prefixes resolve, and an exact id beats a longer neighbour", () => {
  const entries = [{ id: "cred_abc" }, { id: "cred_abcdef" }, { id: "cred_zzz" }];

  assert.equal(resolveCredentialId(entries, "cred_zzz"), "cred_zzz");
  assert.equal(resolveCredentialId(entries, "cred_z"), "cred_zzz");
  // "cred_abc" is a prefix of "cred_abcdef", but it is also an exact id.
  assert.equal(resolveCredentialId(entries, "cred_abc"), "cred_abc");
  assert.throws(() => resolveCredentialId(entries, "cred_ab"), /ambiguous/);
  assert.throws(() => resolveCredentialId(entries, "nope"), /No credential id/);
  assert.throws(() => resolveCredentialId(entries, ""), /An id is required/);

  // Production always passes `[...credentials, ...pendingCredentials]`, where a
  // pending entry has `pendingId` and no `id`. That branch must resolve too —
  // it is what `vault show pending_…` runs.
  const mixed = [{ id: "cred_abc" }, { pendingId: "pending_9f2a" }];
  assert.equal(resolveCredentialId(mixed, "pending_9f2a"), "pending_9f2a");
  assert.equal(resolveCredentialId(mixed, "pending_"), "pending_9f2a");
  assert.equal(resolveCredentialId(mixed, "cred_abc"), "cred_abc");
});

test("clipboard copy reports a usable error when no tool exists", async () => {
  // Inject a spawn that always fails, so the failure path is exercised
  // deterministically and no real clipboard tool runs (which would both make
  // the assertions conditional and leave a test secret on the CI clipboard).
  const failingSpawn = () => {
    const child = new EventEmitter();
    child.stdin = { end() {} };
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
  const result = await copyToClipboard("secret", { platform: "linux", spawn: failingSpawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /wl-copy|xclip|xsel/);
  assert.match(result.error, /vault show/);
});

test("vault list prints metadata and never a stored secret", async () => {
  const home = tempHome();
  await seed(home);
  const io = capture();

  assert.equal(await runVaultCommand(["list"], { home, ...io }), 0);
  assert.match(io.stdout, /github\.com/);
  assert.match(io.stdout, /ada@example\.com/);
  assert.equal(io.stdout.includes("gh-secret-value"), false);
  assert.equal(io.stdout.includes("mail-secret-value"), false);
});

test("vault show hides the password until --reveal", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const hidden = capture();

  assert.equal(await runVaultCommand(["show", github.id], { home, ...hidden }), 0);
  assert.match(hidden.stdout, /\(hidden\)/);
  assert.equal(hidden.stdout.includes("gh-secret-value"), false);

  // --reveal from a test process (no TTY) must fail closed rather than print.
  const piped = capture();
  assert.equal(await runVaultCommand(["show", github.id, "--reveal"], { home, ...piped }), 1);
  assert.equal(piped.stdout.includes("gh-secret-value"), false);
  assert.match(piped.stderr, /not a terminal/);

  const forced = capture();
  assert.equal(
    await runVaultCommand(["show", github.id, "--reveal", "--force"], { home, ...forced }),
    0,
  );
  assert.match(forced.stdout, /gh-secret-value/);
});

test("the `get` alias is gated exactly like `show --reveal`", async () => {
  const home = tempHome();
  const { github } = await seed(home);

  // `get` used to skip the non-terminal reveal gate entirely, so
  // `vault get <id> --reveal > file` printed the secret. It must fail closed.
  const piped = capture();
  assert.equal(await runVaultCommand(["get", github.id, "--reveal"], { home, ...piped }), 1);
  assert.equal(piped.stdout.includes("gh-secret-value"), false);
  assert.match(piped.stderr, /not a terminal/);

  // Including the --json spelling, which is the one a script would reach for.
  const jsonPiped = capture();
  assert.equal(
    await runVaultCommand(["get", github.id, "--reveal", "--json"], { home, ...jsonPiped }),
    1,
  );
  assert.equal(jsonPiped.stdout.includes("gh-secret-value"), false);
});

test("show --json without --reveal omits the secret", async () => {
  const home = tempHome();
  const { github } = await seed(home);
  const io = capture();

  assert.equal(await runVaultCommand(["show", github.id, "--json"], { home, ...io }), 0);
  const parsed = JSON.parse(io.stdout);
  assert.equal(parsed.id, github.id);
  assert.equal("secret" in parsed, false, "metadata-only JSON must not carry the secret");
  assert.equal(io.stdout.includes("gh-secret-value"), false);
});

test("vault rm needs confirmation it cannot get without a terminal", async () => {
  const home = tempHome();
  const { github, vault } = await seed(home);
  const refused = capture();

  assert.equal(await runVaultCommand(["rm", github.id], { home, ...refused }), 1);
  // "could not ask" and "you said no" are different failures; a caller with no
  // terminal must be told which one it hit, and how to proceed.
  assert.match(refused.stderr, /no terminal here to ask/);
  assert.match(refused.stderr, /--yes/);
  assert.match(refused.stderr, /github\.com/);
  assert.equal((await vault.ownerList()).credentials.length, 2);

  const confirmed = capture();
  assert.equal(await runVaultCommand(["rm", github.id, "--yes"], { home, ...confirmed }), 0);
  assert.equal((await vault.ownerList()).credentials.length, 1);
});

test("vault list on an empty vault explains itself instead of printing nothing", async () => {
  const home = tempHome();
  const io = capture();

  assert.equal(await runVaultCommand(["list"], { home, ...io }), 0);
  assert.match(io.stdout, /empty/i);
  assert.match(io.stdout, /Save password/);
  // Listing an empty vault must not create one.
  assert.equal(fs.existsSync(path.join(home, "vault", "vault.enc")), false);
});

test("vault rejects an unknown subcommand with its usage", async () => {
  const home = tempHome();
  const io = capture();

  assert.equal(await runVaultCommand(["frobnicate"], { home, ...io }), 1);
  assert.match(io.stderr, /Unknown vault command/);
  assert.match(io.stderr, /betterwright vault/);
});

test("value-flag arguments are not mistaken for positionals", () => {
  assert.deepEqual(positionalArgs(["list", "--query", "github"]), ["list"]);
  assert.deepEqual(positionalArgs(["show", "cred_1", "--reveal"]), ["show", "cred_1"]);
  assert.deepEqual(positionalArgs(["list", "--query=github"]), ["list"]);
  assert.deepEqual(positionalArgs(["audit", "--limit", "5"]), ["audit"]);
});

test("a mistyped flag reads as a mistake, not a crash", async () => {
  const home = tempHome();
  await seed(home);
  const io = capture();

  assert.equal(await runVaultCommand(["list", "--category", "nonsense"], { home, ...io }), 1);
  assert.match(io.stderr, /Unsupported credential category/);
  assert.match(io.stderr, /Valid categories: login, credit-card/);
  assert.doesNotMatch(io.stderr, /at LocalCredentialVault/, "no stack trace");
});

test("a vault missing its key explains the consequence", async () => {
  const home = tempHome();
  await seed(home);
  fs.rmSync(path.join(home, "vault", "vault.key"));
  const io = capture();

  assert.equal(await runVaultCommand(["list"], { home, ...io }), 1);
  assert.match(io.stderr, /key is missing/);
  assert.match(io.stderr, /unrecoverable without it/);
});

test("corrupted ciphertext fails with a plain sentence", async () => {
  const home = tempHome();
  await seed(home);
  fs.writeFileSync(path.join(home, "vault", "vault.enc"), "garbage");
  const io = capture();

  assert.equal(await runVaultCommand(["list"], { home, ...io }), 1);
  assert.match(io.stderr, /corrupted or its key does not match/);
});

test("`vault path` names the key as the thing to back up", async () => {
  const home = tempHome();
  const io = capture();

  assert.equal(await runVaultCommand(["path"], { home, ...io }), 0);
  assert.match(io.stdout, /vault\.key/);
  assert.match(io.stdout, /back this up/);
});
