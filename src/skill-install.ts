// Install and refresh the host-agent skills that Claude Code, Cursor, and
// other agents load from their conventional skills directories.
//
// Two skills are managed:
//   - `browser` — operator guidance for driving BetterWright. Generated at
//     install time (preamble + agentSystemPrompt), never copied from a stale
//     vendored path.
//   - `full-stack-e2e-review` — a review playbook. Hosts keep only its name
//     and description in context; the body is loaded when the user asks for
//     an end-to-end review. No autoInject keywords, so the standalone browser
//     loop never pulls it in.
//
// There is intentionally no npm postinstall: that is forbidden by
// scripts/check-package.mjs and would surprise library consumers. Instead:
//   - `betterwright skill --install` writes known skill dirs (explicit)
//   - `refreshInstalledAgentSkills` rewrites managed files that already exist
//     and backfills the e2e-review skill next to an existing browser skill
//     (called from setup / update)
//   - `staleAgentSkillReport` tips the operator on doctor when versions drift
//     or the companion review skill is missing

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** @typedef {"claude" | "agents" | "cursor"} SkillInstallTargetId */

export const E2E_REVIEW_SKILL_NAME = "full-stack-e2e-review";
export const HOST_SKILL_NAMES = ["browser", E2E_REVIEW_SKILL_NAME];

/**
 * Conventional user skill destinations. Claude is the historical default;
 * `~/.agents/skills` is the open Agent Skills layout Cursor and others read.
 * Each host root receives one directory per managed skill.
 */
export const SKILL_INSTALL_TARGETS = [
  {
    id: "claude",
    label: "Claude Code",
    skillsRoot: path.join(".claude", "skills"),
    defaultInstall: true,
  },
  {
    id: "agents",
    label: "Agent Skills",
    skillsRoot: path.join(".agents", "skills"),
    defaultInstall: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    skillsRoot: path.join(".cursor", "skills"),
    defaultInstall: false,
  },
];

export function packageVersion() {
  try {
    return String(require("../../package.json").version || "");
  } catch {
    return "";
  }
}

function packagedSkillFile(name) {
  return fileURLToPath(new URL(`../../skills/${name}/SKILL.md`, import.meta.url));
}

/** YAML frontmatter for Claude-compatible SKILL.md, with a version stamp. */
export function claudeSkillFrontmatter(version = packageVersion()) {
  const ver = String(version || "").trim();
  const stamp = ver ? `\ngenerated_by: betterwright@${ver}` : "";
  return `---
name: browser
description: Drive a persistent, policy-guarded real web browser via the betterwright CLI. Use for any task that needs the live web — logging in, filling forms, booking, buying, or reading a page an API will not give you.${stamp}
---`;
}

/** Parse `generated_by: betterwright@X` from skill markdown (frontmatter). */
export function parseGeneratedBy(markdown) {
  const match = String(markdown || "").match(
    /^\s*generated_by:\s*betterwright@([^\s#]+)\s*$/m,
  );
  return match ? match[1] : null;
}

/**
 * Insert or replace the `generated_by` stamp in an existing SKILL.md
 * frontmatter block. Used for host skills whose body is vendored.
 */
export function stampHostSkillMarkdown(markdown, version = packageVersion()) {
  const text = String(markdown || "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) throw new Error("host skill must start with a --- frontmatter block.");
  const fm = match[1]
    .split("\n")
    .filter((line) => !/^\s*generated_by:\s*betterwright@/.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  const body = text.slice(match[0].length).replace(/^\n+/, "").replace(/\n+$/, "");
  const ver = String(version || "").trim();
  const stamp = ver ? `\ngenerated_by: betterwright@${ver}` : "";
  return `---\n${fm}${stamp}\n---\n\n${body}\n`;
}

/** Stamped e2e-review skill as written to host skill directories. */
export function e2eReviewSkillMarkdown({ version = packageVersion() } = {}) {
  const source = fs.readFileSync(packagedSkillFile(E2E_REVIEW_SKILL_NAME), "utf8");
  return stampHostSkillMarkdown(source, version);
}

/**
 * @param {string} body skill body without frontmatter
 * @param {{version?: string}} [options]
 */
export function wrapClaudeSkillMarkdown(body, { version = packageVersion() } = {}) {
  return `${claudeSkillFrontmatter(version)}\n\n${String(body || "").trim()}\n`;
}

function resolveHostIds(targets) {
  if (targets === "all") return SKILL_INSTALL_TARGETS.map((t) => t.id);
  if (targets === "default") {
    return SKILL_INSTALL_TARGETS.filter((t) => t.defaultInstall).map((t) => t.id);
  }
  return [...targets];
}

/**
 * @param {object} options
 * @param {string} [options.home]
 * @param {SkillInstallTargetId[]|"default"|"all"} [options.targets]
 * @param {string} [options.skill] one managed skill name; omit for every host skill
 */
export function resolveSkillInstallPaths({
  home = os.homedir(),
  targets = "default",
  skill,
}: any = {}) {
  const wanted = new Set(resolveHostIds(targets));
  const skillNames = skill ? [skill] : [...HOST_SKILL_NAMES];
  return SKILL_INSTALL_TARGETS.filter((t) => wanted.has(t.id)).flatMap((t) =>
    skillNames.map((name) => {
      const relativeDir = path.join(t.skillsRoot, name);
      return {
        ...t,
        skill: name,
        relativeDir,
        dir: path.join(home, relativeDir),
        file: path.join(home, relativeDir, "SKILL.md"),
      };
    }),
  );
}

function writeSkillFile(file, dir, content) {
  const text = content.endsWith("\n") ? content : `${content}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
}

function contentForDest(dest, browserMarkdown, e2eMarkdown) {
  return dest.skill === "browser" ? browserMarkdown : e2eMarkdown;
}

function browserSkillFile(dest) {
  return path.join(path.dirname(dest.dir), "browser", "SKILL.md");
}

function hostHasManagedBrowserSkill(dest) {
  const file = browserSkillFile(dest);
  if (!fs.existsSync(file)) return false;
  try {
    return isManagedBrowserSkill(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Write managed host skills to the chosen destinations.
 * `markdown` is the generated browser skill; the e2e-review playbook is
 * loaded from the packaged `skills/` tree and stamped to match.
 * @returns {{written: string[], skipped: string[]}}
 */
export function installAgentSkills({
  markdown,
  home = os.homedir(),
  targets = "default",
}: any = {}) {
  const browserMarkdown = String(markdown || "");
  if (!browserMarkdown.trim()) throw new Error("skill markdown is empty");
  const version = parseGeneratedBy(browserMarkdown) || packageVersion();
  const e2eMarkdown = e2eReviewSkillMarkdown({ version });
  const written = [];
  for (const dest of resolveSkillInstallPaths({ home, targets })) {
    writeSkillFile(dest.file, dest.dir, contentForDest(dest, browserMarkdown, e2eMarkdown));
    written.push(dest.file);
  }
  return { written, skipped: [] };
}

/**
 * Rewrite managed skill files that already exist (safe after package upgrade).
 * Never creates a browser skill — that stays explicit via `skill --install`.
 * If a host already has the managed browser skill, the e2e-review companion
 * is written even when it was missing, so existing installs pick it up on
 * setup/update without a second opt-in.
 * @returns {{refreshed: string[], missing: string[]}}
 */
export function refreshInstalledAgentSkills({
  markdown,
  home = os.homedir(),
  targets = "all",
}: any = {}) {
  const browserMarkdown = String(markdown || "");
  if (!browserMarkdown.trim()) throw new Error("skill markdown is empty");
  const version = parseGeneratedBy(browserMarkdown) || packageVersion();
  const e2eMarkdown = e2eReviewSkillMarkdown({ version });
  const refreshed = [];
  const missing = [];
  for (const dest of resolveSkillInstallPaths({ home, targets })) {
    const content = contentForDest(dest, browserMarkdown, e2eMarkdown);
    if (!fs.existsSync(dest.file)) {
      if (dest.skill !== "browser" && hostHasManagedBrowserSkill(dest)) {
        writeSkillFile(dest.file, dest.dir, content);
        refreshed.push(dest.file);
        continue;
      }
      missing.push(dest.file);
      continue;
    }
    let existing = "";
    try {
      existing = fs.readFileSync(dest.file, "utf8");
    } catch {
      missing.push(dest.file);
      continue;
    }
    if (!isManagedHostSkill(existing, dest.skill)) {
      missing.push(dest.file);
      continue;
    }
    writeSkillFile(dest.file, dest.dir, content);
    refreshed.push(dest.file);
  }
  return { refreshed, missing };
}

export function isManagedBrowserSkill(markdown) {
  const text = String(markdown || "");
  if (/^\s*name:\s*browser\s*$/m.test(text)) return true;
  if (/generated_by:\s*betterwright@/i.test(text)) return true;
  if (/# Browser tool: BetterWright/i.test(text)) return true;
  return false;
}

export function isManagedE2eReviewSkill(markdown) {
  const text = String(markdown || "");
  if (/^\s*name:\s*"?full-stack-e2e-review"?\s*$/m.test(text)) return true;
  if (
    /generated_by:\s*betterwright@/i.test(text) &&
    /# Full-stack end-to-end review/i.test(text)
  ) {
    return true;
  }
  return false;
}

export function isManagedHostSkill(markdown, name) {
  if (name === "browser") return isManagedBrowserSkill(markdown);
  if (name === E2E_REVIEW_SKILL_NAME) return isManagedE2eReviewSkill(markdown);
  return false;
}

/**
 * List installed managed skills whose generated_by does not match this package,
 * or a missing e2e-review companion next to a managed browser skill.
 * @returns {{file: string, installed: string|null, current: string}[]}
 */
export function staleAgentSkillReport({
  home = os.homedir(),
  version = packageVersion(),
  targets = "all",
} = {}) {
  const current = String(version || "").trim();
  const stale = [];
  for (const dest of resolveSkillInstallPaths({ home, targets })) {
    if (!fs.existsSync(dest.file)) {
      if (dest.skill !== "browser" && hostHasManagedBrowserSkill(dest)) {
        stale.push({ file: dest.file, installed: null, current });
      }
      continue;
    }
    let existing = "";
    try {
      existing = fs.readFileSync(dest.file, "utf8");
    } catch {
      continue;
    }
    if (!isManagedHostSkill(existing, dest.skill)) continue;
    const installed = parseGeneratedBy(existing);
    if (!current) continue;
    if (installed !== current) {
      stale.push({ file: dest.file, installed, current });
    }
  }
  return stale;
}

/** One-line operator tip, or null when nothing is stale. */
export function staleAgentSkillTip(report = staleAgentSkillReport()) {
  if (!report.length) return null;
  const sample = report[0];
  const from = sample.installed ? `v${sample.installed}` : "unknown version";
  const n = report.length;
  return (
    `Agent skill is stale (${from} → v${sample.current}, ${n} file${n === 1 ? "" : "s"}). ` +
    "Run: betterwright skill --install"
  );
}
