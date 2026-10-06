// test/content/waiguan/char_2023_ling.test.js — 令 外援 kit (server/sim/content/kits/waiguan/char_2023_ling.js).
// Every skill (normal Lv4 + elite Lv7) with its summon piece, both talents (holding / returns / deploy limit, SP + ATK on
// a summon's loss), the S3 merge, the SUM-Y module against 'none' (both tiers' elites), a smoke wave per skill. Expected
// numbers come from the records (skill bb, token variants), never literals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { skillSpecSource } from '../../../server/sim/content/index.js';
import WAIGUAN from '../../../server/sim/content/kits/waiguan/index.js';
import { GameData } from '../../../server/match/gamedata.js';

const CHAR = 'char_2023_ling';
const ID5 = `chess_char_diy_5_${CHAR}_a`, ID6 = `chess_char_diy_6_${CHAR}_a`;
const ELITE5 = ID5.replace(/_a$/, '_b'), ELITE6 = ID6.replace(/_a$/, '_b');
const S1 = 'skchr_ling_1', S2 = 'skchr_ling_2', S3 = 'skchr_ling_3';
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const REC = waiguanRecords(DATA.waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
/** The hand pieces a player gets with a loadout (GameData.placeableTokens: token + count — KIT_CONVENTIONS 16). */
const GD = new GameData(DATA, 'mode_multi_normal', { chess: REC });
const PIECE_TILES = [[10, 6], [10, 7], [9, 6], [11, 7], [9, 7], [12, 6], [10, 8], [12, 7], [9, 8]];
const handPieces = (id, skillIndex) => GD.placeableTokens(id, { skillIndex }).flatMap(({ tokenId, count }) => Array.from({ length: count }, () => tokenId))
  .slice(0, PIECE_TILES.length).map((tokenId, i) => ({ uid: 10 + i, kind: 'token', tokenId, ownerUid: 1, row: PIECE_TILES[i][0], col: PIECE_TILES[i][1] }));
const rec = (id) => REC[id];
const skillOf = (id, sid) => rec(id).skills.find((s) => s.skillId === sid);
const sbb = (id, sid) => skillOf(id, sid).bb;
/** The summon piece of skill `sid` (the skill record's overrideTokenKey). */
const soulOf = (id, sid) => skillOf(id, sid).overrideTokenKey;
/** Loadout-resolved record of `id` with skill `sid` / module `moduleId`. */
const loadout = (id, sid = S1, moduleId = null) => DS.getChess(id, { skillIndex: skillOf(id, sid).index, moduleId });
/** Token def of the owner's loadout. */
const tokenDef = (id, sid, moduleId = null) => DS.getToken(soulOf(id, sid), id, loadout(id, sid, moduleId).loadout);
const tal = (id, i, sid = S1, moduleId = null) => loadout(id, sid, moduleId).raw.talents.find((t) => t.index === i && !t.hidden)?.bb ?? {};
const num = (v) => (Number.isFinite(v) ? v : 0);
/** "最多同时部署N个": the token's base deploy limit + its hidden talent max_deploy_count. */
const maxLive = (id, sid, moduleId = null) => {
  const d = tokenDef(id, sid, moduleId);
  return (d.stats.deployLimit ?? d.raw.deployLimit ?? 1) + num(d.talents.find((t) => t.bb && t.bb.max_deploy_count != null)?.bb.max_deploy_count);
};
const tokBb = (id, sid, key) => { const bb = tokenDef(id, sid).skill?.bb ?? {}; const k = Object.keys(bb).find((x) => x === key || x.endsWith(`.${key}`)); return k ? bb[k] : undefined; };
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e7, speed: 0, ...o });
const DEFS = { chess: REC, enemies: { enemy_dummy: dummy('enemy_dummy'), enemy_fly: dummy('enemy_fly', { motion: 'FLY' }) } };
const HOOKS = ['damaged', 'skillStart', 'skillEnd', 'statusApplied', 'death', 'deploy', 'kill'];
const run = (o) => makeBattle({ defs: DEFS, seed: 7, timeLimit: 300, autoFinish: false, hooks: HOOKS, captureNoisy: true, ...o });
/** 令 (uid 1) with skill `sid`, facing right. */
const L = (id, sid, row, col, o = {}) => ({ uid: 1, chessId: id, row, col, skillIndex: skillOf(id, sid).index, ...o });
/** A summon piece of hers. */
const P = (tokenId, uid, row, col, o = {}) => ({ uid, kind: 'token', tokenId, ownerUid: 1, row, col, ...o });
const READY = { sp: 999 };
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`);
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const at = (h, e) => [Math.round(e.y), Math.round(e.x)].join(',');

test('令: every skill of both tiers (normal + elite, every module) is hand-authored', () => {
  for (const id of [ID5, ID6]) {
    assert.equal(typeof WAIGUAN[id], 'function', `${id} registered`);
    for (const cid of [id, id.replace(/_a$/, '_b')]) {
      const mods = [null, 'none', ...(rec(cid).modules ?? []).map((m) => m.uniEquipId)];
      for (const s of rec(cid).skills) for (const moduleId of cid.endsWith('_b') ? mods : [null]) {
        assert.equal(skillSpecSource(DS.getChess(cid, { skillIndex: s.index, moduleId }), WAIGUAN), 'skills', `${cid} ${s.skillId} ${moduleId}`);
      }
    }
  }
});

test('令 S1: she and her summons ATK +atk, ASPD +attack_speed, summons deal arts; +cnt summon at the start', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, S1);
    const h = run({ units: [L(id, S1, 10, 4, { carryState: READY }), P(soulOf(id, S1), 2, 10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
    const u = h.unit(1), s = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts');
    assert.equal(u.skill.rule, 'DEFAULT');
    // the battle-start deployment used one of her holding, the cast gave cnt
    assert.equal(u.mem.lingHold, Math.min(u.mem.lingHoldCap, num(tal(id, 0).cnt) - 1 + bb.cnt), 'gains cnt summon(s)');
    close(u.s.atk, u.base.atk * (1 + bb.atk), 1e-6, 'her ATK');
    assert.equal(u.s.aspd, 100 + bb.attack_speed);
    close(s.s.atk, s.base.atk * (1 + bb.atk), 1e-6, 'summon ATK');
    assert.equal(s.s.aspd, 100 + bb.attack_speed);
    const t0 = h.hooksOf('skillStart')[0].t;
    h.run(6);
    const during = h.hooksOf('damaged').filter((c) => c.source === s && c.dmg.isAttack && c.t >= t0);
    assert.ok(during.length && during.every((c) => c.type === 'arts'), 'summon attacks deal arts');
    assert.ok(h.runUntil(() => !u.skill.active, 40));
    const t1 = h.b.time;
    h.run(4);
    assert.ok(h.hooksOf('damaged').filter((c) => c.source === s && c.dmg.isAttack && c.t > t1).every((c) => c.type === 'phys'), 'physical again');
    close(s.s.atk, s.base.atk, 1e-6, 'summon buff gone');
    done(h);
  }
});

test('令 S2: she and each summon strike `value` enemies (atk_scale × own ATK arts + bind); summons below hp_ratio recalled', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, S2);
    for (const low of [true, false]) {
      const h = run({
        units: [L(id, S2, 10, 4, { carryState: READY }), P(soulOf(id, S2), 2, 11, 5)],
        enemies: [{ key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 7] }],
        // the summon deploys below (or at) the recall threshold
        setup: (b) => b.on('deploy', (c) => { if (c.unit.kind === 'token') c.unit.hp = c.unit.s.maxHp * (low ? bb.hp_ratio - 0.1 : bb.hp_ratio); }),
      });
      const u = h.unit(1), s = h.unit(2);
      assert.ok(h.runUntil(() => u.skill.activations > 0, 5), 'casts');
      assert.equal(u.skill.kind, 'charges');
      assert.equal(u.skill.maxCharges, skillOf(id, S2).maxChargeTime);
      const t0 = h.hooksOf('skillStart')[0].t;
      const strikes = h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('lingS2') && c.t === t0);
      const mine = strikes.filter((c) => c.source === u), its = strikes.filter((c) => c.source === s);
      assert.equal(mine.length, bb.value, 'her strikes');
      assert.equal(its.length, bb.value, 'the summon strikes too');
      // (no ATK buff at the cast: T2's stack of the recall comes after the strikes)
      for (const c of mine) { assert.equal(c.type, 'arts'); close(c.amount, u.base.atk * bb.atk_scale, 1e-6, 'her damage'); }
      for (const c of its) { assert.equal(c.type, 'arts'); close(c.amount, s.base.atk * tokBb(id, S2, 'atk_scale'), 1e-6, 'its damage (token 2.atk_scale)'); }
      const binds = h.hooksOf('statusApplied').filter((c) => c.status === 'bind' && c.t === t0);
      assert.ok(binds.filter((c) => c.source === u).every((c) => c.duration === bb['ling_s2_unmovable.duration']) && binds.length === 2 * bb.value, 'bind');
      assert.ok(binds.filter((c) => c.source === s).every((c) => c.duration === tokBb(id, S2, 'duration')));
      const recall = h.hooksOf('death').find((c) => c.unit === s);
      if (low) {
        assert.ok(recall && recall.reason === 'retreat' && recall.t === t0, 'recalled at the skill end');
        assert.equal(s.removed, false, 'still a board piece');
      } else assert.equal(recall, undefined, 'at the threshold it stays');
      done(h);
    }
  }
});

test('令 S2 recall: back into her holding (cnt), T2 fires, the piece returns after its redeploy time paying its cost', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, S2), t1 = tal(id, 1, S2);
    const h = run({
      units: [L(id, S2, 10, 4, { carryState: { sp: skillOf(id, S2).spCost } }), P(soulOf(id, S2), 2, 11, 5)],
      enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
      hooks: [...HOOKS, 'spGain'],
      setup: (b) => b.on('deploy', (c) => { if (c.unit.kind === 'token' && c.initial) c.unit.hp = c.unit.s.maxHp * 0.1; }),
    });
    const u = h.unit(1), s = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.activations > 0, 5));
    assert.equal(s.alive, false);
    const held = num(tal(id, 0, S2).cnt) - 1 + bb.cnt;
    assert.equal(u.mem.lingHold, held, 'the battle-start piece used one, the recall gave cnt back');
    assert.equal(u.findBuff('ling:t2')?.stacks, 1, 'T2 ATK stack');
    close(u.s.atk, u.base.atk * (1 + t1.atk), 1e-6, 'ATK +atk');
    assert.ok(h.hooksOf('spGain').some((c) => c.unit === u && c.reason === 'talent' && c.amount === t1.sp), 'T2 SP');
    const dp = h.b.getPlayer('p1').dp, tl = h.b.time;
    assert.ok(h.runUntil(() => s.alive, s.base.respawnTime + 1), 'back');
    close(h.b.time - tl, s.base.respawnTime, 0.3, 'after its redeploy time');
    close(h.b.getPlayer('p1').dp, dp + (h.b.time - tl) - s.base.cost, 1e-6, 'paid its cost');
    assert.equal(u.mem.lingHold, held - 1, 'used one');
    done(h);
  }
});

test('令 S3: she and her summons ATK +atk / DEF +def; summons pulse atk_scale × HER ATK arts at ground enemies around them; +cnt at the end', () => {
  for (const id of [ID6, ELITE6]) {
    const bb = sbb(id, S3), dur = skillOf(id, S3).duration;
    const h = run({
      units: [L(id, S3, 10, 4, { carryState: READY }), P(soulOf(id, S3), 2, 10, 6)],
      enemies: [{ key: 'enemy_dummy', pos: [11, 6] }, { key: 'enemy_dummy', pos: [12, 8] }, { key: 'enemy_dummy', pos: [10, 7] }, { key: 'enemy_fly', pos: [9, 6] }],
    });
    const u = h.unit(1), s = h.unit(2);
    assert.ok(h.runUntil(() => u.skill.active, 5), 'casts');
    const held = u.mem.lingHold;
    close(u.s.atk, u.base.atk * (1 + bb.atk), 1e-6, 'her ATK');
    close(u.s.def, u.base.def * (1 + bb.def), 1e-6, 'her DEF');
    close(s.s.atk, s.base.atk * (1 + bb.atk), 1e-6, 'summon ATK');
    close(s.s.def, s.base.def * (1 + bb.def), 1e-6, 'summon DEF');
    const t0 = h.hooksOf('skillStart')[0].t;
    h.run(2 + 1e-6);
    const [side, far] = h.b.enemies;
    const pulses = h.hooksOf('damaged').filter((c) => c.dmg.tags.includes('lingS3'));
    const onSide = pulses.filter((c) => c.target === side);
    assert.equal(onSide.length, Math.floor(2 / bb.interval + 1e-6), `one per ${bb.interval} s on the tile beside it (${at(h, side)})`);
    for (const c of onSide) { assert.equal(c.source, s); assert.equal(c.type, 'arts'); close(c.amount, u.s.atk * bb.atk_scale, 1e-6, 'her ATK × atk_scale'); }
    assert.equal(pulses.filter((c) => c.target === far).length, 0, 'not two tiles away');
    // ling_s3_aoe[token] AOEDamage targetMotion WALK_ONLY: a flyer on the tile beside it is never hit
    const flyer = h.b.enemies.find((e) => e.isFlying);
    assert.ok(flyer && Math.round(flyer.y) === 9 && Math.round(flyer.x) === 6);
    assert.equal(pulses.filter((c) => c.target === flyer).length, 0, 'no pulse on a flyer');
    assert.ok(h.runUntil(() => !u.skill.active, dur), 'ends');
    assert.equal(h.hooksOf('skillEnd')[0].reason, 'duration');
    assert.equal(u.mem.lingHold, Math.min(u.mem.lingHoldCap, held + bb.cnt), 'gains cnt at the end');
    assert.ok(h.hooksOf('skillEnd')[0].t - t0 > dur - 0.1);
    done(h);
  }
});

test('令 S3 merge: a soul3 deploying with a basic one in its range is absorbed; the host becomes the 高级形态 (token 2.* data)', () => {
  for (const id of [ID6, ELITE6]) {
    const tok = soulOf(id, S3), t1 = tal(id, 1, S3);
    // (10,5) deploys first (left column); (10,6) faces left: (10,5) is in its range
    const h = run({ units: [L(id, S3, 10, 3), P(tok, 2, 10, 5), P(tok, 3, 10, 6, { dir: 'LEFT' })], enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
    const u = h.unit(1), host = h.unit(2), nb = h.unit(3);
    h.run(0.5);
    assert.equal(nb.alive, false, 'the newcomer was absorbed');
    assert.equal(h.hooksOf('death').find((c) => c.unit === nb).reason, 'retreat');
    const adv = host.findBuff('ling:advanced');
    assert.ok(adv, 'the host is the advanced form');
    const sb = host.def.skill.bb, v = (k) => sb[Object.keys(sb).find((x) => x.endsWith(`.${k}`))];
    close(host.s.maxHp, host.base.maxHp * (1 + v('max_hp')), 1e-6, 'max HP');
    close(host.s.atk, host.base.atk * (1 + v('atk')), 1e-6, 'ATK');
    close(host.s.def, host.base.def * (1 + v('def')), 1e-6, 'DEF');
    assert.equal(host.s.blockCnt, host.base.blockCnt + v('block_cnt'));
    close(host.s.interval, host.base.bat + v('base_attack_time'), 1e-6, 'attack interval');
    assert.equal(u.findBuff('ling:t2')?.stacks, 1, 'T2: absorbed');
    close(u.s.atk, u.base.atk * (1 + t1.atk), 1e-6);
    h.run(4);
    assert.ok(h.hooksOf('damaged').filter((c) => c.source === host && c.dmg.isAttack).every((c) => c.type === 'arts'), 'the advanced form deals arts');
    // the absorbed piece returns later (holding) and stands beside the advanced one (no second merge)
    assert.ok(h.runUntil(() => nb.alive, nb.base.respawnTime + 1), 'returns');
    h.run(0.5);
    assert.ok(nb.alive && !nb.findBuff('ling:advanced'), 'no merge into an advanced form');
    done(h);
  }
  // facing away: no merge
  const h = run({ units: [L(ID6, S3, 10, 3), P(soulOf(ID6, S3), 2, 10, 5), P(soulOf(ID6, S3), 3, 10, 6)] });
  h.run(0.5);
  assert.ok(h.unit(2).alive && h.unit(3).alive && !h.unit(2).findBuff('ling:advanced'));
  done(h);
});

test('令: soul3 "攻击阻挡的所有敌人" (its token trait)', () => {
  const h = run({ units: [L(ID6, S3, 10, 3), P(soulOf(ID6, S3), 2, 10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }, { key: 'enemy_dummy', pos: [10, 6] }] });
  const s = h.unit(2);
  h.run(6);
  assert.equal(s.blocking.length, 2);
  const by = new Map();
  for (const c of h.hooksOf('damaged')) if (c.source === s && c.dmg.isAttack) by.set(c.dmg.attackId, (by.get(c.dmg.attackId) ?? 0) + 1);
  assert.ok(by.size > 0 && [...by.values()].every((n) => n === 2), 'every attack hits both');
  done(h);
});

test('令 T1: a summon returns from the holding after its redeploy time, paying its cost; not when the holding is empty or she is down', () => {
  for (const id of [ID6, ELITE6, ELITE5]) {
    const h = run({ units: [L(id, S1, 10, 4), P(soulOf(id, S1), 2, 10, 6)] });
    const u = h.unit(1), s = h.unit(2);
    h.run(1);
    const held = u.mem.lingHold;
    assert.equal(held, num(tal(id, 0).cnt) - 1, 'the battle-start deployment used one of her holding');
    h.b.kill(s);
    const dp = h.b.getPlayer('p1').dp, t0 = h.b.time;
    assert.ok(h.runUntil(() => s.alive, s.base.respawnTime + 1), `${id}: back`);
    close(h.b.time - t0, s.base.respawnTime, 0.3, 'after its redeploy time');
    assert.equal(s.base.cost, tokenDef(id, S1).stats.cost, 'the loadout cost');
    close(h.b.getPlayer('p1').dp, dp + (h.b.time - t0) - s.base.cost, 1e-6, 'paid its cost');
    assert.equal(u.mem.lingHold, held - 1);
    assert.deepEqual([s.tileR, s.tileC], [s.homeR, s.homeC]);
    done(h);
  }
  // holding empty: no return (per battle: REQUIREMENTS §5)
  const h = run({ units: [L(ID6, S1, 10, 4), P(soulOf(ID6, S1), 2, 10, 6)] });
  h.run(1);
  h.unit(1).mem.lingHold = 0;
  h.b.kill(h.unit(2));
  h.run(h.unit(2).base.respawnTime + 5);
  assert.equal(h.unit(2).alive, false, 'no summon left this battle');
  done(h);
  // she is down: it waits for her
  const h2 = run({ units: [L(ID6, S1, 10, 4), P(soulOf(ID6, S1), 2, 10, 6)] });
  h2.run(1);
  h2.b.kill(h2.unit(2));
  h2.b.kill(h2.unit(1));
  h2.run(h2.unit(2).base.respawnTime + 2);
  assert.equal(h2.unit(2).alive, false, 'waits for her');
  assert.ok(h2.runUntil(() => h2.unit(1).alive, h2.unit(1).base.respawnTime + 20));
  assert.ok(h2.runUntil(() => h2.unit(2).alive, 1));
  done(h2);
});

// These multi-piece tests field more pieces than the hand count GameData.placeableTokens gives today (1): they rely on
// stream C's count — deployLimit + the token's hidden max_deploy_count (3, elite SUM-Y 4) — which is also the kit's cap.
test('令 T1: at most N summons stand at once (token deploy limit + max_deploy_count: 3, elite SUM-Y 4, elite none 3)', () => {
  for (const [id, moduleId] of [[ID6, null], [ELITE6, null], [ELITE6, 'none'], [ELITE5, null]]) {
    const n = maxLive(id, S1, moduleId);
    assert.ok(n >= 3, `${id} ${moduleId}: ${n}`);
    // n + 1 pieces (the battle-start deployment places them all), two knocked out ⇒ one comes back
    const pieces = Array.from({ length: n + 1 }, (_, i) => P(soulOf(id, S1), 2 + i, 9 + (i % 3), 6 + Math.floor(i / 3)));
    const h = run({ units: [L(id, S1, 10, 4, { moduleId }), ...pieces] });
    h.run(1);
    const ps = pieces.map((p) => h.unit(p.uid));
    assert.ok(ps.every((p) => p.alive));
    // (n + 1 pieces drew n + 1 of her holding: refill it, only the deploy limit holds them back here)
    h.unit(1).mem.lingHold = h.unit(1).mem.lingHoldCap;
    h.b.kill(ps[0]); h.b.kill(ps[1]);
    h.run(ps[0].base.respawnTime + 2);
    assert.equal(ps.filter((p) => p.alive).length, n, `${id} ${moduleId}: ${n} at once`);
    done(h);
  }
  assert.equal(maxLive(ELITE6, S1) - maxLive(ELITE6, S1, 'none'), 1, 'SUM-Y: one more (data)');
});

test('令 T2: a summon knocked out ⇒ +sp SP and ATK +atk, stacking up to max_stack_cnt', () => {
  for (const id of [ID6, ELITE6]) {
    const t1 = tal(id, 1);
    const pieces = Array.from({ length: t1.max_stack_cnt + 1 }, (_, i) => P(soulOf(id, S1), 2 + i, 9 + (i % 3), 6 + Math.floor(i / 3)));
    const h = run({ units: [L(id, S1, 10, 4), ...pieces] });
    const u = h.unit(1);
    h.run(0.5);
    const sp = u.skill.sp;
    h.b.kill(h.unit(2));
    close(u.skill.sp, sp + t1.sp, 1e-6, 'SP');
    close(u.s.atk, u.base.atk * (1 + t1.atk), 1e-6, 'ATK one stack');
    for (const p of pieces.slice(1)) h.b.kill(h.unit(p.uid));
    assert.equal(u.findBuff('ling:t2').stacks, t1.max_stack_cnt, 'capped');
    close(u.s.atk, u.base.atk * (1 + t1.atk * t1.max_stack_cnt), 1e-6, 'ATK capped');
    // lost when she leaves the field [ASSUMED]
    h.b.kill(u);
    assert.equal(u.findBuff('ling:t2'), null);
    done(h);
  }
});

test('令 module SUM-Y vs none (both tiers): holding cap +trait cnt, cheaper summons (data), stronger summons (data)', () => {
  for (const id of [ELITE5, ELITE6]) {
    for (const moduleId of [null, 'none', ...(rec(id).modules ?? []).map((m) => m.uniEquipId)]) {
      const lo = loadout(id, S1, moduleId).raw;
      const cap = num(tal(id, 0, S1, moduleId).cnt) + num(lo.trait?.bb?.cnt);
      const h = run({ units: [L(id, S1, 10, 4, { moduleId, carryState: READY }), P(soulOf(id, S1), 2, 10, 6)], enemies: [{ key: 'enemy_dummy', pos: [10, 7] }] });
      const u = h.unit(1), s = h.unit(2);
      h.step(1);
      assert.equal(u.mem.lingHoldCap, cap, `${id} ${moduleId}: cap`);
      u.mem.lingHold = cap;
      assert.ok(h.runUntil(() => u.skill.active, 5));
      assert.equal(u.mem.lingHold, cap, 'S1 cannot exceed the cap');
      assert.equal(s.base.cost, tokenDef(id, S1, moduleId).stats.cost, 'its cost from the loadout');
      assert.equal(s.base.atk, tokenDef(id, S1, moduleId).stats.atk);
      done(h);
    }
  }
  assert.ok(loadout(ELITE6).raw.trait.bb.cnt > 0, 'tier VI SUM-Y data');
  assert.ok(tokenDef(ELITE6, S1).stats.cost < tokenDef(ELITE6, S1, 'none').stats.cost, '召唤物部署费用减少 (tier VI data)');
});

test('令: every skill × tier (with her hand pieces placed: GameData.placeableTokens) survives a real wave without content errors and casts', () => {
  for (const id of [ID5, ID6, ELITE5, ELITE6]) {
    for (const s of rec(id).skills) {
      const h = makeBattle({ defs: DEFS, seed: 3, timeLimit: 60,
        units: [L(id, s.skillId, 10, 4, { carryState: READY }), ...handPieces(id, s.index), { uid: 3, chessId: 'chess_char_2_06_a', row: 11, col: 5 }],
        enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
      h.runToEnd(90);
      done(h);
      assert.ok(h.unit(1).skill.activations > 0, `${id} ${s.skillId} casts`);
    }
  }
});
