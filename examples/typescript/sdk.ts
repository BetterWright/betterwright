// The quickstart run through the SDK entrypoint: withBrowser closes the
// client for you, on the way out and on a thrown error.
//
//   node examples/typescript/sdk.ts

import { BrowserError, withBrowser } from "betterwright/sdk";

const title = await withBrowser(async (bw) => {
  await bw.run("await page.goto('https://example.com')", { note: "Opening example.com" });

  const result = await bw.run<string>("return page.title()");
  if (!result.ok) throw new BrowserError(result.error);

  const proof = await bw.run("return screenshot({ kind: 'proof', name: 'example-home' })");
  console.log("Proof:", proof.artifacts?.[0]?.media);
  return result.result;
});

console.log("Title:", title);
