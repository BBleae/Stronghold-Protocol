import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export { AccountDurableObject } from './worker/accounts/account.js';
import { handleAccountRoutes } from './worker/accounts/routes.js';
import { hash } from './worker/accounts/auth.js';
import { errorResponse } from './worker/http.js';
export default {async fetch(req,env) {
  const input=await req.json(), actor=input.actor || 'a';
  if(input.seed) {
    await env.TEST.get(env.TEST.idFromName('directory')).saveSession(await hash(actor.repeat(64)),
      {accountId:actor,expiresAt:Date.now()+600000});
    return Response.json({ok:true});
  }
  env.SITES=env.TEST;
  // As the Worker answers it: an error ends in its route wrapper (worker/index.js, worker/http.js errorResponse).
  try {
    return await handleAccountRoutes(new Request('https://game.example/api/me/preferences',{
      method:input.method || 'GET',headers:{Origin:'https://game.example',
        cookie:'__Host-sp_session='+actor.repeat(64),...input.headers},
      body:input.raw ?? (input.body ? JSON.stringify(input.body) : undefined)}),env)
      || new Response('missing preferences endpoint',{status:404});
  } catch (error) { return errorResponse(error, {}); }
}};`;

const choices = {loadout:{v:1,entries:{chess_test:{skill:0,module:'none'}}},
  'lobby.mode':'solo','lobby.difficulty':'HARD',recentRooms:['ABCD','EFGH'],emoteTheme:'emoticon_originium_slug'};

test('account preferences survive restart, merge fields, and stay isolated between accounts', {timeout:60000}, async t => {
  const h=await createAccountHarness(source,{durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}}});
  t.after(()=>h.dispose());
  await h.fetch({seed:true});await h.fetch({seed:true,actor:'b'});
  assert.deepEqual(await (await h.fetch({})).json(),{accountId:'a',preferences:null});
  const write=body=>h.fetch({method:'POST',body:{accountId:'a',...body}});
  assert.equal((await write({patch:choices,initialize:true})).status,200);
  // A second device migrating old local values cannot replace an existing cloud profile.
  await write({patch:{'lobby.mode':'coop'},initialize:true});
  await Promise.all([write({patch:{'lobby.difficulty':'ABYSS'}}),write({patch:{emoteTheme:'emoticon_foolsday_amiya'}})]);
  await h.restart();
  assert.deepEqual((await (await h.fetch({})).json()).preferences,
    {...choices,'lobby.difficulty':'ABYSS',emoteTheme:'emoticon_foolsday_amiya'});
  assert.equal((await (await h.fetch({actor:'b'})).json()).preferences,null);
  await write({patch:{loadout:{v:1,entries:{}},recentRooms:[]}});
  assert.deepEqual((await (await h.fetch({})).json()).preferences.loadout,{v:1,entries:{}});
  assert.equal((await write({patch:{recentRooms:['A1B2']}})).status,200,'keep room codes accepted by the lobby');
});

test('preferences require the current account, origin, bounded body, and valid allowlisted values', {timeout:60000},async t=>{
  const h=await createAccountHarness(source,{durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}}});
  t.after(()=>h.dispose());await h.fetch({seed:true});
  const post=(body,headers={})=>h.fetch({method:'POST',body,headers});
  assert.equal((await h.fetch({actor:'c'})).status,401);
  assert.equal((await post({accountId:'a',patch:{}},{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await post({accountId:'b',patch:{'lobby.mode':'solo'}})).status,409);
  assert.equal((await h.fetch({method:'DELETE'})).status,405);
  for(const patch of [{settings:{muted:true}},{'lobby.mode':'unknown'},{'lobby.difficulty':'IMPOSSIBLE'},
    {recentRooms:['ABCD','ABCD']},{recentRooms:['ABCD','EFGH','JKLM','NPQR','STUV']},
    {emoteTheme:'unknown'},{loadout:{v:1,entries:{chess_test:{skill:99}}}},
    {loadout:{v:2,entries:{}}},JSON.parse('{"__proto__":{}}')]) {
    assert.equal((await post({accountId:'a',patch})).status,400,JSON.stringify(patch));
  }
  assert.equal((await h.fetch({method:'POST',raw:'{'})).status,400);
  assert.equal((await h.fetch({method:'POST',raw:' '.repeat(65537)})).status,413);
  assert.equal((await (await h.fetch({})).json()).preferences,null,'invalid writes leave storage unchanged');
});
