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
