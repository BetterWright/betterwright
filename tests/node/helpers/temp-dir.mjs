// Temp directories for tests, removed when the test file finishes.
//
// Suites here mkdtemp a fresh home per test and most of them never cleaned up,
// which left ~1.6 GB of `betterwright-*` directories behind after a full run.
// Registering the removal here — rather than at each of the ~50 call sites —
// keeps the guarantee in one place.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const created = [];
let hookRegistered = false;

export function makeTempDir(prefix) {
  if (!hookRegistered) {
    hookRegistered = true;
    // File-level hook: runs once after every test in the importing file.
    after(() => {
      while (created.length) {
        // force:true so a directory a test already removed is not an error.
        fs.rmSync(created.pop(), { recursive: true, force: true });
      }
    });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
