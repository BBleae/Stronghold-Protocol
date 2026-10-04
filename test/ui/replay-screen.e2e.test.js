// The replay screen in headless Chrome (puppeteer-core + system Chrome): the real ReplayScreen on the simplified field
// view, with the match archive and its replay engine served by request interception (30 battles of 10 s). Opt-in like
// the other browser suites: SP_E2E=1 node --test test/ui/replay-screen.e2e.test.js
//
// Asserted: nothing renders while a replay is paused or finished; playing renders the control bar on the click and once
// per replay second, never the screen with its battle list; the clock reads the whole seconds of the selected battle;
// zero console errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RV = 'abcdef0123456789abcd';
const players = [{ playerId: 'p1', name: 'Alice' }, { playerId: 'p2', name: 'Bob' }, { playerId: 'p3', name: 'Carol' }, { playerId: 'p4', name: 'Dave' }];
const battles = Array.from({ length: 30 }, (_, i) => ({
  source: 'client', spec: { stageId: 'stage_x', rect: null, ticks: 300 }, inputs: [], tick: 300, complete: true,
  round: Math.floor(i / 2) + 1, players: i % 2 ? ['p3', 'p4'] : ['p1', 'p2'], fieldId: `f${i % 2}`, battleId: `b${i}`, result: null, kind: 'normal',
}));
const replayText = JSON.stringify({ schemaVersion: 1, rulesVersion: RV, battles });
const facts = { manifest: { chunks: [{ index: 0, hash: createHash('sha256').update(replayText).digest('hex') }], rulesVersion: RV }, result: { players } };
// a battle that only counts its ticks (ends after spec.ticks)
const ENGINE = `export const rulesVersion = ${JSON.stringify(RV)};
export async function ready() {}
export function stage() { return null; }
export function createBattle(spec) {
  const b = { tickCount: 0, finished: false, sharedBoss: null,
    step() { b.tickCount++; if (b.tickCount >= spec.ticks) b.finished = true; },
    snapshot() { return { t: b.tickCount / 30, units: [], dp: 0, killed: 0, total: 0 }; },
    drainEvents() { return []; }, fieldMeta() { return { units: [] }; }, forceEnd() { b.finished = true; } };
  return b;
}`;

test('replay screen: renders only when the clock it shows changes', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run', timeout: 120000 }, async (t) => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => srv.close());
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const p = new URL(req.url()).pathname;
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/__replay') return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="app"></div>' });
    if (p === '/api/matches/M1') return json(facts);
    if (p === '/api/matches/M1/replay/0') return json({ text: replayText });
    if (p === `/replay-engines/${RV}/engine.js`) return req.respond({ status: 200, contentType: 'text/javascript', body: ENGINE });
    return req.continue();
  });
  await page.goto(`http://127.0.0.1:${srv.port}/__replay?render=fallback`);
  await page.evaluate(async () => {
    const { render, options } = await import('/vendor/preact.module.js');
    const { html } = await import('/js/ui/components.js');
    const { store } = await import('/js/store.js');
    const { ReplayScreen } = await import('/js/screens/replay.js');
    store.patch('ui', { replayMatchId: 'M1' });
    const renders = { ReplayScreen: 0, ReplayControls: 0 };
    window.__renders = renders;
    const diffed = options.diffed;
    options.diffed = (vnode) => {
      diffed?.(vnode);
      const name = typeof vnode.type === 'function' ? vnode.type.name : null;
      if (name in renders) renders[name]++;
    };
    render(html`<${ReplayScreen}/>`, document.getElementById('app'));
  });
  const renders = () => page.evaluate(() => ({ ...window.__renders }));
  const clock = () => page.evaluate(() => document.querySelector('.replay-toolbar .num')?.textContent ?? null);
  const click = (text) => page.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled).click(), text);
  const playButton = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '播放' && !b.disabled), { timeout: 20000 });

  await playButton();
  await sleep(300);
  const ready = await renders();
  await sleep(1500);
  assert.deepEqual(await renders(), ready, 'paused: nothing renders');
  assert.equal(await clock(), '0 / 10 秒');

  await click('播放');
  await sleep(2300);
  const played = await renders();
  assert.equal(played.ReplayScreen, ready.ReplayScreen, 'playing never renders the screen');
  const bar = played.ReplayControls - ready.ReplayControls;
  assert.ok(bar >= 2 && bar <= 4, `the control bar: the click and each replay second (${bar} renders)`);
  assert.equal(await clock(), '2 / 10 秒');

  await click('4×');
  await playButton();
  assert.equal(await clock(), '10 / 10 秒', 'played to the end');
  const finished = await renders();
  await sleep(1000);
  assert.deepEqual(await renders(), finished, 'finished: nothing renders');
  assert.deepEqual(problems, []);
});
