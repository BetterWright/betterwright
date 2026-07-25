// `betterwright vault` — the human-facing view of the credential vault.
//
// Everything else that touches the vault is agent-facing and site-scoped: the
// worker RPC only ever answers for the origin the browser is currently on, and
// it never returns a secret. That is right for model-authored code and wrong
// for the person who owns the files, who otherwise cannot get back a password
// their agent generated during a signup or captured from a login they typed.
//
// So this command talks to the vault's owner-only API (see the "Owner-only
// local access" block in vault.mjs) rather than `handleRequest`, and gates the
// one operation that puts plaintext on a terminal:
//
//   - metadata by default; printing a secret needs an explicit `--reveal`
//   - `--reveal` to anything but a terminal needs `--force` on top, so a
//     redirect into a file, a pipe, or an agent's captured stdout fails closed
//   - `vault copy` is the recommended path: the secret goes to the clipboard
//     and never enters scrollback or shell history at all
//   - every reveal is written to the metadata-only audit log

import { spawn } from "node:child_process";

import { flagValue, positionalArgs } from "./cli-flags.mjs";
import { wantsHelp } from "./cli-help.mjs";
import { defaultHome } from "./home.mjs";
import { createLocalCredentialVault } from "./vault.mjs";

const REVEAL_ESCAPE_HATCH = "BETTERWRIGHT_VAULT_ALLOW_NON_INTERACTIVE";

export const VAULT_USAGE = `Usage: betterwright vault <command>

  list [--query <text>] [--category <c>]   saved credentials (metadata only)
  show <id> [--reveal]                     one credential; --reveal prints the password
  copy <id>                                copy the password to the clipboard
  rm <id> [--yes]                          delete one credential
  audit [--limit <n>]                      recent vault activity (metadata only)
  path                                     where the encrypted files live

Options: --json  machine-readable output
         --force allow --reveal when stdout is not a terminal

Categories: login (default), credit-card, identity, api-credential,
            secure-note, ssh-key.

Ids come from \`betterwright vault list\`; a prefix is enough when unambiguous.`;

/** Copy text to the system clipboard without it ever reaching stdout. */
export async function copyToClipboard(text, { platform = process.platform } = {}) {
  const candidates =
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
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
        );
        child.stdin.end(text);
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
export async function runVaultCommand(rest = [], io = {}) {
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
            entry.id.slice(0, 8),
            site(entry.origin),
            entry.username || "—",
            entry.category,
            shortDate(entry.updatedAt || entry.createdAt),
          ]),
        ]),
      );
    }
    if (pendingCredentials.length) {
      log("");
      log(`${pendingCredentials.length} uncommitted signup password(s) — a signup that never confirmed:`);
      log(
        column(
          pendingCredentials.map((entry) => [
            `  ${entry.pendingId.slice(0, 8)}`,
            site(entry.origin),
            entry.username || "—",
            entry.expired ? "expired" : "pending",
          ]),
        ),
      );
    }
    log("");
    log(
      `${credentials.length} credential(s). \`betterwright vault copy <id>\` puts a password on the clipboard; ` +
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
      const entry =
        credentials.find((candidate) => candidate.id === id) ||
        pendingCredentials.find((candidate) => candidate.pendingId === id);
      if (json) {
        log(JSON.stringify(entry, null, 2));
        return 0;
      }
      log(
        column([
          ["id", entry.id || entry.pendingId],
          ["site", entry.origin],
          ["username", entry.username || "—"],
          ["label", entry.label || "—"],
          ["category", entry.category],
          ["match", entry.matchMode],
          ["created", entry.createdAt],
          ["updated", entry.updatedAt || entry.createdAt],
          ["password", "(hidden)"],
        ]),
      );
      log("");
      log("Add --reveal to print the password, or `betterwright vault copy <id>` to");
      log("put it on the clipboard without it touching this terminal.");
      return 0;
    }

    if (subcommand === "show") {
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
        ["id", revealed.id || revealed.pendingId],
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
          entry.id ? String(entry.id).slice(0, 8) : "—",
        ]),
      ]),
    );
    return 0;
  }

  fail(`Unknown vault command "${subcommand}".\n\n${VAULT_USAGE}`);
  return 1;
}
