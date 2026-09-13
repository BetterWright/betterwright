import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { preferredModelId } from "../../dist/src/doctor.js";
import { decodeLocalPlan, detectLocalHardware, draftDirectory, GIB, localInstallArtifacts, localModel, localPlanId, localRoot, modelDirectory, parseLlamaDevices, parseNvidiaGpus, readLocalPlan, recommendLocalModel, writeLocalJson } from "../../dist/src/local-ai.js";
import { LOCAL_DFLASH2, LOCAL_MODELS } from "../../dist/src/local-ai-catalog.js";
import { setupLocalAI, verifyLocalModel } from "../../dist/src/local-ai-cli.js";
import { downloadLocalArtifact, LOCAL_PYTHON_VERSION, LOCAL_RUNTIMES, localRuntimeReady, runtimeDirectory, stageLocalRuntime, VLLM_VERSION, verifyLocalArtifact, withLocalLock } from "../../dist/src/local-ai-install.js";
import { ensureLocalService, localServerArguments, localServiceStatus, serveLocalAI, stopLocalService, stopLocalServiceIfOwned } from "../../dist/src/local-ai-service.js";
import { LOCAL_VLLM_REQUIREMENTS } from "../../dist/src/local-ai-vllm-lock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const quiet = () => {};
function hardware(memory = 64, vram = memory, vendor = "apple", platform = vendor === "apple" ? "darwin" : "linux", compute = 0) {
  return { platform, arch: platform === "darwin" ? "arm64" : "x64", memory: memory * GIB,
    gpus: [{ id: vendor === "apple" ? "MTL0" : vendor === "nvidia" ? "CUDA0" : "Vulkan0", name: `${vendor} test GPU`,
      memory: vram * GIB, freeMemory: vram * GIB, backend: vendor === "apple" ? "metal" : vendor === "nvidia" ? "cuda" : "vulkan",
      vendor, compute, uuid: vendor === "nvidia" ? "GPU-1234-abcd" : "" }] };
}
const cases: Array<[string, ReturnType<typeof hardware>, string, string, string]> = [
  ["5090", hardware(64, 32, "nvidia", "linux", 12), "qwen-27b", "NVFP4", "vllm"],
  ["Pro 6000 Blackwell", hardware(128, 96, "nvidia", "linux", 12), "qwen-27b", "NVFP4", "vllm"],
  ["RTX 6000 Ada", hardware(128, 48, "nvidia", "linux", 8.9), "qwen-27b", "FP8", "vllm"],
  ["Windows 5090", hardware(64, 32, "nvidia", "win32", 12), "nex-mini", "Q5_K_M", "llama.cpp"],
  ["AMD 12 GB", hardware(32, 12, "amd"), "ornith-9b", "Q6_K", "llama.cpp"],
  ["AMD 16 GB", hardware(32, 16, "amd"), "ornith-9b", "Q6_K", "llama.cpp"],
  ["AMD 32 GB", hardware(64, 32, "amd"), "nex-mini", "Q5_K_M", "llama.cpp"],
  ["Intel Arc 16 GB", hardware(32, 16, "intel", "win32"), "ornith-9b", "Q6_K", "llama.cpp"],
  ["Apple 16 GB", hardware(16, 12), "ornith-9b", "Q6_K", "llama.cpp"],
  ["Apple 64 GB working set", hardware(64, 51.8), "nex-mini", "Q6_K", "llama.cpp"],
  ["Apple 128 GB", hardware(128, 100), "nex-mini", "Q8_0", "llama.cpp"],
];
for (const [name, host, id, quant, runtime] of cases) {
  test(`local recommendation: ${name}`, () => {
    const r = recommendLocalModel(host);
    assert.deepEqual([r.model.id, r.model.quant, r.plan.runtime], [id, quant, runtime]);
    assert.ok(r.model.bits >= 3);
    assert.ok(r.downloadBytes + r.reserveBytes <= (host.platform === "darwin" ? host.memory : host.gpus[0].memory));
  });
}
test("preferences and reviewed overrides preserve the quant floor", () => {
  assert.equal(recommendLocalModel(hardware(), { preference: "speed" }).model.quant, "Q4_K_M");
  assert.equal(recommendLocalModel(hardware(), { preference: "quality" }).model.quant, "Q8_0");
  assert.equal(recommendLocalModel(hardware(), { model: "ornith-35b", quant: "q5_k_m" }).model.quant, "Q5_K_M");
  assert.equal(recommendLocalModel(hardware(64, 32, "nvidia", "linux", 12), { preference: "speed" }).model.id, "nex-mini");
  for (const options of [{ quant: "Q2_K" }, { model: "arbitrary/repo" }, { preference: "tiny" }, { model: "qwen-27b" }]) {
    assert.throws(() => recommendLocalModel(hardware(), options));
  }
  assert.throws(() => recommendLocalModel(hardware(32, 12, "amd"), { model: "nex-mini" }), /fits/);
});
test("acceleration matches published draft heads and reserves separate drafter memory", () => {
  const large = recommendLocalModel(hardware(128, 96, "nvidia", "linux", 12));
  const small = recommendLocalModel(hardware(64, 32, "nvidia", "linux", 12));
  assert.equal(large.plan.acceleration, "dflash2"); assert.equal(small.plan.acceleration, "mtp");
  const drafts = LOCAL_DFLASH2.files.reduce((n, f) => n + f.bytes, 0);
  assert.equal(large.downloadBytes - small.downloadBytes, drafts);
  assert.equal(large.reserveBytes, small.reserveBytes + 2 * GIB);
  assert.equal(recommendLocalModel(hardware()).plan.acceleration, "none");
  assert.equal(recommendLocalModel(hardware(), { model: "ornith-9b" }).plan.acceleration, "mtp");
  assert.equal(recommendLocalModel(hardware(), { model: "ornith-35b" }).plan.acceleration, "mtp");
  assert.throws(() => recommendLocalModel(hardware(), { acceleration: "mtp" }), /does not publish MTP/);
  assert.throws(() => recommendLocalModel(hardware(), { model: "ornith-9b", acceleration: "dflash2" }), /DFlash2 needs/);
  assert.throws(() => recommendLocalModel(hardware(), { acceleration: "unreviewed" }), /--acceleration/);
  const none = recommendLocalModel(hardware(128, 96, "nvidia", "linux", 12), { acceleration: "none" });
  assert.equal(none.plan.acceleration, "none"); assert.notEqual(localPlanId(none.plan), localPlanId(large.plan));
  assert.equal(modelDirectory(none.plan), modelDirectory(large.plan)); // Reuse target weights.
  const files = localInstallArtifacts(large.plan, "/tmp/test-local");
  assert.equal(files.filter(f => f.directory === draftDirectory("/tmp/test-local")).length, 2);
  assert.equal(localInstallArtifacts(none.plan).length, none.model.files.length);
  const { acceleration: _acceleration, ...legacy } = none.plan;
  assert.equal(decodeLocalPlan(legacy).acceleration, "none");
  assert.throws(() => decodeLocalPlan({ ...large.plan, modelId: "nex-mini", quant: "Q4_K_M", runtime: "llama.cpp" }), /Invalid/);
});
test("small devices, CPU-only hosts and combined small GPUs are refused", () => {
  for (const host of [hardware(8), hardware(64, 8, "nvidia"), { ...hardware(), gpus: [] }, { ...hardware(), platform: "freebsd" }]) {
    assert.throws(() => recommendLocalModel(host));
  }
  const host = hardware(64, 8, "nvidia"); host.gpus.push({ ...host.gpus[0], id: "CUDA1" });
  assert.throws(() => recommendLocalModel(host), /more than 8 GB/);
});
test("automatic selection evaluates model fit on each GPU before choosing a busy larger card", () => {
  const host = hardware(64, 32, "nvidia", "linux", 12);
  host.gpus[0].freeMemory = 4 * GIB;
  host.gpus.push({ ...hardware(64, 16, "nvidia", "linux", 8.9).gpus[0], id: "CUDA1", uuid: "GPU-2345-abcd" });
  const r = recommendLocalModel(host);
  assert.equal(r.plan.gpu.id, "CUDA1"); assert.equal(r.model.id, "ornith-9b");
  assert.equal(r.model.quant, "Q6_K");
  host.gpus[0].freeMemory = host.gpus[0].memory;
  assert.equal(recommendLocalModel(host).plan.gpu.id, "CUDA0");
});
test("hardware parsers recognize real Metal, Vulkan and CUDA output without counting CPU memory", async () => {
  const gpu = parseNvidiaGpus("0, NVIDIA GeForce RTX 5090, 32768, 30000, 12.0, GPU-1234-abcd")[0];
  assert.equal(gpu.memory, 32 * GIB); assert.equal(gpu.compute, 12);
  const devices = parseLlamaDevices("  MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)\n BLAS: Accelerate (0 MiB, 0 MiB free)\n Vulkan0: AMD Radeon RX 9070 (16384 MiB, 15000 MiB free)");
  assert.equal(devices.length, 2); assert.equal(devices[1].vendor, "amd"); assert.equal(devices[0].id, "MTL0");
  const result = await detectLocalHardware({ platform: "win32", arch: "x64", memory: 64 * GIB, probe: async () => "0, NVIDIA GeForce RTX 5090, 32768, 30000, 12.0, GPU-1234-abcd" });
  assert.equal(result.gpus[0].uuid, gpu.uuid);
});
test("all catalog downloads are immutable, checksummed and from reviewed publishers", () => {
  for (const model of LOCAL_MODELS) {
    assert.ok(model.bits >= 3); assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.match(model.repository, /^(bartowski|ornith-ai|unsloth|Qwen)\//);
    if (model.runtime === "llama.cpp") assert.ok(model.files.some(f => f.name.startsWith("mmproj-")));
    for (const file of model.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0);
      assert.equal(file.url, `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.name}`);
    }
  }
  for (const key of Object.keys(LOCAL_RUNTIMES)) for (const file of LOCAL_RUNTIMES[key]) {
    assert.match(file.url, /^https:\/\/github.com\/ggml-org\/llama.cpp\/releases\/download\/b\d+\//);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  for (const file of LOCAL_DFLASH2.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0);
    assert.equal(file.url, `https://huggingface.co/${LOCAL_DFLASH2.repository}/resolve/${LOCAL_DFLASH2.revision}/${file.name}`);
  }
});
test("saved plans round-trip privately and free VRAM does not create a different installation", () => {
  const home = makeTempDir("bw-local-plan-");
  const plan = recommendLocalModel(hardware()).plan;
  writeLocalJson(path.join(localRoot(home), "selection.json"), plan);
  assert.deepEqual(readLocalPlan(home), plan);
  assert.equal(localPlanId(plan), localPlanId({ ...plan, gpu: { ...plan.gpu, freeMemory: 0 } }));
  assert.notEqual(localPlanId(plan), localPlanId({ ...plan, quant: "Q4_K_M" }));
  assert.throws(() => decodeLocalPlan({ ...plan, gpu: { ...plan.gpu, id: "../../evil" } }), /Invalid/);
  assert.equal(preferredModelId({ env: { BETTERWRIGHT_HOME: home, OPENAI_API_KEY: "fake" }, auth: {} }).model, "local");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(localRoot(home), "selection.json")).mode & 0o777, 0o600);
});
const bytes = Buffer.from("A small reproducible model artifact");
const artifact = { name: "model.gguf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://models.example/model.gguf" };
test("download verifies cache and resumes partial bytes without buffering model files", async () => {
  const dir = makeTempDir("bw-local-download-");
  fs.writeFileSync(path.join(dir, "model.gguf.part"), bytes.subarray(0, 7));
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++; assert.equal(init.headers.range, "bytes=7-");
    return new Response(bytes.subarray(7), { status: 206, headers: { "content-range": `bytes 7-${bytes.length - 1}/${bytes.length}` } });
  };
  const file = await downloadLocalArtifact(artifact, dir, { fetchImpl, log: quiet });
  await downloadLocalArtifact(artifact, dir, { fetchImpl, log: quiet });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(file), bytes); assert.ok(await verifyLocalArtifact(file, artifact));
});
test("download restarts when Range is ignored and rejects corrupt, oversized and redirected HTTP bytes", async () => {
  const dir = makeTempDir("bw-local-download-");
  fs.writeFileSync(path.join(dir, "model.gguf.part"), bytes.subarray(0, 5));
  await downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(bytes), log: quiet });
  fs.unlinkSync(path.join(dir, artifact.name));
  await assert.rejects(downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(Buffer.alloc(bytes.length)), log: quiet }), /Checksum/);
  assert.ok(!fs.existsSync(path.join(dir, "model.gguf.part")));
  await assert.rejects(downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(Buffer.alloc(bytes.length + 1)), log: quiet }), /exceeded/);
  await assert.rejects(downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://models.example/unsafe" } }), log: quiet }), /HTTPS/);
  await assert.rejects(downloadLocalArtifact({ ...artifact, name: "../escape" }, dir), /manifest/);
});
test("truncated downloads survive for retry and invalid ranges cannot append to them", async () => {
  const dir = makeTempDir("bw-local-download-");
  await assert.rejects(downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(bytes.subarray(0, 4)), log: quiet }), /interrupted/);
  await assert.rejects(downloadLocalArtifact(artifact, dir, { fetchImpl: async () => new Response(bytes, { status: 206, headers: { "content-range": "bytes 0-3/4" } }), log: quiet }), /byte range/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "model.gguf.part")), bytes.subarray(0, 4));
});
test("setup serializes mutations and only selects a model after the image/tool check", async () => {
  const home = makeTempDir("bw-local-setup-"), events: string[] = [];
  const dependencies = {
    detect: async () => hardware(), installLlama: async () => { events.push("runtime"); return "llama-server"; },
    installRuntime: async () => "llama-server", probe: async () => "MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)",
    disk: async () => {}, status: async () => ({ running: false }), stop: async () => true,
    download: async () => { events.push("download"); return "file"; }, connect: async () => ({ model: "local", apiKey: "fake", baseURL: "http://127.0.0.1:1/v1" }),
    verify: async () => { events.push("verified"); assert.equal(readLocalPlan(home), null); },
  };
  await setupLocalAI({}, home, quiet, dependencies);
  assert.equal(events[0], "runtime"); assert.equal(events.at(-1), "verified"); assert.equal(readLocalPlan(home).modelId, "nex-mini");
  assert.deepEqual(fs.readdirSync(home), ["local-ai"]);
  await assert.rejects(withLocalLock(home, "setup", () => withLocalLock(home, "setup", async () => {})), /already in progress/);
  const previous = fs.readFileSync(path.join(localRoot(home), "selection.json"), "utf8");
  await assert.rejects(setupLocalAI({ model: "ornith-9b" }, home, quiet, { ...dependencies, verify: async () => { throw new Error("invalid tool call"); } }), /invalid tool/);
  assert.equal(fs.readFileSync(path.join(localRoot(home), "selection.json"), "utf8"), previous);
});
test("setup rejects drivers, small memory and changed running models before weight downloads", async () => {
  const home = makeTempDir("bw-local-fail-"), events: string[] = [];
  const common = { installLlama: async () => "llama-server", probe: async () => "", download: async () => { events.push("download"); }, disk: async () => {} };
  await assert.rejects(setupLocalAI({}, home, quiet, { ...common, detect: async () => hardware(8) }), /more than 8 GB/);
  await assert.rejects(setupLocalAI({}, home, quiet, { ...common, detect: async () => hardware() }), /no accelerated GPU/);
  await assert.rejects(setupLocalAI({}, home, quiet, { ...common, detect: async () => hardware(), probe: async () => "MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)", status: async () => ({ running: true, planId: "other" }) }), /Another local model/);
  assert.deepEqual(events, []); assert.equal(readLocalPlan(home), null);
});
test("failed setup never stops a concurrently started or reused service", async () => {
  const home = makeTempDir("bw-local-setup-ownership-");
  const stopped: string[] = [];
  const common = { detect: async () => hardware(), installLlama: async () => "llama-server", installRuntime: async () => "llama-server",
    probe: async () => "MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)", status: async () => ({ running: false }),
    disk: async () => {}, download: async () => "file", stop: async (_home, token) => { stopped.push(token); return true; },
    verify: async () => { throw new Error("probe failed"); } };
  await assert.rejects(setupLocalAI({}, home, quiet, { ...common, connect: async () => { throw new Error("Another managed model is running"); } }), /Another/);
  for (const started of [false, true]) {
    await assert.rejects(setupLocalAI({}, home, quiet, { ...common,
      connect: async () => ({ model: "local", apiKey: started ? "new-owned-key" : "concurrent-key", baseURL: "http://127.0.0.1:1/v1", started }) }), /probe failed/);
  }
  assert.deepEqual(stopped, ["new-owned-key"]);
});
test("first automatic setup keeps acceleration only when the measured improvement exceeds noise", async () => {
  for (const faster of [false, true]) {
    const home = makeTempDir("bw-local-tune-"), modes: string[] = [], stopped: string[] = [];
    const dependencies = { detect: async () => hardware(), installLlama: async () => "llama-server", installRuntime: async () => "llama-server",
      probe: async () => "MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)", status: async () => ({ running: false }),
      disk: async () => {}, download: async () => "file", verify: async () => {},
      stop: async (_home, token) => { stopped.push(token); return true; },
      connect: async plan => { modes.push(plan.acceleration); return { model: "local", apiKey: plan.acceleration, baseURL: "http://127.0.0.1:1/v1", started: true }; },
      benchmark: async connection => connection.apiKey === "mtp" ? faster ? 150 : 102 : 100 };
    const result = await setupLocalAI({ model: "ornith-9b" }, home, quiet, dependencies);
    assert.equal(result.plan.acceleration, faster ? "mtp" : "none");
    assert.equal(readLocalPlan(home).accelerationTuned, true);
    assert.deepEqual(modes, faster ? ["mtp", "none", "mtp"] : ["mtp", "none"]);
    assert.deepEqual(stopped, faster ? ["mtp", "none"] : ["mtp"]);
    modes.length = 0; stopped.length = 0;
    await setupLocalAI({ model: "ornith-9b" }, home, quiet, { ...dependencies, benchmark: async () => { throw new Error("Do not retune an existing selection"); } });
    assert.deepEqual(modes, [faster ? "mtp" : "none"]); assert.deepEqual(stopped, []);
  }
});
test("readiness requires a parsed tool call with the actual image color", async () => {
  const connection = { model: "local", apiKey: "private-probe-key", baseURL: "http://127.0.0.1:1234/v1" };
  await verifyLocalModel(connection, async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(init.headers.authorization, "Bearer private-probe-key");
    assert.match(request.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "betterwright_probe", arguments: JSON.stringify({ color: "red", marker: "local-setup-check" }) } }] } }] });
  });
  await assert.rejects(verifyLocalModel(connection, async () => Response.json({ choices: [{ message: { content: "red" } }] })), /did not complete/);
});
test("runtime arguments keep vision, context and all layers on the selected accelerator", () => {
  const plan = recommendLocalModel(hardware()).plan;
  const args = localServerArguments(plan, 1234, "/tmp/local");
  for (const flag of ["--mmproj", "--jinja", "--flash-attn", "--device"]) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
  assert.equal(args[args.indexOf("--gpu-layers") + 1], "999");
  const cuda = localServerArguments(recommendLocalModel(hardware(64, 32, "nvidia", "linux", 12)).plan, 1234);
  assert.equal(cuda[cuda.indexOf("--tool-call-parser") + 1], "qwen3_coder");
  assert.ok(cuda.includes("--enforce-eager"));
  assert.equal(JSON.parse(cuda[cuda.indexOf("--speculative-config") + 1]).method, "mtp");
  const dflash = localServerArguments(recommendLocalModel(hardware(128, 96, "nvidia", "linux", 12)).plan, 1234, "/tmp/local");
  assert.deepEqual(JSON.parse(dflash[dflash.indexOf("--speculative-config") + 1]), { method: "dflash", model: draftDirectory("/tmp/local"), num_speculative_tokens: 7 });
  const mtp = localServerArguments(recommendLocalModel(hardware(), { model: "ornith-9b" }).plan, 1234);
  assert.equal(mtp[mtp.indexOf("--spec-type") + 1], "draft-mtp");
  assert.equal(mtp[mtp.indexOf("--spec-draft-device") + 1], "MTL0");
});
test("supervisor authenticates control, hides the key and owns child shutdown", async () => {
  const home = makeTempDir("bw-local-service-");
  const plan = { ...recommendLocalModel(hardware()).plan, platform: process.platform, arch: process.arch };
  const id = localPlanId(plan), runtime = runtimeDirectory(plan, home);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "fixture");
  writeLocalJson(path.join(localRoot(home), "plans", `${id}.json`), plan);
  const fixture = path.join(home, "model-server.cjs");
  fs.writeFileSync(fixture, `const http=require('node:http');http.createServer((q,r)=>{if(q.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){r.writeHead(403).end();return}r.setHeader('content-type','application/json');r.end(JSON.stringify({data:[{id:'betterwright-local'}]}))}).listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');`);
  let child;
  const done = serveLocalAI(id, home, (_command, args, options) => {
    child = spawn(process.execPath, [fixture], { ...options, env: { ...options.env, FIXTURE_PORT: args[args.indexOf("--port") + 1] } });
    return child;
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { if ((await localServiceStatus(home)).ready) { ready = true; break; } await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready);
    assert.equal(await stopLocalServiceIfOwned(home, "another-owner"), false);
    assert.equal((await localServiceStatus(home)).ready, true);
    const state = JSON.parse(fs.readFileSync(path.join(localRoot(home), "service.json"), "utf8"));
    assert.equal((await fetch(`http://127.0.0.1:${state.controlPort}/stop`, { method: "POST" })).status, 403);
    assert.ok(!JSON.stringify(await localServiceStatus(home)).includes(state.token));
    // An unreachable owner must remain authoritative, even if its API key
    // no longer authenticates. Never orphan its live child by replacing it.
    writeLocalJson(path.join(localRoot(home), "service.json"), { ...state, token: "0".repeat(64) });
    try {
      await assert.rejects(ensureLocalService(plan, home, 100), /Ownership was retained/);
      await assert.rejects(stopLocalService(home), /Ownership was retained/);
      assert.equal((await localServiceStatus(home)).running, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(localRoot(home), "service.json"), "utf8")).token, "0".repeat(64));
    } finally { writeLocalJson(path.join(localRoot(home), "service.json"), state); }
    assert.equal(await stopLocalService(home), true); await done;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal((await localServiceStatus(home)).running, false);
  } finally { await stopLocalService(home); child?.kill(); await done; }
});
test("failed ownership publication terminates the already spawned inference child", async () => {
  const home = makeTempDir("bw-local-publication-error-");
  const plan = { ...recommendLocalModel(hardware()).plan, platform: process.platform, arch: process.arch };
  const id = localPlanId(plan), runtime = runtimeDirectory(plan, home);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "fixture");
  writeLocalJson(path.join(localRoot(home), "plans", `${id}.json`), plan);
  fs.mkdirSync(path.join(localRoot(home), "service.json"));
  fs.writeFileSync(path.join(localRoot(home), "service.json", "block-rename"), "fixture");
  let child;
  await assert.rejects(serveLocalAI(id, home, (_command, _args, options) => {
    child = spawn(process.execPath, ["--eval", "setInterval(()=>{},1000)"], options);
    return child;
  }));
  assert.ok(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(!fs.existsSync(path.join(localRoot(home), `service.json.${process.pid}.tmp`)));
});
test("local help and fresh status do not install or initialize integrations", () => {
  const home = makeTempDir("bw-local-cli-");
  for (const args of [["--local", "--help"], ["local", "--help"], ["local", "status", "--json"]]) {
    const result = spawnSync(process.execPath, ["dist/bin/betterwright.js", ...args], { encoding: "utf8", env: { ...process.env, BETTERWRIGHT_HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    if (args.includes("--json")) assert.equal(JSON.parse(result.stdout).configured, false);
    else assert.match(result.stdout, /local/i);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});
test("JSON status reports invalid ownership with a failing exit code", () => {
  const home = makeTempDir("bw-local-status-error-");
  writeLocalJson(path.join(localRoot(home), "service.json"), {});
  const result = spawnSync(process.execPath, ["dist/bin/betterwright.js", "local", "status", "--json"], { encoding: "utf8", env: { ...process.env, BETTERWRIGHT_HOME: home } });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false); assert.match(report.error, /Invalid local service/);
});
test("local model discovery normalizes source case without starting inference", () => {
  const home = makeTempDir("bw-local-model-list-");
  writeLocalJson(path.join(localRoot(home), "selection.json"), recommendLocalModel(hardware()).plan);
  const result = spawnSync(process.execPath, ["dist/bin/betterwright.js", "models", "LOCAL"], { encoding: "utf8", env: { ...process.env, BETTERWRIGHT_HOME: home } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /local/);
  assert.deepEqual(fs.readdirSync(localRoot(home)), ["selection.json"]);
});
test("runtime extraction publishes only validated trees and recovers interrupted staging", async () => {
  const directory = path.join(makeTempDir("bw-local-extract-"), "runtime");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "old-partial"), "old");
  fs.mkdirSync(`${directory}.installing`); fs.writeFileSync(path.join(`${directory}.installing`, "interrupted"), "old");
  await assert.rejects(stageLocalRuntime(directory, async staging => {
    assert.deepEqual(fs.readdirSync(staging), []);
    fs.writeFileSync(path.join(staging, "partial"), "failed"); throw new Error("extraction interrupted");
  }), /interrupted/);
  assert.deepEqual(fs.readdirSync(directory), ["old-partial"]);
  assert.ok(!fs.existsSync(`${directory}.installing`));
  await stageLocalRuntime(directory, async staging => {
    assert.deepEqual(fs.readdirSync(staging), []);
    fs.writeFileSync(path.join(staging, "complete"), "validated");
  });
  assert.deepEqual(fs.readdirSync(directory), ["complete"]);
});
test("runtime readiness rejects stale markers and missing or broken executables", async () => {
  const directory = makeTempDir("bw-local-runtime-ready-");
  fs.writeFileSync(path.join(directory, ".ready"), "version-1");
  assert.equal(await localRuntimeReady(directory, "version-1", process.execPath), true);
  assert.equal(await localRuntimeReady(directory, "version-2", process.execPath), false);
  assert.equal(await localRuntimeReady(directory, "version-1", path.join(directory, "missing")), false);
  fs.writeFileSync(path.join(directory, "broken"), "broken");
  assert.equal(await localRuntimeReady(directory, "version-1", path.join(directory, "broken")), false);
});

test("Windows retries Vulkan if a CUDA binary starts but cannot enumerate its GPU", async () => {
  const home = makeTempDir("bw-local-cuda-fallback-"), backends: string[] = [];
  const r = await setupLocalAI({}, home, quiet, {
    detect: async () => hardware(64, 16, "nvidia", "win32", 8.9),
    installLlama: async (_platform, backend) => { backends.push(backend); return backend; },
    probe: async executable => executable === "cuda" ? "Available devices:" : "Vulkan0: NVIDIA test GPU (16384 MiB, 15000 MiB free)",
    status: async () => ({ running: false }), disk: async () => {}, installRuntime: async () => "vulkan",
    download: async () => "file", connect: async () => ({ model: "local", apiKey: "fake", baseURL: "http://127.0.0.1:1/v1" }), verify: async () => {},
  });
  assert.deepEqual(backends, ["cuda", "vulkan"]); assert.equal(r.plan.gpu.backend, "vulkan");
});

test("a complete verified partial is installed without another download after a crash", async () => {
  const dir = makeTempDir("bw-local-complete-partial-");
  fs.writeFileSync(path.join(dir, "model.gguf.part"), bytes);
  const file = await downloadLocalArtifact(artifact, dir, { fetchImpl: async () => { throw new Error("must stay offline"); }, log: quiet });
  assert.deepEqual(fs.readFileSync(file), bytes); assert.ok(!fs.existsSync(`${file}.part`));
  await assert.rejects(downloadLocalArtifact({ ...artifact, name: ".." }, dir), /manifest/);
});

test("old ownerless locks recover, while fresh and live owners are never stolen", async () => {
  const home = makeTempDir("bw-local-abandoned-lock-");
  fs.mkdirSync(localRoot(home), { recursive: true });
  const lock = path.join(localRoot(home), "setup.lock");
  fs.writeFileSync(lock, "");
  await assert.rejects(withLocalLock(home, "setup", async () => {}), /already in progress/);
  const past = new Date(Date.now() - 60_000); fs.utimesSync(lock, past, past);
  let entered = false;
  await withLocalLock(home, "setup", async () => { entered = true; assert.ok(fs.existsSync(path.join(lock, "owner.json"))); });
  assert.ok(entered);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); fs.utimesSync(lock, past, past);
  await assert.rejects(withLocalLock(home, "setup", async () => {}), /already in progress/);
});
test("stop waits for a startup that has not published service state yet", async () => {
  const home = makeTempDir("bw-local-stop-race-");
  let release;
  const held = withLocalLock(home, "lifecycle", () => new Promise<void>(resolve => { release = resolve; }));
  let stopped = false;
  const stop = stopLocalService(home).then(result => { stopped = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(stopped, false);
  release(); await held; assert.equal(await stop, false); assert.equal(stopped, true);
});
test("an invalid saved local selection cannot silently redirect a task to cloud", () => {
  const home = makeTempDir("bw-local-invalid-selection-");
  fs.mkdirSync(localRoot(home), { recursive: true }); fs.writeFileSync(path.join(localRoot(home), "selection.json"), "broken");
  assert.equal(preferredModelId({ env: { BETTERWRIGHT_HOME: home, OPENAI_API_KEY: "configured-cloud-key" }, auth: {} }).model, "local");
  assert.throws(() => readLocalPlan(home), /repair/);
});

test("the isolated vLLM environment pins Python and every resolved dependency", () => {
  assert.equal(LOCAL_PYTHON_VERSION, "3.12.13");
  const pins = LOCAL_VLLM_REQUIREMENTS.trim().split("\n");
  assert.equal(pins.length, 196);
  assert.ok(pins.includes(`vllm==${VLLM_VERSION}`));
  for (const pin of pins) assert.match(pin, /^[a-z0-9_.-]+==[a-z0-9.+-]+$/i);
});

test("restart verifies file content before launching and only reclaims conclusively dead owners", async () => {
  const home = makeTempDir("bw-local-restart-checksum-");
  const plan = { ...recommendLocalModel(hardware()).plan, platform: process.platform, arch: process.arch };
  const runtime = runtimeDirectory(plan, home), directory = modelDirectory(plan, home);
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(runtime, process.platform === "win32" ? "llama-server.exe" : "llama-server"), "fixture");
  const file = path.join(directory, localModel(plan).files[0].name);
  fs.writeFileSync(file, Buffer.alloc(bytes.length)); // Same size, wrong hash.
  const dead = spawnSync(process.execPath, ["--eval", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  writeLocalJson(path.join(localRoot(home), "service.json"), { controlPort: 1, port: 1, planId: localPlanId(plan), token: "1".repeat(64), supervisorPid: dead.pid, childPid: dead.pid });
  let verified = 0;
  await assert.rejects(ensureLocalService(plan, home, 100, async target => { verified++; return verifyLocalArtifact(target, artifact); }), /checksum/);
  assert.equal(verified, 1); assert.ok(!fs.existsSync(path.join(localRoot(home), "service.json")));
  assert.ok(!fs.existsSync(path.join(localRoot(home), "plans")));
});
