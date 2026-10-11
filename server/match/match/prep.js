// server/match/match/prep.js — Match methods: the PREP phase — its start (deferred item merges, onPrepStart), the AI
// seats' sliced preps (scheduleBotPrep: economy + layout, rehearsal, Ready — in wall-clock slices, or in fixed work
// counts on a recorded host: workSlice / laterWork, infra.js), Ready and the deadline (the AI-played seats' preps it
// finishes on a fixed-work host: _finishBotPrep), and its end (onPrepEnd, PlayerState.endPrep, then COMBAT or the Final
// Assault / Hidden Core).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { botPrepBeginSteps, botPrepEndSteps, runSteps, TRANSIENT, HEAVY } from '../bot.js';
import { DELAYS } from './common.js';

export class MatchPrep {
  enterPrep() {
    this.phase = PHASE.PREP;
    this.sp = null;
    const alive = this.alivePlayers();
    for (const ps of alive) {
      ps.ready = false;
      // Items gained as the previous prep ended waited unmerged (acquireItem deferMerge). Merge them now, before
      // this prep's onPrepStart grants and before the player acts — not in endPrep, which runs in the same prep
      // that granted them and would take an equipped copy off for the fight about to start.
      ps.checkItemMerges();
      ps.recompute();
      this.dispatch(ps, 'onPrepStart', { round: this.round });
      ps.recompute();
    }
    // solo / single-human matches: untimed (soloUntimed); co-op: the round's prepTime
    const secs = this.soloUntimed ? null : this.gd.prepTime(this.round);
    this.setDeadline(secs, () => this.prepDeadline());
    let i = 0;
    for (const ps of alive) if (ps.botControlled) this.scheduleBotPrep(ps, i++);
    this.markPublic();
    this.maybeEndPrep();
  }

  /**
   * The bot plays a prep in three stages, in fixed workSlice counts or botSliceMs wall-clock slices (one scheduler callback
   * each, so other rooms' battles and every player's requests keep flowing): economy + the default layout
   * (bot.js botPrepBeginSteps — shop decisions and layout planning, 50–120 ms late in a 4-bot match), the layout
   * rehearsal (whole simulated battles, 0.2–1 s of CPU per bot late in a match), then botPrepEndSteps (the rehearsed
   * layout, temp, Ready). The step generators run one bot's actions in the same order as the one-shot routine; with
   * several bots their slices interleave, so the shared rng streams and pool may give a bot other draws than bots
   * playing one after another would. Unbounded virtual time without workSlice runs each stage at once. The seat leaving
   * autoplay or a newer schedule for the seat drops the job between two steps. In fixed counts that is never at a
   * TRANSIENT yield (bot.js: the board mid-layout — the drive steps through those in the same callback, and they count
   * as no step), so neither the fight nor a scout ever gets a half-built board; a wall-clock slice may still stop at
   * one. A fixed-count slice also ends at a HEAVY yield (the step before an arrangement): the arrangement's slice is
   * queued as 'prepArrange', which takes an event's work allowance of its own (RecordedMatch deferWork), so it never
   * adds to the other slices an urgent event runs. In fixed counts the prep deadline does not drop a job whose start was
   * due before it (_finishBotPrep): it finishes the economy + default layout and the end stage at once, so the seat's
   * shop decisions complete and its board is whole, but the rest of the rehearsal only gets a share of the deadline's
   * recorded tick budget (workSlice.deadlineRehearsalTicks, shared by the seats it finishes, in seat order) — a
   * rehearsal still unfinished then is cut, and the seat takes the best of the candidates it has finished (the default
   * plan before any). Otherwise the prep ending first drops the job between two steps too.
   */
  scheduleBotPrep(ps, i = 0) {
    const round = this.round;
    const token = (ps._botPrepToken = (ps._botPrepToken || 0) + 1);
    const valid = () => this.phase === PHASE.PREP && this.round === round && ps.alive && !ps.ready && ps.botControlled && ps._botPrepToken === token;
    const fixed = this.workSlice;
    const bounded = !!fixed || Number.isFinite(this.botSliceMs);
    // a queued step of a dropped job leaves the work queue without taking an admission; `heavy`: the step starts an
    // arrangement (bot.js HEAVY) and takes an event's work allowance of its own (deferWork 'prepArrange')
    const later = (ms, fn, heavy = false) => fixed ? this.laterWork(ms, fn, heavy ? 'prepArrange' : 'prep', valid) : this.later(ms, fn);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const delay = this.scaled(DELAYS.BOT_ACTION + i * DELAYS.BOT_STAGGER);
    // where the job stands, for the prep deadline (_finishBotPrep): stage 'wait' (its start is queued), 'begin' (economy
    // + default layout), 'rehearsal', 'end'; `gen` the stage's step generator, `done` / `value` once it has returned
    const run = { valid, startAt: this.sched.now() + delay, stage: 'wait', gen: null, done: false, value: null, job: null, rehearsed: false, complete: null };
    ps._botPrep = run;
    /** Step a generator until done or the slice budget is used; `then(value)` once it is done (null on an error). */
    const drive = (gen, label, then) => {
      const t0 = fixed ? 0 : now();
      let r = null;
      let steps = 0;
      run.gen = gen;
      run.done = false;
      const finish = (value) => {
        run.done = true;
        run.value = value;
        if (fixed) { if (valid()) later(0, () => { if (valid()) then(value); }); }
        else then(value);
      };
      try {
        do { r = gen.next(); if (r.value !== TRANSIENT) steps++; }
        while (!r.done && (fixed ? r.value === TRANSIENT || (steps < fixed.prepSteps && r.value !== HEAVY) : !(bounded && now() - t0 >= this.botSliceMs)));
      } catch (e) {
        this.reportError(`bot ${ps.playerId}${label}`, e);
        finish(null);
        return;
      }
      if (r.done) { finish(r.value); return; }
      later(0, () => { if (valid()) drive(gen, label, then); }, r.value === HEAVY);
    };
    const ready = () => {
      if (!ps.ready) {
        this.autoPickPersonalChoice(ps, 'random');
        ps.resolveTemp();
        ps.setReady(true);
      }
    };
    const end = (job) => {
      run.stage = 'end';
      run.gen = null;
      let gen = null;
      try { gen = botPrepEndSteps(this, ps, job); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); }
      if (!gen) { ready(); return; }
      drive(gen, '', ready);
    };
    /**
     * The rest of the job now, in the order its slices would have run it (the prep deadline: _finishBotPrep). The begin
     * and end stages run to their end; the rehearsal runs at most `budget.ticks` more ticks and takes them from the
     * budget (shared by the seats the deadline finishes). One still unfinished then is cut (job.cut): botPrepEndSteps
     * applies the best of the candidates it finished. The generators' steps are the one-shot routine's and the rehearsal
     * runs on its own seed in fixed ticks, so the board depends only on recorded slices and the recorded budget. Errors
     * are handled as in the slices (a failed rehearsal leaves the default plan).
     */
    run.complete = (budget) => {
      if (!valid()) return;
      if (run.stage === 'wait') { run.stage = 'begin'; run.gen = botPrepBeginSteps(this, ps); run.done = false; }
      if (run.stage === 'begin') {
        let job = null;
        if (run.done) job = run.value;
        else { try { job = runSteps(run.gen); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); } }
        run.job = job;
        run.stage = job ? 'rehearsal' : 'end';
        run.gen = null;
      }
      if (run.stage === 'rehearsal') {
        const job = run.job;
        if (!run.rehearsed && !job.done) {
          try {
            if (budget.ticks > 0) {
              const ticks = job.ticks;
              job.runTicks(budget.ticks);
              budget.ticks = Math.max(0, budget.ticks - (job.ticks - ticks));
            }
            if (!job.done) job.cut = true;
          } catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
        }
        run.stage = 'end';
        run.gen = null;
      }
      if (run.stage === 'end') {
        if (!run.gen) {
          run.done = false;
          try { run.gen = botPrepEndSteps(this, ps, run.job); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); }
        }
        if (run.gen && !run.done) { try { runSteps(run.gen); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); } }
      }
      if (valid()) ready();
    };
    later(delay, () => {
      if (!valid()) return;
      run.stage = 'begin';
      drive(botPrepBeginSteps(this, ps), '', (job) => {
        run.job = job;
        if (!job) { end(null); return; }
        run.stage = 'rehearsal';
        run.gen = null;
        const slice = () => {
          if (!valid()) return;
          let done = true;
          try { done = fixed ? job.runTicks(fixed.prepSimulationTicks) : job.run(this.botSliceMs); } catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
          // over (or failed: the default plan stays) — end() may still wait for its slice
          if (done) run.rehearsed = true;
          if (done) { if (bounded) later(0, () => { if (valid()) end(job); }); else end(job); }
          else later(0, slice);
        };
        // bounded slices start in a callback of their own (the economy + default layout above already used this one)
        // Fixed-step drive already scheduled this continuation separately from the economy/layout slice.
        if (bounded && !fixed) later(0, slice);
        else slice();
      });
    });
  }

  onReadyChanged(ps) {
    this.markPublic();
    void ps;
    this.maybeEndPrep();
  }

  maybeEndPrep() {
    if (this.phase !== PHASE.PREP || this._prepEndQueued) return;
    // Prep ends early once nobody it waits for is still choosing. A seat a bot plays (an AI, or a human on 暂离
    // autoplay) is waited for — its bot readies when its turn is done; a disconnected human nobody plays for is not.
    // With no human connected, only an all-ready room ends early.
    const allReady = () => {
      const alive = this.alivePlayers();
      if (!alive.length || alive.some((p) => !p.ready && (p.botControlled || p.connected))) return false;
      return alive.every((p) => p.ready) || alive.some((p) => !p.isBot && p.connected);
    };
    if (!allReady()) return;
    const round = this.round;
    this._prepEndQueued = true;
    // the prep deadline stays armed until the phase really ends: a player may un-ready before this runs
    this.later(0, () => {
      this._prepEndQueued = false;
      if (this.phase === PHASE.PREP && this.round === round && allReady()) this.prepDeadline();
    });
  }

  /**
   * Whether the AI seats' prep work is urgent (laterWork → deferWork: no voluntary gap, several slices per event): in
   * PREP a human is connected (alive, or eliminated and watching) and every alive human who still chooses for themself
   * (connected, not on autoplay) is ready, so the room waits on the bots alone — a human on autoplay waits too. Recorded
   * state only, so a restore admits the same slices. With no human connected nobody waits: the AI keeps its pace.
   */
  _prepUrgent() {
    if (this.phase !== PHASE.PREP) return false;
    let waiting = false;
    for (const p of this.order) {
      if (p.isBot || !p.connected) continue;
      if (p.alive && !p.botControlled && !p.ready) return false;
      waiting = true;
    }
    return waiting;
  }

  prepDeadline() {
    if (this.phase !== PHASE.PREP) return;
    // the rehearsal ticks this event may run for the AI-played seats it finishes, all of them together
    const budget = { ticks: this.workSlice ? this.workSlice.deadlineRehearsalTicks : 0 };
    for (const ps of this.alivePlayers()) if (!ps.ready) this._finishBotPrep(ps, budget);
    for (const ps of this.alivePlayers()) {
      if (ps.ready) continue;
      this.autoPickPersonalChoice(ps, 'random');
      ps.resolveTemp();
      ps.ready = true;
      ps.dirty();
    }
    this.endPrep();
  }

  /**
   * The prep deadline and an AI-played seat whose prep is still running (scheduleBotPrep), on a fixed-work host
   * (workSlice: a recorded room, one per Durable Object): a job that has started, or whose start was due before now but
   * still waited for the room's work queue, is finished now, so the seat never fights a half-built board and its
   * economy decisions complete. The economy + default layout and the end stage (the chosen plan, temp, Ready) run to
   * their end; the rest of the rehearsal runs on `budget` (prepDeadline: workSlice.deadlineRehearsalTicks, shared by
   * every seat finished in this event, in seat order), so one event never runs a whole late-match rehearsal for each
   * seat (0.2–1 s apiece). The economy + default layout are not bounded, though (~15–40 ms per seat late in a match):
   * three or four seats still in them make the event go over ~80 ms (DEADLINE_REHEARSAL_TICKS). A rehearsal the budget
   * does not cover is cut: the seat takes the best of the candidates finished so far (default plan before any). How far
   * the slices got before the deadline depends on the host, but only through recorded admissions, so a restore replays
   * the same board. A job whose start is not due yet is dropped (the seat keeps its board, as without a bot).
   * Wall-clock slices (botSliceMs, the Node server, whose process hosts every room) are dropped as before.
   */
  _finishBotPrep(ps, budget) {
    const run = ps._botPrep;
    if (!this.workSlice || !run || !run.complete || !run.valid()) return;
    if (run.stage === 'wait' && !(run.startAt < this.sched.now())) return;
    run.complete(budget);
  }

  endPrep() {
    if (this.phase !== PHASE.PREP) return;
    this.setDeadline(0);
    // a job the prep end dropped holds its rehearsal battles: let them go
    for (const ps of this.order) ps._botPrep = null;
    const alive = this.alivePlayers();
    for (const ps of alive) this.dispatch(ps, 'onPrepEnd', { round: this.round });
    for (const ps of alive) ps.endPrep();
    const r = this.round;
    if (r === this.gd.bossRound) {
      this.hiddenLayerSum = alive.reduce((s, p) => s + p.activatedLayers(), 0);
      this.hiddenLayerPlayers = alive.length;
      this.startFinalAssault(false);
    } else if (r === this.gd.hiddenRound) {
      this.startFinalAssault(true);
    } else {
      this.startCombat();
    }
  }
}
