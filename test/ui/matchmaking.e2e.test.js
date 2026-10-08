// Browser E2E of 匹配 (matchmaking queue, a remake feature; DESIGN §F4) against the real server, headless Chrome.
// Opt-in: SP_E2E=1 node --test test/ui/matchmaking.e2e.test.js
//
// Desktop: lobby → 快速匹配 → the queue panel appears and counts up (`queue.status`) → the server forms a room
// (`queue.matched`) → the client joins it on its own, the host fills the empty seats with AI teammates and starts →
// the match screen is up. The queue timings are the production ones, so a lone player waits out the grace before its
// room starts; the test waits for that instead of shortening it.
// Every page must finish with zero console errors / page errors / failed requests. Screenshots: test/e2e/out/queue-*.png

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

describe('matchmaking (匹配, real server + headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    // a fast queue so the test does not sit through the production grace
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true,
      queueTickMs: 50, queueMinSeats: 2, queueGraceMs: 400, queueTimeoutMs: 2500, queueSilentMs: 20_000,
    });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', '匹配测试');
      sessionStorage.setItem('sp.entered', '1');
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
    return { ctx, page, problems };
  }
  const ui = (page) => page.evaluate(() => {
    const s = globalThis.__SP__.store.get();
    return {
      queue: s.queue, roomCode: s.room?.code || null, inMatch: s.room?.inMatch || false,
      seats: (s.room?.seats || []).filter(Boolean).map((x) => ({ name: x.name, bot: x.isBot, ready: x.ready })),
      myId: s.me.playerId, hostId: s.room?.hostId || null, phase: s.match.public?.phase ?? null,
    };
  });
  async function waitUi(page, pred, what, timeout = 25000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) { last = await ui(page); if (pred(last)) return last; await sleep(150); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
  }

  test('desktop: 快速匹配 → queue panel → auto-join the formed room → AI teammates fill it → the match starts', async () => {
    const { ctx, page, problems } = await open();
    // the 快速匹配 button only exists in 同盟模拟 mode
    await page.waitForSelector('[data-testid="queue-join"]', { visible: true, timeout: 15000 });
    await page.click('[data-testid="queue-join"]');
    await page.waitForSelector('.queue-panel', { visible: true, timeout: 10000 });
    const waiting = await waitUi(page, (s) => s.queue.waiting, 'the queue to report waiting');
    assert.equal(waiting.queue.count, 1, 'alone in the queue');
    await page.screenshot({ path: path.join(OUT, 'queue-waiting.png') });

    // the server forms the room and the client joins it on its own
    const joined = await waitUi(page, (s) => !!s.roomCode, 'the room to be joined', 15000);
    assert.match(joined.roomCode, /^[A-Z]{4}$/);
    assert.equal(joined.inMatch, false, 'the room opens first');
    assert.ok(joined.seats.some((s) => s.name === '匹配测试'), 'the matched player holds a seat');

    // the host fills the empty seats with AI teammates and starts without a click
    const started = await waitUi(page, (s) => s.inMatch, 'the match to start', 30000);
    assert.equal(started.seats.length, 4, `every seat is taken (${JSON.stringify(started.seats)})`);
    assert.ok(started.seats.some((s) => s.bot), 'the unmatched seats became AI teammates');
    // m.public is a frame of its own and can land a moment after the room flips to inMatch
    const phased = await waitUi(page, (s) => !!s.phase, 'the first match frame', 20000);
    assert.ok(phased.phase, `the match is in a phase (${phased.phase})`);
    await page.screenshot({ path: path.join(OUT, 'queue-started.png') });
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });

  test('desktop: 取消匹配 leaves the queue and restores the normal buttons', async () => {
    const { ctx, page, problems } = await open();
    await page.waitForSelector('[data-testid="queue-join"]', { visible: true, timeout: 15000 });
    await page.click('[data-testid="queue-join"]');
    await page.waitForSelector('[data-testid="queue-cancel"]', { visible: true, timeout: 10000 });
    const w = await waitUi(page, (s) => s.queue.waiting, 'the queue to report waiting');
    assert.equal(w.queue.count, 1);
    await page.click('[data-testid="queue-cancel"]');
    const done = await waitUi(page, (s) => !s.queue.waiting, 'the queue to be left', 10000);
    assert.equal(done.queue.count, 0);
    assert.ok(await page.waitForSelector('[data-testid="queue-join"]', { visible: true, timeout: 5000 }), 'the 快速匹配 button is back');
    assert.equal(done.roomCode, null, 'no room was created');
    assert.deepEqual(problems, [], 'no console / page / request errors');
    await ctx.close();
  });
});
