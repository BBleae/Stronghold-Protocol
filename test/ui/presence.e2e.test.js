// Browser E2E of the 在线人数 readout (ported from Jerryzhu1234510's fork, 4f4e848f) against the real server, headless
// Chrome (puppeteer-core + system Chrome; CHROME_PATH overrides where). Opt-in:
//
//   SP_E2E=1 node --test test/ui/presence.e2e.test.js
//
// Desktop: the title footer carries the release version AND the live counters (read from /healthz: the title screen
// has no session), a second page (another player, in the lobby) is counted — its top bar shows the numbers the server
// pushes — and the title page catches up within one poll; closing a page takes the count back down.
// Phones (640×360, 844×390, touch) in Chinese and English: the readout is on screen, fully readable (no ellipsis), at
// least 10 px, and overlaps none of its neighbours in the title footer and the lobby top bar. The Cloudflare site's
// signed-out title page (its account card centred over the footer; account mode faked over the Node server, as the
// Worker build marks the page) at 640×360 / 667×375 in Japanese, Chinese and English with three-digit numbers: the
// readout stays clear of the card.
// Every page must finish with zero console errors / page errors / failed requests. Screenshots: test/e2e/out/presence-*.png

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome'].find((p) => existsSync(p)) || '';
const ENABLED = process.env.SP_E2E === '1' && !!CHROME && existsSync(CHROME);
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

const SEL = '[data-testid="lobby-presence"], [data-testid="title-presence"]';
/** The numbers of whichever readout the current screen shows (Chinese: 在线 N 人 · 房间内 M 人). */
const numbersOf = (text) => {
  const m = /^在线 (\d+) 人 · 房间内 (\d+) 人$/.exec(String(text || '').trim());
  return m ? { online: Number(m[1]), inRoom: Number(m[2]) } : null;
};

describe('在线人数 readout (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    // a short presence tick: the push is then observable well inside the test's waits
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, presenceTickMs: 300 });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  /** Open a page: `entered: false` stays on the title screen, `true` goes straight to the lobby. */
  async function open({ entered = false, name = '在线测试', lang = null, device = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    if (device) await page.emulate({ viewport: device, userAgent: ANDROID_UA });
    else await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.evaluateOnNewDocument((enter, who) => {
      localStorage.setItem('sp.name', who);
      if (enter) sessionStorage.setItem('sp.entered', '1');
    }, entered, name);
    await page.goto(`${base}/${lang ? `?lang=${lang}` : ''}`, { waitUntil: 'domcontentloaded' });
    // `connected` is the title screen's socket (no hello yet); `online` means the session was welcomed
    await page.waitForFunction(() => ['connected', 'online'].includes(globalThis.__SP__?.store.get().connection.status), { timeout: 30000 });
    await page.waitForSelector(entered ? '[data-testid="lobby-presence"]' : '[data-testid="title-presence"]', { visible: true, timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 }); // the boot splash is gone
    return { ctx, page, problems };
  }

  const readout = (page) => page.$eval(SEL, (el) => el.textContent.trim());
  /** Wait until the readout's online number satisfies `cmp`. */
  const waitOnline = (page, cmp, n, timeout = 20000) => page.waitForFunction((sel, op, want) => {
    const m = /^在线 (\d+) 人/.exec((document.querySelector(sel)?.textContent || '').trim());
    if (!m) return false;
    const v = Number(m[1]);
    return op === '=' ? v === want : op === '>=' ? v >= want : v <= want;
  }, { timeout }, SEL, cmp, n);

  test('desktop: the title footer and the lobby top bar show the live counters, and they stay current', async () => {
    const a = await open({ entered: false });
    // the title screen has no session yet, so its numbers come from /healthz — and its own page still counts
    await waitOnline(a.page, '>=', 1);
    const first = numbersOf(await readout(a.page));
    assert.ok(first, 'the title footer shows the readout');
    assert.ok(first.online >= 1, `this page is counted (${JSON.stringify(first)})`);
    assert.equal(first.inRoom, 0, 'nobody is in a room');
    assert.equal((await a.page.evaluate(() => globalThis.__SP__.store.get().presence)).via, 'healthz', 'read from /healthz');
    // the release version still sits in the same footer (test/version.test.js pins the expression, this pins the view)
    assert.match(await a.page.$eval('.title-foot', (el) => el.textContent), /v\d+\.\d+\.\d+(-dev)? · WEB SIMULATION/);
    await a.page.screenshot({ path: path.join(OUT, 'presence-title.png') });

    // a second player enters: the lobby readout counts it, pushed by the server over the socket
    const b = await open({ entered: true, name: '第二个人' });
    await waitOnline(b.page, '=', first.online + 1);
    const lobby = numbersOf(await readout(b.page));
    assert.equal(lobby.online, first.online + 1, 'the second page is counted');
    assert.deepEqual(await b.page.evaluate(() => globalThis.__SP__.store.get().presence), { ...lobby, via: 'frame' }, 'pushed, not polled');
    await b.page.screenshot({ path: path.join(OUT, 'presence-lobby.png') });

    // the second player opens a room: the in-room count follows (pushed to the lobby page; polled by the title page)
    await b.page.evaluate(() => globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }));
    await a.page.waitForFunction((sel) => /房间内 1 人$/.test(document.querySelector(sel)?.textContent.trim() || ''), { timeout: 20000 }, SEL);
    await b.page.evaluate(() => globalThis.__SP__.net.request('room.leave', {}));
    await a.page.waitForFunction((sel) => /房间内 0 人$/.test(document.querySelector(sel)?.textContent.trim() || ''), { timeout: 20000 }, SEL);

    // …and the title screen, which only polls, agrees within one interval
    await waitOnline(a.page, '=', lobby.online);
    assert.equal(numbersOf(await readout(a.page)).online, lobby.online, 'both screens agree on the counters');

    // closing the lobby page takes the count back down
    assert.deepEqual(b.problems, [], 'page B: no console errors / failed requests');
    await b.ctx.close();
    await waitOnline(a.page, '<=', first.online);
    assert.equal(numbersOf(await readout(a.page)).online, first.online, 'back to one page');

    assert.deepEqual(a.problems, [], 'page A: no console errors / failed requests');
    await a.ctx.close();
  });

  /** Layout of the readout: readable, on screen, overlapping none of the elements around it. */
  const readoutLayout = (page, scope) => page.evaluate((sel, scopeSel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const out = { text: el.textContent.trim(), fontPx: parseFloat(getComputedStyle(el).fontSize), problems: [] };
    if (el.scrollWidth > el.clientWidth + 1) out.problems.push(`ellipsized (${el.scrollWidth} > ${el.clientWidth})`);
    if (r.width < 10 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) out.problems.push(`off screen [${[r.left, r.top, r.right, r.bottom].map(Math.round)}]`);
    // the leaves around it: every text / control in the same bar that is not the readout itself
    const bar = el.closest(scopeSel);
    for (const n of bar.querySelectorAll('button, .ping, .micro, h1, span, .me-chip')) {
      if (n === el || el.contains(n) || n.contains(el)) continue;
      const b = n.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (ix > 1 && iy > 1) out.problems.push(`overlaps ${n.className || n.tagName} "${n.textContent.trim().slice(0, 16)}"`);
    }
    return out;
  }, SEL, scope);

  /**
   * The Cloudflare site's signed-out title page over this server: the page marked as the Worker build marks it
   * (tools/build-worker.mjs: data-sp-runtime="cloudflare", worker-entry.js), /api/me with password + GitHub sign-in and
   * nobody signed in (its account card), /healthz with `nums`.
   */
  async function openSignIn({ lang, device, nums }) {
    const html = (await (await fetch(`${base}/`)).text())
      .replace('<html ', '<html data-sp-runtime="cloudflare" ').replace('src="/js/main.js"', 'src="/js/worker-entry.js"');
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.emulate({ viewport: device, userAgent: ANDROID_UA });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin !== base) return r.continue();
      if (u.pathname === '/' || u.pathname === '/index.html') return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      if (u.pathname === '/api/me') return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ capabilities: { password: true, github: true }, user: null, activeSeat: null, application: null }) });
      if (u.pathname === '/healthz') return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, online: nums[0], inRoom: nums[1] }) });
      return r.continue();
    });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    // (the Cloudflare site's first visit asks how to load the resources: answered — on demand)
    await page.evaluateOnNewDocument(() => { localStorage.setItem('stronghold-resource-mode', 'ondemand'); });
    await page.goto(`${base}/?lang=${lang}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-screen--sign-in .title-login', { visible: true, timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 15000 });
    await page.waitForFunction((n) => (document.querySelector('[data-testid="title-presence"]')?.textContent || '').includes(String(n)), { timeout: 15000 }, nums[0]);
    await new Promise((r) => setTimeout(r, 900)); // the card's rise-in
    return { ctx, page, problems };
  }

  for (const [w, h] of [[640, 360], [667, 375]]) {
    test(`Cloudflare sign-in title page ${w}×${h}: the readout stays clear of the account card (ja / zh / en, three-digit numbers)`, async () => {
      for (const lang of ['ja', 'zh', 'en']) {
        const { ctx, page, problems } = await openSignIn({ lang, nums: [128, 64], device: { width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true } });
        for (const scrolled of [false, true]) {
          if (scrolled) await page.evaluate(() => { const m = document.querySelector('.title-main'); m.scrollTop = m.scrollHeight; });
          const m = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="title-presence"]'), card = document.querySelector('.title-login');
            const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
            const ix = Math.min(r.right, c.right) - Math.max(r.left, c.left), iy = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
            return { text: el.textContent.trim(), overlap: ix > 0.5 && iy > 0.5 ? [Math.round(ix), Math.round(iy)] : null,
              ellipsized: el.scrollWidth > el.clientWidth + 1, offScreen: r.left < 0 || r.right > innerWidth || r.bottom > innerHeight,
              fontPx: parseFloat(getComputedStyle(el).fontSize) };
          });
          const tag = `${lang} ${w}×${h}${scrolled ? ' scrolled' : ''}: ${m.text}`;
          assert.equal(m.overlap, null, `${tag}: under the card by ${m.overlap}`);
          assert.ok(!m.ellipsized && !m.offScreen && m.fontPx >= 10, `${tag}: readable (${JSON.stringify(m)})`);
        }
        await page.screenshot({ path: path.join(OUT, `presence-signin-${lang}-${w}x${h}.png`) });
        assert.deepEqual(problems, []);
        await ctx.close();
      }
    });
  }

  const PHONES = {
    'phone-min': { width: 640, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    iphone14: { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true },
  };
  for (const [dev, device] of Object.entries(PHONES)) {
    for (const lang of ['zh', 'en']) {
      test(`${dev} (${lang}): the readout fits the title footer and the lobby top bar`, async () => {
        const title = await open({ entered: false, device, lang });
        await title.page.waitForFunction((sel) => /\d/.test(document.querySelector(sel)?.textContent || ''), { timeout: 20000 }, SEL);
        if (lang === 'en') assert.match(await readout(title.page), /^\d+ online · \d+ in rooms$/, 'English');
        const t = await readoutLayout(title.page, '.title-foot');
        await title.page.screenshot({ path: path.join(OUT, `presence-${dev}-${lang}-title.png`) });
        assert.deepEqual(t.problems, [], `title footer: ${t.text}`);
        assert.ok(t.fontPx >= 10, `title footer: ${t.fontPx} px`);
        assert.deepEqual(title.problems, []);
        await title.ctx.close();

        const lobby = await open({ entered: true, device, lang, name: `手机${dev}`.slice(0, 8) });
        await lobby.page.waitForFunction((sel) => /\d/.test(document.querySelector(sel)?.textContent || ''), { timeout: 20000 }, SEL);
        const l = await readoutLayout(lobby.page, '.topbar');
        await lobby.page.screenshot({ path: path.join(OUT, `presence-${dev}-${lang}-lobby.png`) });
        assert.deepEqual(l.problems, [], `lobby top bar: ${l.text}`);
        assert.ok(l.fontPx >= 10, `lobby top bar: ${l.fontPx} px`);
        assert.deepEqual(lobby.problems, []);
        await lobby.ctx.close();
      });
    }
  }
});
