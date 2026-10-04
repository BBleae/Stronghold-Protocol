// Platform adapter only: the authoritative game rules remain in Lobby / Network / Match. Every room belongs to accounts
// (GitHub logins): its seats, approvals and running match are tied to them, and its match is recorded (RecordedMatch)
// so it survives a restart.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { Lobby, Room, CODE_ALPHABET } from '../server/lobby.js';
import { Network, Session, SessionRegistry, TokenBucket, encode, newToken, normalizeIp, limitKeyOf } from '../server/net.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';
import { RecordedMatch, exportMatch, restoreMatch } from '../server/match/checkpoint.js';
import { ApplicationQueue } from './rooms/applications.js';
import { retainedMatchVersions } from './match-versions.js';
import { Spectators } from './rooms/spectators.js';
import { logWarn, logError, errorFields } from './log.js';
import { CLOSE } from './close-codes.js';

// loginCheckMs: how often an open socket's login is checked again with the directory (a logout is noticed this late).
// Strangers (accounts with no place in the room: spectators) get at most spectatorsPerAccount sockets in the room (an
// account has one session there: the socket watching and its replacement), each with at most observerPerSec messages
// a second (burst observerBurst) instead of a player's 40; a stranger's socket that has more than observerBurst
// messages refused within a second is closed (1008).
export const ROOM_LIMITS = Object.freeze({ sockets: 16, socketsPerIp: 8, sessions: 32, messageBytes: 65_536,
  reservationMs: 120_000, idleSocketMs: 90_000, loginCheckMs: 60_000,
  spectatorsPerAccount: 2, observerPerSec: 2, observerBurst: 10 });
export const validCode = (s) => typeof s === 'string' && s.length === 4 && [...s].every((c) => CODE_ALPHABET.includes(c));

class RoomNetwork extends Network {
  onHelloMsg(conn, msg, now) {
    const prefix = `${this.roomRuntime.code}.`;
    const token = typeof msg.token === 'string' && msg.token.startsWith(prefix) ? msg.token.slice(prefix.length) : undefined;
    const meta = this.roomRuntime.socketMeta.get(conn.ws);
    if (!meta?.accountId) { conn.close(CLOSE.LOGIN_INVALID, 'login required'); return; }
    const previous = [...this.registry.all()].find(s => s.accountId === meta.accountId);
    const presented = token && this.registry.byToken(token);
    if (presented && presented.accountId !== meta.accountId) {
      this.reply(conn, {t: 'error', code: ERR.BAD_MSG, detail: 'account mismatch', rid: msg.rid}); return;
    }
    if (previous && this.roomRuntime.lobby.roomOf(previous) && !conn.session && !meta.takeover) {
      // The account's seat is resumed with its token. A token the seat no longer has was superseded by a takeover
      // (继续对局 on another device): this socket was replaced, as the old one of the takeover itself was.
      if (token && token !== previous.token) { conn.close(CLOSE.REPLACED, 'session replaced'); return; }
      if (token !== previous.token) {
        this.reply(conn, {t: 'error', code: ERR.BAD_MSG, detail: 'resume required', rid: msg.rid}); return;
      }
    }
    if (previous && meta.takeover && !conn.session) {
      // A takeover gives the seat a new token: a device that slept through it cannot take the seat back with the old one.
      this.registry.byTokenMap.delete(previous.token);
      do previous.token = newToken(); while (this.registry.byTokenMap.has(previous.token));
      this.registry.byTokenMap.set(previous.token, previous);
    }
    // An account has one session in the room.
    super.onHelloMsg(conn, { ...msg, token: previous?.token }, now);
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
  // A match ended: its archive, the room back in its lobby, then its spectators stop watching, with the result the
  // players got (none for a match nobody finished).
  onMatchEnd(room, ctx, summary) {
    this.onArchive?.(room, ctx, summary);
    super.onMatchEnd(room, ctx, summary);
    let frames = null;
    if (room.replay && summary) {
      const { errors, ...shared } = summary; // the error count is the server's business
      frames = [room.replay.publicFrame, encode({ t: 'm.result', ...shared })].filter(Boolean);
    }
    this.onSpectatorEnd?.(frames);
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
  constructor({ snapshot, now = Date.now } = {}) {
    this.generation = snapshot?.generation || randomBytes(16).toString('hex');
    this.resumeTickets = new Map(snapshot?.resumeTickets || []);
    this.applications = new ApplicationQueue({snapshot:snapshot?.applications,now});
    this.publicRoom = snapshot?.publicRoom ?? false;
    this.archiveOutbox=structuredClone(snapshot?.archiveOutbox || []);
    this.now = now;
    this.code = snapshot?.code || null;
    this.reservation = snapshot?.reservation || null;
    this.socketMeta = new Map();
    // The upstream Lobby, Network and Match log through this: their warnings and errors become structured lines of
    // this room (info and debug are per-match chatter, dropped). Lines a restore's replay repeats say so.
    this.restoring = false;
    const context = (message) => ({ room: this.code, message: String(message), ...(this.restoring ? { restoring: true } : {}) });
    const log = {
      info() {},
      debug() {},
      warn: (message) => logWarn('room_runtime', context(message)),
      error: (message, detail) => logError('room_runtime', { ...context(message), ...(detail ? { error: errorFields(detail) } : {}) }),
    };
    this.registry = new SessionRegistry({ now, maxSessions: ROOM_LIMITS.sessions });
    this.lobby = new AlarmLobby({ registry: this.registry, now, log, options: { maxRooms: 1 }, MatchClass: RecordedMatch });
    this.lobby.genCode = () => this.code;
    // Spectators (worker/rooms/spectators.js) see the room's state and the match's broadcasts.
    this.spectators = new Spectators(this);
    this.lobby.onSpectatorEnd = (frames) => this.spectators.end(frames);
    this.lobby.broadcastState = () => this.spectators.broadcastState();
    this.lobby.sendState = (room, session) => this.spectators.state(session);
    const broadcast = this.lobby.broadcastRoom.bind(this.lobby);
    this.lobby.broadcastRoom = (room, msg) => {
      const result = broadcast(room, msg);
      this.spectators.forward(msg);
      return result;
    };
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
        s.accountId = meta.accountId;
        if (meta.avatarUrl !== undefined) s.avatarUrl = meta.avatarUrl;
        if (!info.repeat) s.connectionEpoch = (s.connectionEpoch || 0) + 1;
        meta.connectionEpoch = s.connectionEpoch;
        if (meta.canCreate && this.reservation) s.canCreate = true;
        if (s.spectating) this.spectators.hello(s, info);
        else this.lobby.onHello(s, info);
      },
      onMessage: (s, msg) => {
        if (msg.t === 'room.spectate') return this.spectators.join(s);
        if (s.spectating) return this.spectators.command(s, msg);
        const room = this.lobby.roomOf(s);
        if (msg.t === 'room.start' && room && !room.match) {
          // The accounts whose history records the match.
          room.archiveParticipants = room.activeHumans()
            .map((p) => ({ playerId: p.playerId, accountId: this.registry.byId(p.playerId)?.accountId }))
            .filter((p) => p.accountId);
        }
        if (msg.t === 'room.join' && !room) {
          // Joining takes the host's approval (worker/rooms/routes.js), used once.
          const ticket = this.socketMeta.get(s.ws)?.joinTicket;
          const entry = this.applications.list(s.accountId).find((x) => x.status === 'approved' && x.ticket === ticket);
          if (!entry) return { error: ERR.APPLICATION_EXPIRED };
          const result = this.lobby.onMessage(s, msg);
          if (!result.error) this.applications.consume(s.accountId, ticket);
          return result;
        }
        // Approved applicants keep their seats free.
        if (msg.t === 'room.addBot' && room && room.seats.filter((x) => !x).length <= this.applications.reservedCount()) {
          return { error: ERR.ROOM_FULL };
        }
        if (msg.t === 'room.create') {
          if (!s.canCreate || !this.reservation) return { error: ERR.NOT_HOST, detail: 'reservation required' };
          const result = this.lobby.onMessage(s, msg);
          if (!result.error) {
            this.reservation = null;
            this.publicRoom = msg.mode === 'coop';
          }
          return result;
        }
        const result = this.lobby.onMessage(s, msg);
        if (!result.error && msg.t === 'room.start') this.applications.invalidate();
        return result;
      },
      routeGame: (s, msg) => s.spectating?this.spectators.command(s,msg):this.lobby.routeGame(s, msg),
      onDisconnect: (s) => (s.spectating ? this.spectators.disconnect(s) : this.lobby.onDisconnect(s)),
      onExpire: (s) => (s.spectating ? this.spectators.leave(s) : this.lobby.onExpire(s)),
    };
    this.network = new RoomNetwork({ registry: this.registry, handler, now, log,
      options: { autoTimers: false, trustProxy: false, maxConnections: ROOM_LIMITS.sockets,
        maxConnectionsPerAddr: ROOM_LIMITS.socketsPerIp, maxSessions: ROOM_LIMITS.sessions } });
    this.network.roomRuntime = this;
    // interruptedUntil: a field of the former anonymous rooms, no longer read.
    if (snapshot) {
      // The room and its sessions as saved. A session saved while connected waits for its socket (the Durable Object
      // attaches the sockets that survived hibernation), then reconcileSockets disconnects it if none did.
      // commandResults: a former per-session command store, no longer kept.
      for (const { commandResults, ...data } of snapshot.sessions || []) {
        const s = Object.assign(new Session(data), data, { ws: null, connected: false });
        if (s.resyncAt == null) s.resyncAt = -Infinity;
        this.registry.byPlayerId.set(s.playerId, s);
        this.registry.byTokenMap.set(s.token, s);
      }
      if (snapshot.room) {
        const r = snapshot.room;
        const room = Object.assign(new Room(r.code, r.mode, r.difficulty, r.createdAt), r);
        if (r.replay) room.replay = { ...r.replay, frames: new Map(r.replay.frames), pending: new Set(r.replay.pending) };
        this.lobby.rooms.set(room.code, room);
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
    this.restoring = true;
    try {
      result = this.lobby.startMatch(room, room.matchKey);
    } finally {
      this.lobby.MatchClass = MatchClass;
      this.restoring = false;
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

  // A reservation starts a new generation of the room: nothing of the previous one (its applications, its resume
  // tickets) carries over.
  reserve(code, accountId = null) {
    this.sweep();
    if (!validCode(code) || !this.isEmpty()) return null;
    this.generation = randomBytes(16).toString('hex');
    this.applications = new ApplicationQueue({ now: this.now });
    this.resumeTickets.clear();
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
    return !this.archiveOutbox.length && !this.reservation && !this.lobby.rooms.size && !this.registry.size && !this.network.connectionCount;
  }
  /**
   * Whether a socket of `accountId` has anything to do here: the account's place in the room (a seat, its
   * reservation, an approval), something its session has yet to collect (why its room closed, a result), or the
   * room's running public match to watch. Anything else is refused as a room that is gone.
   */
  canConnect(accountId) {
    if (!this.code || this.isEmpty()) return false;
    if (this.hasAccount(accountId)) return true;
    if ([...this.registry.all()].some((s) => s.accountId === accountId && (s.notice || s.pendingResult))) return true;
    const room = this.lobby.getRoom(this.code);
    return !!room?.match && this.publicRoom && room.mode === 'coop';
  }

  /**
   * Why a new socket from `ip` of `accountId` is refused (null: admitted). Accounts with no place in the room
   * (strangers: spectators, accounts collecting why their room closed) share what the members do not need: every
   * player seat plus one overlap during a reconnect stays free for the members, in the lobby as in a match. Sockets
   * still awaiting hello count, so connection churn cannot take the members' share.
   */
  admission(ip, accountId) {
    if (this.network.connectionCount >= ROOM_LIMITS.sockets) return 'full';
    const key = limitKeyOf(normalizeIp(ip) || '0.0.0.0');
    if ([...this.socketMeta.values()].filter((m) => m.key === key).length >= ROOM_LIMITS.socketsPerIp) return 'per-address';
    if (this.hasAccount(accountId)) return null;
    const strangers = [...this.socketMeta.values()].filter((m) => !this.hasAccount(m.accountId));
    const reserve = MAX_SEATS + 1;
    if (strangers.length >= ROOM_LIMITS.sockets - reserve) return 'spectators-full';
    if (strangers.filter((m) => m.key === key).length >= ROOM_LIMITS.socketsPerIp - reserve) return 'spectators-per-address';
    if (strangers.filter((m) => m.accountId === accountId).length >= ROOM_LIMITS.spectatorsPerAccount) return 'spectators-per-account';
    return null;
  }
  // `sessionId` / `sessionExpiresAt`: the login the Worker validated at the upgrade (checkLogins checks it again).
  connect(ws, { ip = '0.0.0.0', ticket, attachment, accountId, sessionId, sessionExpiresAt = null, avatarUrl, takeover = false } = {}) {
    if (!attachment && this.admission(ip,accountId)) { ws.close(CLOSE.TRY_LATER, 'connection limit'); return; }
    const normalized = normalizeIp(ip) || '0.0.0.0';
    const resume=this.resumeTickets.get(ticket);
    if (resume && resume.accountId===accountId && resume.expiresAt>this.now()) {
      takeover=true; this.resumeTickets.delete(ticket);
    }
    // A stranger's socket (it can only spectate) is an observer's: it sends little (its bucket below, message()).
    const observer = attachment ? !!attachment.observer : !this.hasAccount(accountId);
    this.socketMeta.set(ws, { ip: normalized, key: limitKeyOf(normalized),
      accountId: attachment?.accountId || accountId, takeover, observer,
      avatarUrl: attachment?.avatarUrl ?? avatarUrl,
      joinTicket:attachment?.joinTicket || ticket,
      sessionId:attachment?.sessionId || sessionId, connectionEpoch:attachment?.connectionEpoch,
      // Sockets saved before logins were kept with them have neither: their first check is due at once.
      sessionExpiresAt: attachment ? attachment.sessionExpiresAt ?? null : sessionExpiresAt,
      sessionCheckedAt: attachment ? attachment.sessionCheckedAt ?? 0 : this.now(),
      canCreate: !!attachment?.canCreate
        || !!(ticket && this.reservation && ticket === this.reservation.ticket && this.reservation.accountId === accountId) });
    this.network.handleConnection(ws, { socket: { remoteAddress: normalized }, headers: {} });
    ws.on('close', () => this.socketMeta.delete(ws));
    const conn = this.network.conns.get(ws);
    // An observer's message bucket is a spectator's, kept with the socket's other state across hibernation
    // (attachment.bucket).
    if (observer && !attachment) conn.bucket = new TokenBucket(ROOM_LIMITS.observerPerSec, ROOM_LIMITS.observerBurst, this.now());
    if (attachment) {
      for (const key of ['openedAt', 'dropWindowAt', 'drops', 'closing']) if (attachment[key] != null) conn[key] = attachment[key];
      if (attachment.bucket) Object.assign(conn.bucket, attachment.bucket);
      if (attachment.heavy) Object.assign(conn.heavy, attachment.heavy);
      const session = this.registry.byId(attachment.playerId);
      if (session) {
        if (attachment.accountId !== session.accountId || attachment.connectionEpoch !== session.connectionEpoch) {
          conn.close(CLOSE.REPLACED,'session replaced');return conn;
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
    const expiresAt = this.socketMeta.get(ws)?.sessionExpiresAt;
    if (expiresAt != null && expiresAt <= this.now()) {
      conn.close(CLOSE.LOGIN_INVALID, 'login expired');
      return;
    }
    if (conn.session && (conn.session.ws !== ws ||
        this.socketMeta.get(ws)?.connectionEpoch !== conn.session.connectionEpoch)) return;
    const binary = typeof message !== 'string';
    const bytes = binary ? message.byteLength : Buffer.byteLength(message, 'utf8');
    if (bytes > ROOM_LIMITS.messageBytes) { ws.close(CLOSE.TOO_BIG, 'message exceeds 64 KiB'); return; }
    this.network.onFrame(conn, binary ? Buffer.from(message) : message, binary);
    // Every frame costs the room an event, a refused one too: an observer flooding past its bucket is closed.
    if (this.socketMeta.get(ws)?.observer && conn.drops > ROOM_LIMITS.observerBurst) conn.close(CLOSE.POLICY, 'rate limit');
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
      if (!conn.session && this.now() - conn.openedAt >= this.network.opts.helloTimeoutMs) conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
      else if (conn.session && this.now() - conn.session.lastSeen >= ROOM_LIMITS.idleSocketMs) conn.close(CLOSE.IDLE, 'idle connection');
    }
    this.lobby.expireGrace();
    this.network.sweep();
    if (this.reservation && this.reservation.expiresAt <= this.now()
      && ![...this.registry.all()].some((s) => s.canCreate && s.connected)) this.reservation = null;
    // Applications are for a room that exists: once it is gone, none can be joined.
    if (!this.lobby.getRoom(this.code)) this.applications.invalidate();
  }
  pump(now=this.now()) {const result=this.lobby.getRoom(this.code)?.match?.pump?.(now) || 0;this.spectators.pump();return result;}
  /**
   * After a wake (the room, its surviving sockets and its match are back): a session that was connected at the last
   * save but whose socket did not survive (a restart closes every socket; hibernation keeps them) disconnects now, the
   * way a closing socket does (Network.onClose: Lobby.onDisconnect — its seat, the match, a solo run's 24-hour resume
   * window, the lobby grace; a spectator's count).
   */
  reconcileSockets() {
    for (const session of this.registry.all()) {
      if (session.connected || session.disconnectedAt != null) continue;
      session.disconnectedAt = this.now();
      this.network.handler.onDisconnect(session);
    }
  }
  nextAlarm() {
    const deadlines = [...this.lobby.deadlines.values()];
    for(const item of this.applications.list()) if(['approved','pending'].includes(item.status)) deadlines.push(item.expiresAt);
    if (this.reservation) deadlines.push(Math.max(this.now() + 30_000, this.reservation.expiresAt));
    for (const c of this.network.conns.values()) deadlines.push(c.session
      ? c.session.lastSeen + ROOM_LIMITS.idleSocketMs : c.openedAt + this.network.opts.helloTimeoutMs);
    for (const s of this.registry.all()) if (!s.connected) deadlines.push(s.disconnectedAt + this.registry.windowOf(s) + 1);
    return deadlines.length ? Math.max(this.now() + 100, Math.min(...deadlines)) : null;
  }
  /** The sessions of open sockets whose login is due to be checked again (ROOM_LIMITS.loginCheckMs after the last). */
  loginsDue(now = this.now()) {
    const due = new Set();
    for (const meta of this.socketMeta.values()) {
      if (meta.sessionId && meta.sessionCheckedAt + ROOM_LIMITS.loginCheckMs <= now) due.add(meta.sessionId);
    }
    return [...due];
  }

  /** When the next login check is due (Infinity: no socket has a login). */
  nextLoginCheck() {
    let at = Infinity;
    for (const meta of this.socketMeta.values()) if (meta.sessionId) at = Math.min(at, meta.sessionCheckedAt + ROOM_LIMITS.loginCheckMs);
    return at;
  }

  /**
   * The directory's answer for the sessions checked (`sessions`: session id -> its record, null when it is gone): a
   * socket whose login was revoked (logout), expired or belongs to another account closes with 4003; the others are
   * checked again ROOM_LIMITS.loginCheckMs later.
   */
  checkLogins(sessions) {
    const now = this.now();
    for (const [ws, meta] of this.socketMeta) {
      if (!sessions.has(meta.sessionId)) continue;
      const session = sessions.get(meta.sessionId);
      if (session && session.accountId === meta.accountId && session.expiresAt > now) {
        meta.sessionCheckedAt = now;
        meta.sessionExpiresAt = session.expiresAt;
      } else {
        this.network.conns.get(ws)?.close(CLOSE.LOGIN_INVALID, 'login required');
      }
    }
  }

  /** When the room's next timed step is due (null: none): the running match's next timer, a spectator count update. */
  timerDue() {
    const match = this.lobby.getRoom(this.code)?.match;
    const due = [match?.recording ? match.sched.nextAt() : null, this.spectators.presenceDue()].filter((at) => at != null);
    return due.length ? Math.min(...due) : null;
  }

  /** Someone (a member or a spectator) is connected. */
  connected() {
    for (const s of this.registry.all()) if (s.connected) return true;
    return false;
  }

  // The running match's checkpoint: its event log (by reference) and the state that replaying the log must reproduce.
  // A match changes only through logged events, so that state is computed again only when the log grew.
  checkpoint(match) {
    const count = match.recording.events.length;
    if (this.saved?.match !== match || this.saved.count !== count) {
      this.saved = { match, count, checkpoint: exportMatch(match, { referenceEvents: true }) };
    }
    return this.saved.checkpoint;
  }

  // The room's persistent state. Finished matches' archives are not part of it: the Durable Object stores them
  // separately (archiveOutbox holds them only until then).
  snapshot() {
    const room = this.lobby.getRoom(this.code);
    const base = { version: 1, code: this.code, reservation: this.reservation,
      generation:this.generation,resumeTickets:[...this.resumeTickets],
      publicRoom:this.publicRoom,applications:this.applications.snapshot(), running: !!room?.match };
    if (room?.match) base.matchCheckpoint = this.checkpoint(room.match);
    return { ...base, sessions: [...this.registry.all()].map(({ ws, ...s }) => ({ ...s,
      resyncAt: Number.isFinite(s.resyncAt) ? s.resyncAt : null })), deadlines: [...this.lobby.deadlines],
    room: room ? { code: room.code, mode: room.mode, difficulty: room.difficulty, hostId: room.hostId,
      seats: room.seats, matchCount: room.matchCount, lastSummary: room.lastSummary, ownerKey: room.ownerKey,
      createdAt: room.createdAt, archiveParticipants:room.archiveParticipants, replay: room.replay ? { publicFrame: room.replay.publicFrame,
        frames: [...room.replay.frames], pending: [...room.replay.pending] } : null } : null };
  }
}
