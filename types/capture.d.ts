import type { BrowserContext, Page } from "playwright-core";
import type { VaultMatchMode } from "./vault.js";
import type { UntrustedValue } from "./untrusted-value.js";

/**
 * Wiring for `installVaultCapture`: how the sensor reaches the vault, maps
 * pages to sessions, and asks the host whether to save. The sensor never
 * returns a captured password; `shouldCapture` sees one only to approve or
 * reject the save.
 */
export interface CaptureOptions {
  /** Forward a vault action for a session, scoped to the page's origin. */
  vaultCallAtOrigin(session: CaptureSession, origin: string, action: string, payload: Record<string, UntrustedValue>): Promise<{ credentials?: Array<{ username: string }> }>;
  /** The session a page belongs to, for scoping vault lookups. */
  sessionForPage(page: Page): CaptureSession;
  /** Add a captured secret to the result redaction set. */
  trackSecret(value: string): void;
  /** Is the browser showing a window? Prompts only appear headed. */
  isHeaded(): boolean;
  /** Epoch ms of the model's last activity on this page; gates capture timing. */
  lastModelActivity(page: Page, origin: string): number;
  /** URL scope for saved credentials. */
  matchMode?: VaultMatchMode;
  /** Trusted host callback only. Captured passwords must never enter agent context. */
  shouldCapture?(capture: { page: Page; origin: string; username: string; password: string }): boolean | Promise<boolean>;
  /** Host-native save UI receives metadata, never a password. */
  requestSave?(request: { page: Page; origin: string; username: string; mode: "save" | "update" }): Promise<"save" | "dismiss" | "never">;
  capturePolicy?(): Promise<{ offerSave: boolean; autosave: boolean }>;
  onReady?(): void;
  onError?(error: Error): void;
  prefsPath?: string;
  gateMs?: number;
  confirmMs?: number;
  promptTtlMs?: number;
  modelWindowMs?: number;
}

/** The opaque session identity `sessionForPage` returns. */
export interface CaptureSession { id: string }
/** The http(s) origin of a URL, for vault scoping. */
export function httpOrigin(url: UntrustedValue): string;
/** One capture owner per context. Await disposal before attaching a replacement. */
export function installVaultCapture(context: BrowserContext, options: CaptureOptions): {
  dispose(): Promise<void>;
  isBusy(page: Page): boolean;
};
