import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The checked-in SKILL.md exists so custom agents can grab the instructions
// straight from the repo or npm package without running the CLI. It must be
// byte-identical to what `betterwright skill --claude` generates — regenerate
// with `node dist/bin/betterwright.js skill --claude > SKILL.md` after editing
// SKILL_PREAMBLE or the operator guidance in src/prompt.ts.
test("SKILL.md matches `betterwright skill --claude` output", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const generated = execFileSync(
    process.execPath,
    ["dist/bin/betterwright.js", "skill", "--claude"],
    { cwd: root, encoding: "utf8" },
  );
  const checkedIn = readFileSync(new URL("../../SKILL.md", import.meta.url), "utf8");
  const words = checkedIn.trim().split(/\s+/).length;
  assert.ok(words < 750, `generated browser skill grew to ${words} words`);
  assert.ok(checkedIn.length < 6_000, `generated browser skill grew to ${checkedIn.length} bytes`);
  assert.match(checkedIn, /never run `vault show --reveal`/i);
  assert.match(checkedIn, /Never claim a view is running without its URL/);
  assert.doesNotMatch(checkedIn, /prefer the site's own machinery/);
  assert.doesNotMatch(checkedIn, /# Full-stack end-to-end review/);
  assert.equal(
    checkedIn,
    generated,
    "SKILL.md is stale — run: node dist/bin/betterwright.js skill --claude > SKILL.md",
  );
});
