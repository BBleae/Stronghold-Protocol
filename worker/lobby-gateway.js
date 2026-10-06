// Node-protocol compatibility gateway: the upstream lobby (server/lobby.js + server/net.js)
// running verbatim inside ONE Durable Object, so a Node client (the APK's embedded webroot)
// joins wei with its own protocol: a single /ws without a room code, `hello` + `room.*`
// over one shared lobby — the same thing an upstream Node server does.
//
// The Worker's account-mode rooms stay dormant (the compat branch in worker/index.js routes
// /ws here and answers /healthz in the Node shape). Nothing in the game rules is re-implemented:
// the Lobby, Network, SessionRegistry and match checkpoints are the upstream classes as-is;
// this file only moves their setTimeout-based deadlines onto the object's alarm and persists
// the whole lobby the way RoomRuntime persists a single room.
//
// Storage is key-value only (no SQLite): the lobby snapshot lives in chunked values; each
// running match's event log lives as one value per event at seq-derived keys, so an event's
// commit writes only the new rows (the same incremental idea the room objects use with their
// events table). Wake cost: the upstream client's 4 s heartbeat ({t:'ping',c:now}) cannot
// match the platform auto-response (a literal {"t":"ping","c":0}), so every ping wakes the
// DO for one event — cheap while the liveness-rounded snapshot deduplicates the commit — but
// one connected client does keep the object off hibernation; account-mode rooms avoid this
// because room-net.js rewrites the ping to the auto-response form.
import { randomBytes } from 'node:crypto';
import { Lobby, Room } from '../server/lobby.js';
import { Network, Session, SessionRegistry } from '../server/net.js';
import { RecordedMatch, exportMatch, restoreMatch } from '../server/match/checkpoint.js';
import { prepareMatchVersion, retainedMatchVersions } from './match-versions.js';
import { logWarn, logError, logInfo, errorFields } from './log.js';
import { CLOSE, refuseSocket } from './close-codes.js';
import { SNAPSHOT_PART, liveness, knownRulesVersion, SocketAdapter } from './do-storage.js';

export const GATEWAY_LIMITS = Object.freeze({ sockets: 256, socketsPerAddr: 32, sessions: 20_000,
  messageBytes: 65_536, heartbeatMs: 30_000, helloTimeoutMs: 30_000, idleSocketMs: 90_000, awakeMs: 60_000 });

const matchKey = (id, seq) => `matchlog:${id}:${String(seq).padStart(8, '0')}`;

// The base Lobby's grace/resync timers are setTimeout; inside the DO they become alarm
// deadlines to wake for (the same conversion AlarmLobby does for one room, generalized).
class GatewayLobby extends Lobby {
  deadlines = new Map();   // playerId -> lobby-grace expiry ms
  resyncDue = new Map();   // playerId -> coalesced resync due ms
  startGrace(room, seat) { this.deadlines.set(seat.playerId, this.now() + this.opts.lobbyGraceMs); }
  clearGrace(playerId) { this.deadlines.delete(playerId); }
  expireGrace() {
    for (const [playerId, at] of [...this.deadlines]) {
      if (at > this.now()) continue;
      this.deadlines.delete(playerId);
      const session = this.registry.byId(playerId);
      const room = session && this.roomOf(session);
      if (!room || room.match || session.connected) continue;
      session.notice = 'timeout';
      session.pendingResult = this.replayFor(room, playerId);
      this.removeMember(room, playerId);
    }
  }
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncDue.has(pid)) return;
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) { this.resyncDue.set(pid, this.now() + wait); return; }
    }
    this.clearResync(pid);
    this.runResync(session);
  }
  clearResync(playerId) {
    super.clearResync(playerId);
    this.resyncDue.delete(playerId);
  }
  // 匹配 (DESIGN §28): the base Lobby re-examines its queue on a setInterval clock while somebody
  // waits. Here a tick is a deadline like the grace and resync expiries, so a group forms inside
  // an event and its frames are committed and released with it (an interval's output would wait
  // in the sockets' buffers for the next client message, and its rooms for the next save).
  queueDue = null;
  startQueueClock() { if (this.queueDue == null && this.opts.queueTickMs > 0) this.queueDue = this.now() + this.opts.queueTickMs; }
  stopQueueClock() { this.queueDue = null; }
  expireQueue() {
    if (this.queueDue == null || this.queueDue > this.now()) return;
    this.queueDue = null;
    this.startQueueClock(); // the next tick; queueTick stops the clock once nobody waits
    this.queueTick();
  }
  expireResync() {
    for (const [playerId, at] of [...this.resyncDue]) {
      if (at > this.now()) continue;
      this.resyncDue.delete(playerId);
      const session = this.registry.byId(playerId);
      if (session) this.runResync(session);
    }
  }
}

/** The lobby as one persistent unit: its sessions and rooms, with per-room checkpoints. */
export class LobbyRuntime {
  constructor({ snapshot, now = Date.now } = {}) {
    this.now = now;
    this.generation = snapshot?.generation || randomBytes(8).toString('hex');
    this.socketMeta = new Map();
    this.savedCps = new Map(); // room code -> { match, count, checkpoint } (RoomRuntime's `saved`)
    const log = { info() {}, debug() {},
      warn: (message) => logWarn('lobby_gateway', { message: String(message) }),
      error: (message, detail) => logError('lobby_gateway', { message: String(message), ...(detail ? { error: errorFields(detail) } : {}) }) };
    this.registry = new SessionRegistry({ now, maxSessions: GATEWAY_LIMITS.sessions });
    // RecordedMatch (not the plain Match): matches log their events, so a checkpoint plus
    // the event log can bring a running match back — the choice the account rooms make too.
    this.lobby = new GatewayLobby({ registry: this.registry, now, log, MatchClass: RecordedMatch });
    this.network = new Network({ registry: this.registry, handler: this.lobby, log, now,
      options: { autoTimers: false, trustProxy: false, heartbeatMs: GATEWAY_LIMITS.heartbeatMs,
        helloTimeoutMs: GATEWAY_LIMITS.helloTimeoutMs, maxConnections: GATEWAY_LIMITS.sockets,
        maxConnectionsPerAddr: GATEWAY_LIMITS.socketsPerAddr, maxSessions: GATEWAY_LIMITS.sessions } });
    if (snapshot) {
      for (const { ws, ...data } of snapshot.sessions || []) {
        const session = Object.assign(new Session(data), data, { ws: null, connected: false });
        if (!Number.isFinite(session.resyncAt)) session.resyncAt = -Infinity;
        this.registry.byPlayerId.set(session.playerId, session);
        this.registry.byTokenMap.set(session.token, session);
      }
      for (const saved of snapshot.rooms || []) {
        const { matchCheckpoint, replay, ...fields } = saved;
        const room = Object.assign(new Room(fields.code, fields.mode, fields.difficulty, fields.createdAt || now()), fields);
        if (replay) room.replay = { ...replay, frames: new Map(replay.frames), pending: new Set(replay.pending) };
        this.lobby.rooms.set(room.code, room);
        if (matchCheckpoint) room.pendingCheckpoint = matchCheckpoint; // the DO owns storage: it replays the log
      }
      for (const [playerId, at] of snapshot.deadlines || []) this.lobby.deadlines.set(playerId, at);
      for (const [playerId, at] of snapshot.resyncDue || []) this.lobby.resyncDue.set(playerId, at);
      // The 匹配 queue, re-examined at once (queueTick drops whoever did not come back connected).
      for (const { playerId, difficulty, since } of snapshot.queue || []) {
        const session = this.registry.byId(playerId);
        if (session) this.lobby.queue.push({ playerId, session, difficulty, since });
      }
      if (this.lobby.queue.length) this.lobby.queueDue = now();
    }
  }

  /** Adopt an upgraded (or hibernated) socket; the Node client names itself in its hello. */
  connect(adapter, { ip = '0.0.0.0', attachment } = {}) {
    if (!attachment && this.network.admission({ socket: { remoteAddress: ip }, headers: {} })) {
      adapter.close(CLOSE.TRY_LATER, 'connection limit');
      return;
    }
    this.socketMeta.set(adapter, { ip });
    this.network.handleConnection(adapter, { socket: { remoteAddress: ip }, headers: {} });
    adapter.on('close', () => this.socketMeta.delete(adapter));
    const conn = this.network.conns.get(adapter);
    if (attachment && conn) {
      for (const key of ['openedAt', 'dropWindowAt', 'drops', 'closing']) if (attachment[key] != null) conn[key] = attachment[key];
      if (attachment.bucket) Object.assign(conn.bucket, attachment.bucket);
      if (attachment.heavy) Object.assign(conn.heavy, attachment.heavy);
      const session = this.registry.byId(attachment.playerId);
      if (session) {
        conn.session = session;
        session.ws = adapter;
        session.connected = true;
        session.disconnectedAt = null;
        const room = this.lobby.roomOf(session);
        if (room) {
          const seat = room.seatOf(session.playerId) || room.spectatorOf?.(session.playerId);
          if (seat) seat.connected = true;
          this.lobby.clearGrace(session.playerId);
        }
      }
    }
    return conn;
  }

  attachment(adapter) {
    const c = this.network.conns.get(adapter);
    return c ? { ip: this.socketMeta.get(adapter)?.ip, playerId: c.session?.playerId, openedAt: c.openedAt,
      dropWindowAt: c.dropWindowAt, drops: c.drops, closing: c.closing, bucket: { ...c.bucket }, heavy: { ...c.heavy } } : null;
  }

  message(adapter, message) {
    const conn = this.network.conns.get(adapter);
    if (!conn || conn.closing || adapter.readyState !== 1) return;
    const binary = typeof message !== 'string';
    const bytes = binary ? message.byteLength : Buffer.byteLength(message, 'utf8');
    if (bytes > GATEWAY_LIMITS.messageBytes) { adapter.close(1009, 'message exceeds 64 KiB'); return; }
    this.network.onFrame(conn, binary ? Buffer.from(message) : message, binary);
  }

  disconnect(adapter) {
    const conn = this.network.conns.get(adapter);
    if (conn) this.network.onClose(conn);
    this.socketMeta.delete(adapter);
  }

  sweep() {
    for (const conn of this.network.conns.values()) {
      if (!conn.session && this.now() - conn.openedAt >= this.network.opts.helloTimeoutMs) conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
      else if (conn.session && this.now() - conn.session.lastSeen >= GATEWAY_LIMITS.idleSocketMs) conn.close(CLOSE.IDLE, 'idle connection');
    }
    this.lobby.expireGrace();
    this.lobby.expireResync();
    this.lobby.expireQueue();
    this.network.sweep();
  }

  /** Bring every running match up to now (the virtual scheduler; the event wraps it). */
  pump(now = this.now()) {
    let steps = 0;
    for (const room of this.lobby.rooms.values()) steps += room.match?.pump?.(now) || 0;
    return steps;
  }

  /**
   * After a wake: a session saved while connected whose socket did not survive (a deployment
   * closes every socket) disconnects now, the way a closing socket does (its seat, the match,
   * a solo run's resume window, the lobby grace) — otherwise it never expires and its seat
   * never leaves the room (RoomRuntime.reconcileSockets, same first step). Then reconcile each
   * running match's per-player connected flags against the sessions that did come back.
   */
  reconcileSockets() {
    for (const session of this.registry.all()) {
      if (session.connected || session.disconnectedAt != null) continue;
      session.disconnectedAt = this.now();
      this.network.handler.onDisconnect(session);
    }
    for (const room of this.lobby.rooms.values()) {
      const match = room.match;
      if (!match) continue;
      for (const player of match.order) {
        if (player.isBot || player.left) continue;
        const connected = !!this.registry.byId(player.playerId)?.connected;
        if (player.connected && !connected) match.onDisconnect(player.playerId);
        else if (!player.connected && connected) match.onReconnect(player.playerId);
      }
    }
  }

  /** The next instant the object must wake (null: nothing waits). */
  nextAlarm() {
    const deadlines = [...this.lobby.deadlines.values(), ...this.lobby.resyncDue.values()];
    for (const conn of this.network.conns.values()) deadlines.push(conn.session
      ? conn.session.lastSeen + GATEWAY_LIMITS.idleSocketMs : conn.openedAt + this.network.opts.helloTimeoutMs);
    for (const s of this.registry.all()) if (!s.connected) deadlines.push(s.disconnectedAt + this.registry.windowOf(s) + 1);
    for (const room of this.lobby.rooms.values()) {
      const next = room.match?.sched?.nextAt?.();
      if (next != null) deadlines.push(next);
    }
    return deadlines.length ? Math.max(this.now() + 100, Math.min(...deadlines)) : null;
  }

  /** The nearest running match's next step, or the 匹配 queue's next tick (null: none). */
  timerDue() {
    // the queue ticks like a match step: everybody in it is connected (queueTick drops the rest)
    let due = this.lobby.queueDue;
    for (const room of this.lobby.rooms.values()) {
      const next = room.match?.sched?.nextAt?.();
      if (next != null && (due == null || next < due)) due = next;
    }
    return due;
  }

  connected() { return this.network.connectionCount > 0; }

  isEmpty() { return !this.lobby.rooms.size && !this.registry.size && !this.network.connectionCount; }

  // The running match's checkpoint, cached like RoomRuntime.checkpoint (keyed by room: a
  // lobby may run several matches): a match changes only through logged events, so
  // re-exporting after every ping (whose commit changes nothing) would rebuild the whole
  // state + log for nothing.
  checkpoint(room, match) {
    const cached = this.savedCps.get(room.code);
    const count = match.recording.events.length;
    if (cached?.match !== match || cached.count !== count) {
      this.savedCps.set(room.code, { match, count, checkpoint: exportMatch(match, { referenceEvents: true }) });
    }
    return this.savedCps.get(room.code).checkpoint;
  }

  snapshot() {
    const rooms = [];
    for (const room of this.lobby.rooms.values()) {
      const saved = { code: room.code, mode: room.mode, difficulty: room.difficulty, hostId: room.hostId,
        seats: room.seats, spectators: room.spectators.map(({ playerId, name, connected }) => ({ playerId, name, connected })),
        matchCount: room.matchCount, lastSummary: room.lastSummary, ownerKey: room.ownerKey,
        matchKey: room.matchKey, createdAt: room.createdAt,
        replay: room.replay ? { publicFrame: room.replay.publicFrame, frames: [...room.replay.frames], pending: [...room.replay.pending] } : null };
      if (room.match?.recording) saved.matchCheckpoint = this.checkpoint(room, room.match);
      else this.savedCps.delete(room.code); // the match ended: no more reads of its cached checkpoint
      rooms.push(saved);
    }
    for (const code of [...this.savedCps.keys()]) if (!this.lobby.rooms.has(code)) this.savedCps.delete(code);
    return { version: 1, generation: this.generation,
      sessions: [...this.registry.all()].map(({ ws, ...s }) => ({ ...s, resyncAt: Number.isFinite(s.resyncAt) ? s.resyncAt : null })),
      rooms, deadlines: [...this.lobby.deadlines], resyncDue: [...this.lobby.resyncDue],
      // the 匹配 queue (not its tick time: a tick a second would rewrite the snapshot every second)
      queue: this.lobby.queue.map(({ playerId, difficulty, since }) => ({ playerId, difficulty, since })) };
  }
}

/**
 * One Durable Object holds the whole node-protocol lobby. The Worker forwards /ws upgrades
 * after its own edge limits; every event commits the lobby. Hibernation keeps sockets
 * (serializeAttachment); a deployment closes them and the wake replays each room's match
 * from its checkpoint and event log — clients resume with their tokens, like after a Node
 * server restart.
 */
export class LobbyGatewayDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();
    this.parts = 0;
    this.savedState = null;
    this.savedLogs = new Map(); // room code -> { id, count }
    this.alarmAt = null;
    this.timer = null;
    this.timerAt = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping","c":0}', '{"t":"pong","c":0}'));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try { await this.load(); }
      catch (error) { logError('lobby_load_failed', { error: errorFields(error) }); throw error; }
    });
  }

  async load() {
    const snapshot = await this.readSnapshot();
    this.runtime = new LobbyRuntime({ snapshot });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const attachment = ws.deserializeAttachment();
      if (!attachment) { try { ws.close(CLOSE.LOST, 'missing session'); } catch {} continue; }
      const adapter = new SocketAdapter(ws);
      this.sockets.set(ws, adapter);
      this.runtime.connect(adapter, { ip: attachment.ip || '0.0.0.0', attachment });
    }
    for (const room of this.runtime.lobby.rooms.values()) {
      if (!room.pendingCheckpoint) continue;
      await this.restoreRoomMatch(room, room.pendingCheckpoint);
      delete room.pendingCheckpoint;
    }
    this.savedState = snapshot ? JSON.stringify(snapshot, liveness) : null;
    this.alarmAt = await this.ctx.storage.getAlarm();
    this.refreshAutoResponses();
    this.runtime.reconcileSockets();
    this.runtime.sweep();
    await this.commit();
  }

  async readSnapshot() {
    const meta = await this.ctx.storage.get('lobby-meta');
    this.parts = meta?.parts || 0;
    if (!this.parts) return undefined;
    const keys = Array.from({ length: this.parts }, (_, i) => `lobby-${i}`);
    const parts = [];
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128);
      const chunks = await this.ctx.storage.get(batch);
      for (const key of batch) {
        if (typeof chunks.get(key) !== 'string') throw new Error('INCOMPLETE_LOBBY_SNAPSHOT');
        parts.push(chunks.get(key));
      }
    }
    return JSON.parse(parts.join(''));
  }

  // One event, one critical section (the room objects' shape): due match steps first, the
  // event, the expiries it made due, then the commit — an error reverts to the last save.
  event(handle) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.refreshAutoResponses();
        this.runtime.pump();
        const result = await handle();
        this.runtime.pump();
        this.runtime.sweep();
        await this.commit();
        return result;
      } catch (error) {
        logError('lobby_event_failed', { error: errorFields(error) });
        throw error;
      }
    });
  }

  refreshAutoResponses() {
    for (const [ws, adapter] of this.sockets) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const session = this.runtime.network.conns.get(adapter)?.session;
      if (session && Number.isFinite(at)) session.lastSeen = Math.max(session.lastSeen, at);
    }
  }

  // Every event's end: persist what changed, release the event's output (a client never
  // sees uncommitted state), schedule the next wake. An empty lobby keeps nothing.
  async commit() {
    const rt = this.runtime;
    const closed = [];
    for (const [ws, adapter] of this.sockets) {
      const attachment = rt.attachment(adapter);
      if (attachment) ws.serializeAttachment(attachment);
      else { this.sockets.delete(ws); closed.push(adapter); }
    }
    if (rt.isEmpty()) await this.clear();
    else await this.save();
    for (const adapter of [...this.sockets.values(), ...closed]) adapter.flush();
    await this.schedule();
  }

  async clear() {
    if (this.parts || this.savedLogs.size || this.alarmAt != null) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
    this.parts = 0;
    this.savedState = null;
    this.savedLogs.clear();
    this.alarmAt = null;
  }

  async save() {
    const rt = this.runtime;
    const snapshot = rt.snapshot();
    const logs = [];
    for (const room of snapshot.rooms) {
      const checkpoint = room.matchCheckpoint;
      if (!checkpoint?.events) continue;
      const { events, ...rest } = checkpoint;
      const id = `${rt.generation}:${room.code}:${rest.options.matchNo}`;
      const previous = this.savedLogs.get(room.code);
      const from = previous && previous.id === id ? previous.count : 0;
      room.matchCheckpoint = { ...rest, eventCount: events.length, eventLogId: id };
      logs.push({ code: room.code, id, rows: events.slice(from).map((event, i) => [from + i, JSON.stringify(event)]), count: events.length });
    }
    const live = new Map(logs.map((entry) => [entry.code, entry]));
    const gone = [...this.savedLogs.keys()].filter((code) => !live.has(code));
    // Compare with liveness rounded: pings alone must not rewrite the snapshot every packet.
    // An unchanged snapshot with no NEW event rows is a no-op too — a running match re-enters
    // save() with a (non-empty) checkpoint on every event, but only its new rows are worth writing.
    const state = JSON.stringify(snapshot, liveness);
    if (state === this.savedState && !logs.some((entry) => entry.rows.length) && !gone.length) return;
    const full = JSON.stringify(snapshot);
    const parts = Math.ceil(full.length / SNAPSHOT_PART) || 1;
    const puts = { 'lobby-meta': { parts } };
    for (let i = 0; i < parts; i++) puts[`lobby-${i}`] = full.slice(i * SNAPSHOT_PART, (i + 1) * SNAPSHOT_PART);
    const deletes = Array.from({ length: this.parts > parts ? this.parts - parts : 0 }, (_, i) => `lobby-${i + parts}`);
    await this.ctx.storage.transaction(async (txn) => {
      // Batch like the room objects: at most 128 keys per put/delete call.
      const entries = Object.entries(puts);
      for (const entry of logs) for (const [seq, payload] of entry.rows) entries.push([matchKey(entry.id, seq), payload]);
      for (let offset = 0; offset < entries.length; offset += 128) await txn.put(Object.fromEntries(entries.slice(offset, offset + 128)));
      for (const code of gone) {
        const { id, count } = this.savedLogs.get(code);
        const keys = Array.from({ length: count }, (_, seq) => matchKey(id, seq));
        for (let offset = 0; offset < keys.length; offset += 128) await txn.delete(keys.slice(offset, offset + 128));
      }
      if (deletes.length) for (let offset = 0; offset < deletes.length; offset += 128) await txn.delete(deletes.slice(offset, offset + 128));
    });
    for (const entry of logs) this.savedLogs.set(entry.code, { id: entry.id, count: entry.count });
    for (const code of gone) this.savedLogs.delete(code);
    this.parts = parts;
    this.savedState = state;
  }

  // A room whose match cannot be replayed ends as interrupted; players learn it on their
  // next hello (room.closed) — an old match never bricks the lobby. Attempts are counted
  // durably before the replay: a wake that dies mid-restore ends the match on the second.
  async restoreRoomMatch(room, checkpoint) {
    const attemptsKey = 'lobby-attempts:' + room.code + ':' + (checkpoint.eventLogId || '');
    const attempts = ((await this.ctx.storage.get(attemptsKey)) ?? 0) + 1;
    const context = { room: room.code, rulesVersion: checkpoint.rulesVersion, events: checkpoint.eventCount, attempts };
    if (!knownRulesVersion(checkpoint.rulesVersion)) { await this.interruptRoom(room, checkpoint, attemptsKey, 'rollback', context); return; }
    if (attempts > 1) { await this.interruptRoom(room, checkpoint, attemptsKey, 'restart', context, new Error('RESTORE_UNFINISHED')); return; }
    await this.ctx.storage.put(attemptsKey, attempts);
    await this.ctx.storage.sync();
    try {
      await prepareMatchVersion(checkpoint.rulesVersion);
      const events = await this.matchEvents(checkpoint.eventLogId, checkpoint.eventCount);
      const restore = retainedMatchVersions[checkpoint.rulesVersion] || restoreMatch;
      const lobby = this.runtime.lobby;
      const MatchClass = lobby.MatchClass;
      let failure = null;
      lobby.MatchClass = class {
        constructor(options) { try { return restore({ ...checkpoint, events }, options); } catch (error) { failure = error; throw error; } }
      };
      room.matchCount -= 1; // startMatch counts it again
      let result;
      try { result = lobby.startMatch(room, room.matchKey); } finally { lobby.MatchClass = MatchClass; }
      if (result.error) throw failure || new Error('MATCH_RESTORE_FAILED: ' + result.detail);
      await this.ctx.storage.delete(attemptsKey);
      // Seed the incremental writer: the next commit appends only events after the replayed log.
      this.savedLogs.set(room.code, { id: checkpoint.eventLogId, count: checkpoint.eventCount });
      logInfo('lobby_match_restored', context);
    } catch (error) {
      await this.interruptRoom(room, checkpoint, attemptsKey, 'restart', context, error);
    }
  }

  // The match's event log: one stored value per event at seq-derived keys. The count is
  // known (the checkpoint's eventCount), so — like the snapshot — the keys are built and
  // batch-get in chunks; no prefix listing (whose value shape differs across runtimes).
  async matchEvents(logId, count) {
    if (!logId) throw new Error('INCOMPLETE_MATCH_LOG');
    const keys = Array.from({ length: count }, (_, seq) => matchKey(logId, seq));
    const events = new Array(count);
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128);
      const chunks = await this.ctx.storage.get(batch);
      for (let i = 0; i < batch.length; i++) {
        const value = chunks.get(batch[i]);
        if (typeof value !== 'string') throw new Error('INCOMPLETE_MATCH_LOG');
        events[offset + i] = JSON.parse(value);
      }
    }
    return events;
  }

  // A match that cannot be replayed ends interrupted: dispose it, and give up its durable
  // restore-attempt counter and its now-abandoned event log — save()'s writer only purges
  // logs it had seeded into savedLogs (a successful restore), so an interrupted match's
  // rows and attempts key would otherwise linger until the whole lobby empties (deleteAll).
  async interruptRoom(room, checkpoint, attemptsKey, reason, context, error) {
    logError('lobby_match_restore_failed', { ...context, reason, ...(error ? { error: errorFields(error) } : {}) });
    this.runtime.lobby.disposeRoom(room, reason);
    await this.ctx.storage.delete(attemptsKey);
    if (checkpoint?.eventLogId) {
      const keys = Array.from({ length: checkpoint.eventCount }, (_, seq) => matchKey(checkpoint.eventLogId, seq));
      for (let offset = 0; offset < keys.length; offset += 128) await this.ctx.storage.delete(keys.slice(offset, offset + 128));
    }
  }

  // Wake policy (the room objects' schedule, for one lobby): a connected match step keeps
  // the object awake with an in-memory timer; otherwise the alarm wakes at the deadline.
  async schedule() {
    const rt = this.runtime;
    const now = Date.now();
    const due = rt.timerDue();
    const awake = rt.connected() && due != null && due - now < GATEWAY_LIMITS.awakeMs;
    this.arm(awake ? Math.min(due, now + GATEWAY_LIMITS.awakeMs) : null);
    const at = Math.min(rt.nextAlarm() ?? Infinity, due ?? Infinity);
    if (at === Infinity) {
      // Nothing waits any more: disarm the alarm (leaving it armed would wake an idle lobby
      // forever — the room objects deleteAlarm for the same reason).
      if (this.alarmAt != null) { await this.ctx.storage.deleteAlarm(); this.alarmAt = null; }
      return;
    }
    if (at === this.alarmAt) return;
    const armed = this.alarmAt != null && this.alarmAt > now;
    if (armed && this.alarmAt < at && awake) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  arm(at) {
    if (at === this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = at == null ? null : setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.ctx.waitUntil(this.event(() => {}));
    }, Math.max(0, at - Date.now()));
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/_ws') return this.openSocket(request);
    if (url.pathname === '/_status') return this.status();
    return new Response('not found', { status: 404 });
  }

  // The Worker applied its edge limits (per network) before calling; admission here is the
  // lobby's own totals (as the node index.js checks at upgrade time).
  openSocket(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
    const ip = request.headers.get('X-Lobby-IP') || '0.0.0.0';
    if (this.runtime.network.admission({ socket: { remoteAddress: ip }, headers: {} })) return refuseSocket(CLOSE.TRY_LATER, 'connection limit');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const adapter = new SocketAdapter(server);
    this.sockets.set(server, adapter);
    this.runtime.connect(adapter, { ip });
    return new Response(null, { status: 101, webSocket: client });
  }

  status() {
    const rt = this.runtime;
    const stats = rt.lobby.stats();
    return Response.json({ rooms: stats.rooms, matches: stats.matches, humans: stats.humans, bots: stats.bots,
      sockets: rt.network.connectionCount, sessions: rt.registry.size }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    return this.event(() => {
      const adapter = this.sockets.get(ws);
      if (adapter) this.runtime.message(adapter, message);
    });
  }

  async webSocketClose(ws, code, reason) {
    await this.ready;
    return this.event(() => {
      const adapter = this.sockets.get(ws);
      if (adapter) {
        this.runtime.disconnect(adapter);
        this.sockets.delete(ws);
      }
      try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
    });
  }

  async webSocketError(ws) { return this.webSocketClose(ws, 1011, 'socket error'); }

  async alarm() {
    await this.ready;
    this.alarmAt = null;
    return this.event(() => {});
  }
}
