import type { BetterWright } from "./client.js";
import type { Guardrails } from "./prompt.js";
import type { BetterWrightOptions } from "./public.js";
import type { UntrustedValue } from "./untrusted-value.js";

export interface PiExtensionOptions {
  autoScreenshot?: boolean;
  browser?: Pick<
    BetterWright,
    "run" | "close" | "downloadPolicy" | "fillCredential"
  >;
  browserOptions?: BetterWrightOptions;
  closeBrowserOnShutdown?: boolean;
  guardrails?: Guardrails;
  maxSteps?: number;
  requireEvidence?: boolean;
  session?: string;
  startUrl?: string;
  traceDir?: string;
}

export interface PiExtensionApiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute(
      toolCallId: string,
      params: Record<string, UntrustedValue>,
      signal?: AbortSignal,
      onUpdate?: UntrustedValue,
      context?: {
        hasUI?: boolean;
        ui?: {
          confirm(title: string, message: string): Promise<boolean>;
        };
      },
    ): Promise<UntrustedValue>;
  }): void;
  on(event: string, handler: (...args: any[]) => UntrustedValue): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export type PiExtension = (pi: PiExtensionApiLike) => void;

export const PI_BROWSER_PARAMETERS: Readonly<object>;
export const PI_BATCH_PARAMETERS: Readonly<object>;
export const PI_LOGIN_PARAMETERS: Readonly<object>;
export const PI_EVIDENCE_PARAMETERS: Readonly<object>;
export function createPiExtension(options?: PiExtensionOptions): PiExtension;

declare const extension: PiExtension;
export default extension;
