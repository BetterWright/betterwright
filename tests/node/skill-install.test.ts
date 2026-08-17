import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  claudeSkillFrontmatter,
  E2E_REVIEW_SKILL_NAME,
  e2eReviewSkillMarkdown,
  installAgentSkills,
  isManagedBrowserSkill,
  isManagedE2eReviewSkill,
  parseGeneratedBy,
  refreshInstalledAgentSkills,
  resolveSkillInstallPaths,
  staleAgentSkillReport,
  staleAgentSkillTip,
  stampHostSkillMarkdown,
  wrapClaudeSkillMarkdown,
} from "../../dist/src/skill-install.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function tempHome() {
  return makeTempDir("bw-skill-");
}

function browserFiles(written) {
  return written.filter((file) => file.includes(`${path.sep}browser${path.sep}`));
}

function e2eFiles(written) {
  return written.filter((file) => file.includes(`${path.sep}${E2E_REVIEW_SKILL_NAME}${path.sep}`));
}

test("claudeSkillFrontmatter stamps generated_by with the package version", () => {
  const fm = claudeSkillFrontmatter("9.9.9");
  assert.match(fm, /^---\n/);
  assert.match(fm, /name: browser/);
  assert.match(fm, /generated_by: betterwright@9\.9\.9/);
  assert.equal(parseGeneratedBy(fm), "9.9.9");
});

test("wrapClaudeSkillMarkdown builds a complete stamped SKILL.md", () => {
  const md = wrapClaudeSkillMarkdown("# Browser tool: BetterWright\n\nhello", {
    version: "1.2.3",
  });
  assert.match(md, /generated_by: betterwright@1\.2\.3/);
  assert.match(md, /# Browser tool: BetterWright/);
  assert.ok(isManagedBrowserSkill(md));
});

test("stampHostSkillMarkdown adds generated_by without duplicating it", () => {
  const source = "---\nname: full-stack-e2e-review\ndescription: Review playbook.\n---\n\n# Full-stack end-to-end review\n\nbody\n";
  const stamped = stampHostSkillMarkdown(source, "4.0.0");
  assert.equal(parseGeneratedBy(stamped), "4.0.0");
  assert.equal(
    stamped.match(/generated_by: betterwright@/g)?.length,
    1,
  );
  const restamped = stampHostSkillMarkdown(stamped, "4.1.0");
  assert.equal(parseGeneratedBy(restamped), "4.1.0");
  assert.equal(
    restamped.match(/generated_by: betterwright@/g)?.length,
    1,
  );
  assert.ok(isManagedE2eReviewSkill(restamped));
});

test("e2eReviewSkillMarkdown loads the packaged playbook and stamps it", () => {
  const md = e2eReviewSkillMarkdown({ version: "8.8.8" });
  assert.equal(parseGeneratedBy(md), "8.8.8");
  assert.match(md, /^---\nname: full-stack-e2e-review\n/);
  assert.match(md, /# Full-stack end-to-end review/);
  assert.match(md, /CuriosityOS\/full-stack-e2e-review/);
  assert.ok(isManagedE2eReviewSkill(md));
});

test("installAgentSkills writes browser and e2e-review to default hosts", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "2.0.0" });
    const { written } = installAgentSkills({
      markdown,
      home,
      targets: "default",
    });
    assert.equal(written.length, 4);
    assert.equal(browserFiles(written).length, 2);
    assert.equal(e2eFiles(written).length, 2);
    for (const file of browserFiles(written)) {
      assert.equal(
        fs.readFileSync(file, "utf8"),
        markdown.endsWith("\n") ? markdown : `${markdown}\n`,
      );
    }
    for (const file of e2eFiles(written)) {
      const text = fs.readFileSync(file, "utf8");
      assert.equal(parseGeneratedBy(text), "2.0.0");
      assert.match(text, /name: full-stack-e2e-review/);
      assert.match(text, /# Full-stack end-to-end review/);
    }
    const paths = resolveSkillInstallPaths({ home, targets: "default" });
    assert.deepEqual(
      [...new Set(paths.map((p) => p.id))].sort(),
      ["agents", "claude"],
    );
    assert.deepEqual(
      [...new Set(paths.map((p) => p.skill))].sort(),
      ["browser", E2E_REVIEW_SKILL_NAME],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install --all includes cursor destination for both skills", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "2.0.0" });
    const { written } = installAgentSkills({ markdown, home, targets: "all" });
    assert.equal(written.length, 6);
    assert.ok(
      written.some((file) => file.includes(path.join(".cursor", "skills", "browser"))),
    );
    assert.ok(
      written.some((file) =>
        file.includes(path.join(".cursor", "skills", E2E_REVIEW_SKILL_NAME)),
      ),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refreshInstalledAgentSkills rewrites existing managed files and backfills e2e-review", () => {
  const home = tempHome();
  try {
    const old = wrapClaudeSkillMarkdown("old body", { version: "1.0.0" });
    const next = wrapClaudeSkillMarkdown("new body", { version: "1.1.0" });
    const claudeFile = path.join(home, ".claude", "skills", "browser", "SKILL.md");
    const e2eFile = path.join(
      home,
      ".claude",
      "skills",
      E2E_REVIEW_SKILL_NAME,
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, old);

    const { refreshed, missing } = refreshInstalledAgentSkills({
      markdown: next,
      home,
      targets: "all",
    });
    assert.ok(refreshed.includes(claudeFile));
    assert.ok(refreshed.includes(e2eFile), "missing e2e-review is backfilled beside browser");
    assert.match(fs.readFileSync(claudeFile, "utf8"), /new body/);
    assert.equal(parseGeneratedBy(fs.readFileSync(claudeFile, "utf8")), "1.1.0");
    assert.equal(parseGeneratedBy(fs.readFileSync(e2eFile, "utf8")), "1.1.0");
    assert.ok(missing.length >= 1);
    assert.ok(
      !refreshed.some((file) => file.includes(`${path.sep}.cursor${path.sep}`)),
      "cursor is not created just because claude exists",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refresh skips unrelated SKILL.md in the same path", () => {
  const home = tempHome();
  try {
    const file = path.join(home, ".claude", "skills", "browser", "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: something-else\n---\n\nnot ours\n");
    const next = wrapClaudeSkillMarkdown("new", { version: "3.0.0" });
    const { refreshed } = refreshInstalledAgentSkills({
      markdown: next,
      home,
      targets: ["claude"],
    });
    assert.deepEqual(refreshed, []);
    assert.match(fs.readFileSync(file, "utf8"), /something-else/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refresh does not create e2e-review on a host without the browser skill", () => {
  const home = tempHome();
  try {
    const next = wrapClaudeSkillMarkdown("new", { version: "3.0.0" });
    const { refreshed, missing } = refreshInstalledAgentSkills({
      markdown: next,
      home,
      targets: ["claude"],
    });
    assert.deepEqual(refreshed, []);
    assert.ok(
      missing.some((file) => file.includes(path.join(".claude", "skills", "browser"))),
    );
    assert.equal(
      fs.existsSync(
        path.join(home, ".claude", "skills", E2E_REVIEW_SKILL_NAME, "SKILL.md"),
      ),
      false,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("staleAgentSkillReport detects version drift on both host skills", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "1.0.0" });
    installAgentSkills({ markdown, home, targets: ["claude"] });
    const report = staleAgentSkillReport({
      home,
      version: "1.1.0",
      targets: ["claude"],
    });
    assert.equal(report.length, 2);
    assert.ok(report.every((entry) => entry.installed === "1.0.0"));
    assert.ok(report.every((entry) => entry.current === "1.1.0"));
    const tip = staleAgentSkillTip(report);
    assert.match(tip, /stale/);
    assert.match(tip, /skill --install/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("staleAgentSkillReport flags a missing e2e-review companion", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "1.9.3" });
    const claudeFile = path.join(home, ".claude", "skills", "browser", "SKILL.md");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, markdown);
    const report = staleAgentSkillReport({
      home,
      version: "1.9.3",
      targets: ["claude"],
    });
    assert.equal(report.length, 1);
    assert.match(report[0].file, /full-stack-e2e-review/);
    assert.equal(report[0].installed, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
