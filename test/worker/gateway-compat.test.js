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

// The review's second blocker: a refused upgrade must answer the client's readable close
// code (1013 try-again-later), not a 500. Before the fix the DO closed an un-accepted
// WebSocket, which workerd throws on — the caller saw `openSocket` reject.
test('NODE_COMPAT: a lobby at its per-address socket cap refuses the next upgrade with 1013', async (t) => {
  const h = await world(t);
  const { GATEWAY_LIMITS } = await import('../../worker/lobby-gateway.js');
  const ip = '5.6.7.8';
  // Open the per-address cap of raw upgrades (no hello needed — handleConnection counts the
  // socket against the network key the moment it is adopted).
  const held = [];
  for (let i = 0; i < GATEWAY_LIMITS.socketsPerAddr; i++) {
    const r = await h.request('https://test.example/ws', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
    assert.equal(r.status, 101, `socket ${i} accepted under the cap`);
    r.webSocket?.accept();
    held.push(r.webSocket);
  }
  // The next upgrade from the same network is refused — a 101 whose socket closes at once
  // with the try-again code, exactly as a browser can observe it (no HTTP status on a refused
  // WebSocket handshake).
  const refused = await h.request('https://test.example/ws', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } });
  assert.equal(refused.status, 101, 'refused upgrades answer with a socket, not a 500');
  const socket = refused.webSocket;
  assert.ok(socket, 'the refusal carries a WebSocket');
  const closed = await new Promise((resolve) => { socket.addEventListener('close', (e) => resolve(e)); socket.accept(); });
  assert.equal(closed.code, 1013, 'the client reads "try again later"');
  // A different network still gets in (the cap is per client address, not global).
  const other = await h.request('https://test.example/ws', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '5.6.7.9' } });
  assert.equal(other.status, 101);
  other.webSocket?.accept();
});

test('匹配: a group forms by the queue clock alone, its frames committed without another client message', { timeout: 120_000 }, async (t) => {
  const h = await world(t);
  const a = await client(h, 'A', '8.8.8.8');
  const b = await client(h, 'B', '9.9.9.9');
  assert.equal((await a.request('queue.join', { difficulty: 'NORMAL' })).t, 'ok');
  assert.equal((await b.request('queue.join', { difficulty: 'NORMAL' })).t, 'ok');
  // the grace runs 3 s from the last arrival; neither client sends anything meanwhile
  let matched = null;
  for (let i = 0; i < 100 && !matched; i++) { matched = b.take('queue.matched'); if (!matched) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(matched, 'queue.matched within 10 s, without another client message');
  assert.equal(matched.seated, true);
  assert.equal((await a.wait('queue.matched')).code, matched.code, 'both in one room');
  const stats = await h.request('https://test.example/healthz').then((r) => r.json());
  assert.equal(stats.rooms, 1, 'the room the queue opened is the lobby\'s');
});

// 在线人数 (presence counters) in the node-protocol deployment: the gateway's lobby counts like the Node server (every live
// socket is online, a hello-less one too; the humans holding a seat are in a room). A hello is answered with the counters,
// a change reaches every session with the event that made it (the commit, not an interval clock), and /healthz carries
// the same two numbers.
test('NODE_COMPAT: 在线人数 — a hello gets the counters, changes go out with their event, /healthz carries them', { timeout: 120_000 }, async (t) => {
  const h = await world(t);
  const empty = await (await h.request('https://test.example/healthz')).json();
  assert.deepEqual([empty.online, empty.inRoom], [0, 0]);
  // a page on the title screen: a socket, no hello yet
  const lurker = await h.request('https://test.example/ws', { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '7.7.7.7' } });
  lurker.webSocket.accept();
  const a = await client(h, 'A', '8.8.8.8');
  const first = await a.wait('presence');
  assert.deepEqual([first.online, first.inRoom], [2, 0], 'the hello-less socket counts as online');
  const waitPresence = async (socket, ok) => {
    for (let i = 0; i < 250; i++) {
      const frame = socket.frames.filter((f) => f.t === 'presence').at(-1);
      if (frame && ok(frame)) return frame;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`no matching presence frame: ${JSON.stringify(socket.frames.filter((f) => f.t === 'presence'))}`);
  };
  const b = await client(h, 'B', '9.9.9.9');
  await waitPresence(a, (f) => f.online === 3 && f.inRoom === 0);
  assert.equal((await b.request('room.create', { mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
  await waitPresence(a, (f) => f.online === 3 && f.inRoom === 1);
  const health = await (await h.request('https://test.example/healthz')).json();
  assert.deepEqual([health.online, health.inRoom, health.sockets], [3, 1, 3]);
  // B's socket drops: no longer online; its seat is kept for the lobby grace, so it is still in the room
  b.ws.close(1000, 'gone');
  await waitPresence(a, (f) => f.online === 2 && f.inRoom === 1);
  lurker.webSocket.close(1000, 'gone');
  await waitPresence(a, (f) => f.online === 1);
});
