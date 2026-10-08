// worker/match-checkpoint.js — the checkpoint a room stores for its running match, whichever rules engine runs it
// (RoomRuntime.checkpoint, GatewayLobby.checkpoint).
//
// exportMatch is the current engine's. A match a retained engine restored (worker/match-versions.js) is an object of
// that older engine, and the Worker checkpoints it with the same exportMatch on every later commit — the archived
// bundles export only create / restore. The retained 7a47e943 / 0e7397b2 engines also checkpointed their 外援 picks
// (`picks`: a copy of match.waiguanPicks — the fork's 外援, DESIGN §F3, retired by the merge of upstream 0.2.0; their bots
// pick too) and refuse a restore whose `picks` differ (CHECKPOINT_STATE_DIVERGED). Without them here the first wake
// after a deploy restored such a match and re-saved it without its picks, and the next wake ended it as interrupted.
// The current engine has no 外援: its matches carry no waiguanPicks and their checkpoints no `picks`.

import { exportMatch } from '../server/match/checkpoint.js';

/**
 * The checkpoint of a running match (its event log by reference): exportMatch, plus the `picks` of a match a retained
 * 外援-era engine runs, exactly as that engine's own exportMatch wrote them.
 * @param {any} match
 */
export function checkpointMatch(match) {
  const checkpoint = exportMatch(match, { referenceEvents: true });
  const picks = match?.waiguanPicks;
  if (picks && typeof picks === 'object') checkpoint.picks = JSON.parse(JSON.stringify(picks));
  return checkpoint;
}
