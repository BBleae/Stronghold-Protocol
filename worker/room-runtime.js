// Platform adapter only: the authoritative game rules remain in Lobby / Network / Match.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { Lobby, Room, CODE_ALPHABET } from '../server/lobby.js';
import { Network, Session, SessionRegistry, sendSession, normalizeIp, limitKeyOf } from '../server/net.js';
import { ERR } from '../shared/constants.js';
import { RecordedMatch, exportMatch, restoreMatch } from '../server/match/checkpoint.js';

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
      if (previous && !conn.session && !meta.takeover && token !== previous.token) {
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
    super.onMatchEnd(room, ctx, summary);
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
    this.now = now;
    this.code = snapshot?.code || null;
    this.reservation = snapshot?.reservation || null;
    this.interruptedUntil = snapshot?.interruptedUntil || 0;
    this.socketMeta = new Map();
    this.registry = new SessionRegistry({ now, maxSessions: ROOM_LIMITS.sessions });
    this.lobby = new AlarmLobby({ registry: this.registry, now, options: { maxRooms: 1 },
      ...(accounts ? {MatchClass:RecordedMatch} : {}) });
    this.lobby.genCode = () => this.code;
    this.lobby.onChange = onChange;
    const handler = {
      onHello: (s, info) => {
        const meta = this.socketMeta.get(s.ws);
        if (this.accounts && meta?.accountId) {
          s.accountId = meta.accountId;
          if (!info.repeat) s.connectionEpoch = (s.connectionEpoch || 0) + 1;
          meta.connectionEpoch = s.connectionEpoch;
        }
        if (this.socketMeta.get(s.ws)?.canCreate && this.reservation) s.canCreate = true;
        this.lobby.onHello(s, info);
        if (this.interruptedUntil > this.now()) sendSession(s, { t: 'room.closed', reason: 'restart' });
      },
      onMessage: (s, msg) => {
        if (msg.t === 'room.create') {
          if (!s.canCreate || !this.reservation) return { error: ERR.NOT_HOST, detail: 'reservation required' };
          const result = this.lobby.onMessage(s, msg);
          if (!result.error) this.reservation = null;
          return result;
        }
        return this.lobby.onMessage(s, msg);
      },
      routeGame: (s, msg) => this.lobby.routeGame(s, msg),
      onDisconnect: (s) => this.lobby.onDisconnect(s),
      onExpire: (s) => this.lobby.onExpire(s),
    };
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
      if (snapshot.matchCheckpoint && snapshot.room) {
        const room=this.lobby.getRoom(this.code), checkpoint=snapshot.matchCheckpoint;
        room.matchCount=Math.max(0,room.matchCount-1);
        const Original=this.lobby.MatchClass;
        this.lobby.MatchClass=class {constructor(options) {return restoreMatch(checkpoint,options);}};
        const result=this.lobby.startMatch(room,room.matchKey);
        this.lobby.MatchClass=Original;
        if (result.error || !room.match) throw new Error('MATCH_RESTORE_FAILED');
      }
    }
  }

  reserve(code, accountId = null) {
    this.sweep();
    if (!validCode(code) || !this.isEmpty()) return null;
    this.code = code;
    const ticket = randomBytes(16).toString('hex');
    this.reservation = { ticket, accountId, expiresAt: this.now() + ROOM_LIMITS.reservationMs };
    return ticket;
  }
  hasAccount(accountId) {
    return !!accountId && (this.reservation?.accountId === accountId ||
      [...this.registry.all()].some(s => s.accountId === accountId && this.lobby.roomOf(s)));
  }
  resumeAccount(accountId) {
    if (!this.hasAccount(accountId)) return null;
    if (this.reservation?.accountId===accountId) return this.reservation.ticket;
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
    return !this.reservation && !this.lobby.rooms.size && !this.registry.size && !this.network.connectionCount
      && this.interruptedUntil <= this.now();
  }
  canConnect() { return !!this.code && !this.isEmpty(); }
  admission(ip) {
    if (this.network.connectionCount >= ROOM_LIMITS.sockets) return 'full';
    const key = limitKeyOf(normalizeIp(ip) || '0.0.0.0');
    if ([...this.socketMeta.values()].filter((m) => m.key === key).length >= ROOM_LIMITS.socketsPerIp) return 'per-address';
    return null;
  }
  connect(ws, { ip = '0.0.0.0', ticket, attachment, accountId, sessionId, takeover = false } = {}) {
    if (!attachment && this.admission(ip)) { ws.close(1013, 'connection limit'); return; }
    const normalized = normalizeIp(ip) || '0.0.0.0';
    const resume=this.resumeTickets.get(ticket);
    if (resume && resume.accountId===accountId && resume.expiresAt>this.now()) {
      takeover=true; this.resumeTickets.delete(ticket);
    }
    this.socketMeta.set(ws, { ip: normalized, key: limitKeyOf(normalized),
      accountId: attachment?.accountId || accountId, takeover,
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
  pump(now=this.now()) {return this.lobby.getRoom(this.code)?.match?.pump?.(now) || 0;}
  nextAlarm() {
    const deadlines = [...this.lobby.deadlines.values()];
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
      interruptedUntil: this.interruptedUntil, running: !!room?.match };
    if (base.running && !room.match.recording) return base;
    if (room?.match?.recording) base.matchCheckpoint=exportMatch(room.match);
    return { ...base, sessions: [...this.registry.all()].map(({ ws, ...s }) => ({ ...s,
      resyncAt: Number.isFinite(s.resyncAt) ? s.resyncAt : null })), deadlines: [...this.lobby.deadlines],
    room: room ? { code: room.code, mode: room.mode, difficulty: room.difficulty, hostId: room.hostId,
      seats: room.seats, matchCount: room.matchCount, lastSummary: room.lastSummary, ownerKey: room.ownerKey,
      createdAt: room.createdAt, replay: room.replay ? { publicFrame: room.replay.publicFrame,
        frames: [...room.replay.frames], pending: [...room.replay.pending] } : null } : null };
  }
}
