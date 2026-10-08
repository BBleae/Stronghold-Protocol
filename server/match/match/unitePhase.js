// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode). Above 4 alive (remake extension,
// unite.js uniteGroups) one 联防 field per helper group — 'u', 'u2', … — each run like the single one, the phase ending
// when every field has its result (settle bills each leaker from its own field).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, uniteGroups, uniteGroupOf } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';

export class MatchUnite {
  startUnite(plan) {
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    // one field per helper group: 'u' (and 'u2', … above 4 alive — unite.js)
    this.fields = uniteGroups(plan).map((g) => {
      const battle = this.newBattle(this._uniteOpts(g, limit));
      return { fieldId: g.fieldId, kind: 'unite', players: g.helpers.map((p) => p.playerId), battle, live: true };
    });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const results = this.fields.map((f) => {
          const res = runner.resultOf(f);
          this._collectSimErrors(f, res);
          f.live = false;
          return res;
        });
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, results.length === 1 ? results[0] : results));
      },
    });
    this.runner.start();
  }

  /**
   * The field a viewer is shown during 联防 by default (the phase start, a resync with no field picked): a helper's own
   * field, the field holding a leaker's enemies (unite.js uniteGroupOf), else the field of the player it follows
   * (watch.js _watchTargetField: an eliminated human, a spectator seat), else the first 联防 field. One field: 'u'.
   */
  _uniteHomeField(ps) {
    const g = this.unitePlan && ps ? uniteGroupOf(this.unitePlan, ps.playerId) : null;
    return (g && this.fields.find((f) => f.kind === 'unite' && f.fieldId === g.fieldId)) || (ps ? this._watchTargetField(ps, this.fields) : null) || this.fields[0] || null;
  }

  /**
   * Battle options of a 联防 field — a plan group (helpers' carried end state, its leakers' enemies; above 4 alive one
   * of several, unite.js uniteGroups) — on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    const fieldId = plan.fieldId || 'u';
    return {
      seed: deriveSeed(this.seed, `${fieldId}:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId,
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    // one field per helper group: 'u' (and 'u2', … above 4 alive — unite.js); each gets its own authority or the server
    const fields = uniteGroups(plan).map((g) => this._ccField({ fieldId: g.fieldId, kind: 'unite', players: g.helpers.map((p) => p.playerId), opts: this._uniteOpts(g, limit) }));
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch(fields);
    // helpers and everyone else (as observers, spectator seats included) simulate a 联防 spec locally: a helper its own
    // field, a leaker the field holding its enemies, anyone else the first field
    for (const ps of this._viewers()) {
      const f = this._uniteHomeField(ps);
      if (!f) continue;
      this.watchers.set(ps.playerId, f.fieldId);
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  /** Every 联防 field has its result: SETTLE after the COMBAT_END pause (several fields: their results in field order). */
  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const results = this.fields.map((f) => {
      const res = f.result;
      this._collectSimErrors(f, res);
      return res;
    });
    this._stopClientCombat();
    for (const f of this.fields) f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, results.length === 1 ? results[0] : results));
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down and rises when one splits or summons (the children carry the leaker).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what settlement can bill that leaker (fields.js uniteBillBounds:
   * sent in + the offspring bound, validateClientResult's budget); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    // the leaker's own 联防 field (one field: 'u'; above 4 alive the field holding its enemies — unite.js)
    const g = uniteGroupOf(plan, pid) || uniteGroups(plan)[0];
    const f = this.fields.find((x) => x && x.kind === 'unite' && x.fieldId === g.fieldId) || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(g, res).get(pid) || 0;
    const sent = g.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) {
      // per field: what that field's result may bill its leakers (validateClientResult's budget on the field's own spec)
      const bounds = new Map();
      for (const grp of uniteGroups(plan)) for (const [id, n] of uniteBillBounds(grp.leaked, this.gd)) bounds.set(id, n);
      this._uniteBounds = { plan, bounds };
    }
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (g.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const fs = runner && runner.fields ? runner.fields.filter((f) => f && f.battle) : [];
    if (!fs.length || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(fs.length === 1 ? uniteLeft(fs[0].battle) : fs.map((f) => uniteLeft(f.battle))); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
