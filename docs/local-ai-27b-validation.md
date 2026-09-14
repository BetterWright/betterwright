# Compact Qwen 27B validation

Tested on 2026-09-14. Both managed profiles use 65,536 tokens, including input,
images, tool history, and output. Ornith 9B remains the 16 GB default.

## Model and runtime pins

| Profile | Immutable model revision | Runtime |
| --- | --- | --- |
| GSQ-RCO IQ3_S | `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF@d562806dbafae37109975e970aae91b43e73b440` | llama.cpp b10902, MTP-bearing GGUF, BF16 vision projector, Q8_0 K/V cache |
| Escha W2 Vision | `ProCreations/Qwen3.8-27B-Escha-W2-Vision@aba52e1d2544194d84cf86b29dc17c8c70da6f2e` | Escha 1.2.1+qwen3dense, PyTorch 2.9.1+cu128, Transformers 5.10.2, FP8 E4M3 KV cache |

The catalog pins each downloaded artifact's revision, size, and SHA-256.
The Escha dependency lock uses direct SHA-256-pinned CUDA Torch wheels and
exact PyPI package versions. Its environment is separate from vLLM.

## GPU capability and context checks

One RTX PRO 6000 Blackwell Workstation Edition, driver 595.84, Linux x64.
Escha used a 24 GiB allocation budget on this larger GPU. This controls the
runtime's allocation policy; it is not a physical 24 GB GPU or a hard memory
limit. Peak values are sampled total-device memory, including desktop usage.

| Profile | Context cap | Image/tool cases | Long tool-history prompt | Peak VRAM |
| --- | ---: | ---: | ---: | ---: |
| GSQ IQ3_S, MTP, Q8_0 K/V | 65,536 | 16/16 | 61,088 tokens | 17,009 MiB (16.61 GiB) |
| Escha, ordinary decoding, FP8 K/V | 65,536 | 16/16 | 61,093 tokens | 22,717 MiB (22.18 GiB) |
| Escha, MTP, FP8 K/V | 65,536 | 16/16 | 61,093 tokens | 23,051 MiB (22.51 GiB) |
| Escha, MTP, FP8 K/V | 131,072 | 16/16 | 126,629 tokens | 23,055 MiB (22.51 GiB) |

The 16 image cases cover colors, OCR, shape placement, counting, and checkout
totals. Every case requires a parsed function call. Additional checks exercise
text arithmetic and a tool-response follow-up. Long histories contain earlier,
middle, and superseded state plus screenshot OCR; retrieval and the following
tool-response turn passed. Separate near-limit image prompts passed at 64,746
tokens for GSQ and 130,287 for Escha's 128K profile.

The original Qwen reference also passed these 16 image cases. This establishes
synthetic smoke-test parity only, not general reasoning, visual benchmark, or
browser-agent parity. FP8 KV scales are runtime defaults (1.0), not separately
calibrated scales. No broad accuracy or cross-GPU speed claim follows from these
checks. The 128K Escha result is an additional launcher experiment; BetterWright
selects 64K.

Escha's language and MTP shards remain byte-identical to the original Escha
checkpoint. All 333 restored visual tensors match the original Qwen source.
The compact INT8 embedding lookup matched all 1,271,398,400 dequantized values
and saved 1.18 GiB without requantizing the vision or MTP head.

The public [model card, validation reports, and reproduction scripts](https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/tree/aba52e1d2544194d84cf86b29dc17c8c70da6f2e)
include the Escha measurements and their limitations. GSQ uses the publisher's
[IQ3_S MTP export and vision projector](https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/tree/d562806dbafae37109975e970aae91b43e73b440).

## Fresh installer and harness checks

A separate disposable environment exercised BetterWright's installer itself,
starting with an empty managed home. Both profiles downloaded and verified
their pinned artifacts, passed the image/tool readiness check, became the saved
local selection, and answered through `resolveModelSelection("local")`.
Unauthenticated requests were rejected; stop/restart and a second readiness
check passed. Runtime logs did not contain either launch's private API key.

The fresh Escha path installed managed Python, the private compiler, and its
complete dependency lock, then passed CUDA/Triton and vision-processor
preflight. These tests exposed and fixed rootless archive ownership, a
dependency-index collision, and Escha's rejection of the generic `none`
reasoning effort. Default and explicit `none` harness requests now use the
supported API value while disabling thinking through the chat template.

Repository validation: the final `bun run release:check` after the native-library
fix passed: 1,256 tests passed, 3 optional live tests skipped, zero failures,
plus lint, types, build, declarations, version and package checks. Two earlier
local retries encountered unrelated subprocess timeouts; the final full run
and the separate 75-test local-AI/profile-lock suite passed. The live catalog verifier checked all 127 distinct pinned artifacts
without downloading model weights. Hardware fixtures cover the new 24 GB
defaults, 16 GB exclusions, runtime restrictions, and fallback to GSQ before
model downloads if automatic Escha installation fails. Review regressions cover
compiler/library repair disk headroom and the different HTTP/template effort names.

Clean Ubuntu 24.04 Hugging Face jobs on A10G (Ampere) and L4 (Ada) stopped
during runtime preflight, before model downloads. Diagnosis exposed a missing
`libnuma.so.1` dependency. The installer now supplies pinned private libnuma and
its GCC runtime dependencies, probes the managed library directly, and reserves
repair space if it is missing or unloadable. Further paid GPU testing was
stopped at the requester's direction; the repaired installer and these models
still need physical RTX 4090 acceptance testing.

## Remaining physical coverage

The new checkpoints have physical acceptance coverage on the PRO 6000 only.
GSQ uses the existing Metal/CUDA/Vulkan/ROCm runtime paths, but this checkpoint
has not been physically tested on Apple, AMD, Windows, Ampere, or Ada hardware.
Escha is restricted to Linux NVIDIA Ampere or newer with at least 23.75 GiB
reported VRAM. Setup also requires 23.75 GiB free, covering the measured
22.51 GiB MTP peak plus over 1.2 GiB of headroom. Marginal A10G/L4 configurations
select GSQ for speed before downloading any model. Ordinary decoding keeps the
same conservative threshold; this is not a claim of physical-card validation. Hardware fixtures verify
selection and refusal rules; they do not substitute for physical GPU tests.
Every installation checks its runtime before downloading model weights and
checks image/tool responses before changing the harness default.

## RTX 4090 follow-up

From a checkout of this PR, use Bun 1.4.0, run `bun install --frozen-lockfile`
and `bun run build`, then test the default profile:

```sh
bun dist/bin/betterwright.js local plan --json
bun dist/bin/betterwright.js --local --model qwen-27b-gsq
bun dist/bin/betterwright.js local status --json
bun dist/bin/betterwright.js exec --model local "Open example.com and report its page heading."
bun dist/bin/betterwright.js local stop
```

On Linux x64 with glibc 2.35+ (Ubuntu 22.04+), repeat setup with
`--model qwen-27b-escha`, then the status, harness, and stop commands above.
Windows uses GSQ; Escha is Linux-only. Explicit selection makes an Escha
installation error visible rather than automatically falling back to GSQ.
Capture GPU/driver and OS versions, the plan's 65,536-token context, setup's
vision/tool result and acceleration comparison, runtime memory, and the
harness result. Also exercise a real long-running task, then stop and restart
the runtime. A successful short setup check alone does not establish 64K
history correctness or memory headroom on this card.
