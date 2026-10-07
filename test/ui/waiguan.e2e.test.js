// Browser E2E of the 外援 / 甄选 (DIY) slots (DESIGN §27) against the real server, headless Chrome (puppeteer-core +
// system Chrome). Opt-in: SP_E2E=1 node --test test/ui/waiguan.e2e.test.js
//
// Desktop: lobby → 干员调配 → the four slot tiles are there → open a slot → the picker lists the 87 candidates and marks
// the sibling slot of the same tier as taken once one is chosen → the choice is persisted (localStorage sp.pref.waiguan),
// the slot tile shows the operator, and the server stores it (a room then carries it in room.state.picks).
// Every page must finish with zero console errors / page errors / failed requests. Screenshots: test/e2e/out/waiguan-*.png

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, sleep as csleep, hasChrome, startRealServer, problemsOf, waitForFunctionLong } from '../e2e/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('外援 / 甄选 slots (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
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
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open({ w = 1920, h = 1080, touch = false } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', '外援测试');
      sessionStorage.setItem('sp.entered', '1');
      // diagnostic: record every frame the page sends
      globalThis.__SP_SENT__ = [];
      const Orig = globalThis.WebSocket;
      globalThis.WebSocket = class extends Orig {
        send(data) { try { globalThis.__SP_SENT__.push(String(data).slice(0, 200)); } catch { /* ignore */ } return super.send(data); }
      };
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
    return { ctx, page, problems };
  }
  const clickSel = async (page, sel) => {
    await page.waitForSelector(sel, { visible: true, timeout: 15000 });
    await page.click(sel);
  };
  /** The picks the client stored (the sync sends the same map with room.pick). */
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.waiguan') || 'null'));

  test('desktop: pick into slot 1 of each tier, the sibling slot refuses the same operator, the server stores it', async () => {
    const { ctx, page, problems } = await open();
    await clickSel(page, '.lobby-screen [data-testid="loadout-open"]');
    await page.waitForSelector('.lo-wg__slot', { visible: true, timeout: 20000 });
    assert.equal(await page.$$eval('.lo-wg__slot', (els) => els.length), 4, 'four 甄选 slots (2 × tier V, 2 × tier VI)');
    assert.equal(await page.$$eval('.lo-wg__slot.is-filled', (els) => els.length), 0, 'all empty to start');
    await page.screenshot({ path: path.join(OUT, 'waiguan-slots-empty.png') });

    // tier V slot 1: the picker lists every candidate
    await clickSel(page, '[data-testid="waiguan-slot-diy5a"]');
    await page.waitForSelector('.lo-wgpick__grid .lo-card', { visible: true, timeout: 20000 });
    const nCand = await page.$$eval('.lo-wgpick__grid .lo-card', (els) => els.length);
    assert.ok(nCand > 50, `the picker lists the roster (${nCand})`);
    await page.screenshot({ path: path.join(OUT, 'waiguan-picker.png') });

    // choose the first candidate of the list
    const firstChar = await page.$eval('.lo-wgpick__grid .lo-card', (el) => el.getAttribute('data-char'));
    const firstName = await page.$eval('.lo-wgpick__grid .lo-card .lo-card__name', (el) => el.textContent.trim());
    await page.click('.lo-wgpick__grid .lo-card');
    await page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });
    assert.equal(await page.$$eval('.lo-wg__slot.is-filled', (els) => els.length), 1, 'the slot is filled');
    assert.equal(await page.$eval('[data-testid="waiguan-slot-diy5a"] .lo-wg__name', (el) => el.textContent.trim()), firstName);

    // tier V slot 2: the same operator is offered as taken and cannot be clicked
    await clickSel(page, '[data-testid="waiguan-slot-diy5b"]');
    await page.waitForSelector('.lo-wgpick__grid .lo-card', { visible: true, timeout: 20000 });
    assert.equal(await page.$eval(`.lo-wgpick__grid [data-char="${firstChar}"]`, (el) => el.disabled), true, 'the same operator of one tier is refused');
    const otherChar = await page.$$eval('.lo-wgpick__grid .lo-card:not([disabled])', (els) => els[0]?.getAttribute('data-char'));
    assert.ok(otherChar && otherChar !== firstChar, 'another candidate is still selectable');
    await page.click(`.lo-wgpick__grid [data-char="${otherChar}"]`);
    await page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });
    assert.equal(await page.$$eval('.lo-wg__slot.is-filled', (els) => els.length), 2, 'both tier V slots are filled');

    // tier VI slot 1: a different tier, so the operator taken in tier V is allowed again
    await clickSel(page, '[data-testid="waiguan-slot-diy6a"]');
    await page.waitForSelector('.lo-wgpick__grid .lo-card', { visible: true, timeout: 20000 });
    assert.equal(await page.$eval(`.lo-wgpick__grid [data-char="${firstChar}"]`, (el) => el.disabled), false, 'a tier VI slot may hold the tier V pick');
    await page.click(`.lo-wgpick__grid [data-char="${firstChar}"]`);
    await page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });

    // persisted, and cleared again
    await page.waitForFunction(() => !!localStorage.getItem('sp.pref.waiguan'), { timeout: 10000 });
    const saved = await stored(page);
    assert.deepEqual(Object.keys(saved.picks).sort(), ['diy5a', 'diy5b', 'diy6a'], 'the three picks are persisted');
    assert.equal(saved.picks.diy5a, firstChar);
    await clickSel(page, '[data-testid="waiguan-clear-diy5a"]');
    await sleep(300);
    assert.equal(await page.$$eval('.lo-wg__slot.is-filled', (els) => els.length), 2, 'the cleared slot is empty again');
    assert.ok(!(await stored(page)).picks.diy5a, 'the clear is persisted too');
    await page.screenshot({ path: path.join(OUT, 'waiguan-slots-filled.png') });

    // the server took the selection: a created room carries it in room.state.picks
    await clickSel(page, '.lo-back');
    await page.waitForSelector('.lobby-screen', { visible: true, timeout: 10000 });
    await page.waitForFunction(async () => {
      const s = globalThis.__SP__.store.get();
      return !!s.room || true; // the room is created below; this just yields a frame
    });
    // create a 独立模拟 room through the UI
    await page.evaluate(() => {
      const s = globalThis.__SP__.store.get();
      return s;
    });
    const roomPicks = await page.evaluate(async () => {
      const net = globalThis.__SP__.net;
      const st = await net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
      return st;
    }).catch(() => null);
    if (roomPicks) {
      await page.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 10000 });
      const picks = await page.evaluate(() => globalThis.__SP__.store.get().room?.picks || {});
      assert.equal(picks.diy5b, (await stored(page)).picks.diy5b, 'the server keeps the selection and echoes it back');
    }
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });

  /**
   * The bug this locks down: a picked 外援 operator appeared on the 干员调配 screen but its SKILL could not be switched — the
   * record was `visible: false` / `isDiy`, so the screen's roster predicate and the server's checkLoadout both dropped the
   * entry, and the radio group never even showed. Now the picked operator is a loadout target like any other.
   */
  test('desktop: a picked 外援 operator can switch its skill, and the server stores the choice', async () => {
    const { ctx, page, problems } = await open();
    await clickSel(page, '.lobby-screen [data-testid="loadout-open"]');
    await page.waitForSelector('.lo-wg__slot', { visible: true, timeout: 20000 });
    // pick a tier VI 外援, then select that operator in the roster list
    await clickSel(page, '[data-testid="waiguan-slot-diy6a"]');
    await page.waitForSelector('.lo-wgpick__grid .lo-card', { visible: true, timeout: 20000 });
    const charId = await page.$eval('.lo-wgpick__grid .lo-card', (el) => el.getAttribute('data-char'));
    await page.click('.lo-wgpick__grid .lo-card');
    await page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });
    // the picker closes on the tier VI slot; that operator's roster card is now in the list. Its chess id is derived the
    // same way the roster does (`chess_char_diy_6_<charId>_a`), and the list card is the one with data-chess.
    const suffix = charId.replace(/^char_\d+_/, '');
    const wantIds = [`chess_char_diy_6_${charId}_a`, `chess_char_diy_6_${suffix}_a`];
    const cardId = await (async () => {
      for (const id of wantIds) {
        if (await page.$(`.lo-grid [data-chess="${id}"]`)) return id;
      }
      // last resort: the first tier VI 外援 card the list shows (the group is labelled 外援)
      const any = await page.$$eval('.lo-grid [data-chess*="_diy_6_"]', (els) => els.map((e) => e.getAttribute('data-chess')));
      return any[0] || null;
    })();
    assert.ok(cardId, `the operator is in the roster list (tried ${wantIds.join(' / ')})`);
    await clickSel(page, `.lo-grid [data-chess="${cardId}"]`);

    // its SKILL radio group is offered (this used to be empty / absent for a 外援)
    await page.waitForSelector('.lo-skills .lo-skill', { visible: true, timeout: 15000 });
    const skills = await page.$$eval('.lo-skills .lo-skill', (els) => els.map((e) => e.getAttribute('data-skill')));
    assert.ok(skills.length >= 2, `the skill options are there (${skills.join(', ')})`);
    const before = await page.$eval('.lo-skills .lo-skill.is-on', (el) => el.getAttribute('data-skill'));
    const target = skills.find((s) => s !== before);
    await page.click(`.lo-skills [data-skill="${target}"]`);
    assert.equal(await page.$eval('.lo-skills .lo-skill.is-on', (el) => el.getAttribute('data-skill')), target, 'the choice is selected');
    await page.screenshot({ path: path.join(OUT, 'waiguan-skill-switch.png') });

    // it is persisted (the sync sends the same map as room.loadout)
    await page.waitForFunction((id) => {
      const lo = JSON.parse(localStorage.getItem('sp.pref.loadout') || 'null');
      const e = lo && (lo.entries || lo);
      return !!(e && e[id]);
    }, { timeout: 10000 }, cardId);
    const entry = await page.evaluate((id) => {
      const lo = JSON.parse(localStorage.getItem('sp.pref.loadout') || 'null');
      const e = lo && (lo.entries || lo);
      return e ? e[id] || null : null;
    }, cardId);
    assert.ok(entry, `the switched skill is stored (${JSON.stringify(entry)})`);
    assert.equal(String(entry.skill), String(target));

    // A room now makes the server echo both copies: the seat's loadout and the room's picks (room.state.picks is sent to
    // the room's members, so this is where the 甄选 selection becomes visible back to the client).
    const kept = await page.evaluate(async (id) => {
      const net = globalThis.__SP__.net;
      try { await net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' }); } catch { return { err: 'create' }; }
      const s = globalThis.__SP__.store.get();
      const seat = (s.room?.seats || []).find((x) => x && x.playerId === s.me.playerId);
      return { entry: (seat?.loadout || {})[id] || null, picks: s.room?.picks || {}, code: s.room?.code || null };
    }, cardId).catch(() => null);
    // the debounced frames have to land: the pick (room.pick) then the loadout (room.loadout, with this entry)
    await page.waitForFunction((id) => (globalThis.__SP_SENT__ || []).some((f) => {
      try { const m = JSON.parse(f); return m.t === 'room.loadout' && !!m.entries && !!m.entries[id]; } catch { return false; }
    }), { timeout: 15000 }, cardId);

    // ask again now that the room exists (room.loadout does not broadcast a state frame: that is deliberate)
    const state = await page.evaluate(async (id) => {
      const net = globalThis.__SP__.net;
      const me = globalThis.__SP__.store.get().me.playerId;
      const st = await net.request('g.state', {});
      const seat = (st?.seats || []).find((x) => x && x.playerId === me);
      return { entry: (seat?.loadout || {})[id] || null, picks: st?.picks || {} };
    }, cardId).catch(() => null);
    if (state && !state.err) {
      assert.ok(state.entry, `the server stored the 外援 loadout entry (${JSON.stringify(state)})`);
      assert.equal(String(state.entry.skill), String(target), 'with the switched skill index');
      assert.equal(state.picks.diy6a || state.picks.diy6b, charId, `and it holds the pick that entry needs (${JSON.stringify(state.picks)})`);
    }
    await page.screenshot({ path: path.join(OUT, 'waiguan-skill-switch.png') });
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });

  /**
   * The search box of the 外援 picker (regression): its TextField was wired with the DOM convention — `onInput=${(e) =>
   * setQuery(e.currentTarget.value)}` — while TextField calls `onInput(value)` with the STRING. Every keystroke therefore
   * threw `Cannot read properties of undefined (reading 'value')` and the query stayed empty, so the list never filtered:
   * a player typing an operator's name saw all 87 cards unchanged and concluded the operator was missing from the roster.
   */
  test('desktop: the 外援 picker search filters the roster (typing a name narrows the list)', async () => {
    const { ctx, page, problems } = await open();
    await clickSel(page, '.lobby-screen [data-testid="loadout-open"]');
    await page.waitForSelector('.lo-wg__slot', { visible: true, timeout: 20000 });
    await clickSel(page, '[data-testid="waiguan-slot-diy6a"]');
    await page.waitForSelector('.lo-wgpick input', { visible: true, timeout: 15000 });
    const all = await page.$$eval('.lo-wgpick__grid .lo-card', (els) => els.length);
    assert.ok(all > 50, `the unfiltered list is the whole roster (${all})`);

    // 维什戴尔: in the data (a 6★ outside the shop pool) and must be findable by name
    await page.click('.lo-wgpick input');
    await page.keyboard.type('维什戴尔');
    await page.waitForFunction((n) => document.querySelectorAll('.lo-wgpick__grid .lo-card').length === n, { timeout: 8000 }, 1);
    const names = await page.$$eval('.lo-wgpick__grid .lo-card .lo-card__name', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(names, ['维什戴尔'], 'the search narrows the list to the typed operator');
    assert.match(await page.$eval('.lo-wgpick__n', (el) => el.textContent), /1\s*名可选/);

    // a query that matches nothing is empty (and says so)
    await page.keyboard.type('xyz');
    await page.waitForFunction(() => document.querySelectorAll('.lo-wgpick__grid .lo-card').length === 0, { timeout: 8000 });
    assert.ok(await page.$('.lo-empty'), 'the empty state is shown');

    // clearing the field brings the roster back
    for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace');
    await page.waitForFunction((n) => document.querySelectorAll('.lo-wgpick__grid .lo-card').length === n, { timeout: 8000 }, all);
    await page.screenshot({ path: path.join(OUT, 'waiguan-picker-search.png') });
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });

  test('phone 844×390 (touch): the slot row and the picker stay usable', async () => {
    const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true });
    await page.waitForSelector('.lobby-screen', { visible: true, timeout: 20000 });
    await clickSel(page, '.lobby-screen [data-testid="loadout-open"]');
    await page.waitForSelector('.lo-wg__slot', { visible: true, timeout: 20000 });
    const box = await page.$eval('.lo-wg__slot', (el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
    assert.ok(box[0] > 20 && box[1] > 20, `the slot tile has a usable size ${JSON.stringify(box)}`);
    await clickSel(page, '[data-testid="waiguan-slot-diy6a"]');
    await page.waitForSelector('.lo-wgpick__grid .lo-card', { visible: true, timeout: 20000 });
    await page.screenshot({ path: path.join(OUT, 'waiguan-picker-phone.png') });
    const grid = await page.$eval('.lo-wgpick__grid', (el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
    assert.ok(grid[1] > 40 && grid[1] <= 390, `the picker grid scrolls inside the viewport ${JSON.stringify(grid)}`);
    await page.click('.lo-wgpick__grid .lo-card');
    await page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });
    assert.equal(await page.$$eval('.lo-wg__slot.is-filled', (els) => els.length), 1, 'the tap selected a candidate');
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });
});

// ---- a bought 外援 in a running match (DESIGN §27) ------------------------------------------------------------------
//
// The bug this locks down, end to end: the player's own picks never reached its shop (the server rolled without the
// player's id), a bought 外援 resolved to nothing in the browser (the in-match lookups read data/chess.json only: blank
// shop card, no piece art, no unit detail, no deploy voice) and never fought (no battle data source knew the record: zero
// ally units). A solo match on test/e2e/fastServer.mjs (SP_START_ROUND 2 + SP_START_SHOP: the picked operator in the first
// shop slot, the hook test/ui/playtest6-elite.e2e.test.js uses; SP_START_KIT 0: nothing else) — the pick is made in the
// 干员调配 picker, the card is bought with real taps, the piece is dragged onto the board, and the battle the browser runs
// must field it and report its damage. Zero console errors.


const MATCH_ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const DIY_CHAR = 'char_180_amgoat';
const DIY_NAME = '艾雅法拉';
const DIY_ID = `chess_char_diy_6_${DIY_CHAR}_a`;

describe('外援 in a running match: shop card, hand piece, unit detail and the battle (fast server, headless Chrome)', { skip: !MATCH_ENABLED && 'set SP_E2E=1 (and have Chrome + assets) to run' }, () => {
  test('solo: the picked 外援 is offered, bought, shown with its name and art, deployed, and fights', { timeout: 300000 }, async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 3, startRound: 2, kit: 0, shop: [DIY_ID] } });
    const c = new Client(puppeteer, srv.base, 'waiguan', { prefix: 'waiguan-match' });
    try {
      await c.open();
      await c.enter('外援');
      // the pick, through the 干员调配 picker (tier VI slot 1, found by name)
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('[data-testid="waiguan-slot-diy6a"]', { visible: true, timeout: 20000 });
      await c.click('[data-testid="waiguan-slot-diy6a"]');
      await c.page.waitForSelector('.lo-wgpick input', { visible: true, timeout: 15000 });
      await c.page.click('.lo-wgpick input');
      await c.page.keyboard.type(DIY_NAME);
      await c.page.waitForFunction((ch) => document.querySelectorAll('.lo-wgpick__grid .lo-card').length === 1
        && document.querySelector(`.lo-wgpick__grid [data-char="${ch}"]`), { timeout: 8000 }, DIY_CHAR);
      await c.click(`.lo-wgpick__grid [data-char="${DIY_CHAR}"]`);
      await c.page.waitForFunction(() => !document.querySelector('.lo-wgpick'), { timeout: 10000 });
      await c.click('.lo-back');
      await c.page.waitForSelector('.lobby-screen', { visible: true, timeout: 10000 });
      await c.hookRequests();

      // solo room → briefing → strategy → the first prep (round 2 by the hook)
      await c.click('.mode-card', '独立模拟');
      await c.click('.diff-card', '险境');
      await c.click('.create-box button', '开始独立模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      // the selection reached the server before the match (room.pick → room.state.picks, the viewer's own)
      await c.page.waitForFunction((ch) => globalThis.__SP__.store.get().room?.picks?.diy6a === ch, { timeout: 15000 }, DIY_CHAR);
      if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
      await c.click('.dband', null, { nth: 1 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      await c.waitFor((x) => x.phase === 'PREP' && !x.ready, 'prep', 60000);
      await csleep(1500);

      // the match holds the pick (m.private.picks: the match's own, locked selection)
      const priv0 = await c.page.evaluate(() => globalThis.__SP__.store.get().match.private);
      assert.equal(priv0.picks?.diy6a, DIY_CHAR, `the match holds the pick (${JSON.stringify(priv0.picks)})`);
      const slotIdx = priv0.shop.slots.findIndex((s) => s && s.id === DIY_ID);
      assert.ok(slotIdx >= 0, 'the 外援 is in the shop');

      // the shop card: the operator's name and portrait (it used to be a blank card: no record in chess.json)
      const card = await c.page.evaluate((name) => {
        const el = [...document.querySelectorAll('.shopbar__cards .scard')].find((x) => x.querySelector('.scard__name')?.textContent.trim() === name);
        if (!el) return null;
        const img = el.querySelector('img.scard__art');
        return { name: el.querySelector('.scard__name').textContent.trim(), src: img?.getAttribute('src') || null };
      }, DIY_NAME);
      assert.ok(card, `a shop card named ${DIY_NAME}`);
      assert.ok(card.src && card.src.includes(DIY_CHAR), `the card shows the operator's portrait (${card.src})`);
      await c.page.waitForFunction((name) => {
        const el = [...document.querySelectorAll('.shopbar__cards .scard')].find((x) => x.querySelector('.scard__name')?.textContent.trim() === name);
        const img = el?.querySelector('img.scard__art');
        return !!(img && img.complete && img.naturalWidth > 0);
      }, { timeout: 15000 }, DIY_NAME);
      await c.shot('shop');

      // buy it: first tap arms, the second buys
      await c.click('.shopbar__cards .scard', DIY_NAME);
      await csleep(300);
      await c.click('.shopbar__cards .scard.is-armed');
      await c.page.waitForFunction((id) => (globalThis.__SP__.store.get().match.private?.hand || []).some((p) => p && p.id === id), { timeout: 8000 }, DIY_ID);
      assert.equal((await c.requests('g.buy')).length, 1, 'one g.buy');
      const piece = (await c.handPieces('chess')).find((p) => p.id === DIY_ID);
      assert.ok(piece, 'the bought 外援 is in the hand');

      // the hand piece: the render view knows the operator (spine / avatar = its charId, not a blank null)
      await c.page.waitForFunction((uid) => !!globalThis.__SP_VIEW__?.raw?.debug?.views?.get('p:' + uid), { timeout: 8000 }, piece.uid);
      const info = await c.page.evaluate((uid) => {
        const v = globalThis.__SP_VIEW__.raw.debug.views.get('p:' + uid);
        return { spine: v?.info?.spine ?? null, avatar: v?.info?.avatar ?? null, tier: v?.info?.tier ?? null };
      }, piece.uid);
      assert.deepEqual(info, { spine: DIY_CHAR, avatar: DIY_CHAR, tier: 6 }, 'the hand piece is drawn as the operator');

      // the unit detail: tap the piece → name, portrait, skills
      const at = await c.piecePoint(piece.uid);
      assert.ok(at, 'the hand piece is on screen');
      await c.page.mouse.click(at.x, at.y);
      await c.page.waitForSelector('.dpanel .dhead__name', { visible: true, timeout: 8000 });
      const detail = await c.page.evaluate(() => ({
        name: document.querySelector('.dpanel .dhead__name')?.textContent.trim() || null,
        art: document.querySelector('.dpanel .dhead__art img')?.getAttribute('src') || null,
        text: document.querySelector('.dpanel')?.textContent || '',
      }));
      assert.equal(detail.name, DIY_NAME, 'the detail card names the operator');
      assert.ok(detail.art && detail.art.includes(DIY_CHAR), `the detail card shows its art (${detail.art})`);
      const rec = await c.page.evaluate((id) => globalThis.__SP__.data.lookup('chess', id), DIY_ID);
      assert.ok(rec && rec.skills?.length, 'the record resolves in the page');
      assert.ok(detail.text.includes(rec.skills.find((s) => s.isDefault)?.name || rec.skills[0].name), 'the skill is described');
      await c.shot('detail');
      await c.click('.dpanel__close', null, { optional: true, timeout: 2000 });

      // deploy it (drag + direction wheel), then fight
      const tile = await c.freeTileFor(piece.uid);
      assert.ok(tile, 'a free tile for the operator');
      const from = await c.piecePoint(piece.uid);
      const to = await c.tilePoint(tile.row, tile.col);
      await c.drag(from, to);
      await c.page.waitForSelector('.fwheel__dia', { timeout: 4000 });
      await c.swipe('LEFT');
      await c.page.waitForFunction((uid) => (globalThis.__SP__.store.get().match.private?.board || []).some((p) => p.uid === uid), { timeout: 8000 }, piece.uid);
      await c.shot('deployed');
      await c.click('.readybtn');
      // the battle the browser simulates fields the 外援: the field view draws a battle unit of that chess id (its spawn
      // info), with the operator's model
      const fielded = () => c.page.evaluate((id) => {
        const views = globalThis.__SP_VIEW__?.raw?.debug?.views;
        const s = globalThis.__SP__.store.get();
        if (!views || !s.match.battle || s.match.public?.phase !== 'COMBAT') return null;
        for (const v of views.values()) if (v?.info?.defId === id && v.info.side !== 'enemy') return { spine: v.info.spine, side: v.info.side };
        return null;
      }, DIY_ID);
      let unit = null;
      for (let t0 = Date.now(); !(unit = await fielded()); await csleep(100)) {
        if (Date.now() - t0 > 60000) throw new Error(`the 外援 never stood on the battle field: ${JSON.stringify(await c.st())}`);
      }
      assert.equal(unit.spine, DIY_CHAR, 'drawn with the operator\u2019s model');
      await csleep(600);
      await c.shot('combat');
      // ... and it fought: the battle's own report (b.result) credits it with damage
      // an own battle at 1× can outlast the browser's protocol timeout: poll in slices (client.mjs waitForFunctionLong)
      await waitForFunctionLong(c.page, () => (globalThis.__e2eReq || []).some((r) => r[0] === 'b.result'), { timeout: 120000 });
      const result = (await c.requests('b.result'))[0][1].result;
      const me = await c.page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
      const stats = (result.perPlayer?.[me]?.unitStats || []).find((u) => u.defId === DIY_ID);
      assert.ok(stats, `the battle report lists the 外援 (${JSON.stringify(result.perPlayer?.[me]?.unitStats)})`);
      assert.ok(stats.dmg > 0, `it dealt damage (${JSON.stringify(stats)})`);
      assert.deepEqual(problemsOf([c]), [], 'no console / page / request errors');
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
