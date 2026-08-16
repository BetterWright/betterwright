// Skill packs: per-site and per-provider operational knowledge an agent loads
// on demand, instead of one static prompt trying to carry everything.
//
// A skill is a directory holding a SKILL.md with YAML-ish frontmatter:
//
//     ---
//     name: 1password
//     description: Read this when the profile has the 1Password extension.
//     siteSpecific: true
//     autoInject:
//       keywords: ["login", "sign in"]
//       url: ["github.com", "*.atlassian.net/jira/**"]
//     ---
//
// `description` is the primary activation signal; `autoInject.url` patterns
// let consumers hint a matching skill when the browser lands on a site, and
// `autoInject.keywords` match against task text. Packaged skills live in the
// npm package's `skills/`; user-authored packs in `$BETTERWRIGHT_HOME/skills`
// override packaged ones by name. SKILL.md stays short and links sibling
// reference files for progressive disclosure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isString } from "./untrusted-value.js";

const PACKAGED_SKILLS_DIR = fileURLToPath(
  new URL("../../skills/", import.meta.url),
);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILL_CHARS = 64_000;

function defaultUserSkillsDir() {
  const home = (process.env.BETTERWRIGHT_HOME || "").trim();
  return path.join(home || path.join(os.homedir(), ".betterwright"), "skills");
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseStringArray(raw, field) {
  let parsed;
  try {
    // Accept a JSON array as-is (handles apostrophes inside double-quoted
    // strings); fall back to single-quoted YAML arrays only when there are no
    // double quotes to preserve.
    parsed = JSON.parse(raw.includes('"') ? raw : raw.replaceAll("'", '"'));
  } catch {
    throw new Error(`Skill frontmatter field ${field} must be a JSON-style array.`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => !isString(item))) {
    throw new Error(`Skill frontmatter field ${field} must be an array of strings.`);
  }
  return parsed.map((item) => item.trim()).filter(Boolean);
}

/**
 * Parse a SKILL.md document into `{name, description, siteSpecific,
 * autoInject: {keywords, url}, body}`. Only the small frontmatter subset the
 * loader understands is accepted; unknown keys are ignored so packs stay
 * forward-compatible.
 */
export function parseSkillDocument(text) {
  const source = String(text).replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) throw new Error("SKILL.md must start with a --- frontmatter block.");
  const meta = {
    name: "",
    description: "",
    siteSpecific: false,
    autoInject: { keywords: [], url: [] },
  };
  let inAutoInject = false;
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (!indented) inAutoInject = false;
    const pair = /^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (!indented && key === "autoInject" && !rawValue.trim()) {
      inAutoInject = true;
      continue;
    }
    if (inAutoInject && indented) {
      if (key === "keywords")
        meta.autoInject.keywords = parseStringArray(rawValue, "autoInject.keywords");
      if (key === "url")
        meta.autoInject.url = parseStringArray(rawValue, "autoInject.url");
      continue;
    }
    if (key === "name") meta.name = String(parseScalar(rawValue));
    if (key === "description") meta.description = String(parseScalar(rawValue));
    if (key === "siteSpecific") meta.siteSpecific = parseScalar(rawValue) === true;
  }
  if (!NAME_PATTERN.test(meta.name)) {
    throw new Error(`Skill name "${meta.name}" must be lowercase-hyphen-case.`);
  }
  if (!meta.description) throw new Error(`Skill "${meta.name}" needs a description.`);
  return { ...meta, body: source.slice(match[0].length) };
}

function parseSkillEntry(text, file, dirName, source) {
  const parsed = parseSkillDocument(text.slice(0, MAX_SKILL_CHARS));
  if (parsed.name !== dirName) {
    throw new Error(
      `Skill name "${parsed.name}" must match its directory "${dirName}".`,
    );
  }
  return { ...parsed, path: file, source };
}

function readSkillDirectory(dir, source) {
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      skills.push(parseSkillEntry(text, file, entry.name, source));
    } catch (error) {
      // A malformed pack must not take down every consumer; surface it as a
      // broken entry so `skills list` can show the reason.
      skills.push({
        name: entry.name,
        description: "",
        siteSpecific: false,
        autoInject: { keywords: [], url: [] },
        body: "",
        path: file,
        source,
        error: error?.message || String(error),
      });
    }
  }
  return skills;
}

/**
 * Enumerate available skills: packaged packs plus user packs from
 * `$BETTERWRIGHT_HOME/skills` (user packs override packaged ones by name).
 * Returns metadata only; use {@link readSkill} for a pack's body.
 */
export function listSkills({ userDir = defaultUserSkillsDir() } = {}) {
  const byName = new Map();
  for (const skill of readSkillDirectory(PACKAGED_SKILLS_DIR, "packaged"))
    byName.set(skill.name, skill);
  for (const skill of readSkillDirectory(userDir, "user"))
    byName.set(skill.name, skill);
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ body: _body, ...meta }) => meta);
}

/** Read one skill (metadata plus full body) by name. */
export function readSkill(name, { userDir = defaultUserSkillsDir() } = {}) {
  const wanted = String(name || "").trim();
  if (!NAME_PATTERN.test(wanted)) throw new Error(`Unknown skill "${name}".`);
  for (const [dir, source] of [
    [userDir, "user"],
    [PACKAGED_SKILLS_DIR, "packaged"],
  ]) {
    const file = path.join(dir, wanted, "SKILL.md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    return parseSkillEntry(text, file, wanted, source);
  }
  throw new Error(`Unknown skill "${name}".`);
}

function hostMatches(host, pattern) {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return (
    host === pattern || host === `www.${pattern}` || `www.${host}` === pattern
  );
}

function pathMatches(pathname, pattern) {
  if (!pattern) return true;
  const escaped = pattern
    // A raw NUL never appears in a legitimate URL pattern, but it would
    // forge the "**" sentinel below and smuggle an unintended ".*" into
    // the regex, so it is dropped before anything else.
    .replaceAll("\u0000", "")
    .replace(/[.+^${}()|?[\]\\]/g, "\\$&")
    // "**" is parked on a NUL sentinel so the single-star replacement
    // cannot see it, then cashed out as ".*" afterwards.
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  // `/foo/**` should also match `/foo` itself.
  const optionalTail = escaped.endsWith("/.*")
    ? `${escaped.slice(0, -3)}(?:/.*)?`
    : escaped;
  return new RegExp(`^${optionalTail}$`).test(pathname);
}

/** Does one autoInject url pattern (host or host/path glob) match a URL? */
export function urlPatternMatches(url, pattern) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const cleaned = String(pattern).trim().replace(/^https?:\/\//, "");
  if (!cleaned) return false;
  const slash = cleaned.indexOf("/");
  const hostPattern = (slash === -1 ? cleaned : cleaned.slice(0, slash)).toLowerCase();
  const pathPattern = slash === -1 ? "" : cleaned.slice(slash);
  return (
    hostMatches(parsed.hostname.toLowerCase(), hostPattern) &&
    pathMatches(parsed.pathname, pathPattern)
  );
}

/** Skills whose autoInject.url patterns match `url`. */
export function matchSkillsForUrl(url, skills = listSkills()) {
  return skills.filter(
    (skill) =>
      !skill.error &&
      skill.autoInject.url.some((pattern) => urlPatternMatches(url, pattern)),
  );
}

/** Skills whose autoInject.keywords appear (case-insensitive) in `text`. */
export function matchSkillsForText(text, skills = listSkills()) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return [];
  return skills.filter(
    (skill) =>
      !skill.error &&
      skill.autoInject.keywords.some((keyword) =>
        haystack.includes(keyword.toLowerCase()),
      ),
  );
}

/**
 * Hints for a run result: `{name, description, path}` for each skill matching
 * any open page's URL. Consumers attach these so the agent knows a deeper pack
 * exists — and where to read it — before improvising site-specific behavior.
 */
export function skillHintsForPages(pages, { skills = listSkills() } = {}) {
  const matched = new Map();
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const skill of matchSkillsForUrl(page?.url, skills)) {
      matched.set(skill.name, {
        name: skill.name,
        description: skill.description,
        path: skill.path,
      });
    }
  }
  return [...matched.values()];
}
