import assert from "node:assert/strict";
import { test } from "node:test";

import { agentSystemPrompt } from "../../src/prompt.mjs";

test("default prompt is permissive", () => {
  const prompt = agentSystemPrompt();
  assert.ok(prompt.includes("You are authorized"));
  assert.ok(prompt.toLowerCase().includes("do not refuse"));
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
