import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT,buildWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';
const chrome=process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('account UI on real Workers: lazy lobby, approval, cross-device resume, history and read-only replay',{
  skip:process.env.SP_ACCOUNTS_E2E!=='1' || !existsSync(chrome),timeout:240000,
},async t=>{
  await buildWorker();
  const h=await createAccountHarness(`
    import worker,{RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive};
    import {hash} from './worker/accounts/auth.js';
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname.startsWith('/__test/login/')){
        const actor=u.pathname.split('/').at(-1),token=await hash(crypto.randomUUID());
        const site=env.SITES.get(env.SITES.idFromName('directory'));
        const user=await site.resolveGithubUser({id:String(actor.charCodeAt(0)),login:actor==='a'?'博士 Alice':'博士 Bob',avatarUrl:null});
        await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
        await site.saveSession(await hash(token),{accountId:user.accountId,expiresAt:Date.now()+600000});
        return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':'__Host-sp_session='+token+'; Path=/; Secure; HttpOnly; SameSite=Lax'}});
      }
      if(u.pathname.startsWith('/api/') || u.pathname==='/ws') {
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin','https://game.example');
        return worker.fetch(new Request('https://game.example'+u.pathname+u.search,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `,{durableObjects:Object.fromEntries(['SiteDirectory','AccountDurableObject','RoomDurableObject','MatchArchive'].map((className,i)=>[['SITES','ACCOUNTS','ROOMS','MATCH_ARCHIVES'][i],{className,useSQLite:true}])),ratelimits:productionLimits,
    bindings:{AUTH_ORIGIN:'https://game.example',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture'},assets:path.join(ROOT,'dist/client')});
  t.after(()=>h.dispose());
  const base=String(await h.url()).replace('127.0.0.1','localhost');
  const puppeteer=(await import('puppeteer-core')).default;
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
  const errors=[],out=path.join(ROOT,'test/e2e/out/accounts');await mkdir(out,{recursive:true});
  const player=async actor=>{
    const ctx=await browser.createBrowserContext(),page=await ctx.newPage();
    page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1920,height:1080});
    await page.evaluateOnNewDocument(()=>{localStorage.setItem('stronghold-resource-mode','ondemand');globalThis.__SP_RENDER__='fallback';});
    await page.goto(base+'__test/login/'+actor,{waitUntil:'domcontentloaded'});
    await page.addStyleTag({content:'*,*::before,*::after {animation:none!important;transition:none!important}'});
    try{await page.waitForFunction(()=>globalThis.__SP__?.net.status==='menu',{timeout:15000});}
    catch(e){throw new Error(JSON.stringify({errors,state:await page.evaluate(()=>({text:document.body.innerText,net:globalThis.__SP__?.net.status,url:location.href}))}),{cause:e});}return page;
  };
  const host=await player('a');
  assert.equal(await host.evaluate(()=>__SP__.net.route),null,'viewing the lobby must not allocate a room');
  const call=(page,type,fields={})=>page.evaluate(([t,f])=>__SP__.net.request(t,f),[type,fields]);
  const click=async(page,text)=>{await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===text),{},text);await page.evaluate(text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text).click(),text);};
  for(const [width,height] of [[1920,1080],[1366,768],[844,390]]) {
    await host.setViewport({width,height});await host.screenshot({path:path.join(out,'lobby-'+width+'.png')});
  }
  await host.setViewport({width:1366,height:768});
  await call(host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  const code=await host.evaluate(()=>__SP__.store.get().room.code);
  const guest=await player('b');await call(guest,'room.join',{code});
  await host.waitForFunction(()=>document.body.innerText.includes('博士 Bob'),{timeout:10000});await click(host,'同意');
  await guest.waitForFunction(()=>!!__SP__.store.get().room,{timeout:10000});
  assert.equal(await guest.evaluate(()=>__SP__.store.get().room.code),code);
  await host.screenshot({path:path.join(out,'room.png')});
  await call(guest,'room.leave');await call(host,'room.leave');
  await call(host,'room.create',{mode:'solo',difficulty:'FUNNY'});await call(host,'room.start');
  await host.waitForFunction(()=>__SP__.store.get().match.public?.phase==='INFO_CHECK');
  const pid=await host.evaluate(()=>__SP__.net.playerId);
  const second=await player('a');await click(second,'继续对局');
  await second.waitForFunction(()=>__SP__.store.get().match.public?.phase==='INFO_CHECK');
  assert.equal(await second.evaluate(()=>__SP__.net.playerId),pid);
  await call(second,'g.infoReady');await second.waitForFunction(()=>__SP__.store.get().match.public?.phase==='BAND_DRAFT');
  await call(second,'g.band',{bandId:'band_sarkazb'});await second.waitForFunction(()=>__SP__.store.get().match.public?.phase==='PREP');
  await call(second,'g.ready',{ready:true});
  await second.waitForFunction(()=>__SP__.store.get().match.public?.round===2,{timeout:120000});
  await call(second,'g.leave');await second.evaluate(()=>__SP__.store.patch('ui',{accountPage:'history'}));
  await second.waitForFunction(()=>document.body.innerText.includes('查看详情'),{timeout:20000});
  await second.screenshot({path:path.join(out,'history.png')});await click(second,'查看详情');await click(second,'观看回放');
  await second.waitForFunction(()=>document.querySelector('.replay-screen') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='播放'&&!b.disabled),{timeout:15000});
  const live=await second.evaluate(()=>JSON.stringify(__SP__.store.get().match));
  await click(second,'播放');await new Promise(r=>setTimeout(r,1000));await click(second,'暂停');
  assert.equal(await second.evaluate(()=>JSON.stringify(__SP__.store.get().match)),live);
  await second.screenshot({path:path.join(out,'replay.png')});
  await second.evaluate(()=>__SP__.store.patch('ui',{accountPage:'statistics'}));
  await second.waitForFunction(()=>document.body.innerText.includes('提前离开'));await second.screenshot({path:path.join(out,'statistics.png')});
  assert.deepEqual(errors,[]);
});
