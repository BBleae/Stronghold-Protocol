// test/content/waiguan/_all.test.js — every 外援 kit registered in server/sim/content/kits/waiguan/index.js: coverage of
// every selectable skill × module (normal + elite, both tiers), and a real wave per skill without content errors.
// Kits not written yet are listed (not failed) until WAIGUAN_STRICT=1 — the last integration commit sets it to 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, checkInvariants } from '../../helpers/battleHarness.js';
import { DataSource, getDefaultSource } from '../../../server/sim/simdata.js';
import { getData } from '../../../server/data.js';
import { waiguanRecords } from '../../../shared/waiguan.js';
import { KITS, skillSpecSource } from '../../../server/sim/content/index.js';
import { WAIGUAN_KITS } from '../../../server/sim/content/kits/waiguan/index.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const REC = waiguanRecords(DATA.waiguan);
const DS = new DataSource({ chess: REC }, getDefaultSource());
const STRICT = process.env.WAIGUAN_STRICT === '1';
const authored = new Set(WAIGUAN_KITS.map(([charId]) => charId));

test('外援 kits: every registered operator covers every skill × module of both tiers; the rest are listed', () => {
  const missing = DATA.waiguan.candidates.filter((c) => !authored.has(c.charId)).map((c) => `${c.name}(${c.charId})`);
  if (missing.length) console.log(`外援 kits still generic: ${missing.length}/87 — ${missing.join(' ')}`);
  if (STRICT) assert.deepEqual(missing, []);
  for (const c of DATA.waiguan.candidates.filter((x) => authored.has(x.charId))) {
    for (const tier of [5, 6]) {
      const base = REC[c.chessIds[tier]];
      for (const id of [base.chessId, base.goldenId]) {
        const rec = REC[id];
        const mods = id === base.goldenId ? [null, 'none', ...(rec.modules ?? []).map((m) => m.uniEquipId)] : [null];
        for (const s of rec.skills) for (const moduleId of mods) {
          assert.equal(skillSpecSource(DS.getChess(id, { skillIndex: s.index, moduleId }), KITS), 'skills', `${id} ${s.skillId} ${moduleId}`);
        }
      }
    }
  }
});

test('外援 kits: every skill of every authored operator (T6 normal + elite) survives a real wave and casts', () => {
  for (const c of DATA.waiguan.candidates.filter((x) => authored.has(x.charId))) {
    const base = REC[c.chessIds[6]];
    for (const id of [base.chessId, base.goldenId]) {
      for (const s of REC[id].skills) {
        const h = makeBattle({ defs: { chess: REC }, seed: 3, timeLimit: 60,
          units: [{ chessId: id, row: 10, col: 4, skillIndex: s.index, carryState: { sp: 999 } }, { chessId: 'chess_char_1_01_a', row: 9, col: 4 }, { chessId: 'chess_char_2_06_a', row: 11, col: 5 }],
          enemies: [{ key: 'enemy_1007_slime', count: 8, interval: 1.5 }, { key: 'enemy_1007_slime', route: 1, count: 8, interval: 1.5, time: 3 }] });
        h.runToEnd(90);
        checkInvariants(h.b);
        assert.equal(h.b.errors.length, 0, `${id} ${s.skillId}: ${JSON.stringify(h.b.errors[0])}`);
        const u = h.b.allyUnits.find((x) => x.defId === id);
        assert.equal(u.kit.skillSource, 'skills', `${id} ${s.skillId} hand-authored`);
        if (u.skill.kind !== 'passive' && u.skill.rule !== 'TAKE_DAMAGE') assert.ok(u.skill.activations > 0, `${id} ${s.skillId} casts`);
      }
    }
  }
});
