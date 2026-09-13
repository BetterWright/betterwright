// A private supervisor owns the inference child. Stop requests authenticate
// to the supervisor; stale PID files never cause an unrelated process kill.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mkdirPrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import { decodeLocalPlan, draftDirectory, GIB, type LocalPlan, localInstallArtifacts, localModel, localPlanId, localRoot, modelDirectory, readLocalPlan, writeLocalJson } from "./local-ai.js";
import { localRuntimeEnvironment, localRuntimeExecutable, verifyLocalArtifact, withLocalLock } from "./local-ai-install.js";
import { localProcessInstance, localProcessIsGone } from "./local-ai-process.js";
import { isNumber, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

export const LOCAL_MODEL_ALIAS = "betterwright-local";
interface LocalService {
  controlPort: number;
  port: number;
  token: string;
  planId: string;
  supervisorPid: number;
  childPid: number;
  supervisorInstance?: string;
  childInstance?: string;
}
export interface LocalConnection { baseURL: string; apiKey: string; model: string; started?: boolean; }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function serviceFile(home: string) { return path.join(localRoot(home), "service.json"); }
function readService(home: string): LocalService | null {
  try {
    const data: UntrustedValue = JSON.parse(fs.readFileSync(serviceFile(home), "utf8"));
    const controlPort = untrustedField(data, "controlPort"), port = untrustedField(data, "port"), token = untrustedField(data, "token"), planId = untrustedField(data, "planId");
    const supervisorPid = untrustedField(data, "supervisorPid"), childPid = untrustedField(data, "childPid");
    if (!isNumber(supervisorPid) || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 0 || !isNumber(childPid) || !Number.isSafeInteger(childPid) || childPid < 0 ||
      !isNumber(port) || !Number.isInteger(port) || port < 1 || port > 65535 || !isNumber(controlPort) || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 ||
      !isString(token) || !/^[a-f0-9]{64}$/.test(token) || !isString(planId) || !/^[a-f0-9]{24}$/.test(planId)) return null;
    const supervisorInstance = untrustedField(data, "supervisorInstance"), childInstance = untrustedField(data, "childInstance");
    return { controlPort, port, token, planId, supervisorPid, childPid,
      supervisorInstance: isString(supervisorInstance) && supervisorInstance.length <= 200 ? supervisorInstance : "",
      childInstance: isString(childInstance) && childInstance.length <= 200 ? childInstance : "" };
  } catch { return null; }
}
async function control(service: LocalService, command: "status" | "stop") {
  const response = await fetch(`http://127.0.0.1:${service.controlPort}/${command}`, {
    method: command === "stop" ? "POST" : "GET", headers: { authorization: `Bearer ${service.token}` },
    signal: AbortSignal.timeout(2000), redirect: "error",
  });
  if (!response.ok) throw new Error("The saved local runtime is not responding to its private control key.");
  const body: UntrustedValue = await response.json();
  if (untrustedField(body, "planId") !== service.planId) throw new Error("The saved local runtime identity does not match.");
  return body;
}
function childGroupIsGone(service: LocalService) {
  if (process.platform === "win32" || service.childInstance && localProcessIsGone(service.childPid, service.childInstance)) return localProcessIsGone(service.childPid, service.childInstance);
  if (service.childPid <= 0) return false;
  try { process.kill(-service.childPid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
}
function ownersAreGone(service: LocalService) { return localProcessIsGone(service.supervisorPid, service.supervisorInstance) && localProcessIsGone(service.childPid, service.childInstance) && childGroupIsGone(service); }
const OWNERSHIP_ERROR = "The local supervisor is unreachable, but its processes may still be alive. Ownership was retained; no replacement was started. Resume or stop the recorded runtime processes, then retry local stop. See local-ai/runtime.log and local-ai/service.json.";
function removeService(service: LocalService, home: string) {
  if (readService(home)?.token === service.token) fs.rmSync(serviceFile(home), { force: true });
}
export async function localServiceStatus(home = defaultHome()) {
  const service = readService(home);
  if (!service) return fs.existsSync(serviceFile(home))
    ? { running: true, ready: false, error: "Invalid local service state; ownership must be repaired before restart." }
    : { running: false, ready: false };
  try {
    const status = await control(service, "status");
    return { running: true, ready: untrustedField(status, "ready") === true, planId: service.planId,
      endpoint: `http://127.0.0.1:${service.port}/v1` };
  } catch {
    return ownersAreGone(service) ? { running: false, ready: false }
      : { running: true, ready: false, planId: service.planId, error: OWNERSHIP_ERROR };
  }
}
export async function stopLocalService(home = defaultHome()): Promise<boolean> {
  return withLocalLock(home, "lifecycle", () => stopLocalServiceUnlocked(home), 10 * 60_000 + 10_000);
}
/** Setup may only clean up the exact service whose probe it started. */
export async function stopLocalServiceIfOwned(home: string, token: string): Promise<boolean> {
  return withLocalLock(home, "lifecycle", async () => {
    if (readService(home)?.token !== token) return false;
    return stopLocalServiceUnlocked(home);
  }, 10 * 60_000 + 10_000);
}
function startupFailure(home: string, offset: number): Error {
  const logfile = path.join(localRoot(home), "runtime.log");
  let detail = "";
  try {
    const fd = fs.openSync(logfile, "r");
    try {
      const bytes = Buffer.alloc(Math.min(128 * 1024, Math.max(0, fs.fstatSync(fd).size - offset)));
      fs.readSync(fd, bytes, 0, bytes.length, offset);
      // Report startup exception summaries, never full requests or configs.
      detail = bytes.toString("utf8").split(/\r?\n/).filter(line => /(?:ImportError|ModuleNotFoundError|RuntimeError|ValueError|AssertionError|FileNotFoundError|OSError|error):/.test(line))
        .slice(0, 12).join("\n").replace(/[a-f0-9]{64}/gi, "<redacted>").slice(0, 2400);
    } finally { fs.closeSync(fd); }
  } catch { /* The logfile path is still actionable if it cannot be read. */ }
  return new Error(`The local runtime could not start. Check ${logfile}; no cloud fallback was used.${detail ? `\n${detail}` : ""}`);
}
async function stopLocalServiceUnlocked(home: string): Promise<boolean> {
  const service = readService(home);
  if (!service) {
    if (fs.existsSync(serviceFile(home))) throw new Error("Invalid local service state; ownership must be repaired before restart.");
    return false;
  }
  try { await control(service, "stop"); }
  catch { if (ownersAreGone(service)) { removeService(service, home); return false; } throw new Error(OWNERSHIP_ERROR); }
  for (let attempt = 0; attempt < 80; attempt++) {
    if (localProcessIsGone(service.childPid, service.childInstance) && childGroupIsGone(service) && (!fs.existsSync(serviceFile(home)) || ownersAreGone(service))) { removeService(service, home); return true; }
    await pause(100);
  }
  throw new Error("The local runtime is still shutting down. Check local-ai/runtime.log and retry local stop.");
}
export function localServerArguments(plan: LocalPlan, port: number, home = defaultHome()): string[] {
  const directory = modelDirectory(plan, home), model = localModel(plan);
  if (plan.runtime === "vllm") {
    const speculative = plan.acceleration === "dflash2" ? { method: "dflash", model: draftDirectory(home), num_speculative_tokens: 7 } :
      plan.acceleration === "mtp" ? { method: "mtp", num_speculative_tokens: 3 } : null;
    return ["serve", directory, "--host", "127.0.0.1", "--port", String(port), "--served-model-name", LOCAL_MODEL_ALIAS,
      "--max-model-len", String(plan.context), "--max-num-seqs", "1", "--gpu-memory-utilization", "0.85",
      "--kv-cache-dtype", "fp8_e4m3", "--reasoning-parser", "qwen3", "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_coder",
      "--enable-chunked-prefill", "--max-num-batched-tokens", "2048", "--disable-uvicorn-access-log",
      ...(plan.gpu.memory < 40 * GIB ? ["--enforce-eager"] : []),
      ...(speculative ? ["--speculative-config", JSON.stringify(speculative)] : [])];
  }
  const weights = model.files.find(f => !f.name.startsWith("mmproj-"));
  const vision = model.files.find(f => f.name.startsWith("mmproj-"));
  if (!weights || !vision) throw new Error("The local model is missing its pinned vision projector.");
  return ["--model", path.join(directory, weights.name), "--mmproj", path.join(directory, vision.name),
    "--host", "127.0.0.1", "--port", String(port), "--alias", LOCAL_MODEL_ALIAS, "--ctx-size", String(plan.context),
    "--parallel", "1", "--device", plan.gpu.id, "--split-mode", "none", "--gpu-layers", "999", "--flash-attn", "on",
    "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--batch-size", "512", "--ubatch-size", "128",
    "--image-max-tokens", "4096", "--jinja", "--reasoning-format", "deepseek", "--no-webui",
    ...(plan.acceleration === "mtp" ? ["--spec-type", "draft-mtp", "--spec-draft-n-max", "3", "--spec-draft-device", plan.gpu.id, "--spec-draft-ngl", "999"] : []),
    "--chat-template-kwargs", JSON.stringify(plan.modelId === "nex-mini" ? { reasoning_effort: "medium" } : { enable_thinking: false })];
}
export async function ensureLocalService(plan: LocalPlan, home = defaultHome(), timeoutMs = 10 * 60_000, verify: typeof verifyLocalArtifact = verifyLocalArtifact): Promise<LocalConnection> {
  if (plan.platform !== process.platform || plan.arch !== process.arch) throw new Error("This local AI installation belongs to different hardware. Run betterwright --local on this machine.");
  const planId = localPlanId(plan);
  return withLocalLock(home, "lifecycle", async () => {
    const existing = readService(home);
    if (!existing && fs.existsSync(serviceFile(home))) throw new Error("Invalid local service state; ownership must be repaired before restart.");
    if (existing) {
      const status = await control(existing, "status").catch(() => null);
      if (!status) {
        if (!ownersAreGone(existing)) throw new Error(OWNERSHIP_ERROR);
        removeService(existing, home);
      }
      if (status && existing.planId !== planId) throw new Error("Another managed model is running. Run betterwright local stop before changing models.");
      if (status && untrustedField(status, "ready") === true) return { baseURL: `http://127.0.0.1:${existing.port}/v1`, apiKey: existing.token, model: LOCAL_MODEL_ALIAS, started: false };
    }
    localRuntimeExecutable(plan, home);
    for (const { artifact: file, directory } of localInstallArtifacts(plan, home)) {
      const target = path.join(directory, file.name);
      if (!await verify(target, file)) throw new Error("Local model files are missing, incomplete, or failed their checksum. Run betterwright --local to resume setup.");
    }
    writeLocalJson(path.join(localRoot(home), "plans", `${planId}.json`), plan);
    const current = await localServiceStatus(home);
    let daemon: ChildProcess | null = null;
    let logOffset = 0;
    if (!current.running) {
      const logfile = path.join(localRoot(home), "runtime.log");
      const log = fs.openSync(logfile, "a", 0o600);
      logOffset = fs.fstatSync(log).size;
      try {
        daemon = spawn(process.execPath, [fileURLToPath(new URL("../bin/betterwright.js", import.meta.url)), "__local-ai", planId], {
          env: { ...process.env, BETTERWRIGHT_HOME: home }, detached: true, windowsHide: true, stdio: ["ignore", log, log],
        });
        daemon.on("error", () => {});
        daemon.unref();
      } finally { fs.closeSync(log); }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw startupFailure(home, logOffset);
      const service = readService(home);
      if (service?.planId === planId) {
        const status = await control(service, "status").catch(() => null);
        if (status && untrustedField(status, "ready") === true) return { baseURL: `http://127.0.0.1:${service.port}/v1`, apiKey: service.token, model: LOCAL_MODEL_ALIAS, started: Boolean(daemon) };
      }
      await pause(500);
    }
    await stopLocalServiceUnlocked(home);
    throw new Error(`Local model startup timed out. Check ${path.join(localRoot(home), "runtime.log")}.`);
  });
}
export async function configuredLocalConnection(home = defaultHome()) {
  const plan = readLocalPlan(home);
  if (!plan) throw new Error("No local model is configured. Run betterwright --local first.");
  return { plan, connection: await ensureLocalService(plan, home) };
}
async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || isString(address)) throw new Error("Could not allocate a loopback model port.");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
export async function serveLocalAI(planId: string, home = defaultHome(), launch: typeof spawn = spawn): Promise<number> {
  if (!/^[a-f0-9]{24}$/.test(planId)) throw new Error("Invalid managed local model ID.");
  const plan = decodeLocalPlan(JSON.parse(fs.readFileSync(path.join(localRoot(home), "plans", `${planId}.json`), "utf8")));
  if (localPlanId(plan) !== planId || plan.platform !== process.platform || plan.arch !== process.arch) throw new Error("The local model plan changed before startup or belongs to another platform.");
  const port = await unusedPort(), token = randomBytes(32).toString("hex");
  let ready = false, stopping = false;
  let child: ChildProcess | null = null;
  const expected = Buffer.from(`Bearer ${token}`);
  let state: LocalService;
  let finish: () => Promise<void>;
  const server = http.createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
    const allowed = request.method === "GET" && request.url === "/status" || request.method === "POST" && request.url === "/stop";
    if (!allowed) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ planId, ready: ready && !stopping }));
    if (request.url === "/stop") void finish();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || isString(address)) throw new Error("Could not allocate the local supervisor port.");
  state = { controlPort: address.port, port, token, planId, supervisorPid: process.pid, childPid: 0 };
  mkdirPrivate(localRoot(home));
  const env: NodeJS.ProcessEnv = { ...localRuntimeEnvironment(plan, home), LLAMA_API_KEY: token, VLLM_API_KEY: token, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
  if (plan.runtime === "vllm" && plan.gpu.uuid) env.CUDA_VISIBLE_DEVICES = plan.gpu.uuid;
  let childDone = Promise.resolve();
  let probe: ReturnType<typeof setInterval> | null = null;
  const onSignal = () => void finish();
  const closed = new Promise<void>(resolve => server.once("close", resolve));
  finish = async () => {
    if (stopping) return;
    stopping = true;
    if (probe) clearInterval(probe);
    // Own the actual child handle/group, including failed state publication.
    const signal = (name: NodeJS.Signals) => {
      if (!child) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
        else if (child.exitCode === null && child.signalCode === null) child.kill(name);
      } catch (error) { if (error?.code !== "ESRCH") throw error; }
    };
    try {
      signal("SIGTERM");
      const force = setTimeout(() => signal("SIGKILL"), 5000);
      try { await childDone; } finally { clearTimeout(force); }
      signal("SIGKILL");
    } finally {
      try {
        if (readService(home)?.token === state.token) fs.rmSync(serviceFile(home), { force: true });
        fs.rmSync(`${serviceFile(home)}.${process.pid}.tmp`, { force: true });
      } finally {
        process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
        server.closeAllConnections(); server.close();
      }
    }
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    // API keys stay out of argv/logged launch commands and all status output.
    child = launch(localRuntimeExecutable(plan, home), localServerArguments(plan, port, home), { env, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    childDone = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    state.childPid = child.pid || 0;
    state.childInstance = localProcessInstance(state.childPid) || "";
    state.supervisorInstance = localProcessInstance(process.pid) || "";
    writeLocalJson(serviceFile(home), state);
    let probeBusy = false;
    probe = setInterval(async () => {
      if (probeBusy || stopping) return;
      probeBusy = true;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000), redirect: "error" });
        const body: UntrustedValue = await response.json();
        const models = untrustedField(body, "data");
        ready = response.ok && Array.isArray(models) && models.some(m => untrustedField(m, "id") === LOCAL_MODEL_ALIAS);
      } catch { ready = false; }
      finally { probeBusy = false; }
    }, 1000);
    void childDone.then(() => finish());
    await closed;
  } catch (error) { await finish(); await closed; throw error; }
  return 0;
}
