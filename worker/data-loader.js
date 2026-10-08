// Bundle only the generated game data the server and the sim read; filesystem/research fallbacks remain exclusive to
// Node. data/assets.json (the client's art and voice manifest, ~0.8 MB) and data/emotes.json are client data that no
// server or sim code reads: they stay out of the Worker and out of every rules-version engine (tools/build-replay.mjs),
// so an art or voice update never mints a rules version. `assets: null` keeps server/data.js's expected-file check quiet.
import config from '../data/config.json';
import chess from '../data/chess.json';
import bonds from '../data/bonds.json';
import garrisons from '../data/garrisons.json';
import items from '../data/items.json';
import bands from '../data/bands.json';
import effects from '../data/effects.json';
import choices from '../data/choices.json';
import enemies from '../data/enemies.json';
import factions from '../data/factions.json';
import waves from '../data/waves.json';
import stages from '../data/stages.json';
import bosses from '../data/bosses.json';
import tokens from '../data/tokens.json';
import tuning from '../data/tuning.json';
// 补位 stand-ins and 自选编队 (0.2.0, DATA.md §18): a room checks its players' 自选 picks against it (shared/diy.js), and a
// match, its recovery and replay engines build stand-in, 自选 and 自选-summon records from it (simdata getStandIn / getDiy /
// getToken, server/match/player/diy.js) — without it they would quietly fall back to the replaced chess's own records
import backups from '../data/backups.json';

export const ROOT = '';
export const DATA_DIR = '/data';
export function readDataDirectory() {
  return { config, chess, bonds, garrisons, items, bands, effects, choices, enemies, factions,
    waves, stages, bosses, tokens, assets: null, tuning, backups };
}
