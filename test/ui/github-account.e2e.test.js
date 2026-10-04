import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, copyRuntimeAssets, bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test(
  'signed-in title shows the account, returns to the lobby, and signs out to the account card',
  {
    skip: process.env.SP_ACCOUNTS_E2E !== '1' || !existsSync(chrome),
    timeout: 90000,
  },
  async (t) => {
    await copyRuntimeAssets();
    await bundleWorker();
    const h = await createAccountHarness(
      `
    import worker,{SiteDirectory,AccountDurableObject} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,AccountDurableObject};
    import {hash} from './worker/accounts/auth.js';
    // GitHub at the Worker's outbound fetch: the credentials check finds the app's credentials valid.
    const outbound=globalThis.fetch;
    globalThis.fetch=async(input,init)=>(typeof input==='string'?input:input.url)==='https://github.com/login/oauth/access_token'
      ? Response.json({error:'bad_verification_code'}) : outbound(input,init);
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname==='/__test/login'){
        const token=await hash(crypto.randomUUID());
        const site=env.SITES.get(env.SITES.idFromName('directory'));
        const user=await site.resolveGithubUser({id:'42',login:'BBleae',name:'晴猫',avatarUrl:'https://avatars.githubusercontent.com/u/42?v=4'});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(token),{accountId:user.accountId,expiresAt:Date.now()+600000});
        return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':'__Host-sp_session='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax'}});
      }
      if(u.pathname.startsWith('/api/')){
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin','https://game.example');
        return worker.fetch(new Request('https://game.example'+u.pathname+u.search,{method:req.method,headers,
          body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `,
      {
        durableObjects: {
          SITES: { className: 'TestObject', useSQLite: true },
          ACCOUNTS: { className: 'AccountDurableObject', useSQLite: true },
        },
        bindings: { AUTH_ORIGIN: 'https://game.example', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture' },
        assets: path.join(ROOT, 'dist/client'),
        ratelimits: productionLimits,
      },
    );
    t.after(() => h.dispose());
    const browser = await (
      await import('puppeteer-core')
    ).default.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1366, height: 768 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('stronghold-resource-mode', 'ondemand'));
    await page.setRequestInterception(true);
    page.on('request', (req) =>
      new URL(req.url()).hostname === 'avatars.githubusercontent.com'
        ? req.respond({
            status: 200,
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#238b70"/></svg>',
          })
        : req.continue(),
    );
    await page.goto(new URL('/__test/login', String(await h.url()).replace('127.0.0.1', 'localhost')).href);
    await page.waitForSelector('.lobby-screen');
    // The account was stored before display names: it gets its discriminator when /api/me first reads it.
    const name = await page.$eval('.me-chip__name', (el) => el.textContent);
    assert.match(name, /^晴猫#\d{4}$/);
    const click = async (selector, text) =>
      page.$$eval(selector, (buttons, text) => buttons.find((b) => b.textContent.trim() === text).click(), text);
    await click('.topbar__left button', '返回');
    await page.waitForSelector('.title-login');
    assert.equal((await page.$$('.title-login input')).length, 0, 'signed-in users must never be offered a nickname');
    assert.ok((await page.$eval('.title-login', (el) => el.textContent)).includes(name));
    assert.equal(
      await page.$eval('.title-login .avatar__img img', (el) => el.src),
      'https://avatars.githubusercontent.com/u/42?v=4',
    );
    const out = path.join(ROOT, 'test/e2e/out/github-profile');
    await mkdir(out, { recursive: true });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [844, 390],
    ]) {
      await page.setViewport({ width, height });
      const box = await page.$eval('.title-login', (el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
      assert.ok(box.scrollWidth <= box.width + 1, JSON.stringify(box));
      await (await page.$('.title-login')).screenshot({ path: path.join(out, 'signed-in-' + width + '.png') });
    }
    await click('.title-login button', '进入大厅');
    await page.waitForSelector('.lobby-screen');
    assert.equal(await page.$eval('.me-chip__name', (el) => el.textContent), name);
    await click('.topbar__left button', '返回');
    await page.waitForSelector('.title-login');
    await click('.title-login button', '退出登录');
    // Signed out: the account card, with GitHub sign-in offered (configured, credentials valid).
    await page.waitForSelector('.title-login__github');
    assert.deepEqual(await page.$$eval('.title-login input', (els) => els.map((el) => el.autocomplete)), [
      'username',
      'current-password',
    ]);
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/me')).json()).user), null);
    assert.deepEqual(errors, []);
  },
);
