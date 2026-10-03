import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export { AccountDurableObject } from './worker/accounts/account.js';
import { handleAuth, hash } from './worker/accounts/auth.js';
export default {async fetch(req,env) {
  const {path, cookie, profile, legacy, providerStatus=200, providerThrows=false} = await req.json();
  if (legacy) {
    const site=env.TEST.get(env.TEST.idFromName('directory'));
    const saved=await site.resolveGithubUser({id:'42',login:'BBleae',avatarUrl:'https://avatars.githubusercontent.com/u/42?v=4'});
    const {githubLogin,...user}=saved;
    await site.restoreProfile(user,false);
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
    const token='a'.repeat(64);
    await site.saveSession(await hash(token),{accountId:user.accountId,expiresAt:Date.now()+600000});
    return Response.json({cookie:'__Host-sp_session='+token,user});
  }
  const calls=[];
  const response=await handleAuth(new Request('https://game.example' + path, {
    headers: cookie ? {cookie} : {},
  }), {...env, SITES:env.TEST, AUTH_ORIGIN:'https://game.example',
    GITHUB_CLIENT_ID:'fixture', GITHUB_CLIENT_SECRET:'fixture'}, {
    fetch:async url => {
      calls.push(String(url));
      if(providerThrows)throw new Error('provider unavailable');
      return Response.json(String(url).includes('access_token')
        ? {access_token:'fixture-token'} : profile,{status:providerStatus});
    },
  });
  response.headers.set('X-Test-Github-Calls',JSON.stringify(calls));
  return response;
}};
`;

test('GitHub profile names and avatars survive login, account storage and subsequent logins', {timeout:60000}, async t => {
  const h = await createAccountHarness(source, {
    durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}},
  });
  t.after(() => h.dispose());
  const request = body => h.request('https://test.example/', {
    method:'POST',body:JSON.stringify(body),redirect:'manual',
  });
  const avatar = 'https://avatars.githubusercontent.com/u/42?v=4';
  const login = async profile => {
    const start = await request({path:'/api/auth/github/start'});
    assert.equal(start.status,302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const done = await request({path:'/api/auth/github/callback?code=fixture&state=' + state,
      cookie:start.headers.get('set-cookie').split(';')[0], profile});
    assert.equal(done.status,303);
    return done.headers.get('set-cookie').split(';')[0];
  };
  const me = async cookie => (await (await request({path:'/api/me',cookie})).json()).user;
  const cookie = await login({id:42,login:'BBleae',name:'  晴猫  ',avatar_url:avatar});
  const first = await me(cookie);
  assert.equal(first.name,'晴猫');
  assert.equal(first.avatarUrl,avatar);
  assert.equal(first.githubId,'42');

  await h.restart();
  assert.deepEqual(await me(cookie),first,'the display profile persists across a restart');
  await login({id:42,login:'renamed-handle',name:'新的名字',avatar_url:avatar + '&s=96'});
  const updated = await me(cookie);
  assert.equal(updated.accountId,first.accountId,'profile changes must not create a new account');
  assert.equal(updated.name,'新的名字','existing sessions read the refreshed profile');
  assert.equal(updated.avatarUrl,avatar + '&s=96');

  for (const name of [null,undefined,'','   ',123]) {
    await login({id:42,login:'BBleae',name,avatar_url:avatar});
    assert.equal((await me(cookie)).name,'BBleae','missing or empty Name falls back to the handle');
  }
  await login({id:42,login:'BBleae',name:'猫'.repeat(90),avatar_url:avatar});
  assert.equal((await me(cookie)).name,'猫'.repeat(80),'stored names respect the existing profile limit');
});

test('existing sessions refresh legacy GitHub names once without signing in again', {timeout:60000}, async t => {
  const h=await createAccountHarness(source,{durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}}});
  t.after(()=>h.dispose());
  const {cookie,user}=await (await h.fetch({legacy:true})).json();
  const response=await h.fetch({path:'/api/me',cookie,
    profile:{id:42,login:'BBleae',name:'晴猫',avatar_url:user.avatarUrl}});
  assert.equal(response.status,200);
  const refreshed=(await response.json()).user;
  assert.equal(refreshed.name,'晴猫');
  assert.equal(refreshed.accountId,user.accountId);
  assert.equal(refreshed.avatarUrl,user.avatarUrl);
  assert.deepEqual(JSON.parse(response.headers.get('X-Test-Github-Calls')),['https://api.github.com/user/42']);
  await h.restart();
  const cached=await h.fetch({path:'/api/me',cookie,providerThrows:true});
  assert.deepEqual((await cached.json()).user,refreshed);
  assert.deepEqual(JSON.parse(cached.headers.get('X-Test-Github-Calls')),[]);
});

test('legacy profile refresh keeps login usable on GitHub failures and rejects a different identity', {timeout:60000}, async t => {
  const h=await createAccountHarness(source,{durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}}});
  t.after(()=>h.dispose());
  const {cookie,user}=await (await h.fetch({legacy:true})).json();
  for(const failure of [{providerStatus:503},{providerThrows:true},{profile:{id:99,login:'someone-else',name:'Wrong account'}}]) {
    const response=await h.fetch({path:'/api/me',cookie,...failure});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).user,user);
  }
  const emptyName=await h.fetch({path:'/api/me',cookie,profile:{id:42,login:'BBleae',name:null,avatar_url:user.avatarUrl}});
  assert.equal((await emptyName.json()).user.name,'BBleae');
  const cached=await h.fetch({path:'/api/me',cookie,providerThrows:true});
  assert.equal((await cached.json()).user.name,'BBleae');
  assert.deepEqual(JSON.parse(cached.headers.get('X-Test-Github-Calls')),[],'a valid profile with no Name does not keep fetching');
});
