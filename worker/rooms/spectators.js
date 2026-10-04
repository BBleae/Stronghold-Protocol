import { sendSession, sendRaw } from '../../server/net.js';
import { CLOSE } from '../close-codes.js';

// A changed spectator count is broadcast at most this often: joins and leaves in between are coalesced.
const PRESENCE_MS = 1000;

// Read-only views live outside Match: retained rule engines and player/checkpoint membership are unchanged. A spectator
// never becomes a simulation authority.
//
// Spectating is public, so what one spectator sends reaches nobody else: its hello and room.spectate are answered to it
// alone, and the spectator count it changes reaches the room with the next presence update (at most one a second).
// When the watched match is over, every spectator stops watching: it gets the result the players got, then its socket
// closes, so an idle tab never holds a place in the next match's audience.
export class Spectators {
  constructor(runtime) {
    this.rt = runtime;
    this.views = new Map();
    // A count change waiting for the next presence update; when the last update went out.
    this.countChanged = false;
    this.presenceAt = -Infinity;
  }

  get room() { return this.rt.lobby.getRoom(this.rt.code); }

  sessions() { return [...this.rt.registry.all()].filter((s) => s.spectating && s.connected); }

  get count() { return this.sessions().length; }

  /** room.state as `session` sees it: seats with avatars, the spectator count, whether it is a spectator. */
  state(session) {
    if (!this.room) return;
    const state = this.room.toState();
    state.seats = state.seats.map((seat) => seat
      ? { ...seat, avatarUrl: seat.isBot ? null : this.rt.registry.byId(seat.playerId)?.avatarUrl ?? null }
      : null);
    sendSession(session, { ...state, spectatorCount: this.count, ...(session.spectating ? { spectating: true } : {}) });
  }

  /** The room changed (Lobby.broadcastState): members and spectators get its state at once, count included. */
  broadcastState() {
    this.countChanged = false;
    this.presenceAt = this.rt.now();
    if (!this.room) return;
    for (const session of this.rt.lobby.memberSessions(this.room)) this.state(session);
    for (const session of this.sessions()) this.state(session);
  }

  /** When the next presence update is due (null: the count did not change). */
  presenceDue() {
    return this.countChanged ? this.presenceAt + PRESENCE_MS : null;
  }

  /** A match broadcast (m.public, b.pool, …) also reaches the spectators. */
  forward(msg) {
    for (const session of this.sessions()) sendSession(session, msg);
  }

  /** room.spectate: watch the room's running match (a public co-op room's, and not as one of its members). */
  join(session) {
    const room = this.room;
    if (!this.rt.accounts || !this.rt.publicRoom || room?.mode !== 'coop' || !room.match) return { error: 'ROOM_NOT_FOUND' };
    if (this.rt.lobby.roomOf(session)) return { error: 'ROOM_STARTED' };
    if (session.spectating) {
      this.state(session);
      return { ok: true };
    }
    session.spectating = true;
    this.countChanged = true;
    this.views.delete(session.playerId);
    this.state(session);
    this.sync(session, true);
    return { ok: true };
  }

  /** room.leave / g.leave, or the session expired. */
  leave(session) {
    this.stop(session);
    this.countChanged = true;
    return { ok: true };
  }

  stop(session) {
    session.spectating = false;
    delete session.watchField;
    this.views.delete(session.playerId);
  }

  /** The spectator's socket closed. */
  disconnect(session) {
    this.views.delete(session.playerId);
    this.countChanged = true;
  }

  /**
   * A spectator's hello. A resumed session (a reconnect) gets the match again and counts again; a hello repeated on a
   * live socket gets the room's state, and nothing else.
   */
  hello(session, { repeat }) {
    this.state(session);
    if (repeat) return;
    this.countChanged = true;
    this.views.delete(session.playerId);
    this.sync(session, true);
  }

  command(session, msg) {
    if (msg.t === 'room.leave' || msg.t === 'g.leave') return this.leave(session);
    if (msg.t !== 'g.watch') return { error: 'NOT_IN_ROOM' };
    const match = this.room?.match;
    if (!match) return { error: 'NOT_IN_ROOM' };
    const valid = match.fields.some((f) => f.fieldId === msg.fieldId)
      || (!match.fields.length && msg.fieldId.startsWith('n:') && match.players.get(msg.fieldId.slice(2))?.alive);
    if (!valid) return { error: 'BAD_TARGET' };
    session.watchField = msg.fieldId;
    this.views.delete(session.playerId);
    this.sync(session, true);
    return { ok: true };
  }

  /**
   * The watched match is over (it ended, the room went private, or the match or the room is gone): every spectator
   * stops watching, connected or not. A connected one gets room.closed {ended} followed by `frames` (the final public
   * view and the players' shared result, when the match produced one — as a member removed from its room gets them,
   * server/lobby.js), then its socket closes. An offline one gets the same on its next hello (Lobby.onHello replays the
   * notice and the frames), and never joins a later match of the room.
   */
  end(frames = null) {
    for (const session of this.rt.registry.all()) {
      if (!session.spectating) continue;
      this.stop(session);
      this.countChanged = true;
      if (session.connected) {
        sendSession(session, { t: 'room.closed', reason: 'ended' });
        for (const frame of frames ?? []) sendRaw(session.ws, frame);
        this.rt.network.conns.get(session.ws)?.close(CLOSE.ROOM_GONE, 'match ended');
      } else {
        session.notice = 'ended';
        session.pendingResult = frames;
      }
    }
  }

  // Every event: spectators follow the match (or stop watching when it is over), and a changed count goes out once
  // its presence update is due.
  pump() {
    if (!this.room?.match || !this.rt.publicRoom) this.end();
    else for (const session of this.sessions()) this.sync(session);
    if (this.countChanged && this.rt.now() >= this.presenceAt + PRESENCE_MS) this.broadcastState();
  }

  sync(session, force = false) {
    const match = this.room?.match;
    if (!match) return;
    const previous = this.views.get(session.playerId) || {};
    const pub = match.publicView();
    const publicKey = JSON.stringify({ ...pub, serverNow: 0 });
    if (force || previous.publicKey !== publicKey) sendSession(session, pub);
    const field = match.fields.find((f) => f.fieldId === session.watchField) || match.fields.find((f) => !f.done) || match.fields[0];
    let fieldKey = null;
    if (field?.cc) {
      session.watchField = field.fieldId;
      fieldKey = field.battleId + ':' + field.done;
      if (force || previous.fieldKey !== fieldKey) {
        sendSession(session, match._startMsg(field, session.playerId, { watch: true }));
        // A late join needs the current shared boss pool even if it has not changed recently enough to produce another
        // room-wide b.pool frame.
        if (match.bossPool) {
          const acked = Object.fromEntries(match.fields.filter((f) => f.cc).map((f) => [f.fieldId,
            f.mode === 'server' && f.credit ? Math.max(f.bossAcked, f.credit.cum) : f.bossAcked]));
          sendSession(session, { t: 'b.pool', hp: Math.max(0, match.bossPool.hp), max: match.bossPool.maxHp,
            teamLp: match.teamLp == null ? null : Math.max(0, Math.round(match.teamLp)), acked });
        }
      }
    } else if (!match.fields.length) {
      const target = match.players.get(session.watchField?.slice(2));
      const player = target?.alive ? target : match.order.find((p) => p.alive && !p.left);
      if (player) {
        const meta = match.prepFieldMeta(player);
        session.watchField = meta.fieldId;
        fieldKey = JSON.stringify(meta);
        if (force || previous.fieldKey !== fieldKey) sendSession(session, meta);
      }
    }
    this.views.set(session.playerId, { publicKey, fieldKey });
  }
}
