import { Match } from './Match.js';
import { VirtualScheduler } from './scheduler.js';
import { appendReplayReport, recordServerBattle, recordServerSpec } from './recorder.js';

import { RULES_VERSION } from '../../shared/rules-version.js';
export { RULES_VERSION };
// Every input that changes the match is logged, so a restore (and a replay) re-applies it: setPicks included — a 甄选
// pick taken during INFO_CHECK / BAND_DRAFT adds the player's private pool entries (DESIGN §27), and a restore without
// it would deal that player's shop from another pool.
const METHODS = new Set(['start', 'handle', 'onDisconnect', 'onReconnect', 'onLeave', 'setLoadout', 'setPicks']);
const copy = (value) => JSON.parse(JSON.stringify(value));
// Work units, not wall-clock milliseconds: live execution and recovery must split at identical points.
const WORK_SLICE = Object.freeze({ prepSteps: 1, prepSimulationTicks: 128, prepIntervalMs: 25, simulationTicks: 512 });
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
    const work = { frame: null, remaining: null, nextPrepAt: 0, prepIntervalMs: 0, prepReserveMs: 0 };
    super({
      ...options,
      scheduler,
      // Each timer records its admission allowance and pump horizon. Once used, expensive work moves past that
      // horizon, while ordinary due timers (especially phase deadlines) still run before the player's input.
      deferWork: (kind, deadline) => {
        const frame = work.frame;
        if (!frame) return 0;
        // Pace the whole room's AI work from the recorded event horizon, not an overdue timer's timestamp.
        // Near the prep deadline remove only the voluntary gap; the fixed slice and event cap still apply.
        const now = Math.max(scheduler.now(), frame.until);
        const pacedPrep = kind === 'prep' && !(deadline > 0 && deadline - now <= work.prepReserveMs);
        if (pacedPrep && work.nextPrepAt > now) return work.nextPrepAt - scheduler.now();
        if (frame.remaining > 0) {
          frame.remaining--;
          if (kind === 'prep') work.nextPrepAt = now + work.prepIntervalMs;
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
      || event.work.remaining < 0 || !Number.isFinite(event.work.until) || event.work.until < event.at))
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
  setPicks(...args) {
    return this._input('setPicks', args);
  }
  _ccField(options) {
    const field = super._ccField(options);
    for (const player of field.spec.players) {
      const used = new Set(this.usedOperators[player.playerId] || []);
      for (const unit of player.units || [])
        if (unit.kind === 'chess' && unit.chessId) used.add(this.gd.baseIdOf(unit.chessId));
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
  pump(until = this._wallNow(), limit = 100, workBudget = { remaining: 1 }) {
    if (!Number.isFinite(until) || !Number.isSafeInteger(workBudget.remaining) || workBudget.remaining < 0)
      throw new Error('MATCH_WORK_BUDGET');
    let n = 0;
    while (n < limit && !this.disposed) {
      const at = this.sched.nextAt();
      if (at == null || at > until) break;
      const effectiveAt = Math.max(at, this.sched.now());
      this._apply({ kind: 'timer', at: effectiveAt, id: this.sched._q[0].id,
        work: { remaining: workBudget.remaining, until: Math.max(until, effectiveAt) } });
      workBudget.remaining = this._work.remaining;
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
    // the players' 甄选 picks (private: in no public view) — a restore must reproduce them too
    picks: copy(match.waiguanPicks || {}),
  };
}
export function restoreMatch(checkpoint, deps) {
  if (checkpoint?.schemaVersion !== 1 || checkpoint.rulesVersion !== RULES_VERSION)
    throw new Error('CHECKPOINT_VERSION');
  if (!Array.isArray(checkpoint.events) || checkpoint.events.length > 200000) throw new Error('CHECKPOINT_EVENT_LIMIT');
  const match = new RecordedMatch({ ...deps, ...checkpoint.options, _startAt: checkpoint.startedAt, _restoring: true });
  try {
    for (const event of checkpoint.events) match._apply(event);
    const current = exportMatch(match, { referenceEvents: true });
    if (
      JSON.stringify(current.view) !== JSON.stringify(checkpoint.view) ||
      JSON.stringify(current.rng) !== JSON.stringify(checkpoint.rng) ||
      JSON.stringify(current.picks) !== JSON.stringify(checkpoint.picks ?? {})
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
