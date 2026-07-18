import type { BetterWright } from "./client.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";
import type { Guardrails } from "./prompt.js";

/** Per-request auth an OAuth adapter resolves before each model call. */
export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

/** A tool call the model asked the harness to run. */
export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A neutral transcript turn the harness passes to a model adapter. */
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; results: Array<{ id: string; name: string; content: string }> };

/** A tool definition exposed to the model. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The pluggable model interface. Implement `complete` to bring your own. */
export interface AgentModel {
  name?: string;
  modelId?: string;
  complete(request: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<{ text: string; toolCalls: AgentToolCall[]; stopReason?: string; usage?: AgentUsage | null }>;
}

/** Token usage, normalized across model adapters (0 when a provider omits it). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentStepEvent {
  step: number;
  tool: string;
  note?: string;
}

export interface RunAgentTaskOptions {
  task: string;
  model?: string | AgentModel;
  modelOptions?: Record<string, unknown>;
  browser?: BetterWright;
  guardrails?: Guardrails;
  maxSteps?: number;
  session?: string;
  headless?: boolean | "auto";
  policy?: NetworkPolicy;
  /** Ignored when an external `browser` is passed — that browser's own vault decides login availability. */
  vault?: CredentialVault;
  onStep?: (event: AgentStepEvent) => void;
  /**
   * When provided, the loop exposes an `ask` tool so the model can put a
   * question to the user mid-task; the returned string is fed back as the
   * answer. Omit it (the `exec` default) to run fully autonomously with no
   * `ask` tool.
   */
  askUser?: (question: { question: string; options: string[] }) => string | Promise<string>;
}

export interface AgentResult {
  ok: boolean;
  answer: string;
  steps: number;
  reason: "max-steps" | "answered" | "stopped" | "done";
  /** How many tool calls the model issued; can exceed `steps` when a turn batches several. */
  toolCalls: number;
  /** Summed token usage the model adapters reported (fields are 0 when unavailable). */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  transcript: AgentMessage[];
  proof: string | null;
}

export function runAgentTask(options: RunAgentTaskOptions): Promise<AgentResult>;

export function resolveModel(model: string | AgentModel, modelOptions?: Record<string, unknown>): AgentModel;

export interface ClaudeModelOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: unknown;
}
export function claudeModel(options?: ClaudeModelOptions): AgentModel;

export interface OpenAIModelOptions {
  baseURL?: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  effort?: string;
  name?: string;
  getAuth?: () => ResolvedAuth | Promise<ResolvedAuth>;
  fetchImpl?: typeof fetch;
}
export function openaiModel(options: OpenAIModelOptions): AgentModel;

export interface OAuthModelOptions {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  /** `"responses"` forces the Responses protocol against an API-key endpoint. */
  protocol?: "responses" | "chat";
  headers?: Record<string, string>;
  name?: string;
  maxTokens?: number;
  effort?: string;
  fetchImpl?: typeof fetch;
}
export function codexModel(options?: OAuthModelOptions): AgentModel;
export function grokModel(options?: OAuthModelOptions): AgentModel;
