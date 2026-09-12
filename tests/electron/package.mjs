import fs from "node:fs/promises";
import path from "node:path";
import { createPackage } from "@electron/asar";

const output = path.resolve(".tmp/electron-e2e");
const stage = path.join(output, "stage");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, "tests/electron"), { recursive: true });
await fs.cp("dist", path.join(stage, "dist"), { recursive: true });
for (const fixture of ["reliability", "detach-recovery"]) {
  await fs.copyFile(`tests/electron/${fixture}.mjs`, path.join(stage, `tests/electron/${fixture}.mjs`));
}
const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
for (const [fixture, archive] of [["reliability", "app"], ["detach-recovery", "detach"]]) {
  manifest.main = `tests/electron/${fixture}.mjs`;
  await fs.writeFile(path.join(stage, "package.json"), JSON.stringify(manifest));
  await createPackage(stage, path.join(output, `${archive}.asar`));
}
console.log("Created isolated Electron reliability and detach E2E archives.");
