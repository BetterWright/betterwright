import type { RunResult, SpilledRunOutput } from "betterwright";
import type { SpilledRunOutput as SdkSpilledRunOutput } from "betterwright/sdk";

const spilled: SpilledRunOutput = {
  truncated: true,
  preview: "A bounded preview",
  fullOutputPath: "/tmp/browser-output.json",
};
const sdkSpilled: SdkSpilledRunOutput = spilled;
const result: RunResult<string> = { ok: true, result: spilled };

function readText(output: RunResult<{ text: string }>): string {
  if (!output.ok) return output.error;
  if (!("truncated" in output.result)) return output.result.text;
  const truncated: true = output.result.truncated;
  const path: string = output.result.fullOutputPath;
  void [truncated, path];
  return output.result.preview;
}

void [sdkSpilled, result, readText({ ok: true, result: spilled })];
