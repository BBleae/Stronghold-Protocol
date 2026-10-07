import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { roomApplications } from '../../worker/rooms/routes.js';
import { ApplicationQueue } from '../../worker/rooms/applications.js';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { RoomDurableObject } from '../../worker/index.js';
import { clearStaleApplication, seatOf } from '../../worker/accounts/routes.js';
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

// The account's seat is claimed before the ticket is issued, so once the ticket exists the account cannot take a seat
// elsewhere: clearing its application record afterwards is a cleanup whose failure changes nothing of the approval.
test('an approval stands once its ticket is issued: a failed cleanup neither revokes it nor releases its seat', { timeout: 60000 }, async t => {
  const h = await createAccountHarness(`
    export {AccountDurableObject as TestObject} from './worker/accounts/account.js';
    export default {async fetch(req, env) {
      const {accountId, op, args} = await req.json();
      return Response.json((await env.TEST.get(env.TEST.idFromName(accountId))[op](...args)) ?? null);
    }};`);
  t.after(() => h.dispose());
  t.mock.method(console, 'warn', () => {}); // Expected injected RPC errors are logged by the route.
  for (const fault of [null, 'cleanup', 'cleanup-and-release']) {
    await t.test(fault ?? 'successful approval retains its account seat', async () => {
      const accountId = `guest-${fault ?? 'success'}`;
      const call = async (op, ...args) => (await h.fetch({ accountId, op, args })).json();
      const queue = new ApplicationQueue();
      const item = queue.apply({ accountId, name: 'Guest' });
      await call('claimApplication', { roomId: 'AAAA', id: item.id, expiresAt: item.expiresAt });
      let ticketAtClaim, issuedTicket, released = false;
      const account = {
        claimSeat(value) {
          ticketAtClaim = queue.list(accountId)[0]?.ticket;
          return call('claimSeat', value);
        },
        async clearApplication(...args) {
          issuedTicket = queue.list(accountId)[0]?.ticket;
          if (fault) throw new Error('synthetic cleanup failure');
          return call('clearApplication', ...args);
        },
        async releaseSeat(value) {
          released = true;
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
      assert.equal(ticketAtClaim, undefined, 'the seat is claimed before the ticket is issued');
      assert.ok(issuedTicket, 'the cleanup runs after the ticket was issued');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ticket, issuedTicket);
      assert.equal(released, false, 'an approval never gives its seat back');
      assert.equal(queue.reservedCount(), 1);
      const restored = new ApplicationQueue({ snapshot: queue.snapshot() });
      const otherClaim = await call('claimSeat', { claimId: 'other-claim', seat: { roomId: 'BBBB', roomGeneration: 'generation-b' } });
      assert.equal(otherClaim.ok, false, 'the approved account cannot take a seat elsewhere');
      assert.equal(restored.consume(accountId, issuedTicket), true, 'the approval survives a room restore');
      assert.equal(queue.consume(accountId, issuedTicket), true, 'the approval admits its applicant');
      assert.equal((await call('getActiveSeat')).roomId, 'AAAA');
    });
  }
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = [];
  send(s) { this.frames.push(JSON.parse(s)); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1008); }
}

// Every failure point of applying, approving, rejecting and cancelling, against a real AccountDurableObject (in
// workerd) and a real room (RoomRuntime and its internal routes). A fault makes the nth call of an account method in
// the request throw, before the account ran it ('before') or after it ran with its answer lost ('after'); `meanwhile`
// changes the account just before the call (a concurrent request). Whatever fails, an account never holds two seats
// (admitted here and seated elsewhere), no pending item outlives its account record, and the step can be retried.
test('application faults: no double seat, no orphaned pending item, every step retryable', { timeout: 120000 }, async (t) => {
  const h = await createAccountHarness(`
    export {AccountDurableObject as TestObject} from './worker/accounts/account.js';
    export default {async fetch(req, env) {
      const {accountId, op, args} = await req.json();
      return Response.json((await env.TEST.get(env.TEST.idFromName(accountId))[op](...args)) ?? null);
    }};`);
  t.after(() => h.dispose());
  const warnings = [];
  t.mock.method(console, 'warn', (line) => warnings.push(line));
  t.mock.method(console, 'error', () => {}); // a 500 answer is logged by the route (request_failed)
  const cleanupWarned = (op) => warnings.some((x) => x.event === 'application_cleanup_failed' && x.op === op);
  let serial = 0;

  // A co-op room 'ABCD' of the account 'host' (4 seats: 3 free) and one applicant, whose account calls go through
  // the request's faults and are counted in `calls`.
  async function world() {
    let now = Date.now();
    const rt = new RoomRuntime({ now: () => now });
    t.after(() => rt.lobby.shutdown());
    const host = new Socket();
    rt.connect(host, { accountId: 'host', ticket: rt.reserve('ABCD', 'host'), name: 'Host' });
    rt.message(host, JSON.stringify({ t: 'hello', name: 'Host' }));
    rt.message(host, JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' }));
    const accountId = `guest-${++serial}`;
    const rpc = async (op, ...args) => (await h.fetch({ accountId, op, args })).json();
    let faults = [];
    const calls = [];
    const applicant = new Proxy({}, { get: (_, op) => async (...args) => {
      calls.push(op);
      const nth = calls.filter((x) => x === op).length;
      const fault = faults.find((f) => f.op === op && (f.nth ?? 1) === nth);
      await fault?.meanwhile?.();
      if (!fault?.when) return rpc(op, ...args);
      if (fault.when === 'after') await rpc(op, ...args);
      throw new Error(`injected ${op} failure (${fault.when})`);
    } });
    const env = {
      ACCOUNTS: { idFromName: (id) => id, get: (id) => (id === accountId ? applicant : {}) },
      // The room's own routes answer for 'ABCD'; every other room is gone (seatOf releases its seats).
      ROOMS: { idFromName: (code) => code, get: (code) => ({ fetch: async (request) => code === 'ABCD'
        ? RoomDurableObject.prototype.route.call({ runtime: rt, env }, request)
        : Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 }) }) },
    };
    const post = async (who, body, requestFaults = []) => {
      faults = requestFaults;
      calls.length = 0;
      const response = await roomApplications(rt, new Request('https://room.internal/_applications', {
        method: 'POST', headers: { 'X-Account-ID': who, 'X-Account-Name': 'Guest', 'Content-Type': 'application/json' },
        body: JSON.stringify(body) }), env);
      faults = [];
      return { status: response.status, body: await response.json() };
    };
    return {
      rt, env, accountId, rpc, calls,
      advance: (ms) => { now += ms; },
      start: () => rt.message(host, JSON.stringify({ t: 'room.start' })),
      apply: (faults) => post(accountId, { action: 'apply' }, faults),
      approve: (id, faults) => post('host', { action: 'approve', id }, faults),
      reject: (id, faults) => post('host', { action: 'reject', id }, faults),
      cancel: (id, faults) => post(accountId, { action: 'cancel', id }, faults),
      item: () => rt.applications.list(accountId)[0],
      // Three other applicants approved: every free seat is reserved.
      fill: () => Array.from({ length: 3 }, (_, i) => {
        const other = rt.applications.apply({ accountId: `${accountId}-filler-${i}`, name: 'F' });
        return rt.applications.decide('host', other.id, 'approved', { hostId: 'host', inMatch: false, freeSeats: 3 });
      }),
      // room.join with the ticket: whether the approval admits the applicant.
      join(ticket) {
        const ws = new Socket();
        rt.connect(ws, { accountId, ticket, name: accountId });
        rt.message(ws, JSON.stringify({ t: 'hello', name: accountId }));
        rt.message(ws, JSON.stringify({ t: 'room.join', code: 'ABCD', rid: 7 }));
        const answer = ws.frames.find((x) => x.rid === 7);
        return answer?.t === 'ok' ? 'JOINED' : answer?.code;
      },
      // A seat in another room, taken the Worker's way (POST /api/rooms): only when seatOf finds none.
      async seatElsewhere() {
        if (await seatOf(env, accountId)) return 'ALREADY_SEATED';
        const claim = await rpc('claimSeat', { claimId: `elsewhere-${accountId}`, seat: { roomId: 'BBBB', roomGeneration: 'gb' } });
        return claim.ok ? 'SEATED' : claim.error;
      },
      seatedMeanwhile: () => rpc('claimSeat', { claimId: 'meanwhile', seat: { roomId: 'ZZZZ', roomGeneration: 'gz' } }),
    };
  }
  // An application as handleLobbyRoutes forwards it to the room.
  async function applied(w) {
    const response = await w.apply();
    assert.equal(response.status, 201);
    return response.body;
  }

  await t.test('deciding fails (ROOM_FULL): it stays pending, its claim goes, a free seat approves it', async () => {
    for (const release of [null, 'before', 'after']) {
      const w = await world();
      const item = await applied(w);
      const [freed] = w.fill();
      warnings.length = 0;
      const full = await w.approve(item.id, release ? [{ op: 'releaseSeat', when: release }] : []);
      assert.deepEqual(full, { status: 409, body: { error: 'ROOM_FULL' } }, `releaseSeat ${release ?? 'ok'}`);
      assert.deepEqual(w.calls, ['claimSeat', 'releaseSeat']);
      assert.equal(cleanupWarned('releaseSeat'), release !== null);
      assert.equal(w.item().status, 'pending');
      assert.equal(w.item().ticket, undefined);
      // A claim whose release failed is not one the room confirms: whoever reads it next releases it.
      assert.equal(await seatOf(w.env, w.accountId), null);
      assert.equal(await w.rpc('getActiveSeat'), null);
      w.rt.applications.cancel(freed.accountId, freed.id);
      const retry = await w.approve(item.id);
      assert.equal(retry.status, 200);
      assert.equal(w.join(retry.body.ticket), 'JOINED');
      assert.equal(await w.seatElsewhere(), 'ALREADY_SEATED');
    }
  });

  await t.test('claiming the seat fails: it stays pending and a retry approves it', async () => {
    for (const when of ['before', 'after']) {
      const w = await world();
      const item = await applied(w);
      const failed = await w.approve(item.id, [{ op: 'claimSeat', when }]);
      assert.equal(failed.status, 500, when);
      assert.equal(w.item().status, 'pending');
      // A claim stored before its answer was lost is not confirmed by the room either.
      assert.equal(await seatOf(w.env, w.accountId), null);
      const retry = await w.approve(item.id);
      assert.equal(retry.status, 200);
      assert.equal(w.join(retry.body.ticket), 'JOINED');
      assert.equal(await w.seatElsewhere(), 'ALREADY_SEATED');
    }
  });

  await t.test('the applicant took a seat elsewhere: APPLICANT_BUSY ends the application', async () => {
    const w = await world();
    const item = await applied(w);
    await w.seatedMeanwhile();
    assert.deepEqual(await w.approve(item.id), { status: 409, body: { error: 'APPLICANT_BUSY' } });
    assert.equal(w.item().status, 'expired');
    assert.equal((await w.rpc('getActiveSeat')).roomId, 'ZZZZ');
  });

  await t.test('the cleanup after an approval fails: the approval stands and admits the applicant once', async () => {
    for (const faults of [[{ op: 'clearApplication', when: 'before' }], [{ op: 'clearApplication', when: 'after' }],
      [{ op: 'clearApplication', when: 'before' }, { op: 'releaseSeat', when: 'before' }]]) {
      const label = faults.map((f) => `${f.op} ${f.when}`).join(' + ');
      const w = await world();
      const item = await applied(w);
      warnings.length = 0;
      const approved = await w.approve(item.id, faults);
      assert.equal(approved.status, 200, label);
      assert.equal(approved.body.status, 'approved');
      assert.deepEqual(w.calls, ['claimSeat', 'clearApplication'], 'claimed before the ticket, never released');
      assert.equal(cleanupWarned('clearApplication'), true);
      assert.equal(w.rt.applications.reservedCount(), 1);
      // The room confirms the seat: the account cannot take another while the approval holds.
      assert.equal((await seatOf(w.env, w.accountId))?.activeSeat.roomId, 'ABCD');
      assert.equal(await w.seatElsewhere(), 'ALREADY_SEATED');
      const restored = new ApplicationQueue({ snapshot: w.rt.applications.snapshot() });
      assert.equal(restored.list(w.accountId)[0].ticket, approved.body.ticket, 'the approval survives a room restore');
      assert.equal(w.join(approved.body.ticket), 'JOINED');
      assert.deepEqual([w.item().status, w.item().ticket], ['joined', undefined], 'a ticket admits once');
      // An application record left behind is dropped before the account applies again.
      await clearStaleApplication(w.env, w.accountId);
      assert.equal(await w.rpc('getApplication'), null);
    }
  });

  await t.test('the cleanup after a rejection fails: it is still answered as rejected', async () => {
    const w = await world();
    const item = await applied(w);
    const rejected = await w.reject(item.id, [{ op: 'clearApplication', when: 'before' }]);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'rejected');
    assert.deepEqual(await w.approve(item.id), { status: 409, body: { error: 'APPLICATION_EXPIRED' } });
    await clearStaleApplication(w.env, w.accountId);
    assert.equal(await w.rpc('getApplication'), null);
    assert.equal((await w.apply()).status, 201, 'the account applies again');
  });

  await t.test('linking the item to the account record fails: the room keeps no pending item', async () => {
    for (const faults of [[{ op: 'claimApplication', nth: 2, when: 'before' }], [{ op: 'claimApplication', nth: 2, when: 'after' }],
      [{ op: 'claimApplication', nth: 2, when: 'before' }, { op: 'clearApplication', when: 'before' }]]) {
      const label = faults.map((f) => `${f.op} ${f.when}`).join(' + ');
      const w = await world();
      const failed = await w.apply(faults);
      assert.equal(failed.status, 500, label);
      assert.deepEqual(w.calls, ['claimApplication', 'claimApplication', 'clearApplication']);
      const orphan = w.item();
      assert.equal(orphan.status, 'expired', 'no pending item without its account record');
      assert.deepEqual(await w.approve(orphan.id), { status: 409, body: { error: 'APPLICATION_EXPIRED' } });
      // A record whose clearing failed too is one the room no longer lists as live: dropped before the next apply.
      await clearStaleApplication(w.env, w.accountId);
      assert.equal(await w.rpc('getApplication'), null);
      const again = await applied(w);
      assert.notEqual(again.id, orphan.id);
      const approved = await w.approve(again.id);
      assert.equal(approved.status, 200);
      assert.equal(w.join(approved.body.ticket), 'JOINED');
    }
  });

  await t.test('re-applying with a lost first-claim answer: the record keeps holding the pending item', async () => {
    const w = await world();
    const item = await applied(w);
    // a retry of the apply (its answer lost, a deep link, a second tab): the first claim reaches the account, its
    // answer does not — the record no longer names the item, and the room still holds it pending
    const failed = await w.apply([{ op: 'claimApplication', nth: 1, when: 'after' }]);
    assert.equal(failed.status, 500);
    assert.deepEqual(w.calls, ['claimApplication']);
    assert.equal(w.item().status, 'pending');
    assert.equal((await w.rpc('getApplication')).id, undefined);
    // the next apply elsewhere: the record stands for the pending item, so the one-application limit holds
    await clearStaleApplication(w.env, w.accountId);
    assert.equal((await w.rpc('getApplication'))?.roomId, 'ABCD', 'the record is kept while its room lists a live item');
    assert.deepEqual(await w.rpc('claimApplication', { roomId: 'BBBB', expiresAt: Date.now() + 120000 }), { ok: false, error: 'APPLICATION_PENDING' });
    // once the item ends the record goes with it
    w.advance(120_001);
    assert.equal(w.item().status, 'expired');
    await clearStaleApplication(w.env, w.accountId);
    assert.equal(await w.rpc('getApplication'), null);
    // an apply to the same room relinks the item (and an approval admits once)
    const again = await applied(w);
    assert.equal((await w.rpc('getApplication')).id, again.id);
  });

  await t.test('the account took a seat between the two claims: the application ends at once', async () => {
    const w = await world();
    const refused = await w.apply([{ op: 'claimApplication', nth: 2, meanwhile: w.seatedMeanwhile }]);
    assert.deepEqual(refused, { status: 409, body: { error: 'ALREADY_SEATED' } });
    assert.equal(w.item().status, 'expired');
    assert.equal(await w.rpc('getApplication'), null);
  });

  await t.test('cancelling an application that already ended calls no account', async () => {
    const ended = {
      expired: async (w) => w.advance(120_001),
      rejected: async (w, item) => assert.equal((await w.reject(item.id)).status, 200),
      cancelled: async (w, item) => assert.equal((await w.cancel(item.id)).status, 200),
      dropped: async (w, item) => {
        await w.seatedMeanwhile();
        assert.equal((await w.approve(item.id)).body.error, 'APPLICANT_BUSY');
      },
      'ended by room.start': async (w) => {
        w.start();
        assert.equal(w.rt.status().inMatch, true);
      },
    };
    for (const [how, end] of Object.entries(ended)) {
      const w = await world();
      const item = await applied(w);
      await end(w, item);
      const { status } = w.item();
      assert.notEqual(status, 'pending', how);
      assert.deepEqual(await w.cancel(item.id), { status: 200, body: w.item() }, how);
      assert.deepEqual(w.calls, [], `${how}: no account call`);
    }
    // A live application gives back what it holds on the account: its seat (once approved) and its record.
    const w = await world();
    const item = await applied(w);
    assert.equal((await w.cancel(item.id)).body.status, 'cancelled');
    assert.deepEqual(w.calls, ['releaseSeat', 'clearApplication']);
    assert.equal(await w.rpc('getApplication'), null);
    // A joined one cannot be cancelled.
    const joined = await world();
    const approved = await joined.approve((await applied(joined)).id);
    assert.equal(joined.join(approved.body.ticket), 'JOINED');
    assert.deepEqual(await joined.cancel(approved.body.id), { status: 409, body: { error: 'ALREADY_JOINED' } });
    assert.deepEqual(joined.calls, []);
  });
});

// Two tabs (or devices) of one account apply at once, tab 1 to room A and tab 2 to room B. Tab 2's clearStaleApplication
// (handleLobbyRoutes) reads the account's record between tab 1's two claims, so it holds a record without an item id;
// its GET of room A waits for tab 1's apply event (a room's events run one at a time: blockConcurrencyWhile), which by
// then has linked the record to its pending item. That record must not be cleared as stale: tab 2 is refused, and the
// account keeps one application (review 2026-10-08: tab 2 got a second one, host A could seat it while it waited on B).
for (const variant of ['first apply', 're-apply']) test(`two concurrent applies of one account (${variant}): the second is refused while the first is pending`, { timeout: 120000 }, async (t) => {
  const h = await createAccountHarness(`
    export {AccountDurableObject as TestObject} from './worker/accounts/account.js';
    export default {async fetch(req, env) {
      const {accountId, op, args} = await req.json();
      return Response.json((await env.TEST.get(env.TEST.idFromName(accountId))[op](...args)) ?? null);
    }};`);
  t.after(() => h.dispose());
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const makeRoom = (code, hostId) => {
    const rt = new RoomRuntime({ now: () => Date.now() });
    t.after(() => rt.lobby.shutdown());
    const host = new Socket();
    rt.connect(host, { accountId: hostId, ticket: rt.reserve(code, hostId), name: 'Host' });
    rt.message(host, JSON.stringify({ t: 'hello', name: 'Host' }));
    rt.message(host, JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' }));
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    return { rt, serial };
  };
  const rooms = { ABCD: makeRoom('ABCD', 'hostA'), BBBB: makeRoom('BBBB', 'hostB') };
  const G = 'guest-race';
  const rpcOf = (accountId) => async (op, ...args) => (await h.fetch({ accountId, op, args })).json();
  let beforeLink = null; // runs before tab 1 links its item (the second claim of room A)
  let onRead = null; // tab 2 has read the record
  const account = (id) => new Proxy({}, { get: (_, op) => async (...args) => {
    if (id === G && op === 'claimApplication' && args[0].roomId === 'ABCD' && args[0].id && beforeLink) {
      const f = beforeLink; beforeLink = null; await f();
    }
    const result = await rpcOf(id)(op, ...args);
    if (id === G && op === 'getApplication' && onRead) { const f = onRead; onRead = null; f(); }
    return result;
  } });
  const env = {
    ACCOUNTS: { idFromName: (id) => id, get: (id) => account(id) },
    ROOMS: { idFromName: (code) => code, get: (code) => ({ fetch: (request) => rooms[code].serial(() =>
      RoomDurableObject.prototype.route.call({ runtime: rooms[code].rt, env }, request)) }) },
  };
  const post = (code, who, body) => env.ROOMS.get(code).fetch(new Request('https://room.internal/_applications', {
    method: 'POST', headers: { 'X-Account-ID': who, 'X-Account-Name': 'Guest', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (variant === 're-apply') assert.equal((await post('ABCD', G, { action: 'apply' })).status, 201);
  let tab2;
  beforeLink = async () => {
    const read = new Promise((resolve) => { onRead = resolve; });
    // tab 2, as handleLobbyRoutes runs it: clearStaleApplication, then the room's apply
    tab2 = (async () => { await clearStaleApplication(env, G); return post('BBBB', G, { action: 'apply' }); })();
    await read;
  };
  const tab1 = await post('ABCD', G, { action: 'apply' });
  const second = await tab2;
  assert.equal(tab1.status, 201);
  assert.deepEqual(second, { status: 409, body: { error: 'APPLICATION_PENDING' } });
  assert.deepEqual(await rpcOf(G)('getApplication').then((x) => x && [x.roomId, x.id]), ['ABCD', tab1.body.id]);
  assert.deepEqual(rooms.BBBB.rt.applications.list(G), []);
  // host A's approval seats the account (its only application)
  const approved = await post('ABCD', 'hostA', { action: 'approve', id: tab1.body.id });
  assert.equal(approved.status, 200);
  assert.equal((await rpcOf(G)('getActiveSeat'))?.roomId, 'ABCD');
});
