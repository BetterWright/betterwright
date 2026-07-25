import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  listSkills,
  matchSkillsForText,
  matchSkillsForUrl,
  parseSkillDocument,
  readSkill,
  skillHintsForPages,
  urlPatternMatches,
} from "../../src/skills.mjs";

const SAMPLE = `---
name: example
description: Read this when testing the loader.
siteSpecific: true
autoInject:
  keywords: ["login", "sign in"]
  url: ["example.com", "*.example.org/app/**"]
---
# Example

Body text.
`;

test("parseSkillDocument reads the frontmatter subset and body", () => {
  const skill = parseSkillDocument(SAMPLE);
  assert.equal(skill.name, "example");
  assert.equal(skill.description, "Read this when testing the loader.");
  assert.equal(skill.siteSpecific, true);
  assert.deepEqual(skill.autoInject.keywords, ["login", "sign in"]);
  assert.deepEqual(skill.autoInject.url, ["example.com", "*.example.org/app/**"]);
  assert.match(skill.body, /^# Example/);
});

test("parseSkillDocument rejects malformed packs", () => {
  assert.throws(() => parseSkillDocument("no frontmatter"), /must start with/);
  assert.throws(
    () => parseSkillDocument("---\nname: Bad Name\ndescription: x\n---\n"),
    /lowercase-hyphen-case/,
  );
  assert.throws(
    () => parseSkillDocument("---\nname: ok\n---\n"),
    /needs a description/,
  );
  assert.throws(
    () =>
      parseSkillDocument(
        "---\nname: ok\ndescription: x\nautoInject:\n  keywords: not-an-array\n---\n",
      ),
    /JSON-style array/,
  );
});

test("parseSkillDocument tolerates CRLF and apostrophes in keywords", () => {
  const crlf = SAMPLE.replaceAll("\n", "\r\n").replace(
    '"login", "sign in"',
    `"i'm not a robot", "log in"`,
  );
  const skill = parseSkillDocument(crlf);
  assert.deepEqual(skill.autoInject.keywords, ["i'm not a robot", "log in"]);
  assert.match(skill.body, /^# Example/);
});

test("urlPatternMatches escapes regex metacharacters like ? in patterns", () => {
  // A literal `?` in a pattern must not act as a regex quantifier.
  assert.equal(urlPatternMatches("https://example.com/ac", "example.com/ab?c"), false);
  assert.equal(urlPatternMatches("https://example.com/ab?c", "example.com/ab?c"), false);
  assert.equal(urlPatternMatches("https://example.com/abc", "example.com/abc"), true);
});

test("urlPatternMatches handles hosts, www, wildcards, and path globs", () => {
  assert.equal(urlPatternMatches("https://example.com/x", "example.com"), true);
  assert.equal(urlPatternMatches("https://www.example.com/", "example.com"), true);
  assert.equal(urlPatternMatches("https://example.com/", "www.example.com"), true);
  assert.equal(urlPatternMatches("https://evil-example.com/", "example.com"), false);
  assert.equal(urlPatternMatches("https://a.b.example.org/", "*.example.org"), true);
  assert.equal(urlPatternMatches("https://example.org/", "*.example.org"), true);
  assert.equal(
    urlPatternMatches("https://foo.example.org/app/settings", "*.example.org/app/**"),
    true,
  );
  assert.equal(
    urlPatternMatches("https://foo.example.org/app", "*.example.org/app/**"),
    true,
  );
  assert.equal(
    urlPatternMatches("https://foo.example.org/other", "*.example.org/app/**"),
    false,
  );
  // A single * matches one path segment; ** spans segments.
  assert.equal(urlPatternMatches("https://example.com/a/b", "example.com/a/*"), true);
  assert.equal(urlPatternMatches("https://example.com/a/b/c", "example.com/a/*"), false);
  assert.equal(urlPatternMatches("https://example.com/a/b/c", "example.com/a/**"), true);
  assert.equal(urlPatternMatches("chrome://settings", "settings"), false);
  assert.equal(urlPatternMatches("not a url", "example.com"), false);
});

test("urlPatternMatches strips raw NULs so the ** sentinel cannot be forged", () => {
  // The glob translation parks "**" on a U+0000 sentinel before expanding
  // single stars. A raw NUL in a pattern used to be cashed out as ".*", so a
  // crafted skill pattern could match paths its author never wrote a glob for.
  const smuggled = "example.com/foo\u0000bar";
  assert.equal(urlPatternMatches("https://example.com/fooXbar", smuggled), false);
  assert.equal(urlPatternMatches("https://example.com/foo/x/bar", smuggled), false);
  // The NUL is dropped, not treated as a glob: only the literal remainder matches.
  assert.equal(urlPatternMatches("https://example.com/foobar", smuggled), true);
});

test("packaged skills ship and are discoverable", () => {
  const names = listSkills().map((skill) => skill.name);
  for (const expected of ["1password", "bitwarden", "credential-manager", "github"])
    assert.ok(names.includes(expected), `missing packaged skill ${expected}`);
  const github = readSkill("github");
  assert.equal(github.siteSpecific, true);
  assert.match(github.body, /Canonical URLs/);
  assert.throws(() => readSkill("no-such-skill"), /Unknown skill/);
  assert.throws(() => readSkill("../etc/passwd"), /Unknown skill/);
});

test("user packs override packaged packs and broken packs are surfaced", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-skills-"));
  try {
    await fs.mkdir(path.join(dir, "github"));
    await fs.writeFile(
      path.join(dir, "github", "SKILL.md"),
      "---\nname: github\ndescription: User override.\n---\nOverridden body.\n",
    );
    await fs.mkdir(path.join(dir, "broken"));
    await fs.writeFile(path.join(dir, "broken", "SKILL.md"), "no frontmatter");

    const skills = listSkills({ userDir: dir });
    const github = skills.find((skill) => skill.name === "github");
    assert.equal(github.source, "user");
    assert.equal(github.description, "User override.");
    assert.match(readSkill("github", { userDir: dir }).body, /Overridden body/);

    const broken = skills.find((skill) => skill.name === "broken");
    assert.match(broken.error, /must start with/);
    // Broken packs never match, so they cannot mis-hint.
    assert.deepEqual(matchSkillsForText("broken", skills), []);

    // A pack whose frontmatter name disagrees with its directory is rejected
    // consistently by list and read (not silently returned).
    await fs.mkdir(path.join(dir, "mismatch"));
    await fs.writeFile(
      path.join(dir, "mismatch", "SKILL.md"),
      "---\nname: other\ndescription: Wrong name.\n---\nBody.\n",
    );
    const mismatch = listSkills({ userDir: dir }).find(
      (skill) => skill.name === "mismatch",
    );
    assert.match(mismatch.error, /must match its directory/);
    assert.throws(
      () => readSkill("mismatch", { userDir: dir }),
      /must match its directory/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("keyword and URL matching drive hints with readable paths", () => {
  const skills = listSkills();
  const forLogin = matchSkillsForText("Please log in to my account", skills).map(
    (skill) => skill.name,
  );
  assert.ok(forLogin.includes("credential-manager"));

  const matched = matchSkillsForUrl("https://github.com/o/r/pull/1", skills).map(
    (skill) => skill.name,
  );
  assert.deepEqual(matched, ["github"]);

  const hints = skillHintsForPages(
    [
      { url: "https://github.com/o/r", active: true },
      { url: "https://example.com/", active: false },
      { url: "https://github.com/o/r/issues", active: false },
    ],
    { skills },
  );
  assert.equal(hints.length, 1);
  assert.equal(hints[0].name, "github");
  assert.ok(hints[0].description);
  assert.ok(hints[0].path.endsWith(path.join("github", "SKILL.md")));
  assert.deepEqual(skillHintsForPages([], { skills }), []);
});
