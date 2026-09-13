# One-command local AI for the harness

After installing BetterWright and its browser, run:

```bash
betterwright --local
betterwright exec "Open example.com and summarize the page"
```

The first command detects the accelerator, chooses a reviewed model and quant,
installs a private inference runtime, downloads verified model files, and checks
image understanding plus parsed tool calls. Only a successful check selects
`local` as the default for `betterwright` and `betterwright exec`.

This configures BetterWright's own agent harness. The skill, MCP server, browser
SDK, and `betterwright run` continue to use the models chosen by their host agents.
An explicit `--model`, `BETTERWRIGHT_MODEL`, or custom endpoint still takes
precedence. Use `--model local` to return to the managed model.

## Hardware and recommendations

Setup uses a single accelerator with enough memory; it does not add together
small GPUs or silently offload layers to the CPU. Both system memory and usable
accelerator memory must exceed 8 GiB. Existing GPU drivers are required. Setup
checks that the selected runtime can use the accelerator before downloading
model weights, and reports a repairable error when a driver is missing.

| Hardware | Default model | Runtime |
| --- | --- | --- |
| Linux x64, RTX 5090 / 32 GiB Blackwell | Qwen3.8-27B NVFP4 | vLLM with CUDA |
| Linux x64, compatible NVIDIA with 48+ GiB and FP8 support, including RTX Pro 6000 | Qwen3.8-27B FP8 | vLLM with CUDA |
| Apple Silicon with 64+ GiB unified memory | Nex-N2.5-mini GGUF | llama.cpp with Metal |
| Other supported GPUs with 32+ GiB, including Windows NVIDIA and AMD | Nex-N2.5-mini GGUF | llama.cpp with CUDA or Vulkan |
| Smaller supported GPUs / Apple Silicon with enough headroom | Ornith-1.5-9B GGUF | llama.cpp with Metal, Vulkan, or CUDA |
| 8 GiB or less system or accelerator memory; CPU-only | No recommendation | No model installed |

Linux llama.cpp uses Vulkan, covering compatible AMD, NVIDIA, and Intel GPUs.
Windows x64 tries the CUDA build for NVIDIA and otherwise uses Vulkan. A working
Vulkan driver/loader is required; Linux binary compatibility is checked before
weights are downloaded. Windows includes `tar.exe` on supported modern systems.
Intel Macs, Linux/Windows ARM, and GPUs without a supported accelerated runtime
are outside this installer. Windows users wanting Qwen's managed vLLM path can
run BetterWright inside GPU-enabled WSL2. The pinned vLLM wheels need glibc
2.35+ (such as Ubuntu 22.04 or newer), which is checked before installation.

`--preference speed` selects Nex on large GPUs and Q4_K_M for GGUF models.
The default `balanced` preference chooses the highest fitting GGUF quant up to
Q6_K; `quality` and machines with at least 90 GiB allow Q8_0. These preferences
trade weight bandwidth and memory against quantization quality; they are not
speed benchmark guarantees. FP8 is preferred to NVFP4 where it fits on supported
NVIDIA hardware. No quant below 3 bits is accepted; the current catalog starts
at 4 bits. Insufficient memory is an error, not a lower-quality automatic fallback.

Memory budgeting includes the vision projector and reserves space for the
context cache and compute workspace. Apple Silicon also reserves macOS and
browser memory, using the runtime's Metal working-set limit. Context is 32K on
smaller accelerators and 64K at 48+ GiB. Other running GPU applications can still
prevent loading; close them and retry if the free-memory check fails.

## Choices and lifecycle

```bash
betterwright --local --preference speed
betterwright --local --preference quality
betterwright --local --model ornith-35b --quant Q5_K_M
betterwright local plan --json
betterwright local status --json
betterwright local stop
betterwright local start
```

`local setup` is equivalent to `--local`. Model overrides are `nex-mini`,
`ornith-35b`, `ornith-9b`, and `qwen-27b`. Quant overrides must be compatible
reviewed variants that fit: Q4_K_M, Q5_K_M, Q6_K, Q8_0, NVFP4, or FP8.

`local plan` is a read-only estimate from native hardware information. On a
Vulkan-only host without native NVIDIA information, run setup to install the
small runtime and enumerate actual devices. Setup makes the final choice from
that enumeration. It prints the model, source, quant, context, and download size.

`local stop` releases model memory while keeping downloaded files and the
selection. A later harness task starts it again automatically. Stop a running
model before choosing a different one. Repeating setup reuses checksum-verified
files, resumes partial downloads, and reruns the readiness check. A failed setup
preserves the previous selection. Concurrent setup/start attempts are locked, and stop waits for an
in-progress startup before releasing model memory. An invalid saved selection
produces an explicit repair error; it never silently redirects a local task to
a configured cloud provider. Select another model explicitly to use it.

Installation lives under `~/.betterwright/local-ai` (or
`BETTERWRIGHT_HOME/local-ai`). Model downloads need roughly 6–38 GiB depending on
the quant. The isolated vLLM/Python installation additionally reserves 30 GiB;
llama.cpp needs much less. Setup checks free disk space with safety headroom and
never downloads model weights to another machine. To remove the installation,
stop it, then delete this `local-ai` directory. That also removes the default.

Every fresh model load rechecks the catalog SHA-256 hashes. If a supervisor
becomes unreachable, startup retains its ownership record and refuses to start
a replacement until both recorded processes are conclusively gone. Stop never
kills a process based only on a stale PID. A suspended owner must be resumed
or its recorded processes stopped before lifecycle commands can recover.

The inference API binds only to `127.0.0.1`, uses a randomly generated private
key, and has a separate authenticated supervisor for start/status/stop. Status
output omits the key. Runtime output is in `local-ai/runtime.log`. Initial setup
needs GitHub, Hugging Face and, for vLLM, Python package downloads. Subsequent
inference loads local weights with Hugging Face offline mode enabled. Browser
network access continues to follow BetterWright's normal guard policy.

## Model provenance and validation

The catalog pins repository revisions, byte sizes, and SHA-256 hashes. Downloads
stream to resumable partial files, are verified, then atomically installed.
Runtime archives are also versioned and checksummed. The vLLM environment pins
Python 3.12.13 and all 196 Python package versions, installing wheels only. No model repository code
is executed with `trust_remote_code`.

- [Nex-N2.5-mini](https://huggingface.co/nex-agi/Nex-N2.5-mini), using
  [Bartowski's GGUFs](https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF).
- [Ornith 9B GGUFs](https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF) and
  [Ornith 35B-A3B GGUFs](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF),
  published by the model authors.
- [NVIDIA Qwen3.8-27B NVFP4](https://huggingface.co/nvidia/Qwen3.8-27B-NVFP4)
  and [Qwen's FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8).

Automated tests cover the hardware/quant matrix, download corruption and resume,
setup failure behavior, and private service lifecycle. Real acceptance testing
used an M4 Max 64 GiB with Ornith 9B Q4_K_M: image/tool-call setup check, guarded
browser navigation, clicking, result verification, and screenshot proof. AMD,
Windows, high-end NVIDIA and the larger models still need real hardware
acceptance testing; fixture coverage does not establish their speed or universal
compatibility. Each installation performs its own image/tool check before the
harness default changes.
