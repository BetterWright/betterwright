// On-disk transcript persistence for `betterwright exec` sessions.
//
// Each `--session` name gets `<home>/sessions/<name>/transcript.json`. The
// next exec in the same session loads it as `history`, so the agent genuinely
// remembers earlier tasks — the resume half of session persistence (the
// daemon holds the browser half).
//
// A named browser profile keeps its own set under `<home>/sessions/@<profile>/`.
// A profile is a separate identity, and an exec transcript quotes the pages it
// visited while signed in as that identity, so it must never resume into
// another one — two profiles both using the default session name would
// otherwise share one history file. The `@` prefix cannot collide with a
// session directory: sanitized session names always start with a letter or
// digit.
//
// Saved transcripts are elided, not summarized: stale browser observations
// (page snapshots, by far the bulk of a browsing transcript) are replaced
// with a one-line stub, because the live page — still open in the session
// daemon — is the source of truth. Actions, reasoning, answers, and small
// results are kept verbatim. The result is O(actions), not O(observations),
// and byte-identical across loads, which is the ideal prompt-caching shape.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultDaemonHome, sessionName } from "./daemon.js";
import { mkdirPrivate, writePrivate } from "./fs-private.js";
import { resolveProfileName } from "./profile-name.js";

const STORE_VERSION = 1;
const KEEP_RECENT_BROWSER_RESULTS = 2;
const ELIDE_OVER_CHARS = 600;
const DEFAULT_MAX_SAVED_CHARS = 150_000;
export const ELIDED_OBSERVATION =
  "[stale browser output elided from the resumed session — the session's browser is still live; take a fresh snapshot instead of trusting this]";

const ROLES = new Set(["user", "assistant", "tool"]);

function storeDir(home, session, profile?: unknown) {
  const name = sessionName(session);
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    ? name
    : `h-${crypto.createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
  const root = path.join(home || defaultDaemonHome(), "sessions");
  const resolved = resolveProfileName(profile);
  // The default profile keeps `sessions/<name>` exactly as before, so an
  // upgraded install resumes the transcripts it already has.
  return resolved === null ? path.join(root, safe) : path.join(root, `@${resolved}`, safe);
}

export function transcriptPath(home, session, profile?: unknown) {
  return path.join(storeDir(home, session, profile), "transcript.json");
}

function validMessage(message) {
  return (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    ROLES.has(message.role)
  );
}

/**
 * Elide stale browser observations and cap total size. Pure — returns a new
 * array, never mutates the input.
 *
 * Rules:
 *  - The most recent `keepRecentBrowser` browser-tool results stay verbatim
 *    (they describe the state the session's live pages are still in).
 *  - Older browser results longer than `elideOverChars` become the stub.
 *  - If the serialized whole still exceeds `maxChars`, whole messages drop
 *    from the front — never splitting an assistant/tool pair, and always
 *    leaving a `user` message first so every model adapter accepts the shape.
 */
export function elideTranscript(messages, options: any = {}) {
  const keepRecent = options.keepRecentBrowser ?? KEEP_RECENT_BROWSER_RESULTS;
  const elideOver = options.elideOverChars ?? ELIDE_OVER_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_SAVED_CHARS;
  const input = (Array.isArray(messages) ? messages : []).filter(validMessage);

  // Walk backwards so the last N browser results are identified first.
  let seenBrowserResults = 0;
  const elided = [...input]
    .reverse()
    .map((message) => {
      if (message.role !== "tool" || !Array.isArray(message.results)) return message;
      let changed = false;
      const results = [...message.results]
        .reverse()
        .map((result) => {
          if (result?.name !== "browser") return result;
          seenBrowserResults += 1;
          const content = String(result.content ?? "");
          if (seenBrowserResults <= keepRecent || content.length <= elideOver)
            return result;
          changed = true;
          return { ...result, content: ELIDED_OBSERVATION };
        })
        .reverse();
      return changed ? { ...message, results } : message;
    })
    .reverse();

  while (elided.length && JSON.stringify(elided).length > maxChars) {
    elided.shift();
    while (elided.length && elided[0].role !== "user") elided.shift();
  }
  while (elided.length && elided[0].role !== "user") elided.shift();
  return elided;
}

/** Load the saved transcript for a session, or [] when absent/invalid. */
export function loadTranscript(home, session, profile?: unknown) {
  try {
    const raw = fs.readFileSync(transcriptPath(home, session, profile), "utf8");
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed : parsed?.messages;
    if (!Array.isArray(messages)) return [];
    return messages.filter(validMessage);
  } catch {
    return [];
  }
}

/** Elide and persist a transcript (atomic write, private permissions). */
export function saveTranscript(home, session, messages, options: any = {}, profile?: unknown) {
  const dir = storeDir(home, session, profile);
  mkdirPrivate(dir);
  const file = transcriptPath(home, session, profile);
  const payload = JSON.stringify({
    version: STORE_VERSION,
    session: sessionName(session),
    ...(resolveProfileName(profile) ? { profile: resolveProfileName(profile) } : {}),
    savedAt: new Date().toISOString(),
    messages: elideTranscript(messages, options),
  });
  // Write private *before* the rename: the transcript is owner-only from the
  // moment it exists, with no window where it is readable under its final name.
  const tmp = `${file}.tmp-${process.pid}`;
  writePrivate(tmp, payload);
  fs.renameSync(tmp, file);
  return file;
}

/** Forget a session's saved transcript (used by `exec --fresh`). */
export function clearTranscript(home, session, profile?: unknown) {
  try {
    fs.rmSync(transcriptPath(home, session, profile), { force: true });
  } catch {
    /* best effort */
  }
}
