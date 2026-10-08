/* global __automaticReconnects */ // a page global read inside page.evaluate / waitForFunction
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, copyRuntimeAssets, bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test(
  'account preferences restore in a clean browser, survive offline reload, and isolate account switches',
  {
    skip: process.env.SP_ACCOUNTS_E2E !== '1' || !existsSync(chrome),
    timeout: 120000,
  },
  async (t) => {
    // Exercise the production client/Worker without adding retained battle-engine versions.
    await copyRuntimeAssets();
    await bundleWorker();
    const h = await createAccountHarness(
      `
    import worker,{RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive};
    import {hash} from './worker/accounts/auth.js';
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname.startsWith('/__test/login/')){
        const actor=u.pathname.split('/').at(-1),token=await hash(crypto.randomUUID());
        const site=env.SITES.get(env.SITES.idFromName('directory'));
        const user=await site.resolveGithubUser({id:String(actor.charCodeAt(0)),login:actor,avatarUrl:null});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(token),{accountId:user.accountId,expiresAt:Date.now()+600000});
        return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':'__Host-sp_session='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax'}});
      }
      if(u.pathname.startsWith('/api/') || u.pathname==='/ws') {
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin','https://game.example');
        return worker.fetch(new Request('https://game.example'+u.pathname+u.search,{method:req.method,headers,
          body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `,
      {
        durableObjects: Object.fromEntries(
          ['SiteDirectory', 'AccountDurableObject', 'RoomDurableObject', 'MatchArchive'].map((className, i) => [
            ['SITES', 'ACCOUNTS', 'ROOMS', 'MATCH_ARCHIVES'][i],
            { className, useSQLite: true },
          ]),
        ),
        ratelimits: productionLimits,
        assets: path.join(ROOT, 'dist/client'),
      },
    );
    t.after(() => h.dispose());
    const browser = await (
      await import('puppeteer-core')
    ).default.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const base = String(await h.url()).replace('127.0.0.1', 'localhost'),
      errors = [];
    const ready = (page) => page.waitForFunction(() => globalThis.__SP__?.net.status === 'menu');
    const open = async () => {
      const context = await browser.createBrowserContext(),
        page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewport({ width: 1366, height: 768 });
      await page.evaluateOnNewDocument(() => localStorage.setItem('stronghold-resource-mode', 'ondemand'));
      await page.goto(base + '__test/login/a');
      await ready(page);
      return page;
    };
    const a = await open();
    // the menu's 自选 picker has its operators before the page meets a room (worker-entry.js, data-sp-diy-kitted)
    assert.ok((await a.evaluate(async () => (await import('/js/ui/loadoutSync.js')).loadoutStore.get().diyKitted))?.includes('char_003_kalts'));
    await a.evaluate(async () => {
      [...document.querySelectorAll('.mode-card')].find((b) => b.textContent.includes('独立模拟')).click();
      [...document.querySelectorAll('.diff-card')].find((b) => b.textContent.includes('终极模拟')).click();
      (await import('/js/ui/loadoutSync.js')).setEntries({ chess_char_1_01_a: { skill: 0, module: 'none' } });
      // the 自选编队 picks and the 干员持有 list follow the account like the loadout (preferenceSchema.js)
      // (an owned 6★ pick names its skill: a pick without one is dropped by the room — shared/diy.js validateDiyPicks)
      (await import('/js/ui/loadoutSync.js')).setDiyPicks({ chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 2 } });
      (await import('/js/ui/loadoutSync.js')).setNotOwned(['chess_char_3_05_a']);
      (await import('/js/screens/lobby.js')).rememberRoom('ABCD');
      (await import('/js/ui/emotes.js')).rememberTheme('emoticon_originium_slug');
    });
    const expected = {
      loadout: { v: 1, entries: { chess_char_1_01_a: { skill: 0, module: 'none' } } },
      diy: { v: 1, picks: { chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 2 } } },
      ownership: { v: 1, notOwned: ['chess_char_3_05_a'] },
      'lobby.mode': 'solo',
      'lobby.difficulty': 'ABYSS',
      recentRooms: ['ABCD'],
      emoteTheme: 'emoticon_originium_slug',
    };
    await a.waitForFunction(
      async () => {
        const r = await (await fetch('/api/me/preferences')).json();
        return r.preferences?.['lobby.difficulty'] === 'ABYSS';
      },
      { timeout: 5000 },
    );
    assert.deepEqual(
      await a.evaluate(async () => (await (await fetch('/api/me/preferences')).json()).preferences),
      expected,
    );
    const b = await open();
    const read = (page) =>
      page.evaluate(async () => {
        const { loadPref } = await import('/js/store.js');
        const { loadoutStore } = await import('/js/ui/loadoutSync.js');
        return {
          loadout: { v: 1, entries: loadoutStore.get().entries },
          diy: { v: 1, picks: loadoutStore.get().diy },
          ownership: { v: 1, notOwned: loadoutStore.get().notOwned },
          'lobby.mode': loadPref('lobby.mode', 'coop'),
          'lobby.difficulty': loadPref('lobby.difficulty', 'FUNNY'),
          recentRooms: loadPref('recentRooms', []),
          emoteTheme: loadPref('emoteTheme', null),
        };
      });
    assert.deepEqual(await read(b), expected);
    assert.equal(await b.$eval('.mode-card.is-selected', (el) => el.textContent.includes('独立模拟')), true);
    assert.equal(await b.$eval('.diff-card.is-selected', (el) => el.textContent.includes('终极模拟')), true);
    assert.equal(await b.evaluate(() => __SP__.net.route), null, 'saving preferences does not allocate a room');
    await b.evaluate(async () => (await import('/js/ui/loadoutSync.js')).openLoadout('lobby'));
    await b.waitForFunction(() => document.querySelector('.lo')?.textContent.includes('已保存到账号'));
    await b.waitForSelector('.lo-body');
    await b.addStyleTag({ content: '*,*::before,*::after {animation:none!important;transition:none!important}' });
    await b.screenshot({ path: path.join(tmpdir(), 'sp-preferences-loadout.png') });
    await b.evaluate(async () => (await import('/js/ui/loadoutSync.js')).closeLoadout());
    // A failed POST leaves a durable local outbox that a reload will flush.
    await b.setRequestInterception(true);
    const intercept = (req) =>
      req.url().endsWith('/api/me/preferences') && req.method() === 'POST' ? req.abort() : req.continue();
    b.on('request', intercept);
    await b.evaluate(async () => {
      (await import('/js/store.js')).savePref('lobby.difficulty', 'HARD');
      await (await import('/js/preferences.js')).preferences.flush();
    });
    b.off('request', intercept);
    await b.setRequestInterception(false);
    await b.reload();
    await ready(b);
    assert.equal((await read(b))['lobby.difficulty'], 'HARD');
    assert.equal(
      await b.evaluate(async () => (await (await fetch('/api/me/preferences')).json()).preferences['lobby.difficulty']),
      'HARD',
    );
    await b.goto(base + '__test/login/b');
    await ready(b);
    const switched = await read(b);
    assert.deepEqual(switched.loadout, { v: 1, entries: {} });
    assert.deepEqual(switched.diy, { v: 1, picks: {} }, 'another account never sees these picks');
    assert.deepEqual(switched.ownership, { v: 1, notOwned: [] }, 'nor this list');
    assert.equal(switched['lobby.mode'], 'coop');
    assert.deepEqual(switched.recentRooms, []);
    await b.goto(base + '__test/login/a');
    await ready(b);
    assert.deepEqual(await read(b), { ...expected, 'lobby.difficulty': 'HARD' });
    // Deployment recovery must work in the already-open browser, without 继续对局 or reload().
    // A room Worker's page meets the room at room.create (its welcome): the 自选编队 and 干员持有 go out just after it
    // (loadoutSync.js), and a match takes them at its start — a player's click on 开始模拟 comes later, so wait for them.
    await b.evaluate(() => __SP__.net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' }));
    await b.waitForFunction(async () => {
      const s = (await import('/js/ui/loadoutSync.js')).loadoutStore.get();
      return s.diySync === 'synced' && s.ownSync === 'synced';
    }, { timeout: 10000 });
    await b.evaluate(() => __SP__.net.request('room.start'));
    await b.waitForFunction(() => __SP__.store.get().match.public?.phase === 'INFO_CHECK');
    const beforeRestart = await b.evaluate(() => ({
      playerId: __SP__.net.playerId,
      room: __SP__.store.get().room.code,
      token: __SP__.net.getToken(),
      url: location.href,
    }));
    await b.evaluate(() => {
      window.__automaticReconnects = [];
      __SP__.net.on('status', (s) => __automaticReconnects.push(s.status));
    });
    await h.restart();
    await b.waitForFunction(
      () =>
        window.__automaticReconnects.includes('reconnecting') &&
        __SP__.net.status === 'online' &&
        __SP__.store.get().match.public?.phase === 'INFO_CHECK',
      { timeout: 30000 },
    );
    assert.deepEqual(
      await b.evaluate(() => ({
        playerId: __SP__.net.playerId,
        room: __SP__.store.get().room.code,
        token: __SP__.net.getToken(),
        url: location.href,
      })),
      beforeRestart,
    );
    // the account's 自选编队 and 干员持有 reached the match (the seat's at its start), and the restore kept them
    const own = () => __SP__.store.get().match.private?.diy?.chess_char_6_diy1_a?.charId === 'char_003_kalts'
      && (__SP__.store.get().match.private?.standIns || []).includes('chess_char_3_05_a');
    await b.waitForFunction(own, { timeout: 10000 });
    const ownBefore = await b.evaluate(() => ({ diy: __SP__.store.get().match.private.diy, standIns: __SP__.store.get().match.private.standIns }));
    await b.evaluate(() => __SP__.net.request('g.infoReady'));
    await b.waitForFunction(() => __SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    // an edit during the match is the next match's (both are out-of-match settings): this one keeps what it took
    await b.evaluate(async () => (await import('/js/ui/loadoutSync.js')).setDiyPicks({}));
    await b.waitForFunction(async () => (await import('/js/ui/loadoutSync.js')).loadoutStore.get().diySync === 'locked', { timeout: 10000 });
    assert.deepEqual(await b.evaluate(() => __SP__.store.get().match.private.diy), ownBefore.diy, 'the running match keeps its picks');
    await b.evaluate(() => __SP__.net.request('g.band', { bandId: 'band_sarkazb' }));
    await b.waitForFunction(() => __SP__.store.get().match.public?.phase === 'PREP');
    await b.evaluate(() => {
      window.__automaticReconnects.length = 0;
    });
    await h.restart();
    await b.waitForFunction(
      () =>
        window.__automaticReconnects.includes('reconnecting') &&
        __SP__.net.status === 'online' &&
        __SP__.store.get().match.public?.phase === 'PREP',
      { timeout: 30000 },
    );
    assert.equal(await b.evaluate(() => __SP__.net.playerId), beforeRestart.playerId);
    assert.equal(await b.evaluate(() => __SP__.store.get().room.code), beforeRestart.room);
    // the restored match (checkpoint + event log) still holds the 自选编队 and 干员持有 it started with
    await b.waitForFunction(() => !!__SP__.store.get().match.private?.diy, { timeout: 10000 });
    assert.deepEqual(await b.evaluate(() => ({ diy: __SP__.store.get().match.private.diy, standIns: __SP__.store.get().match.private.standIns })), ownBefore);
    await b.evaluate(() => __SP__.net.request('g.leave'));
    assert.deepEqual(errors, []);
  },
);
