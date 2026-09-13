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
| Linux x64, RTX 5090 / RTX Pro 6000 Blackwell with 32+ GiB | Qwen3.8-27B NVFP4 | vLLM with CUDA |
| Linux x64, pre-Blackwell NVIDIA with 48+ GiB and FP8 support, such as RTX 6000 Ada | Qwen3.8-27B FP8 | vLLM with CUDA |
| Linux x64, Ampere (A10G / RTX 30-series / A100) | Ornith 9B or Nex GGUF, according to VRAM | llama.cpp with Vulkan |
| Apple Silicon with 64+ GiB unified memory | Nex-N2.5-mini GGUF | llama.cpp with Metal |
| Other supported GPUs with 32+ GiB, including Windows NVIDIA and AMD | Nex-N2.5-mini GGUF | llama.cpp with CUDA or Vulkan |
| Smaller supported GPUs / Apple Silicon with enough headroom | Ornith-1.5-9B GGUF | llama.cpp with Metal, Vulkan, or CUDA |
| 8 GiB or less system or accelerator memory; CPU-only | No recommendation | No model installed |

Hopper (H100/H200) and Ada use native FP8 when Qwen fits. Ampere has no
native FP8/NVFP4 support and uses reviewed GGUF quants instead.

Linux llama.cpp uses Vulkan, covering compatible AMD, NVIDIA, and Intel GPUs.
Windows x64 tries the CUDA build for NVIDIA and otherwise uses Vulkan. Setup installs a private Vulkan loader and required GNU/X11 libraries. A working
GPU driver is required; Linux binary compatibility is checked before
weights are downloaded. Windows includes `tar.exe` on supported modern systems.
Intel Macs, Linux/Windows ARM, and GPUs without a supported accelerated runtime
are outside this installer. Windows users wanting Qwen's managed vLLM path can
run BetterWright inside GPU-enabled WSL2. The pinned vLLM wheels need glibc
2.35+ (such as Ubuntu 22.04 or newer), which is checked before installation.

`--preference speed` selects Nex on large GPUs and Q4_K_M for GGUF models.
The default `balanced` preference chooses the highest fitting GGUF quant up to
Q6_K; `quality` and machines with at least 90 GiB allow Q8_0. These preferences
trade weight bandwidth and memory against quantization quality; they are not
speed benchmark guarantees. Unsloth NVFP4 is preferred on Blackwell for native 4-bit acceleration, even
when FP8 also fits. Compatible older NVIDIA GPUs use FP8. An explicit
`--quant FP8` remains available on sufficiently large NVIDIA GPUs. No quant below 3 bits is accepted; the current catalog starts
at 4 bits. Insufficient memory is an error, not a lower-quality automatic fallback.

Memory budgeting includes the vision projector and reserves space for the
context cache and compute workspace. Apple Silicon also reserves macOS and
browser memory, using the runtime's Metal working-set limit. Context is 32K on
smaller accelerators and 64K at 48+ GiB. Other running GPU applications can still
prevent loading; close them and retry if the free-memory check fails.

Setup also selects compatible speculative decoding automatically. This uses a
draft head to propose several tokens for the target model to verify:

| Model/runtime | Automatic acceleration |
| --- | --- |
| Qwen 27B with vLLM on larger GPUs with sufficient headroom | DFlash2, using the original BF16 drafter from Inco AI |
| Qwen 27B with vLLM on 32 GiB Blackwell | Built-in MTP, three draft tokens; eager execution avoids CUDA graph memory overhead |
| Ornith 9B / 35B GGUF | Bundled MTP heads, three draft tokens on the selected accelerator |
| Nex-N2.5-mini GGUF | No speculative draft: the published weights omit MTP tensors |

For a first installation using `auto`, setup compares the candidate with ordinary
decoding on three short synthetic JSON, code, and browser-workflow prompts. It
keeps the candidate only when average output throughput improves by more than
5%; otherwise it selects ordinary decoding. The result is saved and reused.
This adds benchmark requests and model restarts to initial setup. Existing
selections are never stopped for automatic benchmarking. Explicit `mtp` or
`dflash2` overrides skip this comparison, while retaining the readiness check.

The DFlash2 download adds 3.58 GiB and reserves another 2 GiB of workspace. It
uses the same pinned-download, checksum, resume, and restart verification as
the target model. MTP weights are already included in the selected Ornith and
Qwen files. Nex's configuration contains an MTP field, but that alone does not
provide usable draft weights. Existing Flash Attention, GPU offload, and cache
tuning still apply to Nex.

Use `--acceleration auto|none|mtp|dflash2` to override the automatic choice.
Incompatible or oversized drafts are rejected. `none` is useful for comparing
performance or diagnosing a runtime issue; target weights are reused. Stop the
runtime before changing acceleration. The final accelerated runtime must pass
the image/tool-call check before setup changes the harness default. Speed gains
depend on draft acceptance, prompts, context length, and hardware; no fixed
speedup multiplier is promised.

## Choices and lifecycle

```bash
betterwright --local --preference speed
betterwright --local --preference quality
betterwright --local --model ornith-35b --quant Q5_K_M
betterwright --local --acceleration auto
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
Python 3.12.13 and all 196 Python package versions, installing wheels only.
A private GCC 14.3.0 C/C++ toolchain supports Triton and CUDA runtime
compilation without sudo or a system compiler. All 19 conda-forge toolchain
archives are pinned by SHA-256 and installed offline using pinned micromamba. No model repository code
is executed with `trust_remote_code`.

- [Nex-N2.5-mini](https://huggingface.co/nex-agi/Nex-N2.5-mini), using
  [Bartowski's GGUFs](https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF).
- [Ornith 9B GGUFs](https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF) and
  [Ornith 35B-A3B GGUFs](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF),
  published by the model authors.
- [Unsloth Qwen3.8-27B NVFP4](https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4)
  and [Qwen's FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8).
- [Inco AI's DFlash2 drafter](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2),
  configured using the [vLLM Qwen recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B).
- [llama.cpp speculative decoding](https://github.com/ggml-org/llama.cpp/blob/b10902/docs/speculative.md).

Automated tests cover the hardware/quant matrix, download corruption and resume,
setup failure behavior, and private service lifecycle. Real acceptance testing
used an M4 Max 64 GiB with Ornith 9B Q4_K_M: image/tool-call setup check, guarded
browser navigation, clicking, result verification, and screenshot proof. AMD,
Windows, high-end NVIDIA and the larger models still need real hardware
acceptance testing; fixture coverage does not establish their speed or universal
compatibility. Each installation performs its own image/tool check before the
harness default changes.

Maintainers can run `bun run build:harness` followed by
`bun research/verify-local-ai-catalog.ts` to verify every model/draft pin against
its immutable Hugging Face revision without downloading weights. For a vLLM
refresh, resolve the exact top-level version using pinned uv with
`pip compile --python-version 3.12.13 --python-platform x86_64-manylinux_2_35
--only-binary :all: --no-annotate --no-header --strip-extras`, review every changed
pin in `src/local-ai-vllm-lock.ts`, and repeat fresh GPU acceptance testing.

The GNU compiler lock was resolved with micromamba 2.9.0 for `linux-64`,
`CONDA_OVERRIDE_GLIBC=2.35`, `gcc_linux-64=14.3.0`, and `gxx_linux-64=14.3.0`
from conda-forge. Review the complete resolved archive URLs, sizes, and SHA-256
hashes in `src/local-ai-toolchain-lock.ts` whenever refreshing it. Setup installs
these verified archives offline; it does not resolve newer compiler packages.
