import { randomInt } from 'node:crypto';
import { APP_VERSION } from '../shared/constants.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { normalizeIp, limitKeyOf, TokenBucket } from '../server/net.js';
import { RoomRuntime, validCode } from './room-runtime.js';
import { prepareMatchVersion, retainedMatchVersions } from './match-versions.js';
import { RULES_VERSION } from '../shared/rules-version.js';
import { logInfo, logError, errorFields } from './log.js';
import { PACK_PATH, servePack } from './pack.js';
import { handleAuth, authenticate, accountOf, directoryOf } from './accounts/auth.js';
import { handleAccountRoutes, seatOf } from './accounts/routes.js';
import { handleLobbyRoutes, roomApplications } from './rooms/routes.js';
import { handleHistoryRoutes } from './archive/routes.js';
import { publishArchive,prepareArchive } from './archive/outbox.js';
import { handleBackupRoutes } from './storage/backup.js';

// the deployed commit (tools/build-worker.mjs buildId; esbuild defines it, unbundled tests see 'local')
const BUILD = typeof __SP_BUILD__ === 'string' ? __SP_BUILD__ : 'local';
const json = (body, status = 200, headers = {}) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (status, code, detail) => json({ error: code, ...(detail ? { detail } : {}) }, status);
const edgeIp = (request) => normalizeIp(request.headers.get('CF-Connecting-IP')) || '0.0.0.0';
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code), { locationHint: 'apac' });
const sameOrigin = (request) => !request.headers.has('Origin') || request.headers.get('Origin') === new URL(request.url).origin;
async function admit(env, ip, kind) {
  const stub = env.ADMISSION.get(env.ADMISSION.idFromName(limitKeyOf(ip)), { locationHint: 'apac' });
  const result = await stub.fetch(new Request(`https://admission.internal/${kind}`, { method: 'POST' }));
  return result.ok ? null : result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const backup=await handleBackupRoutes(request,env);if(backup)return backup;
    if(env.ADMISSION && (path==='/api/auth/github/start' || path==='/api/rooms' && request.method==='GET' || /\/applications$/.test(path))) {
      const limited=await admit(env,edgeIp(request),path.startsWith('/api/auth/')?'auth':request.method==='GET'?'status':'application');
      if(limited)return limited;
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
      if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
      const session = env.ACCOUNTS ? await authenticate(request, env) : null;
      if (env.ACCOUNTS && !session) return error(401, 'LOGIN_REQUIRED');
      if (session && request.headers.get('Origin') !== url.origin) return error(403, 'BAD_MSG');
      if (session) {
        // A create that failed after its reservation (e.g. at the first connect) goes on with that reservation.
        const seat = await seatOf(env, session.accountId, 'POST');
        if (seat?.reserved) return json({ code: seat.code, ticket: seat.ticket, generation: seat.generation });
        if (seat) return error(409, 'ALREADY_SEATED');
      }
      const limited = await admit(env, edgeIp(request), 'reserve');
      if (limited) return limited;
      for (let i = 0; i < 12; i++) {
        const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        const response = await roomStub(env, code).fetch(new Request(`https://room.internal/_reserve?room=${code}`, {
          method: 'POST', headers: session ? {'X-Account-ID':session.accountId} : {} }));
        if (response.status !== 409) {
          if (response.ok && session) {
            const route = await response.clone().json();
            const claim = await accountOf(env, session.accountId).claimSeat({ claimId: crypto.randomUUID(),
              seat: { roomId: route.code, roomGeneration: route.generation, matchId: null, seatId: null } });
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
      const limited = await admit(env, edgeIp(request), 'status');
      if (limited) return limited;
      return roomStub(env, code).fetch(new Request('https://room.internal/_status'));
    }
    if (path === '/ws') {
      if (request.method !== 'GET') return error(405, 'BAD_MSG');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG', 'WebSocket required');
      const code = (url.searchParams.get('room') || '').toUpperCase();
      if (!validCode(code)) return error(400, 'BAD_MSG', 'invalid room code');
      if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
      const ip = edgeIp(request);
      const session = env.ACCOUNTS ? await authenticate(request,env) : null;
      if (env.ACCOUNTS && !session) return error(401,'LOGIN_REQUIRED');
      const limited = await admit(env, ip, 'connect');
      if (limited) return limited;
      const dest = new URL('https://room.internal/_ws');
      dest.searchParams.set('room', code);
      const ticket = url.searchParams.get('ticket');
      if (ticket && /^[0-9a-f]{32}$/.test(ticket)) dest.searchParams.set('ticket', ticket);
      return roomStub(env, code).fetch(new Request(dest, { headers: { Upgrade: 'websocket', 'X-Room-IP': ip,
        ...(session ? {'X-Account-ID':session.accountId,'X-Session-ID':session.sessionId} : {}) } }));
    }
    if (path === PACK_PATH) return servePack(request, env);
    if (path.startsWith('/api/')) return error(404, 'ROOM_NOT_FOUND');
    return env.ASSETS ? env.ASSETS.fetch(request) : error(404, 'ROOM_NOT_FOUND');
  },
};

// One tiny, automatically-expiring limiter per edge-provided IP (/64 for IPv6), shared across rooms.
export class AdmissionDurableObject {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const kind = new URL(request.url).pathname.slice(1);
      const settings = { reserve: [8 / 60, 8], connect: [40 / 60, 20], status: [120 / 60, 30],auth:[10/60,5],application:[30/60,10] }[kind];
      if (request.method !== 'POST' || !settings) return error(404, 'BAD_MSG');
      const now = Date.now();
      const stored = await this.ctx.storage.get(kind);
      const bucket = new TokenBucket(...settings, now);
      if (stored) Object.assign(bucket, stored);
      const allowed = bucket.take(now);
      await this.ctx.storage.put(kind, { ...bucket });
      await this.ctx.storage.setAlarm(now + 120_000);
      return allowed ? new Response(null, { status: 204 })
        : json({ error: 'RATE', detail: 'too many requests from your network' }, 429, { 'Retry-After': '8' });
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// Adapt the Workers WebSocket surface to the existing Network's small EventEmitter-like contract.
class SocketAdapter {
  constructor(socket, buffered=false) { this.socket = socket; this.handlers = new Map(); this.closed = false; this.buffered=buffered; this.pending=[]; }
  get readyState() { return this.closed ? 3 : this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount || 0; }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, ...args) { for (const fn of this.handlers.get(type) || []) fn(...args); }
  send(data, callback) { if(this.buffered) this.pending.push(data); else this.socket.send(data); callback?.(); }
  flush() {if(!this.closed) for(const data of this.pending) this.socket.send(data); this.pending=[];}
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(code, reason); } finally { this.emit('close'); }
  }
  terminate() { this.close(1008, 'connection terminated'); }
}

// Storage key of the restore-attempt counter (RoomDurableObject.restoreMatch).
const RESTORE_ATTEMPTS = 'restore-attempts';
// The room snapshot is stored as KV values of this many UTF-16 characters (a value holds at most 128 KiB).
const SNAPSHOT_PART = 16_000;
// A running match's log (its checkpoint in the snapshot says how many events to replay).
const MATCH_EVENTS_TABLE = 'CREATE TABLE IF NOT EXISTS match_events (match_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(match_id,seq))';
// Finished matches waiting to be published to their MatchArchive: facts and manifest, and the encoded replay chunks.
const OUTBOX_TABLES = [
  'CREATE TABLE IF NOT EXISTS archive_outbox (match_id TEXT PRIMARY KEY, entry TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS archive_chunks (match_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(match_id, idx))',
];
// Match timers keep the room in memory while someone is connected or the next one is due within this long.
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
    // The in-memory match timer (arm).
    this.timer = null;
    this.timerAt = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping","c":0}', '{"t":"pong","c":0}'));
    this.ready = ctx.blockConcurrencyWhile(() => this.load());
  }

  // Wake: the persisted room, the sockets that survived hibernation, then its running match.
  async load() {
    this.loading = true;
    const snapshot = await this.readSnapshot();
    // Account rooms run their matches on the virtual scheduler, inside events: every change ends in the event's commit.
    this.runtime = new RoomRuntime({ snapshot, accounts: !!this.env.ACCOUNTS, onChange: this.env.ACCOUNTS ? undefined : () => this.queuePersist() });
    for (const ws of this.ctx.getWebSockets()) {
      // Closing sockets may still be enumerated; never rebind one over its replacement.
      if (ws.readyState !== 1) continue;
      if (snapshot?.running && !snapshot.matchCheckpoint) { try { ws.close(1012, 'active match interrupted by server restart'); } catch {} continue; }
      const attachment = ws.deserializeAttachment();
      if (!attachment) { try { ws.close(1011, 'missing session'); } catch {} continue; }
      if(this.env.ACCOUNTS) {
        const session=attachment.sessionId && await directoryOf(this.env).getSession(attachment.sessionId);
        if(!session || session.accountId!==attachment.accountId) {try{ws.close(4003,'login required');}catch{}continue;}
      }
      const adapter = new SocketAdapter(ws,!!this.env.ACCOUNTS);
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
  queuePersist() {
    // Anonymous rooms: a match on real timers can end outside any event.
    this.ctx.waitUntil(this.ctx.blockConcurrencyWhile(() => this.commit()));
  }

  // One event, one critical section: due match timers run first, then the event, then the timers it made due at
  // once, then expiries, then the commit.
  event(handle) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.refreshAutoResponses();
      this.runtime.pump();
      const result = await handle();
      this.runtime.pump();
      this.runtime.sweep();
      await this.commit();
      return result;
    });
  }

  // The end of every event: save what changed in one transaction, then release the event's output (clients never see
  // uncommitted state), start background publishing, and schedule the next wake.
  async commit() {
    const rt = this.runtime;
    for (const [ws, adapter] of this.sockets) {
      const attachment = rt.attachment(adapter);
      if (attachment) ws.serializeAttachment(attachment);
      else this.sockets.delete(ws);
    }
    const archives = rt.archiveOutbox.slice();
    if (rt.isEmpty() && !this.outboxSize) {
      await this.clear();
    } else {
      await this.save(archives);
      rt.archiveOutbox.splice(0, archives.length);
    }
    for (const adapter of this.sockets.values()) adapter.flush();
    this.publish();
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

  // Wake-ups. Match timers run from memory while someone is connected or the next one is close (no storage write, no
  // restore); otherwise the room may hibernate or be evicted, and a storage alarm wakes it at the next deadline. While
  // the room stays in memory, the alarm is written only when it must fire earlier than the armed one (an early alarm
  // just re-arms); a room that may sleep gets its exact deadline, since waking a sleeping match costs a restore.
  async schedule() {
    const rt = this.runtime;
    const now = Date.now();
    const due = rt.matchDue();
    const connected = rt.connected();
    const awake = due != null && (connected || due - now < AWAKE_MS);
    this.arm(awake ? due : null);
    const at = Math.min(rt.nextAlarm() ?? Infinity, awake || due == null ? Infinity : due, this.outboxSize ? now + 30_000 : Infinity);
    if (at === Infinity || at === this.alarmAt) return;
    const armed = this.alarmAt != null && this.alarmAt > now;
    if (armed && this.alarmAt < at && (awake || connected)) return;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }

  // The in-memory match timer: one, at the next match deadline.
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

  // Background side effects of committed state: seat claims of ended applications, the oldest finished match's
  // archive, the public lobby listing.
  publish() {
    const rt = this.runtime;
    if(this.env.ACCOUNTS && !this.releasingClaims) {
      const terminal=rt.applications.list().filter(item=>['expired','cancelled','rejected'].includes(item.status) && !item.released);
      if(terminal.length) {
        this.releasingClaims=true;
        this.ctx.waitUntil(Promise.all(terminal.map(async item=>{
          const account=accountOf(this.env,item.accountId);
          await account.releaseSeat({claimId:item.id});await account.clearApplication(rt.code,item.id);
        })).then(()=>this.event(()=>{
          for(const item of terminal){const current=rt.applications.items.find(x=>x.id===item.id);if(current)current.released=true;}
          this.releasingClaims=false;
        })).catch(()=>{this.releasingClaims=false;}));
      }
    }
    if (this.env.MATCH_ARCHIVES && this.outboxSize && !this.archiving) {
      this.archiving = true;
      const sql = this.ctx.storage.sql;
      const row = sql.exec('SELECT match_id, entry FROM archive_outbox ORDER BY rowid LIMIT 1').one();
      const { facts, personal, manifest } = JSON.parse(row.entry);
      const chunks = sql.exec('SELECT idx, text FROM archive_chunks WHERE match_id=? ORDER BY idx', row.match_id).toArray()
        .map(({ idx, text }) => ({ index: idx, text }));
      this.ctx.waitUntil(publishArchive(this.env, { facts, personal, encodedReplay: { manifest, chunks } })
        .then(() => this.event(() => {
          this.ctx.storage.transactionSync(() => {
            sql.exec('DELETE FROM archive_chunks WHERE match_id=?', row.match_id);
            sql.exec('DELETE FROM archive_outbox WHERE match_id=?', row.match_id);
          });
          this.outboxSize -= 1;
          this.archiving = false;
        }))
        .catch(() => { this.archiving = false; }));
    }
    if(this.env.SITES) {
      const room=rt.lobby.getRoom(rt.code), now=Date.now();
      if(room) {
        const listing={roomId:rt.code,generation:rt.generation,public:rt.publicRoom && room.mode==='coop',
          connectedHumans:room.activeHumans().filter(s=>s.connected).length,occupied:room.seats.filter(Boolean).length,
          capacity:4,inMatch:!!room.match,spectatorCount:rt.spectators.count,hostName:room.seatOf(room.hostId)?.name || '博士',difficulty:room.difficulty};
        const fingerprint=JSON.stringify(listing);
        if(fingerprint!==this.lastListing || now-(this.lastPublished || 0)>=20000) {
          this.lastListing=fingerprint;this.lastPublished=now;
          this.ctx.waitUntil(directoryOf(this.env).publishRoom({...listing,updatedAt:now,expiresAt:now+60000})
            .catch(()=>{this.lastPublished=0;}));
        }
      }
    }
  }

  async fetch(request) {
    await this.ready;
    return this.event(() => this.route(request));
  }

  // Internal routes: the Worker and the account routes call them on this object's stub.
  async route(request) {
    const url = new URL(request.url);
    const rt = this.runtime;
    if (this.env.ACCOUNTS && ['/_applications', '/_visibility'].includes(url.pathname)) return roomApplications(rt, request, this.env);
    if (url.pathname === '/_reserve' && request.method === 'POST') {
      const code = url.searchParams.get('room');
      if (!validCode(code)) return error(400, 'BAD_MSG');
      const ticket = rt.reserve(code, request.headers.get('X-Account-ID'));
      return ticket ? json({ code, ticket, ...(rt.accounts ? { generation: rt.generation } : {}) }, 201) : error(409, 'ROOM_FULL');
    }
    if (url.pathname === '/_account') {
      // The room is the truth about an account's seat (worker/accounts/routes.js seatOf): 404 releases it.
      const accountId = request.headers.get('X-Account-ID');
      if (request.headers.get('X-Room-Generation') !== rt.generation || !rt.hasAccount(accountId)) return error(404, 'ROOM_NOT_FOUND');
      if (request.method === 'POST') {
        const ticket = rt.resumeAccount(accountId);
        return json({ code: rt.code, generation: rt.generation, ticket,
          join: rt.applications.list(accountId).some((x) => x.status === 'approved'), reserved: rt.reservation?.accountId === accountId });
      }
      return json({ activeSeat: { roomId: rt.code, roomGeneration: rt.generation }, status: rt.status() });
    }
    if (url.pathname === '/_status' && request.method === 'GET') {
      const status = rt.status();
      return status ? json(status) : error(404, 'ROOM_NOT_FOUND');
    }
    if (url.pathname !== '/_ws' || request.method !== 'GET') return error(404, 'BAD_MSG');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG');
    if (!rt.canConnect() || url.searchParams.get('room') !== rt.code) return error(404, 'ROOM_NOT_FOUND');
    const ip = request.headers.get('X-Room-IP') || '0.0.0.0';
    if (rt.admission(ip,request.headers.get('X-Account-ID'))) return error(429, 'RATE', 'connection limit');
    const profile = this.env.ACCOUNTS && request.headers.get('X-Account-ID')
      ? await accountOf(this.env,request.headers.get('X-Account-ID')).getProfile() : null;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const adapter = new SocketAdapter(server,!!this.env.ACCOUNTS);
    this.sockets.set(server, adapter);
    rt.connect(adapter, { ip, ticket: url.searchParams.get('ticket'), accountId: request.headers.get('X-Account-ID'),
      sessionId:request.headers.get('X-Session-ID'), avatarUrl:profile?.avatarUrl ?? null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (this.env.ACCOUNTS) {
      const adapter=this.sockets.get(ws), meta=adapter && this.runtime.socketMeta.get(adapter);
      const session=meta?.sessionId && await directoryOf(this.env).getSession(meta.sessionId);
      if (!session || session.accountId!==meta.accountId || session.expiresAt<=Date.now()) { adapter?.close(4003,'login required'); return; }
    }
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
