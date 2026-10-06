// The title card's connection row in Chrome: ● state text · ping, then 玩法说明 · 资源管理 · ⚙ · ⛶.
//
//   SP_E2E=1 [CHROME_PATH=…] node --test test/ui/title-conn.e2e.test.js
//
// 资源管理 (ui/resourceButton.js) is only in the row on a Cloudflare site, where the resource manager installs its opener
// at boot; here the page installs the real opener itself before the title renders, against the Node server. With #183's ⚙
// next to it the row no longer fits the card: it squeezed the state text onto two lines ("已连接服务/器") and ⚙ / ⛶ out of
// square. Asserted on a 1080p desktop (mouse) and a landscape phone (touch), for the usual state and the longest one
// (登录已失效，请重新登录), with and without 资源管理:
//   * the state text stays on one line, ⚙ / ⛶ are .4rem squares, 玩法说明 / 资源管理 keep their padding, nothing
//     overflows the row;
//   * without 资源管理 the row is one line, as it always was; with it the tools wrap as a whole onto a line under the state;
//   * touch: a tap on the centre of ⚙, ⛶ and each text button reaches that control (the 44 px hit areas).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  phone: { width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true },
};

describe('title connection row', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** The row's geometry, in rem where it is a design size. */
  const measure = () => {
    const row = document.querySelector('.title-conn');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const q = (s) => row.querySelector(s);
    const text = q('.status-dot').nextElementSibling;
    const range = document.createRange();
    range.selectNodeContents(text);
    const mid = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.top + b.height / 2); };
    const tools = ['.title-guide', '.title-res', '.title-settings', '.title-fs'].map(q).filter(Boolean);
    const sq = (el) => { const b = el.getBoundingClientRect(); return [+(b.width / rem).toFixed(3), +(b.height / rem).toFixed(3)]; };
    const pad = (b) => {
      const r = document.createRange();
      r.selectNodeContents(b);
      const c = r.getBoundingClientRect(), o = b.getBoundingClientRect();
      return +(Math.min(c.left - o.left, o.right - c.right) / rem).toFixed(3);
    };
    return {
      text: text.textContent,
      textLines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
      stateMid: mid(q('.status-dot')),
      toolMids: [...new Set(tools.map(mid))],
      gear: sq(q('.title-settings')),
      fs: sq(q('.title-fs')),
      textPads: ['.title-guide', '.title-res'].map(q).filter(Boolean).map(pad),
      res: !!q('.title-res'),
      overflow: row.scrollWidth - row.clientWidth,
      kids: [...row.children].map((k) => k.className),
    };
  };

  /** The control a tap on the centre of each of the row's tools reaches. */
  const tapTargets = () => ['.title-guide', '.title-res', '.title-settings', '.title-fs'].map((sel) => {
    const el = document.querySelector(`.title-conn ${sel}`);
    if (!el) return [sel, null];
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [sel, !!hit && (hit === el || el.contains(hit))];
  });

  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    for (const cloudflare of [false, true]) {
      test(`${vp}, ${cloudflare ? 'with 资源管理 (Cloudflare)' : 'without 资源管理 (Node)'}: one-line state, square ⚙ / ⛶, nothing squeezed`, async () => {
        const page = await browser.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        if (cloudflare) {
          await page.evaluateOnNewDocument(() => {
            // the page's own documents only (not a blank frame, where a root-relative specifier does not resolve)
            if (/^https?:$/.test(location.protocol)) import('/js/ui/resourceButton.js').then((m) => m.installResourceOpener(() => {}));
          });
        }
        await page.emulate({ viewport, userAgent: await browser.userAgent() });
        await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.waitForSelector(cloudflare ? '.title-conn .title-res' : '.title-conn .title-fs', { timeout: 30000 });
        await sleep(400);
        // the phone's taps go through the touch screen's hit areas (a desktop may report a touch screen too: not asserted)
        if (vp === 'phone') assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sp-coarse')), true);

        for (const state of ['usual', 'longest']) {
          if (state === 'longest') {
            await page.evaluate(async () => {
              const { store } = await import('/js/store.js');
              store.patch('connection', { status: 'closed', lastError: { code: 'LOGIN_REQUIRED', text: '登录已失效，请重新登录' } });
            });
            await page.waitForFunction(() => document.querySelector('.title-conn').textContent.includes('登录已失效'));
          }
          const m = await page.evaluate(measure);
          const at = `${vp} ${cloudflare ? 'cf' : 'node'} ${state}: ${JSON.stringify(m)}`;
          assert.equal(m.res, cloudflare, at);
          assert.deepEqual(m.kids, ['title-conn__state', 'title-conn__tools'], at);
          assert.equal(m.textLines, 1, `the state text is one line — ${at}`);
          assert.deepEqual(m.gear, [0.4, 0.4], `⚙ is a .4rem square — ${at}`);
          assert.deepEqual(m.fs, [0.4, 0.4], `⛶ is a .4rem square — ${at}`);
          // .btn--sm pads .16rem (at least, a phone's minimums aside): 玩法说明 / 资源管理 are never squeezed into it
          for (const p of m.textPads) assert.ok(p >= 0.15, `a text button keeps its padding (${p}rem) — ${at}`);
          assert.ok(m.overflow <= 0, `nothing overflows the row — ${at}`);
          assert.equal(m.toolMids.length, 1, `the tools share one line — ${at}`);
          if (cloudflare) assert.ok(m.toolMids[0] > m.stateMid, `with 资源管理 the tools take their own line under the state — ${at}`);
          else assert.equal(m.toolMids[0], m.stateMid, `without 资源管理 the row is one line — ${at}`);
          if (vp === 'phone') {
            for (const [sel, ok] of await page.evaluate(tapTargets)) {
              if (ok !== null) assert.equal(ok, true, `a tap on ${sel} reaches it — ${at}`);
            }
          }
        }
        assert.deepEqual(problems, []);
        await page.close();
      });
    }
  }
});
