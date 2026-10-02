import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bundleWorker } from '../../tools/build-worker.mjs';

function messages(ws) {
  const frames = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.predicate(frame)) {
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  return {
    frames,
    wait(predicate) {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`Frame timed out: ${JSON.stringify(frames)}`)), 5000) };
        waiters.push(waiter);
      });
    },
    send(frame) { ws.send(JSON.stringify(frame)); },
  };
}

test('real Workers runtime isolates rooms, persists lobby hibernation, starts matches and resumes sockets', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-worker-test-'));
  const outfile = path.join(dir, 'index.mjs');
  await bundleWorker({ outfile });
  const legacyOptions = { workers: [{ name: 'rooms-test', scriptPath: outfile, modules: true, modulesRoot: dir,
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'RoomDurableObject', useSQLite: true }, ADMISSION: { className: 'AdmissionDurableObject', useSQLite: true } },
  }] };
  const mf = new Miniflare(convertV4MiniflareOptions(legacyOptions));
  const sockets = [];
  async function reserve() {
    const response = await mf.dispatchFetch('https://game.example/api/rooms', { method: 'POST' });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function connect(room, token, withTicket = true) {
    const response = await mf.dispatchFetch(`https://game.example/ws?room=${room.code}${withTicket ? `&ticket=${room.ticket}` : ''}`, { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101, response.status === 101 ? '' : await response.text());
    const ws = response.webSocket;
    const stream = messages(ws);
    ws.accept();
    sockets.push(ws);
    stream.send({ t: 'hello', name: '玩家', token, rid: 1 });
    const welcome = await stream.wait((f) => f.t === 'welcome');
    return { ws, ...stream, welcome };
  }
  try {
    const a = await reserve();
    const b = await reserve();
    assert.notEqual(a.code, b.code);
    assert.match(a.ticket, /^[0-9a-f]{32}$/);
    assert.equal((await mf.dispatchFetch(`https://game.example/api/rooms/${a.code}`)).status, 404);
    const host = await connect(a);
    host.send({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
    await host.wait((f) => f.t === 'ok' && f.rid === 2);
    const other = await connect(b);
    other.send({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY', rid: 2 });
    await other.wait((f) => f.t === 'ok' && f.rid === 2);
    const guest = await connect(a, undefined, false);
    guest.send({ t: 'room.join', code: a.code, rid: 2 });
    await guest.wait((f) => f.t === 'ok' && f.rid === 2);
    guest.send({ t: 'room.ready', ready: true, rid: 3 });
    await guest.wait((f) => f.t === 'ok' && f.rid === 3);
    assert.equal(other.frames.filter((f) => f.t === 'room.state').at(-1).seats.filter(Boolean).length, 1);
    // This forces a fresh DO constructor while preserving real runtime-managed accepted sockets.
    await mf.unsafeEvictDurableObject('rooms-test', 'RoomDurableObject', { name: a.code, webSockets: 'hibernate' });
    guest.send({ t: 'ping', c: 0 });
    assert.deepEqual(await guest.wait((f) => f.t === 'pong' && f.c === 0), { t: 'pong', c: 0 });
    guest.send({ t: 'hello', name: '玩家', token: guest.welcome.token, rid: 4 });
    const awake = await guest.wait((f) => f.t === 'welcome' && f.rid === 4);
    assert.equal(awake.playerId, guest.welcome.playerId);
    assert.equal(guest.frames.filter((f) => f.t === 'room.state').at(-1).seats[1].ready, true);
    host.send({ t: 'room.start', rid: 5 });
    await host.wait((f) => f.t === 'm.public' && f.phase === 'INFO_CHECK');
    await guest.wait((f) => f.t === 'm.private');
    const status = await (await mf.dispatchFetch(`https://game.example/api/rooms/${a.code}`)).json();
    assert.deepEqual(status, { code: a.code, mode: 'coop', inMatch: true, full: false });
    assert.equal('ticket' in status, false);
    guest.ws.close(1000, 'drop');
    const resumed = await connect(a, guest.welcome.token, false);
    assert.equal(resumed.welcome.resumed, true);
    await resumed.wait((f) => f.t === 'm.private');
    // Active timers intentionally prevent hibernation. A code update, like a deployment, resets them.
    await appendFile(outfile, '\n// simulate deployment\n');
    await mf.setOptions(convertV4MiniflareOptions(legacyOptions));
    const reset = await connect(a, guest.welcome.token, false);
    assert.equal(reset.welcome.resumed, false);
    await reset.wait((f) => f.t === 'room.closed' && f.reason === 'restart');
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
