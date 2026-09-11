import type { BetterWright, RunOptions } from "betterwright";

const options: RunOptions = { automaticUI: false };
declare const browser: BetterWright;
void browser.run("return page.url()", options);
void browser.run("return page.url()", { automaticUI: true });
// @ts-expect-error Automatic discovery is a boolean per-call option.
void browser.run("return page.url()", { automaticUI: "false" });
