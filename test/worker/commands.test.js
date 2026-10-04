import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RoomRuntime } from '../../worker/room-runtime.js';

// Requests are not de-duplicated: the client mints a commandId per send and never re-sends a request, so the room
// keeps nothing per command. The field is still accepted on the wire.

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = [];
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  replies() { return this.frames.filter((f) => f.t === 'ok' || f.t === 'error'); }
}
function connect(rt, accountId, ticket, token) {
  const ws = new Socket();
  rt.connect(ws, { accountId, ticket, ip: '8.8.8.8' });
  rt.message(ws, JSON.stringify({ t: 'hello', name: accountId, token }));
  return ws;
}
const send = (rt, ws, t, fields = {}) => rt.message(ws, JSON.stringify({ t, rid: ws.frames.length + 1, commandId: randomUUID(), ...fields }));

function coopRoom(t) {
  const rt = new RoomRuntime({ accounts: true });
  t.after(() => rt.lobby.shutdown());
  const host = connect(rt, 'host', rt.reserve('ABCD', 'host'));
  send(rt, host, 'room.create', { mode: 'coop', difficulty: 'FUNNY' });
  return { rt, host };
}

test('padded commands from a stranger leave the room snapshot as it was', (t) => {
  const { rt } = coopRoom(t);
  const stranger = connect(rt, 'mallory');
  const before = JSON.stringify(rt.snapshot()).length;
  // A player's full burst. A stranger's socket has a spectator's message limit (burst 10, its hello took one) and is
  // closed past 10 refused frames.
  for (let i = 0; i < 39; i++) send(rt, stranger, 'g.refresh', { pad: 'x'.repeat(60000) });
  assert.deepEqual(stranger.replies().map((f) => f.code), [...Array(9).fill('NOT_IN_ROOM'), ...Array(11).fill('RATE')]);
  assert.deepEqual(stranger.closed, { code: 1008, reason: 'rate limit' });
  assert.ok(JSON.stringify(rt.snapshot()).length - before < 200);
});

test('a repeated commandId is a new request', (t) => {
  const { rt, host } = coopRoom(t);
  send(rt, host, 'room.addBot', { commandId: 'same' });
  send(rt, host, 'room.addBot', { commandId: 'same' });
  assert.equal(host.frames.filter((f) => f.t === 'room.state').at(-1).seats.filter(Boolean).length, 3);
});

test('a snapshot that still holds the former command store loads without it', (t) => {
  const { rt, host } = coopRoom(t);
  const snapshot = JSON.parse(JSON.stringify(rt.snapshot()));
  snapshot.sessions[0].commandResults = { old: { fingerprint: 'x'.repeat(1000), result: { ok: true } } };
  const restored = new RoomRuntime({ accounts: true, snapshot });
  t.after(() => restored.lobby.shutdown());
  assert.equal('commandResults' in restored.snapshot().sessions[0], false);
  const welcome = host.frames.find((f) => f.t === 'welcome');
  const resumed = connect(restored, 'host', undefined, welcome.token);
  assert.equal(resumed.frames.find((f) => f.t === 'welcome').playerId, welcome.playerId);
});
