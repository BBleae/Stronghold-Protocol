// test/render/fxsustain.test.js — skill-long effects (render/fx.js SUSTAINED). User report: 余's S3 灶里乾坤 fire wall
// showed for ~2 s of a 41 s skill; the official wall burns for the whole skill on the tile edge in front of him, across
// the field. The sim emits fx 'firewall' once at the skill's start (server/sim/content/kits/tier6.js); the renderer holds
// it until the caster's skill ends ('skill' off → fx.skill(view, false)), it dies, or the view clears. Same for the
// skill-long fields (tide, healField, coldWind, snow) centred on their caster.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, FX;
before(async () => {
  fake = installFakePixi();
  FX = await import('../../public/js/render/fx.js');
});
after(() => fake.restore());

const DT = 1 / 60;
const cam = presetCamera('normal', { width: 1600, height: 900 });
const unit = (id, x, y, o = {}) => ({ id, x, y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, statuses: new Set(['skill']), info: { defId: 'x' }, onHit() {}, ...o });

function makeFx(views) {
  const P = fake.P;
  const ctx = fakeViewCtx(P);
  const map = new Map(views.map((v) => [v.id, v]));
  const fx = new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true },
    timeScale: () => 2, loadLevel: () => 0, subProfOf: () => null, view: (id) => map.get(id) || null,
    screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120, fieldRect: () => ({ r0: 9, r1: 12, c0: 2, c1: 10 }),
  });
  return fx;
}
const run = (fx, seconds) => { for (let t = 0; t < seconds - 1e-9; t += DT) fx.update(DT); };

describe('余 S3 灶里乾坤: the fire wall burns for the whole skill', () => {
  test('the line: 0.5 tile in front of him, across the field, perpendicular to his direction', () => {
    assert.deepEqual(FX.wallLine(5, 10, 'col', 'RIGHT'), { axis: 'col', at: 5.5, fixed: 5 });
    assert.deepEqual(FX.wallLine(5, 10, 'col', 'LEFT'), { axis: 'col', at: 4.5, fixed: 5 });
    assert.deepEqual(FX.wallLine(5, 10, 'row', 'UP'), { axis: 'row', at: 10.5, fixed: 10 });
  });

  test('held while the skill runs (well past the old 2 s flash), gone after skill off', () => {
    const yu = unit(7, 5, 10, { dir: 'RIGHT' });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    const S = fx.sustains.get('firewall:7');
    assert.ok(S, 'registered');
    assert.deepEqual(S.span, [9, 12], 'across the field rows');
    run(fx, 15);
    assert.ok(fx.sustains.has('firewall:7') && S.a === 1, '15 s later still burning at full strength');
    assert.ok(fx.counts.particles > 0, 'flames rise along it');
    fx.skill(yu, false);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0, 'skill off: faded out');
  });

  test('ends when the caster dies or the view clears; a re-cast refreshes the same wall', () => {
    const yu = unit(7, 5, 10, { dir: 'RIGHT' });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    assert.equal(fx.sustains.size, 1);
    fx.death(yu);
    run(fx, 0.6);
    assert.equal(fx.sustains.size, 0);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    fx.clear();
    assert.equal(fx.sustains.size, 0);
  });

  test('no skill running (a talent / a stray event): only the one-shot look', () => {
    const yu = unit(7, 5, 10, { statuses: new Set() });
    const fx = makeFx([yu]);
    fx.simFx('firewall', 5, 10, { x: 5, y: 10, id: 7, dir: 'RIGHT', axis: 'col' });
    assert.equal(fx.sustains.size, 0);
  });
});

describe('skill-long fields', () => {
  test('浊心斯卡蒂 tide / 白面鸮 healField / 灵知 coldWind / 银灰 snow on the caster last until its skill ends', () => {
    for (const kind of ['tide', 'healField', 'coldWind', 'snow']) {
      const op = unit(3, 6, 10);
      const fx = makeFx([op]);
      fx.simFx(kind, 6, 10, { x: 6, y: 10, id: 3 });
      run(fx, 10);
      const S = fx.sustains.get(`${kind}:3`);
      assert.ok(S && S.disc.alpha > 0.1, `${kind}: shown 10 s later`);
      fx.skill(op, false);
      run(fx, 0.6);
      assert.equal(fx.sustains.size, 0, `${kind}: gone after skill off`);
    }
  });

  test('a field event away from the caster (a heal on a target) is not held', () => {
    const op = unit(3, 6, 10);
    const fx = makeFx([op]);
    fx.simFx('healField', 9, 11, { x: 9, y: 11, id: 3 });
    assert.equal(fx.sustains.size, 0);
  });
});
