import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { mkdirPrivate, writePrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import { GIB, type LocalPlan, localInstallArtifacts, localRoot, readLocalPlan, runLocalProbe } from "./local-ai.js";
import type { LocalArtifact } from "./local-ai-catalog.js";
import { LOCAL_ESCHA_REQUIREMENTS } from "./local-ai-escha-lock.js";
import { localProcessInstance, localProcessIsGone } from "./local-ai-process.js";
import { LOCAL_CUDA_LIBRARIES, LOCAL_GCC_ARTIFACTS, LOCAL_LINUX_LIBRARIES } from "./local-ai-toolchain-lock.js";
import { LOCAL_VLLM_REQUIREMENTS } from "./local-ai-vllm-lock.js";
import { isNumber, isString, untrustedField } from "./untrusted-value.js";

export const LLAMA_VERSION = "b10902";
export const VLLM_VERSION = "0.29.0";
const VLLM_INSTALL_ID = `${VLLM_VERSION}-${createHash("sha256").update(LOCAL_VLLM_REQUIREMENTS).digest("hex").slice(0, 12)}`;
export const ESCHA_VERSION = "1.2.1-qwen3dense";
const ESCHA_INSTALL_ID = `${ESCHA_VERSION}-${createHash("sha256").update(LOCAL_ESCHA_REQUIREMENTS).digest("hex").slice(0, 12)}`;
const UV_VERSION = "0.12.13";
export const LOCAL_PYTHON_VERSION = "3.12.13";
function llamaArchive(name: string, bytes: number, sha256: string): LocalArtifact {
  return { name, bytes, sha256, url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${name}` };
}
// Linux CUDA: /app layers from the official b10902 amd64 image, manifest
// sha256:7c30fc592e6805509120d03944f729dd11c8f2af7cbe373b685ea879a50c18fe.
export const LOCAL_RUNTIMES = {
  linuxCuda: [
  {
    "name": "llama-b10902-cuda-layer-0.tar.gz",
    "url": "https://ghcr.io/v2/ggml-org/llama.cpp/blobs/sha256:5b91a136544a7bc33f340d506cd3853c54d1239a165a0c343ab082b78f48f04e",
    "bytes": 168321277,
    "sha256": "5b91a136544a7bc33f340d506cd3853c54d1239a165a0c343ab082b78f48f04e"
  },
  {
    "name": "llama-b10902-cuda-layer-1.tar.gz",
    "url": "https://ghcr.io/v2/ggml-org/llama.cpp/blobs/sha256:9881161edacb96eb2469de404ac9b3b4496ed502449037bc90006e9e492b9e05",
    "bytes": 25221,
    "sha256": "9881161edacb96eb2469de404ac9b3b4496ed502449037bc90006e9e492b9e05"
  }
],
  metal: [llamaArchive("llama-b10902-bin-macos-arm64.tar.gz", 11140021, "9d6c0ac65ca25c3d2c5173ded6424b0b73ce147090fe56e78d70ae32bbeddfbe")],
  linux: [llamaArchive("llama-b10902-bin-ubuntu-vulkan-x64.tar.gz", 30154951, "ca717eeff2f86b6580e3b5f48b455645eff0cd6d3500a3d5c1e52a32a19c639a")],
  linuxRocm: [llamaArchive("llama-b10902-bin-ubuntu-rocm-10.0-x64.tar.gz", 218367029, "d8d80666a71e6afc14654c2986d3efdcd3983236a84475267a6066d5590c0bad")],
  windows: [llamaArchive("llama-b10902-bin-win-vulkan-x64.zip", 31666258, "a75b13adaebbac980f24c52a7485b9620e96e21591da24b5a88142749f0d67c2")],
  cuda: [llamaArchive("llama-b10902-bin-win-cuda-13.3-x64.zip", 149706753, "621a763137e45f71eb3dc546f47150c0279a42b7711c5a230fb84efdb8ac9f0f"),
    llamaArchive("cudart-llama-bin-win-cuda-13.3-x64.zip", 390970417, "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e")],
};
export const LOCAL_ROCM_ARCHIVES = {
  gfx942: { name: "therock-dist-linux-gfx94X-dcgpu-10.0.0.tar.gz", bytes: 3259456349, sha256: "a7e105c74c26ef88d12f66712a0af1a107ded0405890a8e2389254ed046e7b06",
    url: "https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx94X-dcgpu-10.0.0.tar.gz" },
  gfx908: {
    "name": "therock-dist-linux-gfx908-10.0.0.tar.gz",
    "url": "https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx908-10.0.0.tar.gz",
    "bytes": 1959475470,
    "sha256": "d66ea48f449cdf9fa3e5d89a608998e465aeef01531be94be5f2cbd80c4712d3"
  },
  gfx90a: {
    "name": "therock-dist-linux-gfx90a-10.0.0.tar.gz",
    "url": "https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx90a-10.0.0.tar.gz",
    "bytes": 2123617772,
    "sha256": "19cc76973a79622fd9d9be67101abf2c2a0a997658083e359c5b9accf10fef79"
  },
  gfx950: {
    "name": "therock-dist-linux-gfx950-dcgpu-10.0.0.tar.gz",
    "url": "https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx950-dcgpu-10.0.0.tar.gz",
    "bytes": 2358163738,
    "sha256": "3bf27df141e78dbb14e4e1af3b5f8a4238ff8bf97565ccedd965ae4dddc5e9c8"
  },
} satisfies Record<string, LocalArtifact>;
const UV_ARCHIVE: LocalArtifact = { name: "uv-x86_64-unknown-linux-gnu.tar.gz", bytes: 19391575,
  sha256: "745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd",
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz` };
export const GCC_VERSION = "14.3.0";
const MICROMAMBA_ARCHIVE: LocalArtifact = { name: "micromamba-linux-64", bytes: 18292808,
  sha256: "366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3",
  url: "https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-64" };
export type LocalLog = (message: string) => void;

/** Publish a complete owner record atomically; stale tombstones prevent late
 * recoverers from renaming a fresh replacement held by another process. */
export async function withLocalLock<T>(home: string, name: string, work: () => Promise<T>, waitMs = 0): Promise<T> {
  mkdirPrivate(localRoot(home));
  const lock = path.join(localRoot(home), `${name}.lock`);
  const candidate = `${lock}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`;
  mkdirPrivate(candidate);
  writePrivate(path.join(candidate, "owner.json"), JSON.stringify({ pid: process.pid, instance: localProcessInstance(process.pid) || "" }));
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
        let owner = 0, instance = "";
        try {
          const ownerFile = stat.isDirectory() ? path.join(lock, "owner.json") : lock;
          const record = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
          const pid = untrustedField(record, "pid"), stamp = untrustedField(record, "instance");
          if (isString(stamp) && stamp.length <= 200) instance = stamp;
          if (isNumber(pid) && Number.isSafeInteger(pid) && pid > 0) owner = pid;
        } catch { /* Only abandoned, aged ownerless locks may be reclaimed. */ }
        let stale = !owner && Date.now() - stat.mtimeMs >= 30_000;
        if (owner) stale = localProcessIsGone(owner, instance);
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
    if (entry.name === name) {
      const file = path.join(directory, entry.name);
      if (entry.isFile()) return file;
      if (entry.isSymbolicLink() && fs.realpathSync(file).startsWith(`${path.resolve(directory)}${path.sep}`) && fs.statSync(file).isFile()) return file;
    }
    if (entry.isDirectory()) { const nested = findExecutable(path.join(directory, entry.name), name); if (nested) return nested; }
  }
  return null;
}
export function llamaRuntimeKey(platform: string, backend: string): keyof typeof LOCAL_RUNTIMES {
  if (platform === "darwin") return "metal";
  if (platform === "linux") return backend === "cuda" ? "linuxCuda" : backend === "rocm" ? "linuxRocm" : "linux";
  if (platform === "win32") return backend === "cuda" ? "cuda" : "windows";
  throw new Error("No managed inference runtime is published for this platform.");
}
export function runtimeDirectory(plan: LocalPlan, home = defaultHome()) {
  const id = plan.runtime === "escha" ? `escha-${ESCHA_INSTALL_ID}` : plan.runtime === "vllm" ? `vllm-${VLLM_VERSION}` : `llama-${LLAMA_VERSION}-${llamaRuntimeKey(plan.platform, plan.gpu.backend)}`;
  return path.join(localRoot(home), "runtimes", id);
}
export function localRuntimeExecutable(plan: LocalPlan, home = defaultHome()) {
  const directory = runtimeDirectory(plan, home);
  const executable = plan.runtime === "escha" ? path.join(directory, "venv", "bin", "python") : plan.runtime === "vllm" ? path.join(directory, "venv", "bin", "vllm") :
    fs.existsSync(directory) ? findExecutable(directory, plan.platform === "win32" ? "llama-server.exe" : "llama-server") : null;
  if (!executable || !fs.existsSync(executable)) throw new Error("The managed local runtime is missing. Run betterwright --local to repair it.");
  return executable;
}
/** Cheap diagnostics: full SHA verification remains mandatory at startup. */
export function hasReadyLocalInstallation(home = defaultHome()): boolean {
  try {
    const plan = readLocalPlan(home);
    if (!plan) return false;
    const executable = localRuntimeExecutable(plan, home);
    if (!fs.statSync(executable).isFile() || !fs.statSync(executable).size) return false;
    const version = plan.runtime === "escha" ? ESCHA_INSTALL_ID : plan.runtime === "vllm" ? VLLM_INSTALL_ID : LLAMA_VERSION;
    if (fs.readFileSync(path.join(runtimeDirectory(plan, home), ".ready"), "utf8").trim() !== version) return false;
    if (plan.runtime === "vllm") {
      const env = localRuntimeEnvironment(plan, home);
      if (!env.CC || !env.CXX || !env.CUDA_HOME || ![env.CC, env.CXX, path.join(env.CUDA_HOME, "bin", "nvcc"), path.join(env.CUDA_HOME, "lib", "libcudart.so.13")].every(file => fs.existsSync(file))) return false;
    }
    if (plan.runtime === "escha") {
      const env = localRuntimeEnvironment(plan, home);
      if (!env.CC || !env.CXX || !fs.existsSync(env.CC) || !fs.existsSync(env.CXX)) return false;
    }
    if (plan.gpu.backend === "rocm") {
      const env = localRuntimeEnvironment(plan, home);
      if (!env.ROCM_PATH || !["libamdhip64.so.7", "libhipblas.so.3", "librocblas.so.5"].every(file => fs.existsSync(path.join(env.ROCM_PATH || "", "lib", file)))) return false;
    }
    return localInstallArtifacts(plan, home).every(({ artifact, directory }) => {
      const stat = fs.lstatSync(path.join(directory, artifact.name));
      return stat.isFile() && stat.size === artifact.bytes;
    });
  } catch { return false; }
}
export function llamaRuntimeEnvironment(platform: string, home = defaultHome(), backend = "vulkan", gfx = ""): NodeJS.ProcessEnv {
  if (platform !== "linux") return { ...process.env };
  const root = path.join(localRoot(home), "runtimes");
  const app = path.join(root, `llama-${LLAMA_VERSION}-${llamaRuntimeKey(platform, backend)}`, backend === "cuda" ? "app" : `llama-${LLAMA_VERSION}`);
  const rocm = LOCAL_ROCM_ARCHIVES[gfx] ? path.join(root, `rocm-10.0.0-${gfx}`) : "";
  const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: [app, path.join(root, "linux-libraries-1", "lib"),
    ...(backend === "rocm" && rocm ? [path.join(rocm, "lib")] : []),
    ...(backend === "cuda" ? [path.join(root, "cuda-libraries-12.8", "lib"), path.join(root, "cuda-libraries-12.8", "targets", "x86_64-linux", "lib")] : []), process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
  if (backend === "cuda" || backend === "rocm") env.GGML_BACKEND_PATH = path.join(app, backend === "cuda" ? "libggml-cuda.so" : "libggml-hip.so");
  else delete env.GGML_BACKEND_PATH;
  if (backend === "rocm" && rocm) { env.ROCM_PATH = rocm; env.HIP_PATH = rocm; }
  return env;
}
export function localRuntimeEnvironment(plan: LocalPlan, home = defaultHome()): NodeJS.ProcessEnv {
  if (plan.runtime === "escha") {
    const compiler = path.join(localRoot(home), "runtimes", `gcc-${GCC_VERSION}`);
    const compilerBin = path.join(compiler, "bin");
    const bin = path.join(runtimeDirectory(plan, home), "venv", "bin");
    return { ...process.env, PATH: [bin, compilerBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      CC: path.join(compilerBin, "x86_64-conda-linux-gnu-gcc"), CXX: path.join(compilerBin, "x86_64-conda-linux-gnu-g++"),
      LD_LIBRARY_PATH: [path.join(compiler, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
  }
  if (plan.runtime !== "vllm") return llamaRuntimeEnvironment(plan.platform, home, plan.gpu.backend, plan.gpu.gfx);
  const compiler = path.join(localRoot(home), "runtimes", `gcc-${GCC_VERSION}`);
  const compilerBin = path.join(compiler, "bin");
  const bin = path.join(runtimeDirectory(plan, home), "venv", "bin");
  const cuda = path.join(runtimeDirectory(plan, home), "venv", "lib", "python3.12", "site-packages", "nvidia", "cu13");
  return { ...process.env, PATH: [bin, compilerBin, path.join(cuda, "bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
    CUDA_HOME: cuda, CUDA_PATH: cuda, NVCC_CCBIN: path.join(compilerBin, "x86_64-conda-linux-gnu-g++"),
    CC: path.join(compilerBin, "x86_64-conda-linux-gnu-gcc"), CXX: path.join(compilerBin, "x86_64-conda-linux-gnu-g++"),
    LD_LIBRARY_PATH: [path.join(compiler, "lib"), path.join(cuda, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
}
async function extractRuntime(archive: string, directory: string) {
  // Portable GPU SDKs contain several GiB and many more entries than a
  // small inference executable. Keep extraction bounded independently of probes.
  const listing = await runLocalProbe("tar", ["-tf", archive], process.env, 10 * 60_000, 32 * 1024 * 1024);
  if (listing.trim().split(/\r?\n/).some(name => name.startsWith("/") || name.includes("\\") || /^[a-z]:/i.test(name) || name.split("/").includes(".."))) {
    throw new Error("Unsafe path in the pinned inference runtime archive.");
  }
  mkdirPrivate(directory);
  await runLocalProbe("tar", ["--no-same-owner", "-xf", archive, "-C", directory], process.env, 10 * 60_000);
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
export async function localRuntimeReady(directory: string, version: string, executable: string | null, args = ["--version"], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (!executable || fs.readFileSync(path.join(directory, ".ready"), "utf8") !== version || !fs.statSync(executable).isFile()) return false;
    await runLocalProbe(executable, args, env);
    return true;
  } catch { return false; }
}
async function installCondaArchives(directory: string, artifacts: LocalArtifact[], home: string, log: LocalLog) {
    const managerDirectory = path.join(localRoot(home), "runtimes", "micromamba-2.9.0");
    const archive = await downloadLocalArtifact(MICROMAMBA_ARCHIVE, path.join(localRoot(home), "downloads"), { log });
    await stageLocalRuntime(managerDirectory, async staging => {
      mkdirPrivate(path.join(staging, "bin"));
      const manager = path.join(staging, "bin", "micromamba");
      fs.copyFileSync(archive, manager); fs.chmodSync(manager, 0o700);
      await runLocalProbe(manager, ["--version"]);
    });
    const files: string[] = [];
    for (const artifact of artifacts) files.push(await downloadLocalArtifact(artifact, path.join(localRoot(home), "downloads", "toolchain"), { log }));
    const manifest = path.join(localRoot(home), "runtimes", `${path.basename(directory)}-explicit.txt`);
    writePrivate(manifest, `@EXPLICIT\n${files.map(file => pathToFileURL(file).href).join("\n")}\n`);
    // Conda embeds the installation prefix; build at its final private path.
    fs.rmSync(directory, { recursive: true, force: true });
    await runInstall(path.join(managerDirectory, "bin", "micromamba"), ["create", "--no-rc", "--offline", "--yes", "--prefix", directory, "--file", manifest],
      { ...process.env, MAMBA_ROOT_PREFIX: path.join(localRoot(home), "compiler-cache") });
}
async function publicLlamaRegistryFetch(): Promise<typeof fetch> {
  const response = await fetch("https://ghcr.io/token?service=ghcr.io&scope=repository%3Aggml-org%2Fllama.cpp%3Apull", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Cannot access the official public llama.cpp runtime registry.");
  const token = untrustedField(await response.json(), "token");
  if (!isString(token)) throw new Error("The public runtime registry returned no pull token.");
  return (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === "https://ghcr.io") request.headers.set("authorization", `Bearer ${token}`);
    return fetch(request);
  };
}
export async function installLlamaRuntime(platform: string, backend: string, home = defaultHome(), log: LocalLog = console.log, gfx = ""): Promise<string> {
  const env = llamaRuntimeEnvironment(platform, home, backend, gfx);
  if (platform === "linux") {
    const libraries = path.join(localRoot(home), "runtimes", "linux-libraries-1");
    const ready = path.join(libraries, ".ready");
    if (!fs.existsSync(ready) || !["libgomp.so.1", "libstdc++.so.6", "libvulkan.so.1"].every(file => fs.existsSync(path.join(libraries, "lib", file)))) {
      await installCondaArchives(libraries, LOCAL_LINUX_LIBRARIES, home, log);
      fs.writeFileSync(ready, "1", { mode: 0o600 });
    }
  }
  if (platform === "linux" && backend === "cuda") {
    const libraries = path.join(localRoot(home), "runtimes", "cuda-libraries-12.8");
    if (!fs.existsSync(path.join(libraries, ".ready")) || !["libnccl.so.2", "libcublas.so.12", "libcudart.so.12"].every(file => ["lib", "targets/x86_64-linux/lib"].some(dir => fs.existsSync(path.join(libraries, dir, file))))) {
      await installCondaArchives(libraries, LOCAL_CUDA_LIBRARIES, home, log);
      fs.writeFileSync(path.join(libraries, ".ready"), "12.8", { mode: 0o600 });
    }
  }
  if (platform === "linux" && backend === "rocm") {
    const artifact = LOCAL_ROCM_ARCHIVES[gfx];
    if (!artifact) throw new Error("No reviewed ROCm runtime is available for this GPU architecture. Try a working Vulkan driver.");
    const directory = path.join(localRoot(home), "runtimes", `rocm-10.0.0-${gfx}`);
    const libraries = ["libamdhip64.so.7", "libhipblas.so.3", "librocblas.so.5"];
    if (!fs.existsSync(path.join(directory, ".ready")) || !libraries.every(file => fs.existsSync(path.join(directory, "lib", file)))) {
      const disk = fs.statfsSync(localRoot(home));
      const required = artifact.bytes * 5 + 5 * GIB;
      if (Number(disk.bavail) * Number(disk.bsize) < required) throw new Error(`The private ROCm runtime needs ${(required / GIB).toFixed(1)} GiB of free disk space for download, extraction and safety headroom. No model weights were downloaded.`);
      const archive = await downloadLocalArtifact(artifact, path.join(localRoot(home), "downloads"), { log });
      await stageLocalRuntime(directory, async staging => {
        await extractRuntime(archive, staging);
        if (!libraries.every(file => fs.existsSync(path.join(staging, "lib", file)))) throw new Error("The ROCm archive is missing its required GPU libraries.");
        fs.writeFileSync(path.join(staging, ".ready"), "10.0.0", { mode: 0o600 });
      });
    }
  }
  const key = llamaRuntimeKey(platform, backend);
  const directory = path.join(localRoot(home), "runtimes", `llama-${LLAMA_VERSION}-${key}`);
  const ready = path.join(directory, ".ready");
  const name = platform === "win32" ? "llama-server.exe" : "llama-server";
  const cached = fs.existsSync(directory) ? findExecutable(directory, name) : null;
  if (!await localRuntimeReady(directory, LLAMA_VERSION, cached, ["--version"], env)) {
    await stageLocalRuntime(directory, async staging => {
      const fetchImpl = key === "linuxCuda" ? await publicLlamaRegistryFetch() : fetch;
      for (const artifact of LOCAL_RUNTIMES[key]) {
        const archive = await downloadLocalArtifact(artifact, path.join(localRoot(home), "downloads"), { log, fetchImpl });
        await extractRuntime(archive, staging);
      }
      const executable = findExecutable(staging, platform === "win32" ? "llama-server.exe" : "llama-server");
      if (!executable) throw new Error("The inference runtime archive contains no llama-server.");
      if (platform !== "win32") fs.chmodSync(executable, 0o755);
      const probeEnv = platform === "linux" ? { ...env, GGML_BACKEND_PATH: backend === "cuda" || backend === "rocm" ? path.join(path.dirname(executable), backend === "cuda" ? "libggml-cuda.so" : "libggml-hip.so") : undefined, LD_LIBRARY_PATH: [path.dirname(executable), env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) } : env;
      await runLocalProbe(executable, ["--version"], probeEnv);
      fs.writeFileSync(path.join(staging, ".ready"), LLAMA_VERSION, { mode: 0o600 });
    });
  }
  const executable = findExecutable(directory, platform === "win32" ? "llama-server.exe" : "llama-server");
  if (!executable) throw new Error("The inference runtime archive contains no llama-server.");
  if (platform !== "win32") fs.chmodSync(executable, 0o755);
  await runLocalProbe(executable, ["--version"], env);
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
/** Escha ships its own SGLang fork and a CUDA-12 Torch ABI. Keep this
 * environment separate from vLLM's CUDA-13 dependencies. */
async function installEschaRuntime(plan: LocalPlan, home: string, log: LocalLog): Promise<string> {
  if (plan.platform !== "linux" || plan.arch !== "x64" || plan.gpu.backend !== "cuda" || plan.gpu.compute < 8 || !plan.gpu.uuid) {
    throw new Error("The Escha runtime requires Linux x64 and an NVIDIA Ampere-or-newer GPU.");
  }
  const libc = await runLocalProbe("getconf", ["GNU_LIBC_VERSION"]).catch(() => "");
  const version = libc.match(/glibc\s+(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 35) {
    throw new Error("The pinned Escha dependency set requires glibc 2.35+ (Ubuntu 22.04+). No model weights were downloaded.");
  }
  const compiler = path.join(localRoot(home), "runtimes", `gcc-${GCC_VERSION}`);
  const gcc = path.join(compiler, "bin", "x86_64-conda-linux-gnu-gcc");
  const gxx = path.join(compiler, "bin", "x86_64-conda-linux-gnu-g++");
  if (!await localRuntimeReady(compiler, GCC_VERSION, gcc) || !await localRuntimeReady(compiler, GCC_VERSION, gxx)) {
    await installCondaArchives(compiler, LOCAL_GCC_ARTIFACTS, home, log);
    await runLocalProbe(gcc, ["--version"]); await runLocalProbe(gxx, ["--version"]);
    fs.writeFileSync(path.join(compiler, ".ready"), GCC_VERSION, { mode: 0o600 });
  }
  const directory = runtimeDirectory(plan, home), python = path.join(directory, "venv", "bin", "python");
  const ready = path.join(directory, ".ready");
  if (!await localRuntimeReady(directory, ESCHA_INSTALL_ID, python)) {
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
    log(`Installing isolated Python ${LOCAL_PYTHON_VERSION} and Escha ${ESCHA_VERSION}.`);
    await runInstall(uv, ["venv", "--clear", "--python", LOCAL_PYTHON_VERSION, "--managed-python", path.join(directory, "venv")], env);
    const requirements = path.join(directory, "requirements.txt");
    writePrivate(requirements, LOCAL_ESCHA_REQUIREMENTS);
    await runInstall(uv, ["pip", "sync", "--only-binary", ":all:", "--python", python, requirements], env);
  }
  fs.rmSync(ready, { force: true });
  await runLocalProbe(python, ["-c", "import torch,escha,sglang,transformers; assert torch.__version__ == '2.9.1+cu128'; assert transformers.__version__ == '5.10.2'; assert torch.cuda.is_available(); assert hasattr(torch.ops.escha, 'escha_gemv'); from triton.backends.nvidia.driver import CudaUtils; CudaUtils(); from sglang.srt.multimodal.processors.qwen_vl import QwenVLImageProcessor; print(torch.cuda.get_device_name(0))"],
    { ...localRuntimeEnvironment(plan, home), CUDA_VISIBLE_DEVICES: plan.gpu.uuid }, 120_000);
  fs.writeFileSync(ready, ESCHA_INSTALL_ID, { mode: 0o600 });
  return python;
}

export async function installLocalRuntime(plan: LocalPlan, home = defaultHome(), log: LocalLog = console.log) {
  if (plan.runtime === "escha") return installEschaRuntime(plan, home, log);
  if (plan.runtime !== "vllm") return installLlamaRuntime(plan.platform, plan.gpu.backend, home, log, plan.gpu.gfx);
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The managed vLLM runtime requires Linux x64.");
  const libc = await runLocalProbe("getconf", ["GNU_LIBC_VERSION"]).catch(() => "");
  const version = libc.match(/glibc\s+(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 35) {
    throw new Error("The pinned vLLM wheels require glibc 2.35 or newer (for example Ubuntu 22.04+). No model weights were downloaded.");
  }
  const directory = runtimeDirectory(plan, home);
  const ready = path.join(directory, ".ready");
  // CUDA JIT requires libstdc++ on x86; install a complete private GNU toolchain.
  const compilerDirectory = path.join(localRoot(home), "runtimes", `gcc-${GCC_VERSION}`);
  const gcc = path.join(compilerDirectory, "bin", "x86_64-conda-linux-gnu-gcc");
  const gxx = path.join(compilerDirectory, "bin", "x86_64-conda-linux-gnu-g++");
  if (!await localRuntimeReady(compilerDirectory, GCC_VERSION, gcc) || !await localRuntimeReady(compilerDirectory, GCC_VERSION, gxx)) {
    await installCondaArchives(compilerDirectory, LOCAL_GCC_ARTIFACTS, home, log);
    await runLocalProbe(gcc, ["--version"]); await runLocalProbe(gxx, ["--version"]);
    fs.writeFileSync(path.join(compilerDirectory, ".ready"), GCC_VERSION, { mode: 0o600 });
  }
  const cuda = path.join(directory, "venv", "lib", "python3.12", "site-packages", "nvidia", "cu13");
  const nvcc = path.join(cuda, "bin", "nvcc"), env = localRuntimeEnvironment(plan, home);
  const cudaFiles = ["include/cuda_runtime.h", "lib/libcudart.so.13", "lib64/libcudart.so.13"];
  if (!await localRuntimeReady(directory, VLLM_INSTALL_ID, path.join(directory, "venv", "bin", "vllm")) ||
    !await localRuntimeReady(directory, VLLM_INSTALL_ID, nvcc) || !cudaFiles.every(file => fs.existsSync(path.join(cuda, file)))) {
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
  }
  // NVIDIA wheels use lib/ while nvcc and FlashInfer expect lib64/.
  if (!fs.existsSync(path.join(cuda, "lib64"))) fs.symlinkSync("lib", path.join(cuda, "lib64"));
  for (const library of ["cudart", "nvrtc"]) {
    const link = path.join(cuda, "lib", `lib${library}.so`);
    if (!fs.existsSync(link)) fs.symlinkSync(`lib${library}.so.13`, link);
  }
  fs.rmSync(ready, { force: true });
  await runLocalProbe(nvcc, ["--version"], env);
  const driverLink = path.join(cuda, "lib", "libcuda.so");
  if (!fs.existsSync(driverLink)) {
    const driver = await runLocalProbe(path.join(directory, "venv", "bin", "python"), ["-c", "from pathlib import Path; from triton.backends.nvidia.driver import libcuda_dirs; print(next(str((Path(d)/'libcuda.so.1').resolve()) for d in libcuda_dirs() if (Path(d)/'libcuda.so.1').is_file()))"], env);
    fs.symlinkSync(driver.trim(), driverLink);
  }
  const check = fs.mkdtempSync(path.join(directory, "cuda-check-"));
  try {
    const source = path.join(check, "probe.cu");
    writePrivate(source, "#include <cuda_runtime.h>\n__global__ void bw_probe(float *x) { x[0] = 1.0f; }\n");
    await runLocalProbe(nvcc, ["-c", source, `-arch=sm_${Math.round(plan.gpu.compute * 10)}`, "-o", path.join(check, "probe.o")], env, 120_000);
    const linkSource = path.join(check, "link.cpp");
    writePrivate(linkSource, "int main() { return 0; }\n");
    await runLocalProbe(gxx, [linkSource, "-Wl,--no-as-needed", `-L${path.join(cuda, "lib")}`, "-lcudart", "-lnvrtc", "-lcuda", "-o", path.join(check, "link")], env);
  } catch (error) {
    fs.rmSync(path.join(compilerDirectory, ".ready"), { force: true });
    throw error;
  } finally { fs.rmSync(check, { recursive: true, force: true }); }
  fs.writeFileSync(ready, VLLM_INSTALL_ID, { mode: 0o600 });
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
  let installed = false;
  try {
    installed = await localRuntimeReady(runtimeDirectory(plan, home), plan.runtime === "escha" ? ESCHA_INSTALL_ID : plan.runtime === "vllm" ? VLLM_INSTALL_ID : LLAMA_VERSION, localRuntimeExecutable(plan, home), ["--version"], localRuntimeEnvironment(plan, home));
    if (installed && plan.runtime === "vllm") {
      const env = localRuntimeEnvironment(plan, home);
      installed = Boolean(env.CC && env.CXX && env.CUDA_HOME && [env.CC, env.CXX, path.join(env.CUDA_HOME, "bin", "nvcc"), path.join(env.CUDA_HOME, "lib64", "libcudart.so.13"), path.join(env.CUDA_HOME, "include", "cuda_runtime.h")].every(file => fs.existsSync(file)));
    }
    if (installed && plan.runtime === "escha") {
      const compiler = path.join(localRoot(home), "runtimes", `gcc-${GCC_VERSION}`);
      const env = localRuntimeEnvironment(plan, home);
      installed = await localRuntimeReady(compiler, GCC_VERSION, env.CC || null) &&
        await localRuntimeReady(compiler, GCC_VERSION, env.CXX || null);
    }
  } catch { /* Damaged runtimes reserve the full repair allowance. */ }
  const required = pending + (installed ? 0 : plan.runtime !== "llama.cpp" ? 30 : 2) * GIB + 5 * GIB;
  if (available < required) throw new Error(`Local AI needs ${(required / GIB).toFixed(1)} GiB of free disk space including runtime and safety headroom; ${(available / GIB).toFixed(1)} GiB is available.`);
  return { available, required };
}
