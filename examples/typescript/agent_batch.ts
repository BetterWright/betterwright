// AgentBatch: the default two-call way to drive the browser. Call one opens
// a page and returns its spec; call two runs every step of the task and
// returns per-step results plus a fresh snapshot to plan from.
//
//   bun examples/typescript/agent_batch.ts

import type { AgentBatchStepInput } from "betterwright";
import { BrowserError, withBrowser } from "betterwright/sdk";

await withBrowser(async (bw) => {
  const spec = await bw.batch({ url: "https://example.com" });
  if (!spec.ok) throw new BrowserError(spec.error);
  console.log(`Spec:\n${spec.result.snapshot}`);

  const steps: AgentBatchStepInput[] = [
    { action: "read", target: { role: "heading" } },
    { action: "click", target: { role: "link", name: "More information" } },
    { action: "wait", url: "iana.org" },
    { action: "read", target: { role: "heading" }, expect: "Example Domains" },
  ];
  const done = await bw.batch(steps, { allowWrites: true, proof: true });
  if (!done.ok) throw new BrowserError(done.error);

  const batch = done.result;
  console.log(batch.ok ? "Every step succeeded" : `Stopped at step ${batch.failed?.index}: ${batch.failed?.error}`);
  for (const step of batch.steps) console.log(`${step.id} ${step.action}: ${step.ok ? step.text ?? step.url ?? "ok" : step.error}`);
  console.log("Proof:", batch.proof?.media);
});
