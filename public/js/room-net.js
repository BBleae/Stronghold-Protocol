// Workers transport (account mode): a WebSocket to one room's Durable Object, open only while the player is in that
// room, as a member or as a spectator. The lobby list, join applications and the account's seat are the account HTTP
// API (account.js accountRequest).
//
// States (`state`; the UI sees them through `status`):
//   menu      no room, no socket: status 'menu'. Requests that need a room reject NOT_IN_ROOM at once, so a leave
//             from the menu settles at once too.
//   entering  enter(intent) is getting into a room, one intent at a time. Any failure closes the socket and returns
//             to the menu (an invalid login: lost); enter() rejects with the reason.
//   room      the socket belongs to a room the player is in; Net's reconnects apply (online, reconnecting …). The room
//             ends with room.closed (pushed by the server or emitted here) and the client returns to the menu.
//   lost      the login is invalid (the room or the account API said so): status 'closed', lastError LOGIN_REQUIRED,
//             no socket, no reconnects, no application checks. Requests that need the room reject LOGIN_REQUIRED at
//             once; leaving drops the room, not the invalid login. Logging in again reloads the page, and the reload
//             resumes a seat the login was lost in (restore()). enter() may still try again: another tab may have
//             logged in since.
//
// Intents of enter(): create {mode, difficulty} · join {code} (a join application, HTTP only: see `application`) ·
// joinApproved {code, ticket} · resume {mode, difficulty} (继续对局, which may take the seat over from another
// device; a seat that is still a reservation creates its room with mode/difficulty) · resume {code, token} (this
// tab's own seat after a reload: the room resumes the session the token names, if this account still has it) ·
// spectate {code}.
//
// What this client relies on from the room Worker:
//   close 4001   another tab or device took the seat over          → room.closed {reason: 'replaced'}
//   close 4003   the login is invalid (expired or revoked)         → lost
//   close 4004   the room is gone                                  → room.closed {reason: 'expired'}
//   room.closed  (pushed) this session has no room here any more   → menu
//   welcome      `resumed` is false when the account had no session left in the room (resuming fails); in a room,
//                a welcome for another player id means the seat expired while away → room.closed {reason: 'timeout'}
//   close 1013   try again later                                   → Net's reconnect with backoff
//   Any other close, also before the socket opened (the network failed), is retried with Net's backoff.
// And from the account API: POST /api/rooms answers this account's own unused reservation (a create that failed after
// reserving: finishing it is what the player asks for), and 409 ALREADY_SEATED only for a seat in a live room.

import { Net, NetError, CLOSE_REPLACED, configureTransport } from './net.js';
import { accountRequest } from './account.js';

/** Room Worker close code: the login is invalid (expired or revoked). */
export const CLOSE_LOGIN_INVALID = 4003;
/** Room Worker close code: the room is gone. */
export const CLOSE_ROOM_GONE = 4004;
/** How long entering waits for each answer of the room (its welcome, then its state), reconnects included. */
export const ENTER_TIMEOUT_MS = 12000;
/** How long a room the server ended may still deliver its final frames before the client closes the socket. */
export const DRAIN_MS = 5000;
/** How often a pending join application is checked. */
export const APPLICATION_POLL_MS = 3000;

/** Room code of a saved room token (`CODE.<32 hex>`, saved at every welcome), or null. */
export function roomFromToken(token) {
  const match = typeof token === 'string' && /^([ABCDEFGHJKLMNPQRSTUVWXYZ]{4})\.[a-f0-9]{32}$/.exec(token);
  return match ? match[1] : null;
}

export class RoomNet extends Net {
  constructor(opts = {}) {
    super(opts);
    /** Read by battle/runner.js: account rooms record replays, so battle reports carry them. */
    this.accountMode = true;
    this.baseUrl = opts.baseUrl || globalThis.location?.origin || 'http://localhost:8787';
    this.fetch = opts.fetch || ((...args) => globalThis.fetch(...args));
    /** @type {'menu'|'entering'|'room'|'lost'} */
    this.state = 'menu';
    /** The socket's room: { code, ticket?, spectate? }; null in the menu. */
    this.route = null;
    /** That room's last room.state. */
    this.room = null;
    /** This account's join application ({ code, id, status, error? }) or null: see watchApplication(). */
    this.application = null;
    this._token = null;      // hello token on the route: the last welcome's, or the saved one being resumed
    this._waiting = null;    // { fail } while entering waits for an answer of the room
    this._applicationTimer = null;
    this.getToken = () => this._token;
    this.on('room.state', (msg) => { this.room = msg; });
    // A room.closed the server pushed may be followed by the match's final view and result: read them (see _drain).
    this.on('room.closed', (msg) => this._toMenu(!msg.local));
  }

  /**
   * Get into a room: the one way out of the menu (intents: see the header). Resolves with the answer to the intent's
   * request ({ application } for a join application). A failure closes the socket, returns to the menu (or to 'lost'
   * when the login is invalid) and rejects.
   * @param {{ kind: 'create'|'join'|'joinApproved'|'resume'|'spectate', code?: string, ticket?: string,
   *   token?: string, mode?: string, difficulty?: string, capacity?: number }} intent
   */
  async enter(intent) {
    if (this.state === 'entering') throw new NetError('BUSY');
    if (this.state === 'room') throw new NetError('ALREADY_IN_ROOM');
    if (this._applying() && intent.kind !== 'join' && intent.kind !== 'joinApproved') throw new NetError('APPLICATION_PENDING');
    if (this.state === 'lost') this._toMenu(); // entering anything gives up the room whose login was lost
    this.state = 'entering';
    try {
      const reply = await this._enter(intent);
      this.state = this.route ? 'room' : 'menu';
      return reply;
    } catch (error) {
      this._toMenu();
      if (error.code === 'LOGIN_REQUIRED') this._lose(error);
      throw error;
    }
  }

  /**
   * Boot: resume this tab's seat after a reload (or a tab the browser discarded). `token` is the room token saved at
   * the tab's last welcome; `activeSeat` the account's seat from /api/me. The room's socket opens at once (status
   * 'connecting'), so the boot never shows the menu while a seat is being resumed.
   */
  async restore(token, activeSeat) {
    const code = roomFromToken(token);
    if (code && code === activeSeat?.roomId) await this.enter({ kind: 'resume', code, token });
  }

  /**
   * room.create / room.join enter a room (see enter()). Anything else needs the room: it rejects at once in the menu
   * (NOT_IN_ROOM) and while the login is invalid (LOGIN_REQUIRED).
   */
  request(type, fields = {}, opts = {}) {
    if (type === 'room.create') return this.enter({ kind: 'create', mode: fields.mode, difficulty: fields.difficulty, capacity: fields.capacity });
    if (type === 'room.join') return this.enter({ kind: 'join', code: fields.code });
    if (this.state === 'menu') return Promise.reject(new NetError('NOT_IN_ROOM'));
    const reply = this.state === 'lost'
      ? Promise.reject(new NetError('LOGIN_REQUIRED'))
      : super.request(type, fields, opts);
    // A leave ends the room here whatever the answer: the server removed the seat, did not have it, or keeps it until
    // its reconnect grace runs out (继续对局 can still resume it). g.leave only when confirmed: quitMatch follows a
    // refused g.leave (no running match) with room.leave.
    if (type === 'room.leave') return reply.finally(() => this._leaveRoom());
    if (type === 'g.leave') return reply.then((ok) => { this._leaveRoom(); return ok; });
    return reply;
  }

  /** (Re)connect the route's socket; the menu has none. */
  connect() {
    if (this.route) super.connect();
    else if (this.status !== 'menu') this._setStatus('menu');
  }

  /** Close for good (logout): no reconnects, no application checks. */
  close() {
    this._clearTimer('_applicationTimer', 'clearTimeout');
    this.application = null;
    super.close();
  }

  // ---- join applications (no socket until the host approves) ---------------------------------------------------

  /** Follow a join application ({ code, id, status }, or null): while pending it is checked, and an approval enters. */
  watchApplication(application) {
    this.application = application;
    this._clearTimer('_applicationTimer', 'clearTimeout');
    if (application?.status === 'pending') {
      this._applicationTimer = this.timers.setTimeout(() => {
        this._applicationTimer = null;
        void this._checkApplication(application);
      }, APPLICATION_POLL_MS);
    }
    this._emit('application', application);
  }

  /** Withdraw the pending application. */
  async cancelApplication() {
    const { code, id } = this.application;
    await accountRequest(`/api/rooms/${code}/applications`, { action: 'cancel', id }, this.fetch);
    this.watchApplication(null);
  }

  /** Check the application again now: after a failed join, an approval that is still valid is used again. */
  retryApplication() {
    void this._checkApplication(this.application);
  }

  _applying() {
    return this.application?.status === 'pending' || this.application?.status === 'joining';
  }

  async _checkApplication(application) {
    let item;
    try {
      const { items } = await accountRequest(`/api/rooms/${application.code}/applications`, undefined, this.fetch);
      item = items.find((x) => x.id === application.id) ?? { status: 'expired' };
    } catch (error) {
      // An invalid login or a vanished room ends the application; anything else is checked again later.
      const lost = error.code === 'LOGIN_REQUIRED';
      if (lost) this._lose(error);
      if (lost || error.code === 'ROOM_NOT_FOUND') {
        item = { status: 'failed', error };
      } else {
        console.warn('[room-net] application check failed; retrying', error);
        item = { status: 'pending' };
      }
    }
    if (this.application !== application) return; // withdrawn or replaced meanwhile
    if (item.status !== 'approved') {
      this.watchApplication({ ...application, ...item, code: application.code });
      return;
    }
    this.watchApplication({ ...application, status: 'joining' });
    try {
      await this.enter({ kind: 'joinApproved', code: application.code, ticket: item.ticket });
      this.watchApplication(null);
    } catch (error) {
      this.watchApplication({ ...application, status: 'failed', error });
    }
  }

  async _apply(code) {
    const item = await accountRequest(`/api/rooms/${code}/applications`, { action: 'apply' }, this.fetch);
    this.watchApplication({ ...item, code });
    return { application: this.application };
  }

  // ---- entering --------------------------------------------------------------------------------------------------

  async _enter(intent) {
    switch (intent.kind) {
      case 'create': return this._enterSeat(await this._reserve(), intent);
      case 'join': return this._apply(intent.code);
      case 'joinApproved': return this._enterSeat({ code: intent.code, ticket: intent.ticket, join: true }, intent);
      case 'resume': return intent.token
        ? this._resumed(await this._open({ code: intent.code }, intent.token))
        : this._enterSeat(await this._seat(), intent);
      case 'spectate':
        await this._open({ code: intent.code, spectate: true });
        return super.request('room.spectate');
      default: throw new Error(`unknown intent ${intent.kind}`);
    }
  }

  // A reservation to create a room in: a new one, or this account's own unused one (see the header).
  async _reserve() {
    return { ...await accountRequest('/api/rooms', {}, this.fetch), reserved: true };
  }

  // This account's seat for 继续对局: { code, ticket, join, reserved }.
  async _seat() {
    const seat = await accountRequest('/api/me/resume', {}, this.fetch);
    if (!seat?.code) throw new NetError('NO_ACTIVE_MATCH');
    return seat;
  }

  // Open the socket of one of this account's seats and finish what the seat waits for: a reservation creates its room,
  // an approved application joins it, a seat in a running room is resumed.
  async _enterSeat(seat, intent) {
    const welcome = await this._open({ code: seat.code, ticket: seat.ticket });
    if (seat.reserved) {
      // capacity: the co-op room's seats when the page asks for more than the default (room.create { capacity? })
      return super.request('room.create', { mode: intent.mode, difficulty: intent.difficulty,
        ...(Number.isInteger(intent.capacity) ? { capacity: intent.capacity } : {}) });
    }
    if (seat.join) return super.request('room.join', { code: seat.code });
    return this._resumed(welcome);
  }

  // A resumed seat is entered once the room re-sent its state, or closed it (room.closed tells the player why).
  async _resumed(welcome) {
    if (!welcome.resumed) throw new NetError('NO_ACTIVE_MATCH');
    await this._wait('room.state', 'room.closed');
    return {};
  }

  // Open the socket for `route` and wait for its welcome.
  _open(route, token = null) {
    this.route = route;
    this.room = null;
    this._token = token;
    this.playerId = null;
    this.attempt = 0;
    this.clockSynced = false;
    this._clockSamples = [];
    this.lastError = null;
    const url = new URL('/ws', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', route.code);
    if (route.ticket) url.searchParams.set('ticket', route.ticket);
    this.url = url.href;
    const welcome = this._wait('welcome');
    this.connect();
    return welcome;
  }

  // The first of `types` from the room being entered. Fails when the route ends (_routeEnded) or after ENTER_TIMEOUT_MS.
  _wait(...types) {
    return new Promise((resolve, reject) => {
      const finish = (error, msg) => {
        this.timers.clearTimeout(timer);
        for (const off of offs) off();
        this._waiting = null;
        if (error) reject(error);
        else resolve(msg);
      };
      const offs = types.map((type) => this.on(type, (msg) => finish(null, msg)));
      const timer = this.timers.setTimeout(() => finish(new NetError('TIMEOUT')), ENTER_TIMEOUT_MS);
      this._waiting = { fail: finish };
    });
  }

  // ---- the route's end -------------------------------------------------------------------------------------------

  _onClose(ev) {
    const code = ev?.code;
    if (code === CLOSE_REPLACED) this._routeEnded(new NetError('REPLACED'));
    else if (code === CLOSE_LOGIN_INVALID) this._routeEnded(new NetError('LOGIN_REQUIRED'));
    else if (code === CLOSE_ROOM_GONE) this._routeEnded(new NetError('ROOM_GONE'));
    else super._onClose(ev);
  }

  _onHelloError(msg) {
    // Entering: the refusal is enter()'s rejection, shown by its caller. In a room Net's rejected state applies.
    if (this.state !== 'entering') { super._onHelloError(msg); return; }
    this._clearTimer('_helloTimer', 'clearTimeout');
    this._helloRid = null;
    this._routeEnded(new NetError(msg.code, msg.msg, msg.detail));
  }

  _onWelcome(msg) {
    // In a room, a welcome for another player id is a new session: this account's session in the room expired while
    // the client was away, so the room is over for it.
    if (this.state === 'room' && msg.playerId !== this.playerId) {
      this._emit('room.closed', { t: 'room.closed', reason: 'timeout', local: true });
      return;
    }
    this._token = msg.token;
    super._onWelcome(msg);
  }

  // The route cannot go on. Entering fails with the reason (enter() decides where to go). In a room an invalid login
  // keeps the seat for after a new login ('lost'); anything else ends the room.
  _routeEnded(error) {
    this._dropSocket();
    this._failPending(error.code, true);
    if (this.state === 'entering') {
      this._waiting?.fail(error);
    } else if (error.code === 'LOGIN_REQUIRED') {
      this._lose(error);
    } else {
      this._emit('room.closed', { t: 'room.closed', reason: error.code === 'REPLACED' ? 'replaced' : 'expired', local: true });
    }
  }

  // The login is invalid: stop talking to the server until the player logs in again. Called with no socket left (the
  // route ended, or the menu). The room (if any) and this tab's room token stay, so the reload after the new login
  // resumes the seat.
  _lose(error) {
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    this._clearTimer('_applicationTimer', 'clearTimeout');
    this._manualClose = true;
    this.lastError = error;
    this.state = 'lost';
    this._setStatus('closed');
  }

  // The player left the room: back to the menu, whatever the server answered. An invalid login met on the way stays
  // invalid: 'lost' again after the menu (passing the menu makes the tab forget the room's token, see main.js).
  _leaveRoom() {
    const lost = this.state === 'lost' ? this.lastError : null;
    this._toMenu();
    if (lost) this._lose(lost);
  }

  // Back to the menu: no socket, no route. Requests still waiting for the room fail with NOT_IN_ROOM.
  _toMenu(drain = false) {
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    if (drain) this._drain();
    else this._dropSocket();
    this._failPending('NOT_IN_ROOM', true);
    this.state = 'menu';
    this.route = null;
    this.room = null;
    this._token = null;
    this._manualClose = false;
    this.lastError = null;
    this.attempt = 0;
    this.retryAt = 0;
    this._setStatus('menu');
  }

  // ---- socket details ------------------------------------------------------------------------------------------------

  // The server ended this session's room and may still send the match's final frames (its public view and result,
  // as server/lobby.js does for a removed member and worker/rooms/spectators.js for spectators) before it closes the
  // socket: deliver those, then forget the socket. It is no route any more: its close neither reconnects nor ends a room.
  _drain() {
    const ws = this.ws;
    this._teardownSocket();
    if (!ws) return;
    const timer = this.timers.setTimeout(() => ws.close(1000, 'left room'), DRAIN_MS);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev?.data)); } catch { return; }
      if (msg?.t === 'm.public' || msg?.t === 'm.result') this._emit(msg.t, msg);
    };
    ws.onclose = () => this.timers.clearTimeout(timer);
  }

  // Close the route's socket if one is still open (a closed one is just forgotten).
  _dropSocket() {
    const ws = this.ws;
    this._teardownSocket();
    ws?.close(1000, 'left room');
  }

  _sendRaw(msg) {
    // One commandId per request (Worker protocol). The client never re-sends a request, so no logic here relies on
    // the server de-duplicating it.
    if (msg.rid != null && msg.t !== 'hello' && msg.t !== 'ping' && !msg.commandId) msg.commandId = globalThis.crypto.randomUUID();
    if (msg.t === 'ping' && this.clockSynced && !this.room?.inMatch) {
      this._fixedPingAt = msg.c;
      return super._sendRaw({ t: 'ping', c: 0 });
    }
    return super._sendRaw(msg);
  }

  _onPong(msg) {
    // Idle pongs are answered by Cloudflare without waking the room. They measure
    // latency only; welcome and active-match pings retain real server clock samples.
    if (msg.c === 0) {
      if (this._fixedPingAt == null) return;
      return super._onPong({ t: 'pong', c: this._fixedPingAt });
    }
    super._onPong(msg);
  }
}

export function configureRoomNet(opts = {}) {
  return configureTransport(() => new RoomNet(opts));
}
