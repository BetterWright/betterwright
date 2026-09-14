solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git@refs/tags/153.0.8010.36",
    "managed": False,
    "custom_deps": {
      # Previous browser installers are updater-integration fixtures, not
      # inputs to the managed chrome/inspector-test release targets.
      "src/third_party/updater/chrome_win_arm64/cipd": None,
      "src/third_party/updater/chrome_win_arm64_sans_iid/cipd": None,
      "src/third_party/updater/chrome_win_x86/cipd": None,
      "src/third_party/updater/chrome_win_x86_sans_iid/cipd": None,
      "src/third_party/updater/chrome_win_x86_64/cipd": None,
      "src/third_party/updater/chrome_win_x86_64_sans_iid/cipd": None,
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
