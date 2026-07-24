// Start an account-backed, endpoint-encrypted Live View for one session.
//
// First create a key at https://betterwright.com/account and run:
//   betterwright account set-key
//
// Then:
//   node examples/javascript/live-view.mjs

import { BetterWright, BrowserError } from "betterwright";

const session = "live-view-example";
const bw = new BetterWright({ liveView: { transport: "relay" } });

try {
  const opened = await bw.run("await page.goto('https://example.com'); return page.title()", {
    session,
  });
  if (!opened.ok) throw new BrowserError(opened.error);

  const view = await bw.startLiveView({ session, interactive: true });
  if (!view.ok) throw new BrowserError(view.error);

  // This URL contains the private viewer capability. Give it only to the
  // intended viewer and do not put it in logs or model prompts.
  console.log(`Open ${view.url}`);
  console.log("Press Ctrl-C to end the Live View.");

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await bw.stopLiveView().catch(() => {});
  await bw.close();
}
