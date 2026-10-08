// test/render/makoto-persona.test.js — the fork's collab pick 结城理 (docs/design/fork.md §F6): his <替身> is the persona of
// his skill, drawn on its own clips of his skeleton (render/units.js FORMS char_4217_makoto). The sim (kits/ops/op-makoto.js
// MODEL) follows the engine's 'doll' with an fx 'persona' { form, dur } and keeps the persona as the UnitInfo `form`; the
// view plays its SwitchIn, its idle / attack, its SwitchOut over the last second, and the 本体 back on the <总攻击> clip; S3
// changes <塔纳托斯·改> into <俄耳甫斯·改> through ChangeBegin / ChangeEnd. Headless fake PIXI (test/render/fakepixi.js) on
// the real manifest, as test/render/feedback2-doll.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { spineEntry, hasBackSpine } from '../../public/js/assets.js';
import { FX_KINDS } from '../../public/js/render/fx/kinds.js';
import { fxForm } from '../../shared/protocol.js';
import { makeBattle, enemyRec } from '../helpers/battleHarness.js';
import { unitInfo } from '../../server/sim/snapshot.js';
import { DOLL_SWITCH } from '../../server/sim/professions.js';
import { MODEL } from '../../server/sim/content/kits/ops/op-makoto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const MAKOTO = 'char_4217_makoto';

let fake, UnitView, FORMS, renderInfo;
before(async () => {
  fake = installFakePixi();
  ({ UnitView, FORMS } = await import('../../public/js/render/units.js'));
  ({ renderInfo } = await import('../../public/js/render/app.js'));
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('normal', { width: 1280, height: 720 });
function store() {
  return {
    picture: () => null,
    image: async () => null,
    hasBack: (id) => hasBackSpine(assets, id),
    spineEntry: (id, o) => spineEntry(assets, id, o),
    spine: { acquire: async (entry) => ({ animations: Object.keys(entry.animations || {}).map((name) => ({ name })) }), release() {} },
  };
}
async function view(info = {}) {
  const ctx = fakeViewCtx(fake.P, { assets: store(), cam });
  const v = new UnitView(ctx, { id: 1, side: 'ally', kind: 'op', defId: MAKOTO, spine: MAKOTO, tier: 6, x: 5, y: 10, maxHp: 3000, dir: 'RIGHT', skillIndex: 0, ...info });
  await tick(); await tick();
  assert.ok(v.actor, 'Spine model built');
  return v;
}
const clip = (v) => v.actor.current;
const frames = (v, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };
const secs = (v, s) => frames(v, Math.round(s * 60));

test('every persona form is the sim\'s (MODEL) and its clips are in his Front skeleton; the fx kind draws nothing', () => {
  const front = assets.chars[MAKOTO].spine.front.animations;
  assert.deepEqual(Object.keys(FORMS[MAKOTO]).sort(), Object.values(MODEL).sort());
  for (const [form, f] of Object.entries(FORMS[MAKOTO])) {
    for (const name of [f.change, f.end, f.leave, f.roles.idle, f.roles.die, f.roles.attack?.loop].filter(Boolean)) assert.ok(name in front, `${form}: ${name}`);
    if (f.next) assert.ok(FORMS[MAKOTO][f.next], `${form} → ${f.next}`);
  }
  assert.equal(FORMS[MAKOTO].thanatos.roles.attack, null, '<塔纳托斯> has no attack clip');
  assert.equal(FORMS[MAKOTO].orpheusR.roles.attack, null, '<俄耳甫斯·改> never attacks');
  assert.equal(FX_KINDS.persona?.a, 'none');
});

test('S1 <俄耳甫斯>: the engine\'s \'doll\' changes nothing, the persona comes in on its SwitchIn, attacks on its clip, leaves on its SwitchOut; the 本体 back on the <总攻击>', async () => {
  const v = await view();
  assert.equal(clip(v), 'Idle');
  const dur = DOLL_SWITCH + 20;
  v.setForm('doll', { id: 1, form: 'doll', dur });       // the engine's 'substitute': no clip set of his
  assert.equal(clip(v), 'Idle');
  v.setForm('orpheus', { id: 1, form: 'orpheus', dur }); // the kit's 'persona'
  assert.equal(clip(v), 'Doll_Skill_1_SwitchIn');
  secs(v, 1.1);
  assert.equal(clip(v), 'Doll_Skill_1_Idle');
  v.onAttack(null, 2);
  assert.equal(clip(v), 'Doll_Skill_1_Attack');
  secs(v, dur - 1 - 1.1 + 0.05);
  assert.equal(clip(v), 'Doll_Skill_1_SwitchOut', 'it leaves over its last second');
  secs(v, 0.9);
  v.setForm(null, { id: 1, form: null });                // the engine's 'swap'
  assert.equal(clip(v), 'Skill_AllOutAttack_End', 'the 本体 back: S.E.E.S.队长\'s <总攻击>');
  secs(v, 1.5);
  assert.equal(clip(v), 'Idle');
});

test('S2 <塔纳托斯> knocked out: its Die, held through the reset; S3: <塔纳托斯·改> → ChangeBegin → ChangeEnd → <俄耳甫斯·改>', async () => {
  const v = await view({ skillIndex: 1 });
  v.setForm('thanatos', { dur: 21 });
  assert.equal(clip(v), 'Doll_Skill_2_SwitchIn');
  secs(v, 1.1);
  assert.equal(clip(v), 'Doll_Skill_2_Loop');
  v.onAttack(null, 2);
  assert.equal(clip(v), 'Doll_Skill_2_Loop', 'no attack clip');
  v.die();
  assert.equal(clip(v), 'Doll_Skill_2_Die');
  v.setForm(null, { form: null });                       // 'dollEnd' after the 'die' event
  assert.equal(clip(v), 'Doll_Skill_2_Die');

  const w = await view({ skillIndex: 2 });
  w.setForm('thanatosR', { dur: 21 });
  assert.equal(clip(w), 'Doll_Skill_3_P1_SwitchIn');
  secs(w, 1.1);
  w.onAttack(null, 2);
  assert.equal(clip(w), 'Doll_Skill_3_P1_Attack_A');
  secs(w, 2);
  w.setForm('orpheusRChange', { dur: 1.5 });
  assert.equal(clip(w), 'Doll_Skill_3_P1toP2_ChangeBegin');
  secs(w, 0.6);
  assert.equal(clip(w), 'Doll_Skill_3_P1toP2_ChangeEnd', 'timed to end with the change window');
  secs(w, 0.9);
  w.setForm('orpheusR', { dur: 14 });
  secs(w, 0.2);
  assert.equal(clip(w), 'Doll_Skill_3_P2_Loop');
  w.die();
  assert.equal(clip(w), 'Doll_Skill_3_P2_Die');
  const late = await view({ skillIndex: 2, form: 'orpheusR' });
  assert.equal(clip(late), 'Doll_Skill_3_P2_Loop', 'a view built later (UnitInfo form)');
});

test('sim → view: the real 结城理\'s cast puts UnitInfo `form` on the persona of his skill and its fx (\'persona\', dur = the time to the switch back) switch the view', async () => {
  for (const [skill, model, idle] of [[0, 'orpheus', 'Doll_Skill_1_Idle'], [1, 'thanatos', 'Doll_Skill_2_Loop'], [2, 'thanatosR', 'Doll_Skill_3_P1_Idle']]) {
    const h = makeBattle({
      autoFinish: false, timeLimit: 60, captureNoisy: true, flags: { dpPerSec: 0, dpMax: 999 },
      defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e9, atk: 0, speed: 0, mass: 0 }) } },
      units: [{ uid: 1, diy: { slot: 'chess_char_6_diy1_a', charId: MAKOTO, skillIndex: skill, uniEquipId: null }, elite: true, row: 10, col: 5, carryState: { sp: 999 } }],
      enemies: [{ key: 'enemy_dummy', pos: [10, 6] }],
    });
    h.step();
    const u = h.unit(1);
    const v = await view({ ...renderInfo(unitInfo(u)), id: 1, skillIndex: skill });
    assert.ok(h.runUntil(() => u.trait.doll, 5), `S${skill + 1}: the <替身>`);
    const fx = h.eventsOf('fx').filter((e) => e[4]?.id === u.id && fxForm(e) !== undefined);
    const persona = fx.find((e) => e[1] === 'persona');
    assert.ok(persona && persona[4].form === model, `S${skill + 1}: fx persona ${model}`);
    assert.ok(persona[4].dur > 20 && persona[4].dur <= DOLL_SWITCH + 20 + 1e-9, `dur ${persona[4].dur}`);
    assert.equal(unitInfo(u).form, model);
    for (const e of fx) v.setForm(fxForm(e), e[4]);
    secs(v, 1.1);
    assert.equal(clip(v), idle);
    assert.equal(h.b.errors.length, 0);
  }
});
