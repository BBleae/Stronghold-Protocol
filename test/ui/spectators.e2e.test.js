import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT,buildWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';
const chrome=process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('public spectator UI: live board, presence, read-only controls and restart recovery',{
  skip:process.env.SP_SPECTATORS_E2E!=='1' || !existsSync(chrome),timeout:240000,
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
        const user=await site.resolveGithubUser({id:String(actor.charCodeAt(0)),login:actor==='a'?'博士 Alice':'博士 Bob',avatarUrl:'https://avatars.githubusercontent.com/u/123?v=4'});
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
  const errors=[],out=path.join(ROOT,'test/e2e/out/spectators');await mkdir(out,{recursive:true});
  const player=async actor=>{
    const ctx=await browser.createBrowserContext(),page=await ctx.newPage();
    await page.setRequestInterception(true);
    page.on('request',req=>req.url().startsWith('https://avatars.githubusercontent.com/')
      ? req.respond({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>'}) : req.continue());
    page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1920,height:1080});
    await page.evaluateOnNewDocument(()=>{localStorage.setItem('stronghold-resource-mode','ondemand');globalThis.__SP_RENDER__='fallback';});
    await page.goto(base+'__test/login/'+actor,{waitUntil:'domcontentloaded'});
    await page.addStyleTag({content:'*,*::before,*::after {animation:none!important;transition:none!important}'});
    try{await page.waitForFunction(()=>globalThis.__SP__?.net.status==='menu',{timeout:15000});}
    catch(e){throw new Error(JSON.stringify({errors,state:await page.evaluate(()=>({text:document.body.innerText,net:globalThis.__SP__?.net.status,url:location.href}))}),{cause:e});}return page;
  };

  const host=await player('a');
  const call=(page,type,fields={})=>page.evaluate(([t,f])=>__SP__.net.request(t,f),[type,fields]);
  const click=async(page,text)=>{await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===text&&!b.disabled),{},text);await page.evaluate(text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text).click(),text);};
  await call(host,'room.create',{mode:'coop',difficulty:'FUNNY'});
  for(let i=0;i<3;i++)await call(host,'room.addBot');
  await host.waitForFunction(()=>document.querySelectorAll('.seat .avatar__img img').length===4 && [...document.querySelectorAll('.seat .avatar__img img')].every(img=>img.complete&&img.naturalWidth>0));
  assert.match(await host.$eval('.seat.is-me .avatar__img img',img=>img.src),/avatars.githubusercontent.com/);
  for(const [name,part] of [['华法琳','char_171_bldsk'],['阿米娅','band_amiya'],['惊蛰','char_306_leizi']]) {
    assert.ok(await host.evaluate(([name,part])=>[...document.querySelectorAll('.seat')].some(s=>s.textContent.includes(name)&&s.querySelector('img')?.src.includes(part)),[name,part]));
  }
  await host.screenshot({path:path.join(out,'room-avatars.png')});
  for(let seat=1;seat<=3;seat++)await call(host,'room.removeBot',{seat});
  await call(host,'room.start');
  const code=await host.evaluate(()=>__SP__.store.get().room.code);
  const viewer=await player('b');
  await click(viewer,'进入观战');
  await viewer.waitForFunction(()=>__SP__.store.get().room?.spectating);
  await host.waitForFunction(()=>document.querySelector('.spectator-presence')?.textContent.includes('1 人观战'));
  const second=await player('c');await click(second,'进入观战');
  await viewer.waitForFunction(()=>document.querySelector('.spectator-presence')?.textContent.includes('2 人观战'));
  assert.equal(await viewer.evaluate(()=>__SP__.store.get().match.private),null);
  assert.equal(await viewer.evaluate(()=>__SP__.store.get().room.seats.filter(Boolean).length),1);
  await call(host,'g.infoReady');
  await host.waitForFunction(()=>__SP__.store.get().match.public?.phase==='BAND_DRAFT');
  await host.waitForFunction(()=>document.querySelector('.pavatar__img img')?.src.includes('avatars.githubusercontent.com') && document.querySelector('.pavatar__img img').naturalWidth>0);
  await host.screenshot({path:path.join(out,'draft-avatars.png')});
  await call(host,'g.band',{bandId:'band_sarkazb'});
  await viewer.waitForFunction(()=>__SP__.store.get().match.public?.phase==='PREP',{timeout:30000});
  await viewer.waitForFunction(()=>!!__SP__.store.get().match.field?.fieldId);
  assert.equal(await viewer.evaluate(()=>!!document.querySelector('[data-testid="ready"]')),false);
  await viewer.screenshot({path:path.join(out,'prep.png')});
  await click(second,'退出观战');
  await host.waitForFunction(()=>__SP__.store.get().room?.spectatorCount===1);
  await call(host,'g.ready',{ready:true});
  await viewer.waitForFunction(()=>__SP__.store.get().match.battle?.watch===true,{timeout:30000});
  assert.equal(await viewer.evaluate(()=>__SP__.store.get().match.battle.authoritative),false);
  await viewer.screenshot({path:path.join(out,'combat.png')});
  const playerId=await host.evaluate(()=>__SP__.net.playerId);
  await h.restart();
  await host.waitForFunction(()=>__SP__.net.status==='online' && !!__SP__.store.get().room?.inMatch,{timeout:30000});
  await viewer.waitForFunction(()=>__SP__.net.status==='online' && __SP__.store.get().room?.spectating && !!__SP__.store.get().match.public,{timeout:30000});
  assert.equal(await host.evaluate(()=>__SP__.net.playerId),playerId);
  await click(viewer,'退出观战');
  await host.waitForFunction(()=>__SP__.store.get().room?.spectatorCount===0);
  assert.equal(await host.evaluate(()=>__SP__.store.get().room.inMatch),true);
  assert.deepEqual(errors,[]);
});
