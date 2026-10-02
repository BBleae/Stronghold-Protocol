// Workers transport: one direct WebSocket to the Durable Object for the selected room.
import { Net, NetError, configureTransport } from './net.js';
import { validateC2S } from '../../shared/protocol.js';

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
export function roomFromToken(token) {
  const match = typeof token === 'string' && /^([ABCDEFGHJKLMNPQRSTUVWXYZ]{4})\.[a-f0-9]{32}$/.exec(token);
  return match ? match[1] : null;
}

export class RoomNet extends Net {
  constructor(opts = {}) {
    super(opts);
    this.baseUrl = opts.baseUrl || globalThis.location?.origin || 'http://localhost:8787';
    this.fetch = opts.fetch || ((...args) => globalThis.fetch(...args));
    this._identityToken = this.getToken;
    this._routeToken = undefined;
    this.getToken = () => this._routeToken === undefined ? this._identityToken() : this._routeToken;
    this.route = null;
    this.room = null;
    this._allocation = null;
    this._routeEpoch = 0;
    this._switching = false;
    this.on('room.state', msg => { this.room = msg; });
    this.on('room.closed', () => { this.room = null; });
  }

  async _api(path, body) {
    const abort = new AbortController();
    const timer = this.timers.setTimeout(() => abort.abort(), 10000);
    try {
      const response = await this.fetch(new URL(path, this.baseUrl).href, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal, cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new NetError(result.error || 'INTERNAL', undefined, result.detail);
      return result;
    } catch (error) {
      if (error instanceof NetError) throw error;
      throw new NetError('OFFLINE', '无法连接服务器，请检查网络后重试');
    } finally { this.timers.clearTimeout(timer); }
  }

  async _reserve() {
    const route = await this._api('/api/rooms', {});
    if (!CODE.test(route.code) || !/^[a-f0-9]{32}$/.test(route.ticket)) throw new NetError('INTERNAL');
    return { code: route.code, ticket: route.ticket };
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    if (this._allocation) return;
    this._manualClose = false;
    const epoch = this._routeEpoch;
    const token = this.getToken();
    if (!this.route && roomFromToken(token)) this.route = { code: roomFromToken(token) };
    if (this.route) { this._connectRoute(); return; }
    this._setStatus(this.attempt ? 'reconnecting' : 'connecting');
    this._allocation = this._reserve().then(route => {
      if (epoch !== this._routeEpoch || this._manualClose) return;
      this.route = route;
      this._routeToken = null;
      this._connectRoute();
    }).catch(error => {
      if (epoch !== this._routeEpoch || this._manualClose) return;
      this.lastError = error;
      this._scheduleReconnect();
    }).finally(() => { this._allocation = null; });
  }

  _connectRoute() {
    this._routeConnected = false;
    const url = new URL('/ws', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', this.route.code);
    if (this.route.ticket) url.searchParams.set('ticket', this.route.ticket);
    this.url = url.href;
    super.connect();
  }

  _onOpen() {
    this._routeConnected = true;
    super._onOpen();
  }

  _sendRaw(msg) {
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

  _onClose(ev) {
    if (this._routeConnected || !this.route || this._manualClose) return super._onClose(ev);
    // A handshake failure may mean the old room expired. Only an explicit 404
    // discards the session route; transient network failures keep it for retry.
    const epoch = this._routeEpoch;
    const route = this.route;
    this._teardownSocket();
    this._failPending('DISCONNECTED', false);
    this._setStatus('reconnecting');
    this._api(`/api/rooms/${route.code}`).catch(error => {
      if (error.code === 'ROOM_NOT_FOUND' && epoch === this._routeEpoch && this.route === route && !this._manualClose) {
        this.route = null;
        this._routeToken = null;
        this.room = null;
      }
    }).finally(() => {
      if (epoch === this._routeEpoch && !this._manualClose && !this.ws) this._scheduleReconnect();
    });
  }

  _onWelcome(msg) {
    const changed = this.playerId && this.playerId !== msg.playerId;
    this._routeToken = msg.token;
    if (changed) this.room = null;
    super._onWelcome(msg);
  }

  close() {
    this._routeEpoch++;
    super.close();
  }

  _online() {
    if (this.status === 'online') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        this.timers.clearTimeout(timer);
        unWelcome(); unError(); unStatus();
        error ? reject(error) : resolve();
      };
      const unWelcome = this.on('welcome', () => finish());
      const unError = this.on('helloError', finish);
      const unStatus = this.on('status', state => { if (state.status === 'closed') finish(new NetError('CLOSED')); });
      const timer = this.timers.setTimeout(() => finish(new NetError('TIMEOUT')), 12000);
      this.connect();
    });
  }

  async _openRoute(route, token) {
    this._routeEpoch++;
    this._clearTimer('_reconnectTimer', 'clearTimeout');
    const old = this.ws;
    this._teardownSocket();
    try { old?.close(4000, 'switch room'); } catch { /* already closed */ }
    this._failPending('DISCONNECTED', true);
    this.route = route;
    this._routeToken = token;
    this.attempt = 0;
    this.clockSynced = false;
    this._clockSamples = [];
    this._setStatus('connecting');
    await this._online();
  }

  async request(type, fields = {}, opts = {}) {
    if (type !== 'room.create' && type !== 'room.join') {
      const leavesRoom = type === 'room.leave' || type === 'g.leave';
      try {
        const reply = await super.request(type, fields, opts);
        if (leavesRoom) this.room = null;
        return reply;
      } catch (error) {
        if (leavesRoom && error.code === 'NOT_IN_ROOM') this.room = null;
        throw error;
      }
    }
    if (validateC2S({ ...fields, t: type })) throw new NetError('BAD_MSG');
    if (!this.name || this._manualClose) throw new NetError(this._manualClose ? 'CLOSED' : 'OFFLINE');
    const code = type === 'room.join' ? String(fields.code).trim().toUpperCase() : null;
    if (type === 'room.join' && code === this.room?.code) return super.request(type, { ...fields, code }, opts);
    // The UI already leaves before opening another room; enforce that boundary during concurrent clicks too.
    if (this.room) throw new NetError('BAD_MSG', '请先离开当前房间');
    if (this._switching) throw new NetError('RATE', '正在连接房间，请稍候');
    this._switching = true;
    let previous;
    let switched = false;
    try {
      await this._online();
      previous = { route: this.route, token: this.getToken() };
      let route;
      if (type === 'room.create') route = await this._reserve();
      else {
        if (!CODE.test(code)) throw new NetError('ROOM_NOT_FOUND');
        const status = await this._api(`/api/rooms/${code}`);
        if (status.inMatch) throw new NetError('ROOM_STARTED');
        if (status.full || status.mode === 'solo') throw new NetError('ROOM_FULL');
        route = { code };
      }
      if (this._manualClose) throw new NetError('CLOSED');
      switched = true;
      await this._openRoute(route, route.code === previous.route?.code ? previous.token : null);
      return await super.request(type, type === 'room.join' ? { ...fields, code } : fields, opts);
    } catch (error) {
      if (switched && previous?.route && !this._manualClose) {
        try { await this._openRoute(previous.route, previous.token); } catch { /* normal reconnect retries continue */ }
      }
      throw error;
    } finally { this._switching = false; }
  }
}

export function configureRoomNet(opts = {}) {
  return configureTransport(identity => new RoomNet({ ...identity, ...opts }));
}
