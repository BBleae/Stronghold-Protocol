// Browser E2E (mock harness, headless Chrome): a spectator count update renders the presence badge only, not the
// match screen under it. Opt-in: SP_E2E=1 (and Chrome; CHROME_PATH overrides where).
//
//   SP_E2E=1 node --test test/ui/spectator-presence.e2e.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('a spectator count update renders the presence badge, not the match screen', {
  skip: (process.env.SP_E2E !== '1' || !existsSync(CHROME)) && 'set SP_E2E=1 (and have Chrome) to run', timeout: 60000,
}, async (t) => {
  const { startServer } = await import('../../server/index.js');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => server.close());
  const browser = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/dev/game-mock.html?shot=1&render=fallback&phase=PREP`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 15000 });

  // Count component renders by name (preact's render hook).
  await page.evaluate(async () => {
    const { options } = await import('/vendor/preact.module.js');
    const previous = options.__r;
    globalThis.renders = {};
    options.__r = (vnode) => {
      const name = vnode.type?.name;
      if (name) globalThis.renders[name] = (globalThis.renders[name] ?? 0) + 1;
      previous?.(vnode);
    };
  });
  // What renders within 200 ms of a room.state with `patch` (null: no update at all).
  const update = (patch) => page.evaluate(async (patch) => {
    globalThis.renders = {};
    const { store } = globalThis.__MOCK__;
    if (patch) store.set({ room: { ...store.get().room, ...patch } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { renders: globalThis.renders, badge: document.querySelector('.spectator-presence')?.textContent.trim() };
  }, patch);

  // The screen settles first (the phase banner leaves on its own): a window without an update renders no screen (the
  // prep countdown keeps ticking on its own).
  const screens = ({ renders }) => (renders.GameScreen ?? 0) + (renders.MatchScreen ?? 0);
  for (let i = 0; screens(await update(null)); i++) {
    assert.ok(i < 20, 'the match screen never settled');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (let n = 1; n <= 3; n++) {
    const { renders, badge } = await update({ spectatorCount: n });
    assert.equal(badge, `${n} 人观战`);
    assert.equal(renders.SpectatorPresence, 1);
    assert.equal(renders.GameScreen, undefined, `count ${n}: the router did not render`);
    assert.equal(renders.MatchScreen, undefined, `count ${n}: the match screen did not render`);
  }
  // Control: a change the router reads still renders it.
  const { renders } = await update({ spectating: true });
  assert.equal(renders.GameScreen, 1);
  assert.deepEqual(errors, []);
});
