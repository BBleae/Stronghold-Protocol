// Bundled independently for each version: its module data and registries never touch the live client.
import { getData } from '../server/data.js';
import { DataSource,setSimData } from '../server/sim/simdata.js';
import { createBattleFromSpec } from '../server/sim/spec.js';
import { setGameData } from '../server/sim/content/support/index.js';
export const rulesVersion=__SP_RULES_VERSION__;
let ds;
export async function ready() {
  if(ds)return;
  const raw=getData();setSimData(raw);setGameData(raw);
  ds=new DataSource(raw,null);
}
export function createBattle(spec) {if(!ds)throw new Error('REPLAY_NOT_READY');return createBattleFromSpec(spec,ds);}
export function stage(id) {return getData().stages?.[id] || null;}
