// Account-mode flows on the real Workers bundle in miniflare with the real client in headless Chrome (GitHub mocked at
// the Worker's outbound fetch and at the authorize page): an invite link survives the GitHub login and turns into an
// application, a logged-in friend's invite link applies at once, a reload mid-match resumes the seat, and a login
// revoked elsewhere stops the room client and asks for a new login. Opt-in: SP_ACCOUNTS_E2E=1 (and Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, copyRuntimeAssets, bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness } from '../worker/helpers/account-harness.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('account flows: invite through the GitHub login, invite while logged in, reload resume, revoked login', {
  skip: process.env.SP_ACCOUNTS_E2E !== '1' || !existsSync(chrome), timeout: 240000,
}, async (t) => {
  await copyRuntimeAssets();
  await bundleWorker();
  const h = await createAccountHarness(`
    import worker,{RoomDurableObject,SiteDirectory,AccountDurableObject,AdmissionDurableObject,MatchArchive} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,RoomDurableObject,SiteDirectory,AccountDurableObject,AdmissionDurableObject,MatchArchive};
    import {hash} from './worker/accounts/auth.js';
    const ORIGIN='https://game.example', outbound=globalThis.fetch;
    // GitHub at the Worker's outbound fetch: the OAuth code names the GitHub user (code u<id>).
    globalThis.fetch=async(input,init)=>{
      const href=typeof input==='string'?input:input.url;
      if(href==='https://github.com/login/oauth/access_token')
        return Response.json({access_token:'gho_'+new URLSearchParams(String(init.body)).get('code')});
      if(href==='https://api.github.com/user') {
        const id=Number(new Headers(init.headers).get('Authorization').replace('Bearer gho_u',''));
        return Response.json({id,login:'friend'+id,name:'Friend'+id,avatar_url:null});
      }
      return outbound(input,init);
    };
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname.startsWith('/__test/login/')){
        const actor=u.pathname.split('/').at(-1),token=await hash(crypto.randomUUID());
        const site=env.SITES.get(env.SITES.idFromName('directory'));
        const user=await site.resolveGithubUser({id:String(actor.charCodeAt(0)),login:'博士 '+actor,avatarUrl:null});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(token),{accountId:user.accountId,expiresAt:Date.now()+600000});
        return new Response(null,{status:303,headers:{Location:'/'+u.search,'Set-Cookie':'__Host-sp_session='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax'}});
      }
      if(u.pathname.startsWith('/api/') || u.pathname==='/ws') {
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin',ORIGIN);
        return worker.fetch(new Request(ORIGIN+u.pathname+u.search,{method:req.method,headers,redirect:'manual',
          body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `, { durableObjects: Object.fromEntries(['SiteDirectory', 'AccountDurableObject', 'RoomDurableObject', 'AdmissionDurableObject', 'MatchArchive']
    .map((className, i) => [['SITES', 'ACCOUNTS', 'ROOMS', 'ADMISSION', 'MATCH_ARCHIVES'][i], { className, useSQLite: true }])),
  bindings: { AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture' }, assets: path.join(ROOT, 'dist/client') });
  t.after(() => h.dispose());
  const base = String(await h.url()).replace('127.0.0.1', 'localhost');
  const browser = await (await import('puppeteer-core')).default.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const errors = [];

  /** A fresh browser profile; GitHub's authorize page answers at once with the code of `githubId`. */
  const open = async (githubId = 0) => {
    const page = await (await browser.createBrowserContext()).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1366, height: 768 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('stronghold-resource-mode', 'ondemand'); globalThis.__SP_RENDER__ = 'fallback'; });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.hostname !== 'github.com') return req.continue();
      const back = `${base}api/auth/github/callback?code=u${githubId}&state=${u.searchParams.get('state')}`;
      return req.respond({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(back)})</script>` });
    });
    return page;
  };
  const inMenu = (page) => page.waitForFunction(() => globalThis.__SP__?.net.status === 'menu', { timeout: 15000 });
  const call = (page, type, fields = {}) => page.evaluate(([type, fields]) => __SP__.net.request(type, fields), [type, fields]);
  const click = async (page, text) => {
    await page.waitForFunction((text) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === text && !b.disabled), { timeout: 15000 }, text);
    await page.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text).click(), text);
  };
  const text = (page) => page.evaluate(() => document.body.innerText);

  const host = await open();
  await host.goto(base + '__test/login/a');
  await inMenu(host);
  await call(host, 'room.create', { mode: 'coop', difficulty: 'FUNNY' });
  const code = await host.evaluate(() => __SP__.store.get().room.code);

  // A friend who is not logged in opens the invite, logs in with GitHub and lands back on it: the application goes out.
  const friend = await open(5001);
  await friend.goto(`${base}?room=${code}`);
  await friend.waitForSelector('.title-invite');
  assert.match(await friend.$eval('.title-invite', (el) => el.textContent), new RegExp(`${code}.*登录后申请加入`));
  await Promise.all([friend.waitForNavigation({ waitUntil: 'load' }), friend.click('.title-login__github')]);
  await friend.waitForFunction(() => location.pathname === '/' && globalThis.__SP__?.net.status === 'menu', { timeout: 30000 });
  await friend.waitForFunction((code) => document.body.innerText.includes(`${code} · 等待房主审批`), { timeout: 15000 }, code);
  await host.waitForFunction(() => document.body.innerText.includes('Friend5001'), { timeout: 15000 });
  await click(host, '同意');
  await friend.waitForFunction((code) => __SP__.store.get().room?.code === code, { timeout: 15000 }, code);

  // A logged-in friend opening the invite link applies at once.
  const other = await open();
  await other.goto(`${base}__test/login/c?room=${code}`);
  await other.waitForFunction((code) => document.body.innerText.includes(`${code} · 等待房主审批`), { timeout: 15000 }, code);
  await host.waitForFunction(() => document.body.innerText.includes('博士 c'), { timeout: 15000 });
  await click(host, '拒绝');
  await other.waitForFunction((code) => document.body.innerText.includes(`${code} · 申请已被拒绝`), { timeout: 15000 }, code);

  // A reload mid-match resumes the seat (no 继续对局 click).
  await call(friend, 'room.ready', { ready: true });
  await call(host, 'room.start');
  await friend.waitForFunction(() => !!__SP__.store.get().match.public?.phase, { timeout: 30000 });
  const playerId = await friend.evaluate(() => __SP__.net.playerId);
  await friend.reload({ waitUntil: 'domcontentloaded' });
  await friend.waitForFunction(() => globalThis.__SP__?.net.status === 'online' && !!__SP__.store.get().match.public?.phase, { timeout: 30000 });
  assert.equal(await friend.evaluate(() => __SP__.net.playerId), playerId);
  assert.equal(await friend.evaluate(() => __SP__.store.get().room.code), code);

  // Logging out elsewhere revokes the session: the room client stops and asks for a new login.
  await friend.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await friend.evaluate(() => __SP__.net.request('g.infoReady').catch(() => {}));
  await friend.waitForFunction(() => __SP__.net.status === 'closed', { timeout: 15000 });
  assert.match(await text(friend), /登录已失效，请重新登录/);
  assert.ok(await friend.evaluate(() => [...document.querySelectorAll('.conn-banner button')].some((b) => b.textContent.includes('重新登录'))));
  await friend.evaluate(() => { window.__statuses = []; __SP__.net.on('status', (s) => window.__statuses.push(s.status)); });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.deepEqual(await friend.evaluate(() => window.__statuses), [], 'no reconnect attempts');
  assert.deepEqual(errors, []);
});
