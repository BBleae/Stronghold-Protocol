// One rules version's simulation for the browser, bundled independently for each version (tools/build-replay.mjs) and
// published at /replay-engines/<id>/engine.js: the replay screen re-simulates an archived match with it, and the battle
// runner (public/js/battle/runner.js) simulates a live battle with it when the match runs on rules older than the page's
// own (a match the room Worker restored after a deploy). Its data and registries never touch the live client.
import { getData } from '../server/data.js';
import { DataSource, setSimData } from '../server/sim/simdata.js';
import * as spec from '../server/sim/spec.js';
import { setGameData } from '../server/sim/content/support/index.js';

export const rulesVersion = __SP_RULES_VERSION__;
/** The spec helpers a live battle needs (createBattleFromSpec, battleProgress, compactResult, …), of this version. */
export { spec };

let ds;
export async function ready() {
  if (ds) return;
  const raw = getData();
  setSimData(raw);
  setGameData(raw);
  ds = new DataSource(raw, null);
}
export function dataSource() {
  if (!ds) throw new Error('REPLAY_NOT_READY');
  return ds;
}
export function createBattle(battleSpec) { return spec.createBattleFromSpec(battleSpec, dataSource()); }
export function stage(id) { return getData().stages?.[id] || null; }
