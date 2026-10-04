// Tile lists carried by fx events (`tiles: [[r, c]…]`, read by public/js/render/fx.js tilesAround): the area a skill
// actually covers (its range / grid), so the client flashes those tiles instead of guessing a disc. Cosmetic only —
// nothing in the sim reads them.

import { COLS } from '../constants.js';
import { absoluteRangeKeys } from '../targeting.js';

const CAP = 80;

/** [[r, c]…] of tile keys (r * COLS + c), sorted, at most CAP. */
export function keyTiles(keys) {
  const out = [];
  for (const k of keys || []) {
    if (!Number.isInteger(k) || k < 0) continue;
    out.push([(k / COLS) | 0, k % COLS]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, CAP);
}

/** [[r, c]…] of `grid` offsets around `unit` (its facing), like Battle.unitsInGrid. */
export function gridTiles(unit, grid) {
  if (!unit) return [];
  return keyTiles(absoluteRangeKeys(grid || unit.rangeGrid || [[0, 0]], Math.round(unit.y), Math.round(unit.x), unit.dir));
}
