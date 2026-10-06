// test/content/waiguan/char_4228_closur.test.js — 可露希尔 外援 kit (server/sim/content/kits/waiguan/char_4228_closur.js).
// Every skill (normal Lv4 + elite Lv7), both talents (the 指挥中心 and 极限调度's ATK and 部署费用下限), the trait (援军 ×1.5),
// TAC-X, the 指挥中心's life cycle, both tiers' elites × every module × every skill, two copies, two players on one field.
// Expected numbers come from the records (skill bb, talents, token variants) — never literals. DP is read from the
// player's pool before / after (most tests freeze the natural regen: flags.dpPerSec 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, chessRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';
import { GameData } from '../../../server/match/gamedata.js';
import { absoluteRangeKeys } from '../../../server/sim/targeting.js';
import { batMod } from '../../../server/sim/content/kits/waiguan/_lib.js';
import { COLS } from '../../../server/sim/constants.js';

const CHAR = 'char_4228_closur';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const EL5 = ID5.replace(/_a$/, '_b'), EL6 = ID6.replace(/_a$/, '_b');
const S1 = 'skchr_closur_1', S2 = 'skchr_closur_2', S3 = 'skchr_closur_3';
const TACX = 'uniequip_002_closur';
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const REC = waiguanRecords(DATA.waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const GD = new GameData(DATA, 'mode_multi_normal', { chess: REC });
const CC = REC[ID6].talents.find((t) => t.index === 0).tokenKey;
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const sbb = (id, sid) => skillOf(id, sid).bb;
/** The loadout-resolved record of `id` with module `moduleId` (null = default, 'none'). */
const loadout = (id, moduleId = null) => DS.getChess(id, { moduleId }).raw;
const talOf = (id, i, moduleId = null) => loadout(id, moduleId).talents.find((t) => t.index === i)?.bb ?? {};
/** The TAC-X damage factor of a loadout (1: no module part). */
const cutOf = (id, moduleId = null) => loadout(id, moduleId).talents.find((t) => t.index === -1)?.bb?.damage_scale ?? 1;
const traitScale = (id, moduleId = null) => loadout(id, moduleId).trait.bb.atk_scale;
/** The 指挥中心's effect range of a loadout (the token variant's skill grid). */
const fieldGrid = (id, skillIndex, moduleId = null) => DS.getToken(CC, id, DS.getChess(id, { skillIndex, moduleId }).loadout).skill.rangeGrid;
/** A synthetic operator of faction `nation` (cost 10, 5 s redeploy). */
const op = (id, nation, o = {}) => ({
  ...chessRec({ id, profession: 'WARRIOR', skill: null, stats: { maxHp: 1e5, atk: 1, def: 0, blockCnt: 1, cost: 10, respawnTime: 5, ...(o.stats || {}) }, rangeGrid: [[0, 0], [0, 1]] }),
  nationId: nation,
});
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = {
  chess: { ...REC, test_rhodes_a: op('test_rhodes_a', 'rhodes'), test_lungmen_a: op('test_lungmen_a', 'lungmen'), test_odd_a: op('test_odd_a', 'rhodes', { stats: { cost: 11 } }), test_armour_a: op('test_armour_a', 'rhodes', { stats: { def: 300 } }), test_cheap_a: op('test_cheap_a', 'rhodes', { stats: { cost: 3 } }) },
  enemies: { enemy_dummy: dummy('enemy_dummy'), enemy_hitter: dummy('enemy_hitter', { atk: 3000 }), enemy_shooter: dummy('enemy_shooter', { atk: 1500, range: 9 }), enemy_walker: dummy('enemy_walker', { speed: 0.6 }) },
};
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'death', 'deploy', 'kill', 'attack'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 400, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** 可露希尔 (uid 1) with skill `sid`. */
const C = (id, sid, row, col, o = {}) => ({ uid: 1, chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
/** Her 指挥中心 hand piece(s) for a loadout — GameData.placeableTokens (KIT_CONVENTIONS 16) — on the given tiles. */
const pieces = (id, sid, tiles, { ownerUid = 1, uid = 2 } = {}) => GD.placeableTokens(id, { skillIndex: skillOf(id, sid).index })
  .flatMap(({ tokenId, count }) => Array.from({ length: count }, () => tokenId))
  .map((tokenId, i) => ({ uid: uid + i, kind: 'token', tokenId, ownerUid, row: tiles[i][0], col: tiles[i][1] }));
const A = (uid, chessId, row, col, o = {}) => ({ uid, chessId, row, col, ...o });
const READY = { sp: 999 };
const FROZEN_DP = (dp) => ({ dpInit: dp, dpPerSec: 0 });
const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const dpOf = (h, pid = 'p1') => h.b.getPlayer(pid).dp;
/** Step until `pred`, recording every DP change of player p1 (time, delta) beyond the natural regen. */
function dpLog(h, seconds, pid = 'p1') {
  const out = [];
  let last = dpOf(h, pid);
  const end = h.b.time + seconds;
  while (h.b.time < end - 1e-9) {
    h.step(1);
    const now = dpOf(h, pid), d = now - last - h.b.flags.dpPerSec * h.b.dt;
    if (Math.abs(d) > 1e-6) out.push({ t: h.b.time, d });
    last = now;
  }
  return out;
}
/** Damage of one forced attack of `u` on `e` (her arrow lands a little later). */
function hitOnce(h, u, e) {
  const n0 = h.hooksOf('damaged').length;
  h.b.forceAttack(u, [e]);
  h.runUntil(() => h.hooksOf('damaged').slice(n0).some((c) => c.source === u && c.target === e && c.dmg.isAttack), 3);
  return h.hooksOf('damaged').slice(n0).find((c) => c.source === u && c.target === e && c.dmg.isAttack).amount;
}

test('可露希尔: every skill of both tiers (normal + elite, every module) is hand-authored; her hand holds one 指挥中心', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      const mods = cid.endsWith('_b') ? [null, 'none', ...(rec(cid).modules ?? []).map((m) => m.uniEquipId)] : [null];
      for (const s of rec(cid).skills) {
        for (const moduleId of mods) assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
        const want = DATA.tokens[CC].variants[cid].stats.deployLimit;
        assert.deepEqual(GD.placeableTokens(cid, { skillIndex: s.index }), [{ tokenId: CC, count: want }], `${cid} ${s.skillId} hand`);
      }
    }
  }
});

test('可露希尔 trait: ×atk_scale on enemies blocked by her 援军 — her 指挥中心 and her units on its 效果范围 (per skill); no generic 援军', () => {
  for (const id of [ID6, EL6]) for (const sid of [S1, S2, S3]) {
    const si = skillOf(id, sid).index;
    const field = new Set(absoluteRangeKeys(fieldGrid(id, si), 10, 5, 'RIGHT', 0));
    // allies at (0,+1) / (+1,+1) / (0,+2) of the 指挥中心 at (10,5); one outside her field at (9,3); each blocks a dummy
    const tiles = [[10, 6], [11, 6], [10, 7], [9, 3]];
    const h = run({
      units: [C(id, sid, 10, 3), ...pieces(id, sid, [[10, 5]]), ...tiles.map(([r, c], i) => A(3 + i, 'test_rhodes_a', r, c))],
      enemies: [[10, 5], ...tiles, [11, 4]].map((pos) => ({ key: 'enemy_dummy', pos })),
      flags: FROZEN_DP(0),
    });
    h.run(0.5);
    const u = h.unit(1), t = h.unit(2);
    assert.ok(t && t.alive && t.defId === CC, 'her 指挥中心 piece stands');
    assert.equal(u.trait.reinforcement, t);
    assert.ok(!h.b.allyUnits.some((x) => x.defId === 'token_tactician_reinforce'), 'no generic 援军');
    const es = h.enemies();
    const byTile = (r, c) => es.find((e) => Math.round(e.y) === r && Math.round(e.x) === c);
    const sc = traitScale(id);
    assert.equal(byTile(10, 5).blockedBy, t);
    close(u.profile.dmgMul(h.b, u, byTile(10, 5)), sc, 1e-12, `${id} ${sid} blocked by the 指挥中心`);
    for (const [r, c] of tiles) {
      const e = byTile(r, c);
      assert.ok(e.blockedBy && e.blockedBy.uid >= 3, `${r},${c} blocked by an ally`);
      const want = field.has(r * COLS + c) ? sc : 1;
      close(u.profile.dmgMul(h.b, u, e), want, 1e-12, `${id} ${sid} ally at ${r},${c}`);
    }
    close(u.profile.dmgMul(h.b, u, byTile(11, 4)), 1, 1e-12, 'an enemy nobody blocks');
    // the arrow itself: ATK × atk_scale (DEF 0) on the 指挥中心's enemy, ATK × 1 on the free one
    if (sid === S1) {
      const atk = u.s.atk;
      close(hitOnce(h, u, byTile(10, 5)), atk * sc, 1e-6, 'arrow on a 援军-blocked enemy');
      close(hitOnce(h, u, byTile(11, 4)), atk, 1e-6, 'arrow on a free enemy');
    }
    done(h);
  }
});

test('可露希尔 TAC-X: a 援军 takes damage_scale × the damage of an enemy it blocks (module none / normal: ×1; unblocked attacker ×1)', () => {
  for (const [id, moduleId] of [[EL6, null], [EL5, null], [EL6, 'none'], [ID6, null]]) {
    const cut = cutOf(id, moduleId);
    if (moduleId === null && id !== ID6) assert.ok(cut < 1, `${id}: the default module carries TAC-X`);
    const h = run({
      units: [C(id, S1, 10, 3, { moduleId }), ...pieces(id, S1, [[10, 5]]), A(3, 'test_rhodes_a', 11, 5), A(4, 'test_rhodes_a', 9, 4)],
      enemies: [{ key: 'enemy_hitter', pos: [10, 5] }, { key: 'enemy_hitter', pos: [11, 5] }, { key: 'enemy_hitter', pos: [9, 4] }],
      flags: FROZEN_DP(0),
    });
    h.run(6);
    const t = h.unit(2), inField = h.unit(3), outside = h.unit(4);
    const first = (x) => h.hooksOf('damaged').find((c) => c.target === x && c.source?.side === 'enemy');
    const raw = (x) => Math.max(3000 - x.s.def, 0.05 * 3000);
    close(first(t).amount, raw(t) * cut, 1e-6, `${id} ${moduleId} 指挥中心`);
    close(first(inField).amount, raw(inField) * cut, 1e-6, `${id} ${moduleId} ally in the 效果范围`);
    close(first(outside).amount, raw(outside), 1e-6, `${id} ${moduleId} ally outside`);
    done(h);
  }
  // an attacker the 指挥中心 does not block: ×1
  const h = run({ units: [C(EL6, S1, 10, 3), ...pieces(EL6, S1, [[10, 5]])], enemies: [{ key: 'enemy_shooter', pos: [9, 9] }], flags: FROZEN_DP(0) });
  h.run(8);
  const t = h.unit(2);
  const hit = h.hooksOf('damaged').find((c) => c.target === t && c.source?.side === 'enemy');
  assert.ok(hit, 'the shooter hits the 指挥中心');
  close(hit.amount, Math.max(1500 - t.s.def, 75), 1e-6, 'unblocked attacker');
  done(h);
});

test('可露希尔 指挥中心: never attacks; knocked out ⇒ back on its tile after the token\'s interval, paying its deploy cost', () => {
  // (skills whose DP grants miss the return moment)
  for (const [id, sid] of [[ID6, S3], [EL6, S2]]) {
    const h = run({ units: [C(id, sid, 10, 3), ...pieces(id, sid, [[10, 5]])], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }], flags: FROZEN_DP(5) });
    h.run(3);
    const u = h.unit(1), t = h.unit(2);
    assert.equal(h.enemies()[0].blockedBy, t);
    assert.equal(t.stats.attacks, 0, 'never attacks');
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === t).length, 0);
    const interval = t.def.talents.find((x) => x.bb && x.bb.interval > 0).bb.interval;
    assert.equal(t.base.cost, 0);
    const t0 = h.b.time;
    h.b.kill(t);
    assert.equal(h.hooksOf('death').at(-1).reason, 'killed');
    assert.equal(u.trait.reinforcement, null);
    h.runUntil(() => h.b.time >= t0 + interval - 0.1, interval);
    assert.equal(t.alive, false, 'not before its interval');
    let dp0 = dpOf(h);
    assert.ok(h.runUntil(() => { if (!t.alive) dp0 = dpOf(h); return t.alive; }, 1), 'back');
    close(h.b.time, t0 + interval, h.TICK + 1e-6, 'after exactly its interval');
    assert.deepEqual([t.tileR, t.tileC], [10, 5], 'on its tile');
    assert.equal(u.trait.reinforcement, t);
    close(dpOf(h), dp0, 1e-9, 'its return pays its cost (0)');
    done(h);
  }
  // a return pays the summon's deploy cost (data 0 — raised here to see it) and waits for the DP
  const h = run({ units: [C(ID6, S3, 10, 3), ...pieces(ID6, S3, [[10, 5]])], flags: FROZEN_DP(0) });
  h.run(1);
  const t = h.unit(2);
  const interval = t.def.talents.find((x) => x.bb && x.bb.interval > 0).bb.interval;
  t.base.cost = 2;
  h.b.kill(t);
  h.b.getPlayer('p1').dp = 1;
  h.run(interval + 1);
  assert.equal(t.alive, false, 'waits for its DP');
  h.b.getPlayer('p1').dp = 3;
  assert.ok(h.runUntil(() => t.alive, 1));
  close(dpOf(h), 1, 1e-9, 'paid 2');
  done(h);
});

test('可露希尔 指挥中心: withdrawn when she leaves (not knocked out); back at once with her redeployment, a waiting one too', () => {
  const h = run({ units: [C(EL6, S1, 10, 3), ...pieces(EL6, S1, [[10, 5]])], flags: FROZEN_DP(99) });
  h.run(1);
  const u = h.unit(1), t = h.unit(2);
  h.b.kill(u);
  const d = h.hooksOf('death').find((c) => c.unit === t);
  assert.equal(d.reason, 'retreat', 'withdrawn, not destroyed');
  assert.equal(t.alive, false);
  h.run(20);
  assert.equal(t.alive, false, 'stays off while she is down (its 15 s do not apply)');
  assert.ok(h.runUntil(() => u.alive, 80), 'she redeploys');
  assert.ok(t.alive, 'back in the same step');
  assert.equal(h.hooksOf('deploy').filter((c) => c.unit === t).at(-1).t, h.hooksOf('deploy').filter((c) => c.unit === u).at(-1).t);
  // knocked out, then she leaves and comes back before its own refresh: reborn with her (closur_passive), not later
  const interval = t.def.talents.find((x) => x.bb && x.bb.interval > 0).bb.interval;
  u.base.respawnTime = 2; // (test-only: back well within the 指挥中心's refresh)
  const tk = h.b.time;
  h.b.kill(t);
  h.run(1);
  h.b.kill(u);
  assert.ok(h.runUntil(() => u.alive, 5));
  assert.ok(h.b.time - tk < interval - 5);
  assert.ok(t.alive, 'reborn with her (closur_passive)');
  done(h);
});

test('可露希尔 指挥中心: without a board piece one is summoned on her tactical point at her deployment (one only)', () => {
  for (const id of [ID5, EL6]) {
    const h = run({ units: [C(id, S1, 10, 3)], flags: FROZEN_DP(0) });
    h.run(0.5);
    const u = h.unit(1);
    const cc = h.b.allyUnits.filter((x) => x.defId === CC && x.ownerUnit === u);
    assert.equal(cc.length, 1);
    assert.ok(cc[0].alive && u.baseRangeKeys.includes(cc[0].tileR * COLS + cc[0].tileC), 'in her range');
    assert.ok(h.b.grid.canStand(cc[0].tileR, cc[0].tileC) && h.b.grid.groundPassable(cc[0].tileR, cc[0].tileC), 'a walkable ground tile');
    assert.equal(u.trait.reinforcement, cc[0]);
    // her redeployment brings the same one back (no second)
    h.b.kill(u);
    h.b.getPlayer('p1').dp = 99;
    assert.ok(h.runUntil(() => u.alive, 80));
    assert.equal(h.b.allyUnits.filter((x) => x.defId === CC && x.ownerUnit === u).length, 1);
    assert.ok(cc[0].alive);
    done(h);
  }
});

test('可露希尔 极限调度: her player\'s 【罗德岛】 operators ATK +atk all battle (herself too); two copies: the stronger; another player\'s: none', () => {
  for (const [id, moduleId] of [[ID5, null], [EL5, null], [EL6, null], [EL6, 'none']]) {
    const atk = talOf(id, 1, moduleId).atk;
    const players = [
      { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [C(id, S1, 10, 3, { moduleId, kind: 'chess' }), A(3, 'test_rhodes_a', 11, 4, { kind: 'chess' }), A(4, 'test_lungmen_a', 12, 4, { kind: 'chess' })] },
      { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [A(5, 'test_rhodes_a', 9, 8, { kind: 'chess' })] },
    ];
    const h = run({ kind: 'unite', players, flags: FROZEN_DP(99) });
    h.run(0.5);
    const u = h.unit(1), mine = h.unit(3), other = h.unit(4), theirs = h.unit(5);
    close(u.s.atk, u.base.atk * (1 + atk), 1e-6, `${id} ${moduleId} herself`);
    close(mine.s.atk, mine.base.atk * (1 + atk), 1e-9, 'her 罗德岛 operator');
    assert.equal(other.s.atk, other.base.atk, 'not 罗德岛');
    assert.equal(theirs.s.atk, theirs.base.atk, 'another player\'s 罗德岛 operator');
    h.b.kill(mine);
    assert.ok(h.runUntil(() => mine.alive, 10));
    close(mine.s.atk, mine.base.atk * (1 + atk), 1e-9, 'kept through a knock-out');
    done(h);
  }
  // two copies (tier V normal + tier VI elite): the stronger 极限调度, never the sum — whichever is set up first
  const weak = talOf(ID5, 1).atk, strong = talOf(EL6, 1).atk;
  assert.ok(strong > weak);
  for (const order of [[ID5, EL6], [EL6, ID5]]) {
    const h = run({ units: [C(order[0], S1, 10, 3), { ...C(order[1], S1, 12, 3), uid: 2 }, A(3, 'test_rhodes_a', 11, 6)], flags: FROZEN_DP(99) });
    h.run(0.5);
    const a = h.unit(3);
    close(a.s.atk, a.base.atk * (1 + strong), 1e-9, `${order}`);
    done(h);
  }
});

test('可露希尔 极限调度: her player\'s DP may go down to −|cost| — a knocked-out operator redeploys at DP ≥ cost − |cost|, the debt is paid first', () => {
  for (const [id, moduleId] of [[EL6, null], [EL6, 'none'], [EL5, null], [ID6, null]]) {
    const floor = Math.abs(talOf(id, 1, moduleId).cost);
    const players = [
      { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [C(id, S1, 10, 3, { moduleId, kind: 'chess' }), A(3, 'test_rhodes_a', 11, 4, { kind: 'chess' })] },
      { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [A(5, 'test_rhodes_a', 9, 8, { kind: 'chess' })] },
    ];
    const h = run({ kind: 'unite', players, flags: FROZEN_DP(0) });
    h.run(0.5);
    const a = h.unit(3), b = h.unit(5);
    const cost = a.base.cost;
    // one DP short of the floor: both wait
    h.b.getPlayer('p1').dp = cost - floor - 1;
    h.b.getPlayer('p2').dp = cost - floor;
    h.b.kill(a);
    h.b.kill(b);
    h.run(a.base.respawnTime + 1);
    assert.equal(a.alive, false, `${id} ${moduleId}: below the floor it waits`);
    assert.equal(b.alive, false, 'another player\'s floor is 0');
    // at the floor: it redeploys, the pool is 0 and the rest is owed
    h.b.getPlayer('p1').dp = cost - floor;
    h.step(1);
    assert.ok(a.alive, 'redeploys at DP = cost − floor');
    assert.equal(dpOf(h), 0);
    assert.equal(b.alive, false);
    // the DP gained pays the debt (floor) first
    h.b.flags.dpPerSec = 1;
    const t0 = h.b.time;
    h.runUntil(() => h.b.time >= t0 + floor - 0.2, floor);
    assert.equal(dpOf(h), 0, 'still paying the debt');
    h.runUntil(() => h.b.time >= t0 + floor + 0.5, 1);
    close(dpOf(h), 0.5, 2 * h.TICK, 'then the pool grows');
    done(h);
  }
  // without 可露希尔: the plain DP rule
  const h = run({ units: [A(3, 'test_rhodes_a', 11, 4)], flags: FROZEN_DP(0) });
  h.run(0.5);
  const a = h.unit(3);
  h.b.getPlayer('p1').dp = a.base.cost - 1;
  h.b.kill(a);
  h.run(a.base.respawnTime + 2);
  assert.equal(a.alive, false);
  done(h);
});

test('可露希尔 极限调度 ledger: one floor for all her player\'s redeploys (the debt adds up), after the respawn timer only, never with another player\'s DP', () => {
  const id = EL6, floor = Math.abs(talOf(id, 1).cost);
  // (her S3: no DP of hers before its first cast, long after these checks)
  const mk = (units, o = {}) => run({ units: [C(id, S3, 10, 3), ...units], flags: FROZEN_DP(0), ...o });
  {
    // two down at DP = cost − floor: the first takes the whole floor, the second waits
    const h = mk([A(3, 'test_rhodes_a', 11, 4), A(4, 'test_rhodes_a', 12, 4)]);
    h.run(0.5);
    const a = h.unit(3), b = h.unit(4);
    h.b.kill(a);
    h.b.kill(b);
    h.b.getPlayer('p1').dp = a.base.cost - floor;
    h.run(a.base.respawnTime + 0.2);
    assert.ok(a.alive, 'the first');
    assert.equal(b.alive, false, 'the second waits');
    h.run(3);
    assert.equal(b.alive, false);
    assert.equal(dpOf(h), 0);
    done(h);
  }
  {
    // cheap ones (cost < floor): after the first, the plain pool (0) would still let the second in — the debt does not
    const h = mk([A(3, 'test_cheap_a', 11, 4), A(4, 'test_cheap_a', 12, 4)]);
    h.run(0.5);
    const a = h.unit(3), b = h.unit(4);
    assert.ok(a.base.cost < floor && 2 * a.base.cost > floor);
    h.b.kill(a);
    h.b.kill(b);
    h.run(a.base.respawnTime + 0.2);
    assert.ok(a.alive, 'the first, into the floor');
    assert.equal(b.alive, false, 'the second: the debt counts');
    done(h);
  }
  {
    // the respawn timer first, whatever the DP
    const h = mk([A(3, 'test_rhodes_a', 11, 4)]);
    h.run(0.5);
    const a = h.unit(3);
    const t0 = h.b.time;
    h.b.kill(a);
    h.b.getPlayer('p1').dp = a.base.cost - floor;
    h.runUntil(() => h.b.time >= t0 + a.base.respawnTime - 0.1, a.base.respawnTime);
    assert.equal(a.alive, false, 'not before its timer');
    assert.ok(h.runUntil(() => a.alive, 0.5));
    close(h.b.time, t0 + a.base.respawnTime, 2 * h.TICK, 'at its timer');
    done(h);
  }
  {
    // p1 (hers) holds the DP, p2's operator is down with none: it stays down, p1 pays nothing
    const players = [
      { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [C(id, S3, 10, 3, { kind: 'chess' })] },
      { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [A(5, 'test_rhodes_a', 9, 8, { kind: 'chess' })] },
    ];
    const h = run({ kind: 'unite', players, flags: FROZEN_DP(0) });
    h.run(0.5);
    const b = h.unit(5);
    h.b.kill(b);
    h.b.getPlayer('p1').dp = b.base.cost - floor;
    h.run(b.base.respawnTime + 2);
    assert.equal(b.alive, false, 'another player\'s operator');
    assert.equal(dpOf(h, 'p1'), b.base.cost - floor, 'her player\'s DP untouched');
    done(h);
  }
});

test('可露希尔 S1: SP_FULL (record DEFAULT, AUTO with no target); 援军 1 layer of 护盾, never stacked; DP over the skill grows per cast up to cost_add_max', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S1), dur = skillOf(id, S1).duration;
    assert.equal(skillOf(id, S1).trigger.rule, 'DEFAULT');
    const players = [
      { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [C(id, S1, 10, 3, { carryState: READY, kind: 'chess' }), ...pieces(id, S1, [[10, 5]]), A(3, 'test_rhodes_a', 11, 5, { kind: 'chess' }), A(4, 'test_rhodes_a', 9, 4, { kind: 'chess' })] },
      { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [A(5, 'test_rhodes_a', 10, 6, { kind: 'chess' })] },
    ];
    const h = run({ kind: 'unite', players, flags: FROZEN_DP(0) });
    const u = h.unit(1);
    const log = [];
    const casts = [];
    const want = (k) => Math.min(bb.cost_add_max, bb.cost + bb.cost_per_add * k);
    // casts until the cap is reached, plus one
    let k = 0;
    while (want(k) < bb.cost_add_max) k++;
    const n = k + 2;
    h.step(1);
    assert.equal(u.skill.rule, 'SP_FULL');
    assert.ok(u.skill.active, 'cast as soon as SP is full, no enemy anywhere');
    const t = h.unit(2), inField = h.unit(3), outside = h.unit(4), theirs = h.unit(5);
    assert.equal(t.findBuff('closur:shield').shieldHits, bb.shield_cnt, '指挥中心');
    assert.equal(inField.findBuff('closur:shield').shieldHits, bb.shield_cnt, 'her ally in the 效果范围');
    assert.equal(outside.findBuff('closur:shield'), null, 'outside');
    assert.equal(theirs.findBuff('closur:shield'), null, 'another player\'s unit in the 效果范围');
    while (casts.length < n) {
      const before = u.skill.activations;
      const l = dpLog(h, 1 / 30);
      for (const x of l) log.push(x);
      if (u.skill.activations > before) casts.push(h.hooksOf('skillStart').at(-1).t);
      if (h.b.time > 400) break;
    }
    // the shield is never stacked: still one layer after the later casts (nothing broke it)
    assert.equal(t.findBuff('closur:shield').shieldHits, bb.shield_cnt, '不叠加');
    // DP: cast i gives want(i) DP, 1 each, at (j + ½) × duration / want(i) after its start
    casts.unshift(h.hooksOf('skillStart')[0].t);
    casts.length = n;
    assert.ok(bb.cost + bb.cost_per_add * (n - 1) > bb.cost_add_max, 'the last cast checked is a capped one');
    for (let i = 0; i < n; i++) {
      const total = want(i), iv = dur / total;
      const got = log.filter((x) => x.t > casts[i] && x.t <= casts[i] + dur + 1e-6);
      assert.equal(got.length, total, `${id} cast ${i}: ${total} grants`);
      got.forEach((x, j) => {
        close(x.d, 1, 1e-9);
        close(x.t - casts[i], (j + 0.5) * iv, 2 * h.TICK + 1e-6, `${id} cast ${i} grant ${j}`);
      });
    }
    done(h);
  }
});

test('可露希尔 S1: knocked out mid-skill ⇒ the rest is lost; the cast count restarts with her next deployment', () => {
  const id = EL6, bb = sbb(id, S1);
  const h = run({ units: [C(id, S1, 10, 3, { carryState: READY }), ...pieces(id, S1, [[10, 5]])], flags: FROZEN_DP(0) });
  const u = h.unit(1);
  h.step(1);
  assert.ok(u.skill.active);
  h.runUntil(() => !u.skill.active, 20);
  h.runUntil(() => u.skill.activations === 2, 30);
  const log = dpLog(h, 2);
  assert.equal(log.length, 1, 'second cast: its first grant only so far');
  h.b.kill(u);
  const l2 = dpLog(h, 10);
  assert.equal(l2.length, 0, 'nothing more after the knock-out');
  h.b.getPlayer('p1').dp = u.base.cost;
  assert.ok(h.runUntil(() => u.alive, 80));
  assert.equal(dpOf(h), 0, 'paid her cost');
  h.runUntil(() => u.skill.activations === 3, 30);
  const l3 = dpLog(h, skillOf(id, S1).duration + 0.1);
  assert.equal(l3.reduce((s, x) => s + x.d, 0), bb.cost, 'first cast of the new deployment: cost again');
  done(h);
});

test('可露希尔 S2: +cost DP at once then the period DP to cost_period; ATK +atk, 2 targets, enemies her 援军 block are reachable', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S2), dur = skillOf(id, S2).duration, t1 = talOf(id, 1);
    assert.equal(skillOf(id, S2).trigger.rule, 'SP_FULL');
    const step = bb['closur_s_2[add_cost_period].cost'], iv = bb['closur_s_2[add_cost_period].interval'];
    // an ally of her field (3×3 around the 指挥中心 at (10,6)) at (10,7) — outside her range — blocks a dummy
    const h = run({
      units: [C(id, S2, 10, 3, { carryState: READY }), ...pieces(id, S2, [[10, 6]]), A(3, 'test_rhodes_a', 10, 7)],
      enemies: [{ key: 'enemy_dummy', pos: [10, 7] }],
      flags: FROZEN_DP(0),
    });
    const u = h.unit(1);
    const far = () => h.enemies()[0];
    h.step(1);
    assert.ok(u.skill.active && u.skill.rule === 'SP_FULL', 'cast');
    const t0 = h.hooksOf('skillStart')[0].t;
    close(dpOf(h), bb.cost, 1e-9, `${id} +cost at once`);
    close(u.s.atk, u.base.atk * (1 + t1.atk + bb.atk), 1e-6, 'ATK (+ 极限调度: she is 罗德岛)');
    assert.equal(far().blockedBy, h.unit(3));
    assert.ok(!u.baseRangeKeys.includes(10 * COLS + 7), 'the enemy is outside her range');
    const log = dpLog(h, dur + 0.5);
    assert.equal(u.skill.active, false);
    assert.equal(log.reduce((s, x) => s + x.d, 0), bb.cost_period, 'cost_period over the skill');
    log.forEach((x, j) => close(x.t - t0, (j + 1) * iv, 2 * h.TICK + 1e-6, `grant ${j}`));
    assert.ok(log.every((x) => Math.abs(x.d - step) < 1e-9));
    assert.ok(h.hooksOf('damaged').some((c) => c.source === u && c.target === far() && c.t > t0 && c.t < t0 + dur), 'she hits the enemy her 援军 blocks');
    const after = h.hooksOf('damaged').filter((c) => c.source === u && c.t > t0 + dur + 0.5).length;
    h.run(4);
    assert.equal(h.hooksOf('damaged').filter((c) => c.source === u && c.t > t0 + dur + 0.5).length, after, 'out of reach after the skill');
    done(h);
  }
  // two targets per attack
  const h = run({ units: [C(EL6, S2, 10, 3, { carryState: READY }), ...pieces(EL6, S2, [[9, 6]])], enemies: [0, 1, 2].map(() => ({ key: 'enemy_dummy', pos: [11, 5] })), flags: FROZEN_DP(0) });
  h.run(4);
  const u = h.unit(1);
  const per = new Map();
  for (const c of h.hooksOf('damaged')) if (c.source === u && c.dmg.isAttack) per.set(c.dmg.attackId, (per.get(c.dmg.attackId) ?? 0) + 1);
  assert.ok(per.size > 0 && [...per.values()].every((n) => n === sbb(EL6, S2)['attack@max_target']));
  done(h);
});

test('可露希尔 S2: 援军 DEF +def and block +block_cnt while it runs (her units on the 效果范围, the 指挥中心); none after', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S2);
    const h = run({ units: [C(id, S2, 10, 3, { carryState: READY }), ...pieces(id, S2, [[10, 5]]), A(3, 'test_rhodes_a', 11, 6), A(4, 'test_rhodes_a', 12, 4)], flags: FROZEN_DP(0) });
    const u = h.unit(1), t = h.unit(2), a = h.unit(3), out = h.unit(4);
    h.run(0.5);
    assert.ok(u.skill.active);
    for (const x of [t, a]) {
      close(x.s.def, x.base.def * (1 + bb.def), 1e-6, 'DEF');
      assert.equal(x.s.blockCnt, x.base.blockCnt + bb.block_cnt, 'block');
    }
    assert.equal(out.s.def, out.base.def);
    assert.equal(out.s.blockCnt, out.base.blockCnt);
    h.runUntil(() => !u.skill.active, 40);
    h.step(1);
    assert.equal(t.s.blockCnt, t.base.blockCnt, 'gone with the skill');
    assert.equal(a.findBuff('closur:s2'), null);
    done(h);
  }
});

test('可露希尔 S2: her operator redeployed on the 效果范围 while it runs refunds ⌈cost × cost_return⌉ (outside / not running / another player: none)', () => {
  const id = EL6, bb = sbb(id, S2);
  const players = [
    { playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [C(id, S2, 10, 3, { carryState: READY, kind: 'chess' }), ...pieces(id, S2, [[10, 5]]), A(3, 'test_odd_a', 11, 6, { kind: 'chess' }), A(4, 'test_rhodes_a', 12, 4, { kind: 'chess' })] },
    { playerId: 'p2', seat: 1, side: 'L', colOffset: 0, bonds: {}, units: [A(5, 'test_rhodes_a', 9, 6, { kind: 'chess' })] },
  ];
  const h = run({ kind: 'unite', players, flags: FROZEN_DP(99) });
  const u = h.unit(1), inField = h.unit(3), out = h.unit(4), theirs = h.unit(5);
  h.step(1);
  assert.ok(u.skill.active);
  const t0 = h.b.time;
  // knocked out at +0.5 s: back at +5.5 s (not on a 2 s period grant)
  h.runUntil(() => h.b.time >= t0 + 0.5, 1);
  for (const x of [inField, out, theirs]) h.b.kill(x);
  const p2 = dpOf(h, 'p2');
  let before = dpOf(h);
  h.runUntil(() => { const ok = inField.alive; if (!ok) before = dpOf(h); return ok; }, 10);
  assert.ok(out.alive && theirs.alive, 'all back in the same step');
  assert.ok(!Number.isInteger(inField.base.cost * bb.cost_return), 'a cost whose refund is rounded up');
  close(dpOf(h) - before, -inField.base.cost - out.base.cost + Math.ceil(inField.base.cost * bb.cost_return), 1e-9, 'one refund');
  close(dpOf(h, 'p2'), p2 - theirs.base.cost, 1e-9, 'p2 pays, no refund');
  // after the skill: no refund
  h.runUntil(() => !u.skill.active, 40);
  h.b.kill(inField);
  let b2 = dpOf(h);
  h.runUntil(() => { const ok = inField.alive; if (!ok) b2 = dpOf(h); return ok; }, 10);
  close(dpOf(h) - b2, -inField.base.cost, 1e-9, 'not while S2 is off');
  done(h);
});

test('可露希尔 S2 refund guards: one refund per deployment with two copies; none for a 【移动】 nor for a summon', () => {
  const bb = sbb(EL6, S2);
  // the ally at (10,5) is in both 效果范围 (指挥中心 at (9,5) and (11,5))
  const h = run({
    units: [C(EL6, S2, 9, 3, { carryState: READY }), { ...C(ID6, S2, 11, 3, { carryState: READY }), uid: 2 }, ...pieces(EL6, S2, [[9, 5]], { uid: 3 }), ...pieces(ID6, S2, [[11, 5]], { ownerUid: 2, uid: 4 }),
      A(5, 'test_odd_a', 10, 5), A(6, 'test_rhodes_a', 12, 7)],
    flags: FROZEN_DP(99),
  });
  const a = h.unit(5), mover = h.unit(6);
  h.step(1);
  assert.ok(h.unit(1).skill.active && h.unit(2).skill.active);
  const t0 = h.b.time;
  h.runUntil(() => h.b.time >= t0 + 0.5, 1);
  h.b.kill(a);
  let before = dpOf(h);
  h.runUntil(() => { const ok = a.alive; if (!ok) before = dpOf(h); return ok; }, 10);
  const ret = Math.max(bb.cost_return, sbb(ID6, S2).cost_return);
  close(dpOf(h) - before, -a.base.cost + Math.ceil(a.base.cost * ret), 1e-9, 'one refund for two copies');
  // a 【移动】 into the 效果范围 (Battle.moveRedeploy: deploy `move`) — no refund
  h.step(1);
  const d0 = dpOf(h);
  assert.ok(h.b.moveRedeploy(mover, 10, 6));
  assert.equal(h.hooksOf('deploy').at(-1).unit, mover);
  assert.ok(h.hooksOf('deploy').at(-1).move);
  assert.equal(dpOf(h), d0, 'no refund for a move');
  // a summon (no operator) deployed into the 效果范围 with a cost: no refund
  const tk = h.b.spawnToken('p1', 'token_10002_kalts_mon3tr', 9, 6, { stats: { cost: 11 } });
  assert.ok(tk && tk.base.cost === 11);
  assert.equal(dpOf(h), d0, 'no refund for a summon');
  done(h);
});

test('可露希尔 S3: period DP to cost_period; interval base_attack_time; ATK × attack@atk_scale; 1 target +1 every attack_trigger_cnt attacks (≤ max_trigger_cnt)', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S3), r = skillOf(id, S3), dur = r.duration;
    const iv = bb['closur_s_3[add_cost_period].interval'];
    // 9 dummies on her range, nobody blocks them
    const h = run({ units: [C(id, S3, 10, 3, { carryState: READY }), ...pieces(id, S3, [[12, 3]])], enemies: Array.from({ length: 9 }, (_, i) => ({ key: 'enemy_dummy', pos: [9 + (i % 3), 4 + Math.floor(i / 3)] })), flags: FROZEN_DP(0) });
    const u = h.unit(1);
    h.step(1);
    assert.ok(u.skill.active && u.skill.rule === 'SP_FULL');
    const t0 = h.hooksOf('skillStart')[0].t;
    close(u.s.interval, u.base.bat * (1 + batMod(bb.base_attack_time, rec(id), r.desc)), 1e-9, 'attack interval');
    assert.ok(u.s.interval < u.base.bat);
    // (a test-only ASPD boost: enough attacks in one cast to pass the max_trigger_cnt cap)
    h.b.addBuff(u, { key: 'test:aspd', mods: { aspd: 200 } });
    const log = dpLog(h, dur + 0.5);
    assert.equal(log.reduce((s, x) => s + x.d, 0), bb.cost_period, `${id} cost_period`);
    log.forEach((x, j) => close(x.t - t0, (j + 1) * iv, 2 * h.TICK + 1e-6, `grant ${j}`));
    const per = new Map();
    for (const c of h.hooksOf('damaged')) {
      if (c.source !== u || !c.dmg.isAttack || !c.dmg.isSkill || c.t < t0) continue;
      if (!per.has(c.dmg.attackId)) per.set(c.dmg.attackId, []);
      per.get(c.dmg.attackId).push(c);
    }
    const counts = [...per.values()].map((l) => l.length);
    assert.ok(counts.length > bb.attack_trigger_cnt * (bb.max_trigger_cnt + 2), `${counts.length} attacks`);
    assert.ok(new Set(h.enemies().map((e) => e.id)).size > 1 + bb.max_trigger_cnt, 'more enemies than the capped target count');
    counts.forEach((n, i) => assert.equal(n, Math.min(1 + Math.floor(i / bb.attack_trigger_cnt), 1 + bb.max_trigger_cnt), `attack ${i}`));
    // ATK × atk_scale (DEF 0, nothing blocks them): her ATK during the skill
    const first = [...per.values()][0][0];
    close(first.amount, u.s.atk * bb['attack@atk_scale'], 1e-6, 'damage');
    done(h);
  }
});

test('可露希尔 S3: 迟钝 per hit (slow_down per stack, ≤ max_stack_cnt / slow_down_max, slow_down_time s); the 援军\'s original ranges are hers', () => {
  for (const id of [ID6, EL6]) {
    const bb = sbb(id, S3);
    // the ally at (10,7) (her field: cross 2 around the 指挥中心 at (10,5)) has range (10,7)-(10,8): a dummy on (10,8)
    const h = run({ units: [C(id, S3, 10, 3, { carryState: READY }), ...pieces(id, S3, [[10, 5]]), A(3, 'test_rhodes_a', 10, 7)], enemies: [{ key: 'enemy_dummy', pos: [10, 8] }], flags: FROZEN_DP(0) });
    const u = h.unit(1);
    h.step(1);
    const e = h.enemies()[0];
    assert.ok(!e.blockedBy);
    const hits = () => h.hooksOf('damaged').filter((c) => c.source === u && c.target === e && c.dmg.isAttack).length;
    h.runUntil(() => hits() >= 1, 3);
    assert.equal(hits(), 1, 'her S3 reaches an enemy of her 援军\'s original range');
    const v = bb['attack@slow_down'];
    const slow = () => e.findBuff('closur:slowdown');
    close(e.s.aspd, e.base.aspd * (1 - v), 1e-9, '1 stack: ASPD');
    close(e.s.moveSpeed, e.base.moveSpeed * (1 - v), 1e-9, '1 stack: move');
    h.runUntil(() => hits() >= 3, 5);
    close(e.s.aspd, e.base.aspd * (1 - 3 * v), 1e-9, '3 stacks');
    h.runUntil(() => hits() >= bb['attack@max_stack_cnt'] + 3, 20);
    close(e.s.aspd, e.base.aspd * (1 - Math.min(bb['attack@slow_down_max'], v * bb['attack@max_stack_cnt'])), 1e-9, 'capped');
    assert.equal(slow().data.n, bb['attack@max_stack_cnt']);
    close(slow().timeLeft, bb['attack@slow_down_time'], 2 * u.s.interval, 'refreshed by every hit');
    h.runUntil(() => !u.skill.active, 40);
    h.run(1);
    const last = h.hooksOf('damaged').filter((c) => c.source === u && c.target === e && c.dmg.isAttack).at(-1).t;
    h.runUntil(() => !slow(), bb['attack@slow_down_time'] + 1);
    assert.ok(!slow(), 'lapses');
    close(h.b.time - last, bb['attack@slow_down_time'], 2 * h.TICK, 'slow_down_time after the last hit');
    close(e.s.aspd, e.base.aspd, 1e-9);
    // without S3 she never reaches it
    const n = hits();
    h.run(5);
    assert.equal(hits(), n);
    done(h);
  }
});

test('可露希尔 S3: 迟钝 on a walking enemy — move speed ×(1 − slow_down × stacks) and ASPD alike, from the first hit', () => {
  for (const id of [ID6, EL6]) {
    const v = sbb(id, S3)['attack@slow_down'];
    const h = run({ units: [C(id, S3, 10, 3, { carryState: READY }), ...pieces(id, S3, [[12, 3]])], enemies: [{ key: 'enemy_walker', route: 0 }], flags: FROZEN_DP(0) });
    const u = h.unit(1);
    h.step(1);
    const e = h.enemies()[0];
    assert.ok(e.base.moveSpeed > 0 && e.s.moveSpeed === e.base.moveSpeed, 'a walker');
    const hits = () => h.hooksOf('damaged').filter((c) => c.source === u && c.target === e && c.dmg.isAttack).length;
    assert.ok(h.runUntil(() => hits() >= 1, 30), 'she reaches it');
    const n = e.findBuff('closur:slowdown').data.n;
    assert.equal(n, hits());
    close(e.s.moveSpeed, e.base.moveSpeed * (1 - v * n), 1e-9, `${id} move speed`);
    close(e.s.aspd, e.base.aspd * (1 - v * n), 1e-9, 'ASPD');
    h.runUntil(() => hits() >= 3, 5);
    const m = e.findBuff('closur:slowdown').data.n;
    assert.ok(m >= 3);
    close(e.s.moveSpeed, e.base.moveSpeed * (1 - v * m), 1e-9, `${id} ${m} stacks`);
    done(h);
  }
});

test('可露希尔 modules × skills (both tiers\' elites): casts by SP_FULL, DP at the start, 极限调度 ATK, TAC-X cut, 部署费用下限 per loadout', () => {
  for (const id of [EL5, EL6]) for (const moduleId of [null, 'none', TACX]) for (const sid of [S1, S2, S3]) {
    const bb = sbb(id, sid), t1 = talOf(id, 1, moduleId), cut = cutOf(id, moduleId);
    const h = run({
      units: [C(id, sid, 10, 3, { carryState: READY, moduleId }), ...pieces(id, sid, [[10, 5]]), A(3, 'test_rhodes_a', 11, 4)],
      enemies: [{ key: 'enemy_hitter', pos: [10, 5] }],
      flags: FROZEN_DP(0),
    });
    const u = h.unit(1), t = h.unit(2), a = h.unit(3);
    h.step(1);
    const tag = `${id} ${moduleId} ${sid}`;
    assert.equal(u.kit.skillSource, 'skills', tag);
    assert.ok(u.skill.active && u.skill.rule === 'SP_FULL', `${tag} cast`);
    close(dpOf(h), sid === S1 ? 0 : bb.cost, 1e-9, `${tag} DP at the start`);
    close(a.s.atk, a.base.atk * (1 + t1.atk), 1e-9, `${tag} 极限调度`);
    h.run(3);
    // (S1's 护盾 takes the first hit)
    const hit = h.hooksOf('damaged').find((c) => c.target === t && c.source?.side === 'enemy' && c.amount > 0);
    close(hit.amount, Math.max(3000 - hit.target.s.def, 150) * cut, 1e-6, `${tag} TAC-X`);
    done(h);
    // the floor (before her first cast — no skill DP meanwhile): half a DP below waits, at the floor it redeploys
    const floor = Math.abs(t1.cost);
    const g = run({ units: [C(id, sid, 10, 3, { moduleId }), ...pieces(id, sid, [[10, 5]]), A(3, 'test_rhodes_a', 11, 4)], flags: FROZEN_DP(0) });
    g.run(0.5);
    const b = g.unit(3);
    g.b.kill(b);
    g.run(b.base.respawnTime + 0.2);
    assert.equal(g.unit(1).skill.activations, 0);
    g.b.getPlayer('p1').dp = b.base.cost - floor - 0.5;
    g.step(1);
    assert.equal(b.alive, false, `${tag} below the floor`);
    g.b.getPlayer('p1').dp = b.base.cost - floor;
    g.step(1);
    assert.ok(b.alive, `${tag} at the floor`);
    done(g);
  }
});

test('可露希尔: two copies — 极限调度 floor the larger, whichever is set up first', () => {
  const floor = Math.max(Math.abs(talOf(ID5, 1).cost), Math.abs(talOf(EL6, 1).cost));
  assert.ok(Math.abs(talOf(ID5, 1).cost) < floor);
  for (const [a, b] of [[ID5, EL6], [EL6, ID5]]) {
    const h = run({ units: [C(a, S3, 9, 3), { ...C(b, S3, 11, 3), uid: 2 }, A(5, 'test_rhodes_a', 12, 6)], flags: FROZEN_DP(0) });
    h.run(0.5);
    const x = h.unit(5);
    h.b.kill(x);
    h.run(x.base.respawnTime + 0.2);
    h.b.getPlayer('p1').dp = x.base.cost - floor - 0.5;
    h.step(1);
    assert.equal(x.alive, false, `${a} then ${b}: the larger floor, not the sum`);
    h.b.getPlayer('p1').dp = x.base.cost - floor;
    h.step(1);
    assert.ok(x.alive, `${a} then ${b}`);
    done(h);
  }
});

test('可露希尔: two copies — each her own 指挥中心 and 援军, 极限调度 floor the larger, 迟钝 stacks shared', () => {
  const h = run({
    units: [C(ID5, S3, 9, 3, { carryState: READY }), { ...C(EL6, S3, 11, 3, { carryState: READY }), uid: 2 }, ...pieces(ID5, S3, [[9, 5]], { uid: 3 }), ...pieces(EL6, S3, [[11, 5]], { ownerUid: 2, uid: 4 }), A(5, 'test_rhodes_a', 12, 4)],
    enemies: [{ key: 'enemy_dummy', pos: [10, 5] }],
    flags: FROZEN_DP(0),
  });
  const a = h.unit(1), b = h.unit(2), ca = h.unit(3), cb = h.unit(4), x = h.unit(5);
  h.run(0.5);
  assert.equal(ca.ownerUnit, a);
  assert.equal(cb.ownerUnit, b);
  assert.equal(a.trait.reinforcement, ca);
  assert.equal(b.trait.reinforcement, cb);
  const e = h.enemies()[0];
  h.run(1.5);
  const hits = h.hooksOf('damaged').filter((c) => c.target === e && c.dmg.isAttack && (c.source === a || c.source === b)).length;
  const s = e.findBuff('closur:slowdown');
  assert.equal(s.data.n, Math.min(hits, sbb(EL6, S3)['attack@max_stack_cnt']), 'one stack count for both');
  close(s.data.v, Math.max(sbb(ID5, S3)['attack@slow_down'], sbb(EL6, S3)['attack@slow_down']), 1e-12, 'the stronger value');
  // the larger floor (elite)
  const floor = Math.max(Math.abs(talOf(ID5, 1).cost), Math.abs(talOf(EL6, 1).cost));
  h.b.kill(x);
  h.run(x.base.respawnTime + 0.2);
  h.b.getPlayer('p1').dp = x.base.cost - floor;
  h.step(1);
  assert.ok(x.alive);
  done(h);
});

test('可露希尔: two copies on one ally — the S2 aura of the stronger copy only, the TAC-X cut once', () => {
  // an ally at (10,5) is in both 效果范围 (the 指挥中心 at (9,5) and (11,5))
  const both = (a, b, sid, flags = FROZEN_DP(0)) => run({
    units: [C(a, sid, 9, 3, { carryState: READY }), { ...C(b, sid, 11, 3, { carryState: READY }), uid: 2 }, ...pieces(a, sid, [[9, 5]], { uid: 3 }), ...pieces(b, sid, [[11, 5]], { ownerUid: 2, uid: 4 }), A(5, 'test_armour_a', 10, 5)],
    enemies: [{ key: 'enemy_hitter', pos: [10, 5] }],
    flags,
  });
  const weak = sbb(ID5, S2).def, strong = sbb(EL6, S2).def;
  assert.ok(strong > weak);
  for (const [a, b] of [[ID5, EL6], [EL6, ID5]]) {
    const h = both(a, b, S2);
    h.run(0.5);
    const x = h.unit(5);
    assert.ok(h.unit(1).skill.active && h.unit(2).skill.active);
    assert.ok(x.base.def > 0);
    for (let i = 0; i < 6; i++) { h.step(1); close(x.s.def, x.base.def * (1 + strong), 1e-9, `${a} + ${b}: the stronger aura (step ${i})`); }
    assert.equal(x.s.blockCnt, x.base.blockCnt + sbb(EL6, S2).block_cnt, 'block +1 once');
    done(h);
  }
  const h = both(EL5, EL6, S1);
  h.run(4);
  const x = h.unit(5);
  const hit = h.hooksOf('damaged').find((c) => c.target === x && c.source?.side === 'enemy' && c.amount > 0);
  close(hit.amount, Math.max(3000 - x.s.def, 150) * cutOf(EL6), 1e-6, 'TAC-X once');
  done(h);
});

test('可露希尔: every skill × tier survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, EL5, EL6]) for (const s of rec(id).skills) {
    const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
      units: [{ chessId: id, row: 10, col: 4, skillIndex: s.index, carryState: READY }, { chessId: 'chess_char_2_06_a', row: 10, col: 6 }],
      enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
    h.runToEnd(90);
    done(h);
    const u = h.b.allyUnits.find((x) => x.defId === id);
    assert.ok(u.skill.activations > 0, `${id} ${s.skillId} casts`);
    assert.ok(h.b.allyUnits.some((x) => x.defId === CC && x.ownerUnit === u), 'a 指挥中心');
  }
});
