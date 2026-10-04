// Platform adapter only: the authoritative game rules remain in Lobby / Network / Match.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { Lobby, Room, CODE_ALPHABET } from '../server/lobby.js';
import { Network, Session, SessionRegistry, sendSession, normalizeIp, limitKeyOf } from '../server/net.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';
import { RecordedMatch, exportMatch, restoreMatch } from '../server/match/checkpoint.js';
import { ApplicationQueue } from './rooms/applications.js';
import { retainedMatchVersions } from './match-versions.js';
import { Spectators } from './rooms/spectators.js';

export const ROOM_LIMITS = Object.freeze({ sockets: 16, socketsPerIp: 8, sessions: 32, messageBytes: 65_536,
  reservationMs: 120_000, idleSocketMs: 90_000 });
export const validCode = (s) => typeof s === 'string' && s.length === 4 && [...s].every((c) => CODE_ALPHABET.includes(c));

class RoomNetwork extends Network {
  onHelloMsg(conn, msg, now) {
    const prefix = `${this.roomRuntime.code}.`;
    let token = typeof msg.token === 'string' && msg.token.startsWith(prefix) ? msg.token.slice(prefix.length) : undefined;
    if (this.roomRuntime.accounts) {
      const meta = this.roomRuntime.socketMeta.get(conn.ws);
      if (!meta?.accountId) { conn.close(4003, 'login required'); return; }
      const previous = [...this.registry.all()].find(s => s.accountId === meta.accountId);
      const presented = token && this.registry.byToken(token);
      if (presented && presented.accountId !== meta.accountId) {
        this.reply(conn, {t: 'error', code: ERR.BAD_MSG, detail: 'account mismatch', rid: msg.rid}); return;
      }
      if (previous && this.roomRuntime.lobby.roomOf(previous) && !conn.session && !meta.takeover && token !== previous.token) {
        this.reply(conn, {t: 'error', code: ERR.BAD_MSG, detail: 'resume required', rid: msg.rid}); return;
      }
      token = previous?.token;
    }
    super.onHelloMsg(conn, { ...msg, token }, now);
  }
  reply(conn, msg) {
    return super.reply(conn, msg.t === 'welcome' ? { ...msg, token: `${this.roomRuntime.code}.${msg.token}` } : msg);
  }
}

class AlarmLobby extends Lobby {
  // The platform's one alarm handles every lobby grace deadline; no idle JS timer prevents hibernation.
  deadlines = new Map();
  startGrace(room, seat) { this.deadlines.set(seat.playerId, this.now() + this.opts.lobbyGraceMs); }
  clearGrace(playerId) { this.deadlines.delete(playerId); }
  resync(session, coalesce) {
    if (this.roomOf(session)?.match) super.resync(session, coalesce);
    else this.runResync(session);
  }
  onMatchEnd(room, ctx, summary) {
    this.onArchive?.(room,ctx,summary);
    super.onMatchEnd(room, ctx, summary);
    this.onSpectatorEnd?.();
    this.onChange?.();
  }
  expireGrace() {
    for (const [id, at] of this.deadlines) {
      if (at > this.now()) continue;
      this.deadlines.delete(id);
      const s = this.registry.byId(id);
      const room = s && this.roomOf(s);
      if (!room || room.match || s.connected) continue;
      s.notice = 'timeout';
      s.pendingResult = this.replayFor(room, id);
      this.removeMember(room, id);
    }
  }
}

export class RoomRuntime {
  constructor({ snapshot, now = Date.now, onChange = () => {}, accounts = false } = {}) {
    this.accounts = accounts;
    this.generation = snapshot?.generation || randomBytes(16).toString('hex');
    this.resumeTickets = new Map(snapshot?.resumeTickets || []);
    this.applications = new ApplicationQueue({snapshot:snapshot?.applications,now});
    this.publicRoom = snapshot?.publicRoom ?? false;
    this.archiveOutbox=structuredClone(snapshot?.archiveOutbox || []);
    this.now = now;
    this.code = snapshot?.code || null;
    this.reservation = snapshot?.reservation || null;
    this.interruptedUntil = snapshot?.interruptedUntil || 0;
    this.socketMeta = new Map();
    this.registry = new SessionRegistry({ now, maxSessions: ROOM_LIMITS.sessions });
    this.lobby = new AlarmLobby({ registry: this.registry, now, options: { maxRooms: 1 },
      ...(accounts ? {MatchClass:RecordedMatch} : {}) });
    this.lobby.genCode = () => this.code;
    this.spectators=new Spectators(this);
    this.lobby.onSpectatorEnd=()=>this.spectators.pump();
    this.lobby.broadcastState=()=>this.spectators.presence();
    this.lobby.sendState=(room,session)=>this.spectators.state(session);
    const broadcast=this.lobby.broadcastRoom.bind(this.lobby);
    this.lobby.broadcastRoom=(room,msg)=>{const result=broadcast(room,msg);this.spectators.broadcast(msg);return result;};
    this.lobby.onChange = onChange;
    this.lobby.onArchive = (room, ctx, summary) => {
      const match = ctx.match;
      if (!match?.recording || !room.archiveParticipants?.length) return;
      this.queueArchive(room, {
        startedAt: match.startedAt,
        result: summary,
        replay: { schemaVersion: 1, rulesVersion: match.recording.rulesVersion, battles: match.replayBattles },
        personal: (playerId) => {
          const result = summary.players?.find((p) => p.playerId === playerId);
          const departure = match.departures[playerId];
          return {
            status: departure ? 'left' : ['error', 'abandoned'].includes(summary.reason) ? 'interrupted' : 'completed',
            victory: !!summary.victory,
            hiddenCleared: !!summary.hiddenCleared,
            round: departure?.round || match.round,
            stats: departure?.stats || { ...match.players.get(playerId)?.stats, ...result?.stats },
            operators: match.usedOperators[playerId] || [],
            result,
          };
        },
      });
    };
    const handler = {
      onHello: (s, info) => {
        const meta = this.socketMeta.get(s.ws);
        if (this.accounts && meta?.accountId) {
          s.accountId = meta.accountId;
          if (meta.avatarUrl !== undefined) s.avatarUrl = meta.avatarUrl;
          if (!info.repeat) s.connectionEpoch = (s.connectionEpoch || 0) + 1;
          meta.connectionEpoch = s.connectionEpoch;
        }
        if (this.socketMeta.get(s.ws)?.canCreate && this.reservation) s.canCreate = true;
        if(s.spectating)this.spectators.hello(s);else this.lobby.onHello(s, info);
        if (this.interruptedUntil > this.now()) sendSession(s, { t: 'room.closed', reason: 'restart' });
      },
      onMessage: (s, msg) => {
        if(msg.t==='room.spectate')return this.spectators.join(s);
        if(s.spectating)return this.spectators.command(s,msg);
        if(this.accounts && msg.t==='room.start') {
          const room=this.lobby.roomOf(s);
          if(room && !room.match) room.archiveParticipants=room.activeHumans().map(p=>({
            playerId:p.playerId,accountId:this.registry.byId(p.playerId)?.accountId})).filter(p=>p.accountId);
        }
        if(this.accounts && msg.t==='room.join' && !this.lobby.roomOf(s)) {
          const ticket=this.socketMeta.get(s.ws)?.joinTicket;
          const entry=this.applications.list(s.accountId).find(x=>x.status==='approved' && x.ticket===ticket);
          if(!entry) return {error:ERR.NOT_HOST,detail:'approval required'};
          const result=this.lobby.onMessage(s,msg);
          if(!result.error) this.applications.consume(s.accountId,ticket);
          return result;
        }
        if(this.accounts && msg.t==='room.addBot') {
          const room=this.lobby.roomOf(s);
          if(room && room.seats.filter(x=>!x).length<=this.applications.reservedCount()) return {error:ERR.ROOM_FULL};
        }
        if (msg.t === 'room.create') {
          if (!s.canCreate || !this.reservation) return { error: ERR.NOT_HOST, detail: 'reservation required' };
          const result = this.lobby.onMessage(s, msg);
          if (!result.error) {this.reservation = null;this.publicRoom=this.accounts && msg.mode==='coop';}
          return result;
        }
        const result=this.lobby.onMessage(s, msg);
        if(!result.error && msg.t==='room.start') this.applications.invalidate();
        return result;
      },
      routeGame: (s, msg) => s.spectating?this.spectators.command(s,msg):this.lobby.routeGame(s, msg),
      onDisconnect: (s) => {if(s.spectating){this.spectators.views.delete(s.playerId);this.spectators.presence();}else this.lobby.onDisconnect(s);},
      onExpire: (s) => {if(s.spectating)this.spectators.leave(s);else this.lobby.onExpire(s);},
    };
    for(const key of ['onMessage','routeGame']) {
      const original=handler[key];
      handler[key]=(session,msg)=>{
        if(!this.accounts || !msg.commandId) return original(session,msg);
        if(typeof msg.commandId!=='string' || !/^[a-zA-Z0-9:-]{1,80}$/.test(msg.commandId)) return {error:ERR.BAD_MSG};
        const {rid,commandId,...intent}=msg, fingerprint=JSON.stringify(intent);
        const records=session.commandResults || (session.commandResults={});
        if(Object.hasOwn(records,commandId)) {
          const previous=records[commandId];
          return previous.fingerprint===fingerprint ? previous.result : {error:ERR.BAD_MSG};
        }
        if(Object.keys(records).length>=50000) return {error:ERR.RATE};
        const result=original(session,msg) || {ok:true};
        records[commandId]={fingerprint,result};return result;
      };
    }
    this.network = new RoomNetwork({ registry: this.registry, handler, now,
      options: { autoTimers: false, trustProxy: false, maxConnections: ROOM_LIMITS.sockets,
        maxConnectionsPerAddr: ROOM_LIMITS.socketsPerIp, maxSessions: ROOM_LIMITS.sessions } });
    this.network.roomRuntime = this;
    if (snapshot?.running && !snapshot.matchCheckpoint) {
      // Match memory and timers cannot be recovered after a deployment/eviction. Invalidate all secrets.
      this.reservation = null;
      this.interruptedUntil = now() + ROOM_LIMITS.reservationMs;
    } else if (snapshot) {
      for (const data of snapshot.sessions || []) {
        const s = Object.assign(new Session(data), data, { ws: null, connected: false });
        if (s.disconnectedAt == null) s.disconnectedAt = snapshot.at;
        if (s.resyncAt == null) s.resyncAt = -Infinity;
        this.registry.byPlayerId.set(s.playerId, s);
        this.registry.byTokenMap.set(s.token, s);
      }
      if (snapshot.room) {
        const r = snapshot.room;
        const room = Object.assign(new Room(r.code, r.mode, r.difficulty, r.createdAt), r);
        if (r.replay) room.replay = { ...r.replay, frames: new Map(r.replay.frames), pending: new Set(r.replay.pending) };
        this.lobby.rooms.set(room.code, room);
        for (const seat of room.activeHumans()) {
          seat.connected = false;
          const session = this.registry.byId(seat.playerId);
          this.lobby.deadlines.set(seat.playerId, (session?.disconnectedAt ?? now()) + this.lobby.opts.lobbyGraceMs);
        }
      }
      for (const [id, at] of snapshot.deadlines || []) this.lobby.deadlines.set(id, at);
      // A running match (snapshot.matchCheckpoint) is restored separately: restoreMatch / interruptMatch.
    }
  }

  /**
   * Run the room's persisted match again from its checkpoint (the room and its sessions are already restored).
   * Throws the engine's own error when the log cannot be replayed (unknown rules version, a diverged state, …).
   */
  restoreMatch(checkpoint) {
    const room = this.lobby.getRoom(this.code);
    const restore = retainedMatchVersions[checkpoint.rulesVersion] || restoreMatch;
    let failure = null;
    // Lobby.startMatch wires the match into the room; this class only builds it from the checkpoint.
    const MatchClass = this.lobby.MatchClass;
    this.lobby.MatchClass = class {
      constructor(options) {
        try {
          return restore(checkpoint, options);
        } catch (error) {
          failure = error;
          throw error;
        }
      }
    };
    room.matchCount -= 1; // startMatch counts it again
    let result;
    try {
      result = this.lobby.startMatch(room, room.matchKey);
    } finally {
      this.lobby.MatchClass = MatchClass;
    }
    if (result.error) {
      room.matchCount += 1;
      throw failure || new Error(`MATCH_RESTORE_FAILED: ${result.detail}`);
    }
  }

  /**
   * The room's persisted match cannot run again: it ends as interrupted. The participants' history records the
   * interruption, and the room closes — its members learn `reason` (room.closed) on their next resume, and their
   * seats are free.
   */
  interruptMatch(checkpoint, reason) {
    const room = this.lobby.getRoom(this.code);
    const view = checkpoint.view;
    const players = view.players.map(({ playerId, seat, name, isBot, alive, lp, bandId }) => ({ playerId, seat, name, isBot, alive, lp, bandId }));
    if (room.archiveParticipants?.length) {
      this.queueArchive(room, {
        startedAt: checkpoint.startedAt,
        result: { victory: false, reason: 'interrupted', modeId: view.modeId, difficulty: room.difficulty, lastRound: view.lastRound, players },
        replay: { schemaVersion: 1, rulesVersion: checkpoint.rulesVersion, battles: [] },
        personal: (playerId) => ({
          status: 'interrupted',
          victory: false,
          hiddenCleared: false,
          round: view.round,
          stats: {},
          operators: [],
          result: players.find((p) => p.playerId === playerId) ?? null,
        }),
      });
    }
    this.lobby.disposeRoom(room, reason);
  }

  /**
   * Queue the archive of the room's latest match (number room.matchCount) for its account participants: the shared
   * facts, one personal history fact per participant (`personal(playerId)` adds its outcome) and the replay.
   */
  queueArchive(room, { startedAt, result, replay, personal }) {
    const common = { matchId: `${this.generation}:${room.matchCount}`, endedAt: this.now(), startedAt, mode: room.mode, difficulty: room.difficulty };
    const facts = room.archiveParticipants.map(({ accountId, playerId }) => ({ accountId, playerId, ...common, ...personal(playerId) }));
    this.archiveOutbox.push({
      archiveEncoding: 2,
      facts: { ...common, participants: facts.map((p) => p.accountId), result },
      personal: facts,
      replay,
    });
  }

  reserve(code, accountId = null) {
    this.sweep();
    if (!validCode(code) || !this.isEmpty()) return null;
    this.generation=randomBytes(16).toString('hex');
    this.code = code;
    const ticket = randomBytes(16).toString('hex');
    this.reservation = { ticket, accountId, expiresAt: this.now() + ROOM_LIMITS.reservationMs };
    return ticket;
  }
  hasAccount(accountId) {
    return !!accountId && (this.reservation?.accountId === accountId ||
      this.applications.list(accountId).some(x=>x.status==='approved') ||
      [...this.registry.all()].some(s => s.accountId === accountId && this.lobby.roomOf(s)));
  }
  resumeAccount(accountId) {
    if (!this.hasAccount(accountId)) return null;
    if (this.reservation?.accountId===accountId) return this.reservation.ticket;
    const approved=this.applications.list(accountId).find(x=>x.status==='approved');
    if(approved) return approved.ticket;
    const ticket=randomBytes(16).toString('hex');
    this.resumeTickets.set(ticket,{accountId,expiresAt:this.now()+30000});
    return ticket;
  }
  status() {
    const room = this.lobby.getRoom(this.code);
    return room ? { code: room.code, mode: room.mode, inMatch: !!room.match,
      full: room.mode === 'solo' || room.freeSeat() < 0 } : null;
  }
  isEmpty() {
    return !this.archiveOutbox.length && !this.reservation && !this.lobby.rooms.size && !this.registry.size && !this.network.connectionCount
      && this.interruptedUntil <= this.now();
  }
  canConnect() { return !!this.code && !this.isEmpty(); }
  admission(ip, accountId) {
    if (this.network.connectionCount >= ROOM_LIMITS.sockets) return 'full';
    const key = limitKeyOf(normalizeIp(ip) || '0.0.0.0');
    if ([...this.socketMeta.values()].filter((m) => m.key === key).length >= ROOM_LIMITS.socketsPerIp) return 'per-address';
    if(this.accounts && this.lobby.getRoom(this.code)?.match && !this.hasAccount(accountId)) {
      // Reserve every player seat plus one overlap during authenticated reconnect.
      // Include sockets still awaiting hello so connection churn cannot steal the reserve.
      const observers=[...this.socketMeta.values()].filter(m=>!this.hasAccount(m.accountId));
      const reserve=MAX_SEATS+1;
      if(observers.length>=ROOM_LIMITS.sockets-reserve)return 'spectators-full';
      if(observers.filter(m=>m.key===key).length>=ROOM_LIMITS.socketsPerIp-reserve)return 'spectators-per-address';
    }
    return null;
  }
  connect(ws, { ip = '0.0.0.0', ticket, attachment, accountId, sessionId, avatarUrl, takeover = false } = {}) {
    if (!attachment && this.admission(ip,accountId)) { ws.close(1013, 'connection limit'); return; }
    const normalized = normalizeIp(ip) || '0.0.0.0';
    const resume=this.resumeTickets.get(ticket);
    if (resume && resume.accountId===accountId && resume.expiresAt>this.now()) {
      takeover=true; this.resumeTickets.delete(ticket);
    }
    this.socketMeta.set(ws, { ip: normalized, key: limitKeyOf(normalized),
      accountId: attachment?.accountId || accountId, takeover,
      avatarUrl: attachment?.avatarUrl ?? avatarUrl,
      joinTicket:attachment?.joinTicket || ticket,
      sessionId:attachment?.sessionId || sessionId, connectionEpoch:attachment?.connectionEpoch,
      canCreate: !!attachment?.canCreate || !!(ticket && this.reservation && ticket === this.reservation.ticket &&
        (!this.accounts || this.reservation.accountId===accountId)) });
    this.network.handleConnection(ws, { socket: { remoteAddress: normalized }, headers: {} });
    ws.on('close', () => this.socketMeta.delete(ws));
    const conn = this.network.conns.get(ws);
    if (attachment) {
      for (const key of ['openedAt', 'dropWindowAt', 'drops', 'closing']) if (attachment[key] != null) conn[key] = attachment[key];
      if (attachment.bucket) Object.assign(conn.bucket, attachment.bucket);
      if (attachment.heavy) Object.assign(conn.heavy, attachment.heavy);
      const session = this.registry.byId(attachment.playerId);
      if (session) {
        if(this.accounts && (attachment.accountId!==session.accountId || attachment.connectionEpoch!==session.connectionEpoch)) {
          conn.close(4001,'session replaced');return conn;
        }
        conn.session = session;
        session.ws = ws;
        session.connected = true;
        session.disconnectedAt = null;
        const room = this.lobby.roomOf(session);
        if (room) { room.seatOf(session.playerId).connected = true; this.lobby.clearGrace(session.playerId); }
      }
    }
    return conn;
  }
  attachment(ws) {
    const c = this.network.conns.get(ws);
    return c ? { ...this.socketMeta.get(ws), playerId: c.session?.playerId, openedAt: c.openedAt,
      dropWindowAt: c.dropWindowAt, drops: c.drops, closing: c.closing, bucket: { ...c.bucket }, heavy: { ...c.heavy } } : null;
  }
  message(ws, message) {
    const conn = this.network.conns.get(ws);
    if (!conn) return;
    if (conn.closing || ws.readyState !== 1) return;
    if (this.accounts && conn.session && (conn.session.ws !== ws ||
        this.socketMeta.get(ws)?.connectionEpoch !== conn.session.connectionEpoch)) return;
    const binary = typeof message !== 'string';
    const bytes = binary ? message.byteLength : Buffer.byteLength(message, 'utf8');
    if (bytes > ROOM_LIMITS.messageBytes) { ws.close(1009, 'message exceeds 64 KiB'); return; }
    this.network.onFrame(conn, binary ? Buffer.from(message) : message, binary);
  }
  disconnect(ws) {
    const conn = this.network.conns.get(ws);
    if (conn) this.network.onClose(conn);
    this.socketMeta.delete(ws);
  }
  sweep() {
    this.applications.expire();
    for (const [ticket,value] of this.resumeTickets) if (value.expiresAt<=this.now()) this.resumeTickets.delete(ticket);
    for (const conn of this.network.conns.values()) {
      if (!conn.session && this.now() - conn.openedAt >= this.network.opts.helloTimeoutMs) conn.close(4002, 'hello timeout');
      else if (conn.session && this.now() - conn.session.lastSeen >= ROOM_LIMITS.idleSocketMs) conn.close(1001, 'idle connection');
    }
    this.lobby.expireGrace();
    this.network.sweep();
    if (this.reservation && this.reservation.expiresAt <= this.now()
      && ![...this.registry.all()].some((s) => s.canCreate && s.connected)) this.reservation = null;
  }
  pump(now=this.now()) {const result=this.lobby.getRoom(this.code)?.match?.pump?.(now) || 0;this.spectators.pump();return result;}
  reconcileSockets() {
    const match=this.lobby.getRoom(this.code)?.match;if(!match)return;
    for(const player of match.order) {
      if(player.isBot || player.left)continue;
      const connected=!!this.registry.byId(player.playerId)?.connected;
      if(player.connected && !connected)match.onDisconnect(player.playerId);
      else if(!player.connected && connected)match.onReconnect(player.playerId);
    }
  }
  nextAlarm() {
    const deadlines = [...this.lobby.deadlines.values()];
    if(this.archiveOutbox.length) deadlines.push(this.now()+30000);
    if(this.applications.items.some(x=>['expired','cancelled','rejected'].includes(x.status) && !x.released))deadlines.push(this.now()+30000);
    for(const item of this.applications.list()) if(['approved','pending'].includes(item.status)) deadlines.push(item.expiresAt);
    if(this.accounts && this.lobby.getRoom(this.code)?.activeHumans().some(s=>s.connected)) deadlines.push(this.now()+20000);
    const match=this.lobby.getRoom(this.code)?.match;
    if (match?.recording) {
      const next=match.sched.nextAt(); if(next!=null) deadlines.push(next);
    }
    if (this.reservation) deadlines.push(Math.max(this.now() + 30_000, this.reservation.expiresAt));
    if (this.interruptedUntil > this.now()) deadlines.push(this.interruptedUntil);
    for (const c of this.network.conns.values()) deadlines.push(c.session
      ? c.session.lastSeen + ROOM_LIMITS.idleSocketMs : c.openedAt + this.network.opts.helloTimeoutMs);
    for (const s of this.registry.all()) if (!s.connected) deadlines.push(s.disconnectedAt + this.registry.windowOf(s) + 1);
    return deadlines.length ? Math.max(this.now() + 100, Math.min(...deadlines)) : null;
  }
  snapshot() {
    const room = this.lobby.getRoom(this.code);
    const base = { version: 1, at: this.now(), code: this.code, reservation: this.reservation,
      generation:this.generation,resumeTickets:[...this.resumeTickets],
      publicRoom:this.publicRoom,applications:this.applications.snapshot(),
      archiveOutbox:this.archiveOutbox,
      interruptedUntil: this.interruptedUntil, running: !!room?.match };
    if (base.running && !room.match.recording) return base;
    if (room?.match?.recording) base.matchCheckpoint=exportMatch(room.match,{referenceEvents:true});
    return { ...base, sessions: [...this.registry.all()].map(({ ws, ...s }) => ({ ...s,
      resyncAt: Number.isFinite(s.resyncAt) ? s.resyncAt : null })), deadlines: [...this.lobby.deadlines],
    room: room ? { code: room.code, mode: room.mode, difficulty: room.difficulty, hostId: room.hostId,
      seats: room.seats, matchCount: room.matchCount, lastSummary: room.lastSummary, ownerKey: room.ownerKey,
      createdAt: room.createdAt, archiveParticipants:room.archiveParticipants, replay: room.replay ? { publicFrame: room.replay.publicFrame,
        frames: [...room.replay.frames], pending: [...room.replay.pending] } : null } : null };
  }
}
