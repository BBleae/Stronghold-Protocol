// The production Worker (tools/build-worker.mjs bundleWorker) with every Durable Object, in workerd (Miniflare).
//
// The fixture entry adds what tests need and production lacks: seeded GitHub accounts with session cookies (actor
// 'a' → cookie 'aaaa…'), WebSocket upgrades on behalf of an actor, and hooks on a room's Durable Object (storage
// access, a snapshot rewrite applied at its next wake, the structured log lines it wrote). Storage persists across
// restart(), which replaces the runtime like a deployment does.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleWorker } from '../../../tools/build-worker.mjs';
import { createAccountHarness } from './account-harness.js';

const fixture = (bundle) => `
import worker, { SiteDirectory, AccountDurableObject, RoomDurableObject as ProductionRoom, AdmissionDurableObject, MatchArchive }
  from ${JSON.stringify(bundle.replaceAll('\\', '/'))};
import { hash } from './worker/accounts/auth.js';

// Structured log lines of this isolate (worker/log.js logs one object per call).
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'event' in args[0]) logs.push({ level, ...args[0] });
    write(...args);
  };
}

export class RoomDurableObject extends ProductionRoom {
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
      default: return new Response('unknown hook', { status: 404 });
    }
  }
}
export { SiteDirectory as TestObject, AccountDurableObject, AdmissionDurableObject, MatchArchive };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookie = (actor) => '__Host-sp_session=' + actor.repeat(64);
    if (request.headers.get('Upgrade') === 'websocket') {
      const actor = url.searchParams.get('actor') || 'a';
      url.searchParams.delete('actor');
      return worker.fetch(new Request('https://game.example/ws' + url.search, {
        headers: { Upgrade: 'websocket', Origin: 'https://game.example', cookie: cookie(actor) } }), env);
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
    ['ROOMS', 'RoomDurableObject'], ['ADMISSION', 'AdmissionDurableObject'], ['MATCH_ARCHIVES', 'MatchArchive']]
    .map(([binding, className]) => [binding, { className, useSQLite: true }]));
  const h = await createAccountHarness(fixture(bundle), { durableObjects });
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
    /** Upgrade /ws as `actor`: { status, ws, frames, wait(type, predicate?), send(msg), closed } (ws null when refused). */
    async socket(actor, { code, ticket } = {}) {
      const query = new URLSearchParams({ room: code, actor, ...(ticket ? { ticket } : {}) });
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
    async player(actor, { code, ticket, token } = {}) {
      const socket = await world.socket(actor, { code, ticket });
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
