import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  CommandOptions,
  CommandResult,
  E2ECase,
  E2EContext,
} from "./types.js";

export interface RunnerOptions {
  binary: string;
  binaryArgs: string[];
  report: string;
  groups: string[];
  filter: string;
  timeoutMs: number;
  caseTimeoutMs: number;
  keepWork: boolean;
  requireAll: boolean;
  list: boolean;
  help: boolean;
}

export interface CaseResult {
  id: string;
  group: string;
  title: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  stack?: string;
  reason?: string;
  workDir?: string;
}

export class SkipCase extends Error {}

function isTcpAddress(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object";
}

export function parseOptions(args: string[]): RunnerOptions {
  const options: RunnerOptions = {
    binary: "betterwright",
    binaryArgs: [],
    report: path.resolve(".tmp/e2e-report.json"),
    groups: [],
    filter: "",
    timeoutMs: 45_000,
    caseTimeoutMs: 180_000,
    keepWork: false,
    requireAll: false,
    list: false,
    help: false,
  };
  let binarySet = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--keep-work", "--require-all", "--list", "--help", "-h"].includes(arg)) {
      if (arg === "--keep-work") options.keepWork = true;
      if (arg === "--require-all") options.requireAll = true;
      if (arg === "--list") options.list = true;
      if (arg === "--help" || arg === "-h") options.help = true;
      continue;
    }
    if (["--binary", "--binary-arg", "--report", "--group", "--filter", "--timeout", "--case-timeout"].includes(arg)) {
      const value = args[++index];
      if (!value || (value.startsWith("--") && arg !== "--binary-arg")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--binary") {
        if (binarySet) throw new Error("Specify the binary only once");
        options.binary = value;
        binarySet = true;
      }
      if (arg === "--binary-arg") options.binaryArgs.push(value);
      if (arg === "--report") options.report = path.resolve(value);
      if (arg === "--group") options.groups.push(value);
      if (arg === "--filter") options.filter = value;
      if (arg === "--timeout" || arg === "--case-timeout") {
        const milliseconds = Number(value);
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 3_600_000) {
          throw new Error(`${arg} must be an integer from 100 to 3600000 milliseconds`);
        }
        if (arg === "--timeout") options.timeoutMs = milliseconds;
        else options.caseTimeoutMs = milliseconds;
      }
      continue;
    }
    if (arg.startsWith("-") || binarySet) throw new Error(`Unexpected argument: ${arg}`);
    options.binary = arg;
    binarySet = true;
  }
  if (options.binary.includes("/") || options.binary.includes("\\")) {
    options.binary = path.resolve(options.binary);
  }
  for (const group of options.groups) {
    if (!["cli", "browser", "security", "protocol", "recording"].includes(group)) {
      throw new Error(`Unknown group: ${group}`);
    }
  }
  return options;
}

export function selectCases(cases: E2ECase[], options: RunnerOptions): E2ECase[] {
  const ids = new Set<string>();
  for (const entry of cases) {
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(entry.id)) throw new Error(`Invalid case id: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate case id: ${entry.id}`);
    ids.add(entry.id);
  }
  const selected = cases.filter((entry) =>
    (!options.groups.length || options.groups.includes(entry.group)) &&
    (!options.filter || `${entry.id} ${entry.title}`.includes(options.filter)),
  );
  if (!selected.length) throw new Error("No test cases matched; refusing an empty successful run");
  return selected;
}

export function isolatedEnvironment(workDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "COMSPEC", "ComSpec",
    "PATHEXT", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DISPLAY", "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR", "BETTERWRIGHT_FFMPEG_PATH",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const userHome = path.join(workDir, "user");
  const temp = path.join(workDir, "tmp");
  for (const dir of [userHome, temp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    HOME: userHome,
    USERPROFILE: userHome,
    XDG_CONFIG_HOME: path.join(userHome, ".config"),
    XDG_CACHE_HOME: path.join(userHome, ".cache"),
    XDG_DATA_HOME: path.join(userHome, ".local", "share"),
    APPDATA: path.join(userHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(userHome, "AppData", "Local"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    BETTERWRIGHT_HOME: path.join(workDir, "betterwright"),
    BETTERWRIGHT_NO_DAEMON: "0",
    BETTERWRIGHT_AD_BLOCK: "0",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C.UTF-8",
  });
  if (process.env.BETTERWRIGHT_CHROMIUM_PATH) {
    env.BETTERWRIGHT_CHROMIUM_PATH = process.env.BETTERWRIGHT_CHROMIUM_PATH;
  } else {
    env.BETTERWRIGHT_CHROMIUM_ROOT = process.env.BETTERWRIGHT_CHROMIUM_ROOT ||
      path.join(os.homedir(), ".betterwright", "chromium");
  }
  return env;
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

export function createContext(options: RunnerOptions, workDir: string) {
  const env = isolatedEnvironment(workDir);
  const children = new Set<ChildProcessWithoutNullStreams>();
  const cleanups: Array<() => Promise<void> | void> = [];
  const secrets = new Set<string>();
  let disposed = false;
  const sanitize = (text: string) => {
    let result = text;
    for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
      result = result.replaceAll(secret, "[redacted]");
    }
    return result;
  };
  const start = (args: string[], commandOptions: CommandOptions = {}, duringCleanup = false) => {
    if (disposed && !duringCleanup) throw new Error("Test context has already been disposed");
    const child = spawn(options.binary, [...options.binaryArgs, ...args], {
      cwd: workDir,
      env: { ...env, ...commandOptions.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    return child;
  };
  const command = (args: string[], commandOptions: CommandOptions = {}, duringCleanup = false) => new Promise<CommandResult>((resolve, reject) => {
    const child = start(args, commandOptions, duringCleanup);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | null = null;
    const timeoutMs = commandOptions.timeoutMs ?? options.timeoutMs;
    const timer = setTimeout(() => {
      failure = new Error(`Command ${args[0] || "(default)"} exceeded ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (channel: "stdout" | "stderr", chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) {
        failure = new Error(`Command ${args[0] || "(default)"} exceeded the 2 MiB output limit`);
        child.kill("SIGKILL");
        return;
      }
      if (channel === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(commandOptions.stdin ?? "");
  });
  const context: E2EContext = {
    home: env.BETTERWRIGHT_HOME,
    workDir,
    start,
    command,
    async json(args, commandOptions) {
      const result = await command(args, commandOptions);
      assert.equal(result.code, 0, sanitize(`${args[0]} failed: ${result.stderr}\n${result.stdout}`));
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new Error(sanitize(`${args[0]} did not return one JSON value: ${result.stdout.slice(0, 2_000)}`));
      }
    },
    async run(code, runOptions = {}) {
      const args = ["run", "--no-ad-block", "--no-auto-ui", "--session", runOptions.session || "e2e"];
      if (runOptions.profile) args.push("--profile", runOptions.profile);
      args.push(...(runOptions.args || []), "-c", code);
      const result = await command(args, runOptions);
      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw new Error(sanitize(`run did not return JSON (exit ${result.code}): ${result.stderr}\n${result.stdout.slice(0, 2_000)}`));
      }
      assert.ok(envelope && [true, false].includes(envelope.ok), "run must return an envelope with a boolean ok");
      if (envelope.ok) assert.equal(result.code, 0, "A successful envelope must have exit code 0");
      else assert.notEqual(result.code, 0, "A failed envelope must have a nonzero exit code");
      assert.notEqual(result.code, null, "run must exit normally rather than die from a signal");
      return envelope;
    },
    async serve(handler) {
      const server = http.createServer(handler);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!isTcpAddress(address)) throw new Error("Fixture server has no TCP address");
      const close = async () => {
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      };
      cleanups.push(close);
      return { origin: `http://127.0.0.1:${address.port}`, alternateOrigin: `http://localhost:${address.port}`, close };
    },
    cleanup(action) { cleanups.push(action); },
    skip(reason) { throw new SkipCase(reason); },
    redact(value) { if (value) secrets.add(value); },
  };
  return {
    context,
    sanitize,
    async dispose() {
      disposed = true;
      const failures: string[] = [];
      await Promise.all([...children].map(stopChild));
      try {
        if (fs.existsSync(context.home)) {
          const result = await command(["close", "--all"], { timeoutMs: 15_000 }, true);
          if (result.code !== 0) failures.push(`close --all exited ${result.code}: ${result.stderr}`);
        }
      } catch (error) {
        failures.push(String(error));
      }
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch (error) { failures.push(String(error)); }
      }
      if (failures.length) throw new Error(sanitize(`Cleanup failed: ${failures.join("; ")}`));
    },
  };
}

export async function runCase(entry: E2ECase, options: RunnerOptions, root: string, signal?: AbortSignal): Promise<CaseResult> {
  const workDir = fs.mkdtempSync(path.join(root, "t-"));
  const harness = createContext(options, workDir);
  const started = performance.now();
  const result: CaseResult = {
    id: entry.id,
    group: entry.group,
    title: entry.title,
    status: "passed",
    durationMs: 0,
  };
  let timer: ReturnType<typeof setTimeout>;
  let interrupted: () => void;
  try {
    signal?.throwIfAborted();
    await Promise.race([
      entry.run(harness.context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Case exceeded ${options.caseTimeoutMs}ms`)), options.caseTimeoutMs);
        interrupted = () => reject(new Error("Run interrupted"));
        signal?.addEventListener("abort", interrupted, { once: true });
      }),
    ]);
  } catch (error) {
    result.status = error instanceof SkipCase ? "skipped" : "failed";
    const detail = harness.sanitize(error instanceof Error ? error.message : String(error));
    if (result.status === "skipped") result.reason = detail;
    else {
      result.error = detail;
      if (error instanceof Error && error.stack) result.stack = harness.sanitize(error.stack);
    }
  } finally {
    clearTimeout(timer);
    if (interrupted) signal?.removeEventListener("abort", interrupted);
    try {
      await harness.dispose();
    } catch (error) {
      result.status = "failed";
      result.error = [result.error, harness.sanitize(String(error))].filter(Boolean).join("\n");
      delete result.reason;
    }
    if (options.keepWork || result.error?.includes("Cleanup failed:")) result.workDir = workDir;
    else {
      try {
        fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        result.status = "failed";
        result.error = [result.error, harness.sanitize(`Cleanup failed: ${String(error)}`)].filter(Boolean).join("\n");
        result.workDir = workDir;
        delete result.reason;
      }
    }
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

export function reportExitCode(results: CaseResult[], requireAll: boolean): number {
  if (!results.length || results.some((result) => result.status === "failed")) return 1;
  if (requireAll && results.some((result) => result.status === "skipped")) return 1;
  const cases = results.filter((result) => !result.id.startsWith("preflight."));
  if (!cases.length || cases.every((result) => result.status === "skipped")) return 1;
  return 0;
}
