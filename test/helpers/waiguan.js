// test/helpers/waiguan.js — the 外援 / 甄选 records for sim tests. The battle DataSource of a match does not hold them yet
// (they live only in data/waiguan.json; DESIGN §27), so sim / content tests inject them: `makeBattle({ defs: { chess: WG } })`
// or `wgSource()` (a DataSource with every 外援 record, the generated data behind it).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waiguanRecords } from '../../shared/waiguan.js';
import { DataSource, getDefaultSource } from '../../server/sim/simdata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(ROOT, 'data/waiguan.json');

/** data/waiguan.json (null when the data was never generated). */
export const WAIGUAN = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
/** Every 外援 chess record: tier V + VI, normal + elite (shared/waiguan.js waiguanRecords). */
export const WG = WAIGUAN ? waiguanRecords(WAIGUAN) : {};
/** Skip reason for tests that need the 外援 data. */
export const noWaiguan = !WAIGUAN && 'no data/waiguan.json (run node tools/build-data.mjs)';

/** Chess id of a 外援 operator: wgId('char_010_chen') = chess_char_diy_6_char_010_chen_a. */
export const wgId = (charId, { tier = 6, elite = false } = {}) => `chess_char_diy_${tier}_${charId}_${elite ? 'b' : 'a'}`;

let source = null;
/** A DataSource with every 外援 record over the default (generated) data. */
export function wgSource() {
  if (!source) source = new DataSource({ chess: WG, enemies: {}, tokens: {}, stages: {}, waves: {} }, getDefaultSource());
  return source;
}
