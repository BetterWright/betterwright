/** Versioned capture data for BetterChromium 151 on macOS. */
export const CHROMIUM_151_MACOS_M4_PRO_PROFILE = Object.freeze({
  id: "macos-m4-pro-chromium-151-v1",
  schemaVersion: 1,
  chromiumMajor: 151,
  capture: Object.freeze({
    hardware: "MacBook Pro 14-inch (Mac16,8, Apple M4 Pro, 12 cores, 24 GB)",
    operatingSystem: "macOS 26.6",
    display: '1800x1169@2x "More Space"',
  }),
  platform: "macos",
  navigatorPlatform: "MacIntel",
  userAgentMetadata: Object.freeze({
    greaseBrand: Object.freeze({ brand: "Not;A=Brand", version: "8" }),
    platform: "macOS",
    platformVersion: "26.6.0",
    architecture: "arm",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  }),
  hardwareConcurrency: 12,
  deviceMemory: 16,
  screen: Object.freeze({
    width: 1800,
    height: 1169,
    availWidth: 1800,
    availHeight: 1049,
    colorDepth: 30,
    pixelDepth: 30,
    devicePixelRatio: 2,
  }),
  media: Object.freeze({ colorGamutP3: false, pointerFine: true, hover: true }),
  webgl: Object.freeze({
    unmaskedVendor: "Google Inc. (Apple)",
    unmaskedRenderer:
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)",
  }),
  webgpu: Object.freeze({
    vendor: "apple",
    architecture: "metal-3",
    subgroupMinSize: 32,
    subgroupMaxSize: 32,
    isFallbackAdapter: false,
  }),
});
