// Rooms of 5–8 players (a remake extension; the official room has 4 seats) in the browser: the in-match mock with
// `players=8` / `players=5` (public/dev/game-mock.html — P5–P8, boss pairs b1..b4, two unite fields, 8-entry draft and
// 机变 orders, a 10-card 机变 draft) in headless Chrome (puppeteer-core + system Chrome). Opt-in: SP_E2E=1.
//
//   SP_E2E=1 node --test test/ui/eight-players.e2e.test.js
//
// At the smallest supported phone (640×360), an iPhone 14 (844×390) and 1920×1080:
//   * every screen of the match fits — no page overflow, every visible control inside the viewport (devices.e2e's check);
//   * the team panel has 8 compact rows that end above the corner buttons (交流 / ⚙ / 📖 / ⛶), and each row's centre
//     hits its own row (the touch areas of compact rows never cover the next one);
//   * the strategy draft's 8 dense rows leave 查看禁用盟约与干员 and the tip on screen;
//   * the 机变 draft shows its 10 cards in a 5 × 2 grid, each card fully on screen without overlapping another, at the
//     official text size (≥ 7.5 px on phones, .19rem on desktop); a text longer than its card scrolls inside it (touch
//     swipe / mouse wheel) without arming the card; the dense pick order stays inside the overlay; a two-tap pick of
//     the 10th card sends g.choice { idx: 9 };
//   * the briefing's 8 ready pips and the result's 8 cards;
//   * the real room screen (title → lobby → create against the real server, 7 guests joining over WebSocket): with 8
//     humans seated the host's difficulty labels stay on one line and both pickers end before the ready row (its 8
//     icons are smaller above 4 humans);
// a 5-player room: 7 cards in a 4 × 2 grid, the Final Assault's lone 5th player on b3; and the default 4-player mock
// keeps the official layouts (none of the compact / dense / wide classes). Screenshots: test/e2e/out/p8-*.png.

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

describe('rooms of 5–8 players (mock harness, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
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
    await sleep(1200);
    return { page, problems, touch };
  }

  /** No scrollbars, every visible control inside the viewport (test/ui/devices.e2e.test.js layoutProblems). */
  const layoutProblems = (page) => page.evaluate(() => {
    const out = [];
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollWidth > innerWidth + 1) out.push(`page overflows horizontally (${se.scrollWidth} > ${innerWidth})`);
    if (se.scrollHeight > innerHeight + 1) out.push(`page overflows vertically (${se.scrollHeight} > ${innerHeight})`);
    for (const el of document.body.querySelectorAll('button, input, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      let hidden = false;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) { hidden = true; break; }
      }
      if (hidden || el.closest('.mockbar')) continue;
      let scroller = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) { scroller = true; break; }
      }
      if (scroller) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
        out.push(`clipped: ${el.className || el.tagName} ${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12)} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
      }
    }
    return out;
  });

  /** The team panel: compact?, its rows, whether each row's button centre hits that row, the corner buttons' top. */
  const teamFacts = (page) => page.evaluate(() => {
    const panel = document.querySelector('.team');
    const rows = [...document.querySelectorAll('.team__row')];
    const corner = [...document.querySelectorAll('.gm__corner > *')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 1);
    return {
      compact: !!panel?.classList.contains('team--compact'),
      rows: rows.length,
      bottom: Math.max(...rows.map((r) => r.getBoundingClientRect().bottom)),
      cornerTop: Math.min(...corner.map((r) => r.top)),
      misses: rows.map((row, i) => {
        const b = row.querySelector('.team__btn').getBoundingClientRect();
        const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return t && t.closest('.team__row') === row ? null : `P${i + 1} → ${t?.closest('.team__row') ? 'another row' : t?.className}`;
      }).filter(Boolean),
      outside: rows.filter((r) => { const b = r.getBoundingClientRect(); return b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight; }).length,
    };
  });

  /** The 机变 overlay: grid class / columns, each card's box, text and name metrics, the order strip. */
  const spFacts = (page) => page.evaluate(() => {
    const grid = document.querySelector('.spov__grid');
    const g = grid.getBoundingClientRect();
    const inner = document.querySelector('.spov__inner').getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const cards = [...document.querySelectorAll('.spcard')].map((c) => {
      const r = c.getBoundingClientRect();
      const d = c.querySelector('.spcard__desc');
      const n = c.querySelector('.spcard__name').getBoundingClientRect();
      const ic = c.querySelector('.spcard__icon').getBoundingClientRect();
      const cs = getComputedStyle(d);
      return {
        box: [r.left, r.top, r.right, r.bottom], font: parseFloat(cs.fontSize), overflowY: cs.overflowY,
        over: d.scrollHeight - d.clientHeight, descTop: d.getBoundingClientRect().top - r.top,
        nameIn: n.left >= r.left - 0.5 && n.right <= r.right + 0.5 && n.bottom <= r.bottom + 0.5,
        iconIn: ic.left >= r.left - 0.5 && ic.right <= r.right + 0.5 && ic.bottom <= r.bottom + 0.5,
      };
    });
    const who = [...document.querySelectorAll('.spov__who')].map((el) => el.getBoundingClientRect());
    return {
      cls: grid.className, cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length, grid: [g.left, g.top, g.right, g.bottom],
      rem, cards, dense: !!document.querySelector('.spov__order--dense'), who: who.length,
      whoOut: who.filter((r) => r.left < inner.left - 0.5 || r.right > inner.right + 0.5 || r.bottom > g.top + 0.5).length,
    };
  });

  const overlap = (a, b) => a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5;

  /** A touch swipe (CDP touch events) of dy px from (x, y). */
  async function swipe(page, x, y, dy) {
    const cdp = await page.createCDPSession();
    const pt = (yy) => [{ x: Math.round(x), y: Math.round(yy), radiusX: 1, radiusY: 1, force: 1, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + (dy * i) / 12) });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  for (const vp of Object.keys(VIEWPORTS)) {
    test(`${vp}: 8 players — every in-match screen fits; compact team panel above the corner; dense draft order`, { timeout: 5 * 60 * 1000 }, async () => {
      for (const [name, q] of [['prep', 'phase=PREP'], ['combat', 'phase=COMBAT&variant=done'], ['unite', 'phase=UNITE&variant=leaker'],
        ['final', 'phase=FINAL_ASSAULT'], ['draft', 'phase=BAND_DRAFT'], ['briefing', 'phase=INFO_CHECK'], ['result', 'phase=RESULT']]) {
        const { page, problems } = await open(vp, `players=8&${q}`);
        await page.screenshot({ path: path.join(OUT, `p8-${vp}-${name}.png`) });
        assert.deepEqual(await layoutProblems(page), [], `${vp} ${name}`);
        if (['prep', 'combat', 'unite', 'final'].includes(name)) {
          const t = await teamFacts(page);
          assert.equal(t.compact, true, `${vp} ${name}: compact rows`);
          assert.equal(t.rows, 8);
          assert.equal(t.outside, 0, `${vp} ${name}: every row on screen`);
          assert.ok(t.bottom <= t.cornerTop - 1, `${vp} ${name}: the last row (bottom ${t.bottom.toFixed(1)}) ends above the corner buttons (${t.cornerTop.toFixed(1)})`);
          assert.deepEqual(t.misses, [], `${vp} ${name}: each row's centre hits its own row`);
        }
        if (name === 'final') {
          const fields = await page.evaluate(() => globalThis.__MOCK__.S().pub.fields.map((f) => `${f.fieldId}:${f.players.join('+')}`));
          assert.deepEqual(fields, ['b1:p1+ai_2', 'b2:p3+p4', 'b3:p5+ai_6', 'b4:p7+ai_8'], 'the seat pairs b1..b4');
        }
        if (name === 'draft') {
          const d = await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="match-info-open"]');
            const b = btn.getBoundingClientRect();
            const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            const tip = document.querySelector('[data-testid="draft-tip"]').getBoundingClientRect();
            return { dense: !!document.querySelector('.draft-order--dense'), rows: document.querySelectorAll('.dorder').length,
              btnIn: b.top >= 0 && b.bottom <= innerHeight, btnHit: !!t && btn.contains(t), tipBottom: tip.bottom, tipTop: tip.top };
          });
          assert.equal(d.dense, true);
          assert.equal(d.rows, 8);
          assert.ok(d.btnIn && d.btnHit, `${vp}: 查看禁用盟约与干员 on screen and tappable`);
          assert.ok(d.tipTop < (VIEWPORTS[vp][1]) - 10, `${vp}: the tip starts on screen (${d.tipTop})`);
        }
        if (name === 'briefing') {
          assert.equal(await page.$$eval('.brief-ready__pips--dense i', (els) => els.length), 8);
          assert.match(await page.$eval('.brief-ready__txt', (el) => el.textContent.replace(/\s+/g, '')), /\/8$/);
        }
        if (name === 'result') assert.equal(await page.$$eval('.rcard', (els) => els.length), 8);
        assert.deepEqual(problems, [], `${vp} ${name}`);
        await page.close();
      }
    });

    test(`${vp}: 8 players — the 机变 draft's 10 cards in a 5 × 2 grid, on screen, at the official text size; dense order`, { timeout: 5 * 60 * 1000 }, async () => {
      for (const fam of ['bounty', 'supply', 'shop', 'tactic']) {
        const { page, problems, touch } = await open(vp, `players=8&phase=SP_DRAFT&variant=${fam}`);
        await page.screenshot({ path: path.join(OUT, `p8-${vp}-sp-${fam}.png`) });
        assert.deepEqual(await layoutProblems(page), [], `${vp} ${fam}`);
        const s = await spFacts(page);
        assert.match(s.cls, /\bspov__grid--wide\b/);
        assert.equal(s.cols, 5, '5 columns');
        assert.equal(s.cards.length, 10);
        const [W, H] = VIEWPORTS[vp];
        s.cards.forEach((c, i) => {
          const tag = `${vp} ${fam} card ${i + 1}`;
          assert.ok(c.box[0] >= s.grid[0] - 0.5 && c.box[2] <= s.grid[2] + 0.5 && c.box[1] >= s.grid[1] - 0.5 && c.box[3] <= s.grid[3] + 0.5, `${tag}: inside the grid`);
          assert.ok(c.box[0] >= 0 && c.box[1] >= 0 && c.box[2] <= W && c.box[3] <= H, `${tag}: on screen`);
          for (let j = i + 1; j < s.cards.length; j++) assert.ok(!overlap(c.box, s.cards[j].box), `${tag} / ${j + 1}: no overlap`);
          assert.ok(touch ? c.font >= 7.5 : c.font >= 0.19 * s.rem - 0.01, `${tag}: text ${c.font} px`);
          assert.ok(c.nameIn && c.iconIn, `${tag}: icon and name inside the card`);
          assert.ok(c.over <= 1 || c.overflowY === 'auto', `${tag}: a longer text scrolls in the card`);
          assert.ok(c.box[3] - c.box[1] - c.descTop >= 3 * c.font, `${tag}: room for at least 3 lines of text`);
        });
        assert.equal(s.dense, true);
        assert.equal(s.who, 8);
        assert.equal(s.whoOut, 0, `${vp} ${fam}: the pick order inside the overlay, above the grid`);
        assert.deepEqual(problems, [], `${vp} ${fam}`);
        await page.close();
      }
    });
  }

  test('640×360 / 1920×1080: a text longer than its card scrolls inside it (touch swipe / mouse wheel), free or taken, and never arms the card', async () => {
    for (const vp of ['phone-min', 'desktop']) {
      const { page, problems, touch } = await open(vp, 'players=8&phase=SP_DRAFT&variant=supply');
      // the 10 longest item texts: the 3rd card's is longer than its card (measured free, then taken)
      const longest = await page.evaluate(async () => {
        const { data } = await import('/js/data.js');
        return data.list('items').filter((i) => !i.isGolden && i.itemType === 'EQUIP' && !i.shopExcluded)
          .sort((a, b) => String(b.descRaw || b.desc).length - String(a.descRaw || a.desc).length).slice(0, 10).map((i) => ({ itemId: i.id }));
      });
      for (const picks of [{}, { p4: 2 }]) {
        await page.evaluate((cards, picks) => { const S = globalThis.__MOCK__.S(); S.pub.sp = { ...S.pub.sp, cards, picks }; globalThis.__MOCK__.pushPublic(); }, longest, picks);
        await sleep(300);
        const t = await page.evaluate(() => {
          const c = document.querySelectorAll('.spcard')[2];
          const d = c.querySelector('.spcard__desc');
          d.scrollTop = 0;
          const r = d.getBoundingClientRect();
          return { disabled: c.disabled, over: d.scrollHeight - d.clientHeight, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        assert.ok(t.over > 4, `${vp}: the 3rd longest text is longer than its card (${t.over} px more)`);
        if (touch) await swipe(page, t.x, t.y, -Math.min(60, t.over + 20));
        else { await page.mouse.move(t.x, t.y); await page.mouse.wheel({ deltaY: 120 }); }
        await sleep(400);
        const top = await page.$$eval('.spcard__desc', (els) => els[2].scrollTop);
        assert.ok(top > 4, `${vp} ${t.disabled ? 'taken' : 'free'} card: the text scrolled (${top} px)`);
        assert.equal(await page.$('.spcard.is-armed'), null, `${vp}: scrolling never arms a card`);
      }
      await page.screenshot({ path: path.join(OUT, `p8-${vp}-sp-scrolled.png`) });
      assert.deepEqual(problems, []);
      await page.close();
    }
  });

  test('640×360: two taps on the 10th card pick it (g.choice { idx: 9 })', async () => {
    const { page, problems } = await open('phone-min', 'players=8&phase=SP_DRAFT&variant=bounty');
    const tap = async () => {
      const r = await page.$$eval('.spcard', (els) => { const b = els[9].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.4 }; });
      await page.touchscreen.tap(r.x, r.y);
      await sleep(350);
    };
    await tap();
    assert.equal(await page.$$eval('.spcard', (els) => els.findIndex((c) => c.classList.contains('is-armed'))), 9, 'first tap: the 10th card selected');
    await tap();
    await page.waitForSelector('.spcard.is-mine', { timeout: 3000 });
    const sent = await page.evaluate(() => globalThis.__MOCK__.S().requests.filter(([t]) => t === 'g.choice').map(([, f]) => f.idx));
    assert.deepEqual(sent, [9]);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('640×360: a tap on each compact team row opens that row\'s 前往查看, beside the row and tappable', async () => {
    const { page, problems } = await open('phone-min', 'players=8&phase=PREP');
    // client-side combat: the official observing (a teammate row → 前往查看)
    await page.evaluate(() => { const S = globalThis.__MOCK__.S(); S.pub.combatMode = 'client'; globalThis.__MOCK__.pushPublic(); });
    await sleep(500);
    for (let i = 1; i < 8; i++) {
      const b = await page.$$eval('.team__btn', (els, k) => { const r = els[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
      await page.touchscreen.tap(b.x, b.y);
      await sleep(350);
      const r = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.team__row')];
        const ob = document.querySelector('.team__ob');
        if (!ob) return { open: rows.findIndex((x) => x.classList.contains('is-open')), ob: null };
        const o = ob.getBoundingClientRect();
        const t = document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2);
        const row = ob.closest('.team__row').getBoundingClientRect();
        return { open: rows.findIndex((x) => x.classList.contains('is-open')), ob: { inside: o.right <= innerWidth && o.bottom <= innerHeight, hit: !!t && ob.contains(t), beside: o.left >= row.left + 10 && o.top < row.bottom && o.bottom > row.top } };
      });
      assert.equal(r.open, i, `a tap on P${i + 1} opens P${i + 1}`);
      assert.ok(r.ob && r.ob.inside && r.ob.hit && r.ob.beside, `P${i + 1}: 前往查看 ${JSON.stringify(r.ob)}`);
      // close it again (a second tap on the same row)
      await page.touchscreen.tap(b.x, b.y);
      await sleep(300);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('844×390: 5 players — 7 cards in a 4 × 2 grid; the Final Assault\'s lone 5th player on b3', async () => {
    let { page, problems } = await open('iphone14', 'players=5&phase=SP_DRAFT&variant=tactic');
    const s = await spFacts(page);
    assert.equal(s.cards.length, 7);
    assert.equal(s.cols, 4);
    assert.equal(s.who, 5);
    assert.deepEqual(await layoutProblems(page), []);
    assert.deepEqual(problems, []);
    await page.close();
    ({ page, problems } = await open('iphone14', 'players=5&phase=FINAL_ASSAULT'));
    const fields = await page.evaluate(() => globalThis.__MOCK__.S().pub.fields.map((f) => `${f.fieldId}:${f.players.join('+')}`));
    assert.deepEqual(fields, ['b1:p1+ai_2', 'b2:p3+p4', 'b3:p5']);
    const t = await teamFacts(page);
    assert.equal(t.compact, true);
    assert.equal(t.rows, 5);
    assert.deepEqual(t.misses, []);
    assert.deepEqual(await layoutProblems(page), []);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('the host\'s room bar with 8 humans seated (real server): the difficulty labels stay on one line, the pickers clear of the ready row', { timeout: 3 * 60 * 1000 }, async () => {
    const { TestClient } = await import('../helpers/wsClient.js');
    for (const vp of Object.keys(VIEWPORTS)) {
      for (const humans of [4, 8]) {
        const [w, h, touch] = VIEWPORTS[vp];
        const ctx = await browser.createBrowserContext(); // a fresh profile: no saved session resuming into another room
        const page = await ctx.newPage();
        await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch, isLandscape: true });
        const problems = [];
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 20000 });
        const click = async (sel, text) => {
          const ok = await page.evaluate((s, t) => {
            const el = [...document.querySelectorAll(s)].find((x) => !t || x.textContent.trim().includes(t));
            if (el) el.click();
            return !!el;
          }, sel, text);
          assert.ok(ok, `${sel} ${text || ''}`);
          await sleep(300);
        };
        await page.focus('.title-login input');
        await page.keyboard.type('凯尔希');
        await click('.title-login button', '开始');
        await page.waitForSelector('.lobby-screen', { timeout: 15000 });
        await click('.mode-card', '同盟模拟');
        await click('.create-box button', '创建同盟');
        await page.waitForSelector('.room-bar__right', { timeout: 15000 });
        if (humans > 4) await click('.cpick__opt', String(humans));
        const code = await page.evaluate(() => document.querySelector('.invite__code')?.getAttribute('aria-label')?.replace('同盟密钥', '').trim());
        const guests = [];
        for (let i = 1; i < humans; i++) {
          const g = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
          await g.hello(`客人${i}`);
          const r = await g.request({ t: 'room.join', code });
          assert.equal(r.t, 'ok', JSON.stringify(r));
          guests.push(g);
        }
        await page.waitForFunction((n) => document.querySelectorAll('.ready-count__icons .icon').length === n, { timeout: 5000 }, humans);
        await page.evaluate(() => document.fonts.ready);
        await sleep(400);
        const bar = await page.evaluate(() => {
          const range = document.createRange();
          const opts = [...document.querySelectorAll('.room-bar__left .dpick:not(.cpick) .dpick__opt')].map((el) => {
            const lines = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
              .reduce((acc, n) => { range.selectNodeContents(n); return acc + range.getClientRects().length; }, 0);
            return { text: el.textContent.trim(), lines };
          });
          const box = (s) => document.querySelector(s).getBoundingClientRect();
          return {
            opts, many: document.querySelector('.ready-count__icons').classList.contains('is-many'),
            pickRight: Math.max(box('.room-bar__left .dpick:not(.cpick)').right, box('.room-bar__left .cpick').right),
            centerLeft: box('.room-bar__center').left,
          };
        });
        await page.screenshot({ path: path.join(OUT, `p8-room-bar-${vp}-h${humans}.png`) });
        assert.equal(bar.opts.length, 4, `${vp} ${humans}: the host's four difficulties`);
        for (const o of bar.opts) assert.equal(o.lines, 1, `${vp} ${humans}: 「${o.text}」 on one line`);
        assert.ok(bar.pickRight <= bar.centerLeft, `${vp} ${humans}: the pickers (…${Math.round(bar.pickRight)}) end before the ready row (${Math.round(bar.centerLeft)}…)`);
        assert.equal(bar.many, humans > 4, `${vp} ${humans}: the smaller ready icons only above 4 humans`);
        assert.deepEqual(await layoutProblems(page), [], `${vp} ${humans}`);
        assert.deepEqual(problems, [], `${vp} ${humans}`);
        for (const g of guests) await g.close();
        await page.close();
        await ctx.close();
      }
    }
  });

  test('4 players (the default mock): the official layouts — no compact / dense / wide modifier anywhere', async () => {
    for (const vp of ['phone-min', 'desktop']) {
      for (const q of ['phase=PREP', 'phase=SP_DRAFT&variant=supply', 'phase=BAND_DRAFT', 'phase=INFO_CHECK']) {
        const { page, problems } = await open(vp, q);
        const st = await page.evaluate(() => ({
          mods: [...document.querySelectorAll('.team--compact, .spov__grid--wide, .spov__order--dense, .draft-order--dense, .brief-ready__pips--dense')].map((el) => el.className),
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          pa: document.querySelector('.team .pavatar')?.getBoundingClientRect().width ?? null,
          grid: document.querySelector('.spov__grid') ? getComputedStyle(document.querySelector('.spov__grid')).gridTemplateColumns.split(' ').length : null,
        }));
        assert.deepEqual(st.mods, [], `${vp} ${q}`);
        if (st.pa != null) assert.ok(Math.abs(st.pa - 0.8 * st.rem) < 1, `${vp} ${q}: the official .8rem team avatar (${st.pa})`);
        if (st.grid != null) assert.equal(st.grid, 3, `${vp} ${q}: the official 3 × 2 grid`);
        assert.deepEqual(problems, [], `${vp} ${q}`);
        await page.close();
      }
    }
  });
});
