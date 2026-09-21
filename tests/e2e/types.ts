import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RequestListener } from "node:http";

export interface CommandOptions {
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions extends CommandOptions {
  session?: string;
  profile?: string;
  args?: string[];
}

export interface FixtureServer {
  origin: string;
  alternateOrigin: string;
  close(): Promise<void>;
}

export interface E2EContext {
  home: string;
  workDir: string;
  command(args: string[], options?: CommandOptions): Promise<CommandResult>;
  start(args: string[], options?: CommandOptions): ChildProcessWithoutNullStreams;
  json(args: string[], options?: CommandOptions): Promise<any>;
  run(code: string, options?: RunOptions): Promise<any>;
  serve(handler: RequestListener): Promise<FixtureServer>;
  cleanup(action: () => Promise<void> | void): void;
  skip(reason: string): never;
  redact(value: string): void;
}

export interface E2ECase {
  id: string;
  group: "cli" | "browser" | "security" | "protocol" | "recording";
  title: string;
  requiresBrowser?: boolean;
  run(context: E2EContext): Promise<void>;
}
