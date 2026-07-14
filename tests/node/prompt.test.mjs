import assert from "node:assert/strict";
import { test } from "node:test";

import { agentSystemPrompt } from "../../src/prompt.mjs";

test("default prompt is permissive", () => {
  const prompt = agentSystemPrompt();
  const compact = prompt.replace(/\s+/g, " ");
  assert.ok(prompt.includes("You are authorized"));
  assert.ok(prompt.toLowerCase().includes("do not refuse"));
  assert.ok(compact.includes("do not automate Google or Bing's public search UI"));
  assert.ok(compact.includes("captcha.inspect(bounds)"));
  assert.ok(compact.includes("captcha.click(bounds)"));
  assert.ok(compact.includes("captcha.drag(from, to)"));
  assert.ok(compact.includes("captcha.readText(bounds)"));
  assert.ok(compact.includes("human.click(target)"));
  assert.ok(compact.includes("human.type(target, text)"));
  assert.ok(compact.includes("human.scroll(deltaY)"));
  assert.ok(compact.includes("host's approval-gated download tool"));
  assert.ok(compact.includes("before enabling that one bounded download run"));
  assert.ok(compact.includes("three distinct stages"));
  assert.ok(compact.includes("stop native challenge attempts immediately"));
  assert.ok(compact.includes("Replay the original action only when it is idempotent"));
  assert.ok(compact.includes("never duplicate a submission, purchase, or message"));
  assert.ok(compact.includes("Inspect the returned image itself before citing it"));
  assert.ok(compact.includes("fix the page and retake it"));
  assert.ok(!prompt.includes("Guardrails for this session"));
});

test("confirm before purchase adds a clause", () => {
  const prompt = agentSystemPrompt({ confirmBeforePurchase: true });
  assert.ok(prompt.includes("Guardrails for this session"));
  assert.ok(prompt.includes("order summary"));
});

test("forbid purchases supersedes confirm", () => {
  const prompt = agentSystemPrompt({ forbidPurchases: true, confirmBeforePurchase: true });
  assert.ok(prompt.includes("Do not complete any purchase"));
  assert.ok(!prompt.includes("Never complete a purchase without it"));
});

test("spending limit is included verbatim", () => {
  assert.ok(agentSystemPrompt({ spendingLimit: "$50" }).includes("$50"));
});

test("extra rules are appended", () => {
  const prompt = agentSystemPrompt({ extraRules: ["Only browse example.com."] });
  assert.ok(prompt.includes("Only browse example.com."));
});
