import type { BetterWright } from "./client.js";
import type { Guardrails } from "./prompt.js";
import type { BetterWrightOptions } from "./public.js";

export interface PiExtensionOptions {
  autoScreenshot?: boolean;
  browser?: Pick<
    BetterWright,
    "run" | "close" | "downloadPolicy" | "fillCredential"
  > &
    Partial<
      Pick<
        BetterWright,
        | "liveViewDrainChat"
        | "liveViewPostChat"
        | "liveViewStatus"
        | "startLiveView"
        | "stopLiveView"
        | "waitForHandoff"
      >
    >;
  browserOptions?: BetterWrightOptions;
  chatPollMs?: number;
  closeBrowserOnShutdown?: boolean;
  guardrails?: Guardrails;
  liveView?: {
    enabled?: boolean;
    expose?: string;
    host?: string;
    password?: string;
    passwordHash?: string;
    port?: number;
    publicHost?: string;
  };
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
  sendMessage?(
    message: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): void;
}

export type PiExtension = (pi: PiExtensionApiLike) => void;

export const PI_BROWSER_PARAMETERS: Readonly<object>;
export const PI_LOGIN_PARAMETERS: Readonly<object>;
export const PI_EVIDENCE_PARAMETERS: Readonly<object>;
export const PI_HANDOFF_PARAMETERS: Readonly<object>;
export function createPiExtension(options?: PiExtensionOptions): PiExtension;

declare const extension: PiExtension;
export default extension;
