import assert from "node:assert/strict";
import test from "node:test";

import {
  hostIs,
  isGoogleHost,
  isRecord,
  normalizedText,
  parsedUrl,
  stringValue,
} from "../../dist/src/untrusted-value.js";

test("isRecord accepts plain objects and rejects arrays and null", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(0), false);
});

test("stringValue coerces, and yields \"\" for nullish input", () => {
  assert.equal(stringValue("already"), "already");
  assert.equal(stringValue(42), "42");
  assert.equal(stringValue(null), "");
  assert.equal(stringValue(undefined), "");
  assert.equal(stringValue(false), "false");
});

test("stringValue survives an object whose toString throws", () => {
  // A page-supplied object can carry a hostile getter; the helper must not let
  // it escape as an exception into a classifier.
  const hostile = {
    toString() {
      throw new Error("nope");
    },
  };
  assert.equal(stringValue(hostile), "");
});

test("normalizedText lowercases, folds curly quotes, and collapses whitespace", () => {
  assert.equal(normalizedText("  I’m   Not\tA  Robot \n"), "i'm not a robot");
  assert.equal(normalizedText(null), "");
});

test("normalizedText caps very long input", () => {
  const normalized = normalizedText("a".repeat(250_000));
  assert.equal(normalized.length, 100_000);
});

test("parsedUrl returns a URL or null, never throws", () => {
  assert.equal(parsedUrl("https://example.com/x")?.hostname, "example.com");
  assert.equal(parsedUrl("not a url"), null);
  assert.equal(parsedUrl(null), null);
  assert.equal(parsedUrl(""), null);
});

test("hostIs matches the domain and its subdomains by label", () => {
  assert.equal(hostIs("example.com", "example.com"), true);
  assert.equal(hostIs("www.example.com", "example.com"), true);
  assert.equal(hostIs("deep.a.example.com", "example.com"), true);
  // The label boundary is the point: a substring match would accept this.
  assert.equal(hostIs("notexample.com", "example.com"), false);
  assert.equal(hostIs("example.com.evil.test", "example.com"), false);
});

test("isGoogleHost covers google.com and the country-code domains", () => {
  assert.equal(isGoogleHost("google.com"), true);
  assert.equal(isGoogleHost("www.google.com"), true);
  assert.equal(isGoogleHost("google.de"), true);
  assert.equal(isGoogleHost("www.google.co.uk"), true);
  assert.equal(isGoogleHost("google.com.au"), true);
  assert.equal(isGoogleHost("notgoogle.com"), false);
  assert.equal(isGoogleHost("google.evil.test"), false);
  assert.equal(isGoogleHost("example.com"), false);
});
