import assert from "node:assert/strict";
import test from "node:test";

import {
  buildV2LaunchPlan,
  resolveGeoIdentity,
  v2LaunchArgs,
} from "../../dist/src/cloak-v2.js";

test("v2LaunchArgs renders locale/timezone/platform flags", () => {
  const args = v2LaunchArgs({
    locale: "de-DE",
    timezone: "Europe/Berlin",
    platform: "macos",
  });
  assert.ok(args.includes("--lang=de-DE"));
  assert.ok(args.includes("--fingerprint-locale=de-DE"));
  assert.ok(args.includes("--fingerprint-timezone=Europe/Berlin"));
  assert.ok(args.includes("--fingerprint-platform=macos"));
});

test("v2LaunchArgs uses native fork timezone switch and passes platform farbling", () => {
  const args = v2LaunchArgs({
    locale: "de-DE",
    timezone: "Europe/Berlin",
    platform: "macos",
    nativeFork: true,
  });
  assert.ok(args.includes("--bw-timezone=Europe/Berlin"));
  assert.equal(args.includes("--fingerprint-timezone=Europe/Berlin"), false);
  assert.ok(args.includes("--fingerprint-platform=macos"));
});

test("native fork defaults platform identity to macos mask", () => {
  const plan = buildV2LaunchPlan({ nativeFork: true });
  assert.equal(plan.identity.platform, "macos");
  assert.ok(plan.args.includes("--fingerprint-platform=macos"));
});

test("explicit platform wins over the fork macos default", () => {
  const plan = buildV2LaunchPlan({ nativeFork: true, platform: "windows" });
  assert.equal(plan.identity.platform, "windows");
  assert.ok(plan.args.includes("--fingerprint-platform=windows"));
});

test("headedInvisible parks a real window off-screen at preset size", () => {
  const args = v2LaunchArgs({ platform: "macos", headedInvisible: true });
  assert.ok(args.includes("--window-size=1800,1169"));
  assert.ok(args.includes("--window-position=32000,32000"));
});

test("launch plan derives Accept-Language and canonical locale", () => {
  const plan = buildV2LaunchPlan({ locale: "zh-hant-tw", nativeFork: true });
  assert.equal(plan.identity.locale, "zh-Hant-TW");
  assert.equal(plan.identity.acceptLanguage, "zh-Hant-TW,zh;q=0.9");
  assert.ok(plan.args.includes("--lang=zh-Hant-TW"));
});

test("launch configuration validation is strict", () => {
  assert.throws(() => buildV2LaunchPlan({ locale: "bad_locale" }), /Invalid fork identity locale/);
  assert.throws(() => buildV2LaunchPlan({ timezone: "Mars/Olympus" }), /Invalid browser identity timezone/);
  assert.throws(() => buildV2LaunchPlan({ platform: "android" }), /Unsupported browser identity platform/);
});

test("geo identity: explicit values win, no lookup performed", async () => {
  let called = false;
  const result = await resolveGeoIdentity({
    geoip: true,
    locale: "en-US",
    timezone: "America/New_York",
    fetchJson: async () => {
      called = true;
      return null;
    },
  });
  assert.equal(called, false);
  assert.equal(result.locale, "en-US");
  assert.equal(result.timezone, "America/New_York");
});

test("geo identity: lookup fills missing values from egress geography", async () => {
  const result = await resolveGeoIdentity({
    geoip: true,
    fetchJson: async () => ({ status: "success", countryCode: "DE", timezone: "Europe/Berlin" }),
  });
  assert.equal(result.locale, "de-DE");
  assert.equal(result.timezone, "Europe/Berlin");
  assert.equal(result.source, "geoip");
});

test("geo identity: lookup failure falls back without throwing", async () => {
  const result = await resolveGeoIdentity({
    geoip: true,
    fetchJson: async () => {
      throw new Error("upstream down");
    },
  });
  assert.equal(result.locale, null);
  assert.equal(result.timezone, null);
});

test("geo identity: unknown country falls back to en-US", async () => {
  const result = await resolveGeoIdentity({
    geoip: true,
    fetchJson: async () => ({ status: "success", countryCode: "AQ", timezone: "Antarctica/Troll" }),
  });
  assert.equal(result.locale, "en-US");
  assert.equal(result.timezone, "Antarctica/Troll");
});

test("launch plan contains only native flags and identity", () => {
  const plan = buildV2LaunchPlan({ locale: "ja-JP", timezone: "Asia/Tokyo" });
  assert.ok(plan.args.includes("--lang=ja-JP"));
  assert.equal("viewport" in plan, false);
  assert.equal("initScript" in plan, false);
  assert.equal(plan.identity.timezone, "Asia/Tokyo");
});
