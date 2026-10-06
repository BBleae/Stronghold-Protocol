// Durable Object storage helpers shared by the room objects (worker/index.js) and the lobby
// gateway (worker/lobby-gateway.js): the KV snapshot chunking and liveness rounding both
// saves use, the rules-version check both restores need, and the WebSocket adapter both DOs
// feed to Network. Kept out of match-versions.js (the release build regenerates that file)
// and imported never the other way (index.js already imports lobby-gateway.js).
import { retainedMatchVersions } from './match-versions.js';
import { RULES_VERSION } from '../shared/rules-version.js';
import { CLOSE } from './close-codes.js';

// The snapshot is stored as KV values of this many UTF-16 characters (a value holds at most 128 KiB).
export const SNAPSHOT_PART = 16_000;
// A save compares the snapshot with liveness timestamps rounded to this: pings alone write at most this often.
export const LIVENESS_MS = 30_000;
export const liveness = (key, value) => (key === 'lastSeen' ? Math.floor(value / LIVENESS_MS) : value);

/** A rules version this bundle can restore: its own or a retained one. */
export const knownRulesVersion = (id) => id === RULES_VERSION || Object.hasOwn(retainedMatchVersions, id);

// Adapt the Workers WebSocket surface to the existing Network's small EventEmitter-like contract. An event's output
// waits for the event's commit (flush): its frames, then a close the event made.
export class SocketAdapter {
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
