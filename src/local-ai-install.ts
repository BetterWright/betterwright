import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { mkdirPrivate, writePrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import { GIB, type LocalPlan, localInstallArtifacts, localRoot, runLocalProbe } from "./local-ai.js";
import type { LocalArtifact } from "./local-ai-catalog.js";
import { LOCAL_VLLM_REQUIREMENTS } from "./local-ai-vllm-lock.js";
import { isNumber, untrustedField } from "./untrusted-value.js";

export const LLAMA_VERSION = "b10902";
export const VLLM_VERSION = "0.29.0";
const UV_VERSION = "0.12.13";
export const LOCAL_PYTHON_VERSION = "3.12.13";
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
export const ZIG_VERSION = "0.16.0";
const ZIG_ARCHIVE: LocalArtifact = { name: "zig-x86_64-linux-0.16.0.tar.xz", bytes: 55478392,
  sha256: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
  url: "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz" };
export type LocalLog = (message: string) => void;

/** Publish a complete owner record atomically; stale tombstones prevent late
 * recoverers from renaming a fresh replacement held by another process. */
export async function withLocalLock<T>(home: string, name: string, work: () => Promise<T>, waitMs = 0): Promise<T> {
  mkdirPrivate(localRoot(home));
  const lock = path.join(localRoot(home), `${name}.lock`);
  const candidate = `${lock}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`;
  mkdirPrivate(candidate);
  writePrivate(path.join(candidate, "owner.json"), JSON.stringify({ pid: process.pid }));
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    for (;;) {
      try {
        // Windows rename may replace a file with a directory. Never use
        // rename itself to detect a legacy file or an empty lock directory.
        if (fs.lstatSync(lock, { throwIfNoEntry: false })) throw Object.assign(new Error("Lock exists"), { code: "EEXIST" });
        fs.renameSync(candidate, lock); acquired = true; break;
      }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOTDIR", "EISDIR"].includes(error?.code)) throw error;
        let stat: fs.Stats;
        try { stat = fs.lstatSync(lock); } catch (readError) { if (readError?.code === "ENOENT") continue; throw readError; }
        if (stat.isSymbolicLink()) throw new Error("The local AI lock must not be a symbolic link.");
        let owner = 0;
        try {
          const ownerFile = stat.isDirectory() ? path.join(lock, "owner.json") : lock;
          const pid = untrustedField(JSON.parse(fs.readFileSync(ownerFile, "utf8")), "pid");
          if (isNumber(pid) && Number.isSafeInteger(pid) && pid > 0) owner = pid;
        } catch { /* Only abandoned, aged ownerless locks may be reclaimed. */ }
        let stale = !owner && Date.now() - stat.mtimeMs >= 30_000;
        if (owner) { try { process.kill(owner, 0); } catch (probe) { stale = probe?.code === "ESRCH"; } }
        if (stale) {
          if (stat.isFile()) {
            // Legacy file locks predate atomic directory publication.
            // unlink cannot remove a fresh directory lock if another
            // contender has already recovered and acquired this path.
            try { fs.unlinkSync(lock); continue; }
            catch (reclaim) {
              if (reclaim?.code === "ENOENT") continue;
              if (fs.lstatSync(lock, { throwIfNoEntry: false })?.isDirectory()) continue;
              throw reclaim;
            }
          }
          const fingerprint = createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest("hex").slice(0, 24);
          const tombstone = `${lock}.stale-${fingerprint}`;
          try {
            // Our published directories always contain owner.json. Make an
            // abandoned empty directory non-empty before retaining it too.
            if (stat.isDirectory() && fs.readdirSync(lock).length === 0) writePrivate(path.join(lock, "abandoned"), "");
            fs.renameSync(lock, tombstone);
            continue;
          } catch (reclaim) {
            if (reclaim?.code === "ENOENT") continue;
            if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOTDIR", "EISDIR"].includes(reclaim?.code)) throw reclaim;
          }
        }
        if (Date.now() >= deadline) throw new Error(`Local AI ${name} is already in progress. Wait for it to finish and retry.`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return await work();
  } finally {
    fs.rmSync(acquired ? lock : candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
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
export function localRuntimeEnvironment(plan: LocalPlan, home = defaultHome()): NodeJS.ProcessEnv {
  if (plan.runtime !== "vllm") return { ...process.env };
  const compiler = path.join(localRoot(home), "runtimes", `zig-${ZIG_VERSION}`, `zig-x86_64-linux-${ZIG_VERSION}`);
  const bin = path.join(runtimeDirectory(plan, home), "venv", "bin");
  return { ...process.env, PATH: [bin, compiler, process.env.PATH].filter(Boolean).join(path.delimiter),
    CC: path.join(compiler, "bw-cc"), CXX: path.join(compiler, "bw-cxx"),
    ZIG_GLOBAL_CACHE_DIR: path.join(localRoot(home), "compiler-cache") };
}
async function extractRuntime(archive: string, directory: string) {
  const listing = await runLocalProbe("tar", ["-tf", archive]);
  if (listing.trim().split(/\r?\n/).some(name => name.startsWith("/") || name.includes("\\") || /^[a-z]:/i.test(name) || name.split("/").includes(".."))) {
    throw new Error("Unsafe path in the pinned inference runtime archive.");
  }
  mkdirPrivate(directory);
  await runLocalProbe("tar", ["-xf", archive, "-C", directory]);
}
/** Only publish a complete, validated extraction. Setup holds the install lock. */
export async function stageLocalRuntime(directory: string, populate: (staging: string) => Promise<void>) {
  const staging = `${directory}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  mkdirPrivate(staging);
  try {
    await populate(staging);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(staging, directory);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
export async function localRuntimeReady(directory: string, version: string, executable: string | null, args = ["--version"]): Promise<boolean> {
  try {
    if (!executable || fs.readFileSync(path.join(directory, ".ready"), "utf8") !== version || !fs.statSync(executable).isFile()) return false;
    await runLocalProbe(executable, args);
    return true;
  } catch { return false; }
}
export async function installLlamaRuntime(platform: string, backend: string, home = defaultHome(), log: LocalLog = console.log): Promise<string> {
  const key = llamaRuntimeKey(platform, backend);
  const directory = path.join(localRoot(home), "runtimes", `llama-${LLAMA_VERSION}-${key}`);
  const ready = path.join(directory, ".ready");
  const name = platform === "win32" ? "llama-server.exe" : "llama-server";
  const cached = fs.existsSync(directory) ? findExecutable(directory, name) : null;
  if (!await localRuntimeReady(directory, LLAMA_VERSION, cached)) {
    await stageLocalRuntime(directory, async staging => {
      for (const artifact of LOCAL_RUNTIMES[key]) {
        const archive = await downloadLocalArtifact(artifact, path.join(localRoot(home), "downloads"), { log });
        await extractRuntime(archive, staging);
      }
      const executable = findExecutable(staging, platform === "win32" ? "llama-server.exe" : "llama-server");
      if (!executable) throw new Error("The inference runtime archive contains no llama-server.");
      if (platform !== "win32") fs.chmodSync(executable, 0o755);
      await runLocalProbe(executable, ["--version"]);
      fs.writeFileSync(path.join(staging, ".ready"), LLAMA_VERSION, { mode: 0o600 });
    });
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
  const libc = await runLocalProbe("getconf", ["GNU_LIBC_VERSION"]).catch(() => "");
  const version = libc.match(/glibc\s+(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 35) {
    throw new Error("The pinned vLLM wheels require glibc 2.35 or newer (for example Ubuntu 22.04+). No model weights were downloaded.");
  }
  const directory = runtimeDirectory(plan, home);
  const ready = path.join(directory, ".ready");
  // Triton builds a small CUDA launcher even when all Python packages are
  // wheels. Ship a private C/C++ compiler, without sudo or system packages.
  const compilerDirectory = path.join(localRoot(home), "runtimes", `zig-${ZIG_VERSION}`);
  const compilerBin = path.join(compilerDirectory, `zig-x86_64-linux-${ZIG_VERSION}`);
  if (!await localRuntimeReady(compilerDirectory, `${ZIG_VERSION}-cuda2`, path.join(compilerBin, "zig"), ["version"]) ||
    !fs.existsSync(path.join(compilerBin, "bw-cc")) || !fs.existsSync(path.join(compilerBin, "bw-cxx"))) {
    const archive = await downloadLocalArtifact(ZIG_ARCHIVE, path.join(localRoot(home), "downloads"), { log });
    await stageLocalRuntime(compilerDirectory, async staging => {
      await extractRuntime(archive, staging);
      const zig = findExecutable(staging, "zig");
      if (!zig) throw new Error("The pinned compiler archive contains no zig executable.");
      await runLocalProbe(zig, ["version"]);
      // Zig's GNU -l:filename handling does not consistently search -L
      // paths. Resolve those exact filenames before invoking its linker.
      writePrivate(path.join(path.dirname(zig), "bw-compiler.py"), `import os,sys
from pathlib import Path
args=sys.argv[2:]
directories=[]
for i,arg in enumerate(args):
    if arg == "-L" and i+1 < len(args): directories.append(args[i+1])
    elif arg.startswith("-L"): directories.append(arg[2:])
directories += os.environ.get("LD_LIBRARY_PATH", "").split(":")
directories += ["/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu", "/usr/local/nvidia/lib64", "/usr/lib/wsl/lib", "/usr/lib64", "/usr/lib"]
for i,arg in enumerate(args):
    if arg.startswith("-l:"):
        for directory in directories:
            candidate=Path(directory)/arg[3:]
            if directory and candidate.is_file():
                args[i]=str(candidate.resolve())
                break
zig=str(Path(__file__).resolve().parent/"zig")
os.execv(zig, [zig, sys.argv[1], *args])
`);
      for (const [name, command] of [["bw-cc", "cc"], ["bw-cxx", "c++"]]) {
        fs.writeFileSync(path.join(path.dirname(zig), name), `#!/bin/sh\nexec python3 "$(dirname "$0")/bw-compiler.py" ${command} "$@"\n`, { mode: 0o700 });
      }
      fs.writeFileSync(path.join(staging, ".ready"), `${ZIG_VERSION}-cuda2`, { mode: 0o600 });
    });
  }
  if (!await localRuntimeReady(directory, VLLM_VERSION, path.join(directory, "venv", "bin", "vllm"))) {
    fs.rmSync(ready, { force: true });
    const uvDirectory = path.join(localRoot(home), "runtimes", `uv-${UV_VERSION}`);
    const archive = await downloadLocalArtifact(UV_ARCHIVE, path.join(localRoot(home), "downloads"), { log });
    await stageLocalRuntime(uvDirectory, async staging => {
      await extractRuntime(archive, staging);
      const uv = findExecutable(staging, "uv");
      if (!uv) throw new Error("The pinned uv archive contains no executable.");
      await runLocalProbe(uv, ["--version"]);
    });
    const uv = findExecutable(uvDirectory, "uv");
    if (!uv) throw new Error("The pinned uv archive contains no executable.");
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(localRoot(home), "python"), UV_CACHE_DIR: path.join(localRoot(home), "uv-cache") };
    mkdirPrivate(directory);
    log(`Installing isolated Python ${LOCAL_PYTHON_VERSION} and vLLM ${VLLM_VERSION} (this can take several minutes).`);
    await runInstall(uv, ["venv", "--clear", "--python", LOCAL_PYTHON_VERSION, "--managed-python", path.join(directory, "venv")], env);
    const requirements = path.join(directory, "requirements.txt");
    writePrivate(requirements, LOCAL_VLLM_REQUIREMENTS);
    await runInstall(uv, ["pip", "sync", "--only-binary", ":all:", "--python", path.join(directory, "venv", "bin", "python"), requirements], env);
    fs.writeFileSync(ready, VLLM_VERSION, { mode: 0o600 });
  }
  return localRuntimeExecutable(plan, home);
}
export async function checkLocalDisk(plan: LocalPlan, home = defaultHome()) {
  let existing = path.resolve(home);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  const stats = fs.statfsSync(existing);
  const available = Number(stats.bavail) * Number(stats.bsize);
  let pending = 0;
  for (const { artifact: file, directory } of localInstallArtifacts(plan, home)) {
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
