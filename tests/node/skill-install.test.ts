import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  claudeSkillFrontmatter,
  installAgentSkills,
  isManagedBrowserSkill,
  parseGeneratedBy,
  refreshInstalledAgentSkills,
  resolveSkillInstallPaths,
  staleAgentSkillReport,
  staleAgentSkillTip,
  wrapClaudeSkillMarkdown,
} from "../../dist/src/skill-install.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function tempHome() {
  return makeTempDir("bw-skill-");
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

test("installAgentSkills writes default destinations under HOME", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "2.0.0" });
    const { written } = installAgentSkills({
      markdown,
      home,
      targets: "default",
    });
    assert.equal(written.length, 2);
    for (const file of written) {
      assert.ok(fs.existsSync(file));
      assert.equal(fs.readFileSync(file, "utf8"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    }
    const paths = resolveSkillInstallPaths({ home, targets: "default" });
    assert.deepEqual(
      paths.map((p) => p.id).sort(),
      ["agents", "claude"],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install --all includes cursor destination", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "2.0.0" });
    const { written } = installAgentSkills({ markdown, home, targets: "all" });
    assert.equal(written.length, 3);
    assert.ok(
      written.some((file) => file.includes(path.join(".cursor", "skills", "browser"))),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("refreshInstalledAgentSkills only rewrites existing managed files", () => {
  const home = tempHome();
  try {
    const old = wrapClaudeSkillMarkdown("old body", { version: "1.0.0" });
    const next = wrapClaudeSkillMarkdown("new body", { version: "1.1.0" });
    const claudeFile = path.join(home, ".claude", "skills", "browser", "SKILL.md");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, old);

    const { refreshed, missing } = refreshInstalledAgentSkills({
      markdown: next,
      home,
      targets: "all",
    });
    assert.deepEqual(refreshed, [claudeFile]);
    assert.ok(missing.length >= 1);
    assert.match(fs.readFileSync(claudeFile, "utf8"), /new body/);
    assert.equal(parseGeneratedBy(fs.readFileSync(claudeFile, "utf8")), "1.1.0");
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

test("staleAgentSkillReport detects version drift", () => {
  const home = tempHome();
  try {
    const markdown = wrapClaudeSkillMarkdown("body", { version: "1.0.0" });
    installAgentSkills({ markdown, home, targets: ["claude"] });
    const report = staleAgentSkillReport({
      home,
      version: "1.1.0",
      targets: ["claude"],
    });
    assert.equal(report.length, 1);
    assert.equal(report[0].installed, "1.0.0");
    assert.equal(report[0].current, "1.1.0");
    const tip = staleAgentSkillTip(report);
    assert.match(tip, /stale/);
    assert.match(tip, /skill --install/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
