import test from 'node:test';
import assert from 'node:assert/strict';
import { roomApplications } from '../../worker/rooms/routes.js';
import { ApplicationQueue } from '../../worker/rooms/applications.js';
import { createAccountHarness } from './helpers/account-harness.js';

test('a full-room approval keeps the pending application retryable after a reservation is released', async () => {
  const queue = new ApplicationQueue();
  const first = queue.apply({ accountId: 'first', name: 'First' });
  const second = queue.apply({ accountId: 'second', name: 'Second' });
  queue.decide('host', first.id, 'approved', { hostId: 'host', inMatch: false, freeSeats: 1 });
  const releases = [];
  const account = {
    claimSeat: async () => ({ ok: true }), clearApplication: async () => {},
    releaseSeat: async value => { releases.push(value); },
  };
  const rt = {
    code: 'AAAA', generation: 'generation-a', applications: queue,
    lobby: { getRoom: () => ({ mode: 'coop', hostId: 'host-player', match: null, seats: ['host-player', null] }) },
    registry: { byId: () => ({ accountId: 'host' }) },
  };
  const approve = () => roomApplications(rt, new Request('https://room.internal/_applications', {
    method: 'POST', headers: { 'X-Account-ID': 'host', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', id: second.id }),
  }), { ACCOUNTS: { idFromName: id => id, get: () => account } });
  const full = await approve();
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'ROOM_FULL');
  assert.deepEqual(releases, [{ claimId: second.id }]);
  assert.equal(queue.list('second')[0].status, 'pending');
  queue.cancel('first', first.id);
  const retry = await approve();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, 'approved');
});

test('an approval cleanup failure never leaves a usable ticket after compensating the account seat', { timeout: 60000 }, async t => {
  const h = await createAccountHarness(`
    export {AccountDurableObject as TestObject} from './worker/accounts/account.js';
    export default {async fetch(req, env) {
      const {accountId, op, args} = await req.json();
      return Response.json((await env.TEST.get(env.TEST.idFromName(accountId))[op](...args)) ?? null);
    }};`);
  t.after(() => h.dispose());
  t.mock.method(console, 'error', () => {}); // Expected injected RPC errors are logged by the route.
  for (const fault of [null, 'cleanup', 'cleanup-and-release']) {
    await t.test(fault ?? 'successful approval retains its account seat', async () => {
      const accountId = `guest-${fault ?? 'success'}`;
      const call = async (op, ...args) => (await h.fetch({ accountId, op, args })).json();
      const queue = new ApplicationQueue();
      const item = queue.apply({ accountId, name: 'Guest' });
      await call('claimApplication', { roomId: 'AAAA', id: item.id, expiresAt: item.expiresAt });
      let issuedTicket;
      const account = {
        claimSeat: value => call('claimSeat', value),
        async clearApplication(...args) {
          issuedTicket = queue.list(accountId)[0]?.ticket;
          if (fault) throw new Error('synthetic cleanup failure');
          return call('clearApplication', ...args);
        },
        async releaseSeat(value) {
          if (fault === 'cleanup-and-release') throw new Error('synthetic compensation failure');
          return call('releaseSeat', value);
        },
      };
      const rt = {
        code: 'AAAA', generation: 'generation-a', applications: queue,
        lobby: { getRoom: () => ({ mode: 'coop', hostId: 'host-player', match: null, seats: ['host-player', null] }) },
        registry: { byId: () => ({ accountId: 'host' }) },
      };
      const response = await roomApplications(rt, new Request('https://room.internal/_applications', {
        method: 'POST', headers: { 'X-Account-ID': 'host', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', id: item.id }),
      }), { ACCOUNTS: { idFromName: id => id, get: () => account } });
      assert.ok(issuedTicket, 'the cleanup runs after the ticket was issued');
      assert.equal(response.status, fault ? 500 : 200);
      assert.equal(queue.reservedCount(), fault ? 0 : 1);
      const restored = new ApplicationQueue({ snapshot: queue.snapshot() });
      const otherClaim = await call('claimSeat', { claimId: 'other-claim', seat: { roomId: 'BBBB', roomGeneration: 'generation-b' } });
      assert.equal(otherClaim.ok, fault === 'cleanup', 'only a successfully compensated seat can be claimed elsewhere');
      assert.equal(restored.consume(accountId, issuedTicket), !fault, 'a failed approval stays unusable after a room restore');
      assert.equal(queue.consume(accountId, issuedTicket), !fault, 'a failed approval cannot admit the original applicant');
      const active = await call('getActiveSeat');
      assert.equal(active.roomId, fault === 'cleanup' ? 'BBBB' : 'AAAA');
    });
  }
});
