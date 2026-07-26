// Navigate, read the title, capture a proof screenshot.
//
//   node examples/typescript/quickstart.ts

import { BetterWright, BrowserError } from "betterwright";

const bw = new BetterWright();
try {
  await bw.run("await page.goto('https://example.com')", { note: "Opening example.com" });

  const title = await bw.run("return page.title()");
  if (!title.ok) throw new BrowserError(title.error);
  console.log("Title:", title.result);

  const proof = await bw.run("return screenshot({ kind: 'proof', name: 'example-home' })");
  console.log("Proof:", proof.artifacts?.[0]?.media);
} finally {
  await bw.close();
}
