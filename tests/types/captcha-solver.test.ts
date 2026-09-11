import { dedupeBoxes, sortTilesReadingOrder } from "../../types/captcha-solver.js";

const tiles = [
  { x: 5, y: 0, width: 10, height: 10 },
  { x: 1, y: 0, width: 10, height: 10 },
];
const ordered: Array<{ x: number; y: number; width: number; height: number }> = sortTilesReadingOrder(tiles, 12);

// dedupeBoxes normalises partial rectangles; sortTilesReadingOrder compares
// x/y directly and would produce NaN comparisons for missing coordinates.
const normalised = dedupeBoxes([{ x: 1 }, {}]);
// @ts-expect-error Reading-order sort requires complete rectangles.
sortTilesReadingOrder([{ x: 1 }, {}]);

void [ordered, normalised];
