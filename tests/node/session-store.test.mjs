import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearTranscript,
  ELIDED_OBSERVATION,
  elideTranscript,
  loadTranscript,
  saveTranscript,
  transcriptPath,
} from "../../src/session-store.mjs";

function browserTurn(content, note = "") {
  return [
    { role: "assistant", text: note, toolCalls: [{ id: "t1", name: "browser", input: {} }] },
    { role: "tool", results: [{ id: "t1", name: "browser", content }] },
  ];
}

test("elideTranscript keeps the last two browser observations and stubs older large ones", () => {
  const big = (label) => `${label}:${"x".repeat(2_000)}`;
  const messages = [
    { role: "user", text: "task one" },
    ...browserTurn(big("first")),
    ...browserTurn("small result"),
    ...browserTurn(big("third")),
    ...browserTurn(big("fourth")),
  ];
  const elided = elideTranscript(messages);
  const contents = elided
    .filter((m) => m.role === "tool")
    .map((m) => m.results[0].content);
  assert.equal(contents[0], ELIDED_OBSERVATION); // old + large → stub
  assert.equal(contents[1], "small result"); // old + small → kept
  assert.ok(contents[2].startsWith("third:")); // last two kept verbatim
  assert.ok(contents[3].startsWith("fourth:"));
  // Pure: input untouched.
  assert.ok(messages[2].results[0].content.startsWith("first:"));
});

test("elideTranscript caps total size by dropping whole leading turns, never orphaning tool results", () => {
  const messages = [{ role: "user", text: "the original task" }];
  for (let i = 0; i < 50; i += 1) {
    messages.push({ role: "user", text: `follow-up ${i}: ${"y".repeat(400)}` });
    messages.push(...browserTurn("z".repeat(400)));
  }
  const elided = elideTranscript(messages, { maxChars: 8_000, elideOverChars: 100_000 });
  assert.ok(JSON.stringify(elided).length <= 8_000);
  assert.ok(elided.length > 0);
  assert.equal(elided[0].role, "user");
  for (let i = 0; i < elided.length; i += 1) {
    if (elided[i].role === "tool")
      assert.equal(elided[i - 1]?.role, "assistant", "tool result must follow its assistant turn");
  }
});

test("elideTranscript drops malformed entries", () => {
  const elided = elideTranscript([
    null,
    "nope",
    { role: "system", text: "not a transcript role" },
    { role: "user", text: "keep me" },
  ]);
  assert.deepEqual(elided, [{ role: "user", text: "keep me" }]);
});

test("save/load roundtrip with private permissions; clear forgets", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-store-"));
  try {
    const messages = [
      { role: "user", text: "book the flight" },
      { role: "assistant", text: "done", toolCalls: [] },
    ];
    const file = saveTranscript(home, "default", messages);
    assert.equal(file, transcriptPath(home, "default"));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(loadTranscript(home, "default"), messages);
    clearTranscript(home, "default");
    assert.deepEqual(loadTranscript(home, "default"), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hostile session names cannot escape the sessions directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-store-"));
  try {
    for (const name of ["../../etc/passwd", "..", "a/b", ".hidden", "x".repeat(200)]) {
      const file = transcriptPath(home, name);
      const sessionsRoot = path.join(home, "sessions");
      assert.ok(
        path.resolve(file).startsWith(`${path.resolve(sessionsRoot)}${path.sep}`),
        `${name} must stay under ${sessionsRoot}`,
      );
      assert.ok(!path.resolve(file).includes(".."));
    }
    // Same hostile name maps to the same file (stable hashing).
    assert.equal(transcriptPath(home, "a/b"), transcriptPath(home, "a/b"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadTranscript tolerates a corrupt file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-store-"));
  try {
    const file = transcriptPath(home, "default");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(loadTranscript(home, "default"), []);
    fs.writeFileSync(file, JSON.stringify({ messages: "not-an-array" }));
    assert.deepEqual(loadTranscript(home, "default"), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
