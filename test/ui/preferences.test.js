import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences } from '../../public/js/preferences.js';

const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
const timers={setTimeout:()=>1,clearTimeout:()=>{}};
function cloud() {
  const accounts=new Map(),calls=[];
  return {accounts,calls,forAccount:accountId=>async body=>{
    calls.push(body);
    if(body && (!body.initialize || !accounts.has(accountId))) accounts.set(accountId,{...(accounts.get(accountId)||{}),...body.patch});
    return {accountId,preferences:accounts.get(accountId)??null};
  }};
}
const client=(local,request)=>createPreferences({storage:()=>local,request,timers});

test('first login migrates only selected preferences; a clean second device restores them',async()=>{
  const local=storage(),server=cloud();
  const expected={loadout:{v:1,entries:{chess_test:{skill:0,module:'none'}}},'lobby.mode':'solo',
    'lobby.difficulty':'HARD',recentRooms:['ABCD'],emoteTheme:'emoticon_originium_slug'};
  for(const [key,value] of Object.entries({...expected,settings:{muted:true}}))local.setItem('sp.pref.'+key,JSON.stringify(value));
  const first=client(local,server.forAccount('a'));await first.start('a');
  assert.deepEqual(server.accounts.get('a'),expected);
  const second=client(storage(),server.forAccount('a'));await second.start('a');
  for(const [key,value] of Object.entries(expected))assert.deepEqual(second.load(key,null),value);
  assert.equal(second.load('settings',null),null);
  second.save('lobby.difficulty','ABYSS');await second.flush();
  assert.equal(server.accounts.get('a')['lobby.difficulty'],'ABYSS');
  assert.deepEqual(server.accounts.get('a').loadout,expected.loadout);
  second.save('loadout',{v:1,entries:{}});await second.flush();
  assert.deepEqual(server.accounts.get('a').loadout,{v:1,entries:{}});
});

test('cloud wins over old local values; switching accounts cannot migrate someone else’s choices',async()=>{
  const local=storage(),server=cloud();local.setItem('sp.pref.lobby.mode','"solo"');
  server.accounts.set('a',{'lobby.mode':'coop'});
  await client(local,server.forAccount('a')).start('a');
  const b=client(local,server.forAccount('b'));await b.start('b');
  assert.equal(b.load('lobby.mode','coop'),'coop');assert.deepEqual(server.accounts.get('b'),{});
  const again=client(local,server.forAccount('a'));await again.start('a');
  assert.equal(again.load('lobby.mode',null),'coop');
});

test('offline edits survive reload, recovery merges cloud fields, and account mismatch never sends edits',async()=>{
  const local=storage(),server=cloud();server.accounts.set('a',{'lobby.mode':'solo',emoteTheme:'emoticon_originium_slug'});
  const down=client(local,async()=>{throw new Error('offline');});await down.start('a');
  down.save('lobby.difficulty','HARD');await down.flush();
  const recovered=client(local,server.forAccount('a'));await recovered.start('a');await recovered.flush();
  assert.deepEqual(server.accounts.get('a'),{'lobby.mode':'solo','lobby.difficulty':'HARD',emoteTheme:'emoticon_originium_slug'});
  const writes=[];
  const mismatch=client(local,async body=>{writes.push(body);return {accountId:'b',preferences:{}};});
  await mismatch.start('a');mismatch.save('lobby.mode','coop');await mismatch.flush();
  assert.equal(writes.filter(Boolean).length,0);
});

test('a newer edit during a save is sent afterwards and a failed save retries',async()=>{
  const server=cloud(),local=storage();server.accounts.set('a',{});
  let release,fail=false;
  const c=client(local,async body=>{
    if(body && !release)await new Promise(resolve=>{release=resolve;});
    if(fail){fail=false;throw new Error('offline');}
    return server.forAccount('a')(body);
  });
  await c.start('a');c.save('lobby.difficulty','NORMAL');const saving=c.flush();
  await Promise.resolve();c.save('lobby.difficulty','ABYSS');release();await saving;
  assert.equal(server.accounts.get('a')['lobby.difficulty'],'ABYSS');
  fail=true;c.save('lobby.mode','solo');await c.flush();assert.equal(c.status,'error');
  await c.flush();assert.equal(server.accounts.get('a')['lobby.mode'],'solo');assert.equal(c.status,'synced');
});

test('guest/local mode keeps ordinary preferences usable without network or storage',async()=>{
  const local=storage(),c=client(local,()=>assert.fail('guest must not use account API'));
  c.save('settings',{muted:true});c.save('lobby.mode','solo');
  assert.deepEqual(c.load('settings',null),{muted:true});assert.equal(c.load('lobby.mode',null),'solo');
  const noStorage=createPreferences({storage:()=>{throw new Error('disabled');},timers});
  assert.doesNotThrow(()=>noStorage.save('settings',{muted:true}));
});

test('repeated outages notify once, and late recovery updates preference subscribers',async()=>{
  const server=cloud(),notifications=[],changes=[];server.accounts.set('a',{'lobby.mode':'solo'});
  let offline=true;
  const c=createPreferences({storage:()=>storage(),timers,onError:e=>notifications.push(e.message),
    request:body=>{if(offline)throw new Error('offline');return server.forAccount('a')(body);}});
  c.subscribe(key=>changes.push(key));
  await c.start('a');await c.flush();await c.flush();
  assert.equal(notifications.length,1);
  changes.length=0;offline=false;await c.flush();
  assert.ok(changes.includes('lobby.mode'));assert.equal(c.load('lobby.mode',null),'solo');
});
