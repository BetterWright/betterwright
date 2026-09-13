// Hardware recommendations and persisted selection for BetterWright's own
// harness. The SDK/browser/skill paths never read or start a local model.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mkdirPrivate, writePrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import { LOCAL_MODELS, type LocalModel } from "./local-ai-catalog.js";
import { isNumber, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

export const GIB = 1024 ** 3;
export type LocalPreference = "balanced" | "speed" | "quality";
export type LocalBackend = "metal" | "vulkan" | "cuda";
export interface LocalGpu {
  id: string;
  name: string;
  memory: number;
  freeMemory: number;
  backend: LocalBackend;
  vendor: "apple" | "nvidia" | "amd" | "intel" | "other";
  compute: number;
  uuid: string;
}
export interface LocalHardware {
  platform: string;
  arch: string;
  memory: number;
  gpus: LocalGpu[];
}
export interface LocalPlan {
  version: 1;
  modelId: string;
  quant: string;
  runtime: "llama.cpp" | "vllm";
  platform: string;
  arch: string;
  gpu: LocalGpu;
  context: number;
  preference: LocalPreference;
}
export interface LocalRecommendation {
  plan: LocalPlan;
  model: LocalModel;
  downloadBytes: number;
  reserveBytes: number;
  reason: string;
}
export type LocalProbe = (command: string, args: string[]) => Promise<string>;

export function localRoot(home = defaultHome()) { return path.join(home, "local-ai"); }
export function localModel(plan: LocalPlan): LocalModel {
  const model = LOCAL_MODELS.find(m => m.id === plan.modelId && m.quant === plan.quant && m.runtime === plan.runtime);
  if (!model) throw new Error("The saved local model is not in this version's reviewed catalog. Run betterwright --local again.");
  return model;
}
export function localPlanId(plan: LocalPlan) {
  // Free VRAM changes while a model is running; it is not a new installation.
  return createHash("sha256").update(JSON.stringify([plan.modelId, plan.quant, localModel(plan).revision,
    plan.runtime, plan.platform, plan.arch, plan.gpu.id, plan.gpu.uuid, plan.context])).digest("hex").slice(0, 24);
}
export function modelDirectory(plan: LocalPlan, home = defaultHome()) {
  const model = localModel(plan);
  return path.join(localRoot(home), "models", model.id, model.revision, model.quant);
}
export function writeLocalJson(file: string, value: UntrustedValue) {
  mkdirPrivate(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function runLocalProbe(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => error ? reject(new Error(`${path.basename(command)} failed: ${String(stderr || error.message).slice(0, 1200)}`)) : resolve(`${stdout}\n${stderr}`));
    child.stdin?.end();
  });
}
function vendor(name: string): LocalGpu["vendor"] {
  if (/nvidia|geforce|quadro|tesla/i.test(name)) return "nvidia";
  if (/amd|radeon|instinct/i.test(name)) return "amd";
  if (/intel|arc\b/i.test(name)) return "intel";
  if (/apple/i.test(name)) return "apple";
  return "other";
}
export function parseNvidiaGpus(output: string): LocalGpu[] {
  return output.trim().split(/\r?\n/).flatMap(line => {
    const [index, name, total, free, compute, uuid] = line.split(",").map(s => s.trim());
    if (!name || !/^\d+$/.test(index) || !Number.isFinite(Number(total)) || !Number.isFinite(Number(free)) || !/^GPU-[\da-f-]+$/i.test(uuid || "")) return [];
    return [{ id: `CUDA${index}`, name, memory: Number(total) * 1024 ** 2, freeMemory: Number(free) * 1024 ** 2,
      backend: "cuda", vendor: "nvidia", compute: Number(compute) || 0, uuid } satisfies LocalGpu];
  });
}
export function parseLlamaDevices(output: string, native: LocalGpu[] = []): LocalGpu[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*((?:MTL|Metal|Vulkan|CUDA)\d+):\s+(.+?)\s+\((\d+)\s+MiB,\s*(\d+)\s+MiB free\)/i);
    if (!match) return [];
    const [, id, name, total, free] = match;
    const physical = native.find(g => g.name.toLowerCase() === name.toLowerCase());
    const backend = /^(MTL|Metal)/i.test(id) ? "metal" : /^CUDA/i.test(id) ? "cuda" : "vulkan";
    return [{ id, name, memory: Number(total) * 1024 ** 2, freeMemory: Number(free) * 1024 ** 2,
      backend, vendor: vendor(name), compute: physical?.compute || 0, uuid: physical?.uuid || "" } satisfies LocalGpu];
  });
}
export async function detectLocalHardware({ probe = runLocalProbe, platform = process.platform, arch = process.arch,
  memory = os.totalmem() }: { probe?: LocalProbe; platform?: string; arch?: string; memory?: number } = {}): Promise<LocalHardware> {
  if (platform === "darwin" && arch === "arm64") {
    const name = (await probe("sysctl", ["-n", "machdep.cpu.brand_string"]).catch(() => "Apple Silicon")).trim();
    return { platform, arch, memory, gpus: [{ id: "Metal0", name, memory, freeMemory: memory,
      backend: "metal", vendor: "apple", compute: 0, uuid: "" }] };
  }
  const nvidia = await probe("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.free,compute_cap,uuid", "--format=csv,noheader,nounits"]).catch(() => "");
  // Vulkan enumeration during setup covers Radeon, Arc and other discrete
  // GPUs. WMI AdapterRAM is a 32-bit field; never use it as a VRAM limit.
  return { platform, arch, memory, gpus: parseNvidiaGpus(nvidia) };
}

export function recommendLocalModel(hardware: LocalHardware, options: { preference?: string; model?: string; quant?: string } = {}): LocalRecommendation {
  const preference = options.preference || "balanced";
  if (!["balanced", "speed", "quality"].includes(preference)) throw new Error("--preference must be balanced, speed, or quality.");
  if (hardware.memory <= 8 * GIB) throw new Error("Local AI needs more than 8 GB of system memory. No model is recommended for this hardware.");
  if (!((hardware.platform === "darwin" && hardware.arch === "arm64") || (["linux", "win32"].includes(hardware.platform) && hardware.arch === "x64"))) {
    throw new Error("Automatic local AI setup supports Apple Silicon and Linux/Windows x64 with an accelerated GPU runtime.");
  }
  const gpu = [...hardware.gpus].filter(g => g.memory > 8 * GIB).sort((a, b) => b.memory - a.memory)[0];
  if (!gpu) throw new Error("No supported GPU with more than 8 GB of usable memory was detected. Run betterwright --local to probe Metal/Vulkan, or check your GPU driver. No small CPU model will be installed.");
  const apple = gpu.backend === "metal";
  const capacity = apple ? hardware.memory : gpu.memory;
  const cudaQuality = hardware.platform === "linux" && gpu.vendor === "nvidia" && gpu.uuid &&
    ((gpu.compute >= 10 && capacity >= 30 * GIB) || (gpu.compute >= 8.9 && capacity >= 44 * GIB));
  const id = options.model || (cudaQuality && preference !== "speed" ? "qwen-27b" :
    capacity >= (apple ? 60 : 30) * GIB ? "nex-mini" : "ornith-9b");
  if (!LOCAL_MODELS.some(m => m.id === id)) throw new Error("--model must be nex-mini, ornith-35b, ornith-9b, or qwen-27b.");
  if (id === "qwen-27b" && !cudaQuality) {
    throw new Error("The reviewed Qwen 27B NVFP4/FP8 runtime needs Linux and a supported NVIDIA GPU (32 GB Blackwell, or 48 GB+ with FP8 support). Use nex-mini on this platform, or run setup inside GPU-enabled WSL2.");
  }
  // Reserve OS/browser memory on unified-memory machines as well as the
  // model's KV cache and compute workspace. Discrete VRAM is never summed.
  const budget = apple ? Math.min(capacity - Math.max(4 * GIB, capacity * 0.25), gpu.memory) - (capacity >= 48 * GIB ? 4 : 2) * GIB : capacity - 4 * GIB;
  const reserve = capacity - budget;
  const maxBits = preference === "speed" ? 4 : preference === "quality" || capacity >= 90 * GIB ? 8 : 6;
  let candidates = LOCAL_MODELS.filter(m => m.id === id && m.bits >= 3);
  if (options.quant) {
    candidates = candidates.filter(m => m.quant.toLowerCase() === options.quant.toLowerCase());
    if (!candidates.length) throw new Error("That quant is not in the reviewed catalog. Supported quants are Q4_K_M, Q5_K_M, Q6_K, Q8_0, NVFP4 and FP8 where compatible; no quant below 3 bits is permitted.");
  } else if (id === "qwen-27b") {
    candidates = candidates.filter(m => m.quant === (capacity >= 44 * GIB ? "FP8" : "NVFP4"));
  } else candidates = candidates.filter(m => m.bits <= maxBits);
  if (gpu.compute < 10) candidates = candidates.filter(m => m.quant !== "NVFP4");
  const model = candidates.filter(m => m.files.reduce((n, f) => n + f.bytes, 0) <= budget)
    .sort((a, b) => b.bits - a.bits)[0];
  if (!model) throw new Error("No reviewed quant of that model fits with browser and context-cache headroom. Choose ornith-9b, close GPU-heavy applications, or use hardware with more memory.");
  const context = capacity >= 48 * GIB ? 65536 : 32768;
  const plan: LocalPlan = { version: 1, modelId: model.id, quant: model.quant, runtime: model.runtime, platform: hardware.platform,
    arch: hardware.arch, gpu, context, preference: preference === "quality" ? "quality" : preference === "speed" ? "speed" : "balanced" };
  return { plan, model, downloadBytes: model.files.reduce((n, f) => n + f.bytes, 0), reserveBytes: reserve,
    reason: `${gpu.name}: ${model.quant} preserves quality while reserving ${(reserve / GIB).toFixed(1)} GiB for context, runtime${apple ? ", browser and macOS" : " workspace"}. ${model.id === "nex-mini" || model.id === "ornith-35b" ? "Sparse MoE for responsive local agent turns." : ""}`.trim() };
}

export function decodeLocalPlan(value: UntrustedValue): LocalPlan {
  const get = (key: string) => untrustedField(value, key);
  const gpu = get("gpu");
  const field = (key: string) => untrustedField(gpu, key);
  const model = LOCAL_MODELS.find(m => m.id === get("modelId") && m.quant === get("quant") && m.runtime === get("runtime"));
  const platform = get("platform"), arch = get("arch"), context = get("context"), preference = get("preference");
  const id = field("id"), name = field("name"), memory = field("memory"), freeMemory = field("freeMemory"), backend = field("backend"), gpuVendor = field("vendor"), compute = field("compute"), uuid = field("uuid");
  if (get("version") !== 1 || !model || !isString(platform) || !isString(arch) || !["linux", "win32", "darwin"].includes(platform) || !["arm64", "x64"].includes(arch) ||
    !isNumber(context) || ![32768, 65536].includes(context) || !["balanced", "speed", "quality"].includes(String(preference)) ||
    !isString(id) || !/^(MTL|Metal|Vulkan|CUDA)\d+$/.test(id) || !isString(name) || name.length > 200 ||
    !isNumber(memory) || !Number.isFinite(memory) || memory <= 8 * GIB || !isNumber(freeMemory) || !Number.isFinite(freeMemory) || freeMemory < 0 ||
    !["metal", "vulkan", "cuda"].includes(String(backend)) || !isNumber(compute) || !Number.isFinite(compute) || !isString(uuid) || (uuid !== "" && !/^GPU-[\da-f-]+$/i.test(uuid))) {
    throw new Error("Invalid saved local AI configuration. Run betterwright --local to repair it.");
  }
  return { version: 1, modelId: model.id, quant: model.quant, runtime: model.runtime, platform, arch, context,
    preference: preference === "quality" ? "quality" : preference === "speed" ? "speed" : "balanced",
    gpu: { id, name, memory, freeMemory, backend: backend === "metal" ? "metal" : backend === "cuda" ? "cuda" : "vulkan",
      vendor: gpuVendor === "apple" ? "apple" : gpuVendor === "nvidia" ? "nvidia" : gpuVendor === "amd" ? "amd" : gpuVendor === "intel" ? "intel" : "other", compute, uuid } };
}
export function readLocalPlan(home = defaultHome()): LocalPlan | null {
  const file = path.join(localRoot(home), "selection.json");
  if (!fs.existsSync(file)) return null;
  try { return decodeLocalPlan(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { throw new Error("Cannot read the saved local AI selection. Run betterwright --local to repair it."); }
}
export function hasLocalSelection(home = defaultHome()): boolean {
  return fs.existsSync(path.join(localRoot(home), "selection.json"));
}
