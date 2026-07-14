import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ensureChromeCdp, findChromeExecutable } from "../../src/chrome.mjs";

test("ensureChromeCdp reuses a running debug endpoint", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/x" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const info = await ensureChromeCdp({ port });
    assert.equal(info.started, false);
    assert.equal(info.endpoint, `http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
});

test("findChromeExecutable honors an explicit existing path", () => {
  assert.equal(findChromeExecutable(process.execPath), process.execPath);
});
