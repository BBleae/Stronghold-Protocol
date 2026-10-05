// The node-protocol gateway against the real Workers runtime: a production bundle routed
// through NODE_COMPAT, driven by plain WebSocket clients (no room code, hello + room.*),
// the way the APK's embedded client talks to a Node server. Checks the /healthz shape the
// APK's server list probes, a room that survives an eviction, and sessions/rooms that
// survive a deployment restart (the lobby DO's snapshot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness } from './helpers/account-harness.js';

const fixture = (bundle) => `
import worker, { LobbyGatewayDurableObject } from ${JSON.stringify(bundle.replaceAll('\\', '/'))};
export { LobbyGatewayDurableObject };
export default worker;
`;

async function world(t) {
  // The production bundle (the same build a deploy ships; entry.js re-exports the gateway
  // class), plus the harness env binding NODE_COMPAT that flips the Worker's routing.
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'worker.mjs');
  await bundleWorker({ outfile: bundle });
  const h = await createAccountHarness(fixture(bundle), {
    durableObjects: { LOBBY: { className: 'LobbyGatewayDurableObject', useSQLite: true } },
    bindings: { NODE_COMPAT: '1' },
  });
  t.after(() => h.dispose());
  return h;
}

async function client(h, name, ip = '8.8.8.8', token = null) {
  const response = await h.request('https://test.example/ws', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
  assert.equal(response.status, 101, 'the lobby accepts a Node client without a room code');
  const ws = response.webSocket;
  const result = { ws, frames: [], closed: null };
  ws.addEventListener('message', (event) => result.frames.push(JSON.parse(event.data)));
  ws.addEventListener('close', (event) => { result.closed = { code: event.code, reason: event.reason }; });
  ws.accept();
  result.send = (msg) => ws.send(JSON.stringify(msg));
  let rid = 0;
  result.request = async (t, fields = {}) => {
    const id = ++rid;
    result.send({ t, ...fields, rid: id });
    for (let i = 0; i < 250; i++) {
      const frame = result.frames.find((f) => (f.t === 'ok' || f.t === 'error') && f.rid === id);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`no reply to ${t}: ${JSON.stringify(result.frames).slice(0, 2000)}`);
  };
  result.take = (type) => result.frames.filter((f) => f.t === type).at(-1);
  result.wait = async (type) => {
    for (let i = 0; i < 250; i++) {
      const frame = result.take(type);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`no ${type} frame`);
  };
  result.send({ t: 'hello', name, ...(token ? { token } : {}) });
  result.welcome = await result.wait('welcome');
  return result;
}

test('NODE_COMPAT: healthz answers the node shape; a plain /ws client rooms, joins and resumes', async (t) => {
  const h = await world(t);

  // /healthz: the shape the APK's ServerList probes for a plain Node server (no runtime field,
  // so no roomScoped flag; version = protocol, app = release).
  const health = await (await h.request('https://test.example/healthz')).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, 1, 'the protocol version');
  assert.match(health.app, /^\d+\.\d+\.\d+/, 'the app version');
  assert.equal(health.runtime, undefined, 'no runtime field: the APK treats this as a node server');
  assert.equal(health.rooms, 0);

  const host = await client(h, '博士A');
  assert.equal(host.welcome.version, 1);
  assert.match(host.welcome.token, /^[0-9a-f]{32}$/, 'a node-shaped token (no room prefix)');
  const created = await host.request('room.create', { mode: 'coop', difficulty: 'FUNNY' });
  assert.equal(created.t, 'ok');
  const code = host.take('room.state').code;
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);

  const guest = await client(h, '博士B', '9.9.9.9');
  assert.equal((await guest.request('room.join', { code })).t, 'ok');
  assert.ok(guest.take('room.state'), 'the guest got its room state');
  assert.equal((await guest.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await host.request('room.ready', { ready: true })).t, 'ok');

  // A hibernation with no running match: the platform evicts the object, live sockets keep
  // working (reloaded from storage + attachment), ping/pong answers as if nothing happened.
  await h.evict('LobbyGatewayDurableObject', 'lobby');
  guest.send({ t: 'ping', c: 0 });
  await guest.wait('pong');

  // Only then a match starts.
  assert.equal((await host.request('room.start')).t, 'ok', 'the host started a match');
  await host.wait('m.public');
  await guest.wait('m.public');
  const mid = await (await h.request('https://test.example/healthz')).json();
  assert.equal(mid.rooms, 1);
  assert.equal(mid.matches, 1);
  assert.equal(mid.humans, 2);

  // A deployment restart: every socket closes; the lobby (rooms, sessions, the running
  // match) comes back from storage, and clients resume with their tokens.
  await h.restart();
  const back = await client(h, '博士A', '8.8.8.8', host.welcome.token);
  assert.equal(back.welcome.resumed, true, 'the session resumed after the restart');
  assert.equal(back.welcome.playerId, host.welcome.playerId, 'the same player id');
  // The running match is restored from its checkpoint + event log (an engine load plus a
  // full replay can take seconds); the lobby then resyncs the match state onto the seat.
  const restored = await (await h.request('https://test.example/healthz')).json();
  assert.equal(restored.matches, 1, 'the match survived the restart');
  for (let i = 0; i < 1000 && !back.frames.some((f) => f.t === 'm.private' || f.t === 'm.public'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(back.frames.some((f) => f.t === 'm.private' || f.t === 'm.public'),
    `the running match resynced after the resume (saw: ${back.frames.map((f) => f.t).join(',')})`);
});
