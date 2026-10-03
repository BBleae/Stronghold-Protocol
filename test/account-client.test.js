import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRequest, loadAccount } from '../public/js/account.js';
test('account client distinguishes auth failures and loads capability without allocating a room',async()=>{
  const calls=[];
  const fetch=async(url,init)=>{calls.push({url,init});return Response.json({user:{name:'Alice'},capabilities:{accounts:true},activeSeat:null});};
  assert.equal((await loadAccount(fetch)).user.name,'Alice');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/me');
  await accountRequest('/api/auth/logout',{},async()=>new Response(null,{status:204}));
  await assert.rejects(accountRequest('/api/rooms',{},async()=>Response.json({error:'LOGIN_REQUIRED'},{status:401})),/GitHub/);
});
