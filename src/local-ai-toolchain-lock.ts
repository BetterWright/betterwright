// Complete conda-forge GCC 14.3.0 environment, resolved for Linux x64/glibc 2.35.
// Every archive is verified before offline installation; no solver runs at setup.
import type { LocalArtifact } from "./local-ai-catalog.js";

export const LOCAL_GCC_ARTIFACTS: LocalArtifact[] = [
  {
    "name": "libstdcxx-devel_linux-64-14.3.0-h9f08a49_120.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/libstdcxx-devel_linux-64-14.3.0-h9f08a49_120.conda",
    "bytes": 19363621,
    "sha256": "5b7fd889a648c71d71a7cdda09107c0f189aa306f77c33cd66678a56cb225e53"
  },
  {
    "name": "libgcc-devel_linux-64-14.3.0-hf649bbc_120.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/libgcc-devel_linux-64-14.3.0-hf649bbc_120.conda",
    "bytes": 3089154,
    "sha256": "9e2a3e7de26fc149707f9ff3988dc3e6a0b9534aea1bedcaa6ec9ba93dfdd013"
  },
  {
    "name": "kernel-headers_linux-64-5.14.0-he073ed8_3.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/kernel-headers_linux-64-5.14.0-he073ed8_3.conda",
    "bytes": 1410267,
    "sha256": "c4d973dd80ab10028b3e4c58c1c6d8f437bfeaf6069dafb1130dabc550e9caf4"
  },
  {
    "name": "tzdata-2026c-h151e31d_0.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/tzdata-2026c-h151e31d_0.conda",
    "bytes": 118849,
    "sha256": "b928c30ddcb0e3f544c6eade8352737e6e610e263276b90232db6a578ef899d8"
  },
  {
    "name": "sysroot_linux-64-2.34-h087de78_3.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/sysroot_linux-64-2.34-h087de78_3.conda",
    "bytes": 40779381,
    "sha256": "08c50c314b331730eeb8f87c39a45e5426a5463e078392ab283e2552d753443e"
  },
  {
    "name": "libgomp-16.2.0-he0feb66_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgomp-16.2.0-he0feb66_4.conda",
    "bytes": 639968,
    "sha256": "0fe5cb8e0752241ab55e11656ed1b9726248b522d23b929fe7c95b83eb55b9bb"
  },
  {
    "name": "libzlib-1.3.2-h25fd6f3_3.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libzlib-1.3.2-h25fd6f3_3.conda",
    "bytes": 63713,
    "sha256": "eb8a0db0aa570124f7d2a93d7c7f596e3390df5e047818d873baad32985fc736"
  },
  {
    "name": "_openmp_mutex-4.5-20_gnu.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda",
    "bytes": 28948,
    "sha256": "1dd3fffd892081df9726d7eb7e0dea6198962ba775bd88842135a4ddb4deb3c9"
  },
  {
    "name": "zstd-1.5.7-hb78ec9c_7.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/zstd-1.5.7-hb78ec9c_7.conda",
    "bytes": 601301,
    "sha256": "47d682b9f6d6ec9eb1a6e6c3e75ea6273e899e78fb7fc59f81d39745009fbc60"
  },
  {
    "name": "libgcc-16.2.0-ha9f2e26_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgcc-16.2.0-ha9f2e26_4.conda",
    "bytes": 1058083,
    "sha256": "24090e675d34403b4ee1cd4372d8f6c0937da7ecfd66a19a57cac2ed0f4ea793"
  },
  {
    "name": "ld_impl_linux-64-2.46.1-default_hbd61a6d_102.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/ld_impl_linux-64-2.46.1-default_hbd61a6d_102.conda",
    "bytes": 745303,
    "sha256": "27d83f1188cd19bcb7754a078b3fa7f4cfb8527f8eb2fde54dd01fc529d1adec"
  },
  {
    "name": "libstdcxx-16.2.0-h934c35e_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-16.2.0-h934c35e_4.conda",
    "bytes": 6613148,
    "sha256": "40b792b0186c1e8859280a1f6f19a54fc50a11b32724fc7b637009c1a9bd302b"
  },
  {
    "name": "binutils_impl_linux-64-2.46.1-default_hfdba357_102.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/binutils_impl_linux-64-2.46.1-default_hfdba357_102.conda",
    "bytes": 3713752,
    "sha256": "fb7bf36984a37ce7e4714d1d1da0bd0e3bfc679520f5cdc184afc676fd4b5da2"
  },
  {
    "name": "libsanitizer-14.3.0-h91d2232_20.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libsanitizer-14.3.0-h91d2232_20.conda",
    "bytes": 7299538,
    "sha256": "4b685b1da0f85f4771e1b243e66cf2cf7b2e625caa440efc082d800a4e9b091e"
  },
  {
    "name": "binutils_linux-64-2.46.1-default_h4852527_102.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/binutils_linux-64-2.46.1-default_h4852527_102.conda",
    "bytes": 36337,
    "sha256": "08d7238663fc408ba2ab60b02fa3d06a7ca9d872962e03e90c7e0fdecb7ed1d0"
  },
  {
    "name": "gcc_impl_linux-64-14.3.0-h054831b_20.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/gcc_impl_linux-64-14.3.0-h054831b_20.conda",
    "bytes": 73421270,
    "sha256": "09bb9b0d54b012c36a115e3ecebc80276df261555e847afbb3fbc7ab5566408c"
  },
  {
    "name": "gxx_impl_linux-64-14.3.0-h99ea42b_20.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/gxx_impl_linux-64-14.3.0-h99ea42b_20.conda",
    "bytes": 14756288,
    "sha256": "8cd46d6f94a5a34181492549e1e56e5795337007289e6ca30d9ff1864f0e33c1"
  },
  {
    "name": "gcc_linux-64-14.3.0-h50e9bb6_28.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/gcc_linux-64-14.3.0-h50e9bb6_28.conda",
    "bytes": 29378,
    "sha256": "9fd801f04e12cc3c8f0ea1f92086995ab7dc8071211e3452c506c5f5abf1a0ff"
  },
  {
    "name": "gxx_linux-64-14.3.0-h3ba8f88_28.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/gxx_linux-64-14.3.0-h3ba8f88_28.conda",
    "bytes": 27881,
    "sha256": "a3964e7050886e2287f80d4a45f4015e4adb172045f982499a7a2c021858848b"
  }
];

// SGLang's native kernels link libnuma even on single-GPU hosts. Keep the
// complete non-system dependency closure private; fresh Linux needs no sudo.
export const LOCAL_ESCHA_LIBRARIES: LocalArtifact[] = [
  ...LOCAL_GCC_ARTIFACTS.filter(file => /^(libgcc-|libgomp-|_openmp_mutex-)/.test(file.name)),
  {
    name: "libnuma-2.0.18-hb03c661_4.conda",
    url: "https://conda.anaconda.org/conda-forge/linux-64/libnuma-2.0.18-hb03c661_4.conda",
    bytes: 44657,
    sha256: "db0a0fc67104196afe6732ff055b30829f984f4cf1e8efff4ea5b2bbb1640da2",
  },
];

// Shared libraries for the official Linux Vulkan runtime.
export const LOCAL_LINUX_LIBRARIES: LocalArtifact[] = [
  {
    "name": "libgomp-16.2.0-he0feb66_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgomp-16.2.0-he0feb66_4.conda",
    "bytes": 639968,
    "sha256": "0fe5cb8e0752241ab55e11656ed1b9726248b522d23b929fe7c95b83eb55b9bb"
  },
  {
    "name": "_openmp_mutex-4.5-20_gnu.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda",
    "bytes": 28948,
    "sha256": "1dd3fffd892081df9726d7eb7e0dea6198962ba775bd88842135a4ddb4deb3c9"
  },
  {
    "name": "libgcc-16.2.0-ha9f2e26_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgcc-16.2.0-ha9f2e26_4.conda",
    "bytes": 1058083,
    "sha256": "24090e675d34403b4ee1cd4372d8f6c0937da7ecfd66a19a57cac2ed0f4ea793"
  },
  {
    "name": "xorg-libxau-1.0.12-h7cc23a3_2.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libxau-1.0.12-h7cc23a3_2.conda",
    "bytes": 18793,
    "sha256": "3ec065b94554dc48a4ca582a960a5484bc166b26e83ce0954653e08d17e8bd53"
  },
  {
    "name": "pthread-stubs-0.4-h7cc23a3_1004.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/pthread-stubs-0.4-h7cc23a3_1004.conda",
    "bytes": 9630,
    "sha256": "4a44fd00ea73b79ca2c89b0727b9ccf61c506ead71e67a9abfa4c590042b5a4a"
  },
  {
    "name": "xorg-libxdmcp-1.1.5-hb03c661_2.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libxdmcp-1.1.5-hb03c661_2.conda",
    "bytes": 21120,
    "sha256": "c50a16c05ccd7fe7dd6d6cfb539f4e9a491d50f9ed7a5c902fec638f7d0d27be"
  },
  {
    "name": "libstdcxx-16.2.0-h934c35e_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-16.2.0-h934c35e_4.conda",
    "bytes": 6613148,
    "sha256": "40b792b0186c1e8859280a1f6f19a54fc50a11b32724fc7b637009c1a9bd302b"
  },
  {
    "name": "libxcb-1.17.0-hb83e432_2.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libxcb-1.17.0-hb83e432_2.conda",
    "bytes": 395120,
    "sha256": "7b49e6fd2a584b7f072943e6adf4149677af5121246975278804782d37752837"
  },
  {
    "name": "xorg-libx11-1.8.13-he1eb515_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libx11-1.8.13-he1eb515_1.conda",
    "bytes": 839578,
    "sha256": "68053eebfa9f0d91666786c8fb5839d989aa9b869add92cb8815228bb2d7302c"
  },
  {
    "name": "xorg-libxrender-0.9.12-hb03c661_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libxrender-0.9.12-hb03c661_1.conda",
    "bytes": 34645,
    "sha256": "6901f91d398811e4ec89d7e20a69abac02a7bfebfaf073338b7ea3d1a99685b7"
  },
  {
    "name": "xorg-libxext-1.3.7-h7cc23a3_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libxext-1.3.7-h7cc23a3_1.conda",
    "bytes": 53124,
    "sha256": "aa9bbe8b278aacc194e280ff5037f9f9a1f2c5b33ed97de8e7f01cfbe90dda43"
  },
  {
    "name": "xorg-libxrandr-1.5.5-h7cc23a3_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/xorg-libxrandr-1.5.5-h7cc23a3_1.conda",
    "bytes": 31106,
    "sha256": "05a7f25d7f7f5cd32b27a019233ece97167fd8ade255bc13a0e49e53387f4c30"
  },
  {
    "name": "libvulkan-loader-1.4.357.0-h0e34353_2.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libvulkan-loader-1.4.357.0-h0e34353_2.conda",
    "bytes": 206957,
    "sha256": "a70c25b66321ee77f9892b205e3247263c400803f543dc8aca53d569a59c5a77"
  }
];

// NVIDIA CUDA 12.8 libraries matching the official llama.cpp CUDA image.
export const LOCAL_CUDA_LIBRARIES: LocalArtifact[] = [
  {
    "name": "cuda-version-12.8-h5d125a7_3.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/cuda-version-12.8-h5d125a7_3.conda",
    "bytes": 21086,
    "sha256": "6f93ceb66267e69728d83cf98673221f6b1f95a3514b3a97777cfd0ef8e24f3f"
  },
  {
    "name": "cuda-cudart_linux-64-12.8.90-h3f2d84a_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/noarch/cuda-cudart_linux-64-12.8.90-h3f2d84a_1.conda",
    "bytes": 192766,
    "sha256": "b8b307d03eb16aa111d244004ac48d1e0d0592ade846566bb392f75c54b6828f"
  },
  {
    "name": "libgomp-16.2.0-he0feb66_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgomp-16.2.0-he0feb66_4.conda",
    "bytes": 639968,
    "sha256": "0fe5cb8e0752241ab55e11656ed1b9726248b522d23b929fe7c95b83eb55b9bb"
  },
  {
    "name": "_openmp_mutex-4.5-20_gnu.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda",
    "bytes": 28948,
    "sha256": "1dd3fffd892081df9726d7eb7e0dea6198962ba775bd88842135a4ddb4deb3c9"
  },
  {
    "name": "libgcc-16.2.0-ha9f2e26_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libgcc-16.2.0-ha9f2e26_4.conda",
    "bytes": 1058083,
    "sha256": "24090e675d34403b4ee1cd4372d8f6c0937da7ecfd66a19a57cac2ed0f4ea793"
  },
  {
    "name": "libstdcxx-16.2.0-h934c35e_4.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-16.2.0-h934c35e_4.conda",
    "bytes": 6613148,
    "sha256": "40b792b0186c1e8859280a1f6f19a54fc50a11b32724fc7b637009c1a9bd302b"
  },
  {
    "name": "cuda-nvrtc-12.8.93-h5888daf_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/cuda-nvrtc-12.8.93-h5888daf_1.conda",
    "bytes": 66214407,
    "sha256": "38edf4f501ccbb996cc9f0797fcf404c12d4aeef974308cf8b997b470409c171"
  },
  {
    "name": "cuda-cudart-12.8.90-h5888daf_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/cuda-cudart-12.8.90-h5888daf_1.conda",
    "bytes": 22751,
    "sha256": "294b789d6bce9944fc5987c86dc1cdcdbc4eb965f559b81749dbf03b43e6c135"
  },
  {
    "name": "nccl-2.25.1.1-ha44e49d_0.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/nccl-2.25.1.1-ha44e49d_0.conda",
    "bytes": 184059581,
    "sha256": "5f6ed4e6fa067e15f3e60ceeb08d543d46fa8780e09f6774571ea0c3a64cc85a"
  },
  {
    "name": "libcublas-12.8.4.1-h9ab20c4_1.conda",
    "url": "https://conda.anaconda.org/conda-forge/linux-64/libcublas-12.8.4.1-h9ab20c4_1.conda",
    "bytes": 471593172,
    "sha256": "3d3f7344db000feced2f9154cf0b3f3d245a1d317a1981e43b8b15f7baaaf6f1"
  }
];
