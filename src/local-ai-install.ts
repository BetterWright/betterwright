import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { mkdirPrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import { GIB, type LocalPlan, localModel, localRoot, modelDirectory, runLocalProbe } from "./local-ai.js";
import type { LocalArtifact } from "./local-ai-catalog.js";
import { isNumber, untrustedField } from "./untrusted-value.js";

export const LLAMA_VERSION = "b10902";
export const VLLM_VERSION = "0.29.0";
const UV_VERSION = "0.12.13";
function llamaArchive(name: string, bytes: number, sha256: string): LocalArtifact {
  return { name, bytes, sha256, url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${name}` };
}
export const LOCAL_RUNTIMES = {
  metal: [llamaArchive("llama-b10902-bin-macos-arm64.tar.gz", 11140021, "9d6c0ac65ca25c3d2c5173ded6424b0b73ce147090fe56e78d70ae32bbeddfbe")],
  linux: [llamaArchive("llama-b10902-bin-ubuntu-vulkan-x64.tar.gz", 30154951, "ca717eeff2f86b6580e3b5f48b455645eff0cd6d3500a3d5c1e52a32a19c639a")],
  windows: [llamaArchive("llama-b10902-bin-win-vulkan-x64.zip", 31666258, "a75b13adaebbac980f24c52a7485b9620e96e21591da24b5a88142749f0d67c2")],
  cuda: [llamaArchive("llama-b10902-bin-win-cuda-13.3-x64.zip", 149706753, "621a763137e45f71eb3dc546f47150c0279a42b7711c5a230fb84efdb8ac9f0f"),
    llamaArchive("cudart-llama-bin-win-cuda-13.3-x64.zip", 390970417, "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e")],
};
const UV_ARCHIVE: LocalArtifact = { name: "uv-x86_64-unknown-linux-gnu.tar.gz", bytes: 19391575,
  sha256: "745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd",
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz` };
export type LocalLog = (message: string) => void;

export async function withLocalLock<T>(home: string, name: string, work: () => Promise<T>): Promise<T> {
  mkdirPrivate(localRoot(home));
  const lock = path.join(localRoot(home), `${name}.lock`);
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = 0;
    try { const pid = untrustedField(JSON.parse(fs.readFileSync(lock, "utf8")), "pid"); if (isNumber(pid) && pid > 0) owner = pid; } catch { /* Another process may still be writing the lock. */ }
    if (owner) {
      let dead = false;
      try { process.kill(owner, 0); } catch (probe) { dead = probe?.code === "ESRCH"; }
      if (dead) { fs.unlinkSync(lock); return withLocalLock(home, name, work); }
    }
    throw new Error(`Local AI ${name} is already in progress. Wait for it to finish and retry.`);
  }
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid })); return await work(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

async function hashFile(file: string, hash = createHash("sha256")) {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash;
}
export async function verifyLocalArtifact(file: string, artifact: LocalArtifact): Promise<boolean> {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === artifact.bytes && (await hashFile(file)).digest("hex") === artifact.sha256;
  } catch { return false; }
}
async function fetchArtifact(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  let next = url;
  for (let redirects = 0; redirects <= 8; redirects++) {
    if (new URL(next).protocol !== "https:") throw new Error("Local AI downloads must use HTTPS.");
    const response = await fetchImpl(next, { headers, redirect: "manual", signal: AbortSignal.timeout(30 * 60_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("The model download redirect has no destination.");
    next = new URL(location, next).href;
  }
  throw new Error("Too many redirects downloading a local AI artifact.");
}
/** Stream/resume verified bytes. Never buffer a model in JS memory. */
export async function downloadLocalArtifact(artifact: LocalArtifact, directory: string, { fetchImpl = fetch, log = console.log }: { fetchImpl?: typeof fetch; log?: LocalLog } = {}): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(artifact.name) || [".", ".."].includes(artifact.name) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error("Invalid local AI artifact manifest.");
  mkdirPrivate(directory);
  const file = path.join(directory, artifact.name);
  if (await verifyLocalArtifact(file, artifact)) { log(`Already downloaded: ${artifact.name}`); return file; }
  const partial = `${file}.part`;
  // A process can exit after the last byte but before the final rename.
  // Reuse that verified file instead of downloading many GiB again.
  if (await verifyLocalArtifact(partial, artifact)) { fs.renameSync(partial, file); return file; }
  let offset = 0;
  if (fs.existsSync(partial)) {
    const stat = fs.lstatSync(partial);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The partial model download is not a regular file.");
    offset = stat.size;
    if (offset >= artifact.bytes) { fs.unlinkSync(partial); offset = 0; }
  }
  const headers: Record<string, string> = {};
  if (offset) headers.range = `bytes=${offset}-`;
  const response = await fetchArtifact(artifact.url, headers, fetchImpl);
  if (!response.ok || !response.body) throw new Error(`Download failed for ${artifact.name} (HTTP ${response.status}); rerun betterwright --local to resume.`);
  if (response.status === 206) {
    if (response.headers.get("content-range") !== `bytes ${offset}-${artifact.bytes - 1}/${artifact.bytes}`) {
      await response.body.cancel(); throw new Error("The model server returned an unexpected byte range.");
    }
  } else offset = 0;
  const hash = offset ? await hashFile(partial) : createHash("sha256");
  const fd = fs.openSync(partial, offset ? "a" : "w", 0o600);
  const reader = response.body.getReader();
  let downloaded = offset, lastLog = 0;
  log(`Downloading ${artifact.name} (${(artifact.bytes / GIB).toFixed(2)} GiB)${offset ? " — resuming" : ""}`);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (downloaded + value.byteLength > artifact.bytes) throw new Error("The download exceeded its pinned size.");
      let written = 0;
      while (written < value.byteLength) written += fs.writeSync(fd, value, written, value.byteLength - written);
      hash.update(value); downloaded += value.byteLength;
      if (Date.now() - lastLog > 10_000) { log(`  ${Math.floor(downloaded / artifact.bytes * 100)}% — ${(downloaded / GIB).toFixed(2)} GiB`); lastLog = Date.now(); }
    }
  } finally { fs.closeSync(fd); await reader.cancel().catch(() => {}); }
  if (downloaded !== artifact.bytes) throw new Error("The model download was interrupted. Rerun the same command to resume.");
  if (hash.digest("hex") !== artifact.sha256) { fs.unlinkSync(partial); throw new Error(`Checksum mismatch for ${artifact.name}; the file was rejected.`); }
  fs.renameSync(partial, file);
  return file;
}

function findExecutable(directory: string, name: string): string | null {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return path.join(directory, entry.name);
    if (entry.isDirectory()) { const nested = findExecutable(path.join(directory, entry.name), name); if (nested) return nested; }
  }
  return null;
}
export function llamaRuntimeKey(platform: string, backend: string): keyof typeof LOCAL_RUNTIMES {
  if (platform === "darwin") return "metal";
  if (platform === "linux") return "linux";
  if (platform === "win32") return backend === "cuda" ? "cuda" : "windows";
  throw new Error("No managed inference runtime is published for this platform.");
}
export function runtimeDirectory(plan: LocalPlan, home = defaultHome()) {
  const id = plan.runtime === "vllm" ? `vllm-${VLLM_VERSION}` : `llama-${LLAMA_VERSION}-${llamaRuntimeKey(plan.platform, plan.gpu.backend)}`;
  return path.join(localRoot(home), "runtimes", id);
}
export function localRuntimeExecutable(plan: LocalPlan, home = defaultHome()) {
  const directory = runtimeDirectory(plan, home);
  const executable = plan.runtime === "vllm" ? path.join(directory, "venv", "bin", "vllm") :
    fs.existsSync(directory) ? findExecutable(directory, plan.platform === "win32" ? "llama-server.exe" : "llama-server") : null;
  if (!executable || !fs.existsSync(executable)) throw new Error("The managed local runtime is missing. Run betterwright --local to repair it.");
  return executable;
}
async function extractRuntime(archive: string, directory: string) {
  const listing = await runLocalProbe("tar", ["-tf", archive]);
  if (listing.trim().split(/\r?\n/).some(name => name.startsWith("/") || name.includes("\\") || /^[a-z]:/i.test(name) || name.split("/").includes(".."))) {
    throw new Error("Unsafe path in the pinned inference runtime archive.");
  }
  mkdirPrivate(directory);
  await runLocalProbe("tar", ["-xf", archive, "-C", directory]);
}
export async function installLlamaRuntime(platform: string, backend: string, home = defaultHome(), log: LocalLog = console.log): Promise<string> {
  const key = llamaRuntimeKey(platform, backend);
  const directory = path.join(localRoot(home), "runtimes", `llama-${LLAMA_VERSION}-${key}`);
  const ready = path.join(directory, ".ready");
  if (!fs.existsSync(ready)) {
    for (const artifact of LOCAL_RUNTIMES[key]) {
      const archive = await downloadLocalArtifact(artifact, path.join(localRoot(home), "downloads"), { log });
      await extractRuntime(archive, directory);
    }
  }
  const executable = findExecutable(directory, platform === "win32" ? "llama-server.exe" : "llama-server");
  if (!executable) throw new Error("The inference runtime archive contains no llama-server.");
  if (platform !== "win32") fs.chmodSync(executable, 0o755);
  await runLocalProbe(executable, ["--version"]);
  fs.writeFileSync(ready, LLAMA_VERSION, { mode: 0o600 });
  return executable;
}
function runInstall(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`The managed runtime installer failed (${signal || code}). Rerun betterwright --local to retry.`)); });
  });
}
export async function installLocalRuntime(plan: LocalPlan, home = defaultHome(), log: LocalLog = console.log) {
  if (plan.runtime !== "vllm") return installLlamaRuntime(plan.platform, plan.gpu.backend, home, log);
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The managed vLLM runtime requires Linux x64.");
  const directory = runtimeDirectory(plan, home);
  const ready = path.join(directory, ".ready");
  if (!fs.existsSync(ready)) {
    const uvDirectory = path.join(localRoot(home), "runtimes", `uv-${UV_VERSION}`);
    const archive = await downloadLocalArtifact(UV_ARCHIVE, path.join(localRoot(home), "downloads"), { log });
    await extractRuntime(archive, uvDirectory);
    const uv = findExecutable(uvDirectory, "uv");
    if (!uv) throw new Error("The pinned uv archive contains no executable.");
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(localRoot(home), "python"), UV_CACHE_DIR: path.join(localRoot(home), "uv-cache") };
    mkdirPrivate(directory);
    log(`Installing isolated Python 3.12 and vLLM ${VLLM_VERSION} (this can take several minutes).`);
    await runInstall(uv, ["venv", "--python", "3.12", "--managed-python", path.join(directory, "venv")], env);
    await runInstall(uv, ["pip", "install", "--python", path.join(directory, "venv", "bin", "python"), `vllm==${VLLM_VERSION}`], env);
    fs.writeFileSync(ready, VLLM_VERSION, { mode: 0o600 });
  }
  return localRuntimeExecutable(plan, home);
}
export async function checkLocalDisk(plan: LocalPlan, home = defaultHome()) {
  let existing = path.resolve(home);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const stats = fs.statfsSync(existing);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const directory = modelDirectory(plan, home);
  let pending = 0;
  for (const file of localModel(plan).files) {
    const complete = path.join(directory, file.name);
    if (await verifyLocalArtifact(complete, file)) continue;
    const partial = `${complete}.part`;
    if (await verifyLocalArtifact(partial, file)) continue;
    const stat = fs.existsSync(partial) ? fs.lstatSync(partial) : null;
    const downloaded = stat?.isFile() && stat.size < file.bytes ? stat.size : 0;
    pending += file.bytes - downloaded;
  }
  const installed = fs.existsSync(path.join(runtimeDirectory(plan, home), ".ready"));
  const required = pending + (installed ? 0 : plan.runtime === "vllm" ? 30 : 2) * GIB + 5 * GIB;
  if (available < required) throw new Error(`Local AI needs ${(required / GIB).toFixed(1)} GiB of free disk space including runtime and safety headroom; ${(available / GIB).toFixed(1)} GiB is available.`);
  return { available, required };
}
