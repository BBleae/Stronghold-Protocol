// server/match/match/common.js — constants and small helpers shared by the Match method modules
// (server/match/match/*.js); server/match/Match.js re-exports FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS and
// DEADLINE_REHEARSAL_TICKS.

/**
 * Ticker priority of the remake's match-flow notices (隐秘核心已解锁, 联防阶段, a player out or gone): the official lines
 * (research 06 §9.2) go BOSS_HIT 30 > CHAR_DAMAGE 20 > SHOP_LEVEL 11 > GOLDEN_CHAR 2 > CHAR_GIFT 1; ours sit under the
 * leader-damage lines [ASSUMED].
 */
export const FLOW_TICKER_PRIORITY = 25;
/** Boss clock period (overtime drain, end checks, silence watchdog) in real ms. */
export const BOSS_CLOCK_MS = 250;
export const OK = Object.freeze({ ok: true });
export const fail = (error, detail) => (detail ? { error, detail } : { error });

/** Fixed presentation delays (real ms, × timerScale). */
export const DELAYS = Object.freeze({
  ROUND_START: 2000,
  COMBAT_END: 1500,
  SETTLE: 3000,
  BOT_ACTION: 900,
  BOT_STAGGER: 350,
  PUBLIC_THROTTLE: 100,
});

/**
 * Seconds of one turn of the co-op strategy draft (user playtest #4 item 4: the old 12 s per turn — research 06 §724,
 * itself [ASSUMED] — inside the 50 s step was far too little and counted apart from the header's 50 s). [ASSUMED]: the
 * official data only gives the whole BAND_CHECK step (autoChessData.enterStepList: 50 s, hint 15 s); the turn clock is
 * the remake's. It is also the step's only countdown (m.public.deadline = draft.turnDeadline). × timerScale. A match of
 * more than 4 seats (remake extension) has gamedata.js largeRoom.bandTurn (20 s) turns instead (Match.bandTurnSeconds).
 * Fork decision of 2026-10-10 (docs/design/fork.md §F1.3): upstream 0.2.3 made this 50 s (its owner's official-play
 * report); this fork keeps 30 s.
 */
export const BAND_TURN_SECONDS = 30;

/**
 * Rehearsal ticks the prep deadline runs for the AI-played seats it finishes, all of them together (fixed work counts:
 * workSlice.deadlineRehearsalTicks, recorded with the match; checkpoint.js WORK_SLICE). Measured on a desktop late in an
 * 8-seat match, 1024 ticks are ~10–50 ms of the deadline event (path-dependent; once 65 ms). The rest of that event is
 * not bounded by it: each seat still in its economy + default layout runs another ~15–40 ms (about half of it the final
 * arrangement's other REHEARSAL_VARIANTS plans and rehearsal Battles, made even for a seat left with no ticks), then
 * come the end stages, the fight's start and the commit. So when 3–4 humans switch autoplay on ~1 s before the deadline
 * (their jobs' start, BOT_ACTION later, falls just before it), the deadline event takes ~70–170 ms — over the ~80 ms
 * aim whatever this budget (0 still leaves 60–110 ms). docs/CLOUDFLARE.md 房间计算调度 has the measurements.
 */
export const DEADLINE_REHEARSAL_TICKS = 1024;
