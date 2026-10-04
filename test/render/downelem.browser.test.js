// test/render/downelem.browser.test.js — user playtest #4 items 8 and 9 in headless Chrome through the render demo
// (public/dev/render-demo.html, real Spine models): frames fed to the field view like the client runner does (local
// feed) with b.snap `down` / `elem` — a knocked-out operator stays on its tile in its held Die pose under a redeploy
// ring counting down, then "DP", then comes back with its deploy clip (a press on its tile selects it meanwhile);
// operators and enemies show the official element gauge under their bars (icon + white bar, user playtest #6), refilling
// over a 爆发冷却; a summon and an enemy that die still vanish.
//
// Opt-in (starts Chrome): RENDER_E2E=1 node --test test/render/downelem.browser.test.js
// Chrome path: $CHROME_PATH or the macOS default. Screenshots → test/e2e/out/downelem-*.png.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.RENDER_E2E === '1' && existsSync(CHROME) && existsSync(path.join(ROOT, 'public/assets'));
const skip = enabled ? false : 'set RENDER_E2E=1 (needs Chrome and downloaded assets)';

/**
 * The field view draws the battle LOOK_AHEAD (1 game s, render/app.js) behind the frames it is fed, so right after a push
 * what is drawn is older than the feed: wait until the render clock has reached the newest frame before reading it. This
 * relies on interp.update playing the buffered frames out to the newest once the feed stops (pinned in interp.test.js).
 */
const settled = (page) => page.waitForFunction(() => { const i = window.__demo.view.debug.interp; return i.renderT >= i.newestT; }, { polling: 'raf', timeout: 10000 });

/** Page side: a small field fed frame by frame (local feed) — `step(gt, units, extra, ev)` pushes one frame. */
function installFeed() {
  const v = window.__demo.view;
  const U = (id, side, spine, x, y, extra = {}) => ({ id, kind: side === 'enemy' ? 'enemy' : 'op', side, defId: spine, spine, avatar: spine, x, y, maxHp: 1000, facing: 1, dir: side === 'enemy' ? undefined : 'RIGHT', tier: 3, ...extra });
  const units = [
    U(1, 'ally', 'char_102_texas', 5, 10), U(2, 'ally', 'char_1016_agoat2', 3, 11), U(3, 'ally', 'token_10028_vigil_wolf', 4, 12, { kind: 'token' }),
    U(4, 'enemy', 'enemy_1000_gopro_2', 8, 10), U(5, 'enemy', 'enemy_1000_gopro_2', 9, 11),
  ];
  v.enterBattle({ fieldId: 'dn', kind: 'normal', rect: { r0: 9, r1: 12, c0: 0, c1: 10 }, stageId: 'act2autochess_m01', units });
  v.setCamera('normal', { rect: { r0: 9, r1: 12, c0: 0, c1: 10 }, side: 'L', instant: true });
  v.setLocalFeed({ on: true, speed: 2 });
  const tup = (u, hp = 1000, anim = 0) => [u.id, u.x, u.y, hp, 1000, 0, 0, 0, anim];
  window.__feed = {
    units,
    step(gt, list, extra = {}, ev = null) {
      if (ev && ev.length) v.pushEvents({ t: 'b.ev', fieldId: 'dn', gt, ev });
      v.pushSnapshot({ t: 'b.snap', fieldId: 'dn', gt, units: list.map((x) => (Array.isArray(x) ? x : tup(x))), dp: 5, killed: 0, total: 5, ...extra });
    },
    tup,
    state() {
      const out = {};
      for (const [id, x] of v.debug.views) {
        out[id] = { alive: x.alive, down: x.down ? x.down.state : null, ring: !!x._downRing?.root?.visible, label: x._downRing?.text?.text ?? null,
          el: x._elBar?.root?.visible ? x.el : null, spine: !!x.spineReady, dieClip: x.actor?.current ?? null, alpha: +(x.alpha ?? 0).toFixed(2) };
      }
      return out;
    },
  };
}

describe('knocked-out operators and element gauges in headless Chrome', { skip }, () => {
  let srv, browser;
  before(async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test('down ring countdown → DP → redeploy; element icons; summons and enemies still vanish', async () => {
    const page = await browser.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    try {
      await page.setViewport({ width: 1280, height: 720 });
      // a recording scene, paused: it feeds nothing, the test drives the view
      await page.goto(`http://127.0.0.1:${srv.port}/dev/render-demo.html?scene=normal-m01&paused=1&panel=0`);
      await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 30000 });
      await page.evaluate(installFeed);
      // phase 1 (gt 1–3): everyone stands; texas2's neighbour 艾雅法拉 carries a burn gauge, an enemy is in a neural cooldown
      const run = (fn, from, to) => page.evaluate(async (src, from, to) => {
        const f = window.__feed;
        const body = new Function('f', 'gt', src);
        for (let gt = from; gt <= to + 1e-9; gt += 1 / 30) { body(f, +gt.toFixed(4)); await new Promise((r) => requestAnimationFrame(() => r())); }
      }, fn, from, to);
      await run(`const U = f.units; f.step(gt, [U[0], U[1], U[2], U[3], U[4]], { elem: [[2, 'burn', 0.4, 0, 0], [4, 'neural', 1, 12, 10]] });`, 1, 3);
      await new Promise((r) => setTimeout(r, 1500)); // Spine models load
      await run(`const U = f.units; f.step(gt, [U[0], U[1], U[2], U[3], U[4]], { elem: [[2, 'burn', 0.4, 0, 0], [4, 'neural', 1, 12, 10]] });`, 3, 4);
      await settled(page);
      let st = await page.evaluate(() => window.__feed.state());
      assert.equal(st[2].el, 'burn', 'operator element gauge');
      assert.equal(st[4].el, 'neural', 'enemy element gauge (cooldown)');
      assert.equal(st[1].el, null);
      // phase 2: texas (1) is knocked out, the wolf summon (3) and an enemy (5) die
      await page.evaluate(() => {
        const f = window.__feed, U = f.units;
        f.step(4.05, [f.tup(U[0], 0, 4), U[1], f.tup(U[2], 0, 4), U[3], f.tup(U[4], 0, 4)], { down: [[1, 24.05, 20, 0]] }, [['die', 1, 'killed'], ['die', 3, 'killed'], ['die', 5, 'killed']]);
      });
      await run(`const U = f.units; f.step(gt, [U[1], U[3]], { down: [[1, 24.05, 20, 0]], elem: [[2, 'burn', 0.4, 0, 0]] });`, 4.1, 8);
      await new Promise((r) => setTimeout(r, 1200)); // die clips and fades run out (the last frame stays)
      await run(`const U = f.units; f.step(gt, [U[1], U[3]], { down: [[1, 24.05, 20, 0]], elem: [[2, 'burn', 0.4, 0, 0]] });`, 8, 9);
      await settled(page);
      st = await page.evaluate(() => window.__feed.state());
      await page.screenshot({ path: path.join(OUT, 'downelem-countdown.png') });
      assert.equal(st[1].alive, false);
      assert.equal(st[1].down, 0, 'knocked down');
      assert.ok(st[1].ring, 'redeploy ring');
      assert.equal(st[1].label, '16', 'seconds left');
      assert.equal(st[1].dieClip, 'Die', 'held Die pose');
      assert.ok(st[1].alpha > 0.8, `the model is drawn (${st[1].alpha})`);
      assert.equal(st[3], undefined, 'the summon vanished');
      assert.equal(st[5], undefined, 'the enemy vanished');
      // a press on its tile selects it like any unit on a tile (picking by tile, user playtest #4 item 1)
      const picked = await page.evaluate(() => {
        const v = window.__demo.view, t = v.tileScreen(10, 5), r = v.debug.app.view.getBoundingClientRect();
        return v.debug.pick.battleUnitAt(t.x - r.left, t.y - r.top)?.id ?? null;
      });
      assert.equal(picked, 1, 'the knocked-down operator is picked on its tile');
      // phase 3: the timer is done but the DP is short
      await run(`const U = f.units; f.step(gt, [U[1], U[3]], { down: [[1, 24.05, 20, 1]] });`, 24.1, 25);
      await settled(page);
      st = await page.evaluate(() => window.__feed.state());
      await page.screenshot({ path: path.join(OUT, 'downelem-waitdp.png') });
      assert.equal(st[1].label, 'DP');
      // phase 4: redeploy
      await page.evaluate(() => { const f = window.__feed, U = f.units; f.step(25.05, [f.tup(U[0], 1000, 6), U[1], U[3]], {}, [['deploy', 1]]); });
      await run(`const U = f.units; f.step(gt, [U[0], U[1], U[3]]);`, 25.1, 26);
      await settled(page);
      st = await page.evaluate(() => window.__feed.state());
      await page.screenshot({ path: path.join(OUT, 'downelem-redeployed.png') });
      assert.equal(st[1].alive, true, 'back on its tile');
      assert.equal(st[1].down, null);
      assert.equal(st[1].ring, false);
      assert.equal(st[2].el, null, 'the gauge left the snapshot: row hidden');
      // solo pause (view.setPaused): the picture stands still with the sim — render clock, effects, model animation —
      // frames fed meanwhile are held and play after the resume
      const clocks = () => page.evaluate(() => { const v = window.__demo.view; return { renderT: v.debug.interp.renderT, fx: v.debug.fx.time, actor: v.debug.views.get(1)?.actor?.clock ?? null, paused: v.debug.paused }; });
      await page.evaluate(() => window.__demo.view.setPaused(true));
      const frozen = await clocks();
      assert.equal(frozen.paused, true);
      assert.ok(frozen.actor != null, 'the model is loaded');
      await run(`const U = f.units; f.step(gt, [U[0], U[1], U[3]]);`, 26.1, 27);
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(await clocks(), frozen, 'paused: the render clock, the effects and the model animation stand still');
      await page.evaluate(() => window.__demo.view.setPaused(false));
      await settled(page);
      assert.ok((await clocks()).renderT > frozen.renderT + 0.5, 'resumed: the frames held meanwhile play');
      // review of the review fixes: (a) a field entered while the picture is paused (a replay round picked while paused)
      // shows its units at once — a fade-in needs the frozen clock; (b) the hand-over events of a field entered
      // mid-battle come before the first frame builds the views: a unit the field meta announced still takes them
      const enter = (fieldId, paused, ev) => page.evaluate((fieldId, paused, ev) => {
        const v = window.__demo.view;
        v.setPaused(paused);
        const u = { id: 21, kind: 'op', side: 'ally', defId: 'char_102_texas', spine: 'char_102_texas', avatar: 'char_102_texas', x: 5, y: 10, maxHp: 1000, facing: 1, dir: 'RIGHT', tier: 3 };
        v.enterBattle({ fieldId, kind: 'normal', rect: { r0: 9, r1: 12, c0: 0, c1: 10 }, stageId: 'act2autochess_m01', units: [u] });
        if (ev) v.pushEvents({ t: 'b.ev', fieldId, gt: 40, ev });
        for (const gt of [40, 40 + 1 / 30]) v.pushSnapshot({ t: 'b.snap', fieldId, gt, units: [[21, 5, 10, 1000, 1000, 0, 0, 0, 0]], dp: 5, killed: 0, total: 1 });
      }, fieldId, paused, ev);
      const unit21 = () => page.evaluate(() => { const v = window.__demo.view, x = v.debug.views.get(21); return x ? { fadeIn: x.fadeIn, statuses: [...x.statuses], wanted: v.debug.fx.sustains.has('wanted:21') } : null; });
      await enter('dn2', true, null);
      await page.waitForFunction(() => !!window.__demo.view.debug.views.get(21)?._seen, { polling: 'raf', timeout: 10000 });
      assert.equal((await unit21()).fadeIn, 1, 'entered while paused: shown at once');
      await enter('dn3', false, [['status', 21, 'lemuen:wanted', 1, 'late']]);
      await settled(page);
      await page.waitForFunction(() => window.__demo.view.debug.interp.renderT >= 40, { polling: 'raf', timeout: 10000 });
      const u21 = await unit21();
      assert.deepEqual(u21.statuses, ['lemuen:wanted'], 'the handed-over status reached the unit announced by the meta');
      assert.equal(u21.wanted, true, 'and made its lasting look');
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
});
