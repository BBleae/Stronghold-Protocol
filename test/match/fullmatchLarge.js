// test/match/fullmatchLarge.js — shared by the 5–8-seat soak suites (fullmatch-coop-5seats.test.js,
// fullmatch-coop-8seats.test.js): one whole co-op match with the REAL simulation and client-side combat
// (fullmatchRun.js runFull: zero errors, invariants at every phase change, no rejected client result), then the remake's
// 5–8-player rules (DESIGN §24, docs/PLAYING.md §11, docs/META.md) checked on what the match did:
//   * shared pool: copies per chess = ceil(base × max(1, n / 4)), n = the seats at the start (humans + AI);
//   * strategy draft: one turn per seat; a timed draft of more than 4 seats gives 20 s a turn (30 s otherwise);
//   * 机变: max(6, alive + 2) cards for the alive pickers (7–10 cards for 5–8 players);
//   * 联防: alive ≤ 4 → one field 'u' with ≤ 2 helpers; alive > 4 → up to k = ceil(alive / 4) fields 'u', 'u2', …,
//     1–2 helpers each, every leaker on exactly one field, `unite.fields` published only with more than one field;
//   * 最终攻势 / 隐秘核心: seat pairs b1…b⌈alive / 2⌉, the shared pool = bloodPoint × max(1, alive / 4);
//   * result: a row per seat; with more than 4 players everyone who spent funds (挥金如土's stat) holds a title —
//     the second pass lets a title repeat.
// The views are read through Match.prototype.flush (wrapped for this test process only): the first flush of each
// draft / 联防 / boss phase builds the public view (m.public's own builder, read-only) and checks it — the broadcast
// itself is throttled in virtual time and can skip a short phase. Every broken rule is collected (its first
// occurrence) and reported together, so one run names every rule that does not hold.
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { Match } from '../../server/match/Match.js';
import { SEEDS, runFull } from './fullmatchRun.js';

// 5–8-seat matches take about twice as long as 4-seat ones: a bounded number of seeds keeps the full suite's length
export const LARGE_SEEDS = Math.max(1, Math.min(SEEDS, 6));

const WATCHED = new Set([PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
let observer = null;
const flush = Match.prototype.flush;
Match.prototype.flush = function (...args) {
  const r = flush.apply(this, args);
  if (observer && !this.disposed && WATCHED.has(this.phase)) observer(this);
  return r;
};

const ceilDiv = (a, b) => Math.ceil(a / b);
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** base copies of a chess before the 5–8 scaling (config.economy.poolCopies[tier] / poolCopiesOverrides) */
function baseCopies(gd, id) {
  const eco = gd.economy || gd.config?.economy || {};
  const ov = eco.poolCopiesOverrides;
  if (ov && Number.isInteger(ov[id])) return ov[id];
  return eco.poolCopies?.[gd.tierOf(id)];
}

export function runLarge({ difficulty, humans, bots, seed }) {
  const n = humans + bots;
  const tag = `co-op ${humans}+${bots} (${n} seats) ${difficulty}/${seed}`;
  const seen = { drafts: 0, sp: 0, unite: 0, multiUnite: 0, boss: 0, hidden: 0 };
  const broken = new Map();
  const check = (ok, rule, detail) => { if (!ok && !broken.has(rule)) broken.set(rule, `${rule} — ${detail}`); };
  const done = new Set();
  let match = null;

  observer = (m) => {
    if (match == null) match = m;
    if (m !== match) return;
    const key = `${m.phase}:${m.round}`;
    // the draft / 机变 / 联防 plan and the boss pool are fixed when the phase starts: one look per phase is enough
    if (done.has(key)) return;
    if (m.phase === PHASE.BAND_DRAFT && !m.draft) return;
    if (m.phase === PHASE.SP_DRAFT && !m.sp) return;
    if (m.phase === PHASE.UNITE && !m.unitePlan) return;
    if ((m.phase === PHASE.FINAL_ASSAULT || m.phase === PHASE.HIDDEN_CORE) && !m.bossPool) return;
    done.add(key);
    const v = m.publicView();
    const at = `R${v.round} ${v.phase}`;
    const alive = (v.players || []).filter((p) => p.alive);
    if (v.draft) {
      seen.drafts++;
      check(v.draft.order.length === n, 'one strategy turn per seat', `${v.draft.order.length} turns for ${n} seats`);
      if (!v.draft.untimed) check(v.draft.turnSeconds === (n > 4 ? 20 : 30), 'strategy turn 20 s above 4 seats', `${v.draft.turnSeconds} s with ${n} seats`);
    }
    if (v.sp) {
      seen.sp++;
      check(v.sp.order.length === alive.length, 'every alive player picks a 机变 card', `${at}: order ${v.sp.order.length}, alive ${alive.length}`);
      const want = Math.max(6, alive.length + 2);
      check(v.sp.cards.length === want, '机变 cards = max(6, alive + 2)', `${at} ${v.sp.family}: ${v.sp.cards.length} cards for ${alive.length} alive, want ${want}`);
    }
    if (v.unite) {
      seen.unite++;
      const uf = (v.fields || []).filter((x) => x.kind === 'unite');
      const helpers = uf.flatMap((x) => x.players);
      check(uf.length >= 1, 'a 联防 has a field', at);
      check(uf.every((x) => x.players.length >= 1 && x.players.length <= 2), '1–2 helpers per 联防 field', `${at}: ${JSON.stringify(uf.map((x) => x.players))}`);
      check(same(uf.map((x) => x.fieldId), uf.map((_, i) => (i === 0 ? 'u' : `u${i + 1}`))), '联防 field ids u, u2, …', `${at}: ${uf.map((x) => x.fieldId)}`);
      check(same(sorted(helpers), sorted(v.unite.helpers || [])), 'unite.helpers = the 联防 fields\' players', `${at}: ${v.unite.helpers} vs ${helpers}`);
      // fields = min(ceil(alive / 4), leakers, ceil(helpers / 2)); helpers: the top 2 × min(ceil(alive / 4), leakers)
      // perfect players (2 while alive ≤ 4)
      const perfect = m.alivePlayers().filter((ps) => {
        const r = m.lastResults && m.lastResults.get(ps.playerId);
        return r && !(r.leaked || []).some((l) => l && l.counted !== false) && r.perfect !== false;
      }).length;
      const nLeakers = (v.unite.leakers || []).length;
      const kk = Math.max(1, Math.min(ceilDiv(alive.length, 4), nLeakers));
      check(helpers.length === Math.min(2 * kk, perfect), '联防 helpers = min(2 × min(ceil(alive / 4), leakers), perfect players)', `${at}: ${helpers.length} helpers, ${perfect} perfect, ${alive.length} alive`);
      const wantFields = Math.min(kk, ceilDiv(helpers.length, 2));
      check(uf.length === wantFields, '联防 fields = min(ceil(alive / 4), leakers, ceil(helpers / 2))', `${at}: ${uf.length} fields, ${helpers.length} helpers, ${nLeakers} leakers, ${alive.length} alive`);
      if (alive.length <= 4) {
        check(uf.length === 1, 'alive ≤ 4 → one 联防 field', `${at}: ${uf.length} fields`);
        check(v.unite.fields === undefined, 'unite.fields only with several fields', `${at}: one field, ${alive.length} alive`);
      } else {
        const k = ceilDiv(alive.length, 4);
        check(uf.length <= k, '联防 fields ≤ ceil(alive / 4)', `${at}: ${uf.length} fields for ${alive.length} alive`);
        check(uf.length <= ceilDiv(helpers.length, 2), 'never a 联防 field without a helper', `${at}: ${uf.length} fields, ${helpers.length} helpers`);
        check(helpers.length <= 2 * k, '联防 helpers ≤ 2 × ceil(alive / 4)', `${at}: ${helpers.length} helpers for ${alive.length} alive`);
        if (uf.length > 1) {
          seen.multiUnite++;
          const fl = v.unite.fields;
          check(Array.isArray(fl) && fl.length === uf.length, 'unite.fields lists every 联防 field', `${at}: ${JSON.stringify(fl)}`);
          if (Array.isArray(fl)) {
            const leakers = fl.flatMap((x) => x.leakers || []);
            fl.forEach((x, i) => {
              check(x.fieldId === uf[i]?.fieldId, 'unite.fields in field order', `${at}: ${x.fieldId} vs ${uf[i]?.fieldId}`);
              check(same(sorted(x.helpers || []), sorted(uf[i]?.players || [])), 'unite.fields[].helpers = the field\'s players', `${at} ${x.fieldId}`);
              check((x.leakers || []).length >= 1, 'every 联防 field has a leaker', `${at} ${x.fieldId}`);
            });
            check(same(sorted(leakers), sorted(v.unite.leakers || [])), 'every leaker on exactly one 联防 field', `${at}: ${JSON.stringify(fl.map((x) => x.leakers))} vs ${v.unite.leakers}`);
            check(new Set(leakers).size === leakers.length, 'no leaker on two 联防 fields', `${at}: ${leakers}`);
          }
        } else {
          check(v.unite.fields === undefined, 'unite.fields only with several fields', `${at}: one field, ${alive.length} alive`);
        }
      }
    }
    if ((v.phase === PHASE.FINAL_ASSAULT || v.phase === PHASE.HIDDEN_CORE) && v.bossHp) {
      if (v.phase === PHASE.FINAL_ASSAULT) seen.boss++;
      else seen.hidden++;
      const bf = (v.fields || []).filter((x) => x.kind === 'boss' || x.kind === 'hidden');
      check(same(bf.map((x) => x.fieldId), bf.map((_, i) => `b${i + 1}`)), 'boss field ids b1, b2, …', `${at}: ${bf.map((x) => x.fieldId)}`);
      check(bf.length === ceilDiv(alive.length, 2), 'boss fields = seat pairs', `${at}: ${bf.length} fields for ${alive.length} alive`);
      const bossId = v.phase === PHASE.HIDDEN_CORE ? m.hiddenBossId : m.bossId;
      const bp = m.gd.boss(bossId)?.bloodPoint?.[m.gd.difficulty];
      if (Number.isFinite(bp)) {
        const want = Math.round(bp * Math.max(1, alive.length / 4));
        check(Math.abs(v.bossHp.max - want) <= 1, 'leader pool = bloodPoint × max(1, alive / 4)', `${at}: ${v.bossHp.max}, want ${bp} × max(1, ${alive.length}/4) = ${want}`);
      }
    }
  };

  let out;
  try {
    out = runFull({ mode: 'coop', difficulty, humans, bots, seed });
  } finally {
    observer = null;
  }
  const { m, res } = out;

  check(m.order.length === n, 'every seat plays', `${m.order.length} of ${n}`);
  // shared pool, sized at the start for the n seats (1–4: the official copies)
  const f = Math.max(1, n / 4);
  let entries = 0;
  for (const id of m.pool.entries.keys()) {
    const base = baseCopies(m.gd, id);
    if (!Number.isInteger(base) || base <= 0) continue;
    entries++;
    const want = Math.ceil(base * f);
    check(m.pool.cap(id) === want, 'pool copies = ceil(base × n / 4)', `${id}: ${m.pool.cap(id)}, want ceil(${base} × ${n}/4) = ${want}`);
  }
  check(entries > 0, 'the pool has entries', 'none');
  check(seen.drafts === 1, 'the strategy draft was observed', `${seen.drafts} looks`);

  const rows = res.players || [];
  check(rows.length === n, 'a result row per seat', `${rows.length} rows for ${n} seats`);
  if (n > 4) {
    for (const r of rows) {
      if (r.stats && r.stats.gold > 0) check(!!r.title, 'above 4 players everyone eligible gets a title', `${r.playerId} spent ${r.stats.gold} funds, no title`);
    }
  }
  assert.deepEqual([...broken.values()], [], `${tag}: 5–8-player rules broken`);
  return seen;
}
