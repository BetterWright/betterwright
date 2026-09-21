import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSiteHeaders,
  sameOriginSiteUrl,
  siteTextExcerpts,
} from "../../dist/src/site-tools.js";

test("site helpers resolve relative URLs but reject cross-origin access", () => {
  assert.equal(
    sameOriginSiteUrl("https://example.com/app/page", "../api/state"),
    "https://example.com/api/state",
  );
  assert.throws(
    () => sameOriginSiteUrl("https://example.com/", "https://other.test/api"),
    /active page's origin/,
  );
  assert.throws(
    () => sameOriginSiteUrl("about:blank", "/api"),
    /valid HTTP/,
  );
});

test("site.request headers preserve the browser's credential boundary", () => {
  assert.deepEqual(normalizeSiteHeaders({ Accept: "application/json" }), {
    accept: "application/json",
  });
  for (const name of [
    "Authorization",
    "Cookie",
    "Host",
    "Origin",
    "Referer",
    "Sec-Fetch-Site",
  ]) {
    assert.throws(() => normalizeSiteHeaders({ [name]: "secret" }), /cannot set/);
  }
});

test("site.read returns bounded literal excerpts for large application assets", () => {
  const source = `${"a".repeat(100)}needle${"b".repeat(100)}needle${"c".repeat(100)}`;
  assert.deepEqual(siteTextExcerpts(source, "needle", 40, 1), [
    {
      index: 100,
      text: `${"a".repeat(40)}needle${"b".repeat(40)}`,
    },
  ]);
  assert.equal(siteTextExcerpts("plain text", "missing").length, 0);
});
