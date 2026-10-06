// Co-op rooms of 5–8 players (remake extension, owner's decision; server/match/gamedata.js DEFAULTS.largeRoom): with
// n players above 4 the counts scale by f = n / 4 — shared pool copies (seats at match start), the leader pool and the
// overtime drain (alive at the boss phase's start), the Hidden Core threshold (players whose layers are summed) —, the
// 机变 draft has max(6, alive + 2) cards (the structured drafts topped up), the strategy draft turn is 20 s above 4
// seats, a later 机变 pick 12 s above 4 alive, and result titles get a second pass that may repeat a title. Every rule,
// number, timer and random draw of 1–4 players stays the official one (the existing suites pin those; here the 1–4
// side of every rule is checked against the same code path once more).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { GameData, DEFAULTS } from '../../server/match/gamedata.js';
import { SharedPool } from '../../server/match/pool.js';
import { bossPoolHp, hiddenEligible } from '../../server/match/finalAssault.js';
import { generateDraft, spDraftCardCount, shopDraftCards, bountyDraftKind, draftBounty } from '../../server/match/choices.js';
import { assignTitles } from '../../server/match/results.js';
import { attachAudit } from '../../server/match/audit.js';
import { BAND_TURN_SECONDS } from '../../server/match/Match.js';
import { createRng } from '../../server/sim/rng.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';
import { WAIGUAN_POOL_COPIES } from '../../shared/waiguan.js';

const bossFields = () => FakeBattle.instances.filter((b) => b.kind === 'boss' || b.kind === 'hidden');
const MULTI = ['mode_multi_funny', 'mode_multi_normal', 'mode_multi_hard', 'mode_multi_abyss'];

test('large-room factor: 1 for 1–4 players, solo or no count; n / 4 above (defaults in gamedata.js, config.largeRoom overrides)', () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  assert.deepEqual(DEFAULTS.largeRoom, { players: 4, spCardsPlus: 2, bandTurn: 20, spTurn: 12 });
  assert.deepEqual(gd.largeRoom, DEFAULTS.largeRoom, 'data/config.json has no largeRoom key: the defaults');
  for (const n of [undefined, null, NaN, 0, 1, 2, 3, 4, '4']) {
    assert.equal(gd.largeRoomFactor(n), 1, `${n}`);
    assert.equal(gd.isLargeRoom(n), false, `${n}`);
  }
  for (const [n, f] of [[5, 1.25], [6, 1.5], [7, 1.75], [8, 2]]) {
    assert.equal(gd.largeRoomFactor(n), f);
    assert.equal(gd.isLargeRoom(n), true);
  }
  const solo = new GameData(DATA, 'mode_single_hard');
  assert.equal(solo.largeRoomFactor(8), 1, 'never in solo');
  const custom = new GameData({ ...DATA, config: { ...DATA.config, largeRoom: { players: 6, bandTurn: 25, spTurn: 10, spCardsPlus: 3 } } }, 'mode_multi_hard');
  assert.equal(custom.largeRoomFactor(6), 1);
  assert.equal(custom.largeRoomFactor(8), 8 / 6);
  assert.equal(custom.bandTurnSeconds(7, 30), 25);
  assert.equal(custom.spTurnSeconds(7), 10);
});

test('pool copies: the official counts for 1–4 seats; ceil(count × seats / 4) for 5–8 (overrides too), sized at match start', () => {
  const gd = new GameData(DATA, 'mode_multi_normal');
  const base = { 1: 12, 2: 14, 3: 18, 4: 16, 5: 8, 6: 5 };
  const byTier = (t) => gd.visibleChess.find((id) => gd.tierOf(id) === t && id !== 'chess_char_6_11_a');
  for (let t = 1; t <= 6; t++) {
    const id = byTier(t);
    for (const n of [undefined, 1, 2, 3, 4]) assert.equal(gd.poolCopies(id, n), base[t], `tier ${t}, ${n} seats`);
    for (const n of [5, 6, 7, 8]) assert.equal(gd.poolCopies(id, n), Math.ceil((base[t] * n) / 4), `tier ${t}, ${n} seats`);
    assert.equal(gd.poolCopies(id, 8), 2 * base[t], '8 seats double every count');
  }
  assert.equal(gd.poolCopies('chess_char_6_11_a', 4), 4, '缪尔赛思 keeps her 4 copies');
  assert.equal(gd.poolCopies('chess_char_6_11_a', 5), 5);
  assert.equal(gd.poolCopies('chess_char_6_11_a', 8), 8);
  assert.equal(gd.poolCopies(byTier(5), 5), 10, 'tier V: ceil(8 × 5 / 4)');
  assert.equal(gd.poolCopies(byTier(6), 7), 9, 'tier VI: ceil(5 × 7 / 4) = ceil(8.75)');
  // SharedPool: omitted / 1–4 seats = the official pool
  const official = new SharedPool(gd);
  for (const n of [1, 4]) assert.deepEqual(new SharedPool(gd, { players: n }).snapshot(), official.snapshot());
  const big = new SharedPool(gd, { players: 8 });
  for (const [id, left] of Object.entries(official.snapshot())) assert.equal(big.left(id), 2 * left, id);
  // the match: seats (humans + bots) at match start
  for (const [humans, bots, f] of [[1, 3, 1], [2, 2, 1], [1, 4, 5 / 4], [3, 3, 6 / 4], [1, 7, 2]]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans, bots, seed: 300 + humans + bots, fake: true });
    for (const [id, e] of h.m.pool.entries) {
      // a player's own 甄选 entry (AI teammates bring theirs, DESIGN §27) keeps the official per-tier copies at any size
      if (e.owner != null) { assert.equal(e.cap, WAIGUAN_POOL_COPIES[e.tier], `${humans}+${bots}: own ${id}`); continue; }
      assert.equal(e.cap, f === 1 ? gd.poolCopies(id) : Math.ceil(gd.poolCopies(id) * f - 1e-9), `${humans}+${bots}: ${id}`);
    }
    h.m.dispose();
  }
});

test('leader pool: bloodPoint for 1–4 alive, × alive / 4 for 5–8 (every co-op difficulty, hidden leaders too); solo unchanged', () => {
  const { tuning, ...RAW } = DATA; // eslint-disable-line no-unused-vars
  for (const modeId of MULTI) {
    const gd = new GameData(RAW, modeId);
    for (const bossId of ['boss_1', 'boss_8']) {
      const bp = gd.boss(bossId).bloodPoint[gd.difficulty];
      for (const n of [1, 2, 3, 4, undefined]) assert.equal(bossPoolHp(gd, bossId, n), bp, `${modeId} ${bossId} ${n}`);
      for (const n of [5, 6, 7, 8]) assert.equal(bossPoolHp(gd, bossId, n), Math.round((bp * n) / 4), `${modeId} ${bossId} ${n}`);
      assert.equal(gd.bossPoolHp(bossId, 6), bossPoolHp(gd, bossId, 6), 'GameData agrees');
    }
  }
  const solo = new GameData(RAW, 'mode_single_abyss');
  assert.equal(bossPoolHp(solo, 'boss_5', 1), 750000);
  // a data view without bossPoolShare (the fallback branch) applies the same factor
  const bare = { boss: (id) => RAW.bosses[id], difficulty: 'HARD', isSolo: false, mode: {}, config: {} };
  assert.equal(bossPoolHp(bare, 'boss_1', 4), 1800000);
  assert.equal(bossPoolHp(bare, 'boss_1', 6), 2700000);
});

test('Hidden Core threshold: 1200 for 1–4 summed players, 1200 × players / 4 for 5–8; solo 350', () => {
  const gd = new GameData(DATA, 'mode_multi_normal');
  for (const n of [undefined, 1, 2, 3, 4]) {
    assert.equal(gd.hiddenThreshold(n), 1200);
    assert.equal(hiddenEligible(gd, { layerSum: 1200, teamLp: 50, players: n }), false);
    assert.equal(hiddenEligible(gd, { layerSum: 1201, teamLp: 50, players: n }), true);
  }
  for (const [n, th] of [[5, 1500], [6, 1800], [7, 2100], [8, 2400]]) {
    assert.equal(gd.hiddenThreshold(n), th);
    assert.equal(hiddenEligible(gd, { layerSum: th, teamLp: 50, players: n }), false, `${n}: Σ = threshold is not enough`);
    assert.equal(hiddenEligible(gd, { layerSum: th + 1, teamLp: 50, players: n }), true, `${n}`);
    assert.equal(hiddenEligible(gd, { layerSum: th + 1, teamLp: 1, players: n }), false, 'team LP > 1 still needed');
  }
  assert.equal(new GameData(DATA, 'mode_single_hard').hiddenThreshold(1), 350);
});

test('overtime drain: 1 LP per real second for 1–4 alive at the boss phase start; × alive / 4 above, floored to whole LP', () => {
  const gd = new GameData(DATA, 'mode_multi_normal');
  const at = (realS) => (150 + realS) * gd.combatTimeScale;
  for (const n of [undefined, 1, 4]) {
    assert.equal(gd.bossOvertimeDue(at(0.5), n), 0);
    for (const k of [1, 2, 7, 40]) assert.equal(gd.bossOvertimeDue(at(k), n), k, `${n} alive, ${k} s`);
    assert.equal(gd.bossOvertimeDrainFor(n), 1);
  }
  assert.deepEqual([1, 2, 3, 4, 5, 8, 40].map((k) => gd.bossOvertimeDue(at(k), 5)), [1, 2, 3, 5, 6, 10, 50], '5 alive: 1.25 LP/s');
  assert.deepEqual([1, 2, 3, 4].map((k) => gd.bossOvertimeDue(at(k), 6)), [1, 3, 4, 6], '6 alive: 1.5 LP/s');
  assert.deepEqual([1, 2, 4].map((k) => gd.bossOvertimeDue(at(k), 7)), [1, 3, 7], '7 alive: 1.75 LP/s');
  assert.deepEqual([1, 2, 40].map((k) => gd.bossOvertimeDue(at(k), 8)), [2, 4, 80], '8 alive: 2 LP/s');
  assert.equal(gd.bossOvertimeDue(at(0.9), 8), 0, 'the first point still at 151 real s');
  assert.equal(gd.bossOvertimeDrainFor(8), 2);
});

for (const n of [5, 8]) {
  test(`Final Assault with ${n} players: ${Math.ceil(n / 2)} boss fields (seat pairs, a lone last player on _s), pool × ${n}/4, overtime × ${n}/4 → defeat`, () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: n, seed: 60 + n, fake: true, instant: false, script: (b) => (b.kind === 'boss' ? { bossDps: 1 } : {}) }).start();
    const m = h.m;
    const audit = attachAudit(m);
    h.drive(() => m.phase === PHASE.PREP && m.round === 14);
    for (const p of m.players.values()) p.lp = 10;
    h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
    assert.equal(m.teamLp, 10 * n);
    assert.equal(m.bossAlive, n);
    const fields = bossFields();
    assert.deepEqual(fields.map((f) => f.fieldId), Array.from({ length: Math.ceil(n / 2) }, (_, i) => `b${i + 1}`));
    assert.deepEqual(m.fields.map((f) => f.players), Array.from({ length: Math.ceil(n / 2) }, (_, i) => [`p_${2 * i}`, `p_${2 * i + 1}`].filter((id) => m.players.has(id))));
    for (const f of fields) assert.equal(/_s$/.test(f.opts.waveId), f.opts.players.length === 1, `${f.fieldId}: ${f.opts.waveId}`);
    const bp = m.gd.boss(m.bossId).bloodPoint.FUNNY;
    assert.equal(m.bossPool.maxHp, Math.round((bp * n) / 4), 'leader pool × alive / 4');
    assert.ok(fields.every((f) => f.sharedBoss === m.bossPool), 'one pool for every field');
    assert.ok(m.publicView().overtimeAt > 0);
    assert.equal(m.publicView().overtimeDrainPerSec, n / 4, 'm.public carries the scaled drain');
    const end = h.runToEnd();
    assert.equal(end.victory, false);
    assert.equal(m.teamLp, 0);
    // 10 LP each at n / 4 LP per real second: 40 real s of overtime → 300 + 80 game s (2 players at 1 LP/s: 340)
    assert.ok(Math.abs(fields[0].time - 380) < 2.5, `ended ≈ 380 game s (${fields[0].time})`);
    assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
    m.dispose();
  });
}

test('Final Assault with 4 players: the official pool, 1 LP/s, no overtimeDrainPerSec in m.public', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 4, seed: 64, fake: true, instant: false, script: (b) => (b.kind === 'boss' ? { bossDps: 1 } : {}) }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === 14);
  for (const p of m.players.values()) p.lp = 10;
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  assert.equal(m.bossPool.maxHp, m.gd.boss(m.bossId).bloodPoint.FUNNY);
  assert.ok(m.publicView().overtimeAt > 0);
  assert.ok(!('overtimeDrainPerSec' in m.publicView()));
  h.runToEnd();
  assert.ok(Math.abs(bossFields()[0].time - 380) < 2.5, `40 LP at 1 LP/s: 300 + 80 game s (${bossFields()[0].time})`);
  m.dispose();
});

test('Hidden Core with 6 players: Σ layers over 1200 but not over 1800 keeps it shut; over 1800 opens it (pool × 6/4)', () => {
  for (const [per, open] of [[210, false], [320, true]]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 4, seed: 52, fake: true, script: (b) => (b.kind === 'boss' || b.kind === 'hidden' ? { bossDps: 1e9 } : {}) }).start();
    const m = h.m;
    const audit = attachAudit(m);
    for (const p of m.players.values()) p.lp = 200;
    h.drive(() => m.phase === PHASE.PREP && m.round === 14);
    // only these layers count (whatever the AI teammates banked so far)
    for (const p of m.alivePlayers()) { p.bondCountBonus.yanShip = 3; p.layers = { yanShip: per }; p.recompute(); }
    const alive = m.alivePlayers().length;
    assert.equal(alive, 6, 'everybody alive');
    h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
    assert.equal(m.hiddenLayerPlayers, 6);
    // Σ of the six players at the prep end (prep-end effects may add a few layers)
    assert.ok(m.hiddenLayerSum >= 6 * per, `Σ ${m.hiddenLayerSum}`);
    if (!open) assert.ok(m.hiddenLayerSum > 1200 && m.hiddenLayerSum <= 1800, `Σ ${m.hiddenLayerSum}: over the 1–4 threshold, not over 1800`);
    const end = h.runToEnd({ maxSteps: 3e6 });
    assert.equal(end.victory, true);
    assert.equal(end.hiddenReached, open, `Σ ${m.hiddenLayerSum} vs 1800`);
    if (open) {
      const f = bossFields().find((b) => b.kind === 'hidden');
      assert.equal(f.sharedBoss.maxHp, Math.round((m.gd.boss(m.hiddenBossId).bloodPoint.NORMAL * 6) / 4));
    }
    assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
    m.dispose();
  }
});

test('机变 card count: 6 (co-op) / 3 (solo) up to 4 alive; max(6, alive + 2) above (7 / 8 / 9 / 10)', () => {
  for (const modeId of MULTI) {
    const gd = new GameData(DATA, modeId);
    for (const r of gd.spRounds()) {
      for (const n of [undefined, 1, 2, 3, 4]) assert.equal(spDraftCardCount(gd, r, n), 6, `${modeId} R${r} ${n}`);
      for (const n of [5, 6, 7, 8]) assert.equal(spDraftCardCount(gd, r, n), n + 2, `${modeId} R${r} ${n}`);
    }
  }
  const solo = new GameData(DATA, 'mode_single_hard');
  for (const r of solo.spRounds()) assert.equal(spDraftCardCount(solo, r, 1), 3);
});

/** Data whose SP round `round` of `modeId` always drafts `family`. */
function forced(modeId, round, family) {
  const ch = DATA.choices;
  const sch = ch.schedule[modeId];
  const r = { ...sch.rounds[String(round)], families: [{ family, weight: 1 }] };
  return new GameData({ ...DATA, choices: { ...ch, schedule: { ...ch.schedule, [modeId]: { ...sch, rounds: { ...sch.rounds, [String(round)]: r } } } } }, modeId);
}

test('机变 drafts of 1–4 alive draw exactly what they drew before (same cards, same random numbers consumed)', () => {
  for (const [modeId, round, family] of [['mode_multi_hard', 3, 'bounty'], ['mode_multi_hard', 9, 'bounty'], ['mode_multi_hard', 11, 'bounty'], ['mode_multi_hard', 11, 'shop'], ['mode_multi_hard', 11, 'tactic'], ['mode_multi_normal', 6, 'supply']]) {
    const gd = forced(modeId, round, family);
    for (let seed = 1; seed <= 25; seed++) {
      const a = createRng(seed);
      const ref = generateDraft(gd, a, round, { stageId: 'act2autochess_m01' });
      const next = a();
      for (const n of [1, 4]) {
        const b = createRng(seed);
        assert.deepEqual(generateDraft(gd, b, round, { stageId: 'act2autochess_m01', players: n }), ref, `${family} R${round} seed ${seed} ${n} alive`);
        assert.equal(b(), next, 'the same random numbers consumed');
      }
      assert.equal(ref.cards.length, 6);
    }
  }
});

test('机变 drafts above 4 alive: alive + 2 cards of every family; bounty top-ups of the same kind, distinct; the shop repeats its slot pattern', () => {
  for (const n of [5, 6, 7, 8]) {
    const want = n + 2;
    // bounty: the official structure (6) + other eligible cards of that kind, all different
    for (const round of [3, 9, 11]) {
      const gd = forced('mode_multi_hard', round, 'bounty');
      const kind = bountyDraftKind(round);
      const eligible = new Set(DATA.choices.cards.bounty.filter((c) => draftBounty(c, kind) && gd.enemy(c.enemyKey)).map((c) => c.effectId));
      for (let seed = 1; seed <= 15; seed++) {
        const d = generateDraft(gd, createRng(seed * 31 + n), round, { stageId: 'act2autochess_m01', players: n });
        assert.equal(d.family, 'bounty');
        assert.equal(d.cards.length, want, `R${round} ${n} alive`);
        assert.equal(new Set(d.cards.map((c) => c.id)).size, want, 'distinct bounties');
        assert.ok(d.cards.every((c) => eligible.has(c.id)), `R${round}: every card of the ${kind} draft`);
        assert.deepEqual(d.cards.map((c) => c.idx), Array.from({ length: want }, (_, i) => i));
      }
    }
    // shop (R11): slot k = slot k mod 6 — 7th–10th: VI, VI, V, 盟约之币
    const shop = forced('mode_multi_hard', 11, 'shop');
    const coin = DATA.choices.shopDraft.coin;
    for (let seed = 1; seed <= 15; seed++) {
      const d = generateDraft(shop, createRng(seed * 17 + n), 11, { stageId: 'act2autochess_m01', players: n });
      assert.equal(d.family, 'shop');
      assert.equal(d.cards.length, want);
      const tiers = d.cards.map((c) => (c.id === coin ? 'coin' : DATA.items[c.id].tier));
      const six = tiers.filter((t) => t === 6).length;
      assert.ok(six >= 2 + Math.min(2, want - 6), `tier VI: ${tiers}`);
      assert.ok(tiers.filter((t) => t === 5).length >= 1 + (want >= 9 ? 1 : 0), `tier V: ${tiers}`);
      assert.ok(tiers.filter((t) => t === 'coin').length >= 1 + (want >= 10 ? 1 : 0), `coins: ${tiers}`);
    }
    assert.equal(shopDraftCards(shop, createRng(1), 3, 11).length, 3, 'fewer cards than slots: a subset (solo)');
    // tactic / supply: drawn with replacement, any count
    for (const [modeId, round, family] of [['mode_multi_hard', 11, 'tactic'], ['mode_multi_normal', 6, 'supply']]) {
      const d = generateDraft(forced(modeId, round, family), createRng(n), round, { stageId: 'act2autochess_m01', players: n });
      assert.equal(d.family, family);
      assert.equal(d.cards.length, want, `${family} ${n} alive`);
    }
  }
});

test('机变 in an 8-seat match (1 human + 7 AI): 10 cards, every alive player takes one; the audit agrees', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 7, seed: 77, fake: true }).start();
  const m = h.m;
  const audit = attachAudit(m);
  for (const p of m.players.values()) p.lp = 200;
  const seen = [];
  h.drive(() => {
    if (m.phase === PHASE.SP_DRAFT && m.sp && !seen.includes(m.round)) {
      seen.push(m.round);
      assert.equal(m.sp.cards.length, 10, `R${m.round}`);
      assert.equal(m.publicView().sp.cards.length, 10);
    }
    return m.phase === PHASE.PREP && m.round === 12;
  });
  assert.deepEqual(seen, m.gd.spRounds().filter((r) => r < 12));
  assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
  m.dispose();
});

test('strategy draft: 20 s turns above 4 seats (m.public turnSeconds too), 30 s up to 4 seats', () => {
  for (const [humans, bots, secs] of [[5, 0, 20], [2, 3, 20], [4, 0, BAND_TURN_SECONDS], [2, 2, BAND_TURN_SECONDS]]) {
    const h = makeMatch({ mode: 'coop', humans, bots, seed: 9 }).start();
    const m = h.m;
    const audit = attachAudit(m, { invariants: false });
    for (const ps of m.players.values()) if (!ps.isBot) m.handle(ps.playerId, { t: 'g.infoReady' });
    h.sched.advance(1);
    h.run(() => m.phase === PHASE.BAND_DRAFT && !m.players.get(m.draftTurn())?.isBot, { maxTime: 1000 });
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.equal(m.bandTurnSeconds(), secs, `${humans}+${bots}`);
    assert.equal(Math.round((m.deadline - h.sched.now()) / 1000), secs);
    assert.equal(m.publicView().draft.turnSeconds, secs);
    // idle humans: one whole turn each
    const s0 = h.sched.now();
    h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 20 * secs * 1000 });
    const humansLeft = m.order.filter((p) => !p.isBot).length;
    assert.ok(h.sched.now() - s0 <= humansLeft * secs * 1000 + 50, `${humansLeft} turns of ${secs} s`);
    assert.equal(new Set([...m.players.values()].map((p) => p.bandId)).size, humans + bots, 'distinct strategies');
    assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
    m.dispose();
  }
});

test('机变 timers: 30 s first pick, 12 s later picks above 4 alive (m.public sp.turnSeconds), 16 s up to 4', () => {
  for (const [humans, later] of [[5, 12], [4, 16]]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans, seed: 14, fake: true }).start();
    const m = h.m;
    const audit = attachAudit(m, { invariants: false });
    h.drive(() => m.phase === PHASE.ROUND_START && m.round === 3);
    h.run(() => m.phase === PHASE.SP_DRAFT);
    assert.equal(m.sp.cards.length, humans > 4 ? humans + 2 : 6);
    assert.equal(Math.round((m.deadline - h.sched.now()) / 1000), 30, 'first pick 30 s');
    const pub0 = m.publicView().sp;
    if (humans > 4) assert.equal(pub0.turnSeconds, 30); else assert.ok(!('turnSeconds' in pub0), '1–4: the config timers');
    const [a, b] = m.sp.order;
    assert.deepEqual(m.handle(a, { t: 'g.choice', idx: 0 }), { ok: true });
    assert.equal(Math.round((m.deadline - h.sched.now()) / 1000), later, `later picks ${later} s`);
    const pub1 = m.publicView().sp;
    if (humans > 4) assert.equal(pub1.turnSeconds, 12); else assert.ok(!('turnSeconds' in pub1));
    // b times out: a random remaining card after exactly `later` s
    h.sched.advance(later * 1000 + 1);
    assert.ok(m.sp.picks[b] != null, 'timeout auto-assigns');
    h.drive(() => m.phase === PHASE.PREP && m.round === 3);
    assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
    m.dispose();
  }
});

const fake = (seat, s = {}, layers = 0, lp = 10, alive = true) => ({
  playerId: `p${seat}`, seat, alive, lp, lpAtFinal: lp,
  stats: { bossDamage: 0, merges: 0, itemsEquipped: 0, gold: 0, lpLost: 0, ...s },
  activatedLayers: () => layers,
});

test('titles above 4 players: the one-each pass as before, then each untitled player its best-ranked eligible title (may repeat)', () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  const players = [
    fake(0, { bossDamage: 900, merges: 1, gold: 50, lpLost: 4 }, 100, 5),
    fake(1, { bossDamage: 100, merges: 6, gold: 20, lpLost: 2 }, 300, 9),
    fake(2, { itemsEquipped: 9, gold: 99, lpLost: 9 }, 10, 30),
    fake(3, { merges: 2, gold: 1, lpLost: 1 }, 50, 12),
    fake(4, { bossDamage: 800, merges: 5, gold: 98, itemsEquipped: 8, lpLost: 3 }, 290, 20),
    fake(5, { bossDamage: 50, gold: 10, lpLost: 0 }, 20, 25),
    fake(6, { bossDamage: 700, merges: 4, gold: 97, itemsEquipped: 7, lpLost: 5 }, 280, 18),
    fake(7, {}, 0, 0, false),
  ];
  for (const victory of [true, false]) {
    const first = assignTitles(gd, players, victory, { repeat: false });
    const ids = [...first.values()].map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'the first pass: each title once');
    const all = assignTitles(gd, players, victory);
    for (const [pid, t] of first) assert.equal(all.get(pid).id, t.id, `${pid} keeps its first-pass title`);
    // every player with any eligible title has one; the eliminated one with nothing positive has none
    for (const p of players.slice(0, 7)) assert.ok(all.has(p.playerId), `${p.playerId} titled (${victory ? 'win' : 'loss'})`);
    assert.equal(all.has('p7'), false, 'nothing to be titled for');
    assert.ok(all.size > first.size, 'the second pass titled more players');
    const repeated = [...all.values()].map((t) => t.id);
    assert.ok(new Set(repeated).size < repeated.length, 'a title repeats');
    if (!victory) assert.ok(!repeated.includes('comment_1'), '卫戍之星 still needs a win');
  }
  // 4 players: one pass only (exactly the old result)
  const four = players.slice(0, 4);
  assert.deepEqual(assignTitles(gd, four, true), assignTitles(gd, four, true, { repeat: false }));
});

test('audited FakeBattle matches of 5, 6, 7 and 8 players (all phases incl. multi-field 联防, 机变, Final Assault) report no violations', () => {
  for (const [humans, bots, seed] of [[1, 4, 940], [2, 4, 941], [1, 6, 942], [3, 5, 943]]) {
    const n = humans + bots;
    // every round the seats with (seat + round) % 4 = 0 leak 1–3 enemies (1–2 leakers, the other 3–6 perfect: with more
    // than 4 alive that is 2 联防 fields), and one enemy of each 联防 field's first leaker survives there (a bill)
    let h = null;
    const script = (b) => {
      if (b.kind === 'normal') {
        const ps = h.m.players.get(b.players[0]);
        return ps && (ps.seat + b.round) % 4 === 0 ? { leaks: { [ps.playerId]: 1 + (b.round % 3) } } : {};
      }
      if (b.kind === 'unite' && b.spawns.length) return { survivors: { [b.spawns[0].sourcePlayerId]: 1 } };
      return {};
    };
    h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans, bots, seed, fake: true, script });
    h.autoHumans();
    const audit = attachAudit(h.m);
    h.start();
    for (const ps of h.m.players.values()) ps.lp = 200;
    h.runToEnd({ maxSteps: 3e6 });
    assert.deepEqual(audit.violations, [], `${n} players:\n${audit.violations.join('\n')}`);
    assert.equal(h.m.phase, PHASE.RESULT);
    assert.equal(h.m.errorCount, 0, JSON.stringify(h.m.errors.slice(0, 2)));
    // 联防 really ran, on several fields (each field its own battle): the rounds with a 联防, those with a second field u2
    const unite = FakeBattle.instances.filter((b) => b.kind === 'unite');
    const uniteRounds = new Set(unite.map((b) => b.round));
    const multiRounds = new Set(unite.filter((b) => b.fieldId === 'u2').map((b) => b.round));
    assert.ok(uniteRounds.size >= 3, `${n} players: 联防 in ${uniteRounds.size} rounds`);
    assert.ok(multiRounds.size >= 3, `${n} players: a multi-field 联防 in ${multiRounds.size} rounds`);
    assert.ok(unite.every((b) => b.fieldId !== 'u2' || unite.some((u) => u.fieldId === 'u' && u.round === b.round)), 'u2 only beside u');
    assert.ok(unite.some((b) => b.fieldId === 'u' && b.spawns.length) && unite.some((b) => b.fieldId === 'u2' && b.spawns.length), `${n} players: leakers on both fields`);
    checkInvariants(h.m);
    h.m.dispose();
  }
});
