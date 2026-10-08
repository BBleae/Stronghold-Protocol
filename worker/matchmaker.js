// 匹配 (matchmaking queue, DESIGN §F4.2) for the room Worker (account mode).
//
// The Node server's queue lives in its lobby (server/lobby.js queueTick): every session is connected to that one lobby,
// and the server seats a formed group itself. In the Worker each room is its own Durable Object and the menu has no
// socket, so the queue is one more Durable Object (`MATCHMAKER`, the single instance named 'queue'), reached by polling
// `POST /api/queue` (worker/rooms/queue-routes.js). A formed group then opens its room the way players do:
//   1. its first member (the host) creates a co-op room (POST /api/rooms, room.create) and reports the code ('hosted');
//   2. the others get that code and apply to join it (the invite path: room.join → a join application);
//   3. the host's page approves exactly the accounts of its group (public/js/room-net.js), and screens/room.js fills
//      the missing seats with AI teammates and starts once everybody is in and ready.
// Nothing here seats, approves or creates anything on its own: every room write is one of the players' own
// authenticated requests, with the checks those requests always have. The queue is memory only: an evicted instance
// starts empty, and the next poll (which carries the difficulty) re-enters the player.
//
// The grouping rules are the Node queue's (same difficulty, at most DEFAULT_SEATS humans, ≥ minSeats after the grace
// from the group's LAST arrival, a lone player after the timeout). What the Node queue tells by the socket closing is
// told here by the polls stopping (silentMs): a silent page leaves the queue, and a group that is still waiting for its
// room no longer waits for it.

import { DEFAULT_SEATS, DIFFICULTIES } from '../shared/constants.js';
import { PresenceBoard, PRESENCE_PATH } from './presence.js';

/** Timings (ms) and sizes; the Node queue's grace / timeout / minimum, plus what polling adds. */
export const QUEUE = Object.freeze({
  minSeats: 2,        // humans a group needs before it may start before the timeout (server/lobby.js queueMinSeats)
  graceMs: 3000,      // …once nobody arrived for this long (queueGraceMs)
  timeoutMs: 20_000,  // a lone player gets a room after this long (queueTimeoutMs)
  silentMs: 6000,     // a waiting account whose page stopped polling (every 1.5 s) is dropped
  hostMs: 20_000,     // the host must report its room within this long, else the group goes back to the queue
  groupMs: 120_000,   // a hosted group is kept this long, for the members' pages to fetch the code
  leftMs: 5000,       // a poll this soon after a leave crossed it on the way: it does not queue the account again
});

const CODE = /^[A-Z]{4}$/;

/**
 * The queue and the formed groups. Every call first runs `tick()` with the current time, so the instance needs no timer.
 * Statuses: `{ waiting, difficulty, count, total, waitedMs, minSeats, seats }` (the Node queue.status) plus, once the
 * account is in a formed group, `matched`: host `{ role: 'host', difficulty, code|null, expect, members }` (`expect` =
 * humans of the group, `members` = the other accounts, whose join applications the host approves), member
 * `{ role: 'member', difficulty, code }` (a member still waiting for the host's room keeps `waiting: true`).
 */
export class MatchQueue {
  constructor({ now = Date.now, opts = {} } = {}) {
    this.now = now;
    this.opts = { ...QUEUE, ...opts };
    /** @type {{ accountId: string, difficulty: string, since: number }[]} arrival order */
    this.queue = [];
    /** @type {Map<string, { id: number, difficulty: string, host: string, members: string[], code: string|null,
     *   formedAt: number, hostedAt: number, told: boolean, handed: Set<string>, sinces: Record<string, number> }>} */
    this.groups = new Map();
    /** @type {Map<string, number>} accountId → group id */
    this.groupOf = new Map();
    /** @type {Map<string, number>} accountId → the last time its page asked (queued or grouped accounts) */
    this.seen = new Map();
    /** @type {Map<string, number>} accountId → when it left (see `leftMs`) */
    this.left = new Map();
    this.nextGroup = 1;
  }

  /**
   * Refresh the account's place, or (re-)enter the queue with a difficulty. `fresh` (the page's 匹配 click) starts over:
   * whatever group the account was in before is left first. A plain poll keeps the account's group, and re-enters the
   * queue only when its place was lost (an evicted instance) — never right after a leave it crossed.
   */
  join(accountId, difficulty, { fresh = false } = {}) {
    if (!DIFFICULTIES.includes(difficulty)) return { error: 'BAD_MSG' };
    const now = this.now();
    if (fresh) {
      this.left.delete(accountId);
      this.forget(accountId, now);
    } else if (this.left.has(accountId)) {
      this.tick(now);
      if (this.left.has(accountId)) return { waiting: false };
    }
    this.seen.set(accountId, now);
    this.tick(now);
    if (!this.groupOf.has(accountId)) {
      const e = this.queue.find((x) => x.accountId === accountId);
      if (e) {
        if (e.difficulty !== difficulty) Object.assign(e, { difficulty, since: now });
      } else {
        this.queue.push({ accountId, difficulty, since: now });
      }
      this.tick(now);
    }
    const g = this.groups.get(this.groupOf.get(accountId));
    if (g?.host === accountId) g.told = true; // its page now opens the room: hostMs bounds it from here
    else if (g?.code) g.handed.add(accountId); // its page now applies to the room and stops polling
    return this.status(accountId, now);
  }

  /** Leave the queue, or the group this account was put in (its host leaving ends the group). */
  leave(accountId) {
    const now = this.now();
    this.forget(accountId, now);
    this.left.set(accountId, now);
    this.tick(now);
    return { waiting: false };
  }

  forget(accountId, now) {
    this.queue = this.queue.filter((x) => x.accountId !== accountId);
    const g = this.groups.get(this.groupOf.get(accountId));
    if (!g) return;
    this.groupOf.delete(accountId);
    // the host's room goes with it (cancelled while opening it, or 匹配 again): the members still waiting for the code
    // go back to the queue
    if (g.host === accountId) this.dissolve(g, now, accountId);
    else g.members = g.members.filter((x) => x !== accountId);
    if (!g.members.length) this.groups.delete(g.id);
  }

  /** The host reports the room it opened for its group. */
  hosted(accountId, code) {
    const now = this.now();
    this.tick(now);
    const g = this.groups.get(this.groupOf.get(accountId));
    if (!g || g.host !== accountId || typeof code !== 'string' || !CODE.test(code)) return { error: 'BAD_TARGET' };
    if (g.code && g.code !== code) return { error: 'BAD_TARGET' };
    if (!g.code) Object.assign(g, { code, hostedAt: now });
    return this.status(accountId, now);
  }

  /** What `accountId` sees now (see the class comment). */
  status(accountId, now = this.now()) {
    const g = this.groups.get(this.groupOf.get(accountId));
    if (g) {
      if (g.host === accountId) {
        return { waiting: false, matched: { role: 'host', difficulty: g.difficulty, code: g.code, expect: g.members.length,
          members: g.members.filter((x) => x !== accountId) } };
      }
      if (g.code) return { waiting: false, matched: { role: 'member', difficulty: g.difficulty, code: g.code } };
      // put in a group whose host is opening the room: still waiting, as one of a full count
      return { waiting: true, difficulty: g.difficulty, count: g.members.length, total: this.queue.length + g.members.length,
        waitedMs: Math.max(0, now - (g.sinces[accountId] ?? g.formedAt)), minSeats: this.opts.minSeats, seats: DEFAULT_SEATS };
    }
    const e = this.queue.find((x) => x.accountId === accountId);
    if (!e) return { waiting: false };
    return {
      waiting: true, difficulty: e.difficulty,
      count: this.queue.filter((x) => x.difficulty === e.difficulty).length, total: this.queue.length,
      waitedMs: Math.max(0, now - e.since), minSeats: this.opts.minSeats, seats: DEFAULT_SEATS,
    };
  }

  /**
   * Put a group's members back at the front of the queue, keeping their waiting time; `drop`, and the members already
   * handed the room's code (their pages stopped polling), are not put back.
   */
  dissolve(g, now, drop = null) {
    const back = g.members.filter((x) => x !== drop && !g.handed.has(x))
      .map((accountId) => ({ accountId, difficulty: g.difficulty, since: g.sinces[accountId] ?? now }));
    for (const accountId of g.members) this.groupOf.delete(accountId);
    this.groups.delete(g.id);
    this.queue = [...back, ...this.queue.filter((x) => !back.some((b) => b.accountId === x.accountId))];
  }

  /**
   * 在线人数 (worker/presence.js): the accounts whose page is waiting here right now — in the queue, or in a group whose
   * room they are not in yet — and polled within `silentMs`. They hold no socket, so the presence board counts them here;
   * a member handed the room's code, and a host that reported its room, are in that room (its socket counts there).
   * Reads only: forms no group.
   */
  waiting(now = this.now()) {
    let n = 0;
    for (const [accountId, t] of this.seen) {
      if (now - t >= this.opts.silentMs) continue;
      const g = this.groups.get(this.groupOf.get(accountId));
      const inRoom = g && (g.handed.has(accountId) || (g.host === accountId && g.code));
      if (g ? !inRoom : this.queue.some((e) => e.accountId === accountId)) n++;
    }
    return n;
  }

  /** Drop the silent, expire the groups, and form every group the rules allow (server/lobby.js queueTick). */
  tick(now = this.now()) {
    const o = this.opts;
    for (const [accountId, t] of this.left) if (now - t >= o.leftMs) this.left.delete(accountId);
    const silent = (accountId) => !(now - (this.seen.get(accountId) ?? -Infinity) < o.silentMs);
    this.queue = this.queue.filter((e) => !silent(e.accountId));
    for (const g of [...this.groups.values()]) {
      if (!g.code) {
        // the host never opened the room, or its page went away before it was told to
        if (now - g.formedAt >= o.hostMs || (!g.told && silent(g.host))) { this.dissolve(g, now, g.host); continue; }
        // a member whose page went away is not waited for (its seat gets an AI teammate)
        for (const accountId of g.members) if (accountId !== g.host && silent(accountId)) this.groupOf.delete(accountId);
        g.members = g.members.filter((accountId) => this.groupOf.get(accountId) === g.id);
      } else if (now - g.hostedAt >= o.groupMs) {
        for (const accountId of g.members) this.groupOf.delete(accountId);
        this.groups.delete(g.id);
      }
    }
    for (const [accountId, t] of this.seen) if (now - t >= o.silentMs && !this.groupOf.has(accountId)) this.seen.delete(accountId);
    const taken = new Set();
    for (const head of this.queue) {
      if (taken.has(head.accountId)) continue;
      const members = [head];
      for (const e of this.queue) {
        if (members.length >= DEFAULT_SEATS) break;
        if (e === head || taken.has(e.accountId) || e.difficulty !== head.difficulty) continue;
        members.push(e);
      }
      // the grace runs from the group's own last arrival: players of another difficulty never hold it back
      const lastArrival = members.reduce((t, e) => Math.max(t, e.since), 0);
      const ready = members.length >= DEFAULT_SEATS
        || (members.length >= o.minSeats && now - lastArrival >= o.graceMs)
        || now - head.since >= o.timeoutMs;
      if (!ready) continue;
      for (const e of members) taken.add(e.accountId);
      const id = this.nextGroup++;
      const g = { id, difficulty: head.difficulty, host: head.accountId, members: members.map((e) => e.accountId), code: null,
        formedAt: now, hostedAt: 0, told: false, handed: new Set(), sinces: Object.fromEntries(members.map((e) => [e.accountId, e.since])) };
      this.groups.set(id, g);
      for (const e of members) this.groupOf.set(e.accountId, id);
    }
    if (taken.size) this.queue = this.queue.filter((e) => !taken.has(e.accountId));
  }
}

/**
 * The queue's Durable Object (binding MATCHMAKER, instance 'queue'). Its caller for the queue is the Worker's /api/queue
 * route, which authenticated the account: `X-Account-ID` names it, the JSON body is `{ action: 'join'|'poll'|'leave'|
 * 'hosted', difficulty?, code? }`.
 * It also holds the presence board (在线人数, worker/presence.js) at PRESENCE_PATH: rooms POST their `{ roomId, online,
 * inRoom }` and GET /healthz reads the sums; both are answered with `{ online, inRoom, rooms, queued }`, `online`
 * including the queue's waiting pages (`queued`). Like the queue, the board is memory only.
 */
export class Matchmaker {
  constructor(state, env, { now = Date.now } = {}) {
    this.queue = new MatchQueue({ now });
    this.board = new PresenceBoard({ now });
  }

  /** The site-wide presence counters: the rooms' sums, plus the pages waiting in the queue as online. */
  presence() {
    const { online, inRoom, rooms } = this.board.totals();
    const queued = this.queue.waiting();
    return { online: online + queued, inRoom, rooms, queued };
  }

  async fetch(request) {
    if (new URL(request.url).pathname === PRESENCE_PATH) {
      if (request.method === 'POST') {
        let report = null;
        try { report = await request.json(); } catch { /* malformed: refused below */ }
        if (!this.board.report(report ?? {})) return Response.json({ error: 'BAD_MSG' }, { status: 400 });
      } else if (request.method !== 'GET') {
        return Response.json({ error: 'BAD_MSG' }, { status: 405 });
      }
      return Response.json(this.presence());
    }
    const accountId = request.headers.get('X-Account-ID');
    if (!accountId || request.method !== 'POST') return Response.json({ error: 'BAD_MSG' }, { status: 400 });
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'BAD_MSG' }, { status: 400 }); }
    let out;
    switch (body?.action) {
      case 'join': out = this.queue.join(accountId, body.difficulty, { fresh: true }); break;
      case 'poll': out = this.queue.join(accountId, body.difficulty); break;
      case 'leave': out = this.queue.leave(accountId); break;
      case 'hosted': out = this.queue.hosted(accountId, body.code); break;
      default: out = { error: 'BAD_MSG' };
    }
    return Response.json(out, { status: out.error ? 400 : 200 });
  }
}
