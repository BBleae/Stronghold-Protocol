// Account history's 常用干员 (public/js/screens/history.js, shared/history.js aggregateStats): every row names an operator.
// A 自选 piece is archived as its operator's charId (server/match/checkpoint.js usedOperators; its slot id named only
// '甄选干员'), and a match the deployed fork archived with 外援 (DESIGN §F3, retired 2026-10-08) holds the old record id
// chess_char_diy_<tier>_<charId>_a, which no data file names any more: it counts as that operator's charId too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { aggregateStats, historyOperatorId } = await import('../../shared/history.js');
const { operatorName } = await import('../../public/js/screens/history.js');
const { makeLookups } = await import('../../public/js/ui/gameComponents.js');
const { data } = await import('../../public/js/data.js');
const { DATA } = await import('../match/harness.js');

await data.loadAll('chess', 'backups');

const SHARP = 'char_609_acguad';
const HAAK = 'char_225_haak'; // 阿: a 外援 pick on the deployed fork, a 自选 operator now
const TEXAS = 'chess_char_1_10_a';

test('historyOperatorId: an old 外援 record id is its operator; anything else stays as recorded', () => {
  assert.equal(historyOperatorId('chess_char_diy_6_char_225_haak_a'), HAAK);
  assert.equal(historyOperatorId('chess_char_diy_5_char_225_haak_a'), HAAK);
  assert.equal(historyOperatorId('chess_char_diy_6_char_1012_skadi2_b'), 'char_1012_skadi2');
  for (const id of [TEXAS, SHARP, 'chess_char_5_diy1_a', 'x']) assert.equal(historyOperatorId(id), id);
});

test('常用干员: an operator fielded as 外援 before and through 自选编队 now is one row, named; chess by their names', () => {
  const facts = [
    { status: 'completed', victory: true, round: 9, operators: [TEXAS, 'chess_char_diy_6_char_225_haak_a', 'chess_char_diy_5_char_225_haak_a'] },
    { status: 'completed', victory: false, round: 7, operators: [TEXAS, HAAK, SHARP] },
  ];
  const stats = aggregateStats(facts);
  assert.deepEqual(stats.operators, [{ id: HAAK, matches: 2 }, { id: TEXAS, matches: 2 }, { id: SHARP, matches: 1 }]);
  const gd = makeLookups();
  assert.deepEqual(stats.operators.map((op) => operatorName(gd, op.id)),
    [DATA.backups.units[HAAK].name, DATA.chess[TEXAS].name, DATA.backups.units[SHARP].name]);
  assert.equal(DATA.backups.units[HAAK].name, '阿');
  // an id the data does not have stays readable as itself
  assert.equal(operatorName(gd, 'char_0000_nobody'), 'char_0000_nobody');
});
