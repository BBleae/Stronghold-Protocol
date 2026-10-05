// 联防 with several fields in the browser (more than 4 alive, a remake extension — owner decision 3): the in-match mock
// with `players=8&phase=UNITE` (public/dev/game-mock.html: two 联防 fields 'u' [灰烬's AI, Doctor·B] and 'u2' [P5, AI 6],
// m.public.unite.fields) in headless Chrome (puppeteer-core + system Chrome). Opt-in: SP_E2E=1.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/unite-fields.e2e.test.js
//
// At the smallest supported phone (640×360), an iPhone 14 (844×390) and 1920×1080:
//   * server-run combat (the mock's own mode): the legacy ‹ › switcher names the fields 联防阵地 1 / 2 and cycles them;
//   * client-side combat (m.public.combatMode 'client'), the viewer a leaker of 'u': ‹ 联防阵地 N › sits above the bottom
//     pills, on screen, clear of the team panel and the corner buttons, its arrows tappable; → 联防阵地 2 (g.watch 'u2',
//     the observing pill with 返回战场); back to 联防阵地 1 (its own field: g.watch 'u', no observing pill); a leaker of
//     the other field's row → 前往查看 → that field; the page never overflows;
//   * a helper whose own field runs gets no field switcher; the 4-player 联防 (one field) shows none either.
// Unit counterparts: test/ui/unite-fields.test.js. Screenshots: test/e2e/out/unite-*.png.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** name → [width, height, touch] */
const VIEWPORTS = { 'phone-min': [640, 360, true], iphone14: [844, 390, true], desktop: [1920, 1080, false] };

describe('联防 with several fields (mock harness, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  async function open(vp, query) {
    const [w, h, touch] = VIEWPORTS[vp];
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch, isLandscape: true });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=fallback&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(800);
    // every g.watch the screen sends (the mock answers it and moves the field on screen)
    await page.evaluate(async () => {
      const { net } = await import('/js/net.js'); // the module instance the mock answers through (net.request)
      globalThis.__watches = [];
      const f = net.request;
      net.request = (t, fields) => { if (t === 'g.watch') globalThis.__watches.push(fields?.fieldId); return f(t, fields); };
    });
    return { page, problems };
  }

  /** Server-run → client-side combat (m.public.combatMode 'client'): the client HUD. */
  const clientCombat = (page) => page.evaluate(() => {
    globalThis.__MOCK__.mutate((S) => { S.pub.combatMode = 'client'; });
    globalThis.__MOCK__.pushPublic();
  });

  /** The field switcher(s) on screen: label, box, arrows hit, overlaps with the team panel / corner buttons. */
  const switchFacts = (page, sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const box = (b) => [b.left, b.top, b.right, b.bottom];
    const over = (a, b) => a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5;
    const team = [...document.querySelectorAll('.team__row')].map((x) => box(x.getBoundingClientRect()));
    const corner = [...document.querySelectorAll('.gm__corner > *')].map((x) => x.getBoundingClientRect()).filter((b) => b.width > 1).map(box);
    const arrows = [...el.querySelectorAll('.vswitch__arrow')].map((a) => {
      const b = a.getBoundingClientRect();
      const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!t && a.contains(t);
    });
    return {
      label: el.querySelector('.vswitch__label')?.textContent.trim(), box: box(r),
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      overTeam: team.some((b) => over(box(r), b)), overCorner: corner.some((b) => over(box(r), b)), arrows,
    };
  }, sel);

  const clickArrow = async (page, sel, i) => {
    const arrows = await page.$$(`${sel} .vswitch__arrow`);
    await arrows[i].click();
    await sleep(500);
  };

  for (const vp of Object.keys(VIEWPORTS)) {
    test(`${vp}: server-run — the legacy switcher names and cycles 联防阵地 1 / 2`, { timeout: 120000 }, async () => {
      const { page, problems } = await open(vp, 'players=8&phase=UNITE&variant=leaker');
      const sw = await switchFacts(page, '.chud .vswitch');
      assert.equal(sw.label, '联防阵地 1', 'the leaker is shown the field holding its enemies');
      await clickArrow(page, '.chud .vswitch', 1);
      assert.equal((await switchFacts(page, '.chud .vswitch')).label, '联防阵地 2');
      assert.deepEqual(await page.evaluate(() => globalThis.__watches), ['u2']);
      assert.deepEqual(problems, []);
      await page.close();
    });

    test(`${vp}: client-side combat — ‹ 联防阵地 N › for a leaker: on screen, clear of the panels; switches and comes back`, { timeout: 120000 }, async () => {
      const { page, problems } = await open(vp, 'players=8&phase=UNITE&variant=leaker');
      await clientCombat(page);
      await sleep(400);
      const sw = await switchFacts(page, '.chud__fields');
      assert.ok(sw, 'the field switcher is offered');
      assert.equal(sw.label, '联防阵地 1');
      assert.ok(sw.inside, `${vp}: on screen ${sw.box.map(Math.round)}`);
      assert.equal(sw.overTeam, false, `${vp}: clear of the team panel`);
      assert.equal(sw.overCorner, false, `${vp}: clear of the corner buttons`);
      assert.deepEqual(sw.arrows, [true, true], 'both arrows tappable');
      await page.screenshot({ path: path.join(OUT, `unite-${vp}-switch.png`) });
      // → the other field: watched (the observing pill with 返回战场)
      await clickArrow(page, '.chud__fields', 1);
      assert.equal((await switchFacts(page, '.chud__fields')).label, '联防阵地 2');
      assert.ok(await page.$('.chud__observe .chud__back'), 'observing another field: 返回战场');
      // ← the own field again: like 返回战场 (no observing pill)
      await clickArrow(page, '.chud__fields', 0);
      assert.equal((await switchFacts(page, '.chud__fields')).label, '联防阵地 1');
      assert.equal(await page.$('.chud__observe'), null);
      assert.deepEqual(await page.evaluate(() => globalThis.__watches), ['u2', 'u']);
      // a leaker of the other field: its row → 前往查看 → that field
      const rows = await page.$$('.team__row .team__btn');
      await rows[3].click(); // P4 — a leaker whose enemies fight on u2
      await page.waitForSelector('.team__ob', { timeout: 3000 });
      await page.click('.team__ob');
      await sleep(500);
      assert.equal((await switchFacts(page, '.chud__fields')).label, '联防阵地 2');
      assert.deepEqual(await page.evaluate(() => globalThis.__watches), ['u2', 'u', 'u2']);
      const layout = await page.evaluate(() => {
        const se = document.scrollingElement || document.documentElement;
        return { w: se.scrollWidth - innerWidth, h: se.scrollHeight - innerHeight };
      });
      assert.ok(layout.w <= 1 && layout.h <= 1, `${vp}: no page overflow ${JSON.stringify(layout)}`);
      assert.deepEqual(problems, []);
      await page.close();
    });

    test(`${vp}: no field switcher for a helper whose field runs, nor in the 4-player 联防`, { timeout: 120000 }, async () => {
      for (const q of ['players=8&phase=UNITE', 'phase=UNITE&variant=leaker', 'phase=UNITE']) {
        const { page, problems } = await open(vp, q);
        await clientCombat(page);
        await sleep(400);
        assert.equal(await page.$('.chud__fields'), null, q);
        assert.deepEqual(problems, [], q);
        await page.close();
      }
    });
  }
});
