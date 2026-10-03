// test/render/forms.test.js — user playtest #5 item 1, client side: 掠海漂移体 drops from 近地悬浮 to 爬行模式 for good
// when stunned / frozen / put to sleep (sim content/enemies.js kitSyufo, fx 'phase' { id, kind: 'crawl' }); from then on
// melee operators block and hit it, so its model must stop hovering: render/units.js FORMS switches the view to the
// skeleton's crawl clips (*_02) after its 'Change' clip (render/spine.js SpineActor.setForm), also for a view built
// after the change (render/app.js keeps the mode on the unit info). Headless fake PIXI (test/render/fakepixi.js).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { UF, ANIM } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const SYUFO = 'enemy_2025_syufo';

let fake, UnitView, FORMS;
before(async () => {
  fake = installFakePixi();
  ({ UnitView, FORMS } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('normal', { width: 1280, height: 720 });

/** Asset store with the real manifest entry of the skeleton and its animation names. */
function store(id) {
  const entry = assets.enemies[id].spine;
  const names = Object.keys(entry.animations || {});
  return {
    picture: () => null,
    image: async () => null,
    spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: names.map((name) => ({ name })) }), release() {} },
  };
}

async function syufo(info = {}) {
  const ctx = fakeViewCtx(fake.P, { assets: store(SYUFO), cam });
  const v = new UnitView(ctx, { id: 7, side: 'enemy', kind: 'enemy', defId: SYUFO, spine: SYUFO, tier: 1, x: 8, y: 9, maxHp: 1000, facing: -1, ...info });
  await tick(); await tick();
  assert.ok(v.actor, 'Spine model built');
  return v;
}
const clip = (v) => v.actor.current;
const sample = (flags = 0, anim = 0) => ({ x: 8, y: 9, hp: 1000, maxHp: 1000, sp: 0, spMax: 0, flags, anim, vx: 0 });
const frames = (v, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };

describe('掠海漂移体 爬行模式 (FORMS)', () => {
  test('the crawl set exists in the skeleton the manifest lists', () => {
    const f = FORMS[SYUFO].crawl;
    const anims = assets.enemies[SYUFO].spine.animations;
    for (const name of [f.change, f.roles.idle, f.roles.die, f.roles.move.loop, f.roles.attack.loop]) assert.ok(name in anims, name);
    assert.equal(assets.enemies[SYUFO].spine.anims.idle, 'Idle_01', 'the manifest keeps the hover set as the default');
  });

  test('hovering: the hover clips; on the change: \'Change\' once, then the crawl clips (idle, move, attack, die)', async () => {
    const v = await syufo();
    v.sync(sample(), 1);
    assert.equal(clip(v), 'Idle_01');
    v.setForm('crawl');
    assert.equal(clip(v), 'Change', 'the transition first');
    frames(v, 50);                                   // Change is 0.667 s
    assert.equal(clip(v), 'Idle_02', 'crawling idle');
    v.sync(sample(0, ANIM.MOVE), 2);
    assert.equal(clip(v), 'Move_02');
    v.onAttack?.(null, 2.1);
    assert.equal(clip(v), 'Attack_02');
    v.die();
    assert.equal(clip(v), 'Die_02');
  });

  test('stunned when it drops (the usual case): the change plays out, then the stun holds, then it crawls', async () => {
    const v = await syufo();
    v.sync(sample(UF.STUNNED), 1);
    assert.equal(v.actor.mode, 'stun');
    v.setForm('crawl');
    assert.equal(clip(v), 'Change');
    frames(v, 10);
    v.sync(sample(UF.STUNNED), 1.2);                 // still stunned: the change is not cut short
    assert.equal(v.actor.mode, 'change');
    frames(v, 40);
    assert.equal(v.actor.mode, 'stun', 'then the stun holds (its pose frozen)');
    v.sync(sample(0), 3);
    assert.equal(clip(v), 'Idle_02', 'the stun over: crawling');
  });

  test('a view built after the change (culled, rejoined) starts on the crawl set without replaying \'Change\'', async () => {
    const v = await syufo({ form: 'crawl' });
    assert.equal(v.form, 'crawl');
    v.sync(sample(), 1);
    assert.equal(clip(v), 'Idle_02');
    const w = await syufo({ form: 'crawl' });
    w.die();
    assert.equal(clip(w), 'Die_02');
  });

  test('modes without a clip set change nothing; the same mode twice is a no-op', async () => {
    const v = await syufo();
    v.setForm('grounded');
    assert.equal(clip(v), 'Idle_01');
    v.setForm('crawl');
    frames(v, 50);
    v.setForm('crawl');
    assert.equal(clip(v), 'Idle_02', 'no second Change');
    const ctx = fakeViewCtx(fake.P, { assets: store('enemy_10045_parrot'), cam });
    const p = new UnitView(ctx, { id: 8, side: 'enemy', kind: 'enemy', defId: 'enemy_10045_parrot', spine: 'enemy_10045_parrot', tier: 1, x: 8, y: 9, maxHp: 1000 });
    await tick(); await tick();
    p.setForm('grounded');
    p.setForm('float');
    assert.equal(clip(p), 'Idle_A', '吉兆飞鳞 keeps its own clips (its 晕眩模式 is the Stun clip)');
  });
});

test('render/app.js hands the sim\'s fx \'phase\' to the view and keeps the mode on the unit info', () => {
  const src = readFileSync(path.join(ROOT, 'public/js/render/app.js'), 'utf8');
  assert.match(src, /e\[1\] === 'phase'[\s\S]{0,300}inf\.form = [\s\S]{0,200}setForm\?\.\(e\[4\]\.kind\)/);
});

// User report (2026-10-03): models bobbed up and down at targets on other rows — every attack pushed the whole body
// 0.12 tile towards the target (render/units.js lunge). The original never moves a model off its tile to attack: the
// swing is in the clip, so only the placeholder diamond (no model) still lunges.
test('an operator model stays on its tile when it attacks a target on another row (星熊)', async () => {
  const entry = assets.chars.char_136_hsguma.spine.front;
  const names = Object.keys(entry.animations || {});
  const ctx = fakeViewCtx(fake.P, { cam, assets: {
    picture: () => null, image: async () => null, spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: names.map((name) => ({ name })) }), release() {} },
  } });
  const v = new UnitView(ctx, { id: 3, side: 'ally', kind: 'op', defId: 'chess_char_4_17_a', spine: 'char_136_hsguma', tier: 1, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT' });
  await tick(); await tick();
  assert.ok(v.actor && v.spineReady, 'Spine model built');
  frames(v, 30);
  const rest = { x: v.root.position.x, y: v.root.position.y };
  v.onAttack({ x: 5.6, y: 9.2 }, 1);
  for (let i = 0; i < 12; i++) {
    v.update(1 / 60, cam(), 1 + i / 60);
    assert.ok(Math.abs(v.root.position.x - rest.x) < 1e-6 && Math.abs(v.root.position.y - rest.y) < 1e-6, `frame ${i}: no lunge`);
  }
});
