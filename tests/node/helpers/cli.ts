import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");

// Keep the test event loop free while waiting for the CLI. A synchronous child
// wait can hang a parallel test worker on macOS, beyond the test's own timeout.
export function runCli(args, { timeout = 20_000, env = {}, entrypoint = cli } = {}) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [entrypoint, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      env: { ...process.env, ...env },
    }, (_error, stdout, stderr) => {
      resolve({ status: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    // Close stdin so a command that reads it cannot wait for more input.
    child.stdin?.end();
  });
}
