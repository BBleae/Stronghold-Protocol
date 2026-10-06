// Browser checks of the special-terrain tip (GitHub issue #184 「建议加入对于特殊地形的单击信息提示」) on the in-match mock
// harness (public/dev/game-mock.html):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/terrain-tip.e2e.test.js
//
// A tap on the GROUND — nothing stands there — makes the tile explain itself, on both field implementations: the engine
// canvas (render/app.js `tileClick`, reached by clicking the tile's own screen position) and the DOM fallback
// (ui/fallbackField.js, the tile div). Asserted: the mock's own stage (act2autochess_m01) carries gates, a tap on 蓝门 /
// 红门 opens the card with its mechanism line, a tap on an ordinary floor tile opens nothing (and closes the card that was
// open), and no scenario logs a console error. The words and the numbers are unit-tested in test/ui/gameLogic.test.js
// (terrainInfo, against every terrain of the real stages) — this file is about the tap reaching them.
// On a touch screen (this fork's merge of #185 with the phone support of fork PR #15, DESIGN §26.1) a FINGER explains
// the tile at its release, only when it stayed a tap: the press alone, a one-finger swipe and a pinch explain nothing —
// in prep (where the press stays drag-first) and in battle (where a finger picks a unit on release too).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiles of the mock's stage (act2autochess_m01) the tip must answer for, and one ordinary tile it must not. */
const GATE = { row: 9, col: 10, name: '红门' };
const GOAL = { row: 9, col: 2, name: '蓝门' };
const FLOOR = { row: 10, col: 5, name: null };

describe('special terrain tip in the browser', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  async function open(url, { w = 1600, h = 900, waitUntil = 'networkidle0', touch = false } = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    // the engine keeps fetching art (and SwiftShader is slow to build the board), so it waits on __SP_VIEW__ instead
    await page.goto(`${base}${url}`, { waitUntil, timeout: 60000 });
    return { page, problems };
  }

  /** The open detail card's text (null while none is open). */
  const card = (page) => page.evaluate(() => {
    const el = document.querySelector('.dpanel');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });

  /**
   * Fingers on a page with touch (CDP touch events, as a phone sends them): `down(list)` / `move(list)` take the [x, y] of
   * every finger down after the event (finger i keeps id i + 1), `up()` lifts them all.
   */
  async function fingers(page) {
    const cdp = await page.createCDPSession();
    const pts = (list) => list.map(([x, y], i) => ({ x: Math.round(x), y: Math.round(y), radiusX: 1, radiusY: 1, force: 1, id: i + 1 }));
    const send = (type, list) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts(list) });
    return {
      down: (list) => send('touchStart', list),
      move: (list) => send('touchMove', list),
      up: () => send('touchEnd', []),
      tap: async (x, y) => { await send('touchStart', [[x, y]]); await send('touchEnd', []); },
      detach: () => cdp.detach(),
    };
  }

  test('the fallback (DOM) board: a tap on 蓝门 / 红门 opens the card, an ordinary tile opens nothing', async () => {
    const { page, problems } = await open('/dev/game-mock.html?phase=PREP&render=fallback');
    await page.waitForSelector('.ff-tile', { timeout: 15000 });
    await sleep(400);
    const tap = (row, col) => page.evaluate(([r, c]) => {
      const el = document.querySelector(`.ff-tile[data-row="${r}"][data-col="${c}"]`);
      if (!el) return false;
      const b = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
      return true;
    }, [row, col]);

    assert.ok(await tap(GOAL.row, GOAL.col), 'the mock board draws the 蓝门 tile');
    await page.waitForSelector('.dpanel', { timeout: 5000 });
    let text = await card(page);
    assert.match(text, /蓝门/, text);
    assert.match(text, /目标生命值/, text);
    assert.match(text, /保护目标/, text);

    // the 红门 (the enemies' own entrance) says its own thing
    assert.ok(await tap(GATE.row, GATE.col));
    await sleep(200);
    text = await card(page);
    assert.match(text, /红门/, text);
    assert.match(text, /从这里出场/, text);

    // an ordinary floor tile: nothing to explain, and the card that was open closes with the press
    assert.ok(await tap(FLOOR.row, FLOOR.col));
    await sleep(200);
    assert.equal(await card(page), null, 'an ordinary tile opens nothing');
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('the engine canvas: the same tap on a tile\'s own screen position opens the card', async () => {
    const { page, problems } = await open('/dev/game-mock.html?phase=PREP&render=engine', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    await sleep(1200); // models / camera
    const at = (row, col) => page.evaluate(([r, c]) => {
      const t = globalThis.__SP_VIEW__.tileScreen(r, c);
      return t && { x: t.x, y: t.y };
    }, [row, col]);
    const pt = await at(GOAL.row, GOAL.col);
    assert.ok(pt, 'the 蓝门 tile has a screen position');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('.dpanel', { timeout: 5000 });
    let text = await card(page);
    assert.match(text, /蓝门/, text);
    assert.match(text, /目标生命值/, text);

    const floor = await at(FLOOR.row, FLOOR.col);
    await page.mouse.click(floor.x, floor.y);
    await sleep(250);
    assert.equal(await card(page), null, 'the floor tile closes it again');
    assert.deepEqual(problems, []);
    await page.close();
  });

  // This fork (review of its merge of #185): the picking grid is the whole 19×21 stage, the board on screen is not. Every
  // stage has a 传送入口 at (8,11), right of the temp row. The 3D board builds only this view's area (the own field, rows
  // 6–13 × cols 0–10, and the ring around it), so there a click lands on the empty background and must explain nothing
  // (render/app.js emitTileClick → tileDrawn); the 2D board draws the tile as its dim margin, and there it still explains
  // itself. A deployment without the local board art (no 3D board) runs the 2D half only.
  test('the engine canvas: only a tile the board draws explains itself — 传送入口 (8,11) beside the 3D island opens nothing', async (t) => {
    const TELE = { row: 8, col: 11 };
    /** The tile's screen position when it is inside the viewport and nothing covers the canvas there, else null. */
    const onCanvas = (page, { row, col }) => page.evaluate(([r, c]) => {
      const s = globalThis.__SP_VIEW__.tileScreen(r, c);
      if (!s || s.x < 0 || s.y < 0 || s.x >= innerWidth || s.y >= innerHeight) return null;
      return document.elementFromPoint(s.x, s.y)?.tagName === 'CANVAS' ? { x: s.x, y: s.y } : null;
    }, [row, col]);
    const board3dOn = (page) => page.evaluate(() => globalThis.__SP_VIEW__?.raw?.stats?.().board3d?.on === true);

    // the 2D board: the dim margin draws (8,11), so its card opens
    const d2 = await open('/dev/game-mock.html?phase=PREP&render=engine&board=2d', { waitUntil: 'domcontentloaded' });
    await d2.page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    await sleep(1200); // models / camera
    assert.equal(await board3dOn(d2.page), false, '?board=2d keeps the 2D board');
    const p2 = await onCanvas(d2.page, TELE);
    assert.ok(p2, '(8,11) is on the canvas at 1600×900');
    await d2.page.mouse.click(p2.x, p2.y);
    await d2.page.waitForSelector('.dpanel', { timeout: 5000 });
    assert.match(await card(d2.page), /传送入口/, 'the 2D board draws (8,11): its card opens');
    assert.deepEqual(d2.problems, []);
    await d2.page.close();

    // the 3D board: (8,11) is not built, a click there opens nothing — while a built special tile still does
    const d3 = await open('/dev/game-mock.html?phase=PREP&render=engine&board=3d', { waitUntil: 'domcontentloaded' });
    await d3.page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    try {
      await d3.page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.stats?.().board3d?.on === true, { timeout: 45000 });
    } catch {
      await d3.page.close();
      t.skip('no 3D board on this deployment (local board art or WebGL2 missing): the 2D half ran');
      return;
    }
    await sleep(1200); // the 3D board's first frames / camera
    const goal = await onCanvas(d3.page, GOAL);
    assert.ok(goal, 'the 蓝门 tile is on the canvas');
    await d3.page.mouse.click(goal.x, goal.y);
    await d3.page.waitForSelector('.dpanel', { timeout: 5000 });
    assert.match(await card(d3.page), /蓝门/, 'a tile the 3D board builds explains itself');
    const p3 = await onCanvas(d3.page, TELE);
    assert.ok(p3, '(8,11) is on the canvas at 1600×900');
    await d3.page.mouse.click(p3.x, p3.y);
    await sleep(300);
    assert.equal(await card(d3.page), null, 'the background beside the 3D island explains nothing (and the press closed the 蓝门 card)');
    assert.deepEqual(d3.problems, []);
    await d3.page.close();
  });

  test('Final Assault prep: the tap reports the BOARD tile, so the boss field explains ITS tile (review on #185)', async () => {
    const { page, problems } = await open('/dev/game-mock.html?phase=PREP&variant=boss&render=engine', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    await page.waitForFunction(() => globalThis.__SP_VIEW__.raw.prepField?.().kind === 'bossPrep', { timeout: 15000 });
    await sleep(1200); // camera / models (a deployment with the local board art also builds the 3D board here)
    // A board tile of the player's half + the stage tile it draws (stage 2–5 shown as board 9–12): the card must be about
    // the stage tile. Reporting the drawn tile instead (the old groundTile) made the screen convert a second time, which
    // on this board explains a DIFFERENT tile — or none at all.
    const target = await page.evaluate(async () => {
      const { data } = await import('/js/data.js');
      const gl = await import('/js/ui/gameLogic.js');
      const S = globalThis.__MOCK__.S();
      const stage = data.lookup('stages', S.pub.stageId);
      for (let row = 9; row <= 12; row++) {
        for (let col = 0; col <= 10; col++) {
          const [sr, sc] = gl.fieldTile('bossL', row, col);
          const info = gl.terrainInfo(stage, sr, sc);
          if (!info) continue;
          const t = globalThis.__SP_VIEW__.tileScreen(row, col);
          if (t) return { row, col, sr, sc, name: info.name, x: t.x, y: t.y };
        }
      }
      return null;
    });
    assert.ok(target, 'the boss field has a special tile on the player half');
    // The boss-prep camera is still settling when the board appears (and building the 3D board shifts a machine's timing),
    // so wait for the tile's screen position to stop moving, and re-read it before each try.
    const at = () => page.evaluate(([r, c]) => {
      const t = globalThis.__SP_VIEW__.tileScreen(r, c);
      return t && { x: t.x, y: t.y };
    }, [target.row, target.col]);
    let settled = null;
    for (let i = 0; i < 40; i++) {
      const p = await at();
      if (p && settled && Math.abs(p.x - settled.x) < 1 && Math.abs(p.y - settled.y) < 1) break;
      settled = p;
      await sleep(150);
    }
    assert.ok(settled, 'the boss-field tile still has a screen position');
    let text = null;
    for (let i = 0; i < 3 && text === null; i++) {
      const p = (await at()) || settled;
      await page.mouse.click(p.x, p.y);
      try { await page.waitForSelector('.dpanel', { timeout: 3000 }); } catch { continue; }   // a tap that missed: retry
      text = await card(page);
    }
    assert.ok(text !== null, 'the tap opened the terrain card');
    assert.match(text, new RegExp(target.name), `board (${target.row},${target.col}) → stage (${target.sr},${target.sc}) is ${target.name}, card: ${text}`);
    assert.deepEqual(problems, []);
    await page.close();
  });

  // This fork (merge of #185): the renderer keeps the boss-prep transform (`prepXf`) after the camera leaves the own
  // boss-field prep — the Final Assault battle that follows, or a teammate's boss field scouted from that prep, is a
  // BATTLE board that draws the stage's own rows. A tap there must explain the DRAWN stage tile (render/app.js
  // emitTileClick: groundTile in battle mode), not convert it as a prep board tile (which turns stage (1,3) 传送入口 into
  // board (8,3) — no card — and stage (5,10) 传送出口 into board (12,10) — a 红门).
  test('a boss battle after the boss-field prep: the tap explains the drawn stage tile', async () => {
    const { page, problems } = await open('/dev/game-mock.html?phase=PREP&variant=boss&render=engine', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    await page.waitForFunction(() => globalThis.__SP_VIEW__.raw.prepField?.().kind === 'bossPrep', { timeout: 15000 });
    await sleep(600);
    await page.evaluate(() => globalThis.__MOCK__.setPhase('FINAL_ASSAULT', ''));
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.mode === 'battle', { timeout: 15000 });
    // the state this guards: the battle view still holds the prep's boss-field transform
    assert.equal(await page.evaluate(() => globalThis.__SP_VIEW__.raw.prepField().kind), 'bossPrep');
    await sleep(1200); // the battle camera's flight
    // special stage tiles of the boss rect whose old (prep-converted) reading names something else or nothing; the
    // tiles the mock's units walk / stand on (rows 2, 3, 5) come last
    const targets = await page.evaluate(async () => {
      const { data } = await import('/js/data.js');
      const gl = await import('/js/ui/gameLogic.js');
      const { bossPrepField } = await import('/js/render/prepfield.js');
      const stage = data.lookup('stages', globalThis.__MOCK__.S().pub.stageId);
      const xf = bossPrepField(globalThis.__SP_VIEW__.raw.prepField().side === 'R' ? 'R' : 'L');
      const out = [];
      for (let row = 0; row <= 5; row++) {
        for (let col = 0; col <= 20; col++) {
          const info = gl.terrainInfo(stage, row, col);
          if (!info) continue;
          const b = xf.toBoard(row, col);
          const old = b ? gl.terrainInfo(stage, b.row, b.col)?.name || null : null;
          if (old === info.name) continue;
          out.push({ row, col, name: info.name, old });
        }
      }
      return out.sort((a, b) => ([2, 3, 5].includes(a.row) ? 1 : 0) - ([2, 3, 5].includes(b.row) ? 1 : 0));
    });
    assert.ok(targets.length, 'the boss rect has a special tile the prep transform would misread');
    let hit = null;
    const seen = [];
    for (const t of targets) {
      const p = await page.evaluate(([r, c]) => {
        const s = globalThis.__SP_VIEW__.tileScreen(r, c);
        if (!s || s.x < 0 || s.y < 0 || s.x >= innerWidth || s.y >= innerHeight) return null;
        return document.elementFromPoint(s.x, s.y)?.tagName === 'CANVAS' ? { x: s.x, y: s.y } : null;
      }, [t.row, t.col]);
      if (!p) continue;                                     // off screen, or under the HUD
      await page.mouse.click(p.x, p.y);
      await sleep(300);
      const text = await card(page);
      seen.push(`(${t.row},${t.col}) ${t.name}: ${text}`);
      if (t.old) assert.ok(!text || !text.includes(t.old) || text.includes(t.name), `stage (${t.row},${t.col}) read as the prep tile: ${text}`);
      if (text && text.includes(t.name) && text.includes('地形机制')) { hit = t; break; }
    }
    assert.ok(hit, `a tap on a special stage tile of the boss battle opened its card — ${seen.join(' | ')}`);
    assert.deepEqual(problems, []);
    await page.close();
  });

  // This fork's merge of #185 (terrain tap) with fork PR #15 (phone support: pinch zoom, a battle finger picks on
  // release): render/app.js `touchTap`. A finger never explains a tile on its press — the first finger of a pinch or a
  // swipe would open a card the player did not ask for — but at the release of a tap that stayed within TAP_SLOP_PX.
  test('a finger: the tile explains itself at the release of a tap — never on the press, after a swipe or for a pinch', async () => {
    const { page, problems } = await open('/dev/game-mock.html?phase=PREP&render=engine', { waitUntil: 'domcontentloaded', touch: true });
    await page.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen, { timeout: 30000 });
    await sleep(1200); // models / camera
    const f = await fingers(page);
    const at = (row, col) => page.evaluate(([r, c]) => {
      const t = globalThis.__SP_VIEW__.tileScreen(r, c);
      return t && { x: t.x, y: t.y, s: t.s, canvas: document.elementFromPoint(t.x, t.y)?.tagName === 'CANVAS' };
    }, [row, col]);
    const goal = await at(GOAL.row, GOAL.col);
    const floor = await at(FLOOR.row, FLOOR.col);
    assert.ok(goal?.canvas && floor?.canvas, 'the 蓝门 and the floor tile are on the canvas');

    // prep: the press alone explains nothing, the release of the tap opens the card
    await f.down([[goal.x, goal.y]]);
    await sleep(300);
    assert.equal(await card(page), null, 'a finger still down explains nothing yet');
    await f.up();
    await page.waitForSelector('.dpanel', { timeout: 5000 });
    assert.match(await card(page), /蓝门/);
    // the card opens over the tile; Esc closes it (a floor tap would not do: on a touch screen a finger on an empty tile
    // picks the unit drawn over it, render/pick.js pickBody)
    const close = async () => {
      await page.keyboard.press('Escape');
      await sleep(200);
      assert.equal(await card(page), null, 'Esc closes the card');
      assert.ok((await at(GOAL.row, GOAL.col)).canvas, 'nothing covers 蓝门 again');
    };
    await close();

    // a one-finger swipe that starts on 蓝门 is no tap
    await f.down([[goal.x, goal.y]]);
    for (let i = 1; i <= 6; i++) { await f.move([[goal.x, goal.y + i * 8]]); await sleep(16); }
    await f.up();
    await sleep(300);
    assert.equal(await card(page), null, 'a swipe explains nothing');

    // a pinch whose first finger is on 蓝门: it zooms the board and explains nothing
    await f.down([[goal.x, goal.y]]);
    await f.down([[goal.x, goal.y], [floor.x, floor.y]]);
    const dx = floor.x - goal.x, dy = floor.y - goal.y;
    for (let i = 1; i <= 8; i++) { await f.move([[goal.x, goal.y], [floor.x + dx * i * 0.08, floor.y + dy * i * 0.08]]); await sleep(16); }
    await f.up();
    await sleep(300);
    assert.equal(await card(page), null, 'a pinch explains nothing');
    const zoomed = await at(GOAL.row, GOAL.col);
    assert.ok(zoomed.s > goal.s * 1.2, `the pinch reached the view and zoomed it (px per tile ${goal.s} → ${zoomed.s})`);
    // zoomed in, a tap still explains the tile under the finger
    assert.ok(zoomed.canvas, '蓝门 is still on the canvas after the zoom');
    await f.tap(zoomed.x, zoomed.y);
    await page.waitForSelector('.dpanel', { timeout: 5000 });
    assert.match(await card(page), /蓝门/);
    await f.detach();
    assert.deepEqual(problems, []);
    await page.close();

    // battle: a finger picks at its release — a unit standing there, else the tile; the press alone opens nothing
    const b = await open('/dev/game-mock.html?phase=COMBAT&render=engine', { waitUntil: 'domcontentloaded', touch: true });
    await b.page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.mode === 'battle', { timeout: 30000 });
    await sleep(1200); // the battle camera's flight
    const bf = await fingers(b.page);
    const specials = await b.page.evaluate(async () => {
      const { data } = await import('/js/data.js');
      const gl = await import('/js/ui/gameLogic.js');
      const stage = data.lookup('stages', globalThis.__MOCK__.S().pub.stageId);
      const out = [];
      for (let row = 0; row <= 20; row++) for (let col = 0; col <= 20; col++) {
        const info = gl.terrainInfo(stage, row, col);
        if (info) out.push({ row, col, name: info.name });
      }
      return out;
    });
    assert.ok(specials.length, 'the mock stage has special tiles');
    let hit = null;
    const seen = [];
    for (const t of specials) {
      const p = await b.page.evaluate(([r, c]) => {
        const s = globalThis.__SP_VIEW__.tileScreen(r, c);
        if (!s || s.x < 0 || s.y < 0 || s.x >= innerWidth || s.y >= innerHeight) return null;
        return document.elementFromPoint(s.x, s.y)?.tagName === 'CANVAS' ? { x: s.x, y: s.y } : null;
      }, [t.row, t.col]);
      if (!p) continue;                                     // off screen, or under the HUD
      await bf.down([[p.x, p.y]]);
      await sleep(200);
      assert.equal(await card(b.page), null, `battle (${t.row},${t.col}): a finger still down opens nothing`);
      await bf.up();
      await sleep(300);
      const text = await card(b.page);
      seen.push(`(${t.row},${t.col}) ${t.name}: ${text}`);
      if (text && text.includes(t.name) && text.includes('地形机制')) { hit = t; break; }
      if (text) { await b.page.keyboard.press('Escape'); await sleep(200); }   // a unit stood there: its card goes
    }
    assert.ok(hit, `a finger's tap on a special tile of the battle opened its card — ${seen.join(' | ')}`);
    await bf.detach();
    assert.deepEqual(b.problems, []);
    await b.page.close();
  });
});
