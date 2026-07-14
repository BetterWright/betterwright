import type {
  BetterWrightOptions,
  CredentialFillResult,
  FillCredentialOptions,
  GenerateAndFillCredentialOptions,
  RunOptions,
  RunResult,
} from "./public.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";

export class BrowserError extends Error {}

export class BetterWright {
  constructor(options?: BetterWrightOptions);

  home: string;
  policy: NetworkPolicy;
  vault: CredentialVault | null;
  browserFlavor: "cloak" | "chromium";
  executablePath: string;
  headless: boolean;
  connectOverCdp: string;
  searchMinIntervalMs: number;
  publicSearchPolicy: "block" | "allow";
  downloadPolicy: "ask" | "allow" | "deny";
  defaultTimeout: number;

  run<T = unknown>(code: string, options?: RunOptions): Promise<RunResult<T>>;
  fillCredential(options: FillCredentialOptions): Promise<CredentialFillResult>;
  generateAndFillCredential(
    options: GenerateAndFillCredentialOptions,
  ): Promise<CredentialFillResult>;
  close(): Promise<void>;
}
