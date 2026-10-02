// Bundle only generated game data; filesystem/research fallbacks remain exclusive to Node.
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
import assets from '../data/assets.json';
import emotes from '../data/emotes.json';
import tuning from '../data/tuning.json';

export const ROOT = '';
export const DATA_DIR = '/data';
export function readDataDirectory() {
  return { config, chess, bonds, garrisons, items, bands, effects, choices, enemies, factions,
    waves, stages, bosses, tokens, assets, emotes, tuning };
}
