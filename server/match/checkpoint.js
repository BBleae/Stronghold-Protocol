import { Match, DEADLINE_REHEARSAL_TICKS } from './Match.js';
import { VirtualScheduler } from './scheduler.js';
import { appendReplayReport, recordServerBattle, recordServerSpec } from './recorder.js';

import { RULES_VERSION } from '../../shared/rules-version.js';
export { RULES_VERSION };
// Every input that changes the match is logged, so a restore (and a replay) re-applies it. The inputs a match takes at
// its start are recorded options (OPTION_KEYS): `seats` carries each human's loadout, its 补位 not-owned list
// (seats[].notOwned) and its 自选编队 picks (seats[].diy) — fixed for the match (0.2.0, server/match/Match.js header), so
// a restore deals every player's shop, stand-ins and 自选 stock from the same seats. Later inputs are the methods below
// (setLoadout: INFO_CHECK only). Spectator seats (opts.spectators / addSpectator) change no match state and are not
// recorded (the Worker keeps its own spectators, worker/rooms/spectators.js).
const METHODS = new Set(['start', 'handle', 'onDisconnect', 'onReconnect', 'onLeave', 'setLoadout']);
const copy = (value) => JSON.parse(JSON.stringify(value));
// Work units, not wall-clock milliseconds: live execution and recovery must split at identical points. A match records
// the values it started with (options.workSlice), so a restore keeps them when these defaults change. prepBurst: the AI
// prep slices one event's allowance covers while a connected human waits on the AI seats alone (Match._prepUrgent) —
// late in an 8-seat match most of them are 128-tick rehearsal slices (p50 ~2 ms, up to ~8 ms at R12 on a desktop);
// an arrangement (10–20 ms) takes an allowance of its own (deferWork 'prepArrange'). 5 keeps those events within
// ~30 ms, and the events of a wait few enough that, at ~5 ms of commit per event, the last human's wait is no longer
// than before the slicing. simulationTicks: a headless normal / 联防 battle slice — 128 like the boss pacer's (a
// 512-tick 联防 slice took up to ~97 ms late in an 8-bot match). deadlineRehearsalTicks: the rehearsal ticks the prep
// deadline runs for the AI-played seats it finishes, all together (Match._finishBotPrep, DEADLINE_REHEARSAL_TICKS); a
// match recorded without it restores with this default.
const WORK_SLICE = Object.freeze({ prepSteps: 1, prepSimulationTicks: 128, prepIntervalMs: 25, prepBurst: 5, simulationTicks: 128,
  deadlineRehearsalTicks: DEADLINE_REHEARSAL_TICKS });
// The longest match log restoreMatch replays (CHECKPOINT_EVENT_LIMIT); worker/index.js warns while a running match's log
// nears it.
export const CHECKPOINT_EVENT_LIMIT = 200000;
const OPTION_KEYS = [
  'roomCode',
  'mode',
  'difficulty',
  'modeId',
  'seats',
  'seed',
  'matchNo',
  'timerScale',
  'combatSpeed',
  'botRehearsal',
  'clientCombat',
  'verify',
  'battleContent',
  'workSlice',
];

/** A manually pumped clock makes timer ordering reproducible, including callbacks with closures.
 * Checkpoints store the complete input/timer log; never treat render snapshots as executable state.
 */
export class RecordedMatch extends Match {
  constructor(options) {
    options = { ...options, workSlice: { ...WORK_SLICE, ...options.workSlice } };
    const startedAt = options._startAt ?? (options.now || Date.now)();
    const scheduler = new VirtualScheduler({ start: startedAt, instantCombat: false });
    const output = { muted: !!options._restoring };
    const work = { frame: null, remaining: null, burst: 0, nextPrepAt: 0, prepIntervalMs: 0, prepBurst: 1, prepReserveMs: 0 };
    super({
      ...options,
      scheduler,
      // Each timer records its admission allowance and pump horizon. Once used, expensive work waits past that
      // horizon (Match.laterWork's queue), while ordinary due timers (especially phase deadlines) still run before the
      // player's input.
      deferWork: (kind, deadline, urgent = false) => {
        const frame = work.frame;
        if (!frame) return 0;
        const prep = kind === 'prep' || kind === 'prepArrange';
        // Pace the whole room's AI work from the recorded event horizon, not an overdue timer's timestamp. A human
        // waiting on the AI seats alone (urgent) or the final reserve before the prep deadline removes the voluntary
        // gap; the fixed slice and event cap still apply.
        const now = Math.max(scheduler.now(), frame.until);
        const pacedPrep = prep && !urgent && !(deadline > 0 && deadline - now <= work.prepReserveMs);
        if (pacedPrep && work.nextPrepAt > now) return work.nextPrepAt - scheduler.now();
        // An urgent prep slice is a share of the event's allowance: up to prepBurst of them, and nothing else, per
        // event. An arrangement step (prepArrange, 10–20 ms late in a match) is never one of them: it takes a whole
        // allowance and leaves no share, so it never adds to other slices in one event.
        const share = prep && urgent && kind !== 'prepArrange';
        if (share && frame.burst > 0) {
          frame.burst--;
          return 0;
        }
        if (frame.remaining > 0) {
          frame.remaining--;
          frame.burst = share ? work.prepBurst - 1 : 0;
          if (prep) work.nextPrepAt = now + work.prepIntervalMs;
          return 0;
        }
        return Math.max(1, frame.until - scheduler.now() + 1);
      },
      send: (...args) => {
        return output.muted ? true : options.send(...args);
      },
      broadcast: (...args) => {
        if (!output.muted) options.broadcast(...args);
      },
      onEnd: (...args) => {
        if (!output.muted) options.onEnd(...args);
      },
    });
    work.prepIntervalMs = this.scaled(Number.isFinite(options.workSlice.prepIntervalMs)
      && options.workSlice.prepIntervalMs >= 0 ? options.workSlice.prepIntervalMs : WORK_SLICE.prepIntervalMs);
    work.prepBurst = Number.isSafeInteger(options.workSlice.prepBurst) && options.workSlice.prepBurst >= 1
      ? options.workSlice.prepBurst : WORK_SLICE.prepBurst;
    work.prepReserveMs = this.scaled(5000);
    this.recording = {
      schemaVersion: 1,
      rulesVersion: RULES_VERSION,
      startedAt,
      options: copy(
        Object.fromEntries(OPTION_KEYS.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])),
      ),
      events: [],
    };
    this._wallNow = options.now || Date.now;
    this._work = work;
    this._recordDepth = 0;
    this._recordOutput = output;
    this._restored = false;
    this.departures = {};
    this.usedOperators = {};
    this.replayBattles = [];
    this.recordServerReplay = true;
    this.serverTraces = new WeakMap();
    this.observeReplayFrame = options.observeReplayFrame;
  }
  _input(kind, args) {
    if (this._recordDepth) return Match.prototype[kind].apply(this, args);
    const at = Math.max(this.sched.now(), this._wallNow());
    return this._apply({ kind, at, args: copy(args) });
  }
  _apply(event) {
    if (!Number.isFinite(event.at) || event.at < this.sched.now()) throw new Error('CHECKPOINT_EVENT_TIME');
    if (event.work != null && (event.kind !== 'timer' || !Number.isSafeInteger(event.work.remaining)
      || event.work.remaining < 0 || !Number.isFinite(event.work.until) || event.work.until < event.at
      || (event.work.burst != null && !(Number.isSafeInteger(event.work.burst) && event.work.burst > 0))))
      throw new Error('CHECKPOINT_WORK');
    const previousWork = this._work.frame;
    this._work.frame = event.work ? { ...event.work } : null;
    this.recording.events.push(copy(event));
    this._recordDepth++;
    if (event.kind === 'onLeave') {
      const ps = this.players.get(event.args[0]);
      if (ps && !this.departures[ps.playerId])
        this.departures[ps.playerId] = { stats: copy(ps.stats), round: this.round };
    }
    try {
      if (event.kind === 'timer') {
        this.sched.nextAt();
        const next = this.sched._q[0];
        if (!next || next.id !== event.id || Math.max(this.sched.now(), next.at) !== event.at)
          throw new Error('CHECKPOINT_TIMER_DIVERGED');
        this.sched.runNext();
      } else {
        if (!METHODS.has(event.kind) || !Array.isArray(event.args)) throw new Error('CHECKPOINT_EVENT');
        this.sched.t = event.at;
        if (event.kind === 'handle') {
          const [playerId, msg] = event.args;
          if (msg.replay && ['b.progress', 'b.result'].includes(msg.t)) {
            const field = this._fieldByBattle(msg.battleId);
            if (field && !field.done) appendReplayReport(field, playerId, msg.replay);
          }
        }
        return Match.prototype[event.kind].apply(this, event.args);
      }
    } finally {
      this._work.remaining = this._work.frame?.remaining ?? null;
      this._work.burst = this._work.frame?.burst ?? 0;
      this._work.frame = previousWork;
      this._recordDepth--;
    }
  }
  start() {
    if (this._restored) {
      this._restored = false;
      return;
    }
    return this._input('start', []);
  }
  handle(...args) {
    return this._input('handle', args);
  }
  onDisconnect(...args) {
    return this._input('onDisconnect', args);
  }
  onReconnect(...args) {
    return this._input('onReconnect', args);
  }
  onLeave(...args) {
    return this._input('onLeave', args);
  }
  setLoadout(...args) {
    return this._input('setLoadout', args);
  }
  // usedOperators: the operators each player fielded, for the account history (the Worker archives them as the player's
  // `operators`, shared/history.js). A chess counts as its base id (the elite folded into it); a 自选 piece (0.2.0: its
  // slot chess_char_5_diy1_a … fights as the pick, PlayerState.battleInput `diy`) as its operator's charId — the slot id
  // names no operator (every slot is '甄选干员'), and one operator stays one entry whichever slot fielded it.
  _ccField(options) {
    const field = super._ccField(options);
    for (const player of field.spec.players) {
      const used = new Set(this.usedOperators[player.playerId] || []);
      for (const unit of player.units || []) {
        if (unit.kind !== 'chess' || !unit.chessId) continue;
        const charId = unit.diy && typeof unit.diy.charId === 'string' && unit.diy.charId ? unit.diy.charId : null;
        used.add(charId || this.gd.baseIdOf(unit.chessId));
      }
      this.usedOperators[player.playerId] = [...used];
    }
    return field;
  }
  _specBattle(spec, options = {}) {
    const battle = super._specBattle(spec, options);
    // Frames only for a battle on a shared boss pool; any other server battle replays from its spec (recorder.js).
    this.serverTraces.set(
      battle,
      options.sharedBoss ? recordServerBattle(battle, spec, this.observeReplayFrame) : recordServerSpec(battle, spec),
    );
    return battle;
  }
  _fieldDone(field) {
    if (!field.done) this._recordField(field, field.result);
    return super._fieldDone(field);
  }
  _recordField(field, result) {
    if (field.spec && !this.replayBattles.some((b) => b.battleId === field.battleId)) {
      const server = field.battle && this.serverTraces.get(field.battle),
        client = field.replayTrace;
      const resultTick = Math.round((result?.time || 0) * 30);
      const trace =
        field.resultSource === 'client' && client
          ? {
              source: 'client',
              spec: copy(field.spec),
              inputs: copy(client.inputs),
              tick: client.tick,
              complete: client.tick === resultTick,
            }
          : server || { source: 'missing', spec: copy(field.spec), complete: false, tick: 0 };
      this.replayBattles.push({
        ...trace,
        round: this.round,
        players: field.players.slice(),
        fieldId: field.fieldId,
        battleId: field.battleId,
        result: copy(result ?? null),
        kind: field.kind,
      });
    }
  }
  _finishFinal(hidden, resultOf) {
    if (this.phase !== (hidden ? 'HIDDEN_CORE' : 'FINAL_ASSAULT')) return;
    for (const field of this.fields) this._recordField(field, resultOf(field));
    return super._finishFinal(hidden, resultOf);
  }
  // workBudget: one event's allowance, shared by its pumps — `remaining` admissions, and `burst`, the urgent prep
  // slices left of the one admission they share (deferWork). Both go into each timer's recorded work frame.
  pump(until = this._wallNow(), limit = 100, workBudget = { remaining: 1 }) {
    if (!Number.isFinite(until) || !Number.isSafeInteger(workBudget.remaining) || workBudget.remaining < 0
      || (workBudget.burst != null && !(Number.isSafeInteger(workBudget.burst) && workBudget.burst >= 0)))
      throw new Error('MATCH_WORK_BUDGET');
    let n = 0;
    while (n < limit && !this.disposed) {
      const at = this.sched.nextAt();
      if (at == null || at > until) break;
      const effectiveAt = Math.max(at, this.sched.now());
      const work = { remaining: workBudget.remaining, until: Math.max(until, effectiveAt) };
      if (workBudget.burst > 0) work.burst = workBudget.burst;
      this._apply({ kind: 'timer', at: effectiveAt, id: this.sched._q[0].id, work });
      workBudget.remaining = this._work.remaining;
      if (this._work.burst > 0 || workBudget.burst != null) workBudget.burst = this._work.burst;
      n++;
    }
    return n;
  }
  dispose() {
    super.dispose();
    this.sched.dispose();
  }
}
export function exportMatch(match, { referenceEvents = false } = {}) {
  return {
    ...(referenceEvents ? match.recording : copy(match.recording)),
    view: copy(match.publicView()),
    rng: ['Setup', 'Shop', 'Waves', 'Draft', 'Bots', 'Meta'].map((n) => match['rng' + n].state()),
  };
}
export function restoreMatch(checkpoint, deps) {
  if (checkpoint?.schemaVersion !== 1 || checkpoint.rulesVersion !== RULES_VERSION)
    throw new Error('CHECKPOINT_VERSION');
  if (!Array.isArray(checkpoint.events) || checkpoint.events.length > CHECKPOINT_EVENT_LIMIT) throw new Error('CHECKPOINT_EVENT_LIMIT');
  const match = new RecordedMatch({ ...deps, ...checkpoint.options, _startAt: checkpoint.startedAt, _restoring: true });
  try {
    for (const event of checkpoint.events) match._apply(event);
    const current = exportMatch(match, { referenceEvents: true });
    if (
      JSON.stringify(current.view) !== JSON.stringify(checkpoint.view) ||
      JSON.stringify(current.rng) !== JSON.stringify(checkpoint.rng)
    )
      throw new Error('CHECKPOINT_STATE_DIVERGED');
    match._recordOutput.muted = false;
    match._restored = true;
    return match;
  } catch (error) {
    match.dispose();
    throw error;
  }
}
