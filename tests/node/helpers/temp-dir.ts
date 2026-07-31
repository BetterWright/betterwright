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

// Registered at module load, when the importing file's top-level imports run,
// so this is a genuine file-level hook: it fires once after every test in the
// file. Registering it lazily inside the first makeTempDir call attached it
// to whichever *test* happened to call first, which ran the cleanup before
// that test's own t.after hooks — on Windows that meant trying to remove a
// directory a test was still chdir'd into, which fails with EBUSY there
// (POSIX allows removing the working directory).
after(() => {
  while (created.length) {
    // force:true so a directory a test already removed is not an error.
    // The retries absorb Windows's transient EBUSY/EPERM/ENOTEMPTY, where an
    // antivirus briefly holds fresh files open and closed-but-delete-pending
    // entries keep their parent directory occupied for a moment.
    fs.rmSync(created.pop(), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

export function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
