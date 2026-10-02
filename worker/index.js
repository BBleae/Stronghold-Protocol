import { randomInt } from 'node:crypto';
import { APP_VERSION } from '../shared/constants.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { normalizeIp, limitKeyOf, TokenBucket } from '../server/net.js';
import { RoomRuntime, validCode } from './room-runtime.js';
import { handleAuth, authenticate, accountOf, directoryOf } from './accounts/auth.js';
import { handleAccountRoutes } from './accounts/routes.js';

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
    const auth = await handleAuth(request, env);
    if (auth) return auth;
    const accountResponse = await handleAccountRoutes(request, env);
    if (accountResponse) return accountResponse;
    if (path === '/healthz') return request.method === 'GET'
      ? json({ ok: true, runtime: 'cloudflare', version: APP_VERSION }) : error(405, 'BAD_MSG');
    // Internal endpoints are only invoked on a DO stub; the public entry point never forwards them.
    if (path.startsWith('/_')) return error(404, 'ROOM_NOT_FOUND');
    if (path === '/api/rooms') {
      if (request.method !== 'POST') return error(405, 'BAD_MSG');
      if (!sameOrigin(request)) return error(403, 'BAD_MSG', 'origin mismatch');
      const session = env.ACCOUNTS ? await authenticate(request, env) : null;
      if (env.ACCOUNTS && !session) return error(401, 'LOGIN_REQUIRED');
      if (session && request.headers.get('Origin') !== url.origin) return error(403, 'BAD_MSG');
      if (session && await accountOf(env, session.accountId).getActiveSeat()) return error(409, 'ALREADY_SEATED');
      const limited = await admit(env, edgeIp(request), 'reserve');
      if (limited) return limited;
      for (let i = 0; i < 12; i++) {
        const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        const response = await roomStub(env, code).fetch(new Request(`https://room.internal/_reserve?room=${code}`, {
          method: 'POST', headers: session ? {'X-Account-ID':session.accountId} : {} }));
        if (response.status !== 409) {
          if (response.ok && session) {
            const route=await response.clone().json(), claimId=crypto.randomUUID();
            const claim=await accountOf(env,session.accountId).claimSeat({claimId,expiresAt:Date.now()+120000,
              seat:{roomId:route.code,roomGeneration:route.generation,matchId:null,seatId:null}});
            if (!claim.ok) return error(409,'ALREADY_SEATED');
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
      const settings = { reserve: [8 / 60, 8], connect: [40 / 60, 20], status: [120 / 60, 30] }[kind];
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

export class RoomDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();
    this.activeTimer = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping","c":0}', '{"t":"pong","c":0}'));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get('snapshot-meta');
      let snapshot;
      if (meta?.parts) {
        const keys = Array.from({ length: meta.parts }, (_, i) => `snapshot-${i}`);
        const chunks = await ctx.storage.get(keys);
        snapshot = JSON.parse(keys.map((k) => chunks.get(k)).join(''));
      }
      if(snapshot?.matchCheckpoint?.eventLogId) {
        const c=snapshot.matchCheckpoint;
        c.events=ctx.storage.sql.exec('SELECT payload FROM match_events WHERE match_id=? ORDER BY seq',c.eventLogId).toArray().map(r=>JSON.parse(r.payload));
        if(c.events.length!==c.eventCount) throw new Error('INCOMPLETE_MATCH_LOG');
        this.persistedLogId=c.eventLogId;this.persistedEventCount=c.events.length;
      }
      this.parts = meta?.parts || 0;
      this.runtime = new RoomRuntime({ snapshot, accounts: !!env.ACCOUNTS, onChange: () => this.queuePersist() });
      for (const ws of ctx.getWebSockets()) {
        // Closing sockets may still be enumerated; never rebind one over its replacement.
        if (ws.readyState !== 1) continue;
        if (snapshot?.running && !snapshot.matchCheckpoint) { try { ws.close(1012, 'active match interrupted by server restart'); } catch {} continue; }
        const attachment = ws.deserializeAttachment();
        if (!attachment) { try { ws.close(1011, 'missing session'); } catch {} continue; }
        const adapter = new SocketAdapter(ws,!!env.ACCOUNTS);
        this.sockets.set(ws, adapter);
        this.runtime.connect(adapter, { ip: attachment.ip, attachment });
      }
      this.refreshAutoResponses();
      this.runtime.sweep();
      await this.persist();
    });
  }
  refreshAutoResponses() {
    for (const [ws, adapter] of this.sockets) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const session = this.runtime.network.conns.get(adapter)?.session;
      if (session && Number.isFinite(at)) session.lastSeen = Math.max(session.lastSeen, at);
    }
  }
  queuePersist() {
    // Match completion can be initiated by one of its existing timers, outside a WebSocket event.
    this.ctx.waitUntil(this.ctx.blockConcurrencyWhile(() => this.persist()));
  }
  async persist() {
    const rt = this.runtime;
    const active = !!rt.status()?.inMatch;
    if (active && !this.activeTimer) {
      // An untimed solo phase still owns live match memory. Explicitly prevent hibernation until it ends.
      this.activeTimer = setInterval(() => {
        this.ctx.waitUntil(this.ctx.blockConcurrencyWhile(async () => {
          this.refreshAutoResponses(); rt.pump(); rt.sweep(); await this.persist();
        }));
      }, this.env.ACCOUNTS ? 100 : 30_000);
    } else if (!active && this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }
    for (const [ws, adapter] of this.sockets) {
      const attachment = rt.attachment(adapter);
      if (attachment) ws.serializeAttachment(attachment);
      else this.sockets.delete(ws);
    }
    if (rt.isEmpty()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.parts = 0;
      return;
    }
    // KV values have a size limit. Chunk by UTF-16 characters so even non-ASCII names stay below it.
    const snapshot=rt.snapshot(), checkpoint=snapshot.matchCheckpoint;
    let newEvents=[], logId=null;
    if(checkpoint) {
      logId=rt.generation + ':' + checkpoint.options.matchNo;
      const offset=this.persistedLogId===logId ? this.persistedEventCount || 0 : 0;
      newEvents=checkpoint.events.slice(offset).map((value,i)=>({seq:offset+i,payload:JSON.stringify(value)}));
      checkpoint.eventCount=checkpoint.events.length;checkpoint.eventLogId=logId;
      delete checkpoint.events;
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS match_events (match_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(match_id,seq))');
    }
    const source = JSON.stringify(snapshot);
    const count = Math.ceil(source.length / 16_000);
    const entries = { 'snapshot-meta': { parts: count } };
    for (let i = 0; i < count; i++) entries[`snapshot-${i}`] = source.slice(i * 16_000, (i + 1) * 16_000);
    await this.ctx.storage.transaction(async (txn) => {
      for(const row of newEvents) this.ctx.storage.sql.exec('INSERT INTO match_events VALUES (?,?,?)',logId,row.seq,row.payload);
      await txn.put(entries);
      if (count < this.parts) await txn.delete(Array.from({ length: this.parts - count }, (_, i) => `snapshot-${i + count}`));
    });
    this.parts = count;
    if(checkpoint) {this.persistedLogId=logId;this.persistedEventCount=checkpoint.eventCount;}
    for(const adapter of this.sockets.values()) adapter.flush();
    const at = rt.nextAlarm();
    if (at) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      const rt = this.runtime;
      this.refreshAutoResponses();
      rt.sweep();
      if (url.pathname === '/_reserve' && request.method === 'POST') {
        const code = url.searchParams.get('room');
        if (!validCode(code)) return error(400, 'BAD_MSG');
        const ticket = rt.reserve(code, request.headers.get('X-Account-ID'));
        await this.persist();
        return ticket ? json({ code, ticket, ...(rt.accounts ? {generation:rt.generation} : {}) }, 201) : error(409, 'ROOM_FULL');
      }
      if (url.pathname === '/_account') {
        const accountId=request.headers.get('X-Account-ID');
        if (request.headers.get('X-Room-Generation')!==rt.generation || !rt.hasAccount(accountId)) return error(404,'ROOM_NOT_FOUND');
        if (request.method==='POST') {
          const ticket=rt.resumeAccount(accountId); await this.persist();
          return ticket ? json({code:rt.code,ticket}) : error(404,'ROOM_NOT_FOUND');
        }
        return json({activeSeat:{roomId:rt.code,roomGeneration:rt.generation},status:rt.status()});
      }
      if (url.pathname === '/_status' && request.method === 'GET') {
        const status = rt.status();
        await this.persist();
        return status ? json(status) : error(404, 'ROOM_NOT_FOUND');
      }
      if (url.pathname !== '/_ws' || request.method !== 'GET') return error(404, 'BAD_MSG');
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'BAD_MSG');
      if (!rt.canConnect() || url.searchParams.get('room') !== rt.code) return error(404, 'ROOM_NOT_FOUND');
      const ip = request.headers.get('X-Room-IP') || '0.0.0.0';
      if (rt.admission(ip)) return error(429, 'RATE', 'connection limit');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const adapter = new SocketAdapter(server,!!this.env.ACCOUNTS);
      this.sockets.set(server, adapter);
      rt.connect(adapter, { ip, ticket: url.searchParams.get('ticket'), accountId: request.headers.get('X-Account-ID'),
        sessionId:request.headers.get('X-Session-ID') });
      await this.persist();
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async webSocketMessage(ws, message) {
    await this.ready;
    if (this.env.ACCOUNTS) {
      const adapter=this.sockets.get(ws), meta=adapter && this.runtime.socketMeta.get(adapter);
      const session=meta?.sessionId && await directoryOf(this.env).getSession(meta.sessionId);
      if (!session || session.accountId!==meta.accountId || session.expiresAt<=Date.now()) { adapter?.close(4003,'login required'); return; }
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const adapter = this.sockets.get(ws);
      if (adapter) this.runtime.message(adapter, message);
      await this.persist();
    });
  }
  async webSocketClose(ws, code, reason) {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      const adapter = this.sockets.get(ws);
      if (adapter) { this.runtime.disconnect(adapter); this.sockets.delete(ws); }
      try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
      await this.persist();
    });
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011, 'socket error'); }
  async alarm() {
    await this.ready;
    return this.ctx.blockConcurrencyWhile(async () => {
      this.refreshAutoResponses();
      this.runtime.pump();
      this.runtime.sweep();
      await this.persist();
    });
  }
}
