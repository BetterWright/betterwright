import type { UntrustedValue } from "./untrusted-value.js";
import type { VaultMatchMode } from "./vault.js";

export type BrowserFlavor = "chromium-fork";
export type HeadlessMode = boolean | "auto";
export type PublicSearchPolicy = "block" | "allow";
export type DownloadPolicy = "ask" | "allow" | "deny";

export interface CredentialVault {
  handleRequest(
    action: string,
    payload: Record<string, UntrustedValue>,
    origin: string,
  ): UntrustedValue | Promise<UntrustedValue>;
  redact?(value: UntrustedValue): UntrustedValue;
  /** Called only after the owning worker and all of its pages are closed. */
  resetRedactionSecrets?(): void;
}

export interface BetterWrightArtifact {
  kind?: string;
  path?: string;
  media?: string;
  size?: number;
  [key: string]: UntrustedValue;
}

export interface SkillHint {
  name: string;
  description: string;
  path: string;
}

export interface ResultEnvelopeBase {
  console?: unknown[];
  events?: unknown[];
  artifacts?: BetterWrightArtifact[];
  warnings?: string[];
  challenges?: unknown[];
  pages?: unknown[];
  /** Skill packs whose autoInject.url patterns match an open page. */
  skills?: SkillHint[];
  /** One-time compact action directory when the active origin publishes WebAgents. */
  webagents?: unknown;
  /** One-time compact semantic action directory synthesized from an ordinary page. */
  ui?: unknown;
  profileMode?: string;
  durationMs?: number;
  envelopeTruncated?: boolean;
  /** Secret-free metadata for a generated credential that still needs recovery. */
  pendingCredential?: PendingCredentialRecovery;
}

export interface SuccessfulRunResult<T = unknown> extends ResultEnvelopeBase {
  ok: true;
  result: T;
  error?: never;
}

export interface FailedRunResult extends ResultEnvelopeBase {
  ok: false;
  error: string;
  result?: never;
}

export type RunResult<T = unknown> = SuccessfulRunResult<T> | FailedRunResult;

export interface RunOptions {
  session?: string;
  /** Optional host-facing status text. It is never evaluated in the browser sandbox. */
  note?: string;
  timeout?: number;
  approvedDownloads?: boolean;
}

// --- AgentBatch ------------------------------------------------------------
// The default two-call way for an agent to browse: `batch({url})` opens a
// page and returns its spec (an interactive snapshot), `batch(steps)` runs
// every step of the task in one worker round trip. See docs/agent-batch.md.

export type AgentBatchAction =
  | "goto"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "dblclick"
  | "hover"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "scroll"
  | "wait"
  | "read"
  | "url"
  | "snapshot"
  | "screenshot"
  | "openPage"
  | "usePage"
  | "closePage"
  | "dialog"
  | "overlays";

/**
 * Names exactly one element: one of `ref` (from the spec snapshot), `role`
 * (+ `name`), `label`, `text`, `placeholder`, `testId`, or `css`. `exact`
 * and `nth` refine the match; `frameName` or `frameUrlIncludes` scope it to
 * one iframe. An ambiguous target fails the step.
 */
export interface AgentBatchTarget {
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  testId?: string;
  css?: string;
  exact?: boolean;
  nth?: number;
  frameName?: string;
  frameUrlIncludes?: string;
}

/** One step as a caller writes it; fields beyond the action's own are rejected. */
export interface AgentBatchStepInput {
  action: AgentBatchAction;
  /** Defaults to `s<position>`; must be unique within the batch. */
  id?: string;
  target?: AgentBatchTarget;
  /** `goto` / `openPage` / `wait` (substring of the page URL). */
  url?: string;
  /** `goto` / `reload`. */
  waitUntil?: "load" | "domcontentloaded" | "commit" | "networkidle";
  /** `fill` / `type` text; `select` value or values (matched by value or label). */
  value?: string | string[];
  /** `type`: keep the field's current text instead of clearing it first. */
  append?: boolean;
  /** `press`: a key or chord such as `Enter` or `Control+a`. */
  key?: string;
  /** `scroll` without a target: wheel deltas in pixels. */
  dx?: number;
  dy?: number;
  /** `wait` with a target: the state to wait for (default `visible`). */
  state?: "attached" | "detached" | "visible" | "hidden";
  /** `wait`: visible text to wait for. */
  text?: string;
  /** `wait`: a bounded pause in milliseconds (at most 10000). */
  ms?: number;
  /** `read`: also return this attribute. */
  attribute?: string;
  /** `read`: return every match (up to 100) instead of requiring exactly one. */
  all?: boolean;
  /** `read` / `url`: substring the text, value, or URL must show before the step succeeds. */
  expect?: string;
  /** `snapshot` options; `interactive` defaults to true. */
  interactive?: boolean;
  ref?: string;
  selector?: string;
  diff?: boolean;
  depth?: number;
  maxChars?: number;
  urls?: boolean;
  /** `screenshot` options; `kind` defaults to `debug`. */
  kind?: "proof" | "question" | "debug";
  name?: string;
  fullPage?: boolean;
  annotate?: boolean;
  /** `usePage` / `closePage`: a page id or index. */
  page?: string | number;
  /** `dialog`: how to answer the next dialog. */
  response?: "accept" | "dismiss";
  promptText?: string;
  /** A failure is recorded but does not stop the batch. */
  optional?: boolean;
  /** Requires `allowIrreversible`. */
  irreversible?: boolean;
  /** Per-step budget in milliseconds (100–60000); unset uses the action or navigation default. */
  timeoutMs?: number;
}

export interface AgentBatchOptions {
  /** Required for steps that change page state (click, fill, press, …). */
  allowWrites?: boolean;
  allowIrreversible?: boolean;
  /** Fill a password the task itself supplied; stored secrets use the credential helpers. */
  allowPasswords?: boolean;
  /** The final observation: an interactive snapshot (default), its diff, or none. */
  observe?: "snapshot" | "diff" | "none";
  /** Capture a proof screenshot after every step succeeded. */
  proof?: boolean;
  /** Budget for in-flight requests to finish before an observation (0–5000, default 1000). */
  settleMs?: number;
  /** Pause between steps (0–1000, default 0). */
  minIntervalMs?: number;
}

/** What `batch()` accepts: the steps, or `{url}` for the spec call, or `{steps}`. */
export type AgentBatchInput =
  | AgentBatchStepInput[]
  | ({ url: string; steps?: undefined } & AgentBatchOptions)
  | ({ steps: AgentBatchStepInput[]; url?: undefined } & AgentBatchOptions);

export interface AgentBatchArtifact {
  kind: string;
  path: string;
  media: string;
}

export interface AgentBatchReading {
  tag: string;
  text: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  attribute?: string | null;
}

/** One step's outcome: `ok` plus whatever the action produced. */
export interface AgentBatchStepResult extends Partial<AgentBatchReading> {
  id: string;
  action: AgentBatchAction;
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  status?: number;
  filled?: number;
  typed?: number;
  pressed?: string;
  selected?: string[];
  scrolled?: string | { dx: number; dy: number };
  waited?: string;
  ms?: number;
  count?: number;
  items?: AgentBatchReading[];
  snapshot?: string;
  screenshot?: AgentBatchArtifact;
  pageId?: string;
  closed?: boolean;
  prepared?: "accept" | "dismiss";
  dismissed?: Array<{ kind: string; label: string }>;
}

export interface AgentBatchFailure {
  /** Position of the step that stopped the batch; resume from here. */
  index: number;
  id: string;
  action: AgentBatchAction;
  error: string;
}

export interface AgentBatchResult {
  protocol: "agent-batch/1";
  /** Every non-optional step succeeded. */
  ok: boolean;
  /** Steps that succeeded. */
  completed: number;
  total: number;
  failed?: AgentBatchFailure;
  steps: AgentBatchStepResult[];
  page: { id: string; url: string; title: string };
  /** The final observation, unless `observe` was `none` or it failed. */
  snapshot?: string;
  observeError?: string;
  proof?: AgentBatchArtifact;
  durationMs: number;
}

/** `batch()` options: the batch options plus the run options it forwards. */
export type AgentBatchRunOptions = AgentBatchOptions & RunOptions;

export interface FillCredentialOptions {
  /** Optional CSS or current `aria-ref=eN` target; omit for semantic detection. */
  passwordSelector?: string;
  /** Explicit current-password target for rotation with generated credentials. */
  currentPasswordSelector?: string;
  usernameSelector?: string;
  confirmPasswordSelector?: string;
  submitSelector?: string;
  /** Detect and click the matching form's submit control after filling. */
  submit?: boolean;
  id?: string;
  username?: string;
  session?: string;
  timeout?: number;
}

interface GeneratedCredentialOptions {
  length?: number;
  includeSymbols?: boolean;
  label?: string | null;
}

export type GenerateAndFillCredentialOptions =
  | (Omit<FillCredentialOptions, "id"> &
      GeneratedCredentialOptions & {
        id?: undefined;
        /** URL scope assigned to a new generated credential. Defaults to `"base-domain"`. */
        matchMode?: VaultMatchMode;
      })
  | (FillCredentialOptions &
      GeneratedCredentialOptions & {
        /** Rotate this stored record while preserving its existing URL scope. */
        id: string;
        matchMode?: never;
      });

export interface PendingCredentialRecovery {
  pendingId: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string | null;
  label: string | null;
  expiresAt: string | null;
}

export interface PendingCredentialOptions {
  pendingId: string;
  session?: string;
  timeout?: number;
}

export interface PendingCredentialListOptions {
  session?: string;
  timeout?: number;
}

export interface PendingCredentialMetadata extends PendingCredentialRecovery {
  id?: string;
  category: "login";
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface PendingCredentialPublicRecord {
  pendingId?: string;
  committed?: boolean;
  discarded?: boolean;
  [key: string]: UntrustedValue;
}

export interface CredentialPublicRecord {
  filled: Array<"username" | "currentPassword" | "password" | "confirmPassword">;
  submitted: boolean;
  [key: string]: UntrustedValue;
}

export type CredentialFillResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: CredentialPublicRecord;
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });

export type PendingCredentialResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: PendingCredentialPublicRecord;
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });

export type PendingCredentialListResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: PendingCredentialMetadata[];
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });
