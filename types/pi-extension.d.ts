import type { BetterWright } from "./client.js";
import type { Guardrails } from "./prompt.js";
import type { BetterWrightOptions } from "./public.js";

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
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: {
        hasUI?: boolean;
        ui?: {
          confirm(title: string, message: string): Promise<boolean>;
        };
      },
    ): Promise<unknown>;
  }): void;
  on(event: string, handler: (...args: any[]) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export type PiExtension = (pi: PiExtensionApiLike) => void;

export const PI_BROWSER_PARAMETERS: Readonly<object>;
export const PI_LOGIN_PARAMETERS: Readonly<object>;
export const PI_EVIDENCE_PARAMETERS: Readonly<object>;
export function createPiExtension(options?: PiExtensionOptions): PiExtension;

declare const extension: PiExtension;
export default extension;
