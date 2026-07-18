import type { SkillHint } from "./common.js";

export interface SkillMeta {
  name: string;
  description: string;
  siteSpecific: boolean;
  autoInject: { keywords: string[]; url: string[] };
  path: string;
  source: "packaged" | "user";
  /** Set when a pack failed to parse; it never matches or hints. */
  error?: string;
}

export interface Skill extends SkillMeta {
  body: string;
}

export interface SkillLookupOptions {
  userDir?: string;
}

/** Parse a SKILL.md document into metadata plus body. */
export function parseSkillDocument(text: string): Omit<Skill, "path" | "source">;

/** Enumerate packaged and user skill packs (metadata only). */
export function listSkills(options?: SkillLookupOptions): SkillMeta[];

/** Read one skill pack, metadata plus body, by name. */
export function readSkill(name: string, options?: SkillLookupOptions): Skill;

/** Does one autoInject url pattern (host or host/path glob) match a URL? */
export function urlPatternMatches(url: string, pattern: string): boolean;

/** Skills whose autoInject.url patterns match `url`. */
export function matchSkillsForUrl(url: string, skills?: SkillMeta[]): SkillMeta[];

/** Skills whose autoInject.keywords appear (case-insensitive) in `text`. */
export function matchSkillsForText(text: string, skills?: SkillMeta[]): SkillMeta[];

/** Hints for each skill matching any open page's URL. */
export function skillHintsForPages(
  pages: Array<{ url?: string }>,
  options?: { skills?: SkillMeta[] },
): SkillHint[];
