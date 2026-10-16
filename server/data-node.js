// The filesystem boundary is replaced by worker/data-loader.js in the Workers bundle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

/** data/*.json files the server never reads, so never loads: the official effects' file list (data/local-fx.json, written
 * by tools/local-extract/fx.py, DESIGN §33 — ~1 MB the browser alone fetches, through its served view). */
export const UNLOADED_DATA = Object.freeze(['local-fx.json']);

export function readDataDirectory(dir = DATA_DIR, log = console) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json') && !UNLOADED_DATA.includes(d.name.toLowerCase()))
      .map((d) => d.name).sort();
  } catch (e) {
    log.warn(`[data] cannot read ${dir}: ${e.code || e.message} — running without game data`);
  }
  for (const file of names) {
    try { out[file.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { log.error(`[data] skipping ${file}: ${e.message}`); }
  }
  return out;
}
