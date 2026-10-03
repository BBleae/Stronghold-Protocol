import { randomInt } from 'node:crypto';
import { APP_VERSION } from '../shared/constants.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { normalizeIp, limitKeyOf, TokenBucket } from '../server/net.js';
import { RoomRuntime, validCode } from './room-runtime.js';
import { PACK_PATH, servePack } from './pack.js';
import { handleAuth, authenticate, accountOf, directoryOf } from './accounts/auth.js';
import { handleAccountRoutes } from './accounts/routes.js';
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
        const parts=[];
        for(let offset=0;offset<keys.length;offset+=128) {
          const batch=keys.slice(offset,offset+128),chunks=await ctx.storage.get(batch);
          for(const key of batch) {
            if(typeof chunks.get(key)!=='string')throw new Error('INCOMPLETE_ROOM_SNAPSHOT');
            parts.push(chunks.get(key));
          }
        }
        snapshot = JSON.parse(parts.join(''));
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
        if(env.ACCOUNTS) {
          const session=attachment.sessionId && await directoryOf(env).getSession(attachment.sessionId);
          if(!session || session.accountId!==attachment.accountId) {try{ws.close(4003,'login required');}catch{}continue;}
        }
        const adapter = new SocketAdapter(ws,!!env.ACCOUNTS);
        this.sockets.set(ws, adapter);
        this.runtime.connect(adapter, { ip: attachment.ip, attachment });
      }
      this.refreshAutoResponses();
      this.runtime.reconcileSockets();
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
      this.persistedLogId=null;this.persistedEventCount=0;
      for(const adapter of this.sockets.values())adapter.flush();
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
      const items=Object.entries(entries);
      for(let offset=0;offset<items.length;offset+=128)await txn.put(Object.fromEntries(items.slice(offset,offset+128)));
      if(count<this.parts) {
        const oldKeys=Array.from({length:this.parts-count},(_,i)=>`snapshot-${i+count}`);
        for(let offset=0;offset<oldKeys.length;offset+=128)await txn.delete(oldKeys.slice(offset,offset+128));
      }
    });
    this.parts = count;
    if(checkpoint) {this.persistedLogId=logId;this.persistedEventCount=checkpoint.eventCount;}
    for(const adapter of this.sockets.values()) adapter.flush();
    if(this.env.ACCOUNTS && !this.releasingClaims) {
      const terminal=rt.applications.list().filter(item=>['expired','cancelled','rejected'].includes(item.status) && !item.released);
      if(terminal.length) {
        this.releasingClaims=true;
        this.ctx.waitUntil(Promise.all(terminal.map(async item=>{
          const account=accountOf(this.env,item.accountId);
          await account.releaseSeat({claimId:item.id});await account.clearApplication(rt.code,item.id);
        })).then(()=>this.ctx.blockConcurrencyWhile(async()=>{
          for(const item of terminal){const current=rt.applications.items.find(x=>x.id===item.id);if(current)current.released=true;}
          this.releasingClaims=false;await this.persist();
        })).catch(()=>{this.releasingClaims=false;}));
      }
    }
    if(this.env.MATCH_ARCHIVES && rt.archiveOutbox.length && !this.archiving) {
      this.archiving=true;
      const entry=rt.archiveOutbox[0];
      const publish=async()=>{
        if(!entry.encodedReplay) {
          const encoded=await prepareArchive(entry);
          // Freeze exact compressed bytes durably before the first immutable remote write.
          await this.ctx.blockConcurrencyWhile(async()=>{entry.encodedReplay=encoded;delete entry.replay;await this.persist();});
        }
        await publishArchive(this.env,entry);
      };
      this.ctx.waitUntil(publish().then(()=>this.ctx.blockConcurrencyWhile(async()=>{
        rt.archiveOutbox=rt.archiveOutbox.filter(x=>x.facts.matchId!==entry.facts.matchId);
        this.archiving=false;await this.persist();
      })).catch(()=>{this.archiving=false;}));
    }
    if(this.env.SITES) {
      const room=rt.lobby.getRoom(rt.code), now=Date.now();
      if(room) {
        const listing={roomId:rt.code,generation:rt.generation,public:rt.publicRoom && room.mode==='coop',
          connectedHumans:room.activeHumans().filter(s=>s.connected).length,occupied:room.seats.filter(Boolean).length,
          capacity:4,inMatch:!!room.match,hostName:room.seatOf(room.hostId)?.name || '博士',difficulty:room.difficulty};
        const fingerprint=JSON.stringify(listing);
        if(fingerprint!==this.lastListing || now-(this.lastPublished || 0)>=20000) {
          this.lastListing=fingerprint;this.lastPublished=now;
          this.ctx.waitUntil(directoryOf(this.env).publishRoom({...listing,updatedAt:now,expiresAt:now+60000})
            .catch(()=>{this.lastPublished=0;}));
        }
      }
    }
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
      if(this.env.ACCOUNTS && ['/_applications','/_visibility'].includes(url.pathname)) {
        const response=await roomApplications(rt,request,this.env);await this.persist();return response;
      }
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
          return ticket ? json({code:rt.code,ticket,join:rt.applications.list(accountId).some(x=>x.status==='approved'),reserved:rt.reservation?.accountId===accountId}) : error(404,'ROOM_NOT_FOUND');
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
