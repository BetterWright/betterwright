// Reviewed model artifacts. Revisions and every downloaded byte are pinned.
// Quant sources include model authors, Unsloth, Bartowski, and ISTA-DASLab.
// Escha W2 is an explicitly reviewed mixed 2/3-bit exception; other models keep the 3-bit floor.
export interface LocalArtifact {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
  subdirectory?: "mtp";
}
export interface LocalModel {
  id: string;
  name: string;
  quant: string;
  bits: number;
  runtime: "llama.cpp" | "vllm" | "escha";
  repository: string;
  revision: string;
  files: LocalArtifact[];
  mtp: boolean;
}
export const LOCAL_MODELS: LocalModel[] = [
  {
    "id": "qwen-27b-escha",
    "name": "Qwen3.8-27B Escha W2 Vision",
    "quant": "Escha-W2",
    "bits": 2.469,
    "runtime": "escha",
    "repository": "ProCreations/Qwen3.8-27B-Escha-W2-Vision",
    "revision": "aba52e1d2544194d84cf86b29dc17c8c70da6f2e",
    "mtp": true,
    "files": [
      {
        "name": "LICENSE",
        "bytes": 11444,
        "sha256": "8dc4cd455799e521ed476b5ddc15a84fd8f25271fef409ed092f01dee6995998",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/LICENSE"
      },
      {
        "name": "chat_template.jinja",
        "bytes": 8952,
        "sha256": "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/chat_template.jinja"
      },
      {
        "name": "config.json",
        "bytes": 69751,
        "sha256": "2ea43844403dde9df94237be9b6aa7269d6cedc0e863788b6c8d8f3175feefa9",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/config.json"
      },
      {
        "name": "generation_config.json",
        "bytes": 202,
        "sha256": "e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/generation_config.json"
      },
      {
        "name": "merges.txt",
        "bytes": 3353259,
        "sha256": "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/merges.txt"
      },
      {
        "name": "model-00001-of-00002.safetensors",
        "bytes": 5337335240,
        "sha256": "5eb7bae90fc0dd63710d0215546462c6ab582fb2aa9cf064cbd257ba939df87e",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/model-00001-of-00002.safetensors"
      },
      {
        "name": "model-00002-of-00002.safetensors",
        "bytes": 4815752984,
        "sha256": "3fb5d551314e2122db1ad64325b792eae325deafceafda9090761275e39ac7c7",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/model-00002-of-00002.safetensors"
      },
      {
        "name": "model.safetensors.index.json",
        "bytes": 351387,
        "sha256": "735247e42563b86b113edaa9a3be92675b851be9d4a04234a70e01192807ac6a",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/model.safetensors.index.json"
      },
      {
        "name": "config.json",
        "bytes": 3636,
        "sha256": "75ee6918f289ce855ca196cfdedfa29ae572054441554e7c33977ebde4565b5f",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/mtp/config.json",
        "subdirectory": "mtp"
      },
      {
        "name": "model.safetensors",
        "bytes": 849400408,
        "sha256": "51f430e5c08186ad9ed37043e4c34ee1f7841695e0932a62e28f281048f893a8",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/mtp/model.safetensors",
        "subdirectory": "mtp"
      },
      {
        "name": "patch_runtime.py",
        "bytes": 4348,
        "sha256": "8f54beaf5ae26d852a02ee88e1706ccb1b9ca9bb03bffba558d26f711297aea2",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/patch_runtime.py"
      },
      {
        "name": "preprocessor_config.json",
        "bytes": 390,
        "sha256": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/preprocessor_config.json"
      },
      {
        "name": "quantize_config.json",
        "bytes": 44,
        "sha256": "a35856553feb607f6278fb4bf76442dfd9d603d2fdb5d30c0cf4087c4cd13c92",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/quantize_config.json"
      },
      {
        "name": "serve_vision.py",
        "bytes": 2866,
        "sha256": "1fe5ddf28f2e69c7a6fc11510016cfdd6a35408f6fa104e82acd0c1335130a08",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/serve_vision.py"
      },
      {
        "name": "tokenizer.json",
        "bytes": 12809320,
        "sha256": "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/tokenizer.json"
      },
      {
        "name": "tokenizer_config.json",
        "bytes": 16357,
        "sha256": "854e1f9eaf01518389646815c91e914c02554c2e1b0dd1dc1d184751e22f038c",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/tokenizer_config.json"
      },
      {
        "name": "vendor_serve.sh",
        "bytes": 23951,
        "sha256": "39862c85f6d9909ab4b7c93bc5edac4b366ae31c2a0cfdcb1a3787053cede81e",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/vendor_serve.sh"
      },
      {
        "name": "video_preprocessor_config.json",
        "bytes": 385,
        "sha256": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/video_preprocessor_config.json"
      },
      {
        "name": "vision.safetensors",
        "bytes": 921497312,
        "sha256": "c2a83f353af25b17adb9fdbd18e89d4dec47cd89332a82d23f3db063555596f6",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/vision.safetensors"
      },
      {
        "name": "vocab.json",
        "bytes": 6722759,
        "sha256": "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003",
        "url": "https://huggingface.co/ProCreations/Qwen3.8-27B-Escha-W2-Vision/resolve/aba52e1d2544194d84cf86b29dc17c8c70da6f2e/vocab.json"
      }
    ]
  },
  {
    "id": "qwen-27b-gsq",
    "name": "Qwen3.8-27B GSQ-RCO",
    "quant": "IQ3_S",
    "bits": 3.5,
    "runtime": "llama.cpp",
    "repository": "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
    "revision": "d562806dbafae37109975e970aae91b43e73b440",
    "mtp": true,
    "files": [
      {
        "name": "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
        "bytes": 12120016960,
        "sha256": "58fd826723939933dc86f45b7fe04545cbc2de1c70f6fe2cdd3858c87a98c12f",
        "url": "https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/resolve/d562806dbafae37109975e970aae91b43e73b440/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"
      },
      {
        "name": "mmproj-Qwen3.8-27B-BF16.gguf",
        "bytes": 931146528,
        "sha256": "13cb7bebccbd04afc8f4090cb949ecf8937cdf7377c5799b1a0c594e7c0d3e16",
        "url": "https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/resolve/d562806dbafae37109975e970aae91b43e73b440/mmproj-Qwen3.8-27B-BF16.gguf"
      }
    ]
  },
  {
    "id": "nex-mini",
    "mtp": false,
    "name": "Nex-N2.5-mini",
    "quant": "Q4_K_M",
    "bits": 4,
    "runtime": "llama.cpp",
    "repository": "bartowski/nex-agi_Nex-N2.5-mini-GGUF",
    "revision": "0048da1ad2ad33fdcf8b24bc12185cdebfe459d6",
    "files": [
      {
        "name": "mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf",
        "bytes": 902821984,
        "sha256": "a42698e6a0c3d46160d7f61576f7472603ab02e2dcefa951421dbb3993f3d27d",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf"
      },
      {
        "name": "nex-agi_Nex-N2.5-mini-Q4_K_M.gguf",
        "bytes": 22318512256,
        "sha256": "7f4b8e921dd000e7232c48f53a67a022da22914a52f9fdf972cbdab6f9c407ef",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/nex-agi_Nex-N2.5-mini-Q4_K_M.gguf"
      }
    ]
  },
  {
    "id": "nex-mini",
    "mtp": false,
    "name": "Nex-N2.5-mini",
    "quant": "Q5_K_M",
    "bits": 5,
    "runtime": "llama.cpp",
    "repository": "bartowski/nex-agi_Nex-N2.5-mini-GGUF",
    "revision": "0048da1ad2ad33fdcf8b24bc12185cdebfe459d6",
    "files": [
      {
        "name": "mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf",
        "bytes": 902821984,
        "sha256": "a42698e6a0c3d46160d7f61576f7472603ab02e2dcefa951421dbb3993f3d27d",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf"
      },
      {
        "name": "nex-agi_Nex-N2.5-mini-Q5_K_M.gguf",
        "bytes": 26984675456,
        "sha256": "d38e48485769a18f2a73d712f5083f1b4cdd60a8000131149387d55e3cc60153",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/nex-agi_Nex-N2.5-mini-Q5_K_M.gguf"
      }
    ]
  },
  {
    "id": "nex-mini",
    "mtp": false,
    "name": "Nex-N2.5-mini",
    "quant": "Q6_K",
    "bits": 6,
    "runtime": "llama.cpp",
    "repository": "bartowski/nex-agi_Nex-N2.5-mini-GGUF",
    "revision": "0048da1ad2ad33fdcf8b24bc12185cdebfe459d6",
    "files": [
      {
        "name": "mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf",
        "bytes": 902821984,
        "sha256": "a42698e6a0c3d46160d7f61576f7472603ab02e2dcefa951421dbb3993f3d27d",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf"
      },
      {
        "name": "nex-agi_Nex-N2.5-mini-Q6_K.gguf",
        "bytes": 29373331584,
        "sha256": "37299c1ccf386db35144a2cc86eca7c5598a94e62af3fe797d593bd601f47103",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/nex-agi_Nex-N2.5-mini-Q6_K.gguf"
      }
    ]
  },
  {
    "id": "nex-mini",
    "mtp": false,
    "name": "Nex-N2.5-mini",
    "quant": "Q8_0",
    "bits": 8,
    "runtime": "llama.cpp",
    "repository": "bartowski/nex-agi_Nex-N2.5-mini-GGUF",
    "revision": "0048da1ad2ad33fdcf8b24bc12185cdebfe459d6",
    "files": [
      {
        "name": "mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf",
        "bytes": 902821984,
        "sha256": "a42698e6a0c3d46160d7f61576f7472603ab02e2dcefa951421dbb3993f3d27d",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/mmproj-nex-agi_Nex-N2.5-mini-bf16.gguf"
      },
      {
        "name": "nex-agi_Nex-N2.5-mini-Q8_0.gguf",
        "bytes": 36914690176,
        "sha256": "035e6b4b30557441171b5f9fe144463cbd0dcce764cec72e5d8189a887cd4b04",
        "url": "https://huggingface.co/bartowski/nex-agi_Nex-N2.5-mini-GGUF/resolve/0048da1ad2ad33fdcf8b24bc12185cdebfe459d6/nex-agi_Nex-N2.5-mini-Q8_0.gguf"
      }
    ]
  },
  {
    "id": "ornith-35b",
    "mtp": true,
    "name": "Ornith-1.5-35B-A3B",
    "quant": "Q4_K_M",
    "bits": 4,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    "revision": "12393612fd4f730ff5aadc23e9b8f9648aa49ceb",
    "files": [
      {
        "name": "Ornith-1.5-35B-Q4_K_M.gguf",
        "bytes": 21713463040,
        "sha256": "42739874cc2ccfdb8523b23fbe52e29b2a7555c8176737ca9ca0b5d59859d41f",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/Ornith-1.5-35B-Q4_K_M.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-35B-BF16.gguf",
        "bytes": 902822240,
        "sha256": "1921a36a85aee56cd2abd27f46701802c9d85a33474792e600df6c3b282a135d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/mmproj-Ornith-1.5-35B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-35b",
    "mtp": true,
    "name": "Ornith-1.5-35B-A3B",
    "quant": "Q5_K_M",
    "bits": 5,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    "revision": "12393612fd4f730ff5aadc23e9b8f9648aa49ceb",
    "files": [
      {
        "name": "Ornith-1.5-35B-Q5_K_M.gguf",
        "bytes": 25347532544,
        "sha256": "91df97de5845100e850b4b5ec5ff35695382020b880fad6f7f51787b3a953bd0",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/Ornith-1.5-35B-Q5_K_M.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-35B-BF16.gguf",
        "bytes": 902822240,
        "sha256": "1921a36a85aee56cd2abd27f46701802c9d85a33474792e600df6c3b282a135d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/mmproj-Ornith-1.5-35B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-35b",
    "mtp": true,
    "name": "Ornith-1.5-35B-A3B",
    "quant": "Q6_K",
    "bits": 6,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    "revision": "12393612fd4f730ff5aadc23e9b8f9648aa49ceb",
    "files": [
      {
        "name": "Ornith-1.5-35B-Q6_K.gguf",
        "bytes": 29208731392,
        "sha256": "15d4658bbfc9c6034621729c15bbb50662c82b32a7ddd9624a1e545a74bdbb4b",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/Ornith-1.5-35B-Q6_K.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-35B-BF16.gguf",
        "bytes": 902822240,
        "sha256": "1921a36a85aee56cd2abd27f46701802c9d85a33474792e600df6c3b282a135d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/mmproj-Ornith-1.5-35B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-35b",
    "mtp": true,
    "name": "Ornith-1.5-35B-A3B",
    "quant": "Q8_0",
    "bits": 8,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    "revision": "12393612fd4f730ff5aadc23e9b8f9648aa49ceb",
    "files": [
      {
        "name": "Ornith-1.5-35B-Q8_0.gguf",
        "bytes": 37802149280,
        "sha256": "de46c4baf4b4dd85ea438bb0f757f21c38841a353506579979bba114311658c3",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/Ornith-1.5-35B-Q8_0.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-35B-BF16.gguf",
        "bytes": 902822240,
        "sha256": "1921a36a85aee56cd2abd27f46701802c9d85a33474792e600df6c3b282a135d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/resolve/12393612fd4f730ff5aadc23e9b8f9648aa49ceb/mmproj-Ornith-1.5-35B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-9b",
    "mtp": true,
    "name": "Ornith-1.5-9B",
    "quant": "Q4_K_M",
    "bits": 4,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-9B-GGUF",
    "revision": "abdd624b12ebf020b767fff532ff44fe552b28c3",
    "files": [
      {
        "name": "Ornith-1.5-9B-Q4_K_M.gguf",
        "bytes": 5780090816,
        "sha256": "70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q4_K_M.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-9B-BF16.gguf",
        "bytes": 921704672,
        "sha256": "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/mmproj-Ornith-1.5-9B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-9b",
    "mtp": true,
    "name": "Ornith-1.5-9B",
    "quant": "Q5_K_M",
    "bits": 5,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-9B-GGUF",
    "revision": "abdd624b12ebf020b767fff532ff44fe552b28c3",
    "files": [
      {
        "name": "Ornith-1.5-9B-Q5_K_M.gguf",
        "bytes": 6642544576,
        "sha256": "e4d9634a3b6546a5c00a8680568fe1125f6c98c704ee51ae52ba07650fb4247d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q5_K_M.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-9B-BF16.gguf",
        "bytes": 921704672,
        "sha256": "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/mmproj-Ornith-1.5-9B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-9b",
    "mtp": true,
    "name": "Ornith-1.5-9B",
    "quant": "Q6_K",
    "bits": 6,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-9B-GGUF",
    "revision": "abdd624b12ebf020b767fff532ff44fe552b28c3",
    "files": [
      {
        "name": "Ornith-1.5-9B-Q6_K.gguf",
        "bytes": 7558901696,
        "sha256": "b6f76e74f86245b3caee014b797c10dca931c4dfdaabfb134eab655f81e4154a",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q6_K.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-9B-BF16.gguf",
        "bytes": 921704672,
        "sha256": "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/mmproj-Ornith-1.5-9B-BF16.gguf"
      }
    ]
  },
  {
    "id": "ornith-9b",
    "mtp": true,
    "name": "Ornith-1.5-9B",
    "quant": "Q8_0",
    "bits": 8,
    "runtime": "llama.cpp",
    "repository": "ornith-ai/Ornith-1.5-9B-GGUF",
    "revision": "abdd624b12ebf020b767fff532ff44fe552b28c3",
    "files": [
      {
        "name": "Ornith-1.5-9B-Q8_0.gguf",
        "bytes": 9786060384,
        "sha256": "22086870b009dbe9815ee752c48a82de930118a7c5ce5599590892ae03b8b010",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q8_0.gguf"
      },
      {
        "name": "mmproj-Ornith-1.5-9B-BF16.gguf",
        "bytes": 921704672,
        "sha256": "626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d",
        "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/mmproj-Ornith-1.5-9B-BF16.gguf"
      }
    ]
  },
  {
    "id": "qwen-27b",
    "mtp": true,
    "name": "Qwen3.8-27B",
    "quant": "NVFP4",
    "bits": 4,
    "runtime": "vllm",
    "repository": "unsloth/Qwen3.8-27B-NVFP4",
    "revision": "f0b7c9e722f5565102fff8481c99e4d86ae099c7",
    "files": [
      {
        "name": "chat_template.jinja",
        "bytes": 9993,
        "sha256": "12827f24b742ea4e80cdc12dbcf9622227056b9f797252a3149263d4f9aaadce",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/chat_template.jinja"
      },
      {
        "name": "config.json",
        "bytes": 22564,
        "sha256": "1b3c71868d1299e52df6fc907deb202d5132b1ef0f72aae0ef6d15185dd53a5c",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/config.json"
      },
      {
        "name": "generation_config.json",
        "bytes": 214,
        "sha256": "d0d0ed2e37cdfafef4a5067d5ea2407b05f4fb50526e47c008a5b235d50240fb",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/generation_config.json"
      },
      {
        "name": "model.safetensors",
        "bytes": 22568192096,
        "sha256": "c473512c70eace07e2256fe9fd76596ac03e3295bee7d54cfb72676416afcc05",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/model.safetensors"
      },
      {
        "name": "model.safetensors.index.json",
        "bytes": 164371,
        "sha256": "429430e1b9e65b2cb98eff8cd10a06e70a09cee89c48487a3914684aeb6df57f",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/model.safetensors.index.json"
      },
      {
        "name": "model_mtp.safetensors",
        "bytes": 849400392,
        "sha256": "1d8268aa85ace093a561e3e7b63b9d390dac1cd55a90cd55b5ec509c3c9da9fe",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/model_mtp.safetensors"
      },
      {
        "name": "preprocessor_config.json",
        "bytes": 390,
        "sha256": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/preprocessor_config.json"
      },
      {
        "name": "tokenizer.json",
        "bytes": 19989325,
        "sha256": "06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/tokenizer.json"
      },
      {
        "name": "tokenizer_config.json",
        "bytes": 1047,
        "sha256": "529f30018c36dca5387c99b5edf368287f386f2c32d3790aa7141956bc5119fa",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/tokenizer_config.json"
      },
      {
        "name": "video_preprocessor_config.json",
        "bytes": 385,
        "sha256": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/video_preprocessor_config.json"
      },
      {
        "name": "vocab.json",
        "bytes": 6722759,
        "sha256": "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003",
        "url": "https://huggingface.co/unsloth/Qwen3.8-27B-NVFP4/resolve/f0b7c9e722f5565102fff8481c99e4d86ae099c7/vocab.json"
      }
    ]
  },
  {
    "id": "qwen-27b",
    "mtp": true,
    "name": "Qwen3.8-27B",
    "quant": "FP8",
    "bits": 8,
    "runtime": "vllm",
    "repository": "Qwen/Qwen3.8-27B-FP8",
    "revision": "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a",
    "files": [
      {
        "name": "chat_template.jinja",
        "bytes": 8952,
        "sha256": "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/chat_template.jinja"
      },
      {
        "name": "config.json",
        "bytes": 51350,
        "sha256": "74227dd615bf1ea975aa676bdf355a0379858c12f394b5365cd9dfa5fc2c70bc",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/config.json"
      },
      {
        "name": "crc32.txt",
        "bytes": 2426,
        "sha256": "5ccb0f7436ae756484561fe915780509845f903ea1780dbe9b0a3a7a0dd095ac",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/crc32.txt"
      },
      {
        "name": "generation_config.json",
        "bytes": 202,
        "sha256": "e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/generation_config.json"
      },
      {
        "name": "layers-0.safetensors",
        "bytes": 383865448,
        "sha256": "07f700e293baeaf3cd4240c3df1a948c4403f16961ea7979e86c8d6a9f8fd466",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-0.safetensors"
      },
      {
        "name": "layers-1.safetensors",
        "bytes": 383865448,
        "sha256": "35840b5d452c6e438d000e5c1d8d1bc793d257394404689b8f9424749eee8edc",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-1.safetensors"
      },
      {
        "name": "layers-10.safetensors",
        "bytes": 383865472,
        "sha256": "ab5fbc076ccd6514aba3ab67a0ac1d6701ad395d40cccc0086cf0284ef5d68c9",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-10.safetensors"
      },
      {
        "name": "layers-11.safetensors",
        "bytes": 372313760,
        "sha256": "076b4ba44e9311c8fb8fdc0045f8ce9fd0c75584ade4e95510056b7db4b7ec61",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-11.safetensors"
      },
      {
        "name": "layers-12.safetensors",
        "bytes": 383865472,
        "sha256": "86d8ec0b8fc8e3ffbdfd667b97050533ddf5a4d273b4fe1190a4335542c52829",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-12.safetensors"
      },
      {
        "name": "layers-13.safetensors",
        "bytes": 383865472,
        "sha256": "71dd986134f4338a7b8290ed24993ad34a0f77b76a4cc060fe6403e36dcdda5b",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-13.safetensors"
      },
      {
        "name": "layers-14.safetensors",
        "bytes": 383865472,
        "sha256": "95b285915cba994917b527030874227382ea3421dc7f47d804c0ca5851f039fb",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-14.safetensors"
      },
      {
        "name": "layers-15.safetensors",
        "bytes": 372313760,
        "sha256": "1e87d61e77d2b802f796ab8a049b1119648c9b70d2ba1067f456e5a04449cfc3",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-15.safetensors"
      },
      {
        "name": "layers-16.safetensors",
        "bytes": 383865472,
        "sha256": "8bcdbf4e2c7a8dda3043c4453a476b30a582d58aabfaa49b2829a8b66a664acb",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-16.safetensors"
      },
      {
        "name": "layers-17.safetensors",
        "bytes": 383865472,
        "sha256": "571cea44717878cc8cbbfbd544acfe2d155f5b963fbf5dc67b3fa96afe840a1b",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-17.safetensors"
      },
      {
        "name": "layers-18.safetensors",
        "bytes": 383865472,
        "sha256": "d8700627ca2267fb7beb5d398d6a659a9bfeeb2af76f10e6827b1e4359d59286",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-18.safetensors"
      },
      {
        "name": "layers-19.safetensors",
        "bytes": 372313760,
        "sha256": "2b24cfb752bbed959c614d7fd85412ee27ab2ac1f47deef5d09d0592781400e4",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-19.safetensors"
      },
      {
        "name": "layers-2.safetensors",
        "bytes": 383865448,
        "sha256": "32e63c6455ebfa10b4c36af2878eefcb6f8ccf8e947a62575444dc412c38ac1a",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-2.safetensors"
      },
      {
        "name": "layers-20.safetensors",
        "bytes": 383865472,
        "sha256": "52fd00c68d4f1df96ba701290c04237257ebb832879bb0b6a629525809d84a64",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-20.safetensors"
      },
      {
        "name": "layers-21.safetensors",
        "bytes": 383865472,
        "sha256": "e3c29dd949808c13116d853ce4b0f96cb1238fc0cb6999ab76735deef6bda77a",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-21.safetensors"
      },
      {
        "name": "layers-22.safetensors",
        "bytes": 383865472,
        "sha256": "63446546e3e09c2394fc51855f4e390cb47f896bb8b744f3a210c3159a3ccaf2",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-22.safetensors"
      },
      {
        "name": "layers-23.safetensors",
        "bytes": 372313760,
        "sha256": "4166ed11d0329985f9813ba6a70474ea9f5aeff3d97db3d7b2e81185bd41a996",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-23.safetensors"
      },
      {
        "name": "layers-24.safetensors",
        "bytes": 383865472,
        "sha256": "720bdcfe12b6627bed29feda9c96256e15c20602704669d05097668a9f03dd45",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-24.safetensors"
      },
      {
        "name": "layers-25.safetensors",
        "bytes": 383865472,
        "sha256": "1b188e7e4e8ae6f5d753c597f61d86c1593495de4307c273d8dda9946ec48bb4",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-25.safetensors"
      },
      {
        "name": "layers-26.safetensors",
        "bytes": 383865472,
        "sha256": "ad8c3e3d4b79dfedad674318ee4b150b2cd78b56747c7c8d88a65818109a545d",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-26.safetensors"
      },
      {
        "name": "layers-27.safetensors",
        "bytes": 372313760,
        "sha256": "8d63f461430045960f27a22abf685bfc7445fffbb24764e4a7fa993ba7edac08",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-27.safetensors"
      },
      {
        "name": "layers-28.safetensors",
        "bytes": 383865472,
        "sha256": "f78557cda66107ce25f8c5ecde2f83da874b3bf7c50381e062e14e7294a5b64d",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-28.safetensors"
      },
      {
        "name": "layers-29.safetensors",
        "bytes": 383865472,
        "sha256": "09f264d6fdddab0fb5ecce18034a9a01944d15118147c97058fba101a60f8af1",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-29.safetensors"
      },
      {
        "name": "layers-3.safetensors",
        "bytes": 372313744,
        "sha256": "302f9af90bb683a8be9e96d124b470a2eddee6612c95c39a8e93f26eb654563d",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-3.safetensors"
      },
      {
        "name": "layers-30.safetensors",
        "bytes": 383865472,
        "sha256": "54afe4fc7262ee597d4d9b80d2d6fe8ae501846ff124334b575bed4c6850ed97",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-30.safetensors"
      },
      {
        "name": "layers-31.safetensors",
        "bytes": 372313760,
        "sha256": "2779338203d0715ca323ac0b7fdbb0d450ce2bd1694be395a211a02ade3f34d9",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-31.safetensors"
      },
      {
        "name": "layers-32.safetensors",
        "bytes": 383865472,
        "sha256": "f4af8893594458b6cdb074ef20f9accb708361fe904012465990d09e74994509",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-32.safetensors"
      },
      {
        "name": "layers-33.safetensors",
        "bytes": 383865472,
        "sha256": "8f038505b9fc7d0b31ca976c728b56028ec28390a15ca0410f00df18d3abc1a4",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-33.safetensors"
      },
      {
        "name": "layers-34.safetensors",
        "bytes": 383865472,
        "sha256": "0b28f43cc4d3ae50e37eb3c2ce12a6e181b1c7586a27d5a05c6a3367f08286c9",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-34.safetensors"
      },
      {
        "name": "layers-35.safetensors",
        "bytes": 372313760,
        "sha256": "535b61b9eabbcda5de20e21d2d46fb52528cc9c1f8fac38920382ea2f1030837",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-35.safetensors"
      },
      {
        "name": "layers-36.safetensors",
        "bytes": 383865472,
        "sha256": "2babd209cafbe12a6e375ff6e7a1029f36ee8226f2a9babf6646630f31dd3fb8",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-36.safetensors"
      },
      {
        "name": "layers-37.safetensors",
        "bytes": 383865472,
        "sha256": "651cae579808983fefec954db6e2ac8c3f98bfb038ff1d50aef0505ba7394e65",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-37.safetensors"
      },
      {
        "name": "layers-38.safetensors",
        "bytes": 383865472,
        "sha256": "1c60932dec650cc7679121eaa4d90b8d10a600bf58e23b0784588a339469dd0a",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-38.safetensors"
      },
      {
        "name": "layers-39.safetensors",
        "bytes": 372313760,
        "sha256": "b0c7df4d51b99637ff4ea35eebf7eb134db592eb943e3ccde921729f33949058",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-39.safetensors"
      },
      {
        "name": "layers-4.safetensors",
        "bytes": 383865448,
        "sha256": "b7f367125cdb4b3c3920d1d3ed1ba0d73e464c3e3a92dbd1c195658cb9200afd",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-4.safetensors"
      },
      {
        "name": "layers-40.safetensors",
        "bytes": 383865472,
        "sha256": "6908f1ab1a3d7828a566099ecf393582bec988d0f82f6141848942d1494b0321",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-40.safetensors"
      },
      {
        "name": "layers-41.safetensors",
        "bytes": 383865472,
        "sha256": "21ee5d9842074888bd9fdffa875d1f29f8c77f1f5ccbb8f53becb188e1749caa",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-41.safetensors"
      },
      {
        "name": "layers-42.safetensors",
        "bytes": 383865472,
        "sha256": "565379d4291c06cdf9a4f66d5d21385848a1e5ab17b55fea6c1c8e544f8498f0",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-42.safetensors"
      },
      {
        "name": "layers-43.safetensors",
        "bytes": 372313760,
        "sha256": "4bb8c0a4fadda1f1d66ef6f0dde5a5a94001d04af1842e42009833aff70bf416",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-43.safetensors"
      },
      {
        "name": "layers-44.safetensors",
        "bytes": 383865472,
        "sha256": "14339304cd520a8673f179cb8352c36fbebe184f15309aee2a79afd2d4476fef",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-44.safetensors"
      },
      {
        "name": "layers-45.safetensors",
        "bytes": 383865472,
        "sha256": "7a076aca542f937cc87dec92ab49fd782eae234642b40bc706a6108b3dff2c2a",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-45.safetensors"
      },
      {
        "name": "layers-46.safetensors",
        "bytes": 383865472,
        "sha256": "d82d472cfc4792012934467b90c5e0242df4867a430dd651d13cdee72b7c6645",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-46.safetensors"
      },
      {
        "name": "layers-47.safetensors",
        "bytes": 372313760,
        "sha256": "a83fc757fb11bc50ed3a0c9998b2b2f55c3b6a07598ed458bdbece4285ffaf1f",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-47.safetensors"
      },
      {
        "name": "layers-48.safetensors",
        "bytes": 383865472,
        "sha256": "f6aa126d006c7d976c20b1330c118b42cf3bbe8a7d216bb14f2240d5c49bc72f",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-48.safetensors"
      },
      {
        "name": "layers-49.safetensors",
        "bytes": 383865472,
        "sha256": "7ed54c375407c2baec8cfabe8336f8d3782246848298bb232ac2582113676c69",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-49.safetensors"
      },
      {
        "name": "layers-5.safetensors",
        "bytes": 383865448,
        "sha256": "ebbc2c4bd2b98877caafa7073b6ed732a0284eb82269cf6d21710e245af5837a",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-5.safetensors"
      },
      {
        "name": "layers-50.safetensors",
        "bytes": 383865472,
        "sha256": "73825e1f056c3de53276d3c65743e62b67bf3ca082cf7077ecba1ffef18e9bf1",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-50.safetensors"
      },
      {
        "name": "layers-51.safetensors",
        "bytes": 372313760,
        "sha256": "b6abd8b62b5c4b7beca8cdccd306065be2192ef42491c587ca019d971ed86a1f",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-51.safetensors"
      },
      {
        "name": "layers-52.safetensors",
        "bytes": 383865472,
        "sha256": "6251d51e6fbec6f463ca875fcbe852e07c5025145affe9af053a04fbdc37288f",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-52.safetensors"
      },
      {
        "name": "layers-53.safetensors",
        "bytes": 383865472,
        "sha256": "a9f2f43b4978bba2f755c6d2eb39f8561965bc3c1b2fd1073bb363aff11a9b8c",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-53.safetensors"
      },
      {
        "name": "layers-54.safetensors",
        "bytes": 383865472,
        "sha256": "f0246c9974a4b1207f8f5d05a09c54c50ea61fbfd2dc6480d2b76d3647ece292",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-54.safetensors"
      },
      {
        "name": "layers-55.safetensors",
        "bytes": 372313760,
        "sha256": "649c400495616cf888b7c52e538113610a36265c531d84bff484f8149c157405",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-55.safetensors"
      },
      {
        "name": "layers-56.safetensors",
        "bytes": 383865472,
        "sha256": "eb0a8139a36138639a37219c158b9415412b68d316235061a72e57da5509c188",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-56.safetensors"
      },
      {
        "name": "layers-57.safetensors",
        "bytes": 383865472,
        "sha256": "d7616ad33f9256342573ff85b3f2a0e368dd120257c0c7158564587036119d95",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-57.safetensors"
      },
      {
        "name": "layers-58.safetensors",
        "bytes": 383865472,
        "sha256": "a8dff0e37d0e3903cc29711b935c2865ccd38bd930e7487ae2f4bedbd18ff185",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-58.safetensors"
      },
      {
        "name": "layers-59.safetensors",
        "bytes": 372313760,
        "sha256": "573ed65fd455ec9bd811e95946ea422e08ac36860fdff6968a6d108263a54175",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-59.safetensors"
      },
      {
        "name": "layers-6.safetensors",
        "bytes": 383865448,
        "sha256": "2fea2aaa61d566ba8af27ee89d29d9ee9f1c7f6fbe692772d9ba61fc45109ef6",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-6.safetensors"
      },
      {
        "name": "layers-60.safetensors",
        "bytes": 383865472,
        "sha256": "9a19c30b190bf552eb424af16103f610bcd944fb276b3275eb7c73849799b7de",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-60.safetensors"
      },
      {
        "name": "layers-61.safetensors",
        "bytes": 383865472,
        "sha256": "ff744debd4dd0eef450ed24473df57680db404914302e7147a3b72154131f4a0",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-61.safetensors"
      },
      {
        "name": "layers-62.safetensors",
        "bytes": 383865472,
        "sha256": "d9b3b9e472f78bcadf62c446084833bb549faff9e730b21219f1f80d583eff23",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-62.safetensors"
      },
      {
        "name": "layers-63.safetensors",
        "bytes": 372313760,
        "sha256": "59ba4a3af5e6bc2008c2d6b5d9be8eeaf255cddc0aaf8a0d9583b496bb2e3ae0",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-63.safetensors"
      },
      {
        "name": "layers-7.safetensors",
        "bytes": 372313744,
        "sha256": "f2e0137e878016a7afdb2314972e0cbbe2461a67b00eb1d691b4de8ea2665da8",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-7.safetensors"
      },
      {
        "name": "layers-8.safetensors",
        "bytes": 383865448,
        "sha256": "1721b7bcd730891c224b70a7b6147e44a574a2d6c4d924760acf97728249c92c",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-8.safetensors"
      },
      {
        "name": "layers-9.safetensors",
        "bytes": 383865448,
        "sha256": "0a21e07065b5bb04adc339300dea1872cc48ab8eab3b02df092f7cbc67c8d6f6",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/layers-9.safetensors"
      },
      {
        "name": "merges.txt",
        "bytes": 3353259,
        "sha256": "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/merges.txt"
      },
      {
        "name": "model.safetensors.index.json",
        "bytes": 137335,
        "sha256": "f0838c766951bdfe76d6afbdb2771a8f67aaa2231dedb3d33cebd817729843a2",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/model.safetensors.index.json"
      },
      {
        "name": "mtp.safetensors",
        "bytes": 477202224,
        "sha256": "e5e4464a3793cc261de536592830bca40e7f3af159ed038c358f5660917cf43b",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/mtp.safetensors"
      },
      {
        "name": "outside.safetensors",
        "bytes": 6007102112,
        "sha256": "ddff1d6665a2b39f2612fce0ef955e2436724c565bfbcbc127c7ffd078b698ff",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/outside.safetensors"
      },
      {
        "name": "preprocessor_config.json",
        "bytes": 390,
        "sha256": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/preprocessor_config.json"
      },
      {
        "name": "tokenizer.json",
        "bytes": 12809320,
        "sha256": "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/tokenizer.json"
      },
      {
        "name": "tokenizer_config.json",
        "bytes": 17928,
        "sha256": "b11349aafa7cdc6a320767cf7ceb29ed82f7eda5d65e8e0819e76f0ce947bf27",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/tokenizer_config.json"
      },
      {
        "name": "video_preprocessor_config.json",
        "bytes": 385,
        "sha256": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/video_preprocessor_config.json"
      },
      {
        "name": "vocab.json",
        "bytes": 6722759,
        "sha256": "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003",
        "url": "https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/vocab.json"
      }
    ]
  }
];

/** Original BF16 drafter published by the DFlash2 authors; no remote code. */
export const LOCAL_DFLASH2 = {
  repository: "incoai/Qwen3.8-27B-DFlash2",
  revision: "dedf8df68adfb1afeaf7b7480c0a0243108177b4",
  files: [
    { name: "config.json", bytes: 1239, sha256: "873e3556509b0da06e29654ba00d4944888d4b5e8a33afde25f7eb27d321e980",
      url: "https://huggingface.co/incoai/Qwen3.8-27B-DFlash2/resolve/dedf8df68adfb1afeaf7b7480c0a0243108177b4/config.json" },
    { name: "model.safetensors", bytes: 3848817896, sha256: "67fc76d68dc5a9415511a4f394ef744d67510cd20e93b37cc2cc7d28e4bab65c",
      url: "https://huggingface.co/incoai/Qwen3.8-27B-DFlash2/resolve/dedf8df68adfb1afeaf7b7480c0a0243108177b4/model.safetensors" },
  ],
};
