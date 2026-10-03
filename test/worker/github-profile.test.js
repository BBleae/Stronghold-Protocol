import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';

const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export { AccountDurableObject } from './worker/accounts/account.js';
import { handleAuth } from './worker/accounts/auth.js';
export default {async fetch(req,env) {
  const {path, cookie, profile} = await req.json();
  return handleAuth(new Request('https://game.example' + path, {
    headers: cookie ? {cookie} : {},
  }), {...env, SITES:env.TEST, AUTH_ORIGIN:'https://game.example',
    GITHUB_CLIENT_ID:'fixture', GITHUB_CLIENT_SECRET:'fixture'}, {
    fetch:async url => Response.json(String(url).includes('access_token')
      ? {access_token:'fixture-token'} : profile),
  });
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
