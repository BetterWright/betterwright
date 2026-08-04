import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { nativeModelCatalog, runAgentTask } from "./agent.js";
import { loadCodexAuth, loadGrokAuth } from "./auth.js";
import { BetterWright } from "./client.js";
import { doctorReport } from "./doctor.js";
import { NetworkPolicy } from "./policy.js";

interface HostRequest {
  operation: string;
  args: unknown[];
}

function policyOptions(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const options = value as Record<string, unknown>;
  return {
    allowPrivateNetwork: options.allowPrivateNetwork !== false,
    allowLoopback: options.allowLoopback !== false,
    allowHosts: Array.isArray(options.allowHosts) ? options.allowHosts.map(String) : [],
    blockHosts: Array.isArray(options.blockHosts) ? options.blockHosts.map(String) : [],
  };
}

async function run(request: HostRequest): Promise<unknown> {
  const args = request.args || [];
  switch (request.operation) {
    case "run": {
      const code = String(args[0] || "");
      const session = String(args[1] || "default");
      const browser = new BetterWright({ policy: new NetworkPolicy(policyOptions(args[2])) });
      try {
        return await browser.run(code, { session });
      } finally {
        await browser.close();
      }
    }
    case "exec":
      return runAgentTask({
        task: String(args[0] || ""),
        ...(args[1] ? { model: String(args[1]) } : {}),
        session: String(args[2] || "default"),
      });
    case "doctor":
      return doctorReport();
    case "models":
      return nativeModelCatalog();
    case "close": {
      const browser = new BetterWright();
      return browser.closeSession(String(args[0] || "default"));
    }
    case "sessions":
      return runNativeCli(["sessions"]);
    case "auth": {
      const provider = String(args[0] || "").toLowerCase();
      if (provider === "codex") return loadCodexAuth();
      if (provider === "grok") return loadGrokAuth();
      throw new Error(`Unsupported auth provider: ${provider}`);
    }
    default:
      throw new Error(`Unknown LOLCODE host operation: ${request.operation}`);
  }
}

function runNativeCli(args: string[]): { exitCode: number; output: string } {
  const entry = process.env.BETTERWRIGHT_CLI_ENTRY;
  if (!entry) return { exitCode: 1, output: "BETTERWRIGHT_CLI_ENTRY is not configured" };
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  return { exitCode: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}` };
}

async function main() {
  const request = JSON.parse(fs.readFileSync(0, "utf8")) as HostRequest;
  const result = await run(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.stack || String(error) }));
  process.exitCode = 1;
});
