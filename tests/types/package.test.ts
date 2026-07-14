import {
  agentSystemPrompt,
  BetterWright,
  type BetterWrightOptions,
  BrowserError,
  ensureChromeCdp,
  findChromeExecutable,
  type Guardrails,
  METADATA_ADDRESSES,
  METADATA_HOSTNAMES,
  NetworkPolicy,
  piImageContent,
  type RunResult,
} from "betterwright";
import { chromeExecutableCandidates } from "betterwright/chrome";
import type { PiImageContentBlock } from "betterwright/pi";
import type { NetworkDecision } from "betterwright/policy";
import type { Guardrails as PromptGuardrails } from "betterwright/prompt";
import { METADATA_RESOLVER_RULES } from "betterwright/worker";

const policy = new NetworkPolicy({
  allowLoopback: true,
  custom: (_url, details): NetworkDecision | null =>
    details.method === "DELETE" ? { allowed: false, reason: "blocked" } : null,
});
const options: BetterWrightOptions = {
  policy,
  browser: "cloak",
  headless: "auto",
  downloadPolicy: "ask",
};
const browser = new BetterWright(options);
const run: Promise<RunResult<{ title: string }>> = browser.run<{ title: string }>(
  "return { title: await page.title() }",
  { session: "docs", note: "Reading the page" },
);
const promptOptions: Guardrails & PromptGuardrails = {
  confirmBeforePurchase: true,
  passwordManager: "1Password",
};
const prompt: string = agentSystemPrompt(promptOptions);
const chrome: string | null = findChromeExecutable();
const candidates: string[] = chromeExecutableCandidates();
const cdp = ensureChromeCdp({ port: 9223 });
const images: Promise<PiImageContentBlock[]> = piImageContent({ artifacts: [] });
const error: Error = new BrowserError("failed");
const metadataAddress: boolean = METADATA_ADDRESSES.has("169.254.169.254");
const metadataHost: boolean = METADATA_HOSTNAMES.has("metadata.google.internal");

// @ts-expect-error BetterWright supports only the two declared browser backends.
new BetterWright({ browser: "firefox" });

void [
  run,
  prompt,
  chrome,
  candidates,
  cdp,
  images,
  error,
  metadataAddress,
  metadataHost,
  METADATA_RESOLVER_RULES,
];
