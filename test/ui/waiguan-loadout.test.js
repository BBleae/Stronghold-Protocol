// 外援 / 甄选 (DIY) as a 干员调配 target (DESIGN §16 / §27) — the bug this locks down: a picked 外援 operator appeared on the
// screen but its skill could not be switched. Its record was `visible: false` and `isDiy`, so BOTH ends dropped the entry —
// the screen's roster predicate (isLoadoutSlot) and the server's checkLoadout — and the debounced sync then never sent it.
//
// The three ends are asserted against the SAME picks: the client model (screen), the lobby's lookup, and a running match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLoadout, loadoutOptions } from '../../shared/protocol.js';
import { waiguanRecords, isWaiguanRecord, WAIGUAN_SLOTS } from '../../shared/waiguan.js';
import {
  rosterOf, isLoadoutSlot, sanitizeEntries, changedCount, waiguanPickChess, withWaiguan, recordsOf, effectiveChoice, setChoice, chessOptions,
} from '../../public/js/ui/loadoutModel.js';
import { loadData } from '../../server/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHESS = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
const WAIGUAN = JSON.parse(readFileSync(path.join(ROOT, 'data/waiguan.json'), 'utf8'));
const RECORDS = waiguanRecords(WAIGUAN);
const data = loadData();

/** A candidate whose ELITE (tier VI) carries at least two modules, so skills AND the module are exercised. */
const CAND = WAIGUAN.candidates.find((c) => (RECORDS[`${c.chessIds[6].slice(0, -1)}b`]?.modules || []).length >= 2);
assert.ok(CAND, 'a candidate with module choices');
const A6 = CAND.chessIds[6];
const G6 = `${A6.slice(0, -1)}b`;
const A5 = CAND.chessIds[5];
const PICKS = { diy6a: CAND.charId };
const INSIDE = 'chess_char_1_01_a';

const diyOf = (picks) => waiguanPickChess(WAIGUAN, picks);
const clientLookup = (picks) => withWaiguan((id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : null), diyOf(picks));
/** The lobby's own lookup (server/lobby.js loadout): data/chess.json widened by THIS session's picks. */
const lobbyLookup = (picks) => {
  const diy = diyOf(picks);
  return (id) => data.chess[id] || diy[id] || null;
};

test('外援: the four slot TEMPLATES are never loadout slots, a picked operator is', () => {
  for (const s of WAIGUAN_SLOTS) {
    const tpl = CHESS[s.chessId];
    assert.ok(tpl && tpl.isDiy, `${s.chessId}: the template`);
    assert.equal(isWaiguanRecord(tpl), false, `${s.chessId}: a template is not a real operator`);
    assert.equal(isLoadoutSlot(tpl), false, `${s.chessId}: never a loadout slot`);
  }
  assert.equal(isWaiguanRecord(RECORDS[A6]), true);
  assert.equal(isLoadoutSlot(RECORDS[A6]), true, 'a picked operator is');
  assert.equal(isLoadoutSlot(RECORDS[A5]), true, 'at both tiers');
  assert.equal(isLoadoutSlot(RECORDS[G6]), false, 'the elite form is not a slot of its own (the base id is)');
});

test('外援: the screen offers its skills and module, and the roster lists it once per tier', () => {
  const get = clientLookup(PICKS);
  const base = get(A6);
  const golden = get(G6);
  const opt = chessOptions(base, golden);
  assert.deepEqual(opt.skillOptions.map((s) => s.index), [0, 1, 2], 'the three skills are choices');
  assert.equal(opt.skillOptions.filter((s) => s.isDefault).length, 1);
  assert.ok(opt.moduleOptions.length >= 2, 'the module choices are there');
  for (const s of opt.skillOptions) assert.ok(s.normal && s.elite, `skill ${s.index}: a record at both statuses`);

  // the roster gains exactly the two tiers of the picked operator (base form only: the elite shares the slot)
  const plain = rosterOf(Object.values(CHESS));
  const withPick = rosterOf([...Object.values(CHESS), ...Object.values(diyOf(PICKS))]);
  assert.equal(withPick.length, plain.length + 2, 'two records (tier V, tier VI)');
  assert.deepEqual(withPick.filter((c) => c.isDiy).map((c) => c.chessId).sort(), [A5, A6].sort());
});

test('外援: a switched skill survives the client sanitiser and the lobby check (and is normalised)', () => {
  const get = clientLookup(PICKS);
  const lo = lobbyLookup(PICKS);
  const mod = RECORDS[G6].modules.find((m) => !m.isDefault).uniEquipId;
  // setChoice is what the screen's radio group calls: skill 2 + a non-default module
  let entries = {};
  entries = setChoice(entries, get(A6), get(G6), { skill: 2 });
  entries = setChoice(entries, get(A6), get(G6), { module: mod });
  assert.deepEqual(entries[A6], { skill: 2, module: mod });

  const sent = sanitizeEntries(entries, get);
  assert.deepEqual(sent, { [A6]: { skill: 2, module: mod } }, 'the client sends it');
  const accepted = checkLoadout(sent, lo);
  assert.equal(accepted.error, undefined, `the lobby refuses it: ${accepted.detail || ''}`);
  assert.deepEqual(accepted.loadout, { [A6]: { skill: 2, module: mod } });
  // the screen can read the choice back
  assert.equal(effectiveChoice(sent, get(A6), get(G6)).skill, 2);
  assert.equal(changedCount(sent, get), 1, 'and counts it as a change');
});

test('外援 modules: a tier V elite offers its modules at level 1, a tier VI elite at level 3; the two tiers are separate keys', () => {
  // 阿: GEE-X (default) + GEE-Y, the same ids at both tiers, level-1 / level-3 numbers (official battle_equip_table)
  const picks = { diy5a: 'char_225_haak', diy6a: 'char_225_haak', diy5b: 'char_1052_kalts2' };
  const get = clientLookup(picks);
  const lo = lobbyLookup(picks);
  const id = (tier, g) => `chess_char_diy_${tier}_char_225_haak_${g ? 'b' : 'a'}`;
  const opt = (tier) => chessOptions(get(id(tier)), get(id(tier, true))).moduleOptions.map((m) => [m.id, m.rec?.level ?? null, m.rec?.attr ?? null]);
  assert.deepEqual(opt(5), [['uniequip_002_haak', 1, { maxHp: 135, atk: 37 }], ['uniequip_003_haak', 1, { atk: 43, aspd: 3, respawnTime: -15 }], ['none', null, null]]);
  assert.deepEqual(opt(6), [['uniequip_002_haak', 3, { maxHp: 240, atk: 57 }], ['uniequip_003_haak', 3, { atk: 75, aspd: 5, respawnTime: -15 }], ['none', null, null]]);
  assert.deepEqual(loadoutOptions(lo(id(5)), lo(id(5, true))).modules, ['uniequip_002_haak', 'uniequip_003_haak', 'none']);
  // the screen sends, the lobby accepts: a non-default module, 'none', each tier on its own key
  const entries = { [id(5)]: { module: 'uniequip_003_haak' }, [id(6)]: { module: 'none' } };
  assert.deepEqual(sanitizeEntries(entries, get), entries);
  assert.deepEqual(checkLoadout(entries, lo), { ok: true, loadout: { [id(5)]: { skill: 0, module: 'uniequip_003_haak' }, [id(6)]: { skill: 0, module: 'none' } } });
  assert.deepEqual(checkLoadout({ [id(5)]: { module: 'uniequip_002_haak' } }, lo), { ok: true, loadout: {} }, 'the default is dropped');
  // another operator's module, and any module on a module-less 外援 (凯尔希·思衡托: only 'none', its default)
  assert.equal(checkLoadout({ [id(6)]: { module: 'uniequip_002_ling' } }, lo).error, 'BAD_TARGET');
  assert.deepEqual(checkLoadout({ chess_char_diy_5_char_1052_kalts2_a: { module: 'none' } }, lo), { ok: true, loadout: {} });
  assert.equal(checkLoadout({ chess_char_diy_5_char_1052_kalts2_a: { module: 'uniequip_002_kalts2' } }, lo).error, 'BAD_TARGET');
});

test('外援: without the pick, or with another operator picked, the same entry is refused everywhere', () => {
  const entry = { [A6]: { skill: 2 } };
  // the screen never even lists it
  assert.deepEqual(sanitizeEntries(entry, clientLookup({})), {});
  assert.equal(changedCount(entry, clientLookup({})), 0);
  // and the lobby refuses it (unknown chess — no such record in its lookup)
  const r = checkLoadout(entry, lobbyLookup({}));
  assert.equal(r.error, 'BAD_TARGET');
  assert.match(r.detail, /unknown chess/);
  // a DIFFERENT candidate's record is refused too while this session picked somebody else
  const other = WAIGUAN.candidates.find((c) => c.charId !== CAND.charId);
  const r2 = checkLoadout({ [other.chessIds[6]]: { skill: 0 } }, lobbyLookup(PICKS));
  assert.equal(r2.error, 'BAD_TARGET', 'a 外援 the session did not pick stays unknown');
  // the templates are refused as well (they have no skills at all)
  const r3 = checkLoadout({ chess_char_6_diy1_a: { skill: 0 } }, lobbyLookup(PICKS));
  assert.equal(r3.error, 'BAD_TARGET');
});

test('外援: the pool operator loadout is untouched by any of this', () => {
  const get = clientLookup(PICKS);
  // a pool operator whose elite offers a choice of modules (隐现 has only its default one)
  const multi = Object.values(CHESS).find((c) => c.isGolden && (c.modules || []).length >= 2);
  const base = CHESS[multi.baseId];
  const mod = multi.modules.find((m) => !m.isDefault).uniEquipId;
  const sent = sanitizeEntries({ [base.chessId]: { skill: 0, module: mod } }, get);
  assert.deepEqual(sent, { [base.chessId]: { skill: 0, module: mod } });
  const accepted = checkLoadout(sent, lobbyLookup(PICKS));
  assert.equal(accepted.error, undefined, accepted.detail || '');
  // an unknown id is still refused with a pick present
  assert.equal(checkLoadout({ 'chess_char_9_99_a': { skill: 0 } }, lobbyLookup(PICKS)).error, 'BAD_TARGET');
  assert.equal(loadoutOptions(RECORDS[A6], get(G6)).skills.length, 3);
});
