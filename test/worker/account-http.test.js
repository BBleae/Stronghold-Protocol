import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
import { hash } from '../../worker/accounts/auth.js';
test('online room writes require cookie identity and ignore forged account headers', async () => {
  const token='a'.repeat(64), sessionId=await hash(token), calls=[];
  const session={accountId:'alice',expiresAt:Date.now()+60000};
  const env={
    SITES:{idFromName:n=>n,get:()=>({getSession:async key=>key===sessionId?session:null})},
    ACCOUNTS:{idFromName:n=>n,get:()=>({getActiveSeat:async()=>null,claimSeat:async()=>({ok:true}),releaseSeat:async()=>({ok:true})})},
    RESERVE_LIMIT:{limit:async()=>({success:true})},API_LIMIT:{limit:async()=>({success:true})},
    ROOMS:{idFromName:n=>n,get:()=>({fetch:async req=>{calls.push(req);
      return Response.json({code:'ABCD',ticket:'b'.repeat(32),generation:'g1'},{status:201});}})},
  };
  const req=(cookie)=>new Request('https://game.example/api/rooms',{method:'POST',headers:{
    Origin:'https://game.example','X-Account-ID':'mallory',...(cookie?{cookie:'__Host-sp_session='+token}:{})}});
  assert.equal((await worker.fetch(req(false),env)).status,401);
  assert.equal((await worker.fetch(req(true),env)).status,201);
  assert.equal(calls[0].headers.get('X-Account-ID'),'alice');
  assert.equal((await worker.fetch(new Request('https://game.example/api/me/resume',{method:'POST',headers:{
    cookie:'__Host-sp_session='+token,Origin:'https://evil.example'}}),env)).status,403);
});
