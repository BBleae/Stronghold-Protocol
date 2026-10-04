// The production Worker (tools/build-worker.mjs bundleWorker) with every Durable Object, in workerd (Miniflare).
//
// The fixture entry adds what tests need and production lacks: seeded GitHub accounts with session cookies (actor
// 'a' → cookie 'aaaa…'), WebSocket upgrades on behalf of an actor, hooks on a room's Durable Object (storage
// access, a snapshot rewrite applied at its next wake, the structured log lines of the isolate (every room's), its
// in-memory timer, its login checks or its failed jobs' retries made due) and on the directory (session lookups and
// room listings counted, a logout, an outage). Any hook wakes the room it is sent to. Storage persists across restart(), which replaces the
// runtime like a deployment does; evict() puts one room to sleep with its sockets open, as the platform does.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleWorker } from '../../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from './account-harness.js';

const fixture = (bundle) => `
import worker, { SiteDirectory, AccountDurableObject, RoomDurableObject as ProductionRoom, MatchArchive }
  from ${JSON.stringify(bundle.replaceAll('\\', '/'))};
import { hash } from './worker/accounts/auth.js';

// The directory, with its session lookups and room listings counted (failed ones too). fail(method, on): the method
// throws while on, as an unavailable directory does.
export class TestObject extends SiteDirectory {
  getSession(key) {
    this.lookups = (this.lookups ?? 0) + 1;
    if (this.failing?.getSession) throw new Error('directory unavailable (test)');
    return super.getSession(key);
  }
  publishRoom(room) {
    this.publishes = (this.publishes ?? 0) + 1;
    if (this.failing?.publishRoom) throw new Error('directory unavailable (test)');
    return super.publishRoom(room);
  }
  fail(method, on) { this.failing = { ...this.failing, [method]: on }; }
  counts() { return { lookups: this.lookups ?? 0, publishes: this.publishes ?? 0 }; }
}

// Structured log lines of this isolate (worker/log.js logs one object per call).
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'event' in args[0]) logs.push({ level, ...args[0] });
    write(...args);
  };
}

// Storage writes of each room (by room code): transactions, alarms set.
const writes = new Map();
function counted(ctx, self) {
  const count = (kind) => {
    const entry = writes.get(self.runtime?.code) ?? { transactions: 0, alarms: 0 };
    entry[kind]++;
    writes.set(self.runtime?.code, entry);
  };
  const storage = new Proxy(ctx.storage, { get(target, key) {
    if (key === 'transaction') return (fn) => { count('transactions'); return target.transaction(fn); };
    if (key === 'setAlarm') return (...args) => { count('alarms'); return target.setAlarm(...args); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(ctx, { get(target, key) {
    if (key === 'storage') return storage;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export class RoomDurableObject extends ProductionRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = counted(ctx, this);
  }
  async readSnapshot() {
    const snapshot = await super.readSnapshot();
    const rewrite = await this.ctx.storage.get('test-rewrite');
    if (rewrite && snapshot?.matchCheckpoint) {
      await this.ctx.storage.delete('test-rewrite');
      Object.assign(snapshot.matchCheckpoint, rewrite.checkpoint || {});
      if (rewrite.view) Object.assign(snapshot.matchCheckpoint.view, rewrite.view);
    }
    return snapshot;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/__test/')) return super.fetch(request);
    const input = await request.json();
    const storage = this.ctx.storage;
    switch (url.pathname) {
      case '/__test/get': return Response.json((await storage.get(input.key)) ?? null);
      case '/__test/put': await storage.put(input.key, input.value); return Response.json(null);
      case '/__test/sql': return Response.json(storage.sql.exec(input.query, ...(input.params || [])).toArray());
      case '/__test/logs': await this.ready; return Response.json(logs);
      case '/__test/snapshot': await this.ready; return Response.json((await this.readSnapshot()) ?? null);
      case '/__test/alarm': await this.ready; return Response.json(await storage.getAlarm());
      case '/__test/timer': await this.ready; return Response.json({ timerAt: this.timerAt });
      case '/__test/writes': await this.ready; return Response.json(writes.get(this.runtime.code) ?? { transactions: 0, alarms: 0 });
      case '/__test/retries-due':
        // As if the backoff of the failed listing and login checks were over.
        await this.ready;
        await this.event(() => {
          this.listing.retryAt = 0;
          this.logins.retryAt = 0;
        });
        return Response.json(null);
      case '/__test/logins-due':
        // As if the last login check of every open socket were a minute old.
        await this.ready;
        await this.event(() => { for (const meta of this.runtime.socketMeta.values()) meta.sessionCheckedAt = 0; });
        return Response.json(null);
      default: return new Response('unknown hook', { status: 404 });
    }
  }
}
export { AccountDurableObject, MatchArchive };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookie = (actor) => '__Host-sp_session=' + actor.repeat(64);
    if (request.headers.get('Upgrade') === 'websocket') {
      const actor = url.searchParams.get('actor') || 'a';
      const ip = url.searchParams.get('ip');
      url.searchParams.delete('actor');
      url.searchParams.delete('ip');
      return worker.fetch(new Request('https://game.example/ws' + url.search, { headers: { Upgrade: 'websocket',
        Origin: 'https://game.example', cookie: cookie(actor), ...(ip ? { 'CF-Connecting-IP': ip } : {}) } }), env);
    }
    const input = await request.json();
    const actor = input.actor || 'a';
    if (input.room) {
      return env.ROOMS.get(env.ROOMS.idFromName(input.room)).fetch(new Request('https://room.internal/__test/' + input.hook, {
        method: 'POST', body: JSON.stringify(input.body || {}) }));
    }
    if (input.account) {
      return Response.json(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(input.account))[input.call](...(input.args || [])));
    }
    if (input.directory) {
      const site = env.SITES.get(env.SITES.idFromName('directory'));
      if (input.directory === 'logout') await site.revokeSession(await hash(actor.repeat(64)));
      if (input.directory === 'fail') await site.fail(input.method, input.on);
      return Response.json(await site.counts());
    }
    if (input.seed) {
      const site = env.SITES.get(env.SITES.idFromName('directory'));
      const user = await site.resolveGithubUser({ id: String(actor.charCodeAt(0)), login: 'Player ' + actor, avatarUrl: null });
      await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(user.accountId)).setProfile(user);
      await site.saveSession(await hash(actor.repeat(64)), { accountId: user.accountId, user, expiresAt: Date.now() + (input.ttl ?? 3600000) });
      return Response.json(user);
    }
    return worker.fetch(new Request('https://game.example' + input.path, { method: input.method || 'GET',
      headers: { Origin: 'https://game.example', cookie: cookie(actor), 'Content-Type': 'application/json' },
      body: input.body === undefined ? undefined : JSON.stringify(input.body) }), env);
  },
};
`;

export async function createWorld(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-world-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundle });
  const durableObjects = Object.fromEntries([['SITES', 'TestObject'], ['ACCOUNTS', 'AccountDurableObject'],
    ['ROOMS', 'RoomDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']]
    .map(([binding, className]) => [binding, { className, useSQLite: true }]));
  const h = await createAccountHarness(fixture(bundle), { durableObjects, ratelimits: productionLimits });
  t.after(() => h.dispose());

  const world = {
    restart: () => h.restart(),
    /** A GitHub account with a session cookie for `actor`; resolves with its profile ({ accountId, … }). */
    seed: async (actor, ttl) => (await h.fetch({ seed: true, actor, ttl })).json(),
    /** An HTTP request to the Worker as `actor`; resolves with { status, body }. */
    api: async (actor, path, { method = 'GET', body } = {}) => {
      const response = await h.fetch({ actor, path, method, body });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    /** A hook of the room's Durable Object (see the fixture). */
    room: async (code, hook, body) => (await h.fetch({ room: code, hook, body })).json(),
    /** An RPC method of an account's Durable Object. */
    account: async (accountId, call, ...args) => (await h.fetch({ account: accountId, call, args })).json(),
    /** How many session lookups the directory has served (failed ones too). */
    lookups: async () => (await (await h.fetch({ directory: 'count' })).json()).lookups,
    /** How many room listings the directory has been sent (failed ones too). */
    publishes: async () => (await (await h.fetch({ directory: 'count' })).json()).publishes,
    /** The directory's `method` (getSession, publishRoom) throws while `on`. */
    failDirectory: (method, on = true) => h.fetch({ directory: 'fail', method, on }),
    /** `actor` logs out: the directory revokes its session. */
    logout: async (actor) => h.fetch({ directory: 'logout', actor }),
    /** The room's Durable Object is evicted; its WebSockets hibernate and stay open. */
    evict: (code) => h.evict('RoomDurableObject', code),
    /**
     * Upgrade /ws as `actor` (from `ip`, as the edge reports it): { status, ws, frames, wait(type, predicate?),
     * send(msg), closed } (ws null when refused).
     */
    async socket(actor, { code, ticket, ip } = {}) {
      const query = new URLSearchParams({ room: code, actor, ...(ticket ? { ticket } : {}), ...(ip ? { ip } : {}) });
      const response = await h.request('https://test.example/ws?' + query, { headers: { Upgrade: 'websocket' } });
      const result = { status: response.status, ws: response.webSocket, frames: [], closed: null };
      if (!result.ws) return result;
      result.ws.addEventListener('message', (event) => result.frames.push(JSON.parse(event.data)));
      result.ws.addEventListener('close', (event) => { result.closed = { code: event.code, reason: event.reason }; });
      result.ws.accept();
      result.send = (msg) => result.ws.send(JSON.stringify(msg));
      result.waitFor = async (predicate, label) => {
        for (let i = 0; i < 250; i++) {
          const frame = result.frames.find(predicate);
          if (frame) return frame;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`no ${label} frame: ${JSON.stringify(result.frames).slice(0, 2000)}`);
      };
      result.wait = (type, predicate = () => true) => result.waitFor((f) => f.t === type && predicate(f), type);
      result.waitClosed = async () => {
        for (let i = 0; i < 250 && !result.closed; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(result.closed, 'socket still open');
        return result.closed;
      };
      return result;
    },
    /** Connect and say hello (with `token` to resume a session); resolves with the socket after its welcome. */
    async player(actor, { code, ticket, token, ip } = {}) {
      const socket = await world.socket(actor, { code, ticket, ip });
      assert.equal(socket.status, 101);
      socket.send({ t: 'hello', name: 'Player ' + actor, ...(token ? { token } : {}) });
      socket.welcome = await socket.wait('welcome');
      let rid = 100;
      /** A request; resolves with its reply ({ t: 'ok' } or { t: 'error', code }). */
      socket.request = (t, fields = {}) => {
        const id = ++rid;
        socket.send({ t, ...fields, rid: id });
        return socket.waitFor((f) => (f.t === 'ok' || f.t === 'error') && f.rid === id, `reply to ${t}`);
      };
      return socket;
    },
  };
  return world;
}
