// Generic summons (stream C; content/genericSummons.js, content/tokens.js): the summons of operators WITHOUT a hand-authored
// kit — today the 外援 / 甄选 ones, whose records the tests inject (test/helpers/waiguan.js; the battle DataSource of a match
// does not hold them yet). Real records only: talents / skills / summon texts and numbers of data/waiguan.json + tokens.json.
//   * returns: a summon that left during the battle comes back on its tile after its redeploy time, paying its deploy cost
//     (only the battle-start deployment is free), never while its owner is down (Mon3tr; docked skill summons too)
//   * consumables (REQUIREMENTS §5): the official per-battle count ("可以使用3个雷鸣地雷") — used up = no more that battle;
//     skill gains add to it ("立即获得一个陷阱"); a talent's extra summons are not taken from it
//   * traps: no attack, triggered once by an enemy, the owner's selected skill gives the effect, then used up
//   * hidden summons: 维什戴尔 魂灵之影 (deploy), 死芒 悲叹的仆役 (kills, ≤3), W's 地雷 (skill)
//   * owner → summon links of the selected skill ("自身和召唤物防御力+40%", "Mon3tr的攻击力…"), 鼓舞, lifetimes
//   * owner-kit opt-outs: `managedTokenTalents` (generic summon talents off), `tokenKits` (the owner hands its summon a kit),
//     `genericSummons: true` (a hand kit keeping the generic summoner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle as harnessBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { genericKit } from '../../server/sim/content/generic.js';
import { WG, wgId, noWaiguan } from '../helpers/waiguan.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';

// These tests pin the GENERIC summoner (an owner without a hand-authored kit). 令 and 凯尔希 have hand kits now (kits/waiguan,
// which own their summons), so their generic behaviour is reached by injecting the generic kit for them; a test's own
// `kits` still wins.
const GENERIC_FOR = ['char_2023_ling', 'char_003_kalts'];
const forceGeneric = Object.fromEntries(GENERIC_FOR.flatMap((c) => [5, 6].map((tier) => [`chess_char_diy_${tier}_${c}_a`, (bb, raw, def) => genericKit(bb, raw, def)])));
const makeBattle = (o = {}) => harnessBattle({ ...o, kits: { ...forceGeneric, ...(o.kits || {}) } });
const REAL = { skip: noWaiguan || (!hasGeneratedData() && 'no generated data') };
const dummy = (o = {}) => enemyRec({ key: o.key ?? 'enemy_dummy', hp: 1e7, speed: 0, def: 0, res: 0, atk: 0, ...o });
const walker = (o = {}) => enemyRec({ key: o.key ?? 'enemy_walker', hp: 1e6, speed: 1, def: 0, res: 0, atk: 0, ...o });
const KALTS = wgId('char_003_kalts'), MON = 'token_10002_kalts_mon3tr';
const ELA = wgId('char_4123_ela'), MINE = 'token_10033_ela_grzmot';
const unitOf = (h, uid) => h.b.allyUnits.find((u) => u.uid === uid);
const tokensOf = (h, id) => h.b.allyUnits.filter((u) => u.kind === 'token' && u.defId === id);
const standing = (h, id) => tokensOf(h, id).filter((u) => u.alive && u.deployed);
const noErrors = (h) => { assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); checkInvariants(h.b); };
/** DP paid by each deployment of `pred` units: [{ t, paid }] (DP of the last tick minus DP at the deploy hook). */
function watchDeploys(b, pred, out) {
  let last = null;
  b.on('tick', () => { last = b.getPlayer('p1').dp; }, { priority: 1000 });
  b.on('deploy', (c) => { if (pred(c.unit)) out.push({ t: b.time, id: c.unit.id, paid: last == null ? 0 : Math.round(last - b.getPlayer('p1').dp), initial: !!c.initial }); }, { priority: 1000 });
}

// =================================================================================================================
// returns

test('Mon3tr (凯尔希, generic kit): killed → back on its tile after its 25 s redeploy time, paying its 10 DP; never while 凯尔希 is down', REAL, () => {
  const deploys = [];
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 200, autoFinish: false,
    units: [{ chessId: KALTS, row: 10, col: 4, uid: 1 }, { kind: 'token', tokenId: MON, ownerUid: 1, row: 10, col: 5, uid: 2 }],
    setup: (b) => watchDeploys(b, (u) => u.defId === MON, deploys),
  });
  h.run(1);
  const k = unitOf(h, 1), m = unitOf(h, 2);
  assert.ok(m.alive && m.deployed, 'deployed with the board');
  assert.equal(deploys[0].paid, 0, 'the battle-start deployment is free');
  assert.equal(m.base.respawnTime, 25);
  h.b.getPlayer('p1').dp = 50;
  h.b.kill(m);
  const t0 = h.b.time;
  h.run(24.5);
  assert.ok(!m.alive, 'not before its redeploy time');
  h.run(1);
  assert.ok(m.alive && m.deployed && m.tileR === 10 && m.tileC === 5, 'back on its tile');
  assert.ok(deploys[1].t - t0 >= 25 - 1e-6 && deploys[1].t - t0 <= 25.3, `after 25 s (${deploys[1].t - t0})`);
  assert.equal(deploys[1].paid, 10, 'a return pays the deploy cost');
  // owner down: Mon3tr waits for her
  h.b.kill(m);
  h.b.kill(k);
  h.run(30);
  assert.ok(!m.alive, 'no return while 凯尔希 is down');
  h.runUntil(() => k.alive, 120);
  assert.ok(k.alive, '凯尔希 redeployed');
  h.run(1);
  assert.ok(m.alive, 'Mon3tr comes back as soon as she stands again');
  noErrors(h);
});

test('not enough DP: the return waits for the DP (never free)', REAL, () => {
  const deploys = [];
  let clamp = false;
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 100, autoFinish: false,
    units: [{ chessId: KALTS, row: 10, col: 4, uid: 1 }, { kind: 'token', tokenId: MON, ownerUid: 1, row: 10, col: 5, uid: 2 }],
    setup: (b) => {
      b.on('tick', () => { if (clamp) b.getPlayer('p1').dp = Math.min(b.getPlayer('p1').dp, 9); }, { priority: 2000 });
      watchDeploys(b, (u) => u.defId === MON, deploys);
    },
  });
  h.run(1);
  const m = unitOf(h, 2);
  clamp = true; // 9 DP at most: Mon3tr costs 10
  h.b.kill(m);
  h.run(40);
  assert.ok(!m.alive, 'past its redeploy time, still waiting for the DP');
  assert.equal(deploys.length, 1);
  clamp = false;
  h.run(2);
  assert.ok(m.alive, 'back once the DP is there');
  assert.equal(deploys.at(-1).paid, 10);
  noErrors(h);
});

test('pool 赫默 医疗探机 (docked skill summon, tokens.js): free with the board and free on every S2 release (pool unchanged; only 外援 summons pay)', REAL, () => {
  const SILENCE = 'chess_char_2_02_a', DRONE = 'token_10000_silent_healrb';
  const deploys = [];
  const h = makeBattle({
    autoFinish: false, timeLimit: 200,
    units: [{ chessId: SILENCE, row: 10, col: 3, uid: 1 }, { kind: 'token', tokenId: DRONE, ownerUid: 1, row: 11, col: 4, uid: 3, dir: 'RIGHT' }],
    setup: (b) => {
      b.on('tick', () => { b.getPlayer('p1').dp = 0; }, { priority: 2000 });
      watchDeploys(b, (u) => u.defId === DRONE, deploys);
    },
  });
  h.run(0.5);
  const hm = unitOf(h, 1), piece = unitOf(h, 3);
  assert.ok(piece.alive && deploys[0].paid === 0, 'free with the board');
  assert.ok(piece.base.cost > 0, 'the drone has a cost');
  h.runUntil(() => !piece.alive, 12);
  hm.skill.activate('test', { free: true });
  h.runUntil(() => piece.alive, 8); // after its redeploy time (data respawnTime), with 0 DP
  assert.ok(piece.alive, 'the skill brings it back without DP');
  assert.equal(deploys.at(-1).paid, 0, 'free');
  noErrors(h);
});

// =================================================================================================================
// consumables (REQUIREMENTS §5)

test('艾拉: "可以使用3个雷鸣地雷（最多拥有4个）" — 3 of her 4 pieces deploy; used-up mines do not come back that battle; "立即获得一个陷阱" brings one back (paying)', REAL, () => {
  const deploys = [], triggers = [];
  const route = { motion: 'WALK', start: [11, 10], end: [11, 3], checkpoints: [] };
  const h = makeBattle({
    defs: { chess: WG, enemies: { enemy_walker: walker() } }, timeLimit: 120, autoFinish: false,
    units: [
      { chessId: ELA, row: 10, col: 4, uid: 1, skillIndex: 0 },
      { kind: 'token', tokenId: MINE, ownerUid: 1, row: 11, col: 8, uid: 2 },
      { kind: 'token', tokenId: MINE, ownerUid: 1, row: 11, col: 6, uid: 3 },
      { kind: 'token', tokenId: MINE, ownerUid: 1, row: 12, col: 4, uid: 4 },
      { kind: 'token', tokenId: MINE, ownerUid: 1, row: 9, col: 9, uid: 5 },
    ],
    enemies: [{ key: 'enemy_walker', time: 2, route, count: 2, interval: 6 }],
    setup: (b) => {
      watchDeploys(b, (u) => u.defId === MINE, deploys);
      b.on('summonTrap', (c) => triggers.push({ t: b.time, id: c.token.id, target: c.target.id }));
    },
  });
  const ela = () => unitOf(h, 1);
  const starts = [];
  h.b.on('skillStart', (c) => { if (c.unit === ela()) starts.push(h.b.time); });
  h.run(1);
  const stock = ela().mem.genericSummons.infos.find((i) => i.id === MINE).group;
  assert.equal(standing(h, MINE).length, 3, 'the stock is 3: three deploy');
  assert.ok(deploys.every((d) => d.paid === 0), 'the battle-start deployment is free');
  assert.equal(stock.left, 0);
  assert.equal(stock.max, 4, '最多拥有4个');
  assert.ok(!unitOf(h, 5).alive, 'the fourth piece waits off the field');
  // the enemies walk row 11 and set off the mines next to it (艾拉: "经过周围的第一个敌人"); each one is used up at once
  h.b.on('summonTrap', (c) => assert.ok(c.token.alive, 'triggers once'));
  h.run(60);
  assert.ok(triggers.length >= 2, `${triggers.length} triggers`);
  // S1 "立即获得一个陷阱": a mine comes back only with a skill start (a used one, on its tile, paying its 5 DP) — none
  // otherwise, however long the battle runs
  assert.ok(starts.length >= 1, 'her skill ran');
  const later = deploys.slice(3);
  assert.ok(later.length >= 1);
  for (const d of later) {
    assert.ok(starts.some((t) => d.t >= t - 1e-6 && d.t <= t + 0.6), `a return at ${d.t.toFixed(2)} follows a skill start (${starts.map((t) => t.toFixed(2))})`);
    assert.equal(d.paid, 5, 'a return pays');
  }
  assert.ok(later.length <= starts.length, 'one per skill start at most');
  assert.ok(stock.left <= 1);
  noErrors(h);
});

test('艾拉 trap: never attacks, untargetable; triggered once by an enemy next to it, her SELECTED skill gives the effect (S2: 晕眩4秒 around), then it is used up (no knock-out)', REAL, () => {
  const deaths = [], st = [], atk = [];
  const route = { motion: 'WALK', start: [11, 10], end: [11, 3], checkpoints: [] };
  const h = makeBattle({
    defs: { chess: WG, enemies: { enemy_walker: walker() } }, timeLimit: 40, autoFinish: false,
    units: [{ chessId: ELA, row: 10, col: 3, uid: 1, skillIndex: 1 }, { kind: 'token', tokenId: MINE, ownerUid: 1, row: 11, col: 6, uid: 2 }],
    enemies: [{ key: 'enemy_walker', time: 1, route, count: 2, interval: 0.5 }],
    setup: (b) => {
      b.on('death', (c) => { if (c.unit.defId === MINE) deaths.push(c.reason); });
      b.on('attack', (c) => { if (c.attacker.defId === MINE) atk.push(b.time); });
      b.on('statusApplied', (c) => { if (c.source && c.source.defId === MINE) st.push({ t: b.time, status: c.status, d: c.duration, id: c.target.id }); });
    },
  });
  h.run(0.5);
  const mine = unitOf(h, 2);
  assert.ok(mine.kit.trap && mine.kit.trait.noAttack);
  assert.ok(mine.s.flags.untargetable, '不会受到攻击');
  h.runUntil(() => !mine.alive, 30);
  assert.ok(!mine.alive, 'used up');
  assert.deepEqual(deaths, ['expired'], 'used up, not knocked out');
  assert.deepEqual(atk, [], 'never attacks');
  const stuns = st.filter((x) => x.status === 'stun');
  assert.ok(stuns.length >= 1 && stuns.every((x) => x.d === 4), JSON.stringify(st));
  assert.equal(new Set(stuns.map((x) => x.t)).size, 1, 'one trigger');
  h.run(10);
  assert.ok(!mine.alive, 'stock 1 used: no return');
  noErrors(h);
});

test('多萝西: "部署后立刻在攻击范围内召唤2个共振装置" — two more besides her piece, not taken from the 8 of the stock, in her range', REAL, () => {
  const D = wgId('char_4048_doroth'), RES = 'token_10025_doroth_recttp';
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 20, autoFinish: false,
    units: [{ chessId: D, row: 10, col: 4, uid: 1 }, { kind: 'token', tokenId: RES, ownerUid: 1, row: 12, col: 8, uid: 2 }],
  });
  h.run(1);
  const d = unitOf(h, 1);
  const up = standing(h, RES);
  assert.equal(up.length, 3, 'her piece + 2');
  assert.equal(d.mem.genericSummons.infos[0].group.left, 7, '8 − her one piece');
  const range = new Set(d.rangeKeys);
  for (const t of up.filter((u) => u.uid == null)) assert.ok(range.has(t.tileR * 21 + t.tileC), 'in her range');
  noErrors(h);
});

test('the equipped module raises the stock: 令 SUM-Y "召唤物持有上限+3" (5 → 8), 白铁 "<支援装置>的持有上限+1" (3 → 4); without it the talent\'s count', REAL, () => {
  const stockOf = (chessId, tokenId, moduleId, pieces) => {
    const h = makeBattle({
      defs: { chess: WG }, timeLimit: 10, autoFinish: false,
      units: [{ chessId, row: 10, col: 3, uid: 1, skillIndex: 0, ...(moduleId ? { moduleId } : {}) }, ...Array.from({ length: pieces }, (_, i) => ({ kind: 'token', tokenId, ownerUid: 1, row: 10, col: 5 + i, uid: 2 + i }))],
    });
    h.run(0.5);
    noErrors(h);
    const g = unitOf(h, 1).mem.genericSummons.infos.find((i) => i.id === tokenId).group;
    return g.left + standing(h, tokenId).length;
  };
  const L = wgId('char_2023_ling', { elite: true }), S1 = 'token_10020_ling_soul1';
  assert.equal(stockOf(L, S1, null, 3), 8, 'SUM-Y (default module)');
  assert.equal(stockOf(L, S1, 'none', 3), 5, 'no module');
  assert.equal(stockOf(wgId('char_2023_ling'), S1, null, 3), 5, 'normal');
  const I = wgId('char_4072_ironmn', { elite: true }), P1 = 'token_10027_ironmn_pile1';
  const mod = WG[I].modules.find((m) => m.isDefault)?.uniEquipId ?? WG[I].modules[0].uniEquipId;
  assert.equal(stockOf(I, P1, mod, 2), 4);
  assert.equal(stockOf(I, P1, 'none', 2), 3);
});

test('白铁 节约经费 with his module: "周围8格存在自身装置时技力回复速度+0.2/秒"; a device destroyed next to him comes back to the stock with the talent\'s chance (90 %)', REAL, () => {
  const I = wgId('char_4072_ironmn', { elite: true }), P1 = 'token_10027_ironmn_pile1';
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 30, autoFinish: false, seed: 5,
    units: [{ chessId: I, row: 10, col: 4, uid: 1, skillIndex: 0, moduleId: WG[I].modules.find((m) => m.isDefault).uniEquipId }, { kind: 'token', tokenId: P1, ownerUid: 1, row: 10, col: 5, uid: 2 }, { kind: 'token', tokenId: P1, ownerUid: 1, row: 12, col: 8, uid: 3 }],
  });
  h.run(0.5);
  const iron = unitOf(h, 1);
  assert.equal(iron.findBuff(`gs:nearDevice:${iron.id}`)?.mods.spRecoveryFlat, 0.2);
  const g = iron.mem.genericSummons.infos.find((i) => i.id === P1).group;
  assert.equal(g.left, 2, '3 + 1 (module) − 2 placed');
  let back = 0;
  h.b.rng.chance = () => true; // the 90 % roll succeeds
  h.b.kill(unitOf(h, 3)); // far: no roll
  back = g.left;
  h.b.kill(unitOf(h, 2)); // next to him: +1
  assert.equal(g.left - back, 1);
  h.run(0.2);
  assert.ok(!iron.findBuff(`gs:nearDevice:${iron.id}`), 'no device next to him any more');
});

// =================================================================================================================
// summons without a hand piece

test('维什戴尔 "部署后立刻在攻击范围内召唤一个魂灵之影"; 死芒 "攻击范围内敌人被击倒时生成一个悲叹的仆役，最多召唤3个"', REAL, () => {
  const WIS = wgId('char_1035_wisdel'), NEC = wgId('char_450_necras');
  const h = makeBattle({
    defs: { chess: WG, enemies: { enemy_dummy: dummy() } }, timeLimit: 30, autoFinish: false,
    units: [{ chessId: WIS, row: 12, col: 3, uid: 1 }, { chessId: NEC, row: 10, col: 5, uid: 2 }],
    enemies: [[10, 6], [10, 7], [9, 6], [11, 6], [9, 7]].map(([r, c]) => ({ key: 'enemy_dummy', pos: [r, c], route: { motion: 'WALK', start: [r, c], end: [r, c], checkpoints: [{ type: 'WAIT', time: 99 }] } })),
  });
  h.run(0.5);
  const wis = unitOf(h, 1), nec = unitOf(h, 2);
  const ward = standing(h, 'token_10035_wisdel_wward');
  assert.equal(ward.length, 1);
  assert.ok(new Set(wis.rangeKeys).has(ward[0].tileR * 21 + ward[0].tileC), 'in her range');
  const range = new Set(nec.rangeKeys);
  const inRange = h.b.enemies.filter((e) => e.alive && range.has(Math.round(e.y) * 21 + Math.round(e.x)));
  assert.ok(inRange.length >= 4, `${inRange.length} enemies in 死芒's range`);
  for (const e of inRange) h.b.kill(e, nec);
  assert.equal(standing(h, 'token_10043_necras_skeltn').length, 3, 'at most 3');
  noErrors(h);
});

test('W S2 惊吓盒子: the skill lays a mine on a free ground tile of its range with no enemy on it; it lasts 120 s', REAL, () => {
  const Wc = wgId('char_113_cqbw'), BOX = 'token_10008_cqbw_box';
  const h = makeBattle({
    defs: { chess: WG, enemies: { enemy_dummy: dummy() } }, timeLimit: 200, autoFinish: false,
    units: [{ chessId: Wc, row: 10, col: 4, uid: 1, skillIndex: 1 }],
    enemies: [{ key: 'enemy_dummy', pos: [11, 6], route: { motion: 'WALK', start: [11, 6], end: [11, 6], checkpoints: [{ type: 'WAIT', time: 999 }] } }],
  });
  h.run(0.5);
  const w = unitOf(h, 1);
  assert.equal(tokensOf(h, BOX).length, 0, 'nothing before the skill');
  w.skill.activate('test', { free: true });
  h.run(0.2);
  const [box] = standing(h, BOX);
  assert.ok(box, 'laid');
  assert.ok(box.kit.trap);
  assert.ok(!(box.tileR === 11 && box.tileC === 6), 'not under the enemy');
  assert.ok(new Set(w.rangeKeys).has(box.tileR * 21 + box.tileC));
  assert.ok(Math.abs(box.mem.expiresAt - h.b.time - 120) < 0.3, `120 s (${box.mem.expiresAt - h.b.time})`);
  noErrors(h);
});

// =================================================================================================================
// owner → summon

test('summon links of the SELECTED skill: 电弧 S1 "自身和召唤物防御力+40%" on 戴乌 while it runs; 凯尔希 S3 "Mon3tr的防御力+120%…攻击力+160%" on Mon3tr only; 电弧 鼓舞 12%', REAL, () => {
  const RAD = wgId('char_4195_radian'), T1 = 'token_10051_radian_tower1';
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 60, autoFinish: false,
    units: [
      { chessId: RAD, row: 10, col: 3, uid: 1, skillIndex: 0 }, { kind: 'token', tokenId: T1, ownerUid: 1, row: 10, col: 5, uid: 2 },
      { chessId: KALTS, row: 12, col: 3, uid: 3, skillIndex: 2 }, { kind: 'token', tokenId: MON, ownerUid: 3, row: 12, col: 4, uid: 4 },
    ],
  });
  h.run(0.5);
  const rad = unitOf(h, 1), dai = unitOf(h, 2), k = unitOf(h, 3), mon = unitOf(h, 4);
  const insp = dai.findBuff(`gs:inspire:${rad.id}`);
  assert.ok(insp, '鼓舞');
  assert.deepEqual([insp.mods.atkPct, insp.mods.defPct, insp.mods.hpPct], [0.12, 0.12, 0.12]);
  assert.ok(!dai.findBuff(`gs:link:${rad.id}`));
  rad.skill.activate('test', { free: true });
  h.run(0.1);
  assert.equal(dai.findBuff(`gs:link:${rad.id}`)?.mods.defPct, 0.4);
  rad.skill.end('test');
  h.run(0.1);
  assert.ok(!dai.findBuff(`gs:link:${rad.id}`), 'gone with the skill');
  k.skill.activate('test', { free: true });
  h.run(0.1);
  const link = mon.findBuff(`gs:link:${k.id}`);
  assert.ok(link, 'Mon3tr linked');
  assert.equal(link.mods.atkPct, 1.6);
  assert.equal(link.mods.defPct, 1.2);
  assert.ok(!k.kit.skill.mods?.atkPct && !k.kit.skill.mods?.defPct, '凯尔希 herself gets neither');
  noErrors(h);
});

test('lifetimes: 涤火杰西卡 机动盾牌 "持续50秒", S1 "机动盾牌持续时间+20秒" ⇒ 70 s; 温蒂 蓄水炮 20 s then back after 35 s; 鸿雪 S2 "再部署时间缩短至65%"', REAL, () => {
  const J = wgId('char_1034_jesca2'), SH = 'token_10032_jesca2_jckshd';
  const life = (skillIndex) => {
    const h = makeBattle({ defs: { chess: WG }, timeLimit: 100, autoFinish: false, units: [{ chessId: J, row: 10, col: 4, uid: 1, skillIndex }, { kind: 'token', tokenId: SH, ownerUid: 1, row: 10, col: 5, uid: 2 }] });
    h.run(0.2);
    return Math.round(unitOf(h, 2).mem.expiresAt);
  };
  assert.equal(life(1), 50);
  assert.equal(life(0), 70);
  const WD = wgId('char_400_weedy'), CAN = 'token_10009_weedy_cannon';
  const deploys = [];
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 100, autoFinish: false,
    units: [{ chessId: WD, row: 10, col: 4, uid: 1 }, { kind: 'token', tokenId: CAN, ownerUid: 1, row: 10, col: 5, uid: 2 }],
    setup: (b) => watchDeploys(b, (u) => u.defId === CAN, deploys),
  });
  h.run(60);
  assert.deepEqual(deploys.map((d) => Math.round(d.t)), [0, 55], '20 s on the field + 35 s redeploy time');
  assert.equal(deploys[1].paid, 5);
  noErrors(h);
  const BG = wgId('char_4055_bgsnow'), TW = 'token_10026_bgsnow_subbow';
  const back = (skillIndex) => {
    const out = [];
    const g = makeBattle({ defs: { chess: WG }, timeLimit: 100, autoFinish: false, units: [{ chessId: BG, row: 10, col: 4, uid: 1, skillIndex }, { kind: 'token', tokenId: TW, ownerUid: 1, row: 10, col: 5, uid: 2 }], setup: (b) => watchDeploys(b, (u) => u.defId === TW, out) });
    g.run(70);
    noErrors(g);
    return out.map((d) => Math.round(d.t));
  };
  assert.deepEqual(back(0), [0, 65], '25 s + 40 s');
  assert.deepEqual(back(1), [0, 51], '25 s + 40 s × 65 %');
});

test('container (令 "可以使用5个召唤物（最多同时部署3个）"): docked pieces come back after their redeploy time paying their cost while the 5 last; then no more', REAL, () => {
  const L = wgId('char_2023_ling'), S1 = 'token_10020_ling_soul1';
  const deploys = [];
  const h = makeBattle({
    defs: { chess: WG }, timeLimit: 200, autoFinish: false,
    units: [
      { chessId: L, row: 10, col: 3, uid: 1, skillIndex: 0 },
      ...[5, 6, 7].map((c, i) => ({ kind: 'token', tokenId: S1, ownerUid: 1, row: 10, col: c, uid: 2 + i })),
    ],
    setup: (b) => watchDeploys(b, (u) => u.defId === S1, deploys),
  });
  h.run(0.5);
  const ling = unitOf(h, 1);
  const grp = ling.mem.genericSummons.infos.find((i) => i.id === S1).group;
  assert.equal(standing(h, S1).length, 3, 'three at once');
  assert.equal(grp.left, 2);
  const souls = [2, 3, 4].map((u) => unitOf(h, u));
  h.b.getPlayer('p1').dp = 99;
  h.b.kill(souls[0]);
  h.run(10.6);
  assert.ok(souls[0].alive, 'back after 10 s');
  assert.equal(deploys.at(-1).paid, 12, 'paying its 12 DP');
  h.b.getPlayer('p1').dp = 99;
  h.b.kill(souls[1]);
  h.run(10.6);
  assert.ok(souls[1].alive);
  assert.equal(grp.left, 0, 'the five are used');
  h.b.getPlayer('p1').dp = 99;
  h.b.kill(souls[2]);
  h.run(30);
  assert.ok(!souls[2].alive, 'used up: no more this battle');
  noErrors(h);
});

test('淬羽赫默 S2 "技能期间可以使用一个辅助无人机": 夜灯 takes the field only while the skill runs and leaves with it', REAL, () => {
  const SL = wgId('char_1031_slent2'), LAMP = 'token_10029_slent2_protrb';
  const h = makeBattle({ defs: { chess: WG }, timeLimit: 120, autoFinish: false, units: [{ chessId: SL, row: 10, col: 4, uid: 1, skillIndex: 1 }, { kind: 'token', tokenId: LAMP, ownerUid: 1, row: 10, col: 5, uid: 2 }] });
  h.run(0.5);
  const sl = unitOf(h, 1), lamp = unitOf(h, 2);
  if (lamp.alive) h.b.retreat(lamp, { reason: 'expired', permanent: true }); // the battle-start deployment
  h.run(10);
  assert.ok(!lamp.alive, 'not without the skill');
  sl.skill.activate('test', { free: true });
  h.run(0.6);
  assert.ok(lamp.alive, 'with the skill');
  sl.skill.end('test');
  h.run(20);
  assert.ok(!lamp.alive, 'gone with the skill, and not back after it');
  noErrors(h);
});

// =================================================================================================================
// owner-kit opt-outs (docs/WAIGUAN-KITS.md, last paragraph)

/** A minimal hand-authored 凯尔希 kit (no skill) with the given flags. */
const kaltsKit = (flags) => ({ [KALTS]: () => ({ skill: null, talents: [], genericSummons: true, ...flags }) });
/** Mon3tr's DEF on the field (outside 凯尔希's range) and the true damage of 不毁重构 when it is knocked out. */
function burstDamage(kits) {
  let dmg = 0;
  const h = makeBattle({
    defs: { chess: WG, enemies: { enemy_dummy: dummy() } }, timeLimit: 20, autoFinish: false, kits,
    units: [{ chessId: KALTS, row: 10, col: 2, uid: 1 }, { kind: 'token', tokenId: MON, ownerUid: 1, row: 10, col: 8, uid: 2 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 9], route: { motion: 'WALK', start: [10, 9], end: [10, 9], checkpoints: [{ type: 'WAIT', time: 999 }] } }],
    setup: (b) => b.on('damaged', (c) => { if (c.source?.defId === MON && c.target.side === 'enemy' && (c.type ?? c.dmg?.type) === 'true') dmg += c.amount; }),
  });
  h.run(0.5);
  const mon = unitOf(h, 2);
  const def0 = mon.s.def;
  h.b.kill(mon);
  h.run(0.1);
  noErrors(h);
  return { dmg, def0, kit: mon.kit };
}

test('generic summon talents: Mon3tr 不毁重构 (1200 true when knocked out) and "不在凯尔希攻击范围内时防御力降至0"', REAL, () => {
  const r = burstDamage(undefined);
  assert.equal(Math.round(r.dmg), 1200);
  assert.equal(r.def0, 0, 'outside 凯尔希\'s range: DEF 0');
  assert.ok(!r.kit.ownerManaged);
});

test('owner kit `managedTokenTalents`: a hand kit that runs 不毁重构 itself switches the generic one off (no double burst); `true` switches all off', REAL, () => {
  const named = burstDamage(kaltsKit({ managedTokenTalents: { [MON]: ['不毁重构'] } }));
  assert.equal(named.dmg, 0, 'no generic burst');
  assert.equal(named.def0, 0, 'the other talent still runs');
  const byPattern = burstDamage(kaltsKit({ managedTokenTalents: { [MON]: ['F10.deathBurst'] } }));
  assert.equal(byPattern.dmg, 0, 'by pattern id too');
  const all = burstDamage(kaltsKit({ managedTokenTalents: { [MON]: true } }));
  assert.equal(all.dmg, 0);
  assert.ok(all.def0 > 0, 'no generic talent at all');
});

test('owner kit `tokenKits`: the hand kit hands its summon a kit (owner-managed: no generic talents); the generic summoner runs for a hand kit only with `genericSummons: true`', REAL, () => {
  let made = 0;
  const own = burstDamage(kaltsKit({ tokenKits: { [MON]: () => { made++; return { skill: null, talents: [], trait: {} }; } } }));
  assert.ok(made >= 1);
  assert.ok(own.kit.ownerManaged);
  assert.equal(own.dmg, 0);
  assert.ok(own.def0 > 0);
  const back = (flags) => {
    const h = makeBattle({ defs: { chess: WG }, timeLimit: 60, autoFinish: false, kits: kaltsKit(flags), units: [{ chessId: KALTS, row: 10, col: 4, uid: 1 }, { kind: 'token', tokenId: MON, ownerUid: 1, row: 10, col: 5, uid: 2 }] });
    h.run(0.5);
    h.b.getPlayer('p1').dp = 50;
    h.b.kill(unitOf(h, 2));
    h.run(26);
    noErrors(h);
    return unitOf(h, 2).alive;
  };
  assert.equal(back({ genericSummons: false }), false, 'a hand kit without the flag: its own job');
  assert.equal(back({ genericSummons: true, managedTokenTalents: { [MON]: ['不毁重构'] } }), true);
});

// =================================================================================================================

test('determinism: the same seed gives the same summon battle', REAL, () => {
  const once = () => {
    const out = [];
    const h = makeBattle({
      defs: { chess: WG, enemies: { enemy_walker: walker({ hp: 20000, atk: 300 }) } }, seed: 11, timeLimit: 60,
      units: [
        { chessId: ELA, row: 10, col: 4, uid: 1, skillIndex: 2 }, ...[[11, 8], [11, 6], [12, 7]].map(([r, c], i) => ({ kind: 'token', tokenId: MINE, ownerUid: 1, row: r, col: c, uid: 2 + i })),
        { chessId: KALTS, row: 9, col: 4, uid: 6, skillIndex: 1 }, { kind: 'token', tokenId: MON, ownerUid: 6, row: 9, col: 5, uid: 7 },
      ],
      enemies: [{ key: 'enemy_walker', time: 1, route: { motion: 'WALK', start: [11, 10], end: [9, 2], checkpoints: [] }, count: 8, interval: 3 }],
      setup: (b) => { b.on('deploy', (c) => out.push(`${b.time.toFixed(2)}+${c.unit.id}`)); b.on('death', (c) => out.push(`${b.time.toFixed(2)}-${c.unit.id}${c.reason}`)); },
    });
    h.run(60);
    noErrors(h);
    return out.join('|') + JSON.stringify(h.b.result?.() ?? null);
  };
  const a = once();
  assert.ok(a.length > 20);
  assert.equal(a, once());
});

// =================================================================================================================
// summon-passive skills: "被动效果：陷阱/棋子…触发时…" describes the summon; the operator gets its active half only

test('generic skill spec: a summon-passive half never becomes the operator\'s own effect (望 棋子, 多萝西 / 艾拉 陷阱)', REAL, async () => {
  const { genericSkillSpec } = await import('../../server/sim/content/generic.js');
  const { wgSource } = await import('../helpers/waiguan.js');
  const spec = (charId, index) => {
    const def = wgSource().getChess(wgId(charId, { elite: true }), { skillIndex: index });
    return genericSkillSpec(def.skill, def.skill.bb, def);
  };
  for (const i of [0, 1, 2]) {
    const w = spec('char_2027_wang', i);
    assert.equal(w.attack?.atkScale, undefined, `望 S${i + 1}: the 棋子 scale is not hers`);
    assert.deepEqual(w.mods ?? {}, {}, `望 S${i + 1}`);
    const d = spec('char_4048_doroth', i);
    assert.equal(d.attack?.atkScale, undefined, `多萝西 S${i + 1}: the trap scale is not hers`);
  }
  // 艾拉: S2's active half (防御力+250%, 无视500防御) and S3's (攻击力+60%, 攻击间隔缩短) stay; the trap's stun / 脆弱 do not
  const e2 = spec('char_4123_ela', 1), e3 = spec('char_4123_ela', 2);
  assert.equal(e2.mods.defPct, 2.5);
  assert.equal(e2.mods.defIgnoreFlat, 500);
  assert.equal(e3.mods.atkPct, 0.6);
  assert.equal(e3.mods.batPct, -0.35);
  assert.equal(e3.mods.dmgDealtMul, undefined, 'the trap\'s 25% 脆弱 is not her damage');
  for (const s of [e2, e3]) assert.ok(!(s.startStatuses ?? []).length && !(s.hitStatuses ?? []).length, 'no trap statuses on her');
});
