import { type BetterWrightOptions, withBrowser } from "betterwright/sdk";

const options: BetterWrightOptions = { headless: true, vault: false };

const syncDefault: Promise<string> = withBrowser((browser) => browser.home);
const syncOptions: Promise<number> = withBrowser(options, (browser) => browser.defaultTimeout);
const asyncDefault: Promise<string> = withBrowser(async (browser) => browser.home);
const asyncOptions: Promise<number> = withBrowser(options, async (browser) => browser.defaultTimeout);

const thenable: PromiseLike<number> = Promise.resolve(42);
const thenableDefault: Promise<number> = withBrowser(() => thenable);
const thenableOptions: Promise<number> = withBrowser(options, () => thenable);

const mixedDefault: Promise<string> = withBrowser((browser) =>
  browser.headless ? browser.home : Promise.resolve(browser.home),
);
const mixedOptions: Promise<string> = withBrowser(options, (browser) =>
  browser.headless ? browser.home : Promise.resolve(browser.home),
);

const voidDefault: Promise<void> = withBrowser(() => {});
const voidOptions: Promise<void> = withBrowser(options, () => {});

void [
  syncDefault,
  syncOptions,
  asyncDefault,
  asyncOptions,
  thenableDefault,
  thenableOptions,
  mixedDefault,
  mixedOptions,
  voidDefault,
  voidOptions,
];
