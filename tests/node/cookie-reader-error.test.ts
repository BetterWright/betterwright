import assert from "node:assert/strict";
import test from "node:test";
import { cookieReaderError } from "../../dist/src/cookie-reader-error.js";

test("cookie errors retain actionable codes without native diagnostic text", async () => {
  const error = await cookieReaderError({ rookieCode: "source_extraction_failed", message: "Permission denied: /private/secret-profile" }, {}, { timeoutMs: 1000 });
  assert.equal(error.cookiePermissionDenied, true);
  assert.equal(error.cookieReaderCode, "source_extraction_failed");
  assert.ok(!JSON.stringify(error).includes("secret-profile"));
  assert.ok(!error.message.includes("secret-profile"));
  assert.match(error.message, process.platform === "darwin" ? /Full Disk Access/ : /current user/);
});

test("nested native acquisition reports explain generic extraction errors", async () => {
  const reader = { report: async () => ({ profiles: [{ sources: [{ issues: [{ severity: "error", stage: "acquisition", message: "Operation not permitted /private/profile" }] }] }] }) };
  const error = await cookieReaderError({ rookieCode: "source_extraction_failed" }, reader, { timeoutMs: 1000 });
  assert.equal(error.cookiePermissionDenied, true);
  assert.equal(error.cookieReaderStage, "acquisition");
  assert.ok(!JSON.stringify(error).includes("/private/profile"));
  const unavailable = await cookieReaderError({ rookieCode: "secret-code" }, reader, { timeoutMs: 1000 });
  assert.equal(unavailable.cookieReaderCode, "reader_failed");
  assert.equal(unavailable.cookieReaderStage, undefined);
});

test("profile discovery errors retain fixed guidance without source paths", async () => {
  const error = await cookieReaderError({ rookieCode: "discovery_failed", message: "read directory /private/secret-source" }, {}, { timeoutMs: 1000 });
  assert.equal(error.cookieReaderCode, "discovery_failed");
  assert.match(error.message, /profile discovery failed/);
  assert.equal(error.message.includes("secret-source"), false);
});
