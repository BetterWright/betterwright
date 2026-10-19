// Run after bun run build. Exercises the real extension and managed browser
// through a minimal Pi host adapter; no model/provider framing is measured.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPiExtension } from "../dist/src/pi-extension.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-evidence-probe-"));
const tools = new Map<string, any>();
const handlers = new Map<string, any>();
createPiExtension({
  browserOptions: { home, vault: false, adBlock: false, headless: true },
  requireEvidence: true,
  autoScreenshot: false,
})({
  registerTool: tool => tools.set(tool.name, tool),
  on: (name, handler) => handlers.set(name, handler),
});

const evidence = params => tools.get("browser_evidence").execute("evidence", params);
function textBytes(result) {
  return Buffer.byteLength(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
}

try {
  for (let archived = 0; archived < 3; archived += 1) {
    const initialized = await evidence({
      operation: "initialize", name: `repro-0${archived + 1}`,
      requirements: [{ id: "fixture", description: "The local fixture shows Evidence fixture and Visible marker ALPHA." }],
    });
    const browsed = await tools.get("browser").execute("fixture", { code:
      `await page.setContent('<body style="background:white;color:black;font:24px sans-serif;padding:40px"><h1>Evidence fixture</h1><p>Visible marker ALPHA</p></body>');
       return await page.locator('body').innerText();` });
    const proven = await evidence({ operation: "prove",
      proofs: [{ id: "fixture", evidence: "The frame shows Evidence fixture and Visible marker ALPHA." }] });
    const audited = await evidence({ operation: "audit" });
    const images = proven.content.filter(block => block.type === "image").length;
    if (!browsed.details.ok || !audited.details.ready || images !== 1) throw new Error("Native evidence probe failed.");
    console.log(JSON.stringify({ archived, initialize: textBytes(initialized), browser: textBytes(browsed),
      prove: textBytes(proven), audit: textBytes(audited), ready: audited.details.ready, images }));
  }
} finally {
  try { await handlers.get("session_shutdown")(); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}
