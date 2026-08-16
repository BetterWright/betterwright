// `betterwright vault` — the human-facing view of the credential vault.
//
// Everything else that touches the vault is agent-facing and site-scoped: the
// worker RPC only ever answers for the origin the browser is currently on, and
// it never returns a secret. That is right for model-authored code and wrong
// for the person who owns the files, who otherwise cannot get back a password
// their agent generated during a signup or captured from a login they typed.
//
// So this command talks to the vault's owner-only API (see the "Owner-only
// local access" block in vault.ts) rather than `handleRequest`, and gates the
// one operation that puts plaintext on a terminal:
//
//   - metadata by default; printing a secret needs an explicit `--reveal`
//   - `--reveal` to anything but a terminal needs `--force` on top, so a
//     redirect into a file, a pipe, or an agent's captured stdout fails closed
//   - `vault copy` is the recommended path: the secret goes to the clipboard
//     and never enters scrollback or shell history at all
//   - every reveal is written to the metadata-only audit log

import { spawn } from "node:child_process";

import { flagValue, positionalArgs } from "./cli-flags.js";
import { wantsHelp } from "./cli-help.js";
import { defaultHome } from "./home.js";
import { createLocalCredentialVault, VAULT_CATEGORIES } from "./vault.js";

const REVEAL_ESCAPE_HATCH = "BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE";

export const VAULT_USAGE = `Usage: betterwright vault <command>

  list [--query <text>] [--category <c>]   saved credentials (metadata only)
  show <id> [--reveal]                     one credential; --reveal prints the password
  get <id>                                 alias for show
  copy <id>                                copy the password to the clipboard
  rm <id> [--yes]                          delete one credential
  audit [--limit <n>]                      recent vault activity (metadata only)
  path                                     where the encrypted files live

Options: --json  machine-readable output
         --force allow --reveal when stdout is not a terminal

Categories: login (default), credit-card, identity, api-credential,
            secure-note, ssh-key.

Ids come from \`betterwright vault list\`; a prefix is enough when unambiguous.`;

/**
 * Copy text to the system clipboard without it ever reaching stdout.
 * `spawn` is injectable so the no-tool failure path is testable without a
 * clipboard tool actually running (and writing a test secret to a real
 * clipboard) on whatever machine the tests happen to run on.
 */
export async function copyToClipboard(
  text,
  { platform = process.platform, spawn: spawnFn = spawn } = {},
) {
  const candidates: Array<[string, string[]]> =
    platform === "darwin"
      ? [["pbcopy", []]]
      : platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  let lastError = null;
  for (const [command, args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawnFn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
        );
        // SAFETY: the child is spawned with stdio[0] = "pipe" just above, so
        // stdin is always a writable stream, never null.
        (child.stdin as NonNullable<typeof child.stdin>).end(text);
      });
      return { ok: true, tool: command };
    } catch (error) {
      lastError = error;
    }
  }
  const tried = candidates.map(([command]) => command).join(", ");
  return {
    ok: false,
    error:
      `No clipboard tool worked (tried ${tried}${lastError ? `; last error: ${lastError.message}` : ""}). ` +
      (platform === "linux"
        ? "Install wl-clipboard or xclip, or use `vault show <id> --reveal`."
        : "Use `vault show <id> --reveal` instead."),
  };
}

/**
 * Resolve a possibly-abbreviated id against the stored records.
 * A full id always wins over a prefix so an exact match can never be
 * reported as ambiguous with something that merely starts the same way.
 */
export function resolveCredentialId(entries, wanted) {
  const query = String(wanted || "").trim();
  if (!query) throw new Error("An id is required. Run `betterwright vault list` to see them.");
  const ids = entries.map((entry) => entry.pendingId || entry.id);
  if (ids.includes(query)) return query;
  const matches = ids.filter((id) => id.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Id "${query}" is ambiguous (${matches.length} matches). Use more characters.`,
    );
  }
  throw new Error(`No credential id starts with "${query}". Run \`betterwright vault list\`.`);
}

/**
 * Enough of an id to type back, keeping the kind prefix.
 * A flat slice(0, 8) turned every `pending_<uuid>` into the bare word
 * "pending_", which identifies nothing.
 */
function shortId(id) {
  const value = String(id || "");
  const underscore = value.indexOf("_");
  return underscore === -1 ? value.slice(0, 8) : value.slice(0, underscore + 7);
}

function site(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin || "(unknown)";
  }
}

function shortDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "?";
}

function column(rows) {
  if (!rows.length) return "";
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => String(row[index] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1
            ? String(cell ?? "")
            : String(cell ?? "").padEnd(widths[index]),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Decide whether plaintext may be written to stdout.
 * A terminal is a person looking at the screen; anything else is a file, a
 * pipe, or a tool capturing output, where a leaked secret outlives the moment.
 */
export function revealAllowed({
  force = false,
  isTTY = Boolean(process.stdout.isTTY),
  env = process.env,
} = {}) {
  if (isTTY) return { ok: true };
  if (force || ["1", "true", "yes"].includes(String(env[REVEAL_ESCAPE_HATCH] || "").toLowerCase())) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "Refusing to print a password to something that is not a terminal — it would " +
      "end up in a file, a pipe, or an agent's captured output.\n" +
      "Use `betterwright vault copy <id>` to reach the clipboard instead, or pass " +
      `--force (or set ${REVEAL_ESCAPE_HATCH}=1) if you really mean to redirect it.`,
  };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * @param {string[]} rest tokens after `vault`
 * @param {{home?: string, log?: Function, error?: Function}} [io]
 */
export async function runVaultCommand(rest: any[] = [], io: any = {}) {
  const fail = io.error || ((line) => console.error(line));
  try {
    return await dispatchVaultCommand(rest, io);
  } catch (error) {
    // A mistyped flag should read like a mistyped flag, not like a crash. The
    // vault's own errors already say what went wrong in a sentence; the codes
    // that come from bad user input get the valid choices appended.
    fail(error?.message || String(error));
    if (error?.code === "BAD_INPUT" && /category/i.test(error.message || "")) {
      fail(`Valid categories: ${VAULT_CATEGORIES.join(", ")}.`);
    }
    if (error?.code === "VAULT_KEY_MISSING") {
      fail(
        "vault.key and vault.enc must be kept together — restore the key from your backup, " +
          "or delete both to start a new vault (the saved passwords are unrecoverable without it).",
      );
    }
    return 1;
  }
}

async function dispatchVaultCommand(rest, io) {
  const log = io.log || ((line) => console.log(line));
  const fail = io.error || ((line) => console.error(line));
  const flags = new Set(rest.filter((token) => token.startsWith("--")));
  const json = flags.has("--json");
  const positional = positionalArgs(rest);
  const [subcommand = "list", target] = positional;
  const vault = createLocalCredentialVault({ home: io.home || defaultHome() });

  if (wantsHelp(rest) || subcommand === "help") {
    log(VAULT_USAGE);
    return 0;
  }

  if (subcommand === "path") {
    if (json) {
      log(JSON.stringify({ directory: vault.dir, ...vault.paths }, null, 2));
      return 0;
    }
    log(vault.dir);
    log("  vault.enc    AES-256-GCM record table");
    log("  vault.key    the key that decrypts it — back this up with vault.enc, or lose both");
    log("  audit.jsonl  metadata-only activity log");
    return 0;
  }

  if (subcommand === "list") {
    const { credentials, pendingCredentials } = await vault.ownerList({
      query: flagValue(rest, "--query") || target || null,
      category: flagValue(rest, "--category") || null,
    });
    if (json) {
      log(JSON.stringify({ credentials, pendingCredentials }, null, 2));
      return 0;
    }
    if (!credentials.length && !pendingCredentials.length) {
      log("The vault is empty.");
      log("");
      log("It fills itself as you go: log in by hand in a headed window and answer");
      log("\"Save password?\", or let the agent sign up and commit the password it");
      log("generated. Nothing to do up front.");
      return 0;
    }
    if (credentials.length) {
      log(
        column([
          ["ID", "SITE", "USERNAME", "CATEGORY", "UPDATED"],
          ...credentials.map((entry) => [
            shortId(entry.id),
            site(entry.origin),
            entry.username || "—",
            entry.category,
            shortDate(entry.updatedAt || entry.createdAt),
          ]),
        ]),
      );
    }
    if (pendingCredentials.length) {
      if (credentials.length) log(""); // only a separator; nothing to separate from otherwise
      log(`${pendingCredentials.length} uncommitted signup password(s) — a signup that never confirmed:`);
      log(
        column(
          pendingCredentials.map((entry) => [
            `  ${shortId(entry.pendingId)}`,
            site(entry.origin),
            entry.username || "—",
            entry.expired ? "expired" : "pending",
          ]),
        ),
      );
    }
    log("");
    log(
      `${credentials.length} credential(s)${pendingCredentials.length ? `, ${pendingCredentials.length} uncommitted` : ""}. ` +
        "`betterwright vault copy <id>` puts a password on the clipboard; " +
        "`vault show <id> --reveal` prints it.",
    );
    return 0;
  }

  if (subcommand === "show" || subcommand === "get" || subcommand === "copy" || subcommand === "rm") {
    const { credentials, pendingCredentials } = await vault.ownerList();
    let id;
    try {
      id = resolveCredentialId([...credentials, ...pendingCredentials], target);
    } catch (error) {
      fail(error.message);
      return 1;
    }

    if (subcommand === "rm") {
      const entry =
        credentials.find((candidate) => candidate.id === id) ||
        pendingCredentials.find((candidate) => candidate.pendingId === id);
      if (!flags.has("--yes")) {
        // Separate "said no" from "could not be asked": without a terminal the
        // prompt never appears, and a bare "Nothing was deleted." reads like a
        // failure with no cause. Deleting a credential is not recoverable, so
        // the answer is still no — but say which no it is.
        if (!process.stdin.isTTY) {
          fail(
            `Refusing to delete the ${site(entry?.origin)} credential for ` +
              `${entry?.username || "(no username)"} without confirmation, and ` +
              "there is no terminal here to ask. Re-run with --yes if you are sure.",
          );
          return 1;
        }
        const ok = await confirm(
          `Delete the ${site(entry?.origin)} credential for ${entry?.username || "(no username)"}?`,
        );
        if (!ok) {
          fail("Nothing was deleted.");
          return 1;
        }
      }
      const removed = await vault.ownerRemove(id);
      if (json) {
        log(JSON.stringify(removed, null, 2));
        return 0;
      }
      log(`Deleted ${site(removed.origin)} (${removed.username || "no username"}).`);
      if (removed.auditWarning) fail(`  ! ${removed.auditWarning.message}`);
      return 0;
    }

    const wantsSecret = subcommand === "copy" || flags.has("--reveal");
    if (!wantsSecret) {
      const record = credentials.find((candidate) => candidate.id === id);
      const entry =
        record || pendingCredentials.find((candidate) => candidate.pendingId === id);
      if (json) {
        log(JSON.stringify(entry, null, 2));
        return 0;
      }
      log(
        column([
          // A rotation's pending entry also carries the `id` of the record it
          // will replace; echo back the id the user actually typed.
          ["id", record ? entry.id : entry.pendingId],
          ["site", entry.origin],
          ["username", entry.username || "—"],
          ["label", entry.label || "—"],
          ["category", entry.category],
          ["match", entry.matchMode],
          ["created", entry.createdAt],
          ["updated", record ? entry.updatedAt || entry.createdAt : "(uncommitted)"],
          ["password", "(hidden)"],
        ]),
      );
      log("");
      log("Add --reveal to print the password, or `betterwright vault copy <id>` to");
      log("put it on the clipboard without it touching this terminal.");
      return 0;
    }

    // Gate every path that puts plaintext on stdout. Keying this on the
    // subcommand name once let the `get` alias through: `vault get <id>
    // --reveal > creds.txt` printed the secret with no terminal and no
    // --force. `copy` is the sole exemption, and only because the secret
    // reaches the clipboard instead of stdout.
    if (subcommand !== "copy") {
      const gate = revealAllowed({ force: flags.has("--force") });
      if (!gate.ok) {
        fail(gate.error);
        return 1;
      }
    }

    const revealed = await vault.ownerReveal(id);
    if (revealed.secret == null) {
      fail("That entry has no stored password.");
      return 1;
    }

    if (subcommand === "copy") {
      const copied = await copyToClipboard(revealed.secret);
      if (!copied.ok) {
        fail(copied.error);
        return 1;
      }
      log(
        `Copied the ${site(revealed.origin)} password for ${revealed.username || "(no username)"} to the clipboard.`,
      );
      log("It stays there until you copy something else — clear it when you are done.");
      if (revealed.auditWarning) fail(`  ! ${revealed.auditWarning.message}`);
      return 0;
    }

    if (json) {
      log(JSON.stringify(revealed, null, 2));
      return 0;
    }
    log(
      column([
        ["id", revealed.pending ? revealed.pendingId : revealed.id],
        ["site", revealed.origin],
        ["username", revealed.username || "—"],
        ["password", revealed.secret],
        ...(revealed.notes ? [["notes", revealed.notes]] : []),
      ]),
    );
    if (revealed.pending) {
      log("");
      log("This is an uncommitted signup password: the account may not exist.");
    }
    if (revealed.auditWarning) fail(`  ! ${revealed.auditWarning.message}`);
    return 0;
  }

  if (subcommand === "audit") {
    const limit = Number(flagValue(rest, "--limit", 20)) || 20;
    const { entries } = await vault.ownerAudit({ limit });
    if (json) {
      log(JSON.stringify({ entries }, null, 2));
      return 0;
    }
    if (!entries.length) {
      log("No vault activity has been recorded yet.");
      return 0;
    }
    log(
      column([
        ["WHEN", "ACTION", "SITE", "ID"],
        ...entries.map((entry) => [
          String(entry.at || "").replace("T", " ").slice(0, 19),
          entry.action || "?",
          entry.origin ? site(entry.origin) : "—",
          entry.id ? shortId(entry.id) : "—",
        ]),
      ]),
    );
    return 0;
  }

  fail(`Unknown vault command "${subcommand}".\n\n${VAULT_USAGE}`);
  return 1;
}
