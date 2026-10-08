// 补位 (干员持有, room.ownership) and 自选编队 (room.diy) on the Cloudflare deployment (upstream 0.2.0 §25.3 / §25.4; DESIGN
// §F3: they replaced the fork's 外援 picks). The account rooms (worker/room-runtime.js) and the Node-protocol gateway
// (worker/lobby-gateway.js) run server/lobby.js, so the messages, the `welcome` field and the seat inputs are the
// lobby's own; what the Worker adds is its plumbing — the RoomRuntime handler's welcomeInfo, the room snapshot, the
// match restore — and its data (worker/data-loader.js must bundle data/backups.json, or the rules-version engines field
// the replaced operators' own records without a word).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { RoomRuntime } from '../../worker/room-runtime.js';
import { LobbyRuntime } from '../../worker/lobby-gateway.js';
import { bundleWorker } from '../../tools/build-worker.mjs';
import { RecordedMatch, exportMatch } from '../../server/match/checkpoint.js';
import { KITTED_CHARS } from '../../server/sim/content/kits/index.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { getData } from '../../server/data.js';

const SILVER = 'chess_char_4_22_a'; // 银灰: not owned → his stand-in (data/backups.json)
const T5A = 'chess_char_5_diy1_a';
const T6A = 'chess_char_6_diy1_a';
const SHARP = 'char_609_acguad'; // a kitted 自选 operator for both tiers
const PICKS = { [T5A]: { charId: SHARP }, [T6A]: { charId: SHARP } };

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames = [];
  send(s) { this.frames.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  take(t, rid) { return this.frames.filter((f) => f.t === t && (rid === undefined || f.rid === rid)).at(-1); }
  reply(rid) { return this.frames.find((f) => f.rid === rid && (f.t === 'ok' || f.t === 'error')); }
}

const views = (match) => [...match.players.values()].filter((ps) => !ps.isBot).map((ps) => ({
  priv: ps.privateView(), stock: ps.diyStock.snapshot(), standIns: [...ps.standIns], diy: ps.diy,
}));

test('account room: welcome carries diyKitted, room.ownership / room.diy reach the seat, the match and a restore from the room snapshot', () => {
  let clock = 1000;
  const rt = new RoomRuntime({ now: () => clock });
  const ws = new Socket();
  rt.connect(ws, { accountId: 'alice', ticket: rt.reserve('ABCD', 'alice'), name: 'Alice' });
  let rid = 0;
  const send = (r, s, t, extra = {}) => { r.message(s, JSON.stringify({ t, ...extra, rid: ++rid })); return s.reply(rid); };
  send(rt, ws, 'hello', { name: 'Alice' });
  const welcome = ws.take('welcome');
  assert.deepEqual(welcome.diyKitted, [...KITTED_CHARS], 'the 自选 picker offers what the room accepts');
  assert.ok(welcome.diyKitted.includes(SHARP));
  // sent after the welcome, before the room exists (public/js/ui/loadoutSync.js): kept on the session
  assert.equal(send(rt, ws, 'room.ownership', { notOwned: [SILVER, 'chess_char_1_01_b', 'nope'] }).t, 'ok');
  assert.equal(send(rt, ws, 'room.diy', { picks: PICKS }).t, 'ok');
  assert.equal(send(rt, ws, 'room.diy', { picks: 'all of them' }).code, 'BAD_MSG');
  assert.equal(send(rt, ws, 'room.create', { mode: 'solo', difficulty: 'FUNNY' }).t, 'ok');
  const room = rt.lobby.getRoom('ABCD');
  const pid = [...rt.registry.all()][0].playerId;
  assert.deepEqual(room.seatOf(pid).notOwned, [SILVER], 'only droppable chess are kept');
  assert.deepEqual(Object.keys(room.seatOf(pid).diy).sort(), [T5A, T6A]);
  // the room's snapshot keeps the seat inputs (a lobby that sleeps before its match starts)
  const lobbySnapshot = JSON.parse(JSON.stringify(rt.snapshot()));
  const asleep = new RoomRuntime({ snapshot: lobbySnapshot, now: () => clock });
  assert.deepEqual(asleep.lobby.getRoom('ABCD').seatOf(pid).notOwned, [SILVER]);
  assert.deepEqual(asleep.lobby.getRoom('ABCD').seatOf(pid).diy, room.seatOf(pid).diy);
  asleep.network.close();

  assert.equal(send(rt, ws, 'room.start').t, 'ok');
  const match = room.match;
  const ps = match.players.get(pid);
  assert.deepEqual([...ps.standIns], [SILVER]);
  assert.deepEqual(Object.keys(ps.diy).sort(), [T5A, T6A]);
  const priv = ws.take('m.private');
  assert.deepEqual(priv.standIns, [SILVER], 'm.private names the stand-ins');
  assert.deepEqual(Object.keys(priv.diy).sort(), [T5A, T6A], 'and the 自选 picks');
  // a running match keeps what its seat had at the start
  assert.equal(send(rt, ws, 'room.diy', { picks: {} }).code, 'ROOM_STARTED');
  assert.deepEqual(Object.keys(match.players.get(pid).diy).sort(), [T5A, T6A]);

  match.handle(pid, { t: 'g.infoReady' });
  match.handle(pid, { t: 'g.autoplay', on: true });
  for (let i = 0; i < 400 && !(match.phase === 'PREP' && match.round >= 3); i++) {
    clock = Math.max(clock, match.sched.nextAt());
    rt.pump(clock);
  }
  assert.equal(match.phase, 'PREP');
  // The Durable Object's wake: the room and its sessions from the snapshot, then the match from its checkpoint.
  const snapshot = JSON.parse(JSON.stringify(rt.snapshot()));
  const recovered = new RoomRuntime({ snapshot, now: () => clock });
  recovered.restoreMatch(snapshot.matchCheckpoint);
  const restored = recovered.lobby.getRoom('ABCD').match;
  assert.deepEqual(views(restored), views(match));
  assert.deepEqual(exportMatch(restored), exportMatch(match));
  // and it goes on exactly like the live one
  for (let i = 0; i < 200 && !match.ended; i++) {
    clock = Math.max(clock, match.sched.nextAt());
    rt.pump(clock);
    recovered.pump(clock);
  }
  assert.deepEqual(views(restored), views(match));
  assert.equal(match.errorCount, 0, JSON.stringify(match.errors.slice(0, 2)));
  match.dispose();
  restored.dispose();
  rt.network.close();
  recovered.network.close();
});

test('Node-protocol gateway: welcome carries diyKitted and room.ownership / room.diy pass to the match', (t) => {
  let clock = 1000;
  const rt = new LobbyRuntime({ now: () => clock });
  t.after(() => rt.lobby.shutdown());
  const ws = new Socket();
  rt.connect(ws, { ip: '8.8.8.8' });
  let rid = 0;
  const send = (t2, extra = {}) => { rt.message(ws, JSON.stringify({ t: t2, ...extra, rid: ++rid })); return ws.reply(rid); };
  send('hello', { name: '博士A' });
  assert.deepEqual(ws.take('welcome').diyKitted, [...KITTED_CHARS]);
  assert.equal(send('room.create', { mode: 'solo', difficulty: 'FUNNY' }).t, 'ok');
  assert.equal(send('room.ownership', { notOwned: [SILVER] }).t, 'ok');
  assert.equal(send('room.diy', { picks: PICKS }).t, 'ok');
  assert.equal(send('room.start').t, 'ok');
  const room = [...rt.lobby.rooms.values()][0];
  const ps = [...room.match.players.values()][0];
  assert.deepEqual([...ps.standIns], [SILVER]);
  assert.deepEqual(Object.keys(ps.diy).sort(), [T5A, T6A]);
  // the lobby snapshot (seats) and the match checkpoint (recorded seats) both carry them
  const saved = JSON.parse(JSON.stringify(rt.snapshot())).rooms[0];
  assert.deepEqual(saved.seats[0].notOwned, [SILVER]);
  assert.deepEqual(saved.matchCheckpoint.options.seats[0].notOwned, [SILVER]);
  assert.deepEqual(Object.keys(saved.matchCheckpoint.options.seats[0].diy).sort(), [T5A, T6A]);
  clock += 1;
});

test('rules-version engines built for the Worker field stand-ins and 自选 picks as Node does (data/backups.json is bundled)', { timeout: 120000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'sp-worker-engines-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // the two bundles of a rules version (tools/build-replay.mjs ENGINES), as the Worker build makes them
  await bundleWorker({ entry: 'worker/recovery-engine.js', outfile: path.join(dir, 'recovery.mjs') });
  await bundleWorker({ entry: 'worker/replay-engine.js', outfile: path.join(dir, 'engine.mjs') });
  const recovery = await import(pathToFileURL(path.join(dir, 'recovery.mjs')).href);
  const replay = await import(pathToFileURL(path.join(dir, 'engine.mjs')).href);

  // Server recovery: a match recorded by Node restores in the Worker's engine, its 补位 / 自选 seat inputs included.
  let clock = 1000;
  const seats = [
    { seat: 0, playerId: 'p0', name: 'Alice', isBot: false, connected: true, notOwned: [SILVER], diy: PICKS },
    { seat: 1, playerId: 'p1', name: 'Bob', isBot: false, connected: true },
  ];
  const deps = { mode: 'coop', difficulty: 'FUNNY', roomCode: 'ABCD', seed: 17, matchNo: 1, clientCombat: false,
    botRehearsal: 0, now: () => clock, send() { return true; }, broadcast() {}, onEnd() {} };
  const node = new RecordedMatch({ ...deps, seats, data: getData() }); // (the engine passes its own bundled data)
  t.after(() => node.dispose());
  const fresh = recovery.create({ ...deps, seats });
  t.after(() => fresh.dispose());
  assert.deepEqual(views(fresh), views(node), 'the engine builds the same players from its own data');
  node.start();
  for (const id of ['p0', 'p1']) { node.handle(id, { t: 'g.autoplay', on: true }); node.handle(id, { t: 'g.infoReady' }); }
  for (let i = 0; i < 200000 && !(node.phase === 'PREP' && node.round >= 3); i++) {
    clock = Math.max(clock, node.sched.nextAt());
    node.pump(clock, 10);
  }
  assert.equal(node.phase, 'PREP');
  const restored = recovery.restore(JSON.parse(JSON.stringify(exportMatch(node))), { ...deps });
  t.after(() => restored.dispose());
  assert.deepEqual([...restored.players.get('p0').standIns], [SILVER]);
  assert.deepEqual(views(restored), views(node));

  // Browser replay: a spec with a stand-in and a 自选 piece (and the pick's summons) simulates like Node's.
  await replay.ready();
  const stageId = Object.keys(getData().stages).find((id) => getData().stages[id].kind !== 'unite');
  const players = [{ playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, units: [
    { uid: 1, kind: 'chess', chessId: SILVER, standIn: true, row: 10, col: 3 },
    { uid: 2, kind: 'chess', chessId: 'chess_char_6_diy1_b', diy: { charId: 'char_2023_ling', skillIndex: 2, uniEquipId: 'uniequip_002_ling' }, row: 10, col: 5 },
    { uid: 3, kind: 'chess', chessId: 'chess_char_5_diy1_a', diy: { charId: SHARP }, row: 11, col: 4 },
  ] }];
  const spec = buildBattleSpec({ battleId: 'w', kind: 'normal', seed: 5, stageId, round: 6, players, spawns: [], routes: [], timeLimit: 40 });
  const run = (b) => {
    for (let i = 0; i < 900 && !b.finished; i++) b.step();
    return b.allyUnits.map((u) => [u.uid ?? null, u.kind, u.def?.charId ?? null, u.def?.standInFor ?? null, u.def?.diyFor ?? null,
      u.skill?.id ?? null, Math.round(u.hp ?? 0)]);
  };
  const local = run(createBattleFromSpec(spec, getDefaultSource(), { quiet: true }));
  const remote = run(replay.createBattle(spec));
  assert.deepEqual(remote, local);
  const [silver, ling] = [1, 2].map((uid) => local.find((u) => u[0] === uid && u[1] === 'op'));
  assert.ok(silver[3] === 'char_172_svrash' && silver[2] !== silver[3], `a stand-in fights for 银灰: ${silver}`);
  assert.deepEqual([ling[2], ling[4]], ['char_2023_ling', 'chess_char_6_diy1_a'], 'the 自选 pick fights');
  // a 自选 pick's summons are records of data/backups.json `tokens` (simdata rawToken falls back to them)
  const SOUL = 'token_10020_ling_soul3';
  assert.ok(replay.dataSource().rawToken(SOUL), 'the engine has the 自选 summons');
  assert.deepEqual(replay.dataSource().rawToken(SOUL), getDefaultSource().rawToken(SOUL));
});
