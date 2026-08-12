solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git@refs/tags/150.0.7871.129",
    "managed": False,
    "custom_deps": {
      "src/content/test/data/layout_tests/LayoutTests": None,
      "src/chrome/tools/test/reference_build/chrome_win": None,
      "src/chrome/tools/test/reference_build/chrome_linux": None,
      "src/chrome/tools/test/reference_build/chrome_mac": None,
    },
    "custom_vars": {
      "checkout_pgo_profiles": False,
      "checkout_instrumented_libraries": False,
      "checkout_centipede_deps": False,
      "checkout_chrome_passwords_db": False,
    },
  },
]
