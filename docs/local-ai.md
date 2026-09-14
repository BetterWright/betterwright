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
| Nominal 24 GB GPUs, including RTX 4090 / RTX 3090 / A10G / Radeon 7900 XTX | Qwen3.8-27B GSQ-RCO IQ3_S with vision and MTP, 64K context | llama.cpp with CUDA, ROCm, or Vulkan |
| Linux x64, NVIDIA Ampere+ with nominal 24 GB, `--preference speed` | Qwen3.8-27B Escha W2 with restored vision and MTP, 64K context | Escha SGLang with CUDA |
| Ampere with 32+ GiB, such as A100 | Nex GGUF | llama.cpp with CUDA |
| Apple Silicon with 64+ GiB unified memory | Nex-N2.5-mini GGUF | llama.cpp with Metal |
| Linux x64, AMD Instinct MI100/MI200/MI300/MI350 families | Nex-N2.5-mini GGUF | llama.cpp with private ROCm 10.0 |
| Other supported GPUs with 32+ GiB, including Windows NVIDIA and AMD Radeon | Nex-N2.5-mini GGUF | llama.cpp with CUDA or Vulkan |
| 16 GB GPUs and smaller supported GPUs / Apple Silicon with enough headroom | Ornith-1.5-9B GGUF | llama.cpp with Metal, Vulkan, or CUDA |
| 8 GiB or less system or accelerator memory; CPU-only | No recommendation | No model installed |

Hopper (H100/H200) and Ada use native FP8 when Qwen fits. Ampere has no
native FP8/NVFP4 weight acceleration and uses reviewed GGUF quants by default. The optional Escha kernels support Ampere without requiring native FP8 matrix multiplication.

Linux and Windows x64 try CUDA for NVIDIA and fall back to Vulkan when CUDA
is unavailable. If an automatically selected Python runtime installation or preflight
fails, setup checks llama.cpp and chooses a compatible reviewed GGUF model
before downloading weights. Explicit model, quant, or speculative-draft choices
remain strict and report the failure. AMD Radeon and compatible Intel GPUs use Vulkan. Supported Instinct families use
a private, checksummed AMD ROCm 10.0 SDK, selected from kernel-reported GPU
architecture and VRAM. It does not install or change kernel drivers. The ROCm
SDK download is about 2–3 GiB; MI300X expands to about 11 GiB; setup
checks disk headroom before downloading it. Linux CUDA uses only
the application layers from the official, pinned llama.cpp CUDA 12.8 image, plus
verified NVIDIA runtime libraries; it needs neither Docker nor a system CUDA
toolkit. Setup installs a private Vulkan loader and required GNU/X11 libraries. A working
GPU driver is required; Linux binary compatibility is checked before
weights are downloaded. Windows includes `tar.exe` on supported modern systems.
Intel Macs, Linux/Windows ARM, and GPUs without a supported accelerated runtime
are outside this installer. Windows users wanting Qwen's managed vLLM path can
run BetterWright inside GPU-enabled WSL2. The pinned vLLM wheels need glibc
2.35+ (such as Ubuntu 22.04 or newer), which is checked before installation.

`--preference speed` selects Escha W2 on eligible 24 GB Linux NVIDIA GPUs, Nex on larger GPUs, and Q4_K_M for other GGUF models. On other 24 GB platforms, GSQ IQ3_S remains the portable choice.
The default `balanced` preference chooses the highest fitting GGUF quant up to
Q6_K; `quality` and machines with at least 90 GiB allow Q8_0. These preferences
trade weight bandwidth and memory against quantization quality; they are not
speed benchmark guarantees. Unsloth NVFP4 is preferred on Blackwell for native 4-bit acceleration, even
when FP8 also fits. Compatible older NVIDIA GPUs use FP8. An explicit
`--quant FP8` remains available on sufficiently large NVIDIA GPUs. GSQ IQ3_S is a reviewed mixed-precision build averaging about 3.5 bits per weight. Escha W2 is an explicit exception to the usual 3-bit floor: its original projections mix 2/3-bit storage, while its embedding and output head remain INT8. Arbitrary lower-bit quants are still rejected. Insufficient memory is an error, not a lower-quality automatic fallback.

Memory budgeting includes the vision projector and reserves space for the
context cache and compute workspace. Apple Silicon also reserves macOS and
browser memory, using the runtime's Metal working-set limit. Context is 32K on smaller accelerators and 64K for both new 27B profiles and at 48+ GiB. Ornith 1.5 9B remains the 16 GB default so model weights leave room for agent history. Both new 27B profiles require nominal 24 GB discrete GPUs; explicit GSQ selection also supports Apple Silicon with at least 32 GB unified memory and enough reported Metal memory. Other running GPU applications can still
prevent loading; close them and retry if the free-memory check fails.

Setup also selects compatible speculative decoding automatically. This uses a
draft head to propose several tokens for the target model to verify:

| Model/runtime | Automatic acceleration |
| --- | --- |
| Qwen 27B with vLLM on larger GPUs with sufficient headroom | DFlash2, using the original BF16 drafter from Inco AI |
| Qwen 27B with vLLM on 32 GiB Blackwell | Built-in MTP, three draft tokens; eager execution avoids CUDA graph memory overhead |
| Ornith 9B / 35B GGUF | Bundled MTP heads, three draft tokens on the selected accelerator |
| Qwen 27B GSQ IQ3_S / Escha W2 Vision | Bundled native MTP; compared with ordinary decoding during automatic setup |
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
`ornith-35b`, `ornith-9b`, `qwen-27b`, `qwen-27b-gsq`, and `qwen-27b-escha`. Quant overrides must be compatible
reviewed variants that fit: Q4_K_M, Q5_K_M, Q6_K, Q8_0, IQ3_S, NVFP4, FP8,
or the Escha-W2 exception.

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
the quant. Each isolated vLLM or Escha Python installation additionally reserves 30 GiB;
llama.cpp needs much less. Setup checks free disk space with safety headroom and
downloads model weights only on the machine where the command runs. To remove the installation,
stop it, then delete this `local-ai` directory. That also removes the default.

Every fresh model load rechecks the catalog SHA-256 hashes. If a supervisor
becomes unreachable, startup retains its ownership record and refuses to start
a replacement until both recorded processes are conclusively gone. Stop never
kills a process based only on a stale PID. A suspended owner must be resumed
or its recorded processes stopped before lifecycle commands can recover.

The inference API binds only to `127.0.0.1`, uses a randomly generated private
key, and has a separate authenticated supervisor for start/status/stop. Status
output omits the key. Runtime output is in `local-ai/runtime.log`. Initial setup
needs GitHub, Hugging Face and, for vLLM or Escha, Python package downloads. Subsequent
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
is executed with `trust_remote_code`. Escha executes its explicitly pinned,
checksummed launcher and runtime patch from the reviewed vision repository.

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
setup failure behavior, private service lifecycle, suspended startup cancellation,
and process-ID reuse. Real acceptance tests exercise initial image/tool-call
validation, the saved harness default, guarded browser navigation and clicking,
result verification, screenshot proof, and stop/restart:

| Hardware | Model and quant | Acceptance result |
| --- | --- | --- |
| M4 Max, 64 GiB | Ornith 9B Q4_K_M, Metal | Passed, including automatic MTP comparison |
| NVIDIA A10G, Ampere | Ornith 9B Q6_K, CUDA 12.8 | Passed, including automatic MTP comparison |
| NVIDIA H200, Hopper | Qwen 27B FP8, vLLM | Passed with DFlash2 and ordinary decoding |
| NVIDIA L40S, Ada | Qwen 27B FP8, vLLM | Passed with DFlash2 and ordinary decoding |
| Rented RTX Pro 6000, Blackwell | Unsloth Qwen 27B NVFP4, vLLM | Passed with DFlash2 and ordinary decoding |
| AMD Instinct MI300X, 192 GiB | Nex Q8_0, ROCm 10.0 | Passed; Ornith 9B Q6_K also passed image/tool checks with MTP and ordinary decoding |

On three synthetic 256-token JSON, code, and workflow requests, DFlash2 improved
end-to-end throughput by 2.8–4.5× on Blackwell, 2.9–4.1× on H200, and 3.8–4.9×
on L40S. On MI300X, Nex decoded at 134–137 tokens/s; Ornith's MTP decoded at
174–241 tokens/s versus 132–133 with ordinary decoding. The first-install
speed check selected MTP on A10G (97.6 versus 57.5 output tokens/s) and ordinary
decoding on M4 Max (61.0 versus 52.9). These are short acceptance measurements,
not guarantees for longer contexts or other workloads.

The first Nex browser run completed the requested interaction but used the wrong
screenshot API and did not register proof. Repeating with an explicit instruction
to use `screenshot({kind:'proof'})` passed the proof-file assertion. Local model
outputs still require the harness's normal result and proof verification.

Windows, consumer Radeon/Intel GPUs, Instinct families other than MI300X,
RTX 5090 with 32 GiB, and Nex on Metal
still need physical acceptance testing. Cross-platform CI and hardware fixtures
do not establish universal compatibility. Each installation performs its own
image/tool check before the harness default changes.

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

## Compact 27B models for long agent histories

```bash
# Portable 24 GB default: GSQ IQ3_S, native MTP, Q8_0 KV cache, 64K context.
betterwright --local --model qwen-27b-gsq

# Linux NVIDIA Ampere+ with nominal 24 GB or more: Escha, FP8 KV cache, 64K.
betterwright --local --model qwen-27b-escha
```

[GSQ-RCO IQ3_S](https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF)
uses the publisher's MTP-bearing GGUF plus its vision projector. This path uses
BetterWright's existing pinned llama.cpp runtime across compatible CUDA, Metal,
Vulkan, and ROCm devices. Native MTP is enabled; DFlash2 is not wired into this
GGUF runtime. Automatic setup retains MTP only if the initial speed comparison
improves throughput; use `--acceleration mtp` to select it explicitly.

[Escha W2 Vision](https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision)
restores the original Qwen vision encoder and merger to the Escha language
checkpoint. It installs a separate Python 3.12 environment with the vendor's
SGLang fork, PyTorch 2.9.1+cu128, and Transformers 5.10.2. A hash-checked runtime
patch keeps the existing INT8 embeddings compact and prevents authentication
keys from appearing in the server configuration log. Its MTP and vision weights
retain their original precision. This runtime supports Linux NVIDIA only; it
is not an AMD, Apple, Ollama, or standard Transformers format.

The default compact-Qwen request disables thinking. Explicit `--effort low` or
`medium` enables that template effort; `high`, `xhigh`, and `max` select Qwen's `xhigh` template effort while using the HTTP API's supported `high` value.
`--effort none` disables thinking with valid API controls.

Escha uses FP8 E4M3 KV cache; GSQ uses Q8_0 K/V cache. These cache formats are
separate from weight quantization. Escha's default KV scale is 1.0, with no
separately calibrated scales in this checkpoint. The model card documents the
capability tests and their limits. An 8K fallback is not used to make the 27B
models fit a smaller card. The window includes prompts, screenshots, tool
history, and generated output, so a harness must still budget or compact history
before it is exhausted.

Validation was performed on one RTX PRO 6000 Blackwell. Escha's 24 GiB allocation
profiles passed synthetic vision/tool and long-history retrieval checks at 64K
and 128K. These are allocation-profile measurements, not tests on a physical
RTX 4090 or a guarantee of complete visual/reasoning benchmark parity. The
managed default is 64K. See the [validation record](local-ai-27b-validation.md)
for GSQ measurements and installer checks. Existing NVFP4/DFlash2 choices on larger
Blackwell GPUs remain available.
