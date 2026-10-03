import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const base = process.env.SP_WORKER_URL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('Workers browser boots with the room transport, reports a real battle, leaves, joins and reconnects', {
  skip: !base || !existsSync(chrome), timeout: 240000,
}, async t => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const errors = [];
  async function player(name) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', error => errors.push(error.message));
    // Asset-free checkouts can explicitly exercise transport/gameplay with the existing DOM renderer.
    if(process.env.SP_WORKER_RENDER==='fallback')await page.evaluateOnNewDocument(()=>{globalThis.__SP_RENDER__='fallback';});
    await page.evaluateOnNewDocument(name => {
      localStorage.setItem('sp.name', name);
      sessionStorage.setItem('sp.entered', '1');
      localStorage.setItem('stronghold-resource-mode', 'ondemand');
    }, name);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.net.status === 'online', { timeout: 30000 });
    assert.equal(await page.evaluate(() => __SP__.net.constructor.name), 'RoomNet');
    return page;
  }
  const call = (page, type, fields = {}) => page.evaluate(([type, fields]) => __SP__.net.request(type, fields), [type, fields]);
  const phase = (page, value) => page.waitForFunction(value => __SP__.store.get().match.public?.phase === value, { timeout: 30000 }, value);
  const host = await player('Worker测试房主');
  await host.evaluate(() => {
    globalThis.battleReports = [];
    const request = __SP__.net.request.bind(__SP__.net);
    __SP__.net.request = (type, fields, opts) => { if (type === 'b.result') battleReports.push(fields); return request(type, fields, opts); };
  });
  await call(host, 'room.create', { mode: 'solo', difficulty: 'FUNNY' });
  await call(host, 'room.start');
  await phase(host, 'INFO_CHECK');
  await call(host, 'g.infoReady');
  await phase(host, 'BAND_DRAFT');
  await call(host, 'g.band', { bandId: 'band_sarkazb' });
  await phase(host, 'PREP');
  await call(host, 'g.ready', { ready: true });
  await host.waitForFunction(() => globalThis.battleReports.length > 0, { timeout: 120000 });
  assert.ok(await host.evaluate(() => __SP_RUNNER__._entries.size > 0 || battleReports.length > 0));
  await host.waitForFunction(() => __SP__.store.get().match.public?.round === 2, { timeout: 30000 });
  await call(host, 'g.leave');
  await assert.rejects(call(host, 'room.leave'), /房间|NOT_IN_ROOM/);
  await call(host, 'room.create', { mode: 'coop', difficulty: 'FUNNY' });
  const code = await host.evaluate(() => __SP__.store.get().room.code);
  const guest = await player('Worker测试队友');
  await call(guest, 'room.join', { code });
  await call(guest, 'room.ready', { ready: true });
  await call(host, 'room.start');
  await phase(guest, 'INFO_CHECK');
  const playerId = await guest.evaluate(() => __SP__.net.playerId);
  await guest.reload({ waitUntil: 'domcontentloaded' });
  // Coop briefing has a live countdown; it may advance while the browser reloads.
  try {
    await guest.waitForFunction(() => globalThis.__SP__?.net.status === 'online' && globalThis.__SP__.store.get().room?.inMatch
      && !!globalThis.__SP__.store.get().match.public?.phase, { timeout: 30000 });
  } catch (error) {
    const state = await guest.evaluate(() => ({ status: globalThis.__SP__?.net.status,
      playerId: globalThis.__SP__?.net.playerId, room: globalThis.__SP__?.store.get().room,
      phase: globalThis.__SP__?.store.get().match.public?.phase,
      text: document.body.innerText.slice(-1000) }));
    throw new Error(`Reload did not resume: ${JSON.stringify({ expectedPlayerId: playerId, state, errors })}`, { cause: error });
  }
  assert.equal(await guest.evaluate(() => __SP__.net.playerId), playerId);
  await call(guest, 'g.leave');
  await call(host, 'g.leave');
  assert.deepEqual(errors, []);
});
