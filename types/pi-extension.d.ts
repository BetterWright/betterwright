import type { BetterWright } from "./client.js";
import type { Guardrails } from "./prompt.js";
import type { BetterWrightOptions } from "./public.js";
import type { UntrustedValue } from "./untrusted-value.js";

/**
 * Options for `createPiExtension`. The environment-backed fields name their
 * `BETTERWRIGHT_PI_*` counterpart inline (see docs/environment.md);
 * `browser`, `browserOptions`, `closeBrowserOnShutdown`, and `guardrails`
 * are programmatic-only.
 */
export interface PiExtensionOptions {
  /**
   * Attach the active page as an image after a tool call that produced none.
   * Default true (`BETTERWRIGHT_PI_AUTO_SCREENSHOT`).
   */
  autoScreenshot?: boolean;
  /**
   * A caller-supplied browser instead of the one the extension creates. Only
   * the methods the tools call need to exist.
   */
  browser?: Pick<
    BetterWright,
    "run" | "close" | "downloadPolicy" | "fillCredential"
  >;
  /** Constructor options for the browser the extension creates. */
  browserOptions?: BetterWrightOptions;
  /** Close the browser on host shutdown. Default true. */
  closeBrowserOnShutdown?: boolean;
  /** Guardrails appended to the operator guidance the extension adds. */
  guardrails?: Guardrails;
  /**
   * Browser-tool step budget; reaching it deactivates the tools and the model
   * must answer from collected evidence (`BETTERWRIGHT_PI_MAX_STEPS`).
   */
  maxSteps?: number;
  /**
   * Require `browser_evidence` to be initialized with every atomic task
   * requirement before `browser`/`browser_download` will run
   * (`BETTERWRIGHT_PI_REQUIRE_EVIDENCE`).
   */
  requireEvidence?: boolean;
  /** BetterWright session name for the created browser. Default `"pi"`. */
  session?: string;
  /** HTTP(S) page to open once before the first tool call. */
  startUrl?: string;
  /** Directory for JSONL step traces and copied screenshots. */
  traceDir?: string;
}

/** The slice of Pi's extension API the extension uses. */
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

/** A Pi extension entrypoint: registers the tools and lifecycle handlers. */
export type PiExtension = (pi: PiExtensionApiLike) => void;

/** JSON Schemas for the registered tools, exported for tests and audits. */
export const PI_BROWSER_PARAMETERS: Readonly<object>;
export const PI_LOGIN_PARAMETERS: Readonly<object>;
export const PI_EVIDENCE_PARAMETERS: Readonly<object>;

/**
 * Build the extension `pi install npm:betterwright` loads: registers
 * `browser`, `browser_download`, `browser_evidence`, and `browser_login`
 * (the last only when the vault is enabled), keeps one browser session
 * alive, and appends the operator guidance to the system prompt.
 * See SETUP.md §2.
 */
export function createPiExtension(options?: PiExtensionOptions): PiExtension;

declare const extension: PiExtension;
export default extension;
