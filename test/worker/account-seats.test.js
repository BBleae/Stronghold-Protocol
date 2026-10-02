import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { createAccountHarness } from './helpers/account-harness.js';
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = [];
  send(s) { this.frames.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008); }
  last(t) { return this.frames.filter(m => m.t === t).at(-1); }
}
test('trusted accounts retain their seat across devices; stolen browser tokens do not cross accounts', () => {
  const rt = new RoomRuntime({accounts: true});
  const ticket = rt.reserve('ABCD','alice');
  const connect = (accountId, token, takeover = false) => {
    const ws = new Socket();
    rt.connect(ws, {accountId, ticket, takeover});
    rt.message(ws, JSON.stringify({t:'hello',name:'Player',token}));
    return ws;
  };
  const a = connect('alice');
  rt.message(a, JSON.stringify({t:'room.create',mode:'coop',difficulty:'FUNNY'}));
  const stolen = connect('bob', a.last('welcome').token);
  assert.notEqual(stolen.last('welcome')?.playerId, a.last('welcome').playerId);
  const accidental = connect('alice');
  assert.equal(accidental.last('error')?.detail, 'resume required');
  const b = connect('alice', undefined, true);
  assert.equal(b.last('welcome').playerId, a.last('welcome').playerId);
  assert.equal(a.closed,4001);
  rt.message(a, JSON.stringify({t:'room.leave'}));
  assert.equal(rt.status().code,'ABCD');
  assert.equal(rt.registry.byId(b.last('welcome').playerId).accountId,'alice');
  const restored = new RoomRuntime({snapshot:rt.snapshot(), accounts:true});
  const fresh = new Socket();
  restored.connect(fresh,{accountId:'alice',takeover:true});
  restored.message(fresh,JSON.stringify({t:'hello',name:'Player'}));
  assert.equal(fresh.last('welcome').playerId,b.last('welcome').playerId);
  rt.network.close(); restored.network.close();
});
test('account seat claims are atomic, persistent and released only by their owner', {timeout:60000}, async t => {
  const h = await createAccountHarness(`
    export {AccountDurableObject as TestObject} from './worker/accounts/account.js';
    export default {async fetch(req,env) {
      const {op,args} = await req.json(); try {
        return Response.json((await env.TEST.get(env.TEST.idFromName('a'))[op](...args)) ?? null);
      } catch(e) {return Response.json({error:e.message},{status:409});}
    }};`);
  t.after(() => h.dispose());
  const call = async (op,...args) => (await h.fetch({op,args})).json();
  await call('setProfile',{accountId:'a',githubId:'42',name:'Alice',avatarUrl:null});
  const expiresAt=Date.now()+60000, seat={roomId:'ABCD',roomGeneration:'g1',matchId:null,seatId:null};
  const claims = await Promise.all(['c1','c2'].map(claimId => call('claimSeat',{claimId,seat,expiresAt})));
  assert.equal(claims.filter(c=>c.ok).length,1);
  await h.restart();
  assert.equal((await call('getProfile')).name,'Alice');
  const active=await call('getActiveSeat');
  assert.equal(active.roomId,'ABCD');
  assert.equal((await call('releaseSeat',{claimId:'wrong'})).ok,false);
  assert.equal((await call('getActiveSeat')).claimId,active.claimId);
  assert.equal((await call('releaseSeat',{claimId:active.claimId})).ok,true);
  assert.equal(await call('getActiveSeat'),null);
});
