import { randomInt } from 'node:crypto';
import { APP_VERSION } from '../shared/constants.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { RoomRuntime, validCode } from './room-runtime.js';
import { prepareMatchVersion, retainedMatchVersions } from './match-versions.js';
import { RULES_VERSION } from '../shared/rules-version.js';
import { logInfo, logWarn, logError, errorFields } from './log.js';
import { PACK_PATH, servePack } from './pack.js';
import { handleAuth, authenticate, accountOf, directoryOf } from './accounts/auth.js';
import { handleAccountRoutes, seatOf } from './accounts/routes.js';
import { handleLobbyRoutes, roomApplications } from './rooms/routes.js';
import { handleHistoryRoutes } from './archive/routes.js';
import { publishArchive,prepareArchive } from './archive/outbox.js';
import { handleBackupRoutes } from './storage/backup.js';
import { errorResponse, edgeIp, networkKey, accountKey, within, tooMany } from './http.js';
import { CLOSE, refuseSocket } from './close-codes.js';

// the deployed commit (tools/build-worker.mjs buildId; esbuild defines it, unbundled tests see 'local')
const BUILD = typeof __SP_BUILD__ === 'string' ? __SP_BUILD__ : 'local';
const json = (body, status = 200, headers = {}) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (status, code, detail) => json({ error: code, ...(detail ? { detail } : {}) }, status);
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code), { locationHint: 'apac' });
const sameOrigin = (request) => !request.headers.has('Origin') || request.headers.get('Origin') === new URL(request.url).origin;

export default {
  // The one place a request's unexpected error ends: logged with its route, answered with a status (worker/http.js).
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      const url = new URL(request.url);
      return errorResponse(error, { method: request.method, path: url.pathname, room: url.searchParams.get('room') ?? undefined });
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const backup=await handleBackupRoutes(request,env);if(backup)return backup;
  if (path === '/api/auth/github/start' && !(await within(env.AUTH_LIMIT, networkKey(request)))) return tooMany();
  if ((path === '/api/rooms' && request.method === 'GET') || /\/applications$/.test(path)) {
    const limit = request.method === 'GET' ? env.STATUS_LIMIT : env.APPLICATION_LIMIT;
    if (!(await within(limit, networkKey(request)))) return tooMany();
  }
  const auth = await handleAuth(request, env);
  if (auth) return auth;
  const accountResponse = await handleAccountRoutes(request, env);
  if (accountResponse) return accountResponse;
  const lobbyResponse = await handleLobbyRoutes(request, env);
  if (lobbyResponse) return lobbyResponse;
  const historyResponse=await handleHistoryRoutes(request,env);
  if(historyResponse) return historyResponse;
  if (path === '/healthz') return request.method === 'GET'
    ? json({ ok: true, runtime: 'cloudflare', version: APP_VERSION, build: BUILD }) : error(405, 'BAD_MSG');
  // Internal endpoints are only invoked on a DO stub; the public entry point never forwards them.
  if (path.startsWith('/_')) return error(404, 'ROOM_NOT_FOUND');
  if (path === '/api/rooms') {
    if (request.method !== 'POST') return error(405, 'BAD_MSG');
    // A write: only from the game's own page.
    if (request.headers.get('Origin') !== url.origin) return error(403, 'BAD_MSG', 'origin mismatch');
    if (!(await within(env.RESERVE_LIMIT, networkKey(request)))) return tooMany();
    const session = await authenticate(request, env);
    if (!session) return error(401, 'LOGIN_REQUIRED');
    // A create that failed after its reservation (e.g. at the first connect) goes on with that reservation.
    const seat = await seatOf(env, session.accountId, 'POST');
    if (seat?.reserved) return json({ code: seat.code, ticket: seat.ticket, generation: seat.generation });
    if (seat) return error(409, 'ALREADY_SEATED');
    for (let i = 0; i < 12; i++) {
      const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const response = await roomStub(env, code).fetch(new Request(`https://room.internal/_reserve?room=${code}`, {
        method: 'POST', headers: { 'X-Account-ID': session.accountId } }));
      if (response.status !== 409) {
        if (response.ok) {
          const reserved = await response.clone().json();
          const claim = await accountOf(env, session.accountId).claimSeat({ claimId: crypto.randomUUID(),
            seat: { roomId: reserved.code, roomGeneration: reserved.generation, matchId: null, seatId: null } });
          if (!claim.ok) return error(409, 'ALREADY_SEATED');
        }
        return response;
      }
    }
    return error(503, 'INTERNAL', 'room capacity unavailable');
  }
  const statusMatch = /^\/api\/rooms\/([A-Za-z]{4})$/.exec(path);
  if (statusMatch) {
    if (request.method !== 'GET') return error(405, 'BAD_MSG');
    const code = statusMatch[1].toUpperCase();
    if (!validCode(code)) return error(404, 'ROOM_NOT_FOUND');
    if (!(await within(env.STATUS_LIMIT, networkKey(request)))) return tooMany();
    return roomStub(env, code).fetch(new Request('https://room.internal/_status'));
  }
  if (path === '/ws') {
    if (request.method !== 'GET') return error(405, 'BAD_MSG');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG', 'WebSocket required');
    if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
    // The game's own page is refused with a close code it can read (worker/close-codes.js).
    const code = (url.searchParams.get('room') || '').toUpperCase();
    if (!validCode(code)) return refuseSocket(CLOSE.ROOM_GONE, 'no such room');
    const ip = edgeIp(request);
    // Connections count against the network before the login is looked up, and against the account after.
    if (!(await within(env.CONNECT_LIMIT, networkKey(request)))) return refuseSocket(CLOSE.TRY_LATER, 'too many connections');
    const session = await authenticate(request, env);
    if (!session) return refuseSocket(CLOSE.LOGIN_INVALID, 'login required');
    if (!(await within(env.CONNECT_LIMIT, accountKey(session.accountId)))) return refuseSocket(CLOSE.TRY_LATER, 'too many connections');
    const dest = new URL('https://room.internal/_ws');
    dest.searchParams.set('room', code);
    const ticket = url.searchParams.get('ticket');
    if (ticket && /^[0-9a-f]{32}$/.test(ticket)) dest.searchParams.set('ticket', ticket);
    // The room keeps the login with the socket (and checks it again on its own schedule) and shows the account's
    // avatar: both are read here, so the room's critical section never waits on another object for them.
    const profile = await accountOf(env, session.accountId).getProfile();
    return roomStub(env, code).fetch(new Request(dest, { headers: { Upgrade: 'websocket', 'X-Room-IP': ip,
      'X-Account-ID': session.accountId, 'X-Session-ID': session.sessionId, 'X-Session-Expires': String(session.expiresAt),
      'X-Avatar-URL': profile?.avatarUrl ?? '' } }));
  }
  if (path === PACK_PATH) return servePack(request, env);
  if (path.startsWith('/api/')) return error(404, 'ROOM_NOT_FOUND');
  return env.ASSETS ? env.ASSETS.fetch(request) : error(404, 'ROOM_NOT_FOUND');
}

// Adapt the Workers WebSocket surface to the existing Network's small EventEmitter-like contract. An event's output
// waits for the event's commit (flush): its frames, then a close the event made.
class SocketAdapter {
  constructor(socket) { this.socket = socket; this.handlers = new Map(); this.closed = false; this.pending = []; this.closing = null; }
  get readyState() { return this.closed ? 3 : this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount || 0; }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...args) { for (const fn of this.handlers.get(type) || []) fn(...args); }
  send(data, callback) { this.pending.push(data); callback?.(); }
  flush() {
    for (const data of this.pending) this.socket.send(data);
    this.pending = [];
    if (this.closing) this.socket.close(this.closing.code, this.closing.reason);
    this.closing = null;
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closing = { code, reason };
    this.emit('close');
  }
  terminate() { this.close(CLOSE.POLICY, 'connection terminated'); }
}

// Storage key of the restore-attempt counter (RoomDurableObject.restoreMatch).
const RESTORE_ATTEMPTS = 'restore-attempts';
// The room snapshot is stored as KV values of this many UTF-16 characters (a value holds at most 128 KiB).
const SNAPSHOT_PART = 16_000;
// A running match's log (its checkpoint in the snapshot says how many events to replay).
const MATCH_EVENTS_TABLE = 'CREATE TABLE IF NOT EXISTS match_events (match_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(match_id,seq))';
// Finished matches waiting to be published to their MatchArchive: facts and manifest, and the encoded replay chunks.
const OUTBOX_TABLES = [
  'CREATE TABLE IF NOT EXISTS archive_outbox (match_id TEXT PRIMARY KEY, entry TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS archive_chunks (match_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(match_id, idx))',
];
// A failed background job is retried after 30 s, then twice as long each time, at most an hour later.
const backoff = (failures) => Math.min(3600_000, 30_000 * 2 ** (failures - 1));
// A visible lobby listing is refreshed this often (the directory hides a listing a minute after its last refresh).
const LEASE_REFRESH_MS = 20_000;
// A room whose next timed step (a match timer) is due within this long stays in memory, and its in-memory timer never
// waits longer than this (a pending timer keeps the platform from hibernating or evicting the object).
const AWAKE_MS = 60_000;
// A save compares the snapshot with liveness timestamps rounded to this: pings alone write at most this often.
const LIVENESS_MS = 30_000;
const liveness = (key, value) => (key === 'lastSeen' ? Math.floor(value / LIVENESS_MS) : value);

/** A rules version this bundle can restore: its own or a retained one. */
const knownRulesVersion = (id) => id === RULES_VERSION || Object.hasOwn(retainedMatchVersions, id);

export class RoomDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();
    // What storage holds (see save): the room snapshot as compared, its KV parts, the match log, the outbox size,
    // the restore-attempt counter (restoreMatch), the armed alarm.
    this.savedState = null;
    this.parts = 0;
    this.savedLog = null;
    this.outboxSize = 0;
    this.storedAttempts = 0;
    this.alarmAt = null;
    // The in-memory timer (arm), at the room's next timed step.
    this.timer = null;
    this.timerAt = null;
    // Background jobs (startJobs): an archive being published; the lobby listing's job (in flight, failures in a row,
    // not before, what was published, when to refresh it); the login check's job.
    this.archiving = false;
    this.listing = { busy: false, failures: 0, retryAt: 0, fingerprint: null, refreshAt: 0 };
    this.logins = { busy: false, failures: 0, retryAt: 0 };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping","c":0}', '{"t":"pong","c":0}'));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try {
        await this.load();
      } catch (error) {
        logError('room_load_failed', { room: this.runtime?.code, object: ctx.id.toString(), error: errorFields(error) });
        throw error;
      }
    });
  }

  // Wake: the persisted room, the sockets that survived hibernation, then its running match.
  async load() {
    this.loading = true;
    const snapshot = await this.readSnapshot();
    // Rooms run their matches on the virtual scheduler, inside events: every change ends in the event's commit.
    this.runtime = new RoomRuntime({ snapshot });
    for (const ws of this.ctx.getWebSockets()) {
      // Closing sockets may still be enumerated; never rebind one over its replacement.
      if (ws.readyState !== 1) continue;
      const attachment = ws.deserializeAttachment();
      if (!attachment) { try { ws.close(CLOSE.LOST, 'missing session'); } catch {} continue; }
      // Its login is checked again in the background when due (checkLogins), not before the wake can go on.
      const adapter = new SocketAdapter(ws);
      this.sockets.set(ws, adapter);
      this.runtime.connect(adapter, { ip: attachment.ip, attachment });
    }
    const checkpoint = snapshot?.matchCheckpoint;
    if (checkpoint) {
      this.savedLog = { id: checkpoint.eventLogId, count: checkpoint.eventCount };
      await this.restoreMatch(checkpoint);
    }
    // What storage holds, so the first commit writes only what the wake changed.
    this.savedState = snapshot ? JSON.stringify(snapshot, liveness) : null;
    this.outboxSize = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='archive_outbox'`).one().n
      ? this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM archive_outbox').one().n : 0;
    this.alarmAt = await this.ctx.storage.getAlarm();
    this.refreshAutoResponses();
    this.runtime.reconcileSockets();
    this.runtime.sweep();
    await this.commit();
    this.loading = false;
  }

  async readSnapshot() {
    const meta = await this.ctx.storage.get('snapshot-meta');
    this.parts = meta?.parts || 0;
    if (!meta?.parts) return undefined;
    const keys = Array.from({ length: meta.parts }, (_, i) => `snapshot-${i}`);
    const parts = [];
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128);
      const chunks = await this.ctx.storage.get(batch);
      for (const key of batch) {
        if (typeof chunks.get(key) !== 'string') throw new Error('INCOMPLETE_ROOM_SNAPSHOT');
        parts.push(chunks.get(key));
      }
    }
    return JSON.parse(parts.join(''));
  }

  // A match that cannot be restored ends as interrupted; it never bricks the room or keeps its players seated.
  // A restore that never finishes (CPU or memory limit, the 30 s blockConcurrencyWhile timeout) resets the object
  // without reaching any catch, so each attempt is counted durably before the replay starts, and a second attempt
  // ends the match instead of replaying it again. The counter is cleared once the restored room has served an
  // event after this one (save), not by the restore itself.
  async restoreMatch(checkpoint) {
    const attempts = ((await this.ctx.storage.get(RESTORE_ATTEMPTS)) ?? 0) + 1;
    this.storedAttempts = attempts - 1;
    const context = { room: this.runtime.code, rulesVersion: checkpoint.rulesVersion, events: checkpoint.eventCount, attempts };
    // An unknown rules version means a deployment older than the match (a Cloudflare rollback).
    if (!knownRulesVersion(checkpoint.rulesVersion)) {
      this.interruptMatch(checkpoint, 'rollback', context, new Error('CHECKPOINT_VERSION'));
      return;
    }
    if (attempts > 1) {
      this.interruptMatch(checkpoint, 'restart', context, new Error('RESTORE_UNFINISHED'));
      return;
    }
    await this.ctx.storage.put(RESTORE_ATTEMPTS, attempts);
    await this.ctx.storage.sync();
    this.storedAttempts = attempts;
    try {
      await prepareMatchVersion(checkpoint.rulesVersion);
      this.runtime.restoreMatch({ ...checkpoint, events: this.matchLog(checkpoint) });
    } catch (error) {
      this.interruptMatch(checkpoint, 'restart', context, error);
      return;
    }
    logInfo('match_restored', context);
  }

  interruptMatch(checkpoint, reason, context, error) {
    logError('match_restore_failed', { ...context, reason, error: errorFields(error) });
    this.runtime.interruptMatch(checkpoint, reason);
  }

  // The match's event log as the Array the engines expect. Rows are read and parsed only while the engine iterates
  // them, so the stored payloads and the parsed events are never in memory together.
  matchLog(checkpoint) {
    const sql = this.ctx.storage.sql;
    const { count } = sql.exec('SELECT COUNT(*) AS count FROM match_events WHERE match_id=?', checkpoint.eventLogId).one();
    if (count !== checkpoint.eventCount) throw new Error('INCOMPLETE_MATCH_LOG');
    const events = new Array(count);
    events[Symbol.iterator] = function* () {
      for (const row of sql.exec('SELECT payload FROM match_events WHERE match_id=? ORDER BY seq', checkpoint.eventLogId)) {
        yield JSON.parse(row.payload);
      }
    };
    return events;
  }

  refreshAutoResponses() {
    for (const [ws, adapter] of this.sockets) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const session = this.runtime.network.conns.get(adapter)?.session;
      if (session && Number.isFinite(at)) session.lastSeen = Math.max(session.lastSeen, at);
    }
  }

  // One event, one critical section: due match timers run first, then the event, then the timers it made due at
  // once, then expiries, then the commit.
  // An error resets the object to its last commit (blockConcurrencyWhile); it is logged with the room first.
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
        logError('room_event_failed', { room: this.runtime.code, error: errorFields(error) });
        throw error;
      }
    });
  }

  // The end of every event: save what changed in one transaction, then release the event's output (clients never see
  // uncommitted state), start the background jobs, and schedule the next wake.
  async commit() {
    const rt = this.runtime;
    // A socket the event closed leaves the room, but still gets what the event sent it before its close.
    const closed = [];
    for (const [ws, adapter] of this.sockets) {
      const attachment = rt.attachment(adapter);
      if (attachment) {
        ws.serializeAttachment(attachment);
      } else {
        this.sockets.delete(ws);
        closed.push(adapter);
      }
    }
    const archives = rt.archiveOutbox.slice();
    if (rt.isEmpty() && !this.outboxSize) {
      await this.clear();
    } else {
      await this.save(archives);
      rt.archiveOutbox.splice(0, archives.length);
    }
    for (const adapter of [...this.sockets.values(), ...closed]) adapter.flush();
    this.startJobs();
    await this.schedule();
  }

  // An empty room keeps nothing: its storage is deleted (the object then ceases to exist).
  async clear() {
    if (this.parts || this.savedLog || this.storedAttempts || this.alarmAt != null) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    }
    this.parts = 0;
    this.savedState = null;
    this.savedLog = null;
    this.storedAttempts = 0;
    this.alarmAt = null;
  }

  // Write what changed since the last save, in one transaction: the room snapshot (only when it differs), the new
  // events of the match log, the archives of finished matches.
  async save(archives) {
    const rt = this.runtime;
    const snapshot = rt.snapshot();
    let log = null;
    if (snapshot.matchCheckpoint) {
      const { events, ...checkpoint } = snapshot.matchCheckpoint;
      const id = `${rt.generation}:${checkpoint.options.matchNo}`;
      const from = this.savedLog?.id === id ? this.savedLog.count : 0;
      log = { id, count: events.length, rows: events.slice(from).map((event, i) => [from + i, JSON.stringify(event)]) };
      snapshot.matchCheckpoint = { ...checkpoint, eventCount: events.length, eventLogId: id };
    }
    // The log of a match that ended (or could not be restored) goes with its checkpoint.
    const endedLog = this.savedLog && this.savedLog.id !== log?.id ? this.savedLog.id : null;
    // A restored match keeps its attempt counted until a later event commits (restoreMatch).
    const clearAttempts = this.storedAttempts > 0 && (!log || !this.loading);
    const state = JSON.stringify(snapshot, liveness);
    const changed = state !== this.savedState;
    if (!changed && !log?.rows.length && !endedLog && !clearAttempts && !archives.length) return;
    const encoded = [];
    for (const entry of archives) encoded.push({ entry, replay: await prepareArchive(entry) });
    // KV values have a size limit: chunk by UTF-16 characters so even non-ASCII text stays below it.
    const source = changed ? JSON.stringify(snapshot) : '';
    const parts = changed ? Math.ceil(source.length / SNAPSHOT_PART) : this.parts;
    const sql = this.ctx.storage.sql;
    if (log || endedLog) sql.exec(MATCH_EVENTS_TABLE);
    if (encoded.length) for (const ddl of OUTBOX_TABLES) sql.exec(ddl);
    await this.ctx.storage.transaction(async (txn) => {
      if (endedLog) sql.exec('DELETE FROM match_events WHERE match_id=?', endedLog);
      for (const [seq, payload] of log?.rows ?? []) sql.exec('INSERT INTO match_events VALUES (?,?,?)', log.id, seq, payload);
      for (const { entry: { facts, personal }, replay } of encoded) {
        sql.exec('INSERT INTO archive_outbox (match_id, entry) VALUES (?,?)', facts.matchId,
          JSON.stringify({ facts, personal, manifest: replay.manifest }));
        for (const chunk of replay.chunks) sql.exec('INSERT INTO archive_chunks VALUES (?,?,?)', facts.matchId, chunk.index, chunk.text);
      }
      if (clearAttempts) await txn.delete(RESTORE_ATTEMPTS);
      if (!changed) return;
      const entries = parts === this.parts ? {} : { 'snapshot-meta': { parts } };
      for (let i = 0; i < parts; i++) entries[`snapshot-${i}`] = source.slice(i * SNAPSHOT_PART, (i + 1) * SNAPSHOT_PART);
      const items = Object.entries(entries);
      for (let offset = 0; offset < items.length; offset += 128) await txn.put(Object.fromEntries(items.slice(offset, offset + 128)));
      const stale = Array.from({ length: Math.max(0, this.parts - parts) }, (_, i) => `snapshot-${parts + i}`);
      for (let offset = 0; offset < stale.length; offset += 128) await txn.delete(stale.slice(offset, offset + 128));
    });
    this.savedState = state;
    this.parts = parts;
    this.savedLog = log && { id: log.id, count: log.count };
    this.outboxSize += encoded.length;
    if (clearAttempts) this.storedAttempts = 0;
  }

  // Wake-ups. A room stays in memory, with an in-memory timer for its timed steps (match timers, a spectator count
  // update), while someone is connected to its running match (waking a sleeping match costs a full restore, so a
  // connected match never sleeps, even in an untimed phase or a paused battle), or while someone is connected and a
  // step is due, or the next step is close. Otherwise it may hibernate or be evicted, and a storage alarm wakes it at
  // its next deadline. While the room stays in memory, the alarm is written only when it must fire earlier than the
  // armed one (an early alarm just re-arms); a room that may sleep gets its exact deadline.
  async schedule() {
    const rt = this.runtime;
    const now = Date.now();
    const due = rt.timerDue();
    const connected = rt.connected();
    const watched = connected && !!rt.lobby.getRoom(rt.code)?.match;
    const awake = watched || (due != null && (connected || due - now < AWAKE_MS));
    // The timer fires at the next step or AWAKE_MS from now, whichever is first; an event with nothing to do commits
    // nothing.
    this.arm(awake ? Math.min(due ?? Infinity, now + AWAKE_MS) : null);
    const at = Math.min(rt.nextAlarm() ?? Infinity, awake || due == null ? Infinity : due, this.jobsDue());
    if (at === Infinity || at === this.alarmAt) return;
    const armed = this.alarmAt != null && this.alarmAt > now;
    if (armed && this.alarmAt < at && (awake || connected)) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  // The in-memory timer: one, at the room's next timed step.
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

  // Background jobs, started after a commit: the archives of finished matches, the public lobby listing, the logins of
  // open sockets. A failure is logged and retried after a backoff (the alarm wakes the room for it), never at every
  // event. Seat pointers need no job: a pointer this room no longer confirms is released by its next reader (seatOf).
  startJobs() {
    this.archiveNext();
    this.publishListing();
    this.checkLogins();
  }

  // The oldest due archive is published. A failed one waits for its own backoff, stored with it: it neither blocks the
  // archives of later matches nor is retried at every event.
  archiveNext() {
    if (!this.outboxSize || this.archiving) return;
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT match_id, entry, attempts FROM archive_outbox WHERE retry_at<=? ORDER BY retry_at, rowid LIMIT 1', Date.now()).toArray()[0];
    if (!row) return;
    this.archiving = true;
    const { facts, personal, manifest } = JSON.parse(row.entry);
    const chunks = sql.exec('SELECT idx, text FROM archive_chunks WHERE match_id=? ORDER BY idx', row.match_id).toArray()
      .map(({ idx, text }) => ({ index: idx, text }));
    const published = publishArchive(this.env, { facts, personal, encodedReplay: { manifest, chunks } });
    this.ctx.waitUntil(published.then(
      () => this.event(() => {
        this.ctx.storage.transactionSync(() => {
          sql.exec('DELETE FROM archive_chunks WHERE match_id=?', row.match_id);
          sql.exec('DELETE FROM archive_outbox WHERE match_id=?', row.match_id);
        });
        this.outboxSize -= 1;
        this.archiving = false;
      }),
      (error) => this.event(() => {
        const attempts = row.attempts + 1;
        const retryAt = Date.now() + backoff(attempts);
        sql.exec('UPDATE archive_outbox SET attempts=?, retry_at=? WHERE match_id=?', attempts, retryAt, row.match_id);
        this.archiving = false;
        logError('archive_publish_failed', { room: this.runtime.code, matchId: row.match_id, attempts, retryAt, error: errorFields(error) });
      })));
  }

  // The public lobby (SiteDirectory) lists rooms by lease: the room publishes its listing when it changes, and
  // refreshes one the directory shows every LEASE_REFRESH_MS (the directory hides it a minute after its last refresh).
  publishListing() {
    const rt = this.runtime;
    const room = rt.lobby.getRoom(rt.code);
    const job = this.listing;
    const now = Date.now();
    if (!room || job.busy || now < job.retryAt) return;
    const listing = {
      roomId: rt.code,
      generation: rt.generation,
      public: rt.publicRoom && room.mode === 'coop',
      connectedHumans: room.activeHumans().filter((s) => s.connected).length,
      occupied: room.seats.filter(Boolean).length,
      capacity: 4,
      inMatch: !!room.match,
      spectatorCount: rt.spectators.count,
      hostName: room.seatOf(room.hostId)?.name || '博士',
      difficulty: room.difficulty,
    };
    const fingerprint = JSON.stringify(listing);
    if (fingerprint === job.fingerprint && now < job.refreshAt) return;
    job.busy = true;
    const published = directoryOf(this.env).publishRoom({ ...listing, updatedAt: now, expiresAt: now + 60_000 });
    this.ctx.waitUntil(published.then(
      ({ visible }) => this.event(() => {
        const refreshAt = visible ? Date.now() + LEASE_REFRESH_MS : Infinity;
        this.listing = { busy: false, failures: 0, retryAt: 0, fingerprint, refreshAt };
      }),
      (error) => this.event(() => {
        job.busy = false;
        job.failures += 1;
        job.retryAt = Date.now() + backoff(job.failures);
        logWarn('listing_publish_failed', { room: rt.code, attempts: job.failures, error: errorFields(error) });
      })));
  }

  // Open sockets keep the login they were opened with (its session and expiry). Each is checked again with the directory
  // ROOM_LIMITS.loginCheckMs after the last check, in the background: a logout (which revokes the session) closes its
  // sockets with 4003 within that time, and no message ever waits for the directory. A failed check closes nothing.
  checkLogins() {
    const job = this.logins;
    if (job.busy || Date.now() < job.retryAt) return;
    const due = this.runtime.loginsDue();
    if (!due.length) return;
    job.busy = true;
    const directory = directoryOf(this.env);
    const checked = Promise.all(due.map((sessionId) => directory.getSession(sessionId)));
    this.ctx.waitUntil(checked.then(
      (sessions) => this.event(() => {
        this.runtime.checkLogins(new Map(due.map((sessionId, i) => [sessionId, sessions[i]])));
        this.logins = { busy: false, failures: 0, retryAt: 0 };
      }),
      (error) => this.event(() => {
        job.busy = false;
        job.failures += 1;
        job.retryAt = Date.now() + backoff(job.failures);
        logWarn('login_check_failed', { room: this.runtime.code, sessions: due.length, attempts: job.failures, error: errorFields(error) });
      })));
  }

  // When the next background job is due (Infinity: none): an archive's retry, the listing's retry or lease refresh,
  // the next login check. Called after arm().
  jobsDue() {
    const archive = !this.outboxSize || this.archiving ? Infinity
      : this.ctx.storage.sql.exec('SELECT MIN(retry_at) AS at FROM archive_outbox').one().at;
    const job = this.listing;
    const room = this.runtime.lobby.getRoom(this.runtime.code);
    // A match that may sleep (no in-memory timer) is never woken for its listing, since a wake costs a full restore:
    // its lease lapses (the lobby stops showing a match nobody is playing), and the next wake publishes it again.
    const listing = job.busy || !room || (room.match && !this.timer) ? Infinity
      : job.failures ? job.retryAt : job.refreshAt;
    const logins = this.logins.busy ? Infinity : Math.max(this.logins.retryAt, this.runtime.nextLoginCheck());
    return Math.min(archive, listing, logins);
  }

  async fetch(request) {
    await this.ready;
    return this.event(() => this.route(request));
  }

  // Internal routes: the Worker and the account routes call them on this object's stub.
  async route(request) {
    const url = new URL(request.url);
    const rt = this.runtime;
    if (['/_applications', '/_visibility'].includes(url.pathname)) return roomApplications(rt, request, this.env);
    if (url.pathname === '/_reserve' && request.method === 'POST') {
      const code = url.searchParams.get('room');
      if (!validCode(code)) return error(400, 'BAD_MSG');
      const ticket = rt.reserve(code, request.headers.get('X-Account-ID'));
      return ticket ? json({ code, ticket, generation: rt.generation }, 201) : error(409, 'ROOM_FULL');
    }
    if (url.pathname === '/_account') {
      // The room is the truth about an account's seat (worker/accounts/routes.js seatOf): 404 releases it.
      const accountId = request.headers.get('X-Account-ID');
      if (request.headers.get('X-Room-Generation') !== rt.generation || !rt.hasAccount(accountId)) return error(404, 'ROOM_NOT_FOUND');
      const reserved = rt.reservation?.accountId === accountId;
      if (request.method === 'DELETE') {
        // The account gives up a reservation it never used (worker/accounts/routes.js giveUpReservation).
        if (!reserved) return error(409, 'ALREADY_SEATED');
        rt.reservation = null;
        return json({ ok: true });
      }
      if (request.method === 'POST') {
        const ticket = rt.resumeAccount(accountId);
        return json({ code: rt.code, generation: rt.generation, ticket,
          join: rt.applications.list(accountId).some((x) => x.status === 'approved'), reserved });
      }
      return json({ activeSeat: { roomId: rt.code, roomGeneration: rt.generation }, status: rt.status(), reserved });
    }
    if (url.pathname === '/_status' && request.method === 'GET') {
      const status = rt.status();
      return status ? json(status) : error(404, 'ROOM_NOT_FOUND');
    }
    if (url.pathname !== '/_ws' || request.method !== 'GET') return error(404, 'BAD_MSG');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG');
    const accountId = request.headers.get('X-Account-ID');
    if (url.searchParams.get('room') !== rt.code || !rt.canConnect(accountId)) return refuseSocket(CLOSE.ROOM_GONE, 'no such room');
    const ip = request.headers.get('X-Room-IP') || '0.0.0.0';
    const limit = rt.admission(ip, accountId);
    if (limit) return refuseSocket(CLOSE.TRY_LATER, `connection limit (${limit})`);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const adapter = new SocketAdapter(server);
    this.sockets.set(server, adapter);
    const expires = request.headers.get('X-Session-Expires');
    rt.connect(adapter, { ip, ticket: url.searchParams.get('ticket'), accountId,
      sessionId: request.headers.get('X-Session-ID'), sessionExpiresAt: expires ? Number(expires) : null,
      avatarUrl: request.headers.get('X-Avatar-URL') || null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // A message never waits on another object: the socket's login is checked locally (its expiry) and again in the
  // background (checkLogins).
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

  async webSocketError(ws) {
    return this.webSocketClose(ws, 1011, 'socket error');
  }

  async alarm() {
    await this.ready;
    this.alarmAt = null;
    return this.event(() => {});
  }
}
