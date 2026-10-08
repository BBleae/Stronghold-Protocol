// server/match/match/infra.js — Match methods: infrastructure — error isolation (guard, reportError), timers tracked
// for dispose (later, cancel, scaled), the fixed-work queue of a recorded host (laterWork: workSlice / deferWork), the
// phase deadline (setDeadline), soloUntimed, uids, the player lists (alivePlayers, humans), the bonds this match's
// pool holds (bondInPool, bondLive), a player's boss-round group, deploy field and deploy map, and the guarded meta
// dispatch (dispatch, dispatchItem → effectsMeta.js EffectDispatcher).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { buildDeployMap } from '../board.js';

const WORK_TIMER = Symbol('workTimer');

export class MatchInfra {
  /** Run a callback with error isolation, then flush the views. */
  guard(fn) {
    if (this.disposed) return;
    try { fn(); } catch (e) { this.reportError('guard', e); }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
  }

  reportError(label, e) {
    this.errorCount++;
    const msg = `${label}: ${e && e.message ? e.message : e}`;
    if (this.errors.length < 50) this.errors.push({ label, message: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null });
    this.log.error?.(`[match ${this.roomCode}] ${msg}`, e && e.stack ? String(e.stack).split('\n').slice(1, 4).join(' | ') : '');
  }

  /** Schedule a guarded callback (tracked for dispose). */
  later(ms, fn) {
    if (this.disposed) return null;
    let h = null;
    h = this.sched.setTimeout(() => {
      this._timers.delete(h);
      if (this.disposed) return;
      this.guard(fn);
    }, ms);
    if (h) this._timers.add(h);
    return h;
  }

  cancel(h) {
    if (!h) return;
    if (typeof h === 'object' && WORK_TIMER in h) {
      h.cancelled = true;
      this.cancel(h[WORK_TIMER]);
      h[WORK_TIMER] = null;
      // a queued entry leaves the work queue (its gate moves on to the next entry, or goes)
      if (this._workQueue && !this._workQueue.running) this._armWorkGate();
      return;
    }
    this.sched.clearTimeout(h);
    this._timers.delete(h);
  }

  /**
   * Schedule expensive work: a bot prep step, a headless battle slice, a paced boss round. Without fixed work budgets
   * (workSlice) it is later(). With a recorded host's admission (deferWork) it joins the room's work queue, which ONE
   * gate timer wakes at the earliest time an entry may run. The gate tries every due entry in queue order, so a paced
   * prep entry never blocks a simulation slice behind it: a denied entry keeps its place and waits past the event's
   * horizon (no timer and no logged event of its own), an admitted one leaves the queue and runs, and the continuation
   * it schedules joins the back (the bots take turns). `alive` (optional) drops a stale entry once due, without taking
   * an admission. The returned token cancels the work wherever it waits.
   */
  laterWork(ms, fn, kind = 'simulation', alive = null) {
    if (!this.workSlice) return this.later(ms, fn);
    if (this.disposed) return null;
    const token = { [WORK_TIMER]: null, cancelled: false };
    if (!this.deferWork) {
      // no admission to wait for: each slice still runs in a scheduler callback of its own
      token[WORK_TIMER] = this.later(ms, () => {
        token[WORK_TIMER] = null;
        if (!token.cancelled && (!alive || alive())) fn();
      });
      return token;
    }
    const q = (this._workQueue ??= { entries: [], gate: null, gateAt: Infinity, running: false });
    q.entries.push({ at: this.sched.now() + (Number.isFinite(ms) && ms > 0 ? ms : 0), kind, fn, alive, token });
    // the gate that is running reaches an entry its admitted work adds (another bot's turn may come first)
    if (!q.running) this._armWorkGate();
    return token;
  }

  /** (Re-)arm the work queue's gate at its earliest entry; cancelled entries leave the queue here. */
  _armWorkGate() {
    const q = this._workQueue;
    q.entries = q.entries.filter((e) => !e.token.cancelled);
    let at = Infinity;
    for (const e of q.entries) if (e.at < at) at = e.at;
    if (q.gate && q.gateAt === at) return;
    if (q.gate) this.cancel(q.gate);
    q.gate = null;
    q.gateAt = at;
    if (at < Infinity) q.gate = this.later(Math.max(0, at - this.sched.now()), () => this._runWorkGate());
  }

  /** The work gate: each due entry, in queue order, is dropped (stale), postponed (denied) or run (admitted). */
  _runWorkGate() {
    const q = this._workQueue;
    q.gate = null;
    q.gateAt = Infinity;
    q.running = true;
    try {
      const now = this.sched.now();
      for (let i = 0; i < q.entries.length && !this.disposed;) {
        const e = q.entries[i];
        if (e.at > now) { i++; continue; }
        if (e.token.cancelled || (e.alive && !e.alive())) { q.entries.splice(i, 1); continue; }
        const delay = this.deferWork(e.kind, this.deadline, e.kind.startsWith('prep') && this._prepUrgent());
        if (delay > 0) { e.at = now + delay; i++; continue; }
        q.entries.splice(i, 1);
        try { e.fn(); } catch (err) { this.reportError('work', err); }
      }
    } finally {
      q.running = false;
    }
    if (!this.disposed) this._armWorkGate();
  }

  scaled(ms) { return Math.max(0, Math.round(ms * this.timerScale)); }

  /**
   * Set the phase deadline (seconds; null/0 ⇒ untimed) and its timeout callback. `silent`: the timer runs but no
   * deadline is published (m.public.deadline 0 ⇒ no countdown) — the fixed presentation steps of a solo match.
   */
  setDeadline(seconds, fn, { silent = false } = {}) {
    this.cancel(this._phaseTimer);
    this._phaseTimer = null;
    if (!(seconds > 0) || typeof fn !== 'function') { this.deadline = 0; return; }
    const ms = this.scaled(seconds * 1000);
    this.deadline = silent ? 0 : this.sched.now() + ms;
    this._phaseTimer = this.later(ms, () => { this._phaseTimer = null; fn(); });
  }

  /**
   * Solo timers (research 01 §843 / 06 §3: 下半 独立模拟 has no time limit on 休整期 / 机变 — "休整期及机变阶段没有时间
   * 限制"; the strategy draft is free too): a solo match publishes a deadline ONLY for its battles. INFO_CHECK waits
   * for 准备就绪 (co-op keeps the official 25 s guard), BAND_DRAFT / SP_DRAFT / PREP are untimed, and the fixed
   * presentation steps (BATTLE_CHECK, ROUND_START, SETTLE) run silently (no countdown). The same holds for any match
   * with a single human (loneHuman: a 同盟 room started alone or with AI teammates only — user playtest #4 item 3):
   * the timers only ever made humans wait on each other. AI seats need no deadline: their prep starts after its
   * stagger and, once the human is ready, runs without its voluntary pacing gap (_prepUrgent).
   */
  get soloUntimed() { return this.isSolo || this.loneHuman; }

  nextUid() { return ++this.uidSeq; }

  alivePlayers() { return this.order.filter((p) => p.alive); }

  /** Whether any chess of a bond is in this match's pool (a 驰援 card of a fully banned bond is never offered). */
  bondInPool(bondId) {
    for (const id of this.pool.entries.keys()) {
      const c = this.gd.chess(id);
      if (c && Array.isArray(c.bonds) && c.bonds.includes(bondId)) return true;
    }
    return false;
  }

  /**
   * Whether a bond can matter in this match: not in the mode's static inactive list (标准: 拉特兰 / 阿戈尔 / 卡西米尔 /
   * 奥术 … never activate, research 02 §2.1) and still with chess in the pool. 机变 tactic cards whose every target bond
   * is dead are not offered (choices.js).
   */
  bondLive(bondId) {
    return !this.gd.modeInactiveBonds.has(bondId) && this.bondInPool(bondId);
  }
  humans() { return this.order.filter((p) => !p.isBot && !p.left); }

  /**
   * The boss-round group of a player (`bossWaves`: the seat pairs of finalAssault.js pairPlayers, planned in startRound
   * before the players' round start) and its side — 'L', or 'R' for the second player of a pair (the mirrored right
   * half) — or null outside a boss round / for a player without a field.
   * @returns {{ wave: object, players: string[], side: 'L'|'R' } | null}
   */
  bossGroupOf(ps) {
    if (!ps || !Array.isArray(this.bossWaves)) return null;
    const g = this.bossWaves.find((x) => Array.isArray(x.players) && x.players.includes(ps.playerId));
    return g ? { wave: g.wave, players: g.players, side: g.players.indexOf(ps.playerId) === 1 ? 'R' : 'L' } : null;
  }

  /**
   * The field a player deploys on (server/match/board.js DEPLOY_FIELDS): in a boss round (最终攻势 / 隐秘核心, from its
   * ROUND_START on — the pairing exists before PlayerState.startRound's recompute) the player's half of the boss field,
   * 'bossL' or 'bossR' (bossGroupOf); otherwise its own normal board. User playtest #5 item 7.
   * @returns {'normal'|'bossL'|'bossR'}
   */
  deployFieldOf(ps) {
    const g = this.bossGroupOf(ps);
    return !g ? 'normal' : g.side === 'R' ? 'bossR' : 'bossL';
  }

  /**
   * A fresh deploy map of a player on `field` (default: the field it deploys on now) under its device / tile overrides.
   * Pure — no PlayerState cache is touched (the read-only checker invariants.js uses it; PlayerState.deployMap caches).
   */
  deployMapFor(ps, field = this.deployFieldOf(ps)) {
    return buildDeployMap(this.stage, { deviceOverrides: ps.deviceOverrides, tileOverrides: ps.tileOverrides, field });
  }

  dispatch(ps, hook, ev = {}, opts = {}) {
    try { return this.dispatcher.dispatch(ps, hook, ev, opts); } catch (e) { this.reportError(`dispatch ${hook}`, e); return ev; }
  }

  dispatchItem(ps, item, holder, hook, ev) {
    try { return this.dispatcher.dispatchItem(ps, item, holder, hook, ev); } catch (e) { this.reportError(`dispatchItem ${hook}`, e); return ev; }
  }
}
