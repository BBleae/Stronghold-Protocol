// Password accounts on the real Workers bundle in miniflare with the real client in headless Chrome (no GitHub app
// configured: its sign-in is not offered): registering shows the lobby as 昵称#NNNN; logging out and in; 修改代号 and
// 修改密码 (the account's other logins end); an invite link goes on after a password login; a login lost in a room
// leads to the title screen's account card, and logging in again resumes the seat. Opt-in: SP_ACCOUNTS_E2E=1 (and
// Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, copyRuntimeAssets, bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('password accounts: register, log out and in, 修改代号, 修改密码, an invite after the login, a lost login', {
  skip: process.env.SP_ACCOUNTS_E2E !== '1' || !existsSync(chrome), timeout: 240000,
}, async (t) => {
  await copyRuntimeAssets();
  await bundleWorker();
  const h = await createAccountHarness(`
    import worker,{RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive};
    const ORIGIN='https://game.example';
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname.startsWith('/api/') || u.pathname==='/ws') {
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin',ORIGIN);
        return worker.fetch(new Request(ORIGIN+u.pathname+u.search,{method:req.method,headers,redirect:'manual',
          body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `, { durableObjects: Object.fromEntries(['SiteDirectory', 'AccountDurableObject', 'RoomDurableObject', 'MatchArchive']
    .map((className, i) => [['SITES', 'ACCOUNTS', 'ROOMS', 'MATCH_ARCHIVES'][i], { className, useSQLite: true }])),
  ratelimits: productionLimits, assets: path.join(ROOT, 'dist/client') });
  t.after(() => h.dispose());
  const base = String(await h.url()).replace('127.0.0.1', 'localhost');
  const browser = await (await import('puppeteer-core')).default.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const errors = [];

  /** A fresh browser profile. */
  const open = async () => {
    const page = await (await browser.createBrowserContext()).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1366, height: 768 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('stronghold-resource-mode', 'ondemand'); globalThis.__SP_RENDER__ = 'fallback'; });
    return page;
  };
  const buttons = (page, text) => page.waitForFunction((text) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.replace(/\s/g, '') === text && !b.disabled), { timeout: 15000 }, text);
  const click = async (page, text) => (await buttons(page, text)).click();
  const card = (page) => page.waitForSelector('.title-login form', { timeout: 15000 });
  const tab = (page, text) => page.$$eval('.tabs__tab', (tabs, text) => tabs.find((b) => b.textContent.trim() === text).click(), text);
  const send = (page) => page.click('.title-login button[type="submit"]');
  /** Fill the title card's fields in order (the tab's: 用户名, [博士代号], 密码, [确认密码]) and send: the page starts over. */
  const fill = async (page, values) => {
    const inputs = await page.$$('.title-login input');
    assert.equal(inputs.length, values.length);
    for (const [i, value] of values.entries()) await inputs[i].type(value);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), send(page)]);
  };
  const meName = (page) => page.$eval('.me-chip__name', (el) => el.textContent);
  /** Empty a field as a player does: select its text, delete it. */
  const clear = async (input) => {
    await input.evaluate((el) => el.select());
    await input.press('Backspace');
  };
  const inMenu = (page) => page.waitForFunction(() => globalThis.__SP__?.net.status === 'menu', { timeout: 15000 });

  // No GitHub app: the card offers the username and password only.
  const doctor = await open();
  await doctor.goto(base);
  await card(doctor);
  assert.equal(await doctor.$('.title-login__github'), null, 'GitHub sign-in is not offered');
  assert.deepEqual(await doctor.$$eval('.title-login input', (els) => els.map((el) => el.autocomplete)), ['username', 'current-password']);
  await tab(doctor, '注册');
  assert.deepEqual(await doctor.$$eval('.title-login input', (els) => els.map((el) => [el.type, el.autocomplete])),
    [['text', 'username'], ['text', 'off'], ['password', 'new-password'], ['password', 'new-password']]);
  // A mistake shows under its field, and nothing is sent.
  const inputs = await doctor.$$('.title-login input');
  await inputs[0].type('no');
  await send(doctor);
  await doctor.waitForFunction(() => document.querySelector('.title-login .field.is-invalid')?.textContent.includes('用户名为 3–20 位字母、数字或下划线'));
  await clear(inputs[0]);
  await fill(doctor, ['Doctor_01', '晴猫', 'correct horse', 'correct horse']);
  await doctor.waitForSelector('.lobby-screen');
  const registered = await meName(doctor);
  assert.match(registered, /^晴猫#\d{4}$/, 'the lobby shows 昵称#NNNN');

  // A username is taken in any case: said under the field.
  const second = await open();
  await second.goto(base);
  await card(second);
  await tab(second, '注册');
  const taken = await second.$$('.title-login input');
  for (const [i, value] of ['doctor_01', '别人', 'another one', 'another one'].entries()) await taken[i].type(value);
  await send(second);
  await second.waitForFunction(() => document.querySelector('.title-login .field.is-invalid')?.textContent.includes('用户名已被使用'));

  // Log out, then log in (any case of the username); a wrong password is said under the password.
  await click(doctor, '退出登录');
  await card(doctor);
  const login = await doctor.$$('.title-login input');
  await login[0].type('DOCTOR_01');
  await login[1].type('wrong horse');
  await send(doctor);
  await doctor.waitForFunction(() => document.querySelector('.title-login .field.is-invalid')?.textContent.includes('用户名或密码错误'));
  await clear(login[1]);
  await login[1].type('correct horse');
  await Promise.all([doctor.waitForNavigation({ waitUntil: 'load' }), send(doctor)]);
  await doctor.waitForSelector('.lobby-screen');
  assert.equal(await meName(doctor), registered);

  // 修改代号: the dialog, then the lobby shows the new name with the same discriminator (free under it).
  await click(doctor, '修改代号');
  await doctor.waitForSelector('.modal input');
  assert.equal(await doctor.$eval('.modal input', (el) => el.value), '晴猫');
  await clear(await doctor.$('.modal input'));
  await doctor.type('.modal input', '新代号');
  await click(doctor, '确认');
  await doctor.waitForFunction((name) => document.querySelector('.me-chip__name').textContent === name, { timeout: 15000 },
    '新代号#' + registered.split('#')[1]);
  assert.equal(await doctor.$('.modal'), null);

  // 修改密码: another device's login ends, this one stays; the new password logs in.
  const device = await open();
  await device.goto(base);
  await card(device);
  await fill(device, ['doctor_01', 'correct horse']);
  await device.waitForSelector('.lobby-screen');
  await click(doctor, '修改密码');
  await doctor.waitForSelector('.modal input[autocomplete="current-password"]');
  const fields = await doctor.$$('.modal input:not([hidden])');
  for (const [i, value] of ['correct horse', 'battery staple', 'battery staple'].entries()) await fields[i].type(value);
  await click(doctor, '确认');
  await doctor.waitForFunction(() => !document.querySelector('.modal'), { timeout: 15000 });
  assert.equal(await device.evaluate(async () => (await (await fetch('/api/me')).json()).user), null, 'the other login ended');
  assert.equal(await doctor.evaluate(async () => (await (await fetch('/api/me')).json()).user.name), '新代号#' + registered.split('#')[1]);
  await click(doctor, '退出登录');
  await card(doctor);
  await fill(doctor, ['doctor_01', 'battery staple']);
  await doctor.waitForSelector('.lobby-screen');

  // An invite link opened logged out goes on after the password login: the application reaches the host.
  await inMenu(doctor);
  await doctor.evaluate(() => __SP__.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }));
  const code = await doctor.evaluate(() => __SP__.store.get().room.code);
  const friend = await open();
  await friend.goto(`${base}?room=${code}`);
  await card(friend);
  assert.match(await friend.$eval('.title-invite', (el) => el.textContent), new RegExp(`${code}.*登录后申请加入`));
  await tab(friend, '注册');
  await fill(friend, ['friend_02', '好友', 'friend password', 'friend password']);
  await friend.waitForFunction((code) => document.body.innerText.includes(`${code} · 等待房主审批`), { timeout: 15000 }, code);
  await doctor.waitForFunction(() => /好友#\d{4}/.test(document.body.innerText), { timeout: 15000 });
  await click(doctor, '同意');
  await friend.waitForFunction((code) => __SP__.store.get().room?.code === code, { timeout: 15000 }, code);
  const seat = await friend.evaluate(() => __SP__.net.playerId);

  // The friend's login ends elsewhere: the room notices within a minute (its login check), the client stops and offers
  // 重新登录, which leads to the account card; logging in again resumes the seat.
  await friend.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await friend.waitForFunction(() => __SP__.net.status === 'closed', { timeout: 90000 });
  await click(friend, '重新登录');
  await card(friend);
  await fill(friend, ['friend_02', 'friend password']);
  await friend.waitForFunction((code) => globalThis.__SP__?.store.get().room?.code === code && __SP__.net.status === 'online',
    { timeout: 30000 }, code);
  assert.equal(await friend.evaluate(() => __SP__.net.playerId), seat, 'the same seat');
  assert.deepEqual(errors, []);
});
