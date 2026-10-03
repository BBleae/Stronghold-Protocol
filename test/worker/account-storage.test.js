import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHarness } from './helpers/account-harness.js';
const source = `
export { SiteDirectory as TestObject } from './worker/accounts/directory.js';
export default {async fetch(req,env) {
  const {op,args} = await req.json();
  const stub = env.TEST.get(env.TEST.idFromName('directory'));
  return Response.json((await stub[op](...args)) ?? null);
}};
`;
test('identities and revocations persist; OAuth is atomically consumed once', {timeout:60000}, async t => {
  const h = await createAccountHarness(source); t.after(() => h.dispose());
  const call = async (op,...args) => (await h.fetch({op,args})).json();
  const a = await call('resolveGithubUser', {id:'42',login:'Alice',avatarUrl:null});
  await call('saveOAuth', 'a'.repeat(64), {verifier:'v',expiresAt:Date.now()+600000});
  const consumed = await Promise.all([call('consumeOAuth','a'.repeat(64)),call('consumeOAuth','a'.repeat(64))]);
  assert.equal(consumed.filter(Boolean).length,1);
  await call('saveSession','b'.repeat(64),{accountId:a.accountId,expiresAt:Date.now()+600000});
  await h.restart();
  assert.equal((await call('resolveGithubUser',{id:'42',login:'Renamed',avatarUrl:null})).accountId,a.accountId);
  assert.equal((await call('getSession','b'.repeat(64))).accountId,a.accountId);
  await call('revokeSession','b'.repeat(64));
  await h.restart();
  assert.equal(await call('getSession','b'.repeat(64)),null);
  const now=Date.now();
  await call('publishRoom',{roomId:'ABCD',generation:'g1',public:true,connectedHumans:1,occupied:1,capacity:4,inMatch:false,hostName:'Alice',difficulty:'FUNNY',updatedAt:now,expiresAt:now+60000});
  await call('publishRoom',{roomId:'EFGH',generation:'g2',public:true,connectedHumans:0,occupied:2,capacity:4,inMatch:false,updatedAt:now,expiresAt:now+60000});
  assert.deepEqual((await call('listRooms',{})).items.map(r=>r.roomId),['ABCD']);
  await call('publishRoom',{roomId:'ABCD',generation:'g1',public:false,connectedHumans:1,occupied:1,capacity:4,inMatch:false,updatedAt:now+1,expiresAt:now+60000});
  assert.equal((await call('listRooms',{})).items.length,0);
  await call('publishRoom',{roomId:'EFGH',generation:'g2',public:true,connectedHumans:0,occupied:2,capacity:4,inMatch:true,updatedAt:now+2,expiresAt:now+60000});
  assert.deepEqual((await call('listRooms',{})).items.map(r=>r.roomId),['EFGH'],'active public matches remain watchable while players reconnect');
});
