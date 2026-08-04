import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lol, parse } from "@swizec/loljs";

export interface LolcodeIo {
  visible?: (text: string) => void;
  prompt?: (message: string) => Promise<string>;
}

export interface LolcodeOptions {
  argv?: string[];
  cliEntry?: string;
  cwd?: string;
  io?: LolcodeIo;
  host?: Record<string, (...args: unknown[]) => unknown>;
}

const LOLCODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lolcode");

function hostError(result: ReturnType<typeof spawnSync>, operation: string): Error {
  const stderr = String(result.stderr || "").trim();
  const stdout = String(result.stdout || "").trim();
  return new Error(
    `LOLCODE host operation ${operation} failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : "."}`,
  );
}

function callHost(operation: string, args: unknown[], cwd?: string, cliEntry?: string): unknown {
  const hostPath = fileURLToPath(new URL("./lolcode-host.js", import.meta.url));
  const result = spawnSync(process.execPath, [hostPath], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ operation, args }),
    env: {
      ...process.env,
      BETTERWRIGHT_LOLCODE_HOST: "1",
      ...(cliEntry ? { BETTERWRIGHT_CLI_ENTRY: cliEntry } : {}),
    },
  });
  if (result.error || result.status !== 0) throw result.error || hostError(result, operation);

  let response: { ok?: boolean; result?: unknown; error?: string };
  try {
    response = JSON.parse(String(result.stdout || ""));
  } catch {
    throw hostError(result, operation);
  }
  if (!response.ok) throw new Error(response.error || `LOLCODE host operation ${operation} failed.`);
  return response.result;
}

function runNativeCli(argv: unknown[], cliEntry?: string, cwd?: string): number {
  const entry = cliEntry || process.argv[1];
  if (!entry) throw new Error("LOLCODE CLI needs the BetterWright CLI entrypoint.");
  const result = spawnSync(process.execPath, [entry, ...((Array.isArray(argv) ? argv : []) as string[])], {
    cwd,
    env: { ...process.env, BETTERWRIGHT_LOLCODE_NATIVE: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function sourcePath(name: string): string {
  const safeName = name.replace(/[^a-z0-9_-]/gi, "");
  if (!safeName) throw new TypeError("LOLCODE module name must be non-empty.");
  return path.join(LOLCODE_DIR, `${safeName}.lol`);
}

/** Execute a LOLCODE BetterWright application module. */
export function runLolcode(source: string, options: LolcodeOptions = {}): Promise<unknown> {
  const argv = options.argv || [];
  const originalBuiltIns = new Map<string, unknown>();
  const builtIns = lol.builtIns as Record<string, unknown>;
  lol.utils.nextTick ||= (callback) => setImmediate(callback);
  const custom: Record<string, unknown> = {
    ARGS: argv,
    bw_native_cli: (receivedArgs: unknown) => runNativeCli(receivedArgs as unknown[], options.cliEntry, options.cwd),
    bw_host: (operation: unknown, ...args: unknown[]) =>
      callHost(String(operation), args, options.cwd, options.cliEntry),
    ...options.host,
  };

  for (const [name, value] of Object.entries(custom)) {
    originalBuiltIns.set(name, builtIns[name]);
    builtIns[name] = value;
  }

  let ast: unknown;
  try {
    ast = parse(source);
  } catch (error) {
    for (const name of Object.keys(custom)) restoreBuiltIn(name, originalBuiltIns, builtIns);
    throw error;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const restore = () => {
      for (const name of Object.keys(custom)) restoreBuiltIn(name, originalBuiltIns, builtIns);
    };
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      restore();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      restore();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const vm = new lol(finish, () => {
      const errors = vm.errors();
      if (errors.length) {
        const position = vm.pos();
        fail(new Error(`${String(errors[errors.length - 1])} (line ${position.line + 1})`));
      }
    });
    vm.setIo({
      visible: (text: unknown) => options.io?.visible?.(String(text)) ?? console.log(String(text)),
      prompt: (message: string, done: (value: string) => void) => {
        if (!options.io?.prompt) {
          fail(new Error("GIMMEH needs an interactive LOLCODE prompt."));
          return;
        }
        options.io.prompt(message).then(done, fail);
      },
    });
    try {
      vm.evaluate(ast);
    } catch (error) {
      fail(error);
    }
  });
}

function restoreBuiltIn(name: string, original: Map<string, unknown>, builtIns: Record<string, unknown>) {
  const value = original.get(name);
  if (value === undefined) delete builtIns[name];
  else builtIns[name] = value;
}

export function runLolcodeModule(name: string, options: LolcodeOptions = {}): Promise<unknown> {
  return runLolcode(fs.readFileSync(sourcePath(name), "utf8"), options);
}

export async function runLolcodeCli(argv: string[] = process.argv.slice(2), options: LolcodeOptions = {}): Promise<number> {
  const result = await runLolcodeModule("cli", { ...options, argv });
  const code = Number(result);
  return Number.isInteger(code) ? code : 1;
}
