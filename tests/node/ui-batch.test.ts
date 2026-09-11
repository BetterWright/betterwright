import assert from "node:assert/strict";
import { test } from "node:test";
import { executeUIBatch } from "../../dist/src/ui-batch.js";

test("batch validates later action values before making any writes", async () => {
  let writes = 0;
  const page = { getByLabel() { writes++; throw new Error("must not resolve targets"); } };
  for (const operation of [
    { action: "fill", value: 42 },
    { action: "select", value: [] },
    { action: "press", value: "" },
    { action: "read", value: "x".repeat(10_001) },
  ]) {
    await assert.rejects(executeUIBatch(page, [
      { id: "first", action: "fill", target: { label: "Name" }, value: "Taylor" },
      { id: "invalid", target: { label: "Other" }, ...operation },
      { id: "verify", action: "readUrl", value: "success" },
    ], { allowWrites: true }), /value|key/);
  }
  assert.equal(writes, 0);
});

test("batch stops after a failure and identifies completed operations", async () => {
  const actions = [];
  const locator = {
    first() { return this; },
    async waitFor() {},
    async count() { return 1; },
    async click() {
      actions.push("click");
      if (actions.length === 2) throw new Error("covered");
    },
  };
  const page = { getByRole() { return locator; }, url() { return "initial"; }, on() {}, off() {} };
  await assert.rejects(executeUIBatch(page, [
    { id: "first", action: "click", target: { role: "button" } },
    { id: "second", action: "click", target: { role: "button" } },
    { id: "never", action: "click", target: { role: "button" } },
    { id: "verify", action: "readUrl", value: "success" },
  ], { allowWrites: true }), /Completed operations: \["first"\].*not rolled back/);
  assert.deepEqual(actions, ["click", "click"]);
});


test("observation does not bypass write authorization or expected-value validation", async () => {
  const click = {id:"submit", action:"click", target:{role:"button"}};
  await assert.rejects(executeUIBatch({}, [click], {observe:true}), /allowWrites:true/);
  await assert.rejects(executeUIBatch({}, [{...click, irreversible:true}], {observe:true, allowWrites:true}), /allowIrreversible:true/);
  await assert.rejects(executeUIBatch({}, [click], {allowWrites:true}), /must end with read/);
  await assert.rejects(executeUIBatch({}, [click, {id:"read",action:"readUrl"}], {allowWrites:true}), /expected value/);
  await assert.rejects(executeUIBatch({}, [click, {id:"read",action:"readUrl",value:""}], {observe:true,allowWrites:true}), /expected value/);
});
