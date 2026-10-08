// 联防 with more than 4 alive players (remake extension, owner's decision; server/match/unite.js header, docs/META.md §4,
// DESIGN §F1.4): alive ≤ 4 → the official single field 'u' (≤ 2 helpers, every leaker's enemies on it, exactly as the
// rest of the suite pins it); alive > 4 → k = ⌈alive / 4⌉, helpers = the top 2k perfect players by the helper ranking,
// fields = min(k, leakers, ⌈helpers / 2⌉) with ids 'u', 'u2', …, the helpers 2 per field in ranking order, the leakers spread
// over the fields balancing their counted leaks (largest first to the least-loaded field), each field a normal 联防 with
// only its own leakers' enemies, each leaker billed from its own field. Covered here: the planning rules, both combat
// modes (server-run streaming fields; client-side combat with one field on a client and the other on the server, a
// helper disconnecting mid-联防), the public view contract (`unite.fields` only with several fields), watching, the live
// counter, each helper's bounty coins / damage / kills and every player's onBattleResult `unite` from its own field, a
// field that could not run, fewer leakers than fields (no empty field), and the rule audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { validateC2S, RESULT_LIMITS } from '../../shared/protocol.js';
import { GameData } from '../../server/match/gamedata.js';
import { uniteFieldId, uniteFieldBudget, uniteFieldCount, uniteGroups, uniteBills, assignLeakers, planUnite } from '../../server/match/unite.js';
import { attachAudit } from '../../server/match/audit.js';
import { deriveSeed } from '../../server/sim/rng.js';
import { fitResult, RESULT_FRAME_BUDGET } from '../../server/sim/spec.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch, give, chessOfTier, legalTileFor, checkInvariants } from './harness.js';

const uniteBattles = () => FakeBattle.instances.filter((b) => b.kind === 'unite');
const ids = (list) => list.map((p) => p.playerId);
const pub = (m, pid) => m.publicView().players.find((p) => p.playerId === pid);

/** a deployed unit for `ps` (helpers with more units are ranked first) */
function deployOne(m, ps, n = 1) {
  const pool = chessOfTier(1).filter((x) => m.pool.has(x));
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const id = pool.find((x) => !used.has(x) && legalTileFor(m, ps, x));
    used.add(id);
    give(m, ps, id, 'board', legalTileFor(m, ps, id));
  }
}

test('rules: field ids u, u2, …; one field up to 4 alive, ⌈alive / 4⌉ above (never in solo); the leaker balance', () => {
  assert.deepEqual([0, 1, 2, 3].map(uniteFieldId), ['u', 'u2', 'u3', 'u4']);
  const gd = new GameData(DATA, 'mode_multi_normal');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => uniteFieldBudget(gd, n)), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(uniteFieldBudget(gd, 9), 3, 'the rule itself: ⌈alive / 4⌉');
  assert.equal(uniteFieldBudget(gd, undefined), 1);
  assert.equal(uniteFieldBudget(new GameData(DATA, 'mode_single_normal'), 8), 1, 'never in solo');
  // the fields a round asks for: the budget capped by the leakers (never a field without a leaker)
  assert.deepEqual([0, 1, 2, 3].map((l) => uniteFieldCount(gd, 8, l)), [1, 1, 2, 2]);
  assert.deepEqual([1, 2, 3, 4].map((n) => uniteFieldCount(gd, n, 3)), [1, 1, 1, 1], 'one field up to 4 alive');
  assert.equal(uniteFieldCount(gd, 9, 2), 2);
  // largest leaker first (equal leaks: lower seat) to the least-loaded field, the lowest index on a tie
  const P = (seat, n) => ({ playerId: `x${seat}`, seat, n });
  const ls = [P(0, 2), P(1, 6), P(2, 3), P(3, 3), P(4, 1)];
  const at = assignLeakers(2, ls, (p) => p.n);
  // x1 (6) → 0 [6, 0]; x2 (3) → 1 [6, 3]; x3 (3) → 1 [6, 6]; x0 (2) → 0 on the tie [8, 6]; x4 (1) → 1 [8, 7]
  assert.deepEqual(ls.map((p) => at.get(p)), [0, 0, 1, 1, 1]);
});

test('6 alive, 3 perfect: two fields — u (top 2 by units, the first on the right half) and u2 (1 helper, escaped_single); leakers balanced; each leaker billed from its own field (server-run fields)', () => {
  const script = (b) => {
    if (b.kind === 'normal') return { leaks: { p_0: 6, p_1: 3, p_2: 2 } };
    // a survivor listed on a field that does not hold that leaker is never billed (p_1 is on u2)
    if (b.kind === 'unite' && b.fieldId === 'u') return { survivors: { p_0: 4, p_1: 5 } };
    if (b.kind === 'unite' && b.fieldId === 'u2') return { survivors: { p_1: 1, p_2: 12 } };
    return {};
  };
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 61, fake: true, script });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  // p_5 fields 2 units, p_3 1: selection p_5 > p_3 > p_4 (seat) → u = [p_5, p_3] (pair order: p_5 first), u2 = [p_4]
  deployOne(m, h.ps('p_5'), 2);
  deployOne(m, h.ps('p_3'), 1);
  h.drive(() => m.phase === PHASE.UNITE);
  const plan = m.unitePlan;
  assert.deepEqual(ids(plan.helpers), ['p_5', 'p_3', 'p_4'], 'top 2k = 4 helpers wanted, 3 perfect');
  assert.deepEqual(ids(plan.leakers), ['p_0', 'p_1', 'p_2']);
  const groups = uniteGroups(plan);
  assert.deepEqual(groups.map((g) => [g.fieldId, ids(g.helpers), ids(g.leakers)]), [
    ['u', ['p_5', 'p_3'], ['p_0']],
    // p_0 (6) → u; p_1 (3) → u2 (0 < 6); p_2 (2) → u2 (3 < 6)
    ['u2', ['p_4'], ['p_1', 'p_2']],
  ]);
  assert.equal(plan.leaked.length, 11, 'the union keeps every leak');
  assert.deepEqual(groups.map((g) => g.leaked.length), [6, 5]);
  // the battles: own seeds, own templates, own leakers' enemies only, colOffsets as with one field
  const [u, u2] = uniteBattles();
  assert.deepEqual([u.fieldId, u2.fieldId], ['u', 'u2']);
  assert.equal(u.opts.seed, deriveSeed(m.seed, 'u:1'), 'field u keeps the official seed');
  assert.equal(u2.opts.seed, deriveSeed(m.seed, 'u2:1'));
  assert.equal(u.opts.waveId, m.gd.unite.templates['2']);
  assert.equal(u2.opts.waveId, m.gd.unite.templates['1']);
  assert.deepEqual(u.opts.players.map((p) => [p.playerId, p.colOffset]), [['p_5', 8], ['p_3', 0]]);
  assert.deepEqual(u2.opts.players.map((p) => [p.playerId, p.colOffset]), [['p_4', 0]]);
  assert.deepEqual([...new Set(u.opts.spawns.map((s) => s.sourcePlayerId))], ['p_0']);
  assert.equal(u.opts.spawns.length, 6);
  assert.deepEqual(u2.opts.spawns.map((s) => s.sourcePlayerId).sort(), ['p_1', 'p_1', 'p_1', 'p_2', 'p_2']);
  // the view: the union plus fields (several fields only); fields[] in field order; statuses; live counters
  const v = m.publicView();
  assert.deepEqual(v.unite, {
    helpers: ['p_5', 'p_3', 'p_4'], leakers: ['p_0', 'p_1', 'p_2'],
    fields: [{ fieldId: 'u', helpers: ['p_5', 'p_3'], leakers: ['p_0'] }, { fieldId: 'u2', helpers: ['p_4'], leakers: ['p_1', 'p_2'] }],
  });
  assert.deepEqual(v.fields.map((f) => [f.fieldId, f.kind, f.players]), [['u', 'unite', ['p_5', 'p_3']], ['u2', 'unite', ['p_4']]]);
  assert.deepEqual(['p_3', 'p_4', 'p_5', 'p_0', 'p_1', 'p_2'].map((pid) => pub(m, pid).status), ['helping', 'helping', 'helping', 'done', 'done', 'done']);
  assert.deepEqual(['p_0', 'p_1', 'p_2'].map((pid) => pub(m, pid).uniteLeft), [6, 3, 2], 'sent in, before the fields end');
  // default watching: a helper its own field, a leaker the field holding its enemies, anyone else the first
  assert.deepEqual(['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5'].map((pid) => h.lastTo(pid, 'm.field').fieldId), ['u', 'u2', 'u2', 'u', 'u2', 'u']);
  // server-run streaming: anyone may switch fields
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'u2' }), { ok: true });
  assert.equal(h.lastTo('p_0', 'm.field').fieldId, 'u2');
  h.run(() => m.fields.length === 2 && m.fields.every((f) => !f.live));
  assert.deepEqual(['p_0', 'p_1', 'p_2'].map((pid) => pub(m, pid).uniteLeft), [4, 1, 12], 'each leaker\'s survivors on its own field');
  assert.deepEqual(['p_0', 'p_1', 'p_2'].map((pid) => pub(m, pid).pendingLp), [4, 1, 10]);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5'].map((pid) => h.ps(pid).lp), [36, 39, 30, 40, 40, 40]);
  checkInvariants(m);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('6 alive, 2 fields: each helper\'s 联防 bounty coins, damage and kills, and every player\'s onBattleResult `unite`, come from its own field', () => {
  const script = (b) => {
    if (b.kind === 'normal') return { leaks: { p_0: 2, p_1: 2 } };
    if (b.kind === 'unite' && b.fieldId === 'u') return { survivors: { p_0: 1 }, coins: { p_2: 3, p_3: 4 }, damage: { p_2: 100, p_3: 200 } };
    if (b.kind === 'unite' && b.fieldId === 'u2') return { coins: { p_4: 5, p_5: 6 }, damage: { p_4: 300, p_5: 400 } };
    return {};
  };
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 68, fake: true, script });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  h.drive(() => m.phase === PHASE.UNITE);
  // equal leaks: p_0 (lower seat) → u, p_1 → u2; the helpers by seat (no units anywhere)
  assert.deepEqual(uniteGroups(m.unitePlan).map((g) => [g.fieldId, ids(g.helpers), ids(g.leakers)]), [['u', ['p_2', 'p_3'], ['p_0']], ['u2', ['p_4', 'p_5'], ['p_1']]]);
  const all = ['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5'];
  const before = new Map(all.map((pid) => {
    const ps = h.ps(pid);
    const own = m.lastResults.get(pid);
    assert.equal(own.coins, 0, `${pid}: no bounty coins from its own battle`);
    assert.equal(ps.bounties.length, 0);
    return [pid, { funds: ps.pendingFunds, gained: ps.stats.fundsGained, dmg: ps.stats.dmgDealt, kills: ps.stats.kills, ownKilled: own.killed, ownDmg: own.damageDealt }];
  }));
  const uniteSeen = new Map();
  const dispatch = m.dispatch.bind(m);
  m.dispatch = (ps, hook, ev, ...rest) => {
    if (hook === 'onBattleResult' && !ev?.boss) uniteSeen.set(ps.playerId, ev.unite);
    return dispatch(ps, hook, ev, ...rest);
  };
  h.drive(() => m.phase === PHASE.SETTLE);
  // the 联防 share of each player: [coins, damage, kills] (u's first helper killed 2 − 1 survivor, u2's 2; a FakeBattle
  // credits the kills to a field's first helper); a leaker has none
  const share = { p_0: [0, 0, 0], p_1: [0, 0, 0], p_2: [3, 100, 1], p_3: [4, 200, 0], p_4: [5, 300, 2], p_5: [6, 400, 0] };
  for (const pid of all) {
    const ps = h.ps(pid);
    const b = before.get(pid);
    const [coins, dmg, kills] = share[pid];
    assert.equal(ps.pendingFunds - b.funds, coins, `${pid}: its own field's bounty coins`);
    assert.equal(ps.stats.fundsGained - b.gained, coins, `${pid}: fundsGained`);
    assert.equal(ps.stats.dmgDealt - b.dmg, b.ownDmg + dmg, `${pid}: its own battle's damage + its own field's`);
    assert.equal(ps.stats.kills - b.kills, b.ownKilled + kills, `${pid}: kills`);
  }
  // onBattleResult `unite`: the result of the player's own field — a helper's, a leaker's (the field holding its enemies)
  const fieldOf = (r) => Object.keys(r?.perPlayer || {}).sort().join('+');
  assert.deepEqual(all.map((pid) => fieldOf(uniteSeen.get(pid))), ['p_2+p_3', 'p_4+p_5', 'p_2+p_3', 'p_2+p_3', 'p_4+p_5', 'p_4+p_5']);
  assert.deepEqual([h.ps('p_0').lp, h.ps('p_1').lp], [39, 40], 'and each leaker billed from its own field');
  checkInvariants(m);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('a field whose battle cannot run charges its own leakers their own leaks; the other field still bills its survivors', () => {
  const script = (b) => {
    if (b.kind === 'normal') return { leaks: { p_0: 7, p_1: 4 } };
    if (b.kind === 'unite' && b.fieldId === 'u2') return { throwInCtor: true };
    if (b.kind === 'unite') return { survivors: { p_0: 1 } };
    return {};
  };
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 62, fake: true, script });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  h.drive(() => m.phase === PHASE.UNITE);
  assert.deepEqual(uniteGroups(m.unitePlan).map((g) => [g.fieldId, ids(g.helpers), ids(g.leakers)]), [['u', ['p_2', 'p_3'], ['p_0']], ['u2', ['p_4', 'p_5'], ['p_1']]]);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.equal(h.ps('p_0').lp, 39, 'u ran: 1 survivor');
  assert.equal(h.ps('p_1').lp, 36, 'u2 could not run: its own 4 leaks');
  assert.ok(m.errorCount >= 1, 'the constructor failure was reported');
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('8 alive, 1 perfect: one field u holding all 7 leakers (no `unite.fields`); b.progress `left` with 7 keys is valid', () => {
  const leaks = { p_0: 3, p_1: 2, p_2: 4, p_3: 1, p_4: 2, p_5: 5, p_6: 1 };
  const h = makeMatch({ mode: 'coop', humans: 8, seed: 63, fake: true, script: (b) => (b.kind === 'normal' ? { leaks } : {}) });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  h.drive(() => m.phase === PHASE.UNITE);
  const v = m.publicView();
  assert.deepEqual(v.unite, { helpers: ['p_7'], leakers: ['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6'] }, 'one field: the official view');
  assert.deepEqual(v.fields.map((f) => f.fieldId), ['u']);
  const [u] = uniteBattles();
  assert.equal(u.opts.spawns.length, 18);
  assert.equal(u.opts.waveId, m.gd.unite.templates['1']);
  assert.equal(RESULT_LIMITS.players >= 7, true);
  const left = Object.fromEntries(Object.keys(leaks).map((pid) => [pid, 1]));
  assert.equal(validateC2S({ t: 'b.progress', battleId: 'x.1.1.u', gt: 3, killed: 0, total: 18, done: false, leaks: 0, left }), null);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('5 alive, 1 leaker, 4 perfect: one field (fields = min(k, leakers, ⌈helpers / 2⌉)) with the top 2 helpers — no empty 联防', () => {
  const h = makeMatch({ mode: 'coop', humans: 5, seed: 64, fake: true, script: (b) => (b.kind === 'normal' ? { leaks: { p_2: 3 } } : {}) });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  h.drive(() => m.phase === PHASE.UNITE);
  const groups = uniteGroups(m.unitePlan);
  assert.deepEqual(groups.map((g) => [g.fieldId, g.helpers.length, ids(g.leakers), g.leaked.length]), [['u', 2, ['p_2'], 3]]);
  assert.deepEqual(m.fields.filter((f) => f.kind === 'unite').map((f) => f.fieldId), ['u']);
  assert.equal(m.publicView().unite.fields, undefined, 'one field: the official view, no fields list');
  assert.deepEqual(uniteBattles().map((b) => b.fieldId), ['u']);
  assert.equal(uniteBattles()[0].opts.waveId, m.gd.unite.templates['2']);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('6 alive, 2 leakers, 4 perfect: two fields, one leaker each', () => {
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 66, fake: true, script: (b) => (b.kind === 'normal' ? { leaks: { p_1: 2, p_4: 5 } } : {}) });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  h.drive(() => m.phase === PHASE.UNITE);
  const groups = uniteGroups(m.unitePlan);
  assert.deepEqual(groups.map((g) => [g.fieldId, g.helpers.length, ids(g.leakers)]), [['u', 2, ['p_4']], ['u2', 2, ['p_1']]]);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});
test('client-side combat, 4 humans + 4 AI: the AI pair\'s field runs on the server, the humans\' on a client; a helper disconnecting mid-联防 hands its field to the server; settlement per field', () => {
  const script = (b) => {
    // (a human's leaks stay within the round's spawn entries: the client result must stay plausible)
    if (b.kind === 'normal') return { leaks: { p_0: 4, ai_0: 3, ai_1: 2, p_1: 1 } };
    if (b.kind === 'unite') return { survivors: b.fieldId === 'u' ? { p_0: 3 } : { ai_0: 2, ai_1: 11 } };
    return {};
  };
  // p_2's browser starts its battles late: the 联防 field it would simulate is still running when it drops
  const h = makeMatch({ mode: 'coop', humans: 4, bots: 4, seed: 65, fake: true, clientCombat: true, script, perPlayer: { p_2: { delayMs: 6000 } } });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  // the humans' boards outrank the AI ones (more units): u = the human pair, u2 = the AI pair
  deployOne(m, h.ps('p_2'), 6);
  deployOne(m, h.ps('p_3'), 5);
  h.drive(() => m.phase === PHASE.UNITE);
  const groups = uniteGroups(m.unitePlan);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => [g.fieldId, ids(g.leakers)]), [['u', ['p_0', 'p_1']], ['u2', ['ai_0', 'ai_1']]], 'p_0 (4) → u, ai_0 (3) → u2, ai_1 (2) → u2, p_1 (1) → u (the tie)');
  assert.deepEqual(ids(groups[0].helpers), ['p_2', 'p_3']);
  assert.ok(groups[1].helpers.every((p) => p.isBot));
  const [fu, fu2] = m.fields;
  assert.deepEqual([fu.fieldId, fu.mode, fu.authority], ['u', 'client', 'p_2']);
  assert.deepEqual([fu2.fieldId, fu2.mode], ['u2', 'server']);
  assert.notEqual(fu.battleId, fu2.battleId);
  const starts = h.sent.filter(([, x]) => x.t === 'b.start' && x.kind === 'unite').map(([pid, x]) => `${pid}:${x.fieldId}:${x.authoritative ? 'A' : x.watch ? 'w' : 'r'}`).sort();
  assert.deepEqual(starts, ['p_0:u:w', 'p_1:u:w', 'p_2:u:A', 'p_3:u:r'], 'helpers their field, the leakers the field with their enemies');
  // watching: a helper stays on its running field; a leaker may look at the other field
  assert.equal(m.handle('p_3', { t: 'g.watch', fieldId: 'u2' }).error, 'WRONG_PHASE');
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'u2' }), { ok: true });
  assert.equal(h.lastTo('p_0', 'b.start').fieldId, 'u2');
  // the authority's live counter (b.progress `left`) is read per field
  assert.deepEqual(m.handle('p_2', { t: 'b.progress', battleId: fu.battleId, gt: 2, killed: 1, total: 7, done: false, leaks: 0, left: { p_0: 4, p_1: 1 } }), { ok: true });
  assert.deepEqual([pub(m, 'p_0').uniteLeft, pub(m, 'p_1').uniteLeft], [4, 1]);
  assert.deepEqual([pub(m, 'ai_0').uniteLeft, pub(m, 'ai_1').uniteLeft], [3, 2], 'u2: sent in until its result is released');
  // the helper drops mid-联防: its field is re-simulated on the server, the other field is untouched
  m.onDisconnect('p_2');
  assert.deepEqual([fu.mode, fu2.mode], ['server', 'server']);
  assert.equal(m.phase, PHASE.UNITE);
  h.run(() => fu.done && fu2.done);
  assert.equal(m.phase, PHASE.UNITE, 'the COMBAT_END pause');
  assert.deepEqual(m.handle('p_3', { t: 'g.watch', fieldId: 'u2' }), { ok: true }, 'its own field is done: free to look');
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(['p_0', 'p_1', 'ai_0', 'ai_1', 'p_2', 'p_3'].map((pid) => h.ps(pid).lp), [37, 40, 38, 30, 40, 40]);
  assert.equal(m.verifyStats.takeovers, 1);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('client-side combat: both fields on clients report their own results (accepted), each billed to its own leakers', () => {
  const script = (b) => {
    if (b.kind === 'normal') return { leaks: { p_0: 2, p_1: 4 } };
    if (b.kind === 'unite') return { survivors: b.fieldId === 'u' ? { p_1: 2 } : { p_0: 1 } };
    return {};
  };
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 66, fake: true, clientCombat: true, script });
  const audit = attachAudit(h.m);
  h.start();
  const m = h.m;
  h.toPrep(1);
  for (const ps of m.players.values()) ps.lp = 40;
  h.drive(() => m.phase === PHASE.UNITE);
  assert.deepEqual(uniteGroups(m.unitePlan).map((g) => [g.fieldId, ids(g.helpers), ids(g.leakers)]), [['u', ['p_2', 'p_3'], ['p_1']], ['u2', ['p_4', 'p_5'], ['p_0']]]);
  assert.deepEqual(m.fields.map((f) => [f.fieldId, f.mode, f.authority]), [['u', 'client', 'p_2'], ['u2', 'client', 'p_4']]);
  // a resync with no field picked: a leaker gets the field holding its enemies; a spectator seat follows the first
  // player still in (0.2.0, community report item 56: p_0, a leaker) — the field holding that leaker's enemies
  m.watchers.delete('p_0');
  m.onReconnect('p_0');
  assert.deepEqual([h.lastTo('p_0', 'b.start').fieldId, h.lastTo('p_0', 'b.start').watch], ['u2', true]);
  m.addSpectator('s_1');
  assert.equal(h.lastTo('s_1', 'b.start').fieldId, 'u2');
  assert.deepEqual(m.handle('s_1', { t: 'g.watch', fieldId: 'u' }), { ok: true });
  assert.equal(h.lastTo('s_1', 'b.start').fieldId, 'u');
  h.run(() => m.fields.every((f) => f.done));
  assert.deepEqual(m.fields.map((f) => f.resultSource), ['client', 'client']);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.deepEqual(['p_0', 'p_1'].map((pid) => h.ps(pid).lp), [39, 38]);
  assert.equal(m.verifyStats.rejected, 0);
  assert.deepEqual(audit.violations, []);
  m.dispose();
});

test('1–4 alive: the plan is the official one field (its group shares the plan\'s arrays), no `unite.fields`', () => {
  const h = makeMatch({ mode: 'coop', humans: 4, seed: 67, fake: true, script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 2, p_3: 1 } } : {}) }).start();
  const m = h.m;
  h.toPrep(1);
  h.drive(() => m.phase === PHASE.UNITE);
  const plan = m.unitePlan;
  assert.equal(plan.groups.length, 1);
  const [g] = plan.groups;
  assert.equal(g.fieldId, 'u');
  assert.ok(g.helpers === plan.helpers && g.leakers === plan.leakers && g.leaked === plan.leaked && g.notReentered === plan.notReentered);
  assert.equal('fields' in m.publicView().unite, false);
  // the same plan again from the same results (planUnite is pure)
  const again = planUnite(m, m.lastResults);
  assert.deepEqual([ids(again.helpers), ids(again.leakers), again.leaked.length], [ids(plan.helpers), ids(plan.leakers), plan.leaked.length]);
  m.dispose();
});

test('fitResult: a 联防 result of several leakers\' rounds still over the frame budget keeps every leak with only the keys settlement reads', () => {
  const leak = (src, i) => ({ enemyKey: `enemy_10${String(i % 90).padStart(2, '0')}_slime_long_name`, mods: null, lpr: 1, sourcePlayerId: src, tag: null, counted: true, spawned: true });
  const leaked = Array.from({ length: 400 }, (_, i) => leak(`p_${i % 7}`, i));
  const unspawned = Array.from({ length: 400 }, (_, i) => ({ enemyKey: `enemy_10${String(i % 90).padStart(2, '0')}_slime_long_name`, sourcePlayerId: `p_${i % 7}`, tag: null, time: 12.5 }));
  const pp = { killed: 0, total: 800, leaked, perfect: false, layerGains: {}, coins: 0, damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [] };
  const big = { reason: 'timeout', time: 60, killed: 0, total: 800, errors: 0, perPlayer: { h_1: pp }, unspawned };
  const size = (r) => JSON.stringify({ t: 'b.result', battleId: 'b', result: r, rid: 2147483647 }).length;
  assert.ok(size(big) > RESULT_FRAME_BUDGET);
  const fit = fitResult(big, { battleId: 'b' });
  assert.ok(size(fit) <= RESULT_FRAME_BUDGET, `${size(fit)}`);
  assert.equal(fit.perPlayer.h_1.leaked.length, 400);
  assert.equal(fit.unspawned.length, 400);
  assert.deepEqual(fit.perPlayer.h_1.leaked[8], { enemyKey: leaked[8].enemyKey, sourcePlayerId: 'p_1' });
  assert.deepEqual(fit.unspawned[3], { enemyKey: unspawned[3].enemyKey, sourcePlayerId: 'p_3' });
  assert.equal(validateC2S({ t: 'b.result', battleId: 'x.1.1.u', result: fit }), null, 'still a valid b.result');
});
