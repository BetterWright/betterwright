// Drive two tabs concurrently within one session.
//
//   node examples/typescript/multi_tab.ts

import { BetterWright } from "betterwright";

const bw = new BetterWright();
try {
  const result = await bw.run(`
    const [a, b] = await Promise.all([
      openPage('https://example.com'),
      openPage('https://example.org'),
    ]);
    return { a: await a.title(), b: await b.title(), open: pages.length };
  `);
  // The two opened tabs, plus the blank page the context starts with.
  console.log(result.result);   // { a: 'Example Domain', b: 'Example Domain', open: 3 }
} finally {
  await bw.close();
}
