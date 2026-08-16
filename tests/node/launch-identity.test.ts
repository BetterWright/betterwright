import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptLanguageForLocale,
  buildLaunchIdentityPlan,
  hostPlatform,
  identityLaunchArgs,
  resolveGeoIdentity,
} from "../../dist/src/launch-identity.js";

test("acceptLanguageForLocale derives Chromium's Accept-Language header", () => {
  assert.equal(acceptLanguageForLocale("en-US"), "en-US,en;q=0.9");
  assert.equal(acceptLanguageForLocale("de-DE"), "de-DE,de;q=0.9");
  assert.equal(acceptLanguageForLocale("ja"), "ja");
  assert.throws(() => acceptLanguageForLocale(""), /non-empty/);
  assert.throws(() => acceptLanguageForLocale("not a locale"), /Invalid/);
  assert.throws(
    () => acceptLanguageForLocale("en-US-u-ca-gregory"),
    /extensions/,
  );
});

test("identity defaults to the host platform — no OS masquerade", () => {
  const plan = buildLaunchIdentityPlan({});
  assert.equal(plan.identity.platform, hostPlatform());
  assert.equal(plan.identity.locale, "en-US");
  assert.ok(plan.args.includes(`--fingerprint-platform=${hostPlatform()}`));
  assert.ok(plan.args.includes("--lang=en-US"));
  assert.ok(plan.args.includes("--fingerprint-locale=en-US"));
  // The fork no longer ships a Mac window geometry by default.
  assert.ok(!plan.args.some((a) => a.startsWith("--force-device-scale-factor")));
  assert.ok(!plan.args.some((a) => a.startsWith("--window-size")));
});

test("explicit platform is honored and validated", () => {
  const plan = buildLaunchIdentityPlan({ platform: "windows" });
  assert.equal(plan.identity.platform, "windows");
  assert.throws(
    () => buildLaunchIdentityPlan({ platform: "haiku" }),
    /Unsupported browser identity platform/,
  );
});

test("timezone rides the fork's native flag", () => {
  const plan = buildLaunchIdentityPlan({ timezone: "Europe/Berlin" });
  assert.ok(plan.args.includes("--bw-timezone=Europe/Berlin"));
  assert.equal(plan.identity.timezone, "Europe/Berlin");
  assert.throws(
    () => buildLaunchIdentityPlan({ timezone: "Not/AZone" }),
    /Invalid browser identity timezone/,
  );
});

test("headed-invisible parks a real headed window off-screen", () => {
  const args = identityLaunchArgs({
    headedInvisible: true,
    platform: "linux",
  });
  assert.ok(args.includes("--window-position=32000,32000"));
  assert.ok(args.some((a) => a.startsWith("--window-size=")));
});

test("geoip identity resolves locale/timezone from the egress IP", async () => {
  const resolved = await resolveGeoIdentity({
    geoip: true,
    fetchJson: async () => ({
      status: "success",
      countryCode: "DE",
      timezone: "Europe/Berlin",
    }),
  });
  assert.equal(resolved.locale, "de-DE");
  assert.equal(resolved.timezone, "Europe/Berlin");
  assert.equal(resolved.source, "geoip");
});

test("explicit locale/timezone beat the geo lookup; failures fall back", async () => {
  const pinned = await resolveGeoIdentity({
    geoip: true,
    locale: "fr-FR",
    timezone: "America/New_York",
    fetchJson: async () => {
      throw new Error("unreachable");
    },
  });
  assert.deepEqual(pinned, {
    locale: "fr-FR",
    timezone: "America/New_York",
    source: "explicit",
  });
  const failed = await resolveGeoIdentity({
    geoip: true,
    fetchJson: async () => {
      throw new Error("unreachable");
    },
  });
  assert.deepEqual(failed, { locale: null, timezone: null, source: "explicit" });
  const off = await resolveGeoIdentity({ geoip: false });
  assert.deepEqual(off, { locale: null, timezone: null, source: "explicit" });
});
