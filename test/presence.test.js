// 在线人数 (presence counters) — a remake addition, ported from Jerryzhu1234510's fork (4f4e848f). Boots a real server
// in-process on a random port and drives WebSocket clients: the frame a fresh session gets right after `welcome`, the
// push when another player connects / enters a room / leaves it / drops, the change guard, `presenceTickMs: 0` (the
// hello frame only) and /healthz. Then the Lobby class on its own: without a socket count (a bare lobby; the Worker's room
// Durable Objects start from it and override presenceOn / presence() with the presence board's site-wide counters —
// worker/room-runtime.js, test/worker/presence*.test.js) it sends no frame and starts no timer; given one (the Node
// server, the Worker's node-protocol gateway worker/lobby-gateway.js) it counts and pushes. DESIGN §F5.
//
// The tick is overridden per server so a test never waits for the production interval.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { Lobby, LOBBY_DEFAULTS } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

/** Run `fn` against a FRESH server (the session registry is per server) and close the clients it opened. */
async function withServer(over, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, presenceTickMs: 30, ...over });
  const ctx = { srv, wsUrl: `ws://127.0.0.1:${srv.port}/ws`, httpUrl: `http://127.0.0.1:${srv.port}`, opened: [] };
  const player = async (name) => {
    const c = await TestClient.connect(ctx.wsUrl);
    ctx.opened.push(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };
  try {
    return await fn(player, ctx);
  } finally {
    await Promise.all(ctx.opened.map((c) => c.terminate().catch(() => {})));
    await srv.close();
  }
}

describe('presence counters (在线人数)', () => {
  test('a fresh session is answered at once; online / in-room changes are pushed', async () => {
    await withServer({}, async (player, ctx) => {
      const a = await player('A');
      const first = await a.waitFor('presence');
      assert.equal(first.online, 1, 'this socket is counted');
      assert.equal(first.inRoom, 0, 'nobody is in a room yet');

      const b = await player('B');
      const two = await a.waitFor('presence', (m) => m.online >= 2);
      assert.equal(two.online, 2, 'the second session is counted');
      assert.equal(two.inRoom, 0);

      await b.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
      const inRoom = await a.waitFor('presence', (m) => m.inRoom >= 1);
      assert.equal(inRoom.inRoom, 1, 'the room holds one human');
      assert.equal(inRoom.online, 2, 'entering a room does not change the online count');

      // quiet: the same numbers are never re-sent (each session's last numbers are remembered — the clock's first tick
      // does not repeat the hello's either, whenever it falls)
      await a.expectNone('presence', () => true, 150);

      // leaving the room takes the in-room count back down (the host was its last human, so it closes)
      await b.request({ t: 'room.leave' });
      const left = await a.waitFor('presence', (m) => m.inRoom === 0);
      assert.equal(left.online, 2, 'the session is still online');

      // a dropped socket stops counting as online (its session stays resumable for the reconnect window)
      await b.terminate();
      const dropped = await a.waitFor('presence', (m) => m.online <= 1);
      assert.equal(dropped.online, 1);
      assert.equal(dropped.inRoom, 0);

      // the same counters are on /healthz: a page without a session (the title screen) reads them from there
      const health = await (await fetch(`${ctx.httpUrl}/healthz`)).json();
      assert.equal(health.online, dropped.online, 'healthz.online matches the frame');
      assert.equal(health.inRoom, dropped.inRoom, 'healthz.inRoom matches the frame');
    });
  });

  test('a page that has not entered yet still counts as online (a socket without a session)', async () => {
    await withServer({}, async (player, ctx) => {
      const lurker = await TestClient.connect(ctx.wsUrl); // connected, never said hello: the title screen
      ctx.opened.push(lurker);
      const a = await player('A');
      const first = await a.waitFor('presence');
      assert.equal(first.online, 2, 'the hello-less visitor counts with the player');
      const health = await (await fetch(`${ctx.httpUrl}/healthz`)).json();
      assert.equal(health.online, 2, 'the same count on /healthz');
      assert.equal(health.sessions, 1, 'only the player who said hello has a session');
      await lurker.expectNone('presence', () => true, 100); // no session: the frames go to sessions only
      await lurker.terminate();
      const after = await a.waitFor('presence', (m) => m.online <= 1);
      assert.equal(after.online, 1, 'the visitor closing the page is reflected');
    });
  });

  test('a spectator counts as in-room without being a player; a repeated hello is answered again', async () => {
    await withServer({}, async (player) => {
      const host = await player('HOST');
      await host.waitFor('presence');
      await host.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
      const created = await host.waitFor('presence', (m) => m.inRoom >= 1);
      const code = (await host.waitFor('room.state')).code;
      assert.equal(created.inRoom, 1);

      const watcher = await player('WATCH');
      await watcher.waitFor('presence');
      await watcher.request({ t: 'room.spectate', code });
      const seen = await host.waitFor('presence', (m) => m.inRoom >= 2);
      assert.equal(seen.inRoom, 2, 'the spectator seat is counted with the players');

      // a repeated hello on the live socket (a resync) gets the counters again, at once — the frame after it (a frame of
      // the way there that a predicate above skipped, {2, 1} while the watcher had a socket but no seat yet, may still
      // be queued: cleared first)
      host.clearInbox();
      await host.hello('HOST');
      const again = await host.waitFor('presence');
      assert.deepEqual({ online: again.online, inRoom: again.inRoom }, { online: 2, inRoom: 2 });
    });
  });

  test('presenceTickMs 0 sends the hello frame only', async () => {
    await withServer({ presenceTickMs: 0 }, async (player, ctx) => {
      const a = await player('A');
      assert.equal((await a.waitFor('presence')).online, 1, 'the hello frame still arrives');
      const b = await player('B');
      assert.equal((await b.waitFor('presence')).online, 2);
      await a.expectNone('presence', () => true, 150); // no clock ⇒ no updates
      assert.equal(ctx.srv.lobby.presenceTimer, null, 'no clock was started');
    });
  });

  test('/healthz carries the counters without any session; the clock is unref\'d and stops on shutdown', async () => {
    await withServer({}, async (player, ctx) => {
      const empty = await (await fetch(`${ctx.httpUrl}/healthz`)).json();
      assert.deepEqual({ online: empty.online, inRoom: empty.inRoom }, { online: 0, inRoom: 0 }, 'numbers, not absent');
      assert.equal(ctx.srv.lobby.presenceTimer, null, 'no clock before the first hello');
      await player('A');
      const timer = ctx.srv.lobby.presenceTimer;
      assert.ok(timer, 'the first hello starts the clock');
      assert.equal(timer.hasRef(), false, 'it never keeps the process alive');
      ctx.srv.lobby.shutdown();
      assert.equal(ctx.srv.lobby.presenceTimer, null, 'shutdown stops it');
    });
  });
});

describe('the Lobby class on its own (what the Worker Durable Objects build on)', () => {
  /** A fake connected session (the shape net.js gives the lobby). */
  function fakeSession(registry, name) {
    const sent = [];
    const s = registry.create(name);
    s.connected = true;
    s.ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)), terminate() {} };
    return { s, sent };
  }

  test('no presence frame, no clock; presence() still counts (connected sessions as online)', () => {
    const registry = new SessionRegistry();
    for (const options of [{}, { maxRooms: 1, queueTickMs: 0 }]) { // a bare lobby; a room Durable Object's options (before its override)
      const lobby = new Lobby({ registry, MatchClass: StubMatch, options });
      assert.equal(lobby.presenceOn, false);
      const { s, sent } = fakeSession(registry, 'W');
      lobby.onHello(s, { resumed: false, repeat: false });
      assert.deepEqual(sent.filter((m) => m.t === 'presence'), [], 'no frame after welcome');
      assert.equal(lobby.presenceTimer, null, 'no timer: the Durable Object may hibernate');
      assert.equal(lobby.broadcastPresence(true), false, 'nothing is pushed');
      assert.equal(sent.length, 0);
      const p = lobby.presence();
      assert.ok(p.online >= 1 && p.inRoom === 0, JSON.stringify(p));
      lobby.shutdown();
    }
  });

  test('a lobby given `sockets` counts them and pushes; presenceTickMs 0 keeps it clock-free', () => {
    const registry = new SessionRegistry();
    let sockets = 3;
    const lobby = new Lobby({ registry, MatchClass: StubMatch, sockets: () => sockets, options: { presenceTickMs: 0 } });
    assert.equal(lobby.presenceOn, true);
    const { s, sent } = fakeSession(registry, 'G');
    lobby.onHello(s, { resumed: false, repeat: false });
    assert.deepEqual(sent.filter((m) => m.t === 'presence').map(({ online, inRoom }) => ({ online, inRoom })), [{ online: 3, inRoom: 0 }]);
    assert.equal(lobby.presenceTimer, null);
    assert.equal(lobby.broadcastPresence(), false, 'the hello delivered these numbers: nothing to push');
    assert.equal(lobby.broadcastPresence(), false, 'unchanged numbers are not re-sent');
    sockets = 4;
    assert.equal(lobby.broadcastPresence(), true, 'a change is pushed');
    assert.equal(sent.at(-1).online, 4);
    assert.equal(lobby.broadcastPresence(true), true, 'force re-sends');
    assert.equal(sent.filter((m) => m.t === 'presence').length, 3);
    assert.equal(LOBBY_DEFAULTS.presenceTickMs, 5000, 'the production interval');
    lobby.shutdown();
  });

  test('a hello that caught a passing count is corrected at the next push, though the counters are back where the last push left them', () => {
    const registry = new SessionRegistry();
    let sockets = 0;
    const lobby = new Lobby({ registry, MatchClass: StubMatch, sockets: () => sockets, options: { presenceTickMs: 0 } });
    const last = (sent) => sent.filter((m) => m.t === 'presence').map(({ online }) => online).at(-1);
    // A and V in the lobby, U on the title screen (a socket, no hello): 3 online, pushed to everyone
    sockets = 3;
    const A = fakeSession(registry, 'A'), V = fakeSession(registry, 'V');
    lobby.onHello(A.s, { resumed: false, repeat: false });
    lobby.onHello(V.s, { resumed: false, repeat: false });
    lobby.broadcastPresence();
    assert.deepEqual([last(A.sent), last(V.sent)], [3, 3]);
    // V reloads: its socket is gone for a moment; U says hello meanwhile and is told 2
    V.s.connected = false;
    sockets = 2;
    const U = fakeSession(registry, 'U');
    lobby.onHello(U.s, { resumed: false, repeat: false });
    assert.equal(last(U.sent), 2, 'the passing count');
    // V's new socket opens before the next tick: back to 3, the number of the last push
    V.s.connected = true;
    sockets = 3;
    const nA = A.sent.length;
    assert.equal(lobby.broadcastPresence(), true, 'the next push goes out');
    assert.equal(last(U.sent), 3, 'U is corrected');
    assert.equal(A.sent.length, nA, 'A already had 3: not re-sent');
    assert.equal(lobby.broadcastPresence(), false, 'then quiet');
    lobby.shutdown();
  });

  test('a congested socket that skipped a push gets the numbers at the next one', () => {
    const registry = new SessionRegistry();
    let sockets = 2;
    const lobby = new Lobby({ registry, MatchClass: StubMatch, sockets: () => sockets, options: { presenceTickMs: 0 } });
    const A = fakeSession(registry, 'A'), B = fakeSession(registry, 'B');
    lobby.onHello(A.s, { resumed: false, repeat: false });
    lobby.onHello(B.s, { resumed: false, repeat: false });
    B.s.ws.bufferedAmount = 2 << 20; // over net.js snapDropBytes: a droppable frame is skipped
    sockets = 3;
    assert.equal(lobby.broadcastPresence(), true);
    const online = (sent) => sent.filter((m) => m.t === 'presence').map((m) => m.online);
    assert.deepEqual([online(A.sent), online(B.sent)], [[2, 3], [2]], 'B skipped it');
    B.s.ws.bufferedAmount = 0;
    assert.equal(lobby.broadcastPresence(), true, 'unchanged numbers, but B is behind');
    assert.deepEqual([online(A.sent), online(B.sent)], [[2, 3], [2, 3]], 'B caught up, A not re-sent');
    assert.equal(lobby.broadcastPresence(), false);
    lobby.shutdown();
  });
});
