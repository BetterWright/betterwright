import path from "node:path";

import { flagValue, positionalArgs } from "./cli-flags.js";
import { defaultHome } from "./home.js";
import { detectLocalHardware, GIB, hasLocalSelection, type LocalSetupOptions, localInstallArtifacts, localModel, localPlanId, localRoot, modelDirectory, parseLlamaDevices, readLocalPlan, recommendLocalModel,
  runLocalProbe, writeLocalJson } from "./local-ai.js";
import { checkLocalDisk, downloadLocalArtifact, installLlamaRuntime, installLocalRuntime, type LocalLog, llamaRuntimeEnvironment, localRuntimeEnvironment, withLocalLock } from "./local-ai-install.js";
import { configuredLocalConnection, ensureLocalService, type LocalConnection, localServerArguments, localServiceStatus, stopLocalService, stopLocalServiceIfOwned } from "./local-ai-service.js";
import { isNumber, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

// A synthetic red image, no browser/profile input. The model must see the
// image and return a parsed tool call before setup becomes the default.
const PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAIAAAD9b0jDAAAAJUlEQVR4nGP4z8BAdUR9E0cNHTV01NBRQ0cNHTV01NBRQweloQAOyg0e8L+IEAAAAABJRU5ErkJggg==";
export async function verifyLocalModel(connection: LocalConnection, fetchImpl: typeof fetch = fetch) {
  const marker = "local-setup-check";
  const response = await fetchImpl(`${connection.baseURL}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${connection.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: connection.model, temperature: 0, max_tokens: 512, reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" },
      messages: [{ role: "user", content: [{ type: "text", text: `Use the betterwright_probe tool to report the single solid color of this image. Copy marker '${marker}' into the call. Do not answer in prose.` },
        { type: "image_url", image_url: { url: PROBE_IMAGE } }] }],
      tools: [{ type: "function", function: { name: "betterwright_probe", description: "Report the observed image color and the supplied marker.",
        parameters: { type: "object", properties: { color: { type: "string", enum: ["red", "green", "blue", "white", "black"] }, marker: { type: "string" } }, required: ["color", "marker"] } } }], tool_choice: "auto" }),
  });
  if (!response.ok) throw new Error(`The local runtime failed its vision/tool-call check (HTTP ${response.status}). No harness default was changed.`);
  const body: UntrustedValue = await response.json();
  const choices = untrustedField(body, "choices");
  const message = Array.isArray(choices) ? untrustedField(choices[0], "message") : null;
  const calls = untrustedField(message, "tool_calls");
  const matched = Array.isArray(calls) && calls.some(call => {
    const fn = untrustedField(call, "function");
    if (untrustedField(fn, "name") !== "betterwright_probe") return false;
    const args = untrustedField(fn, "arguments");
    if (!isString(args)) return false;
    try { const parsed: UntrustedValue = JSON.parse(args); return untrustedField(parsed, "color") === "red" && untrustedField(parsed, "marker") === marker; } catch { return false; }
  });
  if (!matched) throw new Error("The local model did not complete the image-and-tool-call check. No harness default was changed. See local-ai/runtime.log.");
}

/** Short, synthetic browser/code-like turns. Compare both modes on this host. */
export async function benchmarkLocalModel(connection: LocalConnection, fetchImpl: typeof fetch = fetch): Promise<number> {
  const prompts = ["Reply with OK.",
    "Return JSON with an array of 12 objects, each with id (1 through 12), label (item followed by id), and selected (true for even ids). No prose.",
    "Write JavaScript selectEnabled(records) that returns sorted ids of records where enabled is true. Include six assert examples.",
    "Write a browser test plan for adding two cart items, removing one, changing quantity, checking total, and cancelling checkout. Include expected results."];
  const rates: number[] = [];
  for (const [i, prompt] of prompts.entries()) {
    const start = performance.now();
    const response = await fetchImpl(`${connection.baseURL}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${connection.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: connection.model, temperature: 0, max_tokens: i ? 128 : 8, reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" }, messages: [{ role: "user", content: prompt }] }),
    });
    const body: UntrustedValue = await response.json();
    const tokens = untrustedField(untrustedField(body, "usage"), "completion_tokens");
    if (!response.ok || !isNumber(tokens) || tokens <= 0) throw new Error("The local acceleration speed check did not receive a valid completion.");
    if (i) rates.push(tokens * 1000 / Math.max(1, performance.now() - start));
  }
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

export interface LocalSetupDependencies {
  detect?: typeof detectLocalHardware;
  installLlama?: typeof installLlamaRuntime;
  installRuntime?: typeof installLocalRuntime;
  download?: typeof downloadLocalArtifact;
  probe?: typeof runLocalProbe;
  connect?: typeof ensureLocalService;
  verify?: typeof verifyLocalModel;
  status?: typeof localServiceStatus;
  stop?: typeof stopLocalServiceIfOwned;
  disk?: typeof checkLocalDisk;
  benchmark?: typeof benchmarkLocalModel;
}
export async function setupLocalAI(options: LocalSetupOptions, home = defaultHome(), log: LocalLog = console.log, dependencies: LocalSetupDependencies = {}) {
  const detect = dependencies.detect || detectLocalHardware, probe = dependencies.probe || runLocalProbe;
  const installLlama = dependencies.installLlama || installLlamaRuntime, installRuntime = dependencies.installRuntime || installLocalRuntime;
  const connect = dependencies.connect || ensureLocalService, verify = dependencies.verify || verifyLocalModel;
  const benchmark = dependencies.benchmark || benchmarkLocalModel;
  const status = dependencies.status || localServiceStatus, stop = dependencies.stop || stopLocalServiceIfOwned;
  return withLocalLock(home, "setup", async () => {
    const previouslyConfigured = hasLocalSelection(home);
    const running = await status(home);
    if (running.error) throw new Error(running.error);
    let managedPlan = null;
    try { const saved = readLocalPlan(home); if (saved && running.ready && running.planId === localPlanId(saved)) managedPlan = saved; } catch { /* Setup can repair invalid selections. */ }
    const accountForManagedWeights = (hardware: Awaited<ReturnType<typeof detect>>) => ({ ...hardware, gpus: hardware.gpus.map(gpu =>
      managedPlan && (gpu.uuid ? gpu.uuid === managedPlan.gpu.uuid : gpu.id === managedPlan.gpu.id)
        ? { ...gpu, freeMemory: gpu.memory } : gpu) });
    let hardware = accountForManagedWeights(await detect());
    if (hardware.memory <= 8 * GIB || !((hardware.platform === "darwin" && hardware.arch === "arm64") || (["linux", "win32"].includes(hardware.platform) && hardware.arch === "x64"))) {
      recommendLocalModel(hardware, options); // Fail before installing even a small runtime.
    }
    const native = hardware.gpus;
    const provisional = native.some(g => g.memory > 8 * GIB) ? recommendLocalModel(hardware, options) : null;
    if (provisional?.plan.runtime !== "vllm") {
      log("Checking the accelerated runtime before downloading model weights…");
      let backend = hardware.platform === "darwin" ? "metal" : hardware.platform === "win32" && native.some(g => g.vendor === "nvidia" && g.compute >= 7.5) ? "cuda" : "vulkan";
      let executable: string;
      let devices: string;
      try {
        executable = await installLlama(hardware.platform, backend, home, log);
        devices = await probe(executable, ["--list-devices"], llamaRuntimeEnvironment(hardware.platform, home));
        if (backend === "cuda" && !parseLlamaDevices(devices, native).length) throw new Error("No usable CUDA device.");
      }
      catch (error) {
        if (backend !== "cuda") throw error;
        log("The CUDA build is unavailable with this driver; checking Vulkan acceleration.");
        backend = "vulkan";
        executable = await installLlama(hardware.platform, backend, home, log);
        devices = await probe(executable, ["--list-devices"], llamaRuntimeEnvironment(hardware.platform, home));
      }
      hardware = accountForManagedWeights({ ...hardware, gpus: parseLlamaDevices(devices, native) });
      if (!hardware.gpus.length) throw new Error("The runtime found no accelerated GPU. Install a working Metal/Vulkan GPU driver and rerun betterwright --local; no model weights were downloaded.");
    }
    const recommendation = recommendLocalModel(hardware, options);
    let { plan } = recommendation;
    const { model } = recommendation;
    const automatic = !options.acceleration || options.acceleration === "auto";
    try {
      const saved = readLocalPlan(home);
      if (automatic && saved?.accelerationTuned && modelDirectory(saved, home) === modelDirectory(plan, home) &&
        saved.context === plan.context && saved.platform === plan.platform && saved.gpu.id === plan.gpu.id && saved.gpu.uuid === plan.gpu.uuid) {
        plan = { ...plan, acceleration: saved.acceleration, accelerationTuned: true };
      }
    } catch { /* Invalid selections remain repairable by setup. */ }
    const updateRecommendation = () => {
      const oldDraft = recommendation.plan.acceleration === "dflash2";
      recommendation.reserveBytes += ((plan.acceleration === "dflash2" ? 1 : 0) - (oldDraft ? 1 : 0)) * 2 * GIB;
      recommendation.plan = plan;
      recommendation.downloadBytes = localInstallArtifacts(plan, home).reduce((sum, item) => sum + item.artifact.bytes, 0);
      if (plan.accelerationTuned) recommendation.reason = `The saved speed check on this hardware selected ${plan.acceleration}. Model quality and the reserved memory budget are unchanged.`;
    };
    updateRecommendation();
    log(`Hardware: ${plan.gpu.name} (${(plan.gpu.memory / GIB).toFixed(1)} GiB accelerator memory)`);
    log(`Model: ${model.name} · ${model.quant} · ${plan.runtime} · ${plan.context.toLocaleString()} token context`);
    log(`Acceleration: ${plan.acceleration}`);
    log(`Source: ${model.repository}@${model.revision.slice(0, 12)}`);
    log(`Model download: ${(recommendation.downloadBytes / GIB).toFixed(2)} GiB including vision support`);
    log(recommendation.reason);
    if (running.running && running.planId !== localPlanId(plan)) throw new Error("Another local model is running. Run betterwright local stop, then repeat setup to change models.");
    if (!running.running && plan.gpu.freeMemory < recommendation.downloadBytes + 2 * GIB) throw new Error("There is not enough free accelerator memory for the selected model and context. Close GPU-heavy applications and retry; the recommendation will not silently drop to a lower-quality model.");
    await (dependencies.disk || checkLocalDisk)(plan, home);
    const executable = await installRuntime(plan, home, log);
    if (plan.runtime === "vllm") {
      // Validate both CUDA and the pinned runtime's real argument parser
      // before spending bandwidth on weights. Request logging defaults off.
      const preflight = "import json,sys,torch; from vllm.entrypoints.launchers.cli_args import make_arg_parser,validate_parsed_serve_args; from vllm.utils.argparse_utils import FlexibleArgumentParser; args=make_arg_parser(FlexibleArgumentParser()).parse_args(json.loads(sys.argv[1])); validate_parsed_serve_args(args); assert not args.enable_log_requests, 'Request logging must be disabled'; assert torch.cuda.is_available(), 'CUDA driver/runtime is unavailable'; from triton.backends.nvidia.driver import CudaUtils; CudaUtils(); print(torch.cuda.get_device_name(0))";
      await probe(path.join(path.dirname(executable), "python"), ["-c", preflight, JSON.stringify(localServerArguments(plan, 8000, home).slice(1))], { ...localRuntimeEnvironment(plan, home), CUDA_VISIBLE_DEVICES: plan.gpu.uuid }, 120_000);
    }
    for (const { artifact, directory } of localInstallArtifacts(plan, home)) await (dependencies.download || downloadLocalArtifact)(artifact, directory, { log });
    log("Loading the model and checking image input plus tool calls…");
    let connection: LocalConnection | null = null;
    try {
      connection = await connect(plan, home);
      await verify(connection);
      // Only tune a first installation we own. Existing selections may be
      // serving concurrent tasks, so repeating setup never benchmarks/stops
      // their service. The selected speed result is retained for later use.
      if (automatic && !previouslyConfigured && connection.started && plan.acceleration !== "none") {
        log(`Comparing ${plan.acceleration} with ordinary decoding on synthetic tasks…`);
        const acceleratedPlan = plan;
        const acceleratedRate = await benchmark(connection);
        if (!await stop(home, connection.apiKey)) throw new Error("Local runtime ownership changed during the speed check. Retry setup.");
        connection = null;
        plan = { ...plan, acceleration: "none" };
        connection = await connect(plan, home);
        await verify(connection);
        const baselineRate = await benchmark(connection);
        if (acceleratedRate > baselineRate * 1.05) {
          if (!await stop(home, connection.apiKey)) throw new Error("Local runtime ownership changed during the speed check. Retry setup.");
          connection = null;
          plan = acceleratedPlan;
          connection = await connect(plan, home);
          await verify(connection);
        }
        plan = { ...plan, accelerationTuned: true };
        updateRecommendation();
        log(`Speed check: ${acceleratedPlan.acceleration} ${acceleratedRate.toFixed(1)} vs ordinary ${baselineRate.toFixed(1)} output tokens/s. Selected ${plan.acceleration}.`);
      }
      writeLocalJson(path.join(localRoot(home), "selection.json"), plan);
    } catch (error) {
      if (connection?.started) await stop(home, connection.apiKey).catch(() => {});
      throw error;
    }
    log("Local AI is ready and selected for the BetterWright harness.");
    log("Run betterwright or betterwright exec \"<task>\". Use --model local to select it explicitly.");
    log("The runtime starts automatically when needed. betterwright local stop releases its memory.");
    return recommendation;
  });
}

export async function runLocalCommand(args: string[], { home = defaultHome(), log = console.log }: { home?: string; log?: LocalLog } = {}): Promise<number> {
  const positional = positionalArgs(args), command = positional[0] || "setup";
  const allowed = new Set(["--preference", "--model", "--quant", "--acceleration", "--json"]);
  for (const arg of args.filter(a => a.startsWith("--"))) if (!allowed.has(arg.split("=")[0])) { log(`Unknown local AI option: ${arg}`); return 1; }
  if (positional.length > 1 || !["setup", "plan", "status", "start", "stop"].includes(command)) { log("Use betterwright local setup|plan|status|start|stop."); return 1; }
  const json = args.includes("--json");
  if (json && !["plan", "status"].includes(command)) { log("--json is supported by local plan and local status."); return 1; }
  const options = { preference: flagValue(args, "--preference"), model: flagValue(args, "--model"), quant: flagValue(args, "--quant"), acceleration: flagValue(args, "--acceleration") };
  for (const flag of ["--preference", "--model", "--quant", "--acceleration"]) {
    const value = flagValue(args, flag);
    if (args.some(a => a === flag || a.startsWith(`${flag}=`)) && (!value || value.startsWith("--"))) { log(`${flag} requires a value.`); return 1; }
  }
  try {
    if (command === "setup") { await setupLocalAI(options, home, log); return 0; }
    if (command === "plan") {
      const recommendation = recommendLocalModel(await detectLocalHardware(), options);
      if (json) log(JSON.stringify(recommendation, null, 2));
      else log(`${recommendation.model.name} · ${recommendation.model.quant} · ${recommendation.plan.runtime}\n${recommendation.reason}\n${(recommendation.downloadBytes / GIB).toFixed(2)} GiB of model files. Run betterwright --local to verify the accelerator and install.`);
      return 0;
    }
    if (command === "stop") { log(await stopLocalService(home) ? "Local AI stopped; model files and harness selection are retained." : "No managed local runtime is running."); return 0; }
    if (command === "start") { await configuredLocalConnection(home); log("Local AI is ready."); return 0; }
    const plan = readLocalPlan(home), status = await localServiceStatus(home);
    if (status.error && !json) { log(`Local AI: ${status.error}`); return 1; }
    const report = { configured: Boolean(plan), model: plan ? localModel(plan).name : null, quant: plan?.quant || null, runtime: plan?.runtime || null, acceleration: plan?.acceleration || null, ...status };
    log(json ? JSON.stringify(report, null, 2) : plan ? `${report.model} · ${report.quant} · ${report.runtime}: ${status.ready ? "ready" : status.running ? "starting" : "stopped (starts when the harness needs it)"}` : "No local model configured. Run betterwright --local.");
    return status.error ? 1 : 0;
  } catch (error) {
    const message = error?.message || String(error);
    log(json ? JSON.stringify({ ok: false, error: message }) : `Local AI: ${message}`);
    return 1;
  }
}
