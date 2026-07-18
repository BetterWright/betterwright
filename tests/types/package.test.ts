import {
  agentSystemPrompt,
  BetterWright,
  type BetterWrightOptions,
  BrowserError,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  classifyChallengeStage,
  detectBotChallenge,
  type Guardrails,
  METADATA_ADDRESSES,
  METADATA_HOSTNAMES,
  NetworkPolicy,
  piImageArtifacts,
  piImageContent,
  piPrimaryImageArtifact,
  type RunResult,
} from "betterwright";
import type { PiImageContentBlock } from "betterwright/pi";
import createBetterWrightPiExtension, {
  createPiExtension,
  type PiExtension,
} from "betterwright/pi-extension";
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
const images: Promise<PiImageContentBlock[]> = piImageContent({ artifacts: [] });
const artifacts = piImageArtifacts({ artifacts: [] });
const primaryArtifact = piPrimaryImageArtifact({ artifacts: [] });
const extension: PiExtension = createPiExtension({ maxSteps: 100 });
const defaultExtension: PiExtension = createBetterWrightPiExtension;
const error: Error = new BrowserError("failed");
const metadataAddress: boolean = METADATA_ADDRESSES.has("169.254.169.254");
const metadataHost: boolean = METADATA_HOSTNAMES.has("metadata.google.internal");
const captchaStage = classifyChallengeStage({
  frames: [{ url: "https://www.google.com/recaptcha/api2/anchor?k=k", text: "I'm not a robot" }],
});
const captchaStatus: string = CAPTCHA_SOLVE_STATUSES.READY;
const captchaStageName: string = CAPTCHA_STAGES.CHECKBOX;
const challenge = detectBotChallenge({
  url: "https://example.com",
  text: "Verify you are human",
});

// @ts-expect-error BetterWright supports only managed CloakBrowser.
new BetterWright({ browser: "firefox" });
// @ts-expect-error The stock Chromium fallback was removed.
new BetterWright({ browser: "chromium" });
// @ts-expect-error External browser binaries are not accepted.
new BetterWright({ executablePath: "/opt/chromium" });
// @ts-expect-error CDP attach mode was removed.
new BetterWright({ connectOverCdp: "http://127.0.0.1:9222" });

void [
  run,
  prompt,
  images,
  artifacts,
  primaryArtifact,
  extension,
  defaultExtension,
  error,
  metadataAddress,
  metadataHost,
  METADATA_RESOLVER_RULES,
  captchaStage,
  captchaStatus,
  captchaStageName,
  challenge,
];
