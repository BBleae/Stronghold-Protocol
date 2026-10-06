// test/data.test.js — integrity tests for the generated game data (data/*.json, task F1).
//
// Loads every file produced by tools/build-data.mjs and checks shapes, counts and cross-file
// referential integrity (bonds ↔ chess, garrisons, items/bands ↔ effects, wave spawns ↔ enemies,
// config rounds ↔ waves, stages 19×21, finite numbers…), plus regression tests for defects found in
// review (module token parts, enemy rangeRadius/undefined-field semantics, token sources).
// When the official-data cache (.cache/gamedata) is present, two more suites run: an independent
// re-derivation of every chess/enemy stat from the raw tables, and an offline rebuild that must
// reproduce data/ byte-for-byte (catches a stale data/ after a build-script change).
// Run: node --test test/data.test.js (build first with `node tools/build-data.mjs` if data/ is missing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waiguanRecords, WAIGUAN_SLOTS, WAIGUAN_TIER_FIELDS, WAIGUAN_ELITE_TIER_FIELDS } from '../shared/waiguan.js';
import { composeStats, composeTalents } from '../shared/loadoutRecord.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR lets the suite validate an alternative build output (e.g. `--out /tmp/x`).
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
const CACHE = join(ROOT, '.cache', 'gamedata');
const HAS_CACHE = ['excel/activity_table.json', 'excel/character_table.json', 'excel/skill_table.json', 'excel/battle_equip_table.json',
  'levels/enemydata/enemy_database.json', 'levels/activities/act1autochess/level_autochess_enemy_data.json']
  .every((rel) => existsSync(join(CACHE, rel)));
const FILES = ['config', 'chess', 'bonds', 'garrisons', 'items', 'bands', 'effects', 'choices', 'enemies', 'factions', 'waves', 'stages', 'bosses', 'tokens', 'waiguan'];

/** Load one data file (fails with a helpful message when the build has not run). */
function load(name) {
  const p = join(DATA, `${name}.json`);
  assert.ok(existsSync(p), `data/${name}.json missing — run: node tools/build-data.mjs`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
const D = Object.fromEntries(FILES.map((f) => [f, load(f)]));
const { config, chess, bonds, garrisons, items, bands, effects, choices, enemies, factions, waves, stages, bosses, tokens, waiguan } = D;

/**
 * Every chess record a token variant may name: data/chess.json plus the 外援 / 甄选 (DIY) roster of data/waiguan.json
 * (which the server merges into a match's own chess table, DESIGN §27). Built by reconstructing the tier V records
 * from the tier VI ones exactly as the server does.
 */
const allChess = { ...chess, ...waiguanRecords(waiguan) };
const waiguanCandidates = waiguan.candidates;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every(isInt);
const normalChess = Object.values(chess).filter((c) => !c.isGolden);
const visible = normalChess.filter((c) => c.visible);

/** Every number reachable in an object is finite (JSON cannot hold NaN, but null stats would slip). */
function assertStatsFinite(stats, label, keys) {
  assert.ok(stats && typeof stats === 'object', `${label}: stats missing`);
  for (const k of keys) assert.ok(isFiniteNum(stats[k]), `${label}: stats.${k} = ${stats[k]}`);
}

test('all data files load and are non-empty; total size < 6 MB', () => {
  let total = 0;
  for (const f of FILES) {
    total += statSync(join(DATA, `${f}.json`)).size;
    assert.ok(Object.keys(D[f]).length > 0, `${f} is empty`);
  }
  assert.ok(total < 6 * 1024 * 1024, `total ${total} bytes`);
});

test('numbers: every stats/bb/enemyScale object holds only finite numbers (no null/NaN leaks)', () => {
  const bad = [];
  const walk = (x, path) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'stats' || k === 'bb' || k === 'enemyScale') && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === null || (typeof sv === 'number' && !Number.isFinite(sv))) bad.push(`${path}.${k}.${sk}`);
        }
      }
      walk(v, `${path}.${k}`);
    }
  };
  for (const f of FILES) walk(D[f], f);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} bad numeric fields`);
});

test('chess: 266 records, 112 visible non-DIY (16/17/19/22/19/19 per tier)', () => {
  assert.equal(Object.keys(chess).length, 266);
  assert.equal(visible.length, 112);
  const perTier = {};
  for (const c of visible) perTier[c.tier] = (perTier[c.tier] || 0) + 1;
  assert.deepEqual(perTier, { 1: 16, 2: 17, 3: 19, 4: 22, 5: 19, 6: 19 });
  assert.equal(normalChess.filter((c) => c.isDiy).length, 4);
  assert.equal(normalChess.filter((c) => c.isHidden).length, 17);
});

// ---- 外援 / 甄选 (DIY) roster (data/waiguan.json, DESIGN §27) --------------------------------------

test('waiguan: 87 candidates × 2 tiers, none of them in the shared chess table', () => {
  assert.ok(waiguanCandidates.length > 50, `expected a broad 6★ roster, got ${waiguanCandidates.length}`);
  assert.equal(Object.keys(waiguan.chess).length, waiguanCandidates.length * 2, 'two tier VI records per candidate');
  assert.equal(Object.keys(waiguan.chessT5).length, waiguanCandidates.length * 2, 'two tier V overlays per candidate');
  // the roster must never leak into data/chess.json: only the four empty DIY slot templates live there
  for (const id of Object.keys(allChess)) {
    if (id.includes('_diy_')) assert.ok(!chess[id], `${id} must not be in data/chess.json`);
  }
  const seen = new Set();
  for (const c of waiguanCandidates) {
    assert.ok(!seen.has(c.charId), `${c.charId}: duplicate candidate`);
    seen.add(c.charId);
    assert.equal(c.rarity, 6);
    assert.ok(c.bonds.length >= 1, `${c.charId}: derivation always yields a bond (协防 fallback)`);
    for (const b of c.bonds) assert.ok(bonds[b], `${c.charId}: bond ${b}`);
    for (const tier of [5, 6]) assert.ok(typeof c.chessIds?.[tier] === 'string', `${c.charId}: tier ${tier} record id`);
  }
  // the pool's own operators are excluded (the player already has them in the shop)
  const poolChars = new Set(Object.values(chess).map((c) => c.charId).filter(Boolean));
  for (const c of waiguanCandidates) assert.ok(!poolChars.has(c.charId), `${c.charId} is a pool operator`);
});

test('waiguan: the roster covers EVERY 6★ of the built data — no gap, no stray entry', { skip: !HAS_CACHE && 'no .cache/gamedata' }, () => {
  // A user reported the roster as incomplete ("我在测试时候没有看到维什戴尔"). It was the picker's broken search box
  // (covered by the browser E2E), but the claim is worth a standing check: against the very official data this build was
  // made from, the 6★ population must split exactly into "the mode's shop pool" and "the 外援 candidates". This reads
  // .cache/gamedata (the source `node tools/build-data.mjs` built data/ from), so publishing a newer official version and
  // rebuilding moves the check with the data instead of pinning a list here.
  const charTableFile = join(CACHE, 'excel/character_table.json');
  assert.ok(existsSync(charTableFile), 'the official character table is cached (run tools/build-data.mjs once)');
  const charTable = JSON.parse(readFileSync(charTableFile, 'utf8'));
  const six = Object.entries(charTable).filter(([id, c]) => /^char_/.test(id) && c?.rarity === 'TIER_6');
  assert.ok(six.length > 100, `the official data holds ${six.length} 6★`);

  // the mode's shop pool, from the same research the build reads
  const pools = JSON.parse(readFileSync(join(ROOT, 'docs/research/03-operators.json'), 'utf8'));
  const poolIds = new Set(pools.chess.filter((c) => !c.isHidden && c.chessType !== 'DIY' && c.charId).map((c) => c.charId));
  assert.ok(poolIds.size > 40, `the pool fields ${poolIds.size} operators`);
  const poolSix = six.filter(([id]) => poolIds.has(id));
  assert.ok(poolSix.length > 40, `${poolSix.length} of the pool's operators are 6★`);

  const candidateIds = new Set(waiguanCandidates.map((c) => c.charId));
  // every 6★ is covered by exactly one of the two sets — nothing missing, nothing listed twice
  const uncovered = six.filter(([id]) => !candidateIds.has(id) && !poolIds.has(id)).map(([id, c]) => `${c.name}(${id})`);
  assert.deepEqual(uncovered, [], 'every 6★ is either a pool operator or a candidate');
  for (const id of candidateIds) {
    assert.equal(charTable[id]?.rarity, 'TIER_6', `${id}: a candidate is a 6★`);
    assert.ok(!poolIds.has(id), `${id}: a 6★ pool operator must not be a candidate too`);
  }
  assert.equal(candidateIds.size, waiguanCandidates.length, 'no duplicate candidate');
  assert.equal(waiguanCandidates.length, six.length - poolSix.length, 'the candidate count is the 6★ complement of the pool');

  // 维什戴尔, the operator the report named: a 6★ outside the pool, selectable at both tiers
  const wisdel = waiguanCandidates.find((c) => c.charId === 'char_1035_wisdel');
  assert.ok(wisdel, '维什戴尔 is a candidate');
  assert.equal(wisdel.name, '维什戴尔');
  assert.ok(!poolIds.has(wisdel.charId), 'and is not in the shop pool');
  for (const tier of [5, 6]) assert.ok(allChess[`chess_char_diy_${tier}_${wisdel.charId}_a`], `维什戴尔 tier ${tier} record`);
});

test('waiguan: every record is a full 6★ chess of its slot tier, without 特质', () => {
  for (const [id, c] of Object.entries(allChess)) {
    if (!id.includes('_diy_')) continue;
    const tier = id.startsWith('chess_char_diy_5_') ? 5 : 6;
    assert.equal(c.chessId, id);
    assert.equal(c.tier, tier, `${id}: tier`);
    assert.equal(c.isDiy, true);
    // `visible` marks a REAL, fieldable operator — a picked 甄选 record is one (it is a 干员调配 target: its skills and
    // module are chosen like any operator's), so hiding it here would make its skill unswitchable. What keeps it out of the
    // shared shop pool is `isDiy` alone — asserted through the very predicate GameData.visibleChess applies.
    assert.equal(c.visible, true, `${id}: a picked 甄选 record is a real operator`);
    assert.equal(c.visible && !c.isGolden && !c.isDiy && !c.isHidden && Number.isInteger(c.tier), false, `${id}: still out of the shop pool`);
    assert.equal(c.rarity, 6, `${id}: the roster is 6★ only`);
    assert.equal(c.garrisonIds.length, 0, `${id}: 甄选 chess have no 特质`);
    assert.ok(c.stats && c.stats.maxHp > 0, `${id}: stats`);
    assert.ok(c.rangeGrid.length, `${id}: range`);
    assert.equal(c.skills.filter((s) => s.isDefault).length, 1, `${id}: one default skill`);
    assert.ok(allChess[c.baseId] && allChess[c.goldenId], `${id}: base / elite pair`);
    assert.ok(c.charId && c.name, `${id}: operator`);
    if (c.isGolden) {
      // An elite carries its own operator's module choices. Two roster operators (凯尔希·思衡托, 予愿安洁莉娜) have no
      // module in the official data at all: the record then carries the placeholder `module` of a module-less elite
      // (id null, active false — the same shape the pool uses) and an empty choice list.
      if ((c.modules || []).length) {
        assert.ok(c.module?.active, `${id}: an elite with module choices has one active`);
        assert.equal(c.modules.filter((m) => m.isDefault).length, 1, `${id}: one default module`);
        const def = c.modules.find((m) => m.isDefault);
        assert.ok(String(def.uniEquipId).endsWith(c.charId.replace(/^char_\d+_/, '')), `${id}: default module belongs to the operator`);
      } else {
        assert.equal(c.module?.active, false, `${id}: no module choices ⇒ nothing active`);
      }
    }
  }
});

test('waiguan: bond derivation uses mainPower AND subPower — checked against the official pool', { skip: !HAS_CACHE && 'no .cache/gamedata' }, () => {
  // The faction ids of a 甄选 candidate come from character_table's mainPower AND its subPower ARRAY. Reading only the
  // top-level nationId / groupId / teamId (a single, often historical faction) gets real operators wrong: 能天使 read as
  // 炎 instead of 拉特兰, 德克萨斯 as 炎 instead of 叙拉古, and 水月 / 百炼嘉维尔 / 卡涅利安 / 烛煌 / 结城理 with no core
  // bond at all. The check below uses the 121 pool operators, whose bonds the official mode STATES, as ground truth.
  const charTable = JSON.parse(readFileSync(join(CACHE, 'excel/character_table.json'), 'utf8'));
  const coreBonds = Object.values(bonds).filter((b) => b.isCore);
  assert.equal(coreBonds.length, 8, `${coreBonds.length} core bonds`);
  const powerOf = (id) => new Set(bonds[id]?.powerIdList || []);
  /** Every faction SOURCE the game files give an operator (its own fields, mainPower, each subPower entry). */
  const factionSourcesOf = (ch) => [ch, ch.mainPower, ...(Array.isArray(ch.subPower) ? ch.subPower : ch.subPower ? [ch.subPower] : [])]
    .filter((s) => s && typeof s === 'object')
    .map((s) => ['nationId', 'groupId', 'teamId'].map((k) => s[k]).filter(Boolean))
    .filter((ids) => ids.length);
  /** The core bonds an operator derives: each source matches on its own and the results are UNIONed. */
  const coreOf = (ch) => {
    const out = new Set();
    for (const ids of factionSourcesOf(ch)) {
      for (const b of coreBonds) if (b.powerIdList.some((p) => ids.includes(p))) out.add(b.bondId);
    }
    return [...out].sort();
  };

  // ground truth: the pool's own records carry the bonds the official mode assigned
  const poolRecs = new Map();
  for (const c of Object.values(chess)) { if (c.charId && !c.isGolden && !poolRecs.has(c.charId)) poolRecs.set(c.charId, c); }
  let checked = 0;
  const onlyExtra = [];
  // The derivation grants EVERY core bond a faction source matches. For 5 企鹅物流 operators the official piece lists a
  // single bond where the character files match two (they carry 龙门 `lungmen` AND 企鹅物流 `penguin`, and 炎's
  // `powerIdList` holds `lungmen`,`penguin`; their `subPower` adds 叙拉古 / 拉特兰). `penguin` is a 炎 power by the
  // mode's own design, so the extra bond is factually right — the official piece is simply the narrower record. They are
  // listed here instead of loosening the assertion, so a NEW divergence still fails.
  const KNOWN_EXTRA = new Set(['德克萨斯', '缄默德克萨斯', '能天使', '新约能天使', '莫斯提马']);
  for (const [charId, rec] of poolRecs) {
    const official = (rec.bonds || []).filter((b) => bonds[b]?.isCore).sort();
    if (!official.length) continue;                       // the mode itself gives this one no core bond
    checked++;
    const derived = coreOf(charTable[charId] || {});
    for (const b of official) assert.ok(derived.includes(b), `${rec.name}: official ${b} is derived (got ${derived.join('/') || 'none'})`);
    // "all matching core bonds" is the official rule, not a single one: 哈洛德 officially carries 维多利亚 AND 谢拉格
    // (main and subPower each contribute one), 烛煌 维多利亚 AND 炎, 锏 谢拉格 AND 卡西米尔.
    const extra = derived.filter((b) => !official.includes(b));
    if (extra.length) {
      onlyExtra.push(rec.name);
      assert.ok(KNOWN_EXTRA.has(rec.name), `${rec.name}: unexpected extra core bond ${extra.join('/')} (official ${official.join('/')})`);
    } else {
      assert.deepEqual(derived.slice().sort(), official.slice().sort(), `${rec.name}: derived core bonds equal the official set`);
    }
  }
  assert.ok(checked >= 75, `${checked} pool operators have a stated core bond`);
  assert.deepEqual(onlyExtra.slice().sort(), [...KNOWN_EXTRA].sort(), 'exactly the known 企鹅物流 operators add one bond');

  // every candidate: core bonds iff the data gives a matching faction, else exactly the 协防 fallback
  for (const c of waiguanCandidates) {
    const derived = coreOf(charTable[c.charId] || {});
    const stored = c.bonds.filter((b) => bonds[b]?.isCore);
    assert.deepEqual([...stored].sort(), [...derived].sort(), `${c.name}: stored core bonds match the derivation`);
    if (!derived.length) assert.deepEqual(c.bonds, ['emptyShip'], `${c.name}: no matching faction ⇒ 协防干员`);
  }

  // the report's own example: the P3 collab operator is filed under laterano in the game files
  const makoto = waiguanCandidates.find((c) => c.name === '结城理');
  assert.ok(makoto, '结城理 is a candidate');
  assert.ok(factionSourcesOf(charTable[makoto.charId]).some((ids) => ids.includes('laterano')), 'his subPower carries laterano');
  assert.deepEqual(makoto.bonds, ['lateranoShip'], 'so he derives 拉特兰, not 协防');
  // and the ones whose real allegiance sits in subPower
  for (const [name, bond] of [['能天使', 'lateranoShip'], ['德克萨斯', 'siracusaShip'], ['水月', 'egirShip'], ['百炼嘉维尔', 'sargonShip']]) {
    const id = Object.keys(charTable).find((k) => charTable[k].name === name);
    assert.ok(coreOf(charTable[id]).includes(bond), `${name}: derives ${bond}`);
  }
});

test('waiguan: the two tiers of one operator are the same operator (tier V = tier VI + the tier fields; an elite + its 模组 level)', () => {
  for (const c of waiguanCandidates) {
    for (const suffix of ['_a', '_b']) {
      const id5 = c.chessIds[5].replace(/_a$/, suffix);
      const id6 = c.chessIds[6].replace(/_a$/, suffix);
      const r5 = allChess[id5];
      const r6 = allChess[id6];
      assert.ok(r5 && r6, `${c.charId}${suffix}: tier records (${id5} / ${id6})`);
      assert.equal(r5.tier, 5);
      assert.equal(r6.tier, 6);
      // everything but the nine tier fields is the same record — and, on an elite, what its slot's 模组 level decides
      // (tier V elite equipLevel 1, tier VI 3: the module bonus, the module trait / talent parts, the module choices)
      const allowed = new Set([...WAIGUAN_TIER_FIELDS, ...(r6.isGolden ? WAIGUAN_ELITE_TIER_FIELDS : [])]);
      for (const k of new Set([...Object.keys(r5), ...Object.keys(r6)])) {
        if (allowed.has(k)) continue;
        assert.deepEqual(r5[k], r6[k], `${id5}.${k} differs from ${id6}`);
      }
      // what the module level does not touch stays shared
      for (const k of ['statsBase', 'traitBase', 'talentsBase', 'skills', 'skill']) assert.deepEqual(r5[k], r6[k], `${id5}.${k} is module-independent`);
      const tpl = chess[r6.isGolden ? 'chess_char_5_diy1_b' : 'chess_char_5_diy1_a'];
      const tpl6 = chess[r6.isGolden ? 'chess_char_6_diy1_b' : 'chess_char_6_diy1_a'];
      assert.equal(r5.status.equipLevel, tpl.status.equipLevel, `${id5}: the tier V slot's 模组 level`);
      assert.equal(r6.status.equipLevel, tpl6.status.equipLevel, `${id6}: the tier VI slot's 模组 level`);
      assert.equal(r5.status.skillLevel, tpl.status.skillLevel, `${id5}: the tier V slot's skill level`);
      assert.equal(r6.status.skillLevel, r6.isGolden ? 7 : 4);
      assert.deepEqual([r5.status.equipLevel, r6.status.equipLevel], r6.isGolden ? [1, 3] : [0, 0], `${c.charId}${suffix}: 模组 levels`);
      if (r6.isGolden) {
        assert.equal(r5.module.level, 1, `${id5}: module level`);
        assert.equal(r6.module.level, 3, `${id6}: module level`);
      }
    }
  }
});

test('waiguan: every elite composes back from statsBase / traitBase / talentsBase at its OWN tier\'s 模组 level', () => {
  let nMods = 0;
  let nElites = 0;
  for (const [id, c] of Object.entries(allChess)) {
    if (!id.includes('_diy_') || !c.isGolden) continue;
    nElites++;
    assert.equal(c.module.level, c.status.equipLevel, `${id}: module.level = status.equipLevel`);
    assert.ok(Array.isArray(c.modules) && c.statsBase && c.traitBase && c.talentsBase, `${id}: module choices`);
    const defs = c.modules.filter((m) => m.isDefault);
    assert.equal(defs.length, c.module.active ? 1 : 0, `${id}: default module iff active`);
    if (defs.length) assert.equal(defs[0].uniEquipId, c.module.id, `${id}: the default is the equipped one`);
    const dm = defs[0] ?? null;
    for (const m of c.modules) {
      nMods++;
      assert.equal(m.level, c.status.equipLevel, `${id} ${m.uniEquipId}: level`);
    }
    // the default loadout = the record's own stats / trait / talents (the pool's rule, test 'chess: golden modules[]')
    assert.deepEqual(composeStats(c.statsBase, dm?.attr), c.stats, `${id}: statsBase + default attr = stats`);
    assert.deepEqual(dm?.traitOverride ?? c.traitBase, c.trait, `${id}: trait`);
    assert.deepEqual(composeTalents(c.talentsBase, dm?.talentChanges), c.talents, `${id}: talents`);
  }
  assert.equal(nElites, waiguanCandidates.length * 2);
  // 144 module choices per tier (85 operators carry 1-3 modules, 2 carry none); the same ids at both tiers
  assert.equal(nMods, 2 * 144, 'module choices over both tiers');
  for (const c of waiguanCandidates) {
    const ids = (tier) => allChess[c.chessIds[tier].replace(/_a$/, '_b')].modules.map((m) => m.uniEquipId);
    assert.deepEqual(ids(5), ids(6), `${c.charId}: the same module choices at tier V and VI`);
  }
  // 阿 (official battle_equip_table uniequip_002_haak / _003_haak): GEE-X level 1 +135 HP / +37 ATK, level 3 +240 / +57;
  // E2 Lv60 base 1897 / 663. Talent 0's module upgrade (`prob`, the second effect) arrives only at level 2+.
  const h5 = allChess.chess_char_diy_5_char_225_haak_b, h6 = allChess.chess_char_diy_6_char_225_haak_b;
  assert.deepEqual(h5.modules.map((m) => [m.typeName, m.level, m.attr]), [['GEE-X', 1, { maxHp: 135, atk: 37 }], ['GEE-Y', 1, { atk: 43, aspd: 3, respawnTime: -15 }]]);
  assert.deepEqual(h6.modules.map((m) => [m.typeName, m.level, m.attr]), [['GEE-X', 3, { maxHp: 240, atk: 57 }], ['GEE-Y', 3, { atk: 75, aspd: 5, respawnTime: -15 }]]);
  assert.deepEqual([h5.statsBase.maxHp, h5.statsBase.atk, h5.stats.maxHp, h5.stats.atk, h6.stats.maxHp, h6.stats.atk], [1897, 663, 2032, 700, 2137, 720]);
  assert.equal(h5.talents[0].bb.prob, undefined, 'tier V: talent 0 not upgraded at module level 1');
  assert.equal(h6.talents[0].bb.prob, 0.3, 'tier VI: talent 0 upgraded at module level 3');
  // the module-less operators: the placeholder module, no choices, at both tiers
  for (const tier of [5, 6]) {
    const k = allChess[`chess_char_diy_${tier}_char_1052_kalts2_b`];
    assert.deepEqual(k.modules, [], `凯尔希·思衡托 tier ${tier}: no module`);
    assert.deepEqual(k.module, { id: null, name: null, type: null, level: tier === 5 ? 1 : 3, active: false });
    assert.deepEqual(k.stats, k.statsBase);
  }
});

test('waiguan: a normal record carries the inactive module stub a pool normal has', () => {
  for (const [id, c] of Object.entries(allChess)) {
    if (!id.includes('_diy_') || c.isGolden) continue;
    const g = allChess[c.goldenId];
    if (g.module?.id) assert.deepEqual(c.module, { ...g.module, level: 0, active: false }, `${id}: stub`);
    else assert.equal(c.module, null, `${id}: module-less operator`);
    for (const k of ['modules', 'statsBase', 'traitBase', 'talentsBase']) assert.equal(c[k], undefined, `${id}: normal chess has no ${k}`);
  }
  // the pool's shape, for comparison (data/chess.json: 圣约送葬人 normal)
  assert.deepEqual(chess.chess_char_5_01_a.module, { id: 'uniequip_002_excu2', name: '待解答', type: 'REA-X', level: 0, active: false });
});

test('waiguan: token variants exist for both tiers of every summoning candidate; tier V elites summon with 模组 level 1', () => {
  for (const t of Object.values(tokens)) {
    for (const owner of Object.keys(t.variants || {})) {
      if (!owner.includes('_diy_')) continue;
      assert.ok(allChess[owner], `${t.tokenId}: variant owner ${owner}`);
      assert.ok(allChess[owner].tokens.includes(t.tokenId), `${t.tokenId}: ${owner} does not list the token`);
    }
  }
  for (const [id, c] of Object.entries(allChess)) {
    if (!id.includes('_diy_')) continue;
    for (const tok of c.tokens) assert.ok(tokens[tok]?.variants?.[id], `${id}: no variant of ${tok}`);
  }
  // 令 SUM-Y (default) adds summon attributes at every level: level 1 −3 cost only, level 3 also +HP / +ATK
  const soul = tokens.token_10020_ling_soul1;
  const v5 = soul.variants.chess_char_diy_5_char_2023_ling_b, v6 = soul.variants.chess_char_diy_6_char_2023_ling_b;
  assert.deepEqual([v5.stats.maxHp, v5.stats.atk, v5.stats.cost], [2407, 529, 9]);
  assert.deepEqual([v6.stats.maxHp, v6.stats.atk, v6.stats.cost], [2557, 574, 9]);
  assert.deepEqual(v5.byModule.none.stats, v6.byModule.none.stats, 'no module: the same summon at both tiers');
  assert.deepEqual(soul.variants.chess_char_diy_5_char_2023_ling_a, soul.variants.chess_char_diy_6_char_2023_ling_a, 'normal: the same summon at both tiers');
  // the token's top-level defaults stay the first owner's (tier VI normal)
  assert.deepEqual(soul.owners.slice(0, 1), ['chess_char_diy_6_char_2023_ling_a']);
  assert.deepEqual(soul.stats, soul.variants.chess_char_diy_6_char_2023_ling_a.stats);
});

test('waiguan: slots match the official four (2 at tier V, 2 at tier VI)', () => {
  assert.deepEqual(WAIGUAN_SLOTS.map((s) => [s.slot, s.tier]), [['diy5a', 5], ['diy5b', 5], ['diy6a', 6], ['diy6b', 6]]);
  for (const s of WAIGUAN_SLOTS) {
    const rec = chess[s.chessId];
    assert.ok(rec && rec.isDiy && !rec.stats, `${s.chessId}: the empty slot template`);
  }
});

test('chess: ids, golden pairs and references resolve', () => {
  for (const [id, c] of Object.entries(chess)) {
    assert.equal(c.chessId, id);
    assert.ok(chess[c.baseId], `${id}: baseId`);
    assert.equal(chess[c.baseId].isGolden, false, `${id}: baseId must be normal`);
    assert.ok(c.goldenId && chess[c.goldenId]?.isGolden, `${id}: goldenId`);
    assert.equal(c.tier, chess[c.baseId].tier, `${id}: tier differs from base`);
    assert.ok(c.tier >= 1 && c.tier <= 6);
    for (const b of c.bonds) assert.ok(bonds[b], `${id}: bond ${b}`);
    for (const g of c.garrisonIds) assert.ok(garrisons[g], `${id}: garrison ${g}`);
    for (const t of c.tokens) assert.ok(tokens[t], `${id}: token ${t}`);
    assert.ok(isFiniteNum(c.price) && isFiniteNum(c.sellPrice), `${id}: price`);
  }
  assert.equal(chess.chess_char_2_11_a.upgradeNum, 2, '风丸 merges with 2 copies');
});

test('chess: every non-DIY chess has stats, range, classification and a resolvable skill', () => {
  const statKeys = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat', 'aspd', 'respawnTime', 'spRecovery', 'moveSpeed', 'tauntLevel', 'massLevel'];
  for (const c of Object.values(chess)) {
    if (c.isDiy) { assert.equal(c.visible, false); continue; }
    assertStatsFinite(c.stats, c.chessId, statKeys);
    assert.ok(c.stats.maxHp > 0 && c.stats.bat > 0 && c.stats.aspd > 0, `${c.chessId}: positive stats`);
    assert.ok(Array.isArray(c.rangeGrid) && c.rangeGrid.every(isPair), `${c.chessId}: rangeGrid`);
    assert.ok(['phys', 'arts', 'heal', 'true'].includes(c.dmgType), `${c.chessId}: dmgType ${c.dmgType}`);
    assert.ok(['melee', 'ranged', 'heal', 'none'].includes(c.attackKind), `${c.chessId}: attackKind`);
    assert.ok(['arrow', 'bolt', 'orb', 'none'].includes(c.projectile), `${c.chessId}: projectile`);
    assert.equal(typeof c.canHitFly, 'boolean');
    assert.ok(c.skill && typeof c.skill.skillId === 'string', `${c.chessId}: skill`);
    assert.ok(c.skill.level === (c.isGolden ? 7 : 4), `${c.chessId}: skill level ${c.skill.level}`);
    assert.ok(typeof c.skill.trigger?.rule === 'string', `${c.chessId}: trigger`);
    assert.ok(typeof c.skill.desc === 'string' && !/\{[a-z_@.\[\]]+(:[0-9.%]+)?\}/i.test(c.skill.desc), `${c.chessId}: unresolved skill placeholder`);
    for (const [k, v] of Object.entries(c.skill.bb)) assert.ok(isFiniteNum(v), `${c.chessId}: skill bb ${k}`);
    assert.ok(c.trait && typeof c.trait.desc === 'string', `${c.chessId}: trait`);
    assert.ok(Array.isArray(c.talents));
    assert.ok(c.assets && c.assets.avatar && c.assets.spine, `${c.chessId}: assets`);
    if (c.isGolden) assert.equal(c.module ? c.module.active || c.module.id === null : true, true);
  }
  // Spot checks against official numbers (隐现 E1 Lv55: HP 1123, ATK 399).
  assert.equal(chess.chess_char_1_01_a.stats.maxHp, 1123);
  assert.equal(chess.chess_char_1_01_a.stats.atk, 399);
  assert.equal(chess.chess_char_1_01_a.targetPriority, 'fly');
});

test('bonds: 23 bonds with valid members, thresholds and effects', () => {
  assert.equal(Object.keys(bonds).length, 23);
  assert.equal(Object.values(bonds).filter((b) => b.isCore).length, 8);
  const modes = new Set(['BOARD', 'BOARD_AND_DECK', 'BOARD_ALL_CHESS']);
  for (const b of Object.values(bonds)) {
    assert.ok(modes.has(b.countMode), `${b.bondId}: countMode ${b.countMode}`);
    assert.ok(b.thresholds.length >= 1, `${b.bondId}: thresholds`);
    for (let i = 0; i < b.thresholds.length; i++) {
      assert.ok(isInt(b.thresholds[i]) && b.thresholds[i] > 0);
      if (i) assert.ok(b.thresholds[i] > b.thresholds[i - 1], `${b.bondId}: ascending`);
    }
    for (const m of b.members) {
      assert.ok(chess[m] && !chess[m].isGolden, `${b.bondId}: member ${m}`);
      assert.ok(chess[m].bonds.includes(b.bondId), `${b.bondId}: member ${m} lacks bond`);
    }
    assert.ok(effects[b.effectId], `${b.bondId}: effect`);
  }
  assert.deepEqual(bonds.yanShip.thresholds, [3, 6, 9]);
  assert.deepEqual(bonds.egirShip.thresholds, [3, 5]);
  assert.deepEqual(bonds.suntShip.thresholds, [2, 5]);
  assert.equal(bonds.soloShip.maxCount, 1);
  // Every chess bond membership is mirrored in the bond member list.
  for (const c of normalChess) for (const b of c.bonds) assert.ok(bonds[b].members.includes(c.chessId), `${c.chessId} not in ${b}.members`);
});

test('garrisons: all referenced exist; 43 distinct effect keys', () => {
  const keys = new Set(Object.values(garrisons).map((g) => g.effectKey));
  assert.equal(keys.size, 43);
  for (const g of Object.values(garrisons)) {
    assert.ok(typeof g.eventType === 'string' && typeof g.desc === 'string', g.garrisonId);
    for (const o of g.owners) assert.ok(chess[o], `${g.garrisonId}: owner ${o}`);
  }
});

test('items: 115 item chess with valid effects, bonds and golden links', () => {
  assert.equal(Object.keys(items).length, 115);
  assert.equal(Object.values(items).filter((i) => i.itemType === 'EQUIP' && !i.isGolden).length, 56);
  assert.equal(Object.values(items).filter((i) => i.itemType === 'MAGIC').length, 3);
  for (const it of Object.values(items)) {
    assert.ok(effects[it.effectId], `${it.id}: effect ${it.effectId}`);
    if (it.goldenId) assert.ok(items[it.goldenId]?.isGolden, `${it.id}: golden`);
    if (it.giveBondId) assert.ok(bonds[it.giveBondId], `${it.id}: giveBond`);
    if (it.requiresBondId) assert.ok(bonds[it.requiresBondId], `${it.id}: requiresBond`);
    assert.ok(isInt(it.tier) && it.tier >= 1 && it.tier <= 6, `${it.id}: tier`);
    assert.ok(isFiniteNum(it.price), `${it.id}: price`);
    assert.ok(typeof it.trapId === 'string' && it.iconId === it.trapId);
  }
});

test('bands: 40 strategies with effects and starting LP', () => {
  assert.equal(Object.keys(bands).length, 40);
  for (const b of Object.values(bands)) {
    assert.ok(effects[b.effectId], `${b.bandId}: effect`);
    assert.ok(isInt(b.totalHp) && b.totalHp >= 20 && b.totalHp <= 45, `${b.bandId}: totalHp`);
    assert.ok(b.name && b.iconId);
  }
  assert.equal(bands.band_bldsk.totalHp, 28);
});

test('effects: every buff has a key and finite numeric blackboard', () => {
  for (const e of Object.values(effects)) {
    for (const b of e.buffs) {
      assert.equal(typeof b.key, 'string', e.effectId);
      for (const [k, v] of Object.entries(b.bb)) assert.ok(isFiniteNum(v), `${e.effectId}.${k}`);
    }
  }
});

test('enemies: stats are finite and motion/dmgType valid', () => {
  for (const e of Object.values(enemies)) {
    assertStatsFinite(e.stats, e.key, ['maxHp', 'atk', 'def', 'res', 'moveSpeed', 'bat', 'aspd', 'rangeRadius', 'blockCnt', 'massLevel', 'lpr', 'hpRecoveryPerSec', 'tauntLevel']);
    assert.ok(['WALK', 'FLY'].includes(e.stats.motion), `${e.key}: motion ${e.stats.motion}`);
    assert.ok(['phys', 'arts', 'true', 'heal', 'none', 'element'].includes(e.stats.dmgType), `${e.key}: dmgType ${e.stats.dmgType}`);
    for (const s of e.summons) assert.ok(enemies[s], `${e.key}: summon ${s}`);
  }
});

test('waves: every template resolves spawns, routes and enemies', () => {
  assert.equal(Object.keys(waves).length, 38);
  for (const w of Object.values(waves)) {
    assert.ok(w.routes.length > 0, `${w.id}: routes`);
    for (const r of [...w.routes, ...w.extraRoutes]) {
      if (!r) continue;
      assert.ok(isPair(r.start) && isPair(r.end), `${w.id}: route endpoints`);
      for (const p of r.checkpoints) assert.ok(isPair(p), `${w.id}: checkpoint`);
    }
    for (const sp of w.spawns) {
      assert.ok(isFiniteNum(sp.time) && sp.time >= 0, `${w.id}: time`);
      assert.ok(isInt(sp.count) && sp.count >= 1, `${w.id}: count`);
      assert.ok(isFiniteNum(sp.interval) && sp.interval >= 0, `${w.id}: interval`);
      if (sp.action) continue;
      assert.ok(enemies[sp.key], `${w.id}: enemy ${sp.key}`);
      assert.ok(w.routes[sp.routeIndex], `${w.id}: route ${sp.routeIndex}`);
    }
    for (const [bn, phases] of Object.entries(w.branches)) {
      for (const sp of phases.flat()) {
        if (sp.action) continue;
        assert.ok(enemies[sp.key], `${w.id}/${bn}: enemy ${sp.key}`);
        assert.ok(w.extraRoutes[sp.routeIndex], `${w.id}/${bn}: extraRoute ${sp.routeIndex}`);
      }
    }
    for (const k of Object.keys(w.overrides)) assert.ok(enemies[k], `${w.id}: override ${k}`);
    if (w.kind === 'normal') assert.ok(isFiniteNum(w.maxPlayTime) && w.maxPlayTime > 0);
  }
});

test('config: modes, rounds and templates', () => {
  const inScope = Object.values(config.modes).filter((m) => m.inScope);
  assert.equal(inScope.length, 8);
  for (const m of Object.values(config.modes)) {
    for (const [r, rd] of Object.entries(m.rounds)) {
      const tpls = rd.template ? [rd.template] : Object.values(rd.bossTemplates || {});
      assert.ok(tpls.length > 0, `${m.modeId} r${r}: template`);
      for (const t of tpls) assert.ok(waves[t], `${m.modeId} r${r}: ${t}`);
      if (!rd.isBoss) assert.ok(isFiniteNum(rd.combatTimeLimit), `${m.modeId} r${r}: combatTimeLimit`);
      if (m.type === 'SINGLE') assert.equal(rd.prepTime, null, `${m.modeId}: solo prep untimed`);
      if (m.type === 'MULTI') assert.ok(isFiniteNum(rd.prepTime), `${m.modeId} r${r}: prepTime`);
      const es = m.enemyScale[r];
      assert.ok(es && isFiniteNum(es.atk) && isFiniteNum(es.hp) && isFiniteNum(es.speed), `${m.modeId} r${r}: enemyScale`);
    }
    for (const b of [...m.activeBondIds, ...m.inactiveBondIds]) assert.ok(bonds[b], `${m.modeId}: bond ${b}`);
    for (const s of m.stages) assert.ok(stages[s]?.active, `${m.modeId}: stage ${s}`);
    if (m.inScope) {
      assert.equal(m.upgradePrices.length, 5);
      assert.ok(m.stages.length > 0);
    }
  }
  const M = config.modes;
  assert.equal(M.mode_single_funny.lastRound, 9);
  assert.equal(M.mode_single_funny.hiddenRound, null);
  assert.equal(M.mode_multi_funny.lastRound, 14);
  assert.equal(M.mode_multi_funny.hiddenRound, null);
  for (const id of ['mode_single_normal', 'mode_single_hard', 'mode_single_abyss', 'mode_multi_normal', 'mode_multi_hard', 'mode_multi_abyss']) {
    assert.equal(M[id].lastRound, 14, id);
    assert.equal(M[id].hiddenRound, 15, id);
  }
  assert.deepEqual(M.mode_multi_hard.spRounds, [3, 9, 11]);
  assert.deepEqual(M.mode_multi_normal.upgradePrices, [5, 8, 11, 12, 13]);
  assert.equal(config.economy.income[1], 4);
  assert.equal(config.economy.income[3], 6);
  assert.equal(config.economy.benchSize, 10);
  assert.equal(config.economy.deployCap, 8);
  assert.equal(config.economy.mergeCountOverrides.chess_char_2_11_a, 2);
  assert.equal(config.economy.poolCopiesOverrides.chess_char_6_11_a, 4);
  assert.deepEqual(config.hiddenCore.single, 350);
  assert.deepEqual(config.hiddenCore.multi, 1200);
  assert.equal(config.titles.length, 6);
});

test('stages: 19 rows × 21 cols with known glyphs; paths are contiguous', () => {
  const glyphs = new Set('#XrRfphbaASEIOmgdi'.split(''));
  for (const s of Object.values(stages)) {
    assert.equal(s.rows.length, 19, `${s.id}: rows`);
    for (const row of s.rows) {
      assert.equal(row.length, 21, `${s.id}: cols`);
      for (const ch of row) assert.ok(glyphs.has(ch), `${s.id}: glyph ${ch}`);
    }
    assert.equal(s.rows[9][2], 'E', `${s.id}: objective at (9,2)`);
    assert.equal(s.rows[9][10], 'S', `${s.id}: gate at (9,10)`);
    for (const paths of [s.groundPaths, s.groundPathsWithDevices]) {
      for (const [k, p] of Object.entries(paths)) {
        for (let i = 1; i < p.length; i++) {
          const dr = Math.abs(p[i][0] - p[i - 1][0]), dc = Math.abs(p[i][1] - p[i - 1][1]);
          assert.ok(dr <= 1 && dc <= 1 && dr + dc > 0, `${s.id} ${k}: step ${i}`);
          const g = s.rows[p[i][0]][p[i][1]];
          assert.ok(s.tiles[g]?.groundPassable, `${s.id} ${k}: impassable ${g}`);
        }
      }
    }
    assert.ok(s.groundPaths['9,10->9,2'], `${s.id}: lower gate path`);
  }
  assert.equal(Object.values(stages).filter((s) => s.active).length, 8);
});

test('bosses, factions, tokens and choices resolve', () => {
  assert.equal(Object.keys(bosses).length, 10);
  for (const b of Object.values(bosses)) {
    assert.ok(enemies[b.enemyKey], `${b.bossId}: enemy`);
    for (const v of Object.values(b.bloodPoint)) assert.ok(isFiniteNum(v) && v > 0, `${b.bossId}: bloodPoint`);
    for (const t of Object.values(b.templates)) assert.ok(waves[t.template], `${b.bossId}: ${t.template}`);
  }
  assert.equal(Object.values(bosses).filter((b) => b.hidden).length, 3);

  assert.equal(Object.keys(factions.entries).length, 67);
  for (const e of Object.values(factions.entries)) {
    assert.equal(typeof e.fly, 'boolean', `faction ${e.key}: fly`);
    assert.ok(!('kS' in e), `faction ${e.key}: no k copies (research 08 §7-1)`);
    for (const x of [{ key: e.key }, ...e.N, ...e.E]) {
      assert.ok(enemies[x.key], `faction ${e.key}: ${x.key}`);
      assert.ok(!('k' in x), `faction ${e.key}: ${x.key} has no k`);
      assert.equal(enemies[x.key].isFlyEnemy, e.fly, `faction ${e.key}: ${x.key} shares the entry's movement class`);
    }
  }
  for (const k of Object.values(factions.templateSlots)) assert.ok(enemies[k], `template slot ${k}`);
  // the official generator's parameters (research 08 §2)
  const g = factions.generation;
  assert.equal(g.maxLevelCnt, 15);
  assert.equal(g.specialEnemyNum, 3);
  assert.equal(g.fillType, 'SPECIAL');
  assert.deepEqual([g.minReplacedEnemyCount, g.maxReplacedEnemyCount, g.firstHalfMaxRound, g.minActionIntervalRatio], [1, 5, 7, 0.05]);
  assert.deepEqual(Object.values(g.typeSlots), [3, 3, 3, 3, 3, 3]);
  assert.deepEqual(Object.values(g.placeholders).map((p) => p.slot).sort(), ['E', 'EF', 'N', 'NF', 'S', 'SF'], 'T / TF are tokens, not placeholders');
  assert.ok(!('kFormula' in g));

  for (const t of Object.values(tokens)) {
    assertStatsFinite(t.stats, t.tokenId, ['maxHp', 'atk', 'def', 'res', 'bat', 'aspd']);
    for (const o of t.owners) assert.ok(allChess[o]?.tokens.includes(t.tokenId), `${t.tokenId}: owner ${o}`);
  }
  assert.ok(tokens.enemy_9012_acloon, '炎佑 present');

  assert.equal(Object.keys(choices.events).length, 109);
  for (const s of Object.values(choices.schedule)) {
    for (const r of Object.values(s.rounds)) {
      assert.ok(r.families.length > 0);
      for (const ids of Object.values(r.events)) for (const id of ids) assert.ok(choices.events[id], `event ${id}`);
    }
  }
  for (const c of choices.cards.bounty) {
    assert.ok(effects[c.effectId]);
    for (const a of c.adds) assert.ok(enemies[a.enemyKey], `bounty ${c.effectId}: ${a.enemyKey}`);
    assert.ok([1, 2, 3].includes(c.tier));
  }
  for (const c of choices.cards.tactic) assert.ok(effects[c.effectId]);
  for (const [id, p] of Object.entries(choices.pools)) {
    for (const x of [...(p.items || []), ...(p.weighted || []).map((w) => w[0])]) assert.ok(items[x] || chess[x], `pool ${id}: ${x}`);
  }
});

// ---- regression tests for review findings -------------------------------------------------------

test('chess: module parts flagged isToken upgrade the summon, never the operator', () => {
  // 缪尔赛思 golden: talent 0 keeps her own text/token/cnt; the 流形 upgrades live on the token variant.
  const mlyss = chess.chess_char_6_11_b;
  assert.equal(mlyss.talents[0].name, '净水即生命');
  assert.equal(mlyss.talents[0].tokenKey, 'token_10030_mlyss_wtrman');
  assert.equal(mlyss.talents[0].bb.cnt, 1);
  assert.ok(!('scale' in mlyss.talents[0].bb), 'token-only blackboard leaked into the operator talent');
  assert.ok(!mlyss.talents.some((t) => t.bb.damage_scale !== undefined || t.bb.sp === 5), 'token talents attached to operator');
  const wtr = tokens.token_10030_mlyss_wtrman.variants;
  assert.equal(wtr.chess_char_6_11_a.talents[0].bb.scale, 0.9);
  assert.equal(wtr.chess_char_6_11_b.talents[0].bb.scale, 1);
  assert.ok(wtr.chess_char_6_11_b.talents.some((t) => t.bb.damage_scale === 0.85));
  assert.equal(wtr.chess_char_6_11_b.count, 1);

  // 浊心斯卡蒂 golden: operator talent 0 still sends 1 海嗣; the 30 s duration belongs to the 海嗣.
  const skadi = chess.chess_char_6_04_b;
  assert.equal(skadi.talents[0].tokenKey, 'token_10017_skadi2_dedant');
  assert.equal(skadi.talents[0].bb.cnt, 1);
  assert.ok(!('duration' in skadi.talents[0].bb));
  const dedant = tokens.token_10017_skadi2_dedant.variants;
  assert.equal(dedant.chess_char_6_04_a.talents[0].bb.duration, 25);
  assert.equal(dedant.chess_char_6_04_b.talents[0].bb.duration, 30);
  assert.equal(dedant.chess_char_6_04_b.stats.respawnTime, dedant.chess_char_6_04_a.stats.respawnTime - 5, 'module token attribute');

  // 伺夜 golden: the wolves' damage reduction is on the wolf, not on 伺夜.
  assert.ok(!chess.chess_char_3_19_b.talents.some((t) => t.bb.damage_scale !== undefined));
  assert.ok(tokens.token_10028_vigil_wolf.variants.chess_char_3_19_b.talents.some((t) => t.bb.damage_scale === 0.85));
  assert.ok(!tokens.token_10028_vigil_wolf.variants.chess_char_3_19_a.talents.some((t) => t.bb.damage_scale !== undefined));

  // 耀骑士临光 golden: “耀阳” gets the module trait upgrade.
  assert.equal(tokens.token_10019_nearl2_sword.variants.chess_char_6_17_b.trait.bb.atk_scale, 1.15);
  assert.equal(tokens.token_10019_nearl2_sword.variants.chess_char_6_17_a.trait.bb.atk_scale, undefined);

  // Module talent overrides keep base keys the upgrade does not restate (宴: +100 aspd at 70% HP lost).
  assert.equal(chess.chess_char_1_18_b.talents[0].bb.min_attack_speed, 100);
  assert.equal(chess.chess_char_1_18_b.talents[0].bb.damage_resistance, 0.25);
});

test('chess/tokens: talent tokens resolve and every token variant says where it comes from', () => {
  for (const c of Object.values(chess)) {
    for (const t of c.talents) if (t.tokenKey) {
      assert.ok(c.tokens.includes(t.tokenKey) && tokens[t.tokenKey], `${c.chessId}: talent token ${t.tokenKey}`);
    }
  }
  // 凛御银灰: the talent's container id maps onto the default skill's token (S2 → eagle2).
  const svash = chess.chess_char_5_14_a;
  assert.equal(svash.talents[0].tokenKey, 'token_10057_svash2_eagle2');
  assert.equal(svash.talents[0].containerTokenKey, 'token_10057_svash2_eagle');
  assert.equal(svash.skill.overrideTokenKey, 'token_10057_svash2_eagle2');
  const allowed = new Set(['talent', 'skill', 'display']);
  for (const t of Object.values(tokens)) {
    for (const [owner, v] of Object.entries(t.variants)) {
      assert.ok(Array.isArray(v.sources) && v.sources.length && v.sources.every((s) => allowed.has(s)), `${t.tokenId}@${owner}: sources`);
      assert.ok(allChess[owner]?.tokens.includes(t.tokenId), `${t.tokenId}: owner ${owner}`);
    }
  }
  assert.deepEqual(tokens.token_10057_svash2_eagle1.variants.chess_char_5_14_a.sources, ['display']);
  // 夕's skill "cnt" is a charge count, not a token count.
  assert.equal(tokens.token_10015_dusk_drgn.variants.chess_char_5_12_a.count, null);
  // Placeable (hand) tokens = the manually deployable summons (PRTS 卫戍协议/帮助 §战斗部署; user playtest #6): shop
  // state DEFAULT or no shop-state entry (凯瑟琳's device), never HIDDEN, made by some owner loadout (talent or skill) —
  // 赫默's 医疗探机 and 巫恋's 诅咒娃娃 included (in battle they wait on their tile for the skill).
  const makes = (list) => list.includes('talent') || list.includes('skill');
  for (const t of Object.values(tokens)) {
    if (t.kind !== 'summon') continue;
    const made = Object.values(t.variants).some((v) => makes(v.sources) || Object.values(v.bySkill || {}).some((b) => makes(b.sources)));
    assert.equal(t.placeable, t.displayType !== 'HIDDEN' && made, `${t.tokenId} (${t.name}): placeable`);
  }
  // The pool's own hand summons stay exactly as they were; the 外援 / 甄选 operators bring their own (each is a real
  // manually deployable summon of its operator — Mon3tr, 幻影, 龙腾.…, the tactician 援军 — so the roster widens this set
  // on purpose, DESIGN §27). A placeable token is never HIDDEN and never display-only.
  const placeableNames = Object.values(tokens).filter((t) => t.placeable).map((t) => t.name);
  for (const n of ['医疗探机', '诅咒娃娃', '斯卡蒂的海嗣', '流形', '狼群', '爬行号·防护单元']) {
    assert.ok(placeableNames.includes(n), `${n} must stay placeable`);
  }
  for (const t of Object.values(tokens)) {
    if (!t.placeable) continue;
    assert.notEqual(t.displayType, 'HIDDEN', `${t.tokenId}: a HIDDEN token is never a hand card`);
    const sources = Object.values(t.variants).flatMap((v) => [v.sources, ...Object.values(v.bySkill || {}).map((b) => b.sources)]);
    assert.ok(sources.some((s) => makes(s)), `${t.tokenId}: placeable without a talent/skill source`);
  }
  assert.equal(tokens.enemy_9012_acloon.stats.deployLimit, tokens.enemy_9012_acloon.deployLimit);
});

// ---- operator loadouts: selectable skills & modules (DESIGN §16) ------------------------------------

test('chess: skills[] = every skill unlocked at the status, at the chess skill level; exactly one default = skill', () => {
  for (const c of Object.values(chess)) {
    if (c.isDiy) { assert.equal(c.skills, undefined, `${c.chessId}: DIY has no skills`); continue; }
    assert.ok(Array.isArray(c.skills) && c.skills.length >= 1 && c.skills.length <= 3, `${c.chessId}: skills`);
    const idx = c.skills.map((s) => s.index);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${c.chessId}: skills ordered by index`);
    assert.equal(new Set(idx).size, idx.length, `${c.chessId}: unique skill indices`);
    // E1 unlocks S1–S2, E2 S1–S3 (tier 1–2 normal chess are E1)
    assert.ok(idx.every((i) => i <= c.status.phase), `${c.chessId}: skill ${idx} locked at E${c.status.phase}`);
    const defs = c.skills.filter((s) => s.isDefault);
    assert.equal(defs.length, 1, `${c.chessId}: one default skill`);
    const { isDefault, ...d } = defs[0];
    assert.deepEqual(d, c.skill, `${c.chessId}: default entry = skill (back-compat shape)`);
    for (const s of c.skills) {
      assert.equal(s.level, c.status.skillLevel, `${c.chessId} ${s.skillId}: level`);
      assert.equal(typeof s.isDefault, 'boolean');
      assert.ok(typeof s.skillId === 'string' && typeof s.iconId === 'string' && typeof s.name === 'string', `${c.chessId}: skill ids`);
      assert.ok(typeof s.trigger?.rule === 'string', `${c.chessId} ${s.skillId}: trigger`);
      assert.ok(s.rangeGrid === null || s.rangeGrid.every(isPair), `${c.chessId} ${s.skillId}: rangeGrid`);
      assert.ok(!/\{[a-z_@.\[\]]+(:[0-9.%]+)?\}/i.test(s.desc), `${c.chessId} ${s.skillId}: unresolved placeholder`);
      for (const [k, v] of Object.entries(s.bb)) assert.ok(isFiniteNum(v), `${c.chessId} ${s.skillId}: bb ${k}`);
      assert.ok(s.overrideTokenKey === null || c.tokens.includes(s.overrideTokenKey), `${c.chessId} ${s.skillId}: token ${s.overrideTokenKey} listed`);
    }
    if (c.tier <= 2 && !c.isGolden) assert.ok(idx.length <= 2, `${c.chessId}: E1 chess has no S3`);
  }
  // Triggers per skill (PRTS 卫戍协议/帮助 技能策略; tools/build-data.mjs resolveTrigger): the class rows cover every MANUAL
  // skill of the class and no AUTO one; a MANUAL skill with a 技能范围 of its own (not an attack-range change) is SKILL_RANGE.
  const rules = (id) => chess[id].skills.map((s) => s.trigger.rule);
  assert.deepEqual(rules('chess_char_1_02_a'), ['TAKE_DAMAGE', 'TAKE_DAMAGE']);         // 角峰 (重装, both MANUAL)
  assert.deepEqual(rules('chess_char_1_10_b'), ['DEFAULT', 'TAKE_DAMAGE']);             // 古米 (S1 自动触发)
  assert.deepEqual(rules('chess_char_3_08_a'), ['SEARCH', 'SEARCH']);                   // 薄绿 (阵法术师: the default S2 too)
  assert.deepEqual(rules('chess_char_3_19_a'), ['DEFAULT', 'DEFAULT', 'SP_FULL']);      // 伺夜 (战术家: S1/S2 are AUTO)
  assert.deepEqual(rules('chess_char_6_11_b'), ['MLYSS_WTRMAN', 'MLYSS_WTRMAN', 'MLYSS_WTRMAN']); // 缪尔赛思 (charId row −1)
  assert.deepEqual(rules('chess_char_1_08_a'), ['DEFAULT', 'SKILL_RANGE']);             // 德克萨斯 S2 剑雨: 对周围所有敌人
  assert.deepEqual(chess.chess_char_1_08_a.skills[1].trigger.customRangeGrid, chess.chess_char_1_08_a.skills[1].rangeGrid);
  assert.deepEqual(rules('chess_char_4_22_a'), ['DEFAULT', 'DEFAULT', 'DEFAULT']);      // 银灰: "攻击范围缩小 / 扩大" = attack range
  assert.deepEqual(rules('chess_char_3_18_a'), ['DEFAULT', 'SKILL_RANGE', 'DEFAULT']);  // 忍冬: S2 对周围…, S3 攻击距离+1
  // the deliberate deviation from the 重装 row (DESIGN §21.29, the owner's decision; tools/build-data.mjs
  // TRIGGER_DEVIATIONS, per chess): six skills cast with an enemy in range, rawRule keeps the official TAKE_DAMAGE
  const raws = (id) => chess[id].skills.map((s) => s.trigger.rawRule);
  for (const id of ['chess_char_1_04_a', 'chess_char_1_04_b']) {                       // 深巡: S1 keeps the row, S2 deviates
    assert.deepEqual(rules(id), ['TAKE_DAMAGE', 'DEFAULT']);
    assert.deepEqual(raws(id), ['TAKE_DAMAGE', 'TAKE_DAMAGE']);
  }
  for (const id of ['chess_char_1_20_a', 'chess_char_1_20_b']) {                       // 雷蛇: S1 AUTO, S2 deviates
    assert.deepEqual(rules(id), ['DEFAULT', 'DEFAULT']);
    assert.deepEqual(raws(id), ['DEFAULT', 'TAKE_DAMAGE']);
  }
  for (const id of ['chess_char_5_08_a', 'chess_char_5_08_b']) {                       // 号角: S1 AUTO, S2 / S3 deviate
    assert.deepEqual(rules(id), ['DEFAULT', 'DEFAULT', 'DEFAULT']);
    assert.deepEqual(raws(id), ['DEFAULT', 'TAKE_DAMAGE', 'TAKE_DAMAGE']);
  }
  for (const id of ['chess_char_2_18_a', 'chess_char_2_18_b']) {                       // 灰毫: S1 (generic skcom_atk_up[3]) and S2
    assert.deepEqual(rules(id), ['DEFAULT', 'DEFAULT']);
    assert.deepEqual(raws(id), ['TAKE_DAMAGE', 'TAKE_DAMAGE']);
  }
  // 余 S2 厚礼上宾 (DESIGN §22.10, the owner's decision of 2026-10-04): SKILL_RANGE on its own x-1, S1 keeps the row, S3 its
  // official charId row
  for (const id of ['chess_char_6_03_a', 'chess_char_6_03_b']) {
    assert.deepEqual(rules(id), ['TAKE_DAMAGE', 'SKILL_RANGE', 'CUSTOM_RANGE']);
    assert.deepEqual(raws(id), ['TAKE_DAMAGE', 'TAKE_DAMAGE', 'CUSTOM_RANGE_SEARCH_ENEMY']);
    assert.deepEqual(chess[id].skills[1].trigger.customRangeGrid, chess[id].skills[1].rangeGrid);
  }
  const deviated = Object.values(chess).flatMap((c) => (c.skills || []).filter((s) => s.trigger.rawRule === 'TAKE_DAMAGE' && s.trigger.rule !== 'TAKE_DAMAGE').map((s) => `${c.baseId} ${s.skillId}`));
  assert.equal(deviated.length, 14, 'exactly the six skills of §21.29 and 余 S2, normal + elite');
  assert.deepEqual([...new Set(deviated)].sort(), ['chess_char_1_04_a skchr_udflow_2', 'chess_char_1_20_a skchr_liskam_2', 'chess_char_2_18_a skchr_ashlok_2', 'chess_char_2_18_a skcom_atk_up[3]', 'chess_char_5_08_a skchr_horn_2', 'chess_char_5_08_a skchr_horn_3', 'chess_char_6_03_a skchr_yu_2']);
  for (const c of Object.values(chess)) {
    for (const s of c.skills || []) {
      if (s.skillType !== 'MANUAL') assert.ok(!['TAKE_DAMAGE', 'SEARCH', 'SKILL_RANGE'].includes(s.trigger.rule), `${c.chessId} ${s.skillId}: an AUTO / PASSIVE skill takes no strategy row`);
      if (s.trigger.rule === 'SKILL_RANGE') assert.ok(s.rangeGrid && s.skillType === 'MANUAL' && !/攻击(范围|距离)(与溅射范围)?(扩大|改变|缩小|缩短|加长|增加|\+)/.test(s.desc), `${c.chessId} ${s.skillId}: SKILL_RANGE only for a 技能范围`);
    }
  }
  assert.deepEqual(chess.chess_char_1_01_a.skills.map((s) => [s.skillId, s.level, s.spCost, s.isDefault]),
    [['skchr_inside_1', 4, 14, false], ['skchr_inside_2', 4, 24, true]]);             // 隐现 Lv4 (default S2)
  const sw = chess.chess_char_3_04_b;                                                    // 琳琅诗怀雅: S2 makes the 香槟
  assert.deepEqual(sw.skills.map((s) => s.overrideTokenKey), [null, 'token_10031_swire2_gdtrap', null]);
});

test('chess: golden modules[] (+ statsBase/traitBase/talentsBase) compose back to the default record', async () => {
  const { composeStats, composeTalents } = await import('../server/sim/simdata.js');
  const statKeys = ['maxHp', 'atk', 'def', 'res', 'aspd', 'cost', 'blockCnt', 'respawnTime', 'bat', 'deployLimit', 'deckStack'];
  let nMods = 0;
  for (const c of Object.values(chess)) {
    if (c.isDiy) continue;
    if (!c.isGolden || !(c.status.equipLevel > 0)) {
      for (const k of ['modules', 'statsBase', 'traitBase', 'talentsBase']) assert.equal(c[k], undefined, `${c.chessId}: normal chess has no ${k}`);
      continue;
    }
    assert.ok(Array.isArray(c.modules), `${c.chessId}: modules`);
    const defs = c.modules.filter((m) => m.isDefault);
    assert.equal(defs.length, c.module?.active ? 1 : 0, `${c.chessId}: default module iff module active`);
    if (defs.length) assert.equal(defs[0].uniEquipId, c.module.id);
    const dm = defs[0] ?? null;
    // default loadout = the record's own stats / trait / talents
    assert.deepEqual(composeStats(c.statsBase, dm?.attr), c.stats, `${c.chessId}: statsBase + default attr = stats`);
    assert.deepEqual(dm?.traitOverride ?? c.traitBase, c.trait, `${c.chessId}: trait`);
    assert.deepEqual(composeTalents(c.talentsBase, dm?.talentChanges), c.talents, `${c.chessId}: talents`);
    assert.equal(new Set(c.modules.map((m) => m.uniEquipId)).size, c.modules.length);
    for (const m of c.modules) {
      nMods++;
      assert.match(m.uniEquipId, /^uniequip_\d{3}_/, `${c.chessId}: module id`);
      assert.ok(!/^uniequip_001_/.test(m.uniEquipId), `${c.chessId}: INITIAL (no module) is not a module choice`);
      assert.ok(typeof m.name === 'string' && typeof m.typeName === 'string' && m.typeName.length > 0, `${m.uniEquipId}: name/type`);
      assert.equal(m.level, c.status.equipLevel, `${m.uniEquipId}: level`);
      for (const [k, v] of Object.entries(m.attr)) assert.ok(statKeys.includes(k) && isFiniteNum(v), `${m.uniEquipId}: attr ${k}`);
      assert.ok(m.traitOverride === null || (typeof m.traitOverride.desc === 'string' && m.traitOverride.bb), `${m.uniEquipId}: traitOverride`);
      for (const t of m.talentChanges) assert.ok(Number.isInteger(t.talentIndex) && t.bb && typeof t.hidden === 'boolean', `${m.uniEquipId}: talentChanges`);
      // every choice composes into complete stats
      assertStatsFinite(composeStats(c.statsBase, m.attr), `${c.chessId}+${m.uniEquipId}`, statKeys);
    }
  }
  assert.ok(nMods >= 170, `module choices: ${nMods}`);  // 184 ADVANCED modules over 129 goldens
  // 缪尔赛思 精锐 (E2 60, module Lv3): 梳妆流形 (default) / 落叶四季
  const m = chess.chess_char_6_11_b;
  assert.deepEqual(m.modules.map((x) => [x.uniEquipId, x.typeName, x.isDefault]), [['uniequip_002_mlyss', 'TAC-X', true], ['uniequip_003_mlyss', 'TAC-Y', false]]);
  assert.deepEqual(m.modules[1].attr, { maxHp: 170, atk: 28, def: 28 });
  assert.deepEqual([m.statsBase.maxHp, m.statsBase.atk, m.statsBase.def], [1703, 467, 111]);
  // module-less goldens: no choices, base = stats
  assert.deepEqual(chess.chess_char_5_14_b.modules, []);
  assert.deepEqual(chess.chess_char_5_14_b.statsBase, chess.chess_char_5_14_b.stats);
});

test('tokens: owner loadout variants (bySkill per non-default owner skill, byModule per other module / none)', () => {
  const allowed = new Set(['talent', 'skill', 'display']);
  for (const t of Object.values(tokens)) {
    for (const [owner, v] of Object.entries(t.variants || {})) {
      const o = allChess[owner];
      const alt = o.skills.filter((s) => !s.isDefault).map((s) => String(s.index));
      assert.deepEqual(Object.keys(v.bySkill || {}), alt, `${t.tokenId}@${owner}: bySkill keys`);
      for (const b of Object.values(v.bySkill || {})) {
        assert.ok(Array.isArray(b.sources) && b.sources.every((x) => allowed.has(x)), `${t.tokenId}@${owner}: bySkill sources`);
        assert.ok(b.count === null || isInt(b.count), `${t.tokenId}@${owner}: bySkill count`);
      }
      const mods = o.isGolden && o.module?.active ? [...o.modules.filter((m) => !m.isDefault).map((m) => m.uniEquipId), 'none'] : [];
      assert.deepEqual(Object.keys(v.byModule || {}), mods, `${t.tokenId}@${owner}: byModule keys`);
      for (const b of Object.values(v.byModule || {})) assert.ok(b.stats && b.trait && Array.isArray(b.talents), `${t.tokenId}@${owner}: byModule shape`);
    }
  }
  const w = tokens.token_10030_mlyss_wtrman.variants.chess_char_6_11_b;
  assert.equal(w.skill.skillId, 'sktok_mlyss_wtrman_3');                         // default S3
  assert.equal(w.bySkill[0].skill.skillId, 'sktok_mlyss_wtrman_1');              // 流形 follows the owner's skill slot
  assert.equal(w.byModule.none.talents[0].bb.scale, 0.9);                        // no module: 90% copy
  assert.ok(!w.byModule.none.talents.some((x) => x.bb.damage_scale !== undefined));
  assert.deepEqual(tokens.token_10022_kazema_shadow.variants.chess_char_2_11_a.bySkill[0].sources, [], '风丸 S1 makes no 纸偶');
  assert.deepEqual(tokens.token_10057_svash2_eagle1.variants.chess_char_5_14_a.bySkill[0].sources, ['talent', 'skill', 'display'], '凛御银灰 S1: talent eagle = eagle1');
});

test('enemies: rangeRadius contract (MELEE ⇒ 0) and undefined-field defaults', () => {
  for (const e of Object.values(enemies)) {
    const s = e.stats;
    assert.ok(s.rangeRadius >= 0, `${e.key}: rangeRadius ${s.rangeRadius}`);
    if (e.applyWay === 'MELEE') assert.equal(s.rangeRadius, 0, `${e.key}: MELEE enemy must not attack at range`);
    assert.ok(isFiniteNum(s.rawRangeRadius), `${e.key}: rawRangeRadius`);
    if (e.applyWay !== 'MELEE') assert.equal(s.rangeRadius, Math.max(0, s.rawRangeRadius), `${e.key}: rangeRadius`);
    assert.ok(s.maxHp > 0 && s.bat > 0 && s.moveSpeed >= 0 && s.lpr >= 0, `${e.key}: core stats`);
  }
  // Only three skill-driven leaders have an official (defined) attack speed of 0.
  const zeroAspd = Object.values(enemies).filter((e) => e.stats.aspd === 0).map((e) => e.key).sort();
  assert.deepEqual(zeroAspd, ['enemy_9017_achunt', 'enemy_9017_achunt_2', 'enemy_9021_acduml', 'enemy_9021_acduml_2', 'enemy_9022_acdumm']);
  assert.equal(enemies.enemy_1045_hammer.stats.rangeRadius, 0);         // 粉碎攻坚手: MELEE, official 2.5
  assert.equal(enemies.enemy_1045_hammer.stats.rawRangeRadius, 2.5);
  assert.equal(enemies.enemy_1305_mhslim.stats.rangeRadius, 1.8);       // 灼热源石虫: RANGED keeps its radius
  assert.equal(enemies.enemy_2016_csphtm.stats.aspd, 100);              // 卢西恩: undefined attackSpeed → 100
  assert.equal(enemies.enemy_1269_nhfly.stats.bat, 1);                  // 枯朽之种: undefined bat → 1
  assert.equal(enemies.enemy_1229_darmy.stats.lpr, 1);                  // 萨卡兹王庭军战士: undefined lpr → 1
  assert.equal(enemies.enemy_10067_ftsjc.stats.atk, 400);               // 灼藤: season override ATK 400
  for (const w of Object.values(waves)) {
    for (const [k, o] of Object.entries(w.overrides)) {
      if (o.stats && 'rangeRadius' in o.stats && (o.applyWay || enemies[k].applyWay) === 'MELEE') assert.equal(o.stats.rangeRadius, 0, `${w.id}: ${k}`);
    }
  }
});

test('stages: 下半 devices at match start = the non-hidden ones (act1 m02 has no crates); official helper lanes', () => {
  for (const s of Object.values(stages)) for (const d of s.devices) assert.equal(d.active, !d.hidden, `${s.id} ${d.alias}`);
  const m02 = stages.act1autochess_m02;
  for (const a of ['#001', '#002', '#003', '#004']) assert.equal(m02.devices.find((d) => d.alias === `trap_1105_accrate${a}`).active, false, `m02 crate ${a}`);
  // research 08 §3.2: upper gate of act1 m02 keeps the top road to col 3; act1 m04 stays on row 11 down to col 4
  const lane = (id, k = '12,10->9,2') => stages[id].groundPathsWithDevices[k].map((p) => p.join(',')).join(' ');
  assert.equal(lane('act1autochess_m02'), '12,10 12,9 12,8 12,7 12,6 12,5 12,4 12,3 11,3 10,3 9,3 9,2');
  assert.equal(lane('act1autochess_m04'), '12,10 12,9 11,9 11,8 11,7 11,6 11,5 11,4 10,4 9,4 9,3 9,2');
  assert.equal(lane('act2autochess_m02'), '12,10 12,9 12,8 12,7 11,7 10,7 9,7 9,6 9,5 9,4 9,3 9,2', 'crates on col 9: col 7 (mire)');
  assert.equal(lane('act2autochess_m02', '9,10->9,2'), '9,10 9,9 9,8 9,7 9,6 9,5 9,4 9,3 9,2');
});

test('stages: device rangeTiles are the direction-rotated range, inside the grid', () => {
  for (const s of Object.values(stages)) {
    for (const d of s.devices) {
      if (!d.rangeGrid) { assert.equal(d.rangeTiles ?? null, null, `${s.id} ${d.alias}`); continue; }
      assert.ok(Array.isArray(d.rangeTiles) && d.rangeTiles.length <= d.rangeGrid.length, `${s.id} ${d.alias}: rangeTiles`);
      for (const [r, c] of d.rangeTiles) assert.ok(r >= 0 && r < 19 && c >= 0 && c < 21, `${s.id} ${d.alias}: (${r},${c})`);
      assert.ok(d.rangeTiles.some(([r, c]) => r === d.pos[0] && c === d.pos[1]) || !d.rangeGrid.some(([a, b]) => a === 0 && b === 0), `${s.id} ${d.alias}: own tile`);
    }
  }
  // A blower on the row-13 separator facing DOWN blows into rows 12..10 of its column.
  const blower = stages.act2autochess_m01.devices.find((d) => d.key === 'trap_013_blower' && d.pos[0] === 13 && d.pos[1] === 5);
  assert.deepEqual(blower.rangeTiles, [[13, 5], [12, 5], [11, 5], [10, 5]]);
});

test('stages: player-facing names are clean Chinese "战场#NN…" labels (no research annotations)', () => {
  // Regression: research 05 named act1 m01 '战场#01 (upper half #01)'; the English note reached the
  // briefing BATTLEFIELD row. Names come from research only, so the build must strip such notes.
  for (const s of Object.values(stages)) {
    assert.match(s.name, /^战场#\d{2}(?:\((?:上半|下半)\))?(?: \S.*)?$/, `${s.id}: name ${JSON.stringify(s.name)}`);
    assert.doesNotMatch(s.name, /[A-Za-z]/, `${s.id}: Latin text in name ${JSON.stringify(s.name)}`);
    assert.equal(s.name, s.name.trim().replace(/\s+/g, ' '), `${s.id}: stray whitespace in name`);
  }
  assert.equal(stages.act1autochess_m01.name, '战场#01');
  assert.equal(stages.act2autochess_m01.name, '战场#05(下半) 源石流发生装置');
});

test('official spot checks (hard-coded values from the zh_CN client data)', () => {
  const st = (id) => { const s = chess[id].stats; return [s.maxHp, s.atk, s.def, s.res, s.blockCnt, s.cost]; };
  assert.deepEqual(st('chess_char_6_11_b'), [1893, 492, 141, 0, 1, 15]);      // 缪尔赛思 精锐 (E2 60 + module Lv3)
  assert.deepEqual(st('chess_char_6_17_b'), [3593, 1108, 279, 0, 1, 19]);     // 耀骑士临光 精锐
  assert.deepEqual(st('chess_char_3_08_a'), [1594, 629, 170, 15, 1, 25]);     // 薄绿 (E2 1)
  assert.deepEqual(st('chess_char_2_11_a'), [1816, 547, 254, 0, 2, 15]);      // 风丸 (E1 60)
  assert.deepEqual(st('chess_char_4_07_b'), [2383, 604, 359, 0, 1, 13]);      // 风笛 精锐
  assert.equal(chess.chess_char_6_11_b.module.level, 3);
  assert.deepEqual([chess.chess_char_4_07_b.skill.skillId, chess.chess_char_4_07_b.skill.level, chess.chess_char_4_07_b.skill.spCost], ['skchr_bpipe_2', 7, 5]);
  const es = (k) => { const s = enemies[k].stats; return [s.maxHp, s.atk, s.def, s.res]; };
  assert.deepEqual(es('enemy_1422_lrsldr'), [4700, 300, 100, 40]);           // 萨卡兹枯朽前锋 (template N)
  assert.deepEqual(es('enemy_1427_lrnazg'), [15000, 900, 500, 50]);          // “灵幛” (template E)
  assert.deepEqual(es('enemy_1045_hammer'), [10000, 1000, 1000, 0]);         // 粉碎攻坚手
  assert.deepEqual(bosses.boss_1.bloodPoint, { FUNNY: 247500, NORMAL: 675000, HARD: 1800000, ABYSS: 3600000 });
  assert.deepEqual(bosses.boss_10.bloodPoint, { FUNNY: 825000, NORMAL: 1012500, HARD: 3800000, ABYSS: 7600000 });
  assert.deepEqual([items.chess_item_1_01_e_a.name, items.chess_item_1_01_e_a.price, items.chess_item_1_01_e_a.params.atk], ['维式重锤', 1, 0.15]);
  assert.deepEqual([bands.band_sarkazb.totalHp, bands.band_lisa.totalHp], [45, 20]);
  assert.deepEqual(config.modes.mode_multi_abyss.rounds['15'].prepTime, 215);
  assert.equal(config.modes.mode_multi_abyss.enemyScale['6'].hp, 2.239488);   // 1.2^4 × 1.08
});

/** Read an official cache file (only called when HAS_CACHE). */
const raw = (rel) => JSON.parse(readFileSync(join(CACHE, rel), 'utf8'));

test('independent re-derivation of every chess and enemy stat from the raw official tables', { skip: !HAS_CACHE && 'no .cache/gamedata' }, () => {
  const act = raw('excel/activity_table.json').activity.AUTOCHESS_SEASON.act2autochess;
  const CT = raw('excel/character_table.json'), BE = raw('excel/battle_equip_table.json'), ST = raw('excel/skill_table.json');
  const PH = { PHASE_0: 0, PHASE_1: 1, PHASE_2: 2 };
  let n = 0;
  for (const [id, cd] of Object.entries(act.charChessDataDict)) {
    const c = chess[id];
    if (!c || c.isDiy) continue;
    const shop = act.charShopChessDatas[act.chessNormalIdLookupDict[id] || id];
    const P = CT[shop.charId].phases[PH[cd.status.evolvePhase]];
    const k0 = P.attributesKeyFrames[0], k1 = P.attributesKeyFrames[P.attributesKeyFrames.length - 1];
    const t = (cd.status.charLevel - k0.level) / (k1.level - k0.level || 1);
    const f = (key) => k0.data[key] + (k1.data[key] - k0.data[key]) * t;
    const exp = { maxHp: f('maxHp'), atk: f('atk'), def: f('def'), res: f('magicResistance'), aspd: f('attackSpeed'), blockCnt: f('blockCnt'), cost: f('cost') };
    const map = { max_hp: 'maxHp', atk: 'atk', def: 'def', magic_resistance: 'res', attack_speed: 'aspd', block_cnt: 'blockCnt', cost: 'cost' };
    if (cd.status.equipLevel > 0 && shop.defaultUniEquipId) {
      const mp = BE[shop.defaultUniEquipId]?.phases.find((p) => p.equipLevel === cd.status.equipLevel);
      for (const b of mp?.attributeBlackboard || []) if (map[b.key]) exp[map[b.key]] += b.value;
    }
    for (const [key, v] of Object.entries(exp)) assert.ok(Math.abs(v - c.stats[key]) <= 0.5 + 1e-9, `${id} ${c.name}: ${key} ${c.stats[key]} vs official ${v}`);
    const lv = ST[CT[shop.charId].skills[shop.defaultSkillIndex].skillId].levels[cd.status.skillLevel - 1];
    for (const e of lv.blackboard) if (!(e.valueStr && e.value === 0)) assert.ok(Math.abs(c.skill.bb[e.key] - e.value) < 1e-6, `${id}: skill bb ${e.key}`);
    assert.deepEqual([c.skill.spCost, c.skill.initSp, c.skill.duration], [lv.spData.spCost, lv.spData.initSp, lv.duration], `${id}: skill sp`);
    // every selectable skill (DESIGN §16) at the chess skill level
    const ph = PH[cd.status.evolvePhase];
    const unlockedIdx = CT[shop.charId].skills.map((s, i) => [s, i]).filter(([s, i]) => s.skillId && (i === shop.defaultSkillIndex || PH[s.unlockCond?.phase ?? 'PHASE_0'] <= ph)).map(([, i]) => i);
    assert.deepEqual(c.skills.map((s) => s.index), unlockedIdx, `${id}: unlocked skills`);
    for (const s of c.skills) {
      const sl = ST[CT[shop.charId].skills[s.index].skillId].levels[cd.status.skillLevel - 1];
      for (const e of sl.blackboard) if (!(e.valueStr && e.value === 0)) assert.ok(Math.abs(s.bb[e.key] - e.value) < 1e-6, `${id} S${s.index + 1}: bb ${e.key}`);
      assert.deepEqual([s.spCost, s.initSp, s.duration, s.name], [sl.spData.spCost, sl.spData.initSp, sl.duration, sl.name], `${id} S${s.index + 1}: sp`);
    }
    for (const m of c.modules || []) {
      const mp = BE[m.uniEquipId].phases.find((p) => p.equipLevel === cd.status.equipLevel);
      const exp = {};
      for (const b of mp.attributeBlackboard) exp[map[b.key] ?? b.key] = (exp[map[b.key] ?? b.key] || 0) + b.value;
      for (const [k, v] of Object.entries(exp)) {
        const f = { respawn_time: 'respawnTime', base_attack_time: 'bat', max_deploy_count: 'deployLimit', max_deck_stack_cnt: 'deckStack' }[k] ?? k;
        assert.ok(Math.abs(m.attr[f] - v) < 1e-6, `${id} ${m.uniEquipId}: attr ${k} ${m.attr[f]} vs official ${v}`);
      }
    }
    n++;
  }
  assert.equal(n, 258);

  const db = new Map(raw('levels/enemydata/enemy_database.json').enemies.map((e) => [e.Key, e.Value]));
  const ov = new Map((raw('levels/activities/act1autochess/level_autochess_enemy_data.json').enemyDbRefs || [])
    .filter((r) => r.overwrittenData).map((r) => [r.id, r.overwrittenData]));
  // the 鸭爵 strategy's swapped-in enemies cost 1 LP at the protection point (PRTS 卫戍协议：盟约 下半/PRTS盟约记录 鸭爵 备注
  // "但进入保护目标点将减少1点目标生命值"; the database's lifePointReduce 0 is the roguelike rule)
  const swapped = new Set(Object.values(act.effectBuffInfoDataDict).flat().filter((b) => b.key === 'round_start_all_player_change_enemy_2')
    .flatMap((b) => b.blackboard.filter((kv) => kv.key === 'enemylist').flatMap((kv) => kv.valueStr.split(','))));
  assert.equal(swapped.size, 4);
  for (const e of Object.values(enemies)) {
    const base = db.get(e.key).find((l) => l.level === 0).enemyData;
    const o = ov.get(e.key);
    // Season override if defined, else the base value if defined, else the documented default.
    const pick = (get, dflt) => {
      const x = o && get(o);
      if (x && x.m_defined) return x.m_value;
      const b = get(base);
      return b && b.m_defined ? b.m_value : dflt;
    };
    const exp = {
      maxHp: pick((x) => x.attributes?.maxHp, 0), atk: pick((x) => x.attributes?.atk, 0), def: pick((x) => x.attributes?.def, 0),
      res: pick((x) => x.attributes?.magicResistance, 0), moveSpeed: pick((x) => x.attributes?.moveSpeed, 1),
      bat: pick((x) => x.attributes?.baseAttackTime, 1), aspd: pick((x) => x.attributes?.attackSpeed, 100),
      lpr: swapped.has(e.key) ? 1 : pick((x) => x.lifePointReduce, 1), massLevel: pick((x) => x.attributes?.massLevel, 0),
      motion: pick((x) => x.motion, 'WALK'),
    };
    for (const [key, v] of Object.entries(exp)) {
      const got = e.stats[key];
      assert.ok(typeof v === 'number' ? Math.abs(v - got) < 1e-6 : v === got, `${e.key} ${e.name}: ${key} ${got} vs official ${v}`);
    }
    // official attribute power (RandomEnemyGenerater._GetEnemyAttrPower): DATABASE stats (no season override), float32
    const at = base.attributes;
    const f = Math.fround;
    const P = f(f(f(f(at.atk.m_value * 5) + f(at.maxHp.m_value)) + f(at.def.m_value * 3)) + f(3 * at.magicResistance.m_value));
    assert.equal(e.attrPower, P, `${e.key} ${e.name}: attrPower`);
  }
  // 灼藤 / 元核孽生者 count with their database ATK, not the season override 400 (research 08 §2.3)
  for (const k of ['enemy_10067_ftsjc', 'enemy_1439_dslntf']) {
    const e = enemies[k];
    assert.equal(e.stats.atk, 400, `${k}: spawned with the season ATK`);
    assert.notEqual(e.attrPower, e.stats.maxHp + 5 * e.stats.atk + 3 * e.stats.def + 3 * e.stats.res, `${k}: power from the database ATK`);
  }
});

test('independent re-derivation of every 外援 record\'s stats and modules at its slot\'s official 模组 level', { skip: !HAS_CACHE && 'no .cache/gamedata' }, () => {
  // Catches a slot level silently copied from the other tier again (the tier V elites once carried tier VI's level 3).
  const act = raw('excel/activity_table.json').activity.AUTOCHESS_SEASON.act2autochess;
  const CT = raw('excel/character_table.json'), BE = raw('excel/battle_equip_table.json'), UE = raw('excel/uniequip_table.json');
  const PH = { PHASE_0: 0, PHASE_1: 1, PHASE_2: 2 };
  const map = { max_hp: 'maxHp', atk: 'atk', def: 'def', magic_resistance: 'res', attack_speed: 'aspd', block_cnt: 'blockCnt', cost: 'cost',
    respawn_time: 'respawnTime', base_attack_time: 'bat', max_deploy_count: 'deployLimit', max_deck_stack_cnt: 'deckStack' };
  let n = 0;
  for (const [id, c] of Object.entries(allChess)) {
    if (!id.includes('_diy_')) continue;
    const slot = act.charChessDataDict[`chess_char_${c.tier}_diy1_${c.isGolden ? 'b' : 'a'}`].status;
    assert.equal(c.status.equipLevel, slot.equipLevel, `${id}: the official slot's equipLevel`);
    const advanced = (UE.charEquip[c.charId] || []).filter((u) => UE.equipDict[u]?.type !== 'INITIAL');
    const def = advanced[0] ?? null;
    assert.equal(c.module?.id ?? null, def, `${id}: default module = the operator's first ADVANCED uniequip`);
    const P = CT[c.charId].phases[PH[slot.evolvePhase]];
    const k0 = P.attributesKeyFrames[0], k1 = P.attributesKeyFrames[P.attributesKeyFrames.length - 1];
    const t = (slot.charLevel - k0.level) / (k1.level - k0.level || 1);
    const f = (key) => k0.data[key] + (k1.data[key] - k0.data[key]) * t;
    const exp = { maxHp: f('maxHp'), atk: f('atk'), def: f('def'), res: f('magicResistance'), aspd: f('attackSpeed'), blockCnt: f('blockCnt'), cost: f('cost') };
    const attrAt = (u) => {
      const out = {};
      for (const b of BE[u]?.phases.find((p) => p.equipLevel === slot.equipLevel)?.attributeBlackboard || []) out[map[b.key] ?? b.key] = (out[map[b.key] ?? b.key] || 0) + b.value;
      return out;
    };
    if (slot.equipLevel > 0 && def) for (const [k, v] of Object.entries(attrAt(def))) if (k in exp) exp[k] += v;
    for (const [key, v] of Object.entries(exp)) assert.ok(Math.abs(v - c.stats[key]) <= 0.5 + 1e-9, `${id}: ${key} ${c.stats[key]} vs official ${v}`);
    if (c.isGolden) {
      assert.deepEqual(c.modules.map((m) => m.uniEquipId), advanced, `${id}: every ADVANCED module is a choice`);
      for (const m of c.modules) {
        for (const [k, v] of Object.entries(attrAt(m.uniEquipId))) assert.ok(Math.abs(m.attr[k] - v) < 1e-6, `${id} ${m.uniEquipId}: attr ${k} ${m.attr[k]} vs official ${v}`);
      }
    }
    n++;
  }
  assert.equal(n, waiguanCandidates.length * 4);
});

test('offline rebuild reproduces data/ byte-for-byte (data/ is not stale)', { skip: (!HAS_CACHE && 'no .cache/gamedata') || (process.env.DATA_DIR && 'DATA_DIR set') }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'sp-data-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-data.mjs'), '--offline', '--quiet', '--out', out, '--report', join(out, 'report.json')], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0 && /missing cached file/.test(r.stderr)) { t.skip('partial .cache/gamedata (run node tools/build-data.mjs once online)'); return; }
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);
    for (const f of FILES) {
      assert.ok(readFileSync(join(out, `${f}.json`)).equals(readFileSync(join(DATA, `${f}.json`))), `data/${f}.json is stale — run: node tools/build-data.mjs`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('build CLI rejects unknown options and missing values without writing anything', () => {
  for (const args of [['--bogus'], ['--out'], ['--out', '--offline'], ['--refresh', '--offline']]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-data.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status}`);
    assert.match(r.stderr, /usage:/);
  }
});
