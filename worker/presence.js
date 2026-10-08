// 在线人数 (presence counters, the owner's decision of 2026-10-08, after Jerryzhu1234510's fork 4f4e848f) for the
// Cloudflare deployment. The meaning is the Node server's (server/lobby.js presence): `online` = the clients with a live
// socket, `inRoom` = the humans holding a seat plus the spectators.
//
// The Node server counts its own sockets. Here every socket lives in one room's Durable Object, and the menu holds no
// socket at all, so the counters are summed on one board that the rooms report to:
//   * a room (worker/index.js RoomDurableObject.publishPresence) reports { online: its open sockets, inRoom: its humans
//     holding a seat plus its spectators } when the numbers change, renews the report at its first event
//     PRESENCE.refreshMs after the last one (its login checks wake it every minute while a socket is open, so a renewal
//     costs no wake of its own), and withdraws it once both numbers are zero;
//   * the board (PresenceBoard) keeps a report for PRESENCE.leaseMs: a room that stops reporting (evicted with nobody
//     connected, crashed, restarted by a deployment) drops out by itself;
//   * the board lives in the Matchmaker's single instance (MATCHMAKER 'queue', memory only like the queue): no Durable
//     Object class of its own, and the 匹配 queue's waiting pages, which poll and hold no socket, are counted where
//     they are (MatchQueue.waiting) — they are `online`, as a Node client waiting in the queue is;
//   * GET /healthz (healthPresence) reads the sums at most once per PRESENCE.cacheMs per isolate and per Cloudflare
//     location (the Cache API), so the pages polling it (the title screen every 10 s) never reach a room, and reach the
//     board a few times a minute however many of them there are.
// A room's report answers with the sums, which the room passes to its sessions as the `presence` frame when they
// changed (worker/room-runtime.js AlarmLobby): no request of its own.
//
// Not counted, unlike on a Node server: a page on the title screen or browsing the lobby (it polls over HTTP and holds
// no socket). The node-protocol deployment (NODE_COMPAT, worker/lobby-gateway.js) runs the whole lobby in one object
// and counts exactly as the Node server does.

import { within, networkKey } from './http.js';

/** Timings (ms). */
export const PRESENCE = Object.freeze({
  refreshMs: 55_000,  // a room renews its report at its first event this long after the last one…
  forceMs: 100_000,   // …and is woken for it this long after the last one when nothing else woke it (a socket is open)
  leaseMs: 150_000,   // the board forgets a room this long after its last report
  cacheMs: 5_000,     // /healthz reads the board at most this often (per isolate, and per location through the Cache API)
  staleMs: 60_000,    // a board that cannot be read (over STATUS_LIMIT, failing, slow) leaves the last sums this long
  timeoutMs: 2_000,   // a board that does not answer within this long is not waited for
  graceMs: 1_000,     // a request waits for a read in flight at most timeoutMs + this long (then: the last sums)
});

/** The Matchmaker's internal route of the board (only Durable Object stubs reach it; the Worker never forwards to it). */
export const PRESENCE_PATH = '/_presence';

const ROOM = /^[A-Z]{4}$/;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000;

/**
 * The rooms' reports (memory only). A report replaces the room's previous one; zeros withdraw it; a report older than
 * the lease no longer counts.
 */
export class PresenceBoard {
  constructor({ now = Date.now, leaseMs = PRESENCE.leaseMs } = {}) {
    this.now = now;
    this.leaseMs = leaseMs;
    /** @type {Map<string, { online: number, inRoom: number, expiresAt: number }>} room code → its last report */
    this.rooms = new Map();
  }

  /** A room's numbers. False for a malformed report (nothing changes). */
  report({ roomId, online, inRoom } = {}) {
    if (typeof roomId !== 'string' || !ROOM.test(roomId) || !isCount(online) || !isCount(inRoom)) return false;
    if (!online && !inRoom) this.rooms.delete(roomId);
    else this.rooms.set(roomId, { online, inRoom, expiresAt: this.now() + this.leaseMs });
    return true;
  }

  /** The sums of the rooms whose lease runs (expired reports are dropped). */
  totals() {
    const now = this.now();
    let online = 0;
    let inRoom = 0;
    for (const [roomId, entry] of this.rooms) {
      if (entry.expiresAt <= now) { this.rooms.delete(roomId); continue; }
      online += entry.online;
      inRoom += entry.inRoom;
    }
    return { online, inRoom, rooms: this.rooms.size };
  }
}

/** `{ online, inRoom }` of an answer, or null when it is not two counts. */
export function presenceOf(value) {
  return value && isCount(value.online) && isCount(value.inRoom) ? { online: value.online, inRoom: value.inRoom } : null;
}

// The Matchmaker's single instance (worker/rooms/queue-routes.js names it the same way).
const boardOf = (env) => env.MATCHMAKER.get(env.MATCHMAKER.idFromName('queue'));

/** A room's report (`{ roomId, online, inRoom }`); resolves with the site-wide sums. Throws when the board refused it. */
export async function reportPresence(env, report) {
  const response = await boardOf(env).fetch(new Request('https://queue.internal' + PRESENCE_PATH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }));
  if (!response.ok) throw new Error(`presence report refused (${response.status})`);
  const totals = presenceOf(await response.json());
  if (!totals) throw new Error('presence report: malformed answer');
  return totals;
}

/** The board's sums, or null when it fails or does not answer within `timeoutMs`. Never throws. */
export async function readBoard(env, { timeoutMs = PRESENCE.timeoutMs } = {}) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const read = boardOf(env).fetch(new Request('https://queue.internal' + PRESENCE_PATH))
      .then(async (response) => (response.ok ? presenceOf(await response.json()) : null), () => null);
    return await Promise.race([read, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// What this isolate last read (the sums and when), when it last read past the Cache API (the board: a read that failed
// is not tried again sooner than PRESENCE.cacheMs; a request refused on its own network's limit is no attempt), and the
// read in flight with when it started, which concurrent requests share.
const fresh = () => ({ value: null, at: -Infinity, triedAt: -Infinity, pending: null, pendingAt: -Infinity });
const shared = fresh();

/** An empty cache state of its own (healthPresence `state`, for a test). */
export function presenceCacheState() { return fresh(); }
/** Empty the isolate's own cache state (a test going through worker.fetch). */
export function resetPresenceCache() { Object.assign(shared, fresh()); }

const UNKNOWN = Object.freeze({ online: null, inRoom: null });
const defaultCache = () => (typeof caches !== 'undefined' && caches?.default) || null;
// The Cache API key: a path of the deployment's own origin that no route serves (the sums are public anyway).
const CACHE_PATH = '/__presence';

/**
 * The counters GET /healthz carries: `{ online, inRoom }`, numbers, or null when unknown (no board bound, or it could not
 * be read and nothing read in the last PRESENCE.staleMs). Read from this isolate's copy while it is younger than
 * PRESENCE.cacheMs, else from this location's Cache API copy, else from the board — which counts against the client
 * network's STATUS_LIMIT like the other status polls (only that read reaches a Durable Object; a network over its
 * limit gets the last sums instead — that network only: its refusal is no attempt of the isolate's, and a request of
 * another network that joined it reads the board itself).
 * A read in flight is shared by the concurrent requests; it runs under the starting request's `waitUntil` (the worker's
 * ctx), so a client that goes away mid-read cancels nothing the others wait for, and no request waits for one longer
 * than timeoutMs + PRESENCE.graceMs — one older than that is dropped and the next request starts afresh.
 * `now`, `cache` (a Cache API cache, or null), `state` (the isolate's copy), `timeoutMs` and `graceMs` are for tests.
 */
export async function healthPresence(request, env, { now = Date.now, cache = defaultCache(), state = shared, timeoutMs, graceMs = PRESENCE.graceMs, waitUntil } = {}) {
  if (!env.MATCHMAKER) return UNKNOWN;
  const waitMs = (timeoutMs ?? PRESENCE.timeoutMs) + graceMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = now();
    if (state.value && t - state.at < PRESENCE.cacheMs) return state.value;
    // a read started by a request whose I/O was cancelled may never settle: not waited for past waitMs
    if (state.pending && t - state.pendingAt >= waitMs) state.pending = null;
    if (!state.pending) {
      if (t - state.triedAt < PRESENCE.cacheMs) return staleOf(state, t) ?? UNKNOWN;
      // (a limit binding that throws never turns the health answer into an error: the counters are only unknown)
      const p = refresh(request, env, { now, cache, state, timeoutMs })
        .catch(() => ({ value: staleOf(state, now()) }))
        .finally(() => { if (state.pending === p) state.pending = null; });
      state.pending = p;
      state.pendingAt = t;
      try { waitUntil?.(p); } catch { /* no context: the waiters' own bound still holds */ }
    }
    const r = await settleWithin(state.pending, waitMs);
    if (!r) return staleOf(state, now()) ?? UNKNOWN;
    // refused on the starting request's own network only: a request of another network reads the board itself
    if (r.refused && r.key !== networkKey(request) && attempt === 0) continue;
    return r.value ?? UNKNOWN;
  }
  return staleOf(state, now()) ?? UNKNOWN;
}

const staleOf = (state, t) => (state.value && t - state.at < PRESENCE.staleMs ? state.value : null);

/** `promise`'s value, or null when it does not settle within `ms`. */
async function settleWithin(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One read past the isolate's copy: `{ value }`, or `{ value, refused: true, key }` when the network `key` is over its limit. */
async function refresh(request, env, { now, cache, state, timeoutMs }) {
  const remember = (value, at) => {
    if (at > state.at || !state.value) Object.assign(state, { value, at });
    return value;
  };
  const stale = () => staleOf(state, now());
  let key = null;
  try { key = new Request(new URL(CACHE_PATH, request.url)); } catch { /* no usable origin: no shared copy */ }
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      const body = hit ? await hit.json() : null;
      const value = presenceOf(body);
      if (value && Number.isFinite(body.at) && now() - body.at < PRESENCE.cacheMs) return { value: remember(value, body.at) };
    } catch { /* an unreadable copy is a miss */ }
  }
  if (env.STATUS_LIMIT) {
    const net = networkKey(request);
    let ok;
    try { ok = await within(env.STATUS_LIMIT, net); } catch (e) { state.triedAt = now(); throw e; }
    if (!ok) return { value: stale(), refused: true, key: net };
  }
  state.triedAt = now();
  const value = await readBoard(env, { timeoutMs });
  if (!value) return { value: stale() };
  const at = now();
  remember(value, at);
  if (cache && key) {
    try {
      await cache.put(key, Response.json({ ...value, at }, {
        headers: { 'Cache-Control': `public, max-age=${Math.ceil(PRESENCE.cacheMs / 1000)}` } }));
    } catch { /* the isolate's copy still serves */ }
  }
  return { value };
}
