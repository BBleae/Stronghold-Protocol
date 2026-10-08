// Local battle runner — client-side combat (DESIGN §14, research 09 §3.2 / §6.4).
//
// Like the official client, the browser simulates battles itself with the shared deterministic sim (server/sim,
// served read-only at /sim/). The server sends a JSON BattleSpec (`b.start`); this module builds the Battle with
// /sim/spec.js createBattleFromSpec and
//   * steps it at the battle speed (fixed 1/30 s ticks, 2× → 60 ticks per real second; at most
//     max(8, 4·speed) ticks per animation frame, bounded fast-forward up to CATCHUP_TICKS per frame when it is far
//     behind: a reconnect, observing a running field, a tab back from the background); each frame first steps every
//     running field's real-time share, the rest — that fast-forward, the silent catch-up of a field being prepared —
//     within a soft budget (runBatch),
//   * feeds the render engine every frame through the same wire formats the server used to stream
//     (`snap` = b.snap frame from battle.snapshot(), `ev` = b.ev frame from battle.drainEvents()) and publishes the
//     field meta (m.field shape) into store.match.field so the game screen enters the battle,
//   * when authoritative: reports b.progress (~1 Hz; boss fields 4 Hz with the shared-pool damage and the LP meter)
//     and b.result (compactResult) at the end; applies b.pool (LocalBossPool.sync) and b.end (forceEnd / takeover),
//   * keeps an authoritative battle running while the tab is hidden (a 250 ms interval pump; browsers throttle it to
//     ~1 Hz, its real-time share of up to CATCHUP_TICKS per pump absorbs that); a pump the browser suspends, or a tick
//     so slow that no share keeps up, still falls behind — the server deadline / silence takeover covers a normal field,
//     a boss field that keeps reporting is not taken over for lag.
// A frame that fast-forwards (catch-up) passes on only the state-bearing events (keepsState: spawns, deaths, deploys,
// statuses, skills, leaks and the fx that change an enemy's model form — shared/protocol.js fxForm); while the tab is
// hidden the battle on screen keeps the same events (compacted past HELD_MAX; a backlog still past it makes the view
// re-enter from the field meta) and the first frame back delivers them — or, for a battle that ended while hidden, the
// visibilitychange itself — so the view still knows every unit and every enemy's current form (player report #5 after
// 0.1.0: a 转译基底·α that changed form during a stall or in a background tab died in its first-form model). Such a
// frame or step covers seconds of play, so it drains the events every EV_SLICE ticks and each batch keeps its own game
// time (`gt`): the render engine then knows how late a form fx is and skips a change clip that has already ended.
// Display replicas (a teammate's field after the own battle, 联防 observers, the partner of a boss pair) run the same
// spec fast-forwarded to the server's clock (`elapsed`) and never report.
// A b.start is registered as a preparation the moment it arrives — before the sim module (or its rules version's engine)
// has loaded, while the Battle is built and caught up silently in the frame / pump batches (runBatch) — so what comes
// for that battle meanwhile is applied to it in order (upstream R21G, PR #266; the fork's preparations: `controls` until
// the Battle exists): a b.end takeover stops its reports; a forced / timeout b.end (the first end counts) ends it as soon
// as the Battle exists, without catching up; a second b.start of it updates its flags and clock (never a second Battle);
// b.pool and the solo pause reach it. A b.start of another field supersedes it: an authority, or a battle the server
// already ended, is still built and kept, a display replica is dropped. The next prep's clear() drops it.
// A b.result goes out right behind its battle's final b.progress, on the same session. One that could not go out
// (offline) or was lost with the socket (the request failed DISCONNECTED / OFFLINE, or timed out twice) is kept and
// sent again on the next session ('welcome') or when a b.start still names this finished battle authoritative (the
// server is waiting for it); the server takes a duplicate idempotently. A server refusal is final.
// Replay log (account mode): every battle simulated here logs its tick inputs — the b.pool syncs and the b.end — the way
// the replay re-applies them (battle/replay-runner.js). An authoritative battle's b.progress carries the part of the log
// the server's copy (server/match/recorder.js) lacks, at most REPORT_INPUTS inputs per report (a longer backlog goes out
// as several reports), each report claiming the tick it covers. A report counts once it went out on an open socket.
// Whenever the server's copy is unknown — the battle's first report, authority gained (a boss handover), a new
// session — the reports start a new segment (seq 0) with the whole log, which replaces the server's copy.
// Solo pause (g.pause, DESIGN §14): while `m.public.paused` is true every local battle clock stands still (no ticks, no
// reports); on resume the clocks move on by the paused time, like the server's field clock.
// Live leaks (user playtest #3 item 2): every normal field simulated here keeps its counted leaks so far — the settle
// rule's count (leaked entries with counted !== false, /sim/spec.js battleProgress) — and publishes them as
// state().leaks { [fieldId]: n } whenever one changes, authoritative or display replica alike; the top bar shows the
// own field's min(lpCapPerRound, n) as the LP about to be lost (ui/hud.js liveLp). A 联防 field keeps each leaker's
// enemies still standing (/sim/spec.js uniteLeft; user playtest #6 item 7) as state().uniteLeft { [playerId]: n },
// published whenever it changes (it falls as the helpers kill them), and its authority reports it as b.progress `left`.
// Live bond layers (DESIGN §20.15): every battle simulated here keeps the bonds whose layers grew in it (IN_BATTLE gains,
// Battle.addLayers — normal battles only) as absolute counts per player, published as state().bondLayers
// { [playerId]: { [bondId]: n } } (every battle of the round: the own one, the teammates' replicas) whenever one grows;
// the bond strip of the player on screen — the own one, or a watched teammate's — shows them live (ui/watchBonds.js).
//
// What such a backlog / catch-up frame hands over (keepsState, handOver) also keeps 影哨 placed / recalled — the backlog
// never a skill START (the snapshot's SKILL flag turns a running skill on; replayed, it flashed its activation and played
// its voice long after; a catch-up frame still passes them on) — and marks a status that is on and a 影哨 event as late:
// the view makes the lasting look the status names (render/fxsustain.js) and no stale one-shot (review of the animation /
// effects PR, point 8). Every such 'ev' batch (the backlog's, a catch-up frame's) carries `handOver: true`: the render
// engine tells a late tuple by its game time (render/app.js heardEvents), the DOM fallback, which hears the frames as they
// come, by that flag — it gives the sound only the batch's spawns (screens/game.js onEv: no late 作战中 / 部署 voice).
//
// The sim (≈ 0.2–1 ms per tick) runs on the main thread: one battle at a time is stepped for display (plus an
// authoritative one if it is not the one on screen, plus the ones being prepared). Each RAF / hidden pump is one batch
// (runBatch): the running battles' real-time shares and the preparations' convergence floors first, never cut, then the
// catch-up beyond real time and the rest of the preparation work within a soft wall-time budget (FRAME_WORK_MS and the
// others below), checked between fixed ticks, authoritative battles first. A frame thus stays within its fields' cap·c
// (as before the budget) plus the floors and the budget, an authority keeps its clock wherever the device can keep it at
// all, and a preparation converges. Construction and the initial view setup remain synchronous.
//
//   import { battleRunner } from './battle/runner.js'     (browser singleton wired to net.js + store.js; null in Node)
//   battleRunner.on('snap' | 'ev' | 'field' | 'state' | 'ownDone', fn) → off
//     'ev' { t: 'b.ev', fieldId, gt, ev, handOver? }: `handOver` true on a batch of a catch-up frame or of the hidden-tab
//               backlog (the span the view did not see: state-bearing tuples only, see above)
//     'ownDone' { battleId, fieldId, late }: one of the player's own battles (an entry that is no display replica of
//               someone else's field — authoritative or not) just finished here, once per entry, whichever field is on
//               screen. `late`: it was already over when it reached this client (it finished in the silent catch-up
//               before it was first shown: a reload / resync after its end). The game screen speaks that battle's
//               settlement line from it when the own field is not on screen (screens/game.js sayResult, DESIGN §21.30).
//   battleRunner.state()  → { battleId, fieldId, kind, authoritative, watch, done, own, members, loading, paused, leaks,
//                              uniteLeft, bondLayers } | null
//   battleRunner.settlement(battleId, playerId) → how that player's part of a finished own battle went — { perfect,
//                           leaked (counted leaks), killed, total, unitsEnd: [{ defId (chess id), alive }], boss,
//                           bossDown } — or null (unknown battle, still running, a display replica, no such player).
//                           Read from the battle's own result (authoritative or not: every own battle is simulated
//                           here); bossDown (boss / hidden fields only, else null): the pool was emptied — the battle
//                           ended 'cleared' here, the server's b.end said 'cleared', or the result's bossHpLeft is 0.
//                           The settlement voice line (audio.js settlementVoice) is picked from it.
//   battleRunner.stats() → tick/step cost, prepareMs/maxPrepareMs, maxFrameMs/maxPumpMs and workload counters.
//     Frame/pump maxima include synchronous runner subscribers, not the page's independent render loop.
//   battleRunner.unitStats(unitId, fieldId?) → the live stats of a unit of the battle on screen (shared/protocol.js
//                           unitStatsEntry: current HP, effective max HP / ATK / DEF / RES / interval / block / move
//                           speed next to its base; an ally also its live attack range `range` — unit.liveRangeGrid,
//                           facing RIGHT, never a kit's target-selection grid) | null — the detail card reads it a few
//                           times a second (user playtest #4 item 7; the range mini-map, community report E1 after
//                           0.1.0). Read-only: it takes the stats the sim computed last (`unit._s`) and the range grid it
//                           keeps, and never makes the unit recompute them, so looking never changes the battle's floats.
//   battleRunner.unitIdOf(uid, ownerId, fieldId?) → the id of an own board piece's unit in that battle | null
//   battleRunner.ownerOps(ownerId, fieldId?) → [{ kind: 'op', ownerId, defId, items?, standInFor? }] that player's
//                           operators in the battle on screen with their equipment (a teammate's bond popup: the members in
//                           play, DESIGN §20.15, 变形同构体 wearers included; a 补位 stand-in names the replaced charId) | []
//
// createBattleRunner(deps) builds an instance with injectable net / store / clock / frame scheduler / sim loader
// (test/match/runner.test.js, runner-pending.test.js, runner-lifecycle.test.js and runner-budget.test.js drive it under Node).

import { net as appNet } from '../net.js';
import { store as appStore } from '../store.js';
import { unitStatsEntry, fxForm, RESULT_LIMITS } from '../../../shared/protocol.js';
import { spectateEffects } from './observe.js';

const TICK = 1 / 30;
/** Fast-forward budget per frame (ticks) when far behind. */
export const CATCHUP_TICKS = 240;
/** Silent catch-up slice (ticks) while a new battle is prepared before it is shown. */
const PREPARE_SLICE = 600;
/**
 * Soft wall-time budgets (ms) of one batch — an animation frame, a hidden-tab pump — for the work past the battles'
 * shares (runBatch): catch-up beyond real time and preparations. Checked between ticks (a step is indivisible), started
 * after the shares. FRAME_WORK_MS while a field plays on screen at its pace (also while another one loads behind it);
 * LOADING_WORK_MS while none does (only the loading view, a finished field, a fast-forward); HIDDEN_WORK_MS per hidden-tab
 * pump (browsers throttle it to ~1 Hz).
 */
export const FRAME_WORK_MS = 4;
export const LOADING_WORK_MS = 10;
export const HIDDEN_WORK_MS = 64;
/**
 * A page can stay visible yet get no animation frames (an occluded window or an embedded web view that stops drawing
 * without setting document.hidden). Once a requested frame is this late, the interval pump runs the authoritative
 * battles and the preparations as for a hidden tab, so the field keeps reporting instead of waiting for a takeover.
 */
export const FRAME_STALL_MS = 1000;
/** A preparation's floor per batch: this many times what its target grew since its last batch (≤ CATCHUP_TICKS). */
export const PREPARE_FLOOR = 2;
const MAX_ENTRIES = 4;
/**
 * Battles the cache keeps (evict(), besides the current, own, authoritative-unsent and undelivered ones): one round of
 * the room — the own battle and every teammate's display replica — so cycling through teammates never rebuilds and
 * fast-forwards a replica it saw: MAX_ENTRIES (4) for 1–4 players, one per player in a room of 5–8.
 * @param {number} [players] the match's players (m.public players)
 */
export const runnerCacheMax = (players) => Math.max(MAX_ENTRIES, Number.isInteger(players) ? players : 0);
const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);
/**
 * The b.ev tuples a catch-up frame or the hidden-tab backlog keeps: the state-bearing kinds, and every fx that sets an
 * enemy's model form (shared/protocol.js fxForm — dropped, the view kept the old model: player report #5 after 0.1.0).
 */
export const keepsState = (x) => Array.isArray(x) && (STATE_EV.has(x[0]) || fxForm(x) !== undefined || isSentryFx(x));
/** 伊内丝's 影哨 placed / recalled: kept with the state too — lost, it stays missing / drawn. */
export const isSentryFx = (x) => Array.isArray(x) && x[0] === 'fx' && (x[1] === 'sentry' || x[1] === 'sentryRecall') && !!x[4] && typeof x[4] === 'object' && x[4].id != null;
/**
 * A kept tuple as the view gets it after the span it did not see (the hidden-tab backlog, a catch-up frame): a status
 * that is on marked 'late' — its lasting look is made from it (render/fxsustain.js status), the fx that came with it
 * being one-shot and not kept —, a 影哨 event marked `late` — its record only, no stale summon pillar / recall streak.
 */
export function handOver(x) {
  if (x[0] === 'status' && x[3]) return [x[0], x[1], x[2], x[3], 'late'];
  if (isSentryFx(x)) return [x[0], x[1], x[2], x[3], { ...x[4], late: true }];
  return x;
}
/**
 * Hidden-tab backlog cap (tuples) of the battle on screen. Past it the backlog is compacted (compactHeld: only the last
 * 'status' per unit and status, the last 'skill' per unit — what the view ends up showing); only a backlog still past it
 * (thousands of spawns) makes the view re-enter from the field meta.
 */
export const HELD_MAX = 3000;
/**
 * Ticks per event batch of a step that covers more than one frame of play (a catch-up frame of up to CATCHUP_TICKS, a
 * hidden-tab step): its events are drained every EV_SLICE ticks and stamped with that game time, not the frame's.
 */
export const EV_SLICE = 15;

/**
 * A hidden-tab backlog without the superseded toggles: of the 'status' tuples only the last per (unit, status), of the
 * 'skill' tuples only the last per unit, every other tuple (spawn / die / deploy / leak / form fx — bounded by the units)
 * kept; order preserved. A long hidden boss fight toggles statuses thousands of times, the rest stays small.
 */
export function compactHeld(list) {
  const last = new Map();
  list.forEach((x, i) => {
    if (x[0] === 'status') last.set(`s:${x[1]}:${x[2]}`, i);
    else if (x[0] === 'skill') last.set(`k:${x[1]}`, i);
  });
  return list.filter((x, i) => (x[0] === 'status' ? last.get(`s:${x[1]}:${x[2]}`) === i : x[0] === 'skill' ? last.get(`k:${x[1]}`) === i : true));
}
/**
 * Data files the simulation reads (DataSource + content/support gameData()). `backups` = data/backups.json (0.2.0 补位
 * stand-ins and 自选编队 operators): a stand-in / a 自选 slot fights in the browser's battle exactly as in the server's.
 */
export const SIM_DATA_FILES = Object.freeze(['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups']);

/** Request failures after which a b.result counts as never delivered (re-sent on the next session / b.start). */
export const LOST_RESULT_CODES = Object.freeze(['DISCONNECTED', 'OFFLINE', 'TIMEOUT']);

/** The most replay-log inputs one b.progress report carries (shared/protocol.js isReplayReport). */
export const REPORT_INPUTS = 128;

/** Ticks per frame at a speed (same cap as the server pacing: server/match/fields.js maxTicksPerInterval). */
export const ticksPerFrameCap = (speed) => Math.max(8, Math.ceil((Number(speed) || 2) * 4));

function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || Object.isFrozen(o)) continue;
    Object.freeze(o);
    for (const v of Object.values(o)) if (v !== null && typeof v === 'object') stack.push(v);
  }
  return root;
}

/**
 * Browser sim loader: the /sim/ modules + the data files (own frozen copies — the server's data is frozen too, so a
 * content bug that writes into a record fails identically on both sides).
 */
export async function loadBrowserSim({ base = '/sim/', dataBase = '/data/', fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  const [spec, simdata, support] = await Promise.all([
    import(`${base}spec.js`), import(`${base}simdata.js`), import(`${base}content/support/index.js`),
  ]);
  const fetchOnce = async (n) => {
    try {
      const res = await fetchFn(`${dataBase}${n}.json`, { cache: 'no-cache' });
      return res && res.ok ? await res.json() : null;
    } catch { return null; }
  };
  const files = await Promise.all(SIM_DATA_FILES.map(async (n) => (await fetchOnce(n)) ?? fetchOnce(n)));
  // a battle simulated without part of the data would still produce a plausible result the server accepts: never run
  // one — the loader fails (the next b.start retries it; meanwhile the server's deadline takes the field over)
  const missing = SIM_DATA_FILES.filter((n, i) => !files[i] || typeof files[i] !== 'object');
  if (missing.length) throw new Error(`simulation data unavailable: ${missing.join(', ')}`);
  const raw = {};
  SIM_DATA_FILES.forEach((n, i) => { raw[n] = deepFreeze(files[i]); });
  simdata.setSimData(raw);
  if (typeof support.setGameData === 'function') support.setGameData(null); // re-read through the injected data
  return { spec, ds: new simdata.DataSource(raw, null) };
}

/**
 * Another rules version's simulation: the archived engine the deployment publishes for it (worker/replay-engine.js,
 * /replay-engines/<id>/engine.js), with the spec helpers a live battle needs. An engine archived before it exported
 * those helpers cannot run a live battle: rejects with code ENGINE_NOT_LIVE (a failed load rejects as it is).
 */
export async function loadEngineSim(version, { importFn = (url) => import(url) } = {}) {
  const engine = await importFn(`/replay-engines/${version}/engine.js`);
  if (engine.rulesVersion !== version) throw new Error(`engine ${version} reports rules version ${engine.rulesVersion}`);
  if (!engine.spec || typeof engine.dataSource !== 'function') {
    throw Object.assign(new Error(`the engine of rules version ${version} cannot run live battles`), { code: 'ENGINE_NOT_LIVE' });
  }
  await engine.ready();
  return { spec: engine.spec, ds: engine.dataSource() };
}

/** Battle logger: content errors are isolated by the sim; report them as warnings (the server logs its own). */
const SIM_LOGGER = Object.freeze({
  error: (...a) => console.warn('[sim]', ...a),
  warn: (...a) => console.warn('[sim]', ...a),
  info() {},
  debug() {},
});

/**
 * `rulesVersion`: the rules of the page's own simulation (index.html data-sp-rules in the Cloudflare build). A b.start
 * naming other rules (a match the room Worker restored from an older deployment) is simulated with that version's
 * engine (loadEngine), so the browser and the server run the match on the same rules.
 * @param {{ net: any, store: any, loadSim?: () => Promise<{ spec: any, ds: any }>, now?: () => number,
 *   rulesVersion?: string|null, loadEngine?: (version: string) => Promise<{ spec: any, ds: any }>,
 *   raf?: (fn: (t: number) => void) => any, caf?: (h: any) => void, setInterval?: Function, clearInterval?: Function,
 *   doc?: { hidden?: boolean, addEventListener?: Function } | null, logger?: object }} deps
 */
export function createBattleRunner(deps) {
  const net = deps.net;
  const store = deps.store;
  const now = deps.now || (() => (globalThis.performance ? performance.now() : Date.now()));
  const raf = deps.raf || ((fn) => globalThis.requestAnimationFrame(fn));
  const caf = deps.caf || ((h) => globalThis.cancelAnimationFrame(h));
  const setIv = deps.setInterval || ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = deps.clearInterval || ((h) => globalThis.clearInterval(h));
  const doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
  const loadSim = deps.loadSim || (() => loadBrowserSim());
  const ownRules = deps.rulesVersion !== undefined ? deps.rulesVersion : (doc?.documentElement?.dataset?.spRules ?? null);
  const loadEngine = deps.loadEngine || ((version) => loadEngineSim(version));
  const logger = deps.logger || SIM_LOGGER;

  const listeners = new Map();
  const emit = (type, payload) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.warn(`[runner] ${type} listener failed`, err); }
    }
  };

  /** @type {Map<string, any>} battleId → entry */
  const entries = new Map();
  // Preparations receive controls immediately and share simulation work with committed entries, without rendering.
  const preparing = new Map();
  let workAfter = null;       // last battle ID that used a batch's soft budget; the next one starts after it (runBatch)
  let cur = null;              // entry on screen
  let simP = null;
  let startSeq = 0;            // viewing selection; switching it must not cancel own authority
  let lifecycle = 0;          // clear / new round / leaving invalidates every unfinished preparation
  let disposed = false;
  let loading = null;          // b.start being prepared
  let rafH = null;
  let rafAt = 0;               // when the pending frame was requested (FRAME_STALL_MS)
  let ivH = null;
  let lastPool = null;
  /** solo pause: the runner clock's instant when m.public.paused turned true (null while running) */
  let pausedAt = null;
  /** a normal field's leak count (or a battle's bond layers) changed since the last publishState() */
  let leaksDirty = false;
  /** sessions so far ('welcome'): a replay report segment belongs to the session it started in */
  let session = 0;
  const stats = { ticks: 0, stepMs: 0, prepareMs: 0, maxPrepareMs: 0, maxFrameMs: 0, maxPumpMs: 0,
    catchups: 0, errors: 0, battles: 0, frames: 0 };
  /** Hidden-tab backlog tuple → the game time it was drained at (emitFrame batches the backlog by it). */
  const heldAt = new WeakMap();

  const hidden = () => !!(doc && doc.hidden);
  /** The battle clock: frozen at the pause instant while the solo battle is paused. */
  const clock = () => (pausedAt != null ? pausedAt : now());
  const bossLike = (e) => e.kind === 'boss' || e.kind === 'hidden';

  function ensureSim() {
    if (!simP) {
      simP = loadSim().catch((err) => { simP = null; throw err; });
    }
    return simP;
  }

  // The simulation of a battle's rules: the page's own, or that version's archived engine. An engine that cannot run
  // live battles (archived before it could) leaves only the page's own rules — said in the console, once per version;
  // a failed load is not kept (the next b.start tries again, as with the page's own simulation).
  const engines = new Map();
  function simFor(version) {
    if (!version || version === ownRules) return ensureSim();
    if (!engines.has(version)) {
      engines.set(version, loadEngine(version).catch((err) => {
        if (err.code !== 'ENGINE_NOT_LIVE') {
          engines.delete(version);
          throw err;
        }
        console.warn(`[runner] rules version ${version}: ${err.message}; simulating with this page's rules`);
        return ensureSim();
      }));
    }
    return engines.get(version);
  }

  /** Counted leaks so far of every normal field simulated here: { [fieldId]: n } (user playtest #3 item 2). */
  function leakMap() {
    const out = {};
    for (const e of entries.values()) if (e.kind === 'normal' && e.fieldId) out[e.fieldId] = e.leaks;
    return out;
  }

  /**
   * Live bond layers of every battle simulated here (DESIGN §20.15): { [playerId]: { [bondId]: n } } — only the bonds
   * whose layers grew in this round's battle, as absolute counts (the battle's live copy, ≤ BOND_LAYER_CAP).
   */
  function layerMap() {
    const out = {};
    for (const e of entries.values()) {
      if (!e.live) continue;
      for (const [pid, m] of Object.entries(e.live)) out[pid] = { ...(out[pid] || {}), ...m };
    }
    return out;
  }

  /**
   * The 联防 field on screen (never an older round's kept entry, nor while a new battle is being prepared): each
   * leaker's enemies still standing { [playerId]: n } (absent = none left), else null.
   */
  function uniteLeftMap() {
    const e = cur;
    return !loading && e && e.kind === 'unite' && e.left ? { ...e.left } : null;
  }

  function state() {
    const e = cur;
    if (!e) return loading ? { loading: true, battleId: loading.battleId, fieldId: loading.fieldId, kind: loading.kind, leaks: leakMap(), uniteLeft: uniteLeftMap(), bondLayers: layerMap() } : null;
    return {
      battleId: e.battleId, fieldId: e.fieldId, kind: e.kind, authoritative: e.authoritative, watch: e.watch,
      done: e.done, own: e.own, members: e.members.slice(), loading: !!loading, speed: e.speed, paused: pausedAt != null,
      leaks: leakMap(), uniteLeft: uniteLeftMap(), bondLayers: layerMap(),
    };
  }

  function publishState() {
    leaksDirty = false;
    const s = state();
    try { store.patch('match', { battle: s }); } catch { /* store without a match slice */ }
    emit('state', s);
  }

  /**
   * Re-count an entry's leaks when its battle recorded a new one (Battle.leakedCount) or ended (timeout leaks, and the
   * final result): the settle rule's count, leaked entries with counted !== false (/sim/spec.js battleProgress).
   * 联防: each leaker's enemies still standing (/sim/spec.js uniteLeft) whenever a kill, a leak, a spawn or the end
   * changed them.
   */
  function noteLeaks(e) {
    noteLayers(e);
    if (e.kind === 'unite') { noteUniteLeft(e); return; }
    if (e.kind !== 'normal') return;
    const b = e.battle;
    const mark = `${Number(b.leakedCount) || 0}:${b.finished ? 1 : 0}`;
    if (mark === e.leakMark) return;
    e.leakMark = mark;
    let n = e.leaks;
    try { n = Math.max(0, Math.trunc(Number(e.sim.spec.battleProgress(b).leaks) || 0)); } catch { /* keep the last count */ }
    if (n !== e.leaks) { e.leaks = n; leaksDirty = true; }
  }

  function noteUniteLeft(e) {
    const b = e.battle;
    const mark = `${Number(b.killed) || 0}:${Number(b.leakedCount) || 0}:${Number(b.total) || 0}:${b.finished ? 1 : 0}`;
    if (mark === e.leakMark) return;
    e.leakMark = mark;
    let left = e.left;
    try { left = e.sim.spec.uniteLeft(b) || left; } catch { /* keep the last count */ }
    if (JSON.stringify(left) !== JSON.stringify(e.left)) { e.left = left; leaksDirty = true; }
  }

  /**
   * Re-read an entry's live bond layers (DESIGN §20.15): per player of its spec, the bonds whose layers in the battle's
   * live copy (Battle.addLayers, clamped at BOND_LAYER_CAP like the client's AddBondCount) exceed the spec's start
   * count. Nothing to do when the battle disables gains (联防, boss rounds).
   */
  function noteLayers(e) {
    const b = e.battle;
    if (!b || (b.flags && b.flags.layerGainsEnabled === false) || typeof b.getPlayer !== 'function') return;
    let sum = 0;
    let live = null;
    for (const sp of Array.isArray(e.spec.players) ? e.spec.players : []) {
      const ps = sp && sp.playerId != null ? b.getPlayer(sp.playerId) : null;
      if (!ps || !ps.bonds || typeof ps.bonds !== 'object') continue;
      const start = sp.bonds && typeof sp.bonds === 'object' ? sp.bonds : {};
      for (const id of Object.keys(ps.bonds)) {
        const n = Number(ps.bonds[id] && ps.bonds[id].layers) || 0;
        const from = Number(start[id] && start[id].layers) || 0;
        if (!(n > from)) continue;
        sum += n - from;
        if (!live) live = {};
        if (!live[sp.playerId]) live[sp.playerId] = {};
        live[sp.playerId][id] = n;
      }
    }
    if (sum === e.layerSum) return;
    e.layerSum = sum;
    e.live = live;
    leaksDirty = true;
  }

  /** Publish the state when a leak count (or a battle's bond layers) changed since the last publish. */
  function flushLeaks() { if (leaksDirty) publishState(); }

  /** Target tick of an entry on its clock. */
  const targetTick = (e, t) => Math.max(0, Math.floor((((t - e.t0) / 1000) * e.speed) / TICK + 1e-9));

  /**
   * Step up to `n` ticks → the ticks stepped. `sliced` (a catch-up frame, a hidden-tab step): every EV_SLICE ticks the
   * events drained so far go to `e.slices` as { gt, ev } with that game time, for emitFrame / hold. `budget` (the batch's
   * soft budget { deadline, remaining }; null: a share, never cut) is checked before each tick.
   */
  function stepEntry(e, n, sliced, budget = null) {
    const b = e.battle;
    const t = now();
    let k = 0;
    try {
      for (; k < n && !b.finished; k++) {
        if (budget) {
          if (budget.remaining <= 0 || now() >= budget.deadline) break;
          budget.remaining--;
        }
        b.step();
        if (sliced && (k + 1) % EV_SLICE === 0 && k + 1 < n) {
          const ev = b.drainEvents() || [];
          if (ev.length) e.slices.push({ gt: Number(b.time) || 0, ev });
        }
      }
    } catch (err) {
      stats.errors++;
      console.warn('[runner] battle step failed', err);
      try { b.forceEnd('timeout'); } catch { /* ignore */ }
    }
    stats.ticks += k;
    stats.stepMs += now() - t;
    return k;
  }

  function frameOf(e) {
    const snap = e.battle.snapshot();
    const { t: gt, ...rest } = snap || {};
    return { ...rest, t: 'b.snap', fieldId: e.fieldId, gt: Number.isFinite(gt) ? gt : 0 };
  }

  /** The steps' events, each batch with its own game time: the sliced ones (stepEntry), then the rest at `gt`. */
  function drainSlices(e, gt) {
    let ev = [];
    try { ev = e.battle.drainEvents() || []; } catch { ev = []; }
    const out = e.slices;
    e.slices = [];
    if (ev.length) out.push({ gt, ev });
    return out;
  }

  function emitFrame(e, catchingUp) {
    // the hidden-tab backlog overflowed: the view starts again from the field meta (UnitInfo carries every unit's form)
    if (e.stale) { show(e); return; }
    const gt = Number(e.battle.time) || 0;
    // the hidden-tab backlog first, batched by the game time each tuple was drained at (a tuple put there by hand: now)
    const held = e.held;
    if (held.length) e.held = [];
    let run = null;
    for (const x of held) {
      const at = heldAt.get(x) ?? gt;
      if (!run || run.gt !== at) { if (run) emit('ev', run); run = { t: 'b.ev', fieldId: e.fieldId, gt: at, ev: [], handOver: true }; }
      run.ev.push(handOver(x));
    }
    if (run) emit('ev', run);
    for (const s of drainSlices(e, gt)) {
      if (!catchingUp) { if (s.ev.length) emit('ev', { t: 'b.ev', fieldId: e.fieldId, gt: s.gt, ev: s.ev }); continue; }
      const list = s.ev.filter(keepsState).map(handOver);
      if (list.length) emit('ev', { t: 'b.ev', fieldId: e.fieldId, gt: s.gt, ev: list, handOver: true });
    }
    try { emit('snap', frameOf(e)); } catch (err) { console.warn('[runner] snapshot failed', err); }
  }

  /**
   * Events of a step that is not rendered (hidden tab): the battle on screen keeps its state-bearing ones for the next
   * rendered frame (keepsState, ≤ HELD_MAX — beyond that it is re-entered from the field meta); any other battle starts
   * from its field meta when shown (show()), so its events go.
   */
  function hold(e) {
    const batches = drainSlices(e, Number(e.battle.time) || 0);
    if (e !== cur || e.stale) return;
    // (a skill START is not kept: one that still runs comes back with the snapshot's SKILL flag — replayed, it would
    // flash its activation and play its voice long after it began; its END is)
    for (const s of batches) for (const x of s.ev) if (keepsState(x) && !(x[0] === 'skill' && x[2])) { e.held.push(x); heldAt.set(x, s.gt); }
    if (e.held.length > HELD_MAX) {
      e.held = compactHeld(e.held);
      if (e.held.length > HELD_MAX) { e.held = []; e.stale = true; }
    }
  }

  /**
   * The tab is visible again: the battle on screen that ended while it was hidden (advance() no longer runs for it)
   * delivers its backlog and last snapshot now — else the view kept the pre-hide state for the rest of the phase.
   */
  function flushHidden() {
    const e = cur;
    if (e && e.battle.finished && (e.held.length || e.stale)) emitFrame(e, false);
  }

  /** An authoritative battle reports its progress ~1 Hz (boss fields 4 Hz) until its result is out. */
  function progress(e) {
    if (!e.authoritative || e.resultSent || !net) return;
    const t = now();
    const every = bossLike(e) ? 250 : 1000;
    if (t - e.lastProgressAt < every) return;
    e.lastProgressAt = t;
    report(e);
  }

  /**
   * Send the battle's b.progress; in account mode with the part of its replay log the server's copy lacks (see the
   * header): one report per REPORT_INPUTS inputs, the last one claiming the current tick, each counted once it went out.
   * → false when a report could not go out (offline: the next session's new segment carries the whole log again).
   */
  function report(e) {
    const p = e.sim.spec.battleProgress(e.battle);
    const msg = { battleId: e.battleId, gt: Math.min(1e5, p.gt), killed: Math.min(p.killed, p.total), total: Math.min(1e5, p.total), done: !!p.done };
    if (bossLike(e)) {
      const pool = e.battle.sharedBoss;
      msg.leaks = Math.min(1e6, e.meter.lp);
      msg.bossDmg = pool && Number.isFinite(pool.cum) ? pool.cum : 0;
      if (pool && pool.byPlayer) {
        const by = {};
        for (const pid of Object.keys(pool.byPlayer).slice(0, RESULT_LIMITS.players)) by[pid] = pool.byPlayer[pid];
        msg.by = by;
      }
    } else {
      msg.leaks = Math.min(1e6, p.leaks);
      // 联防: the leakers' enemies still standing (shared/protocol.js b.progress `left`, ≤ RESULT_LIMITS.players keys —
      // one per leaker of the field, so never cut in a room of up to MAX_SEATS players)
      if (p.left) msg.left = Object.fromEntries(Object.entries(p.left).slice(0, RESULT_LIMITS.players));
    }
    if (!net.accountMode) return net.send('b.progress', msg);
    if (!e.segment || e.segment.session !== session) e.segment = { id: crypto.randomUUID(), session, seq: 0, sent: 0 };
    const seg = e.segment;
    do {
      const inputs = e.inputs.slice(seg.sent, seg.sent + REPORT_INPUTS);
      const all = seg.sent + inputs.length === e.inputs.length;
      const tick = all ? e.battle.tickCount : inputs[inputs.length - 1].tick;
      if (!net.send('b.progress', { ...msg, replay: { segment: seg.id, seq: seg.seq, tick, inputs } })) return false;
      seg.seq++;
      seg.sent += inputs.length;
    } while (seg.sent < e.inputs.length);
    return true;
  }

  function finished(e) {
    if (e.done) return;
    e.done = true;
    noteLeaks(e);
    if (e.authoritative && !e.resultSent && net) {
      e.resultSent = true;
      let result = null;
      try {
        result = e.sim.spec.compactResult(e.battle.result());
        // an oversized frame would close the socket at the very end of the battle (64 KB inbound limit)
        if (typeof e.sim.spec.fitResult === 'function') result = e.sim.spec.fitResult(result, { bossLike: bossLike(e), battleId: e.battleId });
      } catch (err) { console.warn('[runner] result failed', err); }
      if (result) {
        e.result = result;
        deliver(e);
      }
    }
    if (e === cur) publishState();
    else flushLeaks();
    // the player's own battle is over (see 'ownDone' in the header): once per entry — a handover re-runs finished()
    if (e.own && !e.watch && !e.ownDoneSent) {
      e.ownDoneSent = true;
      emit('ownDone', { battleId: e.battleId, fieldId: e.fieldId, late: !!e.lateEnd });
    }
  }

  /**
   * Send an entry's b.result right behind its final b.progress (the rest of its replay log), on the same session: a
   * result request queued while offline would reach the server ahead of the replay log the next session sends again.
   * Retried once on a timeout. `e.delivery`: 'pending' while a request is out, 'delivered' once the server answered
   * (ok, or a refusal — final), 'undelivered' when it could not go out or never got there (LOST_RESULT_CODES): kept for
   * redeliver() (the next session) and for an authoritative b.start of the finished battle. A battle the server ended
   * before it stepped here (`noReplay`, applyEnd) sends its result alone.
   */
  function deliver(e, retries = 1) {
    if (!e.result || e.delivery === 'pending') return;
    if (!e.noReplay && !report(e)) {
      e.delivery = 'undelivered';
      console.warn('[runner] b.result not sent (offline) — sent on the next session');
      return;
    }
    e.delivery = 'pending';
    net.request('b.result', { battleId: e.battleId, result: e.result }, { timeout: 15000 }).then(() => {
      e.delivery = 'delivered';
    }, (err) => {
      const code = err && err.code;
      if (!LOST_RESULT_CODES.includes(code)) {
        e.delivery = 'delivered';
        console.warn('[runner] b.result refused', code);
        return;
      }
      e.delivery = 'undelivered';
      if (code === 'TIMEOUT' && retries > 0) deliver(e, retries - 1);
      else console.warn(`[runner] b.result not delivered (${code}) — sent again on the next session`);
    });
  }

  /** A new session: every result that could not go out or was lost with the old socket goes out again. */
  function redeliver() {
    for (const e of entries.values()) if (e.delivery === 'undelivered') deliver(e);
  }

  /** Solo pause (m.public.paused): freeze / resume every local battle clock. */
  function setPaused(on) {
    if (on === (pausedAt != null)) return;
    if (on) {
      pausedAt = now();
    } else {
      const d = Math.max(0, now() - pausedAt);
      pausedAt = null;
      for (const e of entries.values()) { e.t0 += d; e.lastProgressAt += d; }
      // Entries constructed while paused used the frozen clock; unloaded engines have no clock to shift yet.
      for (const task of preparing.values()) if (task.entry) { task.entry.t0 += d; task.entry.lastProgressAt += d; }
    }
    publishState();
    schedule();
  }

  function running(e) { return !e.battle.finished && (e === cur || (e.authoritative && !e.resultSent)); }

  /**
   * A preparation is shown (committed) once it is within a frame's cap of its clock — or of the clock its last batch
   * stepped it toward (`caught`): a hidden-tab pump of slow ticks ends further behind than that, as a running battle does.
   */
  function preparationReady(task) {
    const e = task.entry;
    return e && (task.caught || e.battle.finished || targetTick(e, clock()) - e.battle.tickCount <= ticksPerFrameCap(e.speed));
  }

  function settlePreparation(task) {
    const resolve = task.resume;
    task.resume = null; // completion, cancellation and repeated b.end all settle this waiter only once
    resolve?.();
  }

  /**
   * A running battle's step in this batch (null: on its clock): `n` ticks toward its clock — ≤ ticksPerFrameCap, or, when
   * it is more than four frames behind, a fast-forward of ≤ CATCHUP_TICKS per frame / PREPARE_SLICE per hidden-tab pump —
   * of which `share` the soft budget never cuts, its real-time share: ≤ ticksPerFrameCap per frame (a frame steps a
   * running field at most cap·c beyond the budget), ≤ CATCHUP_TICKS per hidden-tab pump (as before the budget: at ~1 Hz
   * an authority keeps its clock up to ~16 ms per tick).
   */
  function entryWork(e, t, fg) {
    const behind = targetTick(e, t) - (e.battle.tickCount || 0);
    if (behind <= 0) return null;
    const cap = ticksPerFrameCap(e.speed);
    const catchingUp = behind > cap * 4;
    if (catchingUp) stats.catchups++;
    const n = Math.min(behind, !catchingUp ? cap : fg ? CATCHUP_TICKS : PREPARE_SLICE);
    return { n, share: Math.min(n, fg ? cap : CATCHUP_TICKS), catchingUp };
  }

  /**
   * A preparation's step in this batch (null: nothing to step): ≤ PREPARE_SLICE ticks toward its clock, of which `share`
   * the soft budget never cuts — its floor, PREPARE_FLOOR times what its target grew since its last batch (≤
   * CATCHUP_TICKS: it converges whatever the frame rate, the tick cost and the other work), and in a hidden-tab pump for
   * an authority (a handover / reconnect b.start while hidden) the share a running authority gets there.
   */
  function preparationWork(task, t, fg) {
    const e = task.entry;
    const target = targetTick(e, t);
    const growth = Math.max(0, target - task.target);
    task.target = target;
    const behind = target - e.battle.tickCount;
    if (behind <= 0) return null;
    const floor = Math.min(CATCHUP_TICKS, Math.ceil(PREPARE_FLOOR * growth));
    const share = Math.min(behind, Math.max(floor, e.authoritative && !fg ? CATCHUP_TICKS : 0));
    return { n: Math.max(share, Math.min(behind, PREPARE_SLICE)), share };
  }

  /**
   * One batch — an animation frame (`fg`) or a hidden-tab pump — over the running battles (on a hidden tab only the
   * authoritative ones) and the preparations. Each first steps its share (entryWork / preparationWork), whatever the
   * budget; the rest — catch-up beyond real time, preparation — then shares one soft budget (FRAME_WORK_MS, LOADING_WORK_MS
   * while no field on screen plays at its pace, HIDDEN_WORK_MS; started after the shares) and PREPARE_SLICE ticks in all:
   * authoritative battles first (the server waits for them), each class from the battle after the last one that used the
   * budget. Then each battle renders / holds and reports what it did.
   */
  function runBatch(fg) {
    if (pausedAt != null) return;
    const t = clock();
    let work = [];
    for (const e of entries.values()) if (running(e) && (fg || e.authoritative)) work.push({ e, task: null });
    for (const task of preparing.values()) if (task.entry && task.resume) work.push({ e: task.entry, task });
    const from = work.findIndex((w) => w.e.battleId === workAfter) + 1;
    work = [...work.slice(from), ...work.slice(0, from)];
    work = [...work.filter((w) => w.e.authoritative), ...work.filter((w) => !w.e.authoritative)];
    const step = (w, n, budget) => {
      const at = now();
      w.ticks += stepEntry(w.e, n, !w.task && (w.plan.catchingUp || !w.shown), budget);
      w.ms += now() - at;
    };
    let shared = 0;
    let live = false; // a field plays on screen at its pace (else: only the loading view, a finished field, a fast-forward)
    for (const w of work) {
      w.plan = w.task ? preparationWork(w.task, t, fg) : entryWork(w.e, t, fg);
      w.shown = fg && !w.task && w.e === cur;
      w.ticks = 0;
      w.ms = 0;
      if (w.shown) live = !w.plan || !w.plan.catchingUp;
      if (w.plan) step(w, w.plan.share, null);
      shared += w.ticks;
    }
    const budget = { deadline: now() + (!fg ? HIDDEN_WORK_MS : live ? FRAME_WORK_MS : LOADING_WORK_MS),
      remaining: Math.max(0, PREPARE_SLICE - shared) };
    for (const w of work) {
      if (budget.remaining <= 0 || now() >= budget.deadline) break;
      if (!w.plan || w.ticks >= w.plan.n || w.e.battle.finished) continue;
      const before = budget.remaining;
      step(w, w.plan.n - w.ticks, budget);
      if (budget.remaining < before) workAfter = w.e.battleId;
    }
    for (const w of work) {
      const { e, task } = w;
      // a synchronous listener (of a frame, a report, the state) can clear the runner or switch the field meanwhile
      if (!w.plan || (task ? !validPreparation(task) || task.entry !== e : entries.get(e.battleId) !== e)) continue;
      if (task) {
        stats.prepareMs += w.ms;
        stats.maxPrepareMs = Math.max(stats.maxPrepareMs, w.ms);
        try { e.battle.drainEvents(); } catch { /* the field is first shown after preparation */ }
        noteLeaks(e);
        // (nothing before its first tick: an end that comes first sends the result alone, applyEnd)
        if (e.authoritative && e.battle.tickCount) progress(e);
        if (targetTick(e, t) - e.battle.tickCount <= ticksPerFrameCap(e.speed)) task.caught = true;
        continue;
      }
      if (w.shown && e === cur) emitFrame(e, w.plan.catchingUp);
      else hold(e);
      noteLeaks(e);
      progress(e);
      if (e.battle.finished) finished(e);
    }
    flushLeaks();
  }

  function frame() {
    rafH = null;
    stats.frames++;
    const started = now();
    runBatch(true);
    schedule();
    stats.maxFrameMs = Math.max(stats.maxFrameMs, now() - started);
  }

  function pump() {
    // hidden tab: no animation frames — the authoritative battles and the preparations (a display replica's ends with it);
    // likewise a visible page whose requested frame is FRAME_STALL_MS late
    if (!hidden() && !(rafH != null && now() - rafAt >= FRAME_STALL_MS)) return;
    const started = now();
    runBatch(false);
    schedule();
    stats.maxPumpMs = Math.max(stats.maxPumpMs, now() - started);
  }

  function schedule() {
    // A forced end / already-caught-up preparation can commit even while paused or after the budget was exhausted.
    for (const task of preparing.values()) if (task.resume && preparationReady(task)) settlePreparation(task);
    const hasPreparation = [...preparing.values()].some(task => task.entry && task.resume);
    // paused: nothing to step (the view keeps its last frame); resume reschedules
    const any = pausedAt == null && (hasPreparation || [...entries.values()].some(running));
    if (any && rafH == null && !hidden()) { rafH = raf(frame); rafAt = now(); }
    else if (!any && rafH != null) { caf(rafH); rafH = null; }
    const needPump = pausedAt == null && (hasPreparation || [...entries.values()].some((e) => e.authoritative && running(e)));
    if (needPump && ivH == null) ivH = setIv(pump, 250);
    else if (!needPump && ivH != null) { clearIv(ivH); ivH = null; }
  }

  /** Put an entry on screen: field meta into the store (the game screen enters it), then its current frame. */
  function show(e) {
    cur = e;
    e.held = [];
    e.slices = [];
    e.stale = false;
    let meta = null;
    try { meta = e.battle.fieldMeta(); } catch { meta = { units: [] }; }
    const field = {
      t: 'm.field', ...meta, fieldId: e.fieldId, kind: e.kind, rect: meta.rect ?? e.spec.rect, stageId: meta.stageId ?? e.spec.stageId,
      live: !e.done, battleId: e.battleId, players: e.members.slice(), local: true, speed: e.speed,
      // the watched player's effects column (user playtest #2; undefined for 联防 / boss pairs and server-run fields)
      effects: spectateEffects(e.spec, e.members),
      // which half each player holds (联防: the first helper takes the right half; boss pairs: L / R)
      sides: Object.fromEntries((e.spec.players || []).filter((p) => p && p.playerId).map((p) => [p.playerId, p.side === 'R' || Number(p.colOffset) >= 8 ? 'R' : 'L'])),
    };
    emit('field', field);
    try { store.patch('match', { field }); } catch { /* ignore */ }
    publishState();
    try { e.battle.drainEvents(); } catch { /* the view starts from the meta + this frame */ }
    emit('snap', frameOf(e));
    schedule();
  }

  function evict() {
    let players;
    try { players = store?.get?.()?.match?.public?.players?.length; } catch { /* a store without a match slice */ }
    const max = runnerCacheMax(players);
    if (entries.size <= max) return;
    for (const [id, e] of entries) {
      if (entries.size <= max) break;
      if (e === cur || (e.authoritative && !e.resultSent) || e.own || e.delivery === 'pending' || e.delivery === 'undelivered') continue;
      entries.delete(id);
    }
  }

  const validPreparation = (task) => !disposed && task.lifecycle === lifecycle && preparing.get(task.msg.battleId) === task;

  function dropPreparation(task) {
    if (preparing.get(task.msg.battleId) === task) preparing.delete(task.msg.battleId);
    settlePreparation(task);
    task.controls.length = 0;
    task.entry?.meter.detach?.();
    task.entry = null;
  }

  function updateStart(e, msg, pending = false) {
    const was = e.authoritative;
    e.authoritative = !!msg.authoritative && !e.resultSent;
    e.watch = !!msg.watch;
    if (msg.authoritative && e.resultSent) deliver(e);
    if (pending) {
      // Resends share the pending Battle but still carry a newer target clock, even without authority promotion.
      e.speed = Number(msg.speed) > 0 ? Number(msg.speed) : 2;
      e.t0 = clock() - ((Number(msg.elapsed) || 0) / e.speed) * 1000;
    }
    if (e.authoritative && !was) {
      const speed = Number(msg.speed) > 0 ? Number(msg.speed) : 2;
      e.t0 = clock() - ((Number(msg.elapsed) || 0) / speed) * 1000;
      e.lastProgressAt = -Infinity;
      e.segment = null;
      if (e.battle.finished) { e.done = false; finished(e); }
    }
  }

  function selectStart() {
    ++startSeq;
    // Only the watched replica becomes obsolete. A still-authoritative own field must keep running off screen, and a
    // battle the server already ended is still built and kept (switching back shows its end; upstream R21G).
    for (const task of preparing.values()) if (!task.authoritative && !task.ended && task.seq !== startSeq) dropPreparation(task);
  }

  async function onStart(msg) {
    if (disposed || !msg || typeof msg !== 'object' || !msg.spec || typeof msg.battleId !== 'string') return;
    const speed = Number(msg.speed) > 0 ? Number(msg.speed) : 2;
    const existing = entries.get(msg.battleId);
    if (existing) {
      updateStart(existing, msg);
      selectStart();
      loading = null;
      // a resend of what is already on screen (reconnect / resync) only updates the state; switching back shows it
      if (cur !== existing) show(existing);
      else { publishState(); schedule(); }
      return;
    }
    const pending = preparing.get(msg.battleId);
    if (pending) {
      // Reconnect / resync of a battle still loading or catching up: update it, never construct a second copy.
      pending.authoritative = !!msg.authoritative;
      pending.seq = startSeq + 1;
      if (pending.entry) {
        updateStart(pending.entry, msg, true);
        // a new clock, not growth: no floor for the jump, and caught up only with this one
        pending.target = targetTick(pending.entry, clock());
        pending.caught = false;
      } else pending.controls.push({ kind: 'start', msg });
      selectStart();
      loading = { battleId: msg.battleId, fieldId: msg.fieldId, kind: msg.kind };
      publishState();
      return pending.promise;
    }
    selectStart();
    // target: the entry's target tick at its last batch (runBatch: the floor follows its growth); caught: that batch
    // brought it within a frame's cap of it (preparationReady); ended: a forced / timeout b.end came for it (selectStart)
    const task = { msg, seq: startSeq, lifecycle, authoritative: !!msg.authoritative, ended: false, entry: null,
      controls: [], pool: lastPool, resume: null, promise: null, target: 0, caught: false };
    preparing.set(msg.battleId, task);
    loading = { battleId: msg.battleId, fieldId: msg.fieldId, kind: msg.kind };
    publishState();
    task.promise = prepare(task, speed);
    return task.promise;
  }

  async function prepare(task, speed) {
    const msg = task.msg;
    try {
      let sim;
      try { sim = await simFor(msg.rulesVersion); } catch (err) {
        if (!validPreparation(task)) return;
        console.warn('[runner] simulation unavailable', err);
        if (task.seq === startSeq) { loading = null; publishState(); }
        return;
      }
      if (!validPreparation(task)) return;
      let battle;
      try {
        battle = sim.spec.createBattleFromSpec(msg.spec, sim.ds, { logger });
      } catch (err) {
        console.warn('[runner] battle construction failed', err);
        if (task.seq === startSeq) { loading = null; publishState(); }
        return;
      }
      stats.battles++;
      const e = {
        battleId: msg.battleId, fieldId: msg.fieldId || msg.spec.fieldId, kind: msg.kind || msg.spec.kind, spec: msg.spec, sim, battle,
        authoritative: !!msg.authoritative, watch: !!msg.watch, own: !msg.watch, speed,
        members: (msg.spec.players || []).map((p) => p && p.playerId).filter(Boolean),
        t0: clock() - ((Number(msg.elapsed) || 0) / speed) * 1000, lastProgressAt: -Infinity, done: false, resultSent: false,
        result: null, delivery: null,
        // the replay log (tick inputs: b.pool syncs, the b.end) and its report segment { id, session, seq: the next one,
        // sent: the inputs it carried } (null: the next report starts one)
        inputs: [], segment: null,
        meter: sim.spec.attachLpMeter(battle),
        // counted leaks so far (normal fields; noteLeaks) and the Battle state they were counted at; 联防 fields: each
        // leaker's enemies still standing (noteUniteLeft)
        leaks: 0, leakMark: '', left: null,
        // live bond layers grown in this battle { [playerId]: { [bondId]: n } } and their total gain (noteLayers)
        live: null, layerSum: 0,
        // state-bearing events of the steps run while the tab was hidden (hold(); delivered by the next rendered frame;
        // heldAt = the game time each was drained at), and whether that backlog overflowed (the next frame re-enters the
        // view from the field meta); the event batches of the current sliced step (stepEntry)
        held: [], stale: false, slices: [],
        // the server's b.end reason (settlement() bossDown: 'cleared' = the boss pool was emptied); whether 'ownDone' went
        // out, and whether the battle was already over when it was first shown (its `late`); whether its result goes out
        // without a replay report (ended before it stepped: applyEnd)
        endReason: null, ownDoneSent: false, lateEnd: false, noReplay: false,
      };
      task.entry = e;
      if (task.pool && battle.sharedBoss) syncPool(e, task.pool);
      for (const control of task.controls) {
        if (control.kind === 'pool' && battle.sharedBoss) syncPool(e, control.msg);
        else if (control.kind === 'end') applyEnd(e, control.msg, true);
        else if (control.kind === 'start') updateStart(e, control.msg, true);
      }
      task.controls.length = 0;
      task.target = targetTick(e, clock());
      // Construction is synchronous; the catch-up steps run in the RAF / hidden-pump batches (runBatch).
      while (validPreparation(task) && !preparationReady(task)) {
        await new Promise(resolve => { task.resume = resolve; schedule(); });
      }
      if (!validPreparation(task)) return;
      entries.set(e.battleId, e);
      task.entry = null;
      evict();
      noteLeaks(e);
      // its leak count / bond layers join the published state (upstream R21G: counted while it was prepared, they were
      // published only with its next change when it is not the field shown)
      leaksDirty = true;
      if (task.seq === startSeq) { loading = null; show(e); }
      else schedule();
      // over before it was ever shown (a reload / resync after its end): finished now, but `late` for 'ownDone'
      if (battle.finished) { e.lateEnd = true; finished(e); }
      flushLeaks();
    } finally { dropPreparation(task); }
  }

  /** A b.pool into a boss battle's shared pool, logged at this tick while the battle runs (the replay re-applies it). */
  function syncPool(e, msg) {
    const acked = msg.acked ? msg.acked[e.fieldId] : undefined;
    if (!e.battle.finished) e.inputs.push({ tick: e.battle.tickCount, kind: 'pool', hp: msg.hp, acked: acked ?? null });
    e.battle.sharedBoss.sync(msg.hp, acked);
  }

  function onPool(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastPool = msg;
    for (const e of entries.values()) if (e.battle.sharedBoss) syncPool(e, msg);
    for (const task of preparing.values()) {
      if (!task.entry) task.controls.push({ kind: 'pool', msg });
      else if (task.entry.battle.sharedBoss) syncPool(task.entry, msg);
    }
    emit('pool', msg);
  }

  function onEnd(msg) {
    if (!msg) return;
    const task = preparing.get(msg.battleId);
    if (task && msg.reason === 'takeover') task.authoritative = false;
    else if (task) task.ended = true;
    if (task && !task.entry) { task.controls.push({ kind: 'end', msg }); return; }
    const e = entries.get(msg.battleId) || task?.entry;
    if (!e) return;
    applyEnd(e, msg, !!task);
  }

  function applyEnd(e, msg, pending = false) {
    if (msg.reason === 'takeover') {
      e.authoritative = false;
      if (e === cur) publishState();
      schedule();
      return;
    }
    // as the server sent it (a boss field: 'cleared' = the pool was emptied, 'forced' = the team LP ran out — Match
    // _endFinal); the local battle only knows 'timeout' / 'forced' (settlement() bossDown reads it). The first end counts
    // (upstream R21G: a later b.end of the ended battle changes nothing)
    if (e.endReason == null) e.endReason = typeof msg.reason === 'string' ? msg.reason : null;
    if (!e.battle.finished) {
      // the end reached a battle still preparing that never stepped (it came while the engine loaded): its b.result goes
      // out alone — a tick-0 replay segment would replace what the server holds with a 'complete' replay of a battle
      // never played here. The server keeps the trace it already has: an earlier page's segments when this one replaced
      // its session (a reload, 继续对局 elsewhere — an incomplete replay beside this result), else none (a missing
      // replay). It still need not wait out the result grace.
      if (pending && !e.battle.tickCount) e.noReplay = true;
      const reason = msg.reason === 'timeout' ? 'timeout' : 'forced';
      e.inputs.push({ tick: e.battle.tickCount, kind: 'end', reason });
      try { e.battle.forceEnd(reason); } catch { /* ignore */ }
    }
    if (e === cur) emitFrame(e, false);
    if (pending) e.lateEnd = true;
    finished(e);
    flushLeaks();
    schedule();
  }

  /** Drop every battle (a new round's prep, the match ended, the player left). */
  function clear() {
    ++lifecycle;
    ++startSeq;
    loading = null;
    for (const task of preparing.values()) dropPreparation(task);
    for (const e of entries.values()) {
      // never drop an unreported authoritative result (the round already moved on: the server has its own)
      if (e.authoritative && !e.resultSent && !e.battle.finished) { try { e.battle.forceEnd('forced'); } catch { /* ignore */ } }
    }
    entries.clear();
    workAfter = null;
    cur = null;
    lastPool = null;
    if (rafH != null) { caf(rafH); rafH = null; }
    if (ivH != null) { clearIv(ivH); ivH = null; }
    publishState();
  }

  const offs = [];
  if (net && typeof net.on === 'function') {
    offs.push(net.on('b.start', (m) => { onStart(m).catch((err) => console.warn('[runner] b.start failed', err)); }));
    offs.push(net.on('b.pool', onPool));
    offs.push(net.on('b.end', onEnd));
    // a new session (reconnect / resume): the server's copy of every replay log is unknown — the reports start new
    // segments — and the results that could not go out or were lost with the old socket go out again
    offs.push(net.on('welcome', () => {
      session++;
      redeliver();
    }));
  }
  // phase changes: combat fields live until the next prep; leaving the match drops everything
  let lastPhase = null;
  if (store && typeof store.subscribe === 'function') {
    offs.push(store.subscribe((s) => {
      const pub = s && s.match && s.match.public ? s.match.public : null;
      // solo pause (DESIGN §14): the local battle clocks follow m.public.paused
      setPaused(!!(pub && pub.paused));
      const phase = pub ? pub.phase : null;
      if (phase === lastPhase) return;
      lastPhase = phase;
      if (!phase || ['PREP', 'ROUND_START', 'SP_DRAFT', 'RESULT', 'LOBBY', 'INFO_CHECK', 'BAND_DRAFT', 'BATTLE_CHECK'].includes(phase)) {
        if (entries.size || preparing.size || loading) clear();
      }
      // warm the simulation up as soon as a match runs (the first b.start then starts at once)
      if (phase && phase !== 'LOBBY' && !simP) ensureSim().catch(() => {});
    }));
  }
  if (doc && typeof doc.addEventListener === 'function') {
    const visible = () => { if (hidden()) return; flushHidden(); schedule(); };
    doc.addEventListener('visibilitychange', visible);
    offs.push(() => doc.removeEventListener?.('visibilitychange', visible));
  }

  return {
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    state,
    stats() {
      return { ...stats, avgTickMs: stats.ticks ? stats.stepMs / stats.ticks : 0, entries: entries.size, loadingSim: !!simP };
    },
    /**
     * Live stats of unit `unitId` of the battle on screen (null: no such battle / unit, or `fieldId` names another
     * field). Reads the sim's last computed stats (`unit._s`, falling back to the base) — never `unit.s`, whose lazy
     * recompute would run earlier than the sim itself would run it.
     * @param {number} unitId @param {string|null} [fieldId]
     */
    unitStats(unitId, fieldId = null) {
      const e = cur;
      if (!e || !Number.isInteger(unitId) || (fieldId != null && e.fieldId !== fieldId)) return null;
      let u = null;
      try { u = typeof e.battle.unitById === 'function' ? e.battle.unitById(unitId) : null; } catch { u = null; }
      if (!u) return null;
      try { return unitStatsEntry(u, u._s || null); } catch { return null; }
    },
    /**
     * The unit id of the board piece `uid` owned by `ownerId` in the battle on screen (an own operator's card opened in
     * prep and left open into the battle turns live); null when that battle has no such unit.
     * @param {number} uid @param {string} ownerId @param {string|null} [fieldId]
     */
    unitIdOf(uid, ownerId, fieldId = null) {
      const e = cur;
      if (!e || !Number.isInteger(uid) || (fieldId != null && e.fieldId !== fieldId)) return null;
      const list = Array.isArray(e.battle.allyUnits) ? e.battle.allyUnits : [];
      const u = list.find((x) => x && x.uid === uid && x.ownerId === ownerId);
      return u && Number.isInteger(u.id) ? u.id : null;
    },
    /**
     * The operators `ownerId` fields in the battle on screen — their board in that battle, waiting to deploy, deployed
     * or knocked out (the field meta published by show() is taken before they deploy) — as UnitInfo-like
     * { kind: 'op', ownerId, defId }: a teammate's bond popup lists them as the members in play (ui/watchBonds.js
     * ownerBoard). [] when no such battle is on screen.
     * @param {string} ownerId @param {string|null} [fieldId]
     */
    ownerOps(ownerId, fieldId = null) {
      const e = cur;
      if (!e || typeof ownerId !== 'string' || !ownerId || (fieldId != null && e.fieldId !== fieldId)) return [];
      const list = Array.isArray(e.battle.allyUnits) ? e.battle.allyUnits : [];
      return list.filter((u) => u && u.kind === 'op' && u.ownerId === ownerId && typeof u.defId === 'string')
        .map((u) => {
          const o = Array.isArray(u.items) && u.items.length ? { kind: 'op', ownerId, defId: u.defId, items: [...u.items] } : { kind: 'op', ownerId, defId: u.defId };
          const si = u.def && typeof u.def.standInFor === 'string' ? u.def.standInFor : null;
          return si ? { ...o, standInFor: si } : o;
        });
    },
    /**
     * How `playerId`'s part of the finished own battle `battleId` went (see the header) — the settlement voice line is
     * picked from it (audio.js settlementVoice; screens/game.js sayResult). null: no such entry (unknown, or dropped
     * with the round), still running, a display replica of someone else's field, or the player has no part in it. Own
     * entries are never evicted, so this stays valid until the next prep drops the round's battles.
     * @param {string} battleId @param {string} playerId
     * @returns {{ perfect: boolean, leaked: number, killed: number, total: number,
     *   unitsEnd: { defId: string, alive: boolean }[], boss: boolean, bossDown: boolean|null }|null}
     */
    settlement(battleId, playerId) {
      const e = typeof battleId === 'string' ? entries.get(battleId) : null;
      if (!e || !e.done || !e.own || e.watch || typeof playerId !== 'string' || !playerId) return null;
      try {
        const res = e.battle.result();
        const pp = res && res.perPlayer ? res.perPlayer[playerId] : null;
        if (!pp || typeof pp !== 'object') return null;
        const boss = bossLike(e);
        return {
          perfect: !!pp.perfect,
          // the settle rule's count (Match.settle / /sim/spec.js battleProgress: counted !== false)
          leaked: (Array.isArray(pp.leaked) ? pp.leaked : []).filter((l) => l && l.counted !== false).length,
          killed: pp.killed ?? res.killed,
          total: pp.total ?? res.total,
          unitsEnd: (Array.isArray(pp.unitsEnd) ? pp.unitsEnd : []).filter(Boolean).map((u) => ({ defId: u.defId, alive: !!u.alive })),
          boss,
          bossDown: boss ? (e.battle.reason === 'cleared' || e.endReason === 'cleared' || (Number.isFinite(res.bossHpLeft) && res.bossHpLeft <= 0)) : null,
        };
      } catch { return null; }
    },
    /** Re-show the current battle (the game screen remounted). */
    reshow() { if (cur) show(cur); },
    /** Test / debug hooks. */
    _entries: entries,
    _frame: frame,
    _pump: pump,
    onStart, onPool, onEnd, clear, ensureSim, redeliver, setPaused,
    dispose() { disposed = true; clear(); for (const off of offs) { try { off?.(); } catch { /* ignore */ } } listeners.clear(); },
  };
}

/** The browser runner, wired to the app's socket and store (null outside a browser). */
export const battleRunner = typeof window !== 'undefined' && typeof document !== 'undefined'
  ? createBattleRunner({ net: appNet, store: appStore })
  : null;
if (battleRunner) globalThis.__SP_RUNNER__ = battleRunner; // dev / E2E introspection
