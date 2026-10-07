#!/usr/bin/env node
// Local workerd benchmark for RoomDO scheduling. Never sends requests to a deployed Worker.
//
// Usage:
//   node tools/bench-worker-scheduling.mjs --tag before --output .cache/scheduling-bench
//   node tools/bench-worker-scheduling.mjs --root /path/to/other/checkout --tag after --output /same/output
//   node tools/bench-worker-scheduling.mjs --configs ai8,human8 --duration-ms 14000 --round 11 --seed 17
//   node tools/bench-worker-scheduling.mjs --configs h1ai7,mixed8 --ready-after-ms 0,1200 --duration-ms 180000
//   node tools/bench-worker-scheduling.mjs --configs ai8timed,mixed8 --duration-ms 140000 --ready-after-ms 120000
//   node tools/bench-worker-scheduling.mjs --root /baseline/checkout --prepare-only --tag baseline-lineups
//
// Scenarios: ai4/ai8 = one connected human on autoplay plus 3/7 AI seats (4/8 AI-controlled seats, untimed prep);
// h1ai3/h1ai7 = one connected human who does NOT autoplay and readies after --ready-after-ms, plus 3/7 AI seats:
// the single-human room has no prep deadline, so its PREP ends only when the AI seats finish (the human waits);
// hNaiM (N >= 1 humans, N + M = 4..8 seats) is the general form: mixed8 = h4ai4, human8 = h8ai0 (timed when N > 1).
// ai8timed = eight connected human protocol seats on autoplay: eight AI preparation jobs with the real
// multiplayer prep deadline. Their combat fields run on the eight SimClients, not as server AI fields.
// --ready-after-ms is relative to each client's first PREP message per round (default 1200: a human who readies
// early, before the AI seats). A comma list (0,1200) runs every manual scenario once per value; AI-only scenarios
// run once. A delay later than the AI seats' own prep (e.g. 30000) makes the human decide the phase change and hides
// any wait for AI work: use it only to measure a full prep window, never as evidence that nobody waits.
// Preparation uses the same seed and autoplay to reach the requested round with non-empty lineups.
// Fixed work slicing is disabled only during preparation, then restored for the measured window.
// The preparation log is NOT a valid recovery fixture; recovery is covered by separate engine tests.
// --prepare-only records initial workload fingerprints without generating measured traffic.
// It is excluded from RTT measurements. SimClients then run real, paced client battles and submit
// progress through WebSockets. They do not make AI decisions in the human/mixed measured window.
//
// Production RoomDO event(), its two pump() calls, timers, save(), SQLite/KV storage and socket flush
// remain intact. Only local fixture account provisioning and the clock origin are adapted; external
// account/listing/archive background jobs are disabled. A second (light) room receives ping/ready traffic
// concurrently. Both rooms share one local workerd process: this does not measure production isolate
// placement, network latency, client rendering, or total CPU. The test reports elapsed measurement
// wall time and actual progress instead of treating fast request replies as proof that work completed.
//
// Every 50ms: one callback sends a timestamp ping to each room (main room rotates human sockets); the two pings carry
// the same pair index, and the report subtracts them pair by pair (main - light). Both slow at once is the shared
// workerd process (another room's event blocks this one too); only the main ping slow is queueing in the main room.
// Every 250ms: unitStats while the last client-visible phase allows it; manual humans ready after
// --ready-after-ms. Every 500ms: ready toggle in the independent light room. A queued operation can cross a phase
// boundary; WRONG_PHASE replies are retained, together with pending replies and closed sockets.
//
// Server-side labels: the main room traces every DO event of the measured window at its existing boundaries (the
// critical section's refreshAutoResponses() and commit(), the two pumps, the runtime's message()): the local Worker
// clock at its start, the phase and round at its start and after its work (PREP>COMBAT: a due timer of that event
// changed the phase), the Battle steps it ran (server fields, HeadlessJobs, Boss pacing and catch-up, AI rehearsals),
// the work allowance it used, the match log rows and SQL rows it appended, the inputs it handled, and its duration on
// the local Worker clock (workMs: pumps and input until the commit starts; commitMs: save, flush, schedule). Each
// ping and operation sample is labelled by the event that handled it, not by the client's last m.public (throttled
// to 100ms, so a sample sent while the server already ran a phase change counted under the old phase). It also
// carries the events that began after it was sent and before its own (it queued behind them) and their steps. The
// counters add no event, timer, message or storage write; a step costs one more call. Local workerd advances the
// clock during an event; a runtime that only advances it on I/O reads 0 for both durations.
//
// Output: <output>/<tag>-results.json includes RTT mean/p50/p95/p99/max by server label, paired main - light
// differences, the server event summary (events, events with work, steps per event, log rows per event), raw
// samples and events, pending/errors, initial/final lineups, phases, match events, transactions and SQL append
// counts. Each completed scenario also records fixture-only witnesses at existing pump/ready/phase-end boundaries:
// each seat's natural/forced ready time and deadline margin, when each PREP ended, and server calculation finished
// vs result done; humanWait is "last connected human ready -> PREP end" per round (Worker clock and virtual clock,
// with the number of DO events in between). The console prints the JSON line, then a table: every mean next to its
// p99 and maximum. The before/after metrics requests themselves run normal production events: transaction/event
// deltas can differ by about one boundary sampling event (the server trace excludes both).
// A short duration does not validate a full prep deadline; use up to 180000ms for complete windows.
// Preparation can end early when all seats ready; the tool does not keep them artificially unready.
// Each completed scenario is saved immediately. Compare identical configs/seed/round/duration on the same idle
// host; run only one benchmark/test process at a time. Small samples do not establish a production p95: with a
// few hundred samples p99 is one of the largest few values.
// Requires the repository's development dependencies and test/worker/helpers/account-harness.js.

import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--prepare-only") {
    options.prepareOnly = true;
    continue;
  }
  if (arg === "--help") {
    console.log("Usage: node tools/bench-worker-scheduling.mjs [--root DIR] [--tag LABEL] [--output DIR] [--configs ai4,ai8,ai8timed,h1ai3,h1ai7,human8,mixed8,hNaiM] [--duration-ms 14000 (4000..180000)] [--ready-after-ms 1200 | 0,1200 (each 0..180000)] [--round 11] [--seed 17] [--prepare-only]");
    process.exit(0);
  }
  if (!["--root", "--tag", "--output", "--configs", "--duration-ms", "--ready-after-ms", "--round", "--seed"].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error("Unknown or incomplete option: " + arg);
  options[arg.slice(2)] = process.argv[++i];
}
const root = path.resolve(options.root || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const tag = options.tag || "run";
if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error("--tag must contain only letters, numbers, underscore or hyphen");
// manual: the connected humans do not autoplay in the measured window and ready after --ready-after-ms.
const NAMED = { ai4: { seats: 4, humans: 1, manual: false }, ai8: { seats: 8, humans: 1, manual: false }, ai8timed: { seats: 8, humans: 8, manual: false }, human8: { seats: 8, humans: 8, manual: true }, mixed8: { seats: 8, humans: 4, manual: true } };
function scenario(name) {
  if (NAMED[name]) return NAMED[name];
  const x = /^h([1-8])ai([0-7])$/.exec(name);
  const humans = x && Number(x[1]), seats = x && humans + Number(x[2]);
  return x && seats >= 4 && seats <= 8 ? { seats, humans, manual: true } : null;
}
const configs = (options.configs || "ai4,ai8,h1ai7,human8,mixed8").split(",");
if (!configs.length || configs.some((c) => !scenario(c))) throw new Error("Unknown --configs scenario");
const durationMs = Number(options["duration-ms"] || 14e3), setupRound = Number(options.round || 11), seed = Number(options.seed || 17);
const readyAfterList = [...new Set(String(options["ready-after-ms"] ?? "1200").split(",").map(Number))];
if (!Number.isInteger(durationMs) || durationMs < 4e3 || durationMs > 18e4) throw new Error("--duration-ms must be 4000..180000");
if (readyAfterList.some((ms) => !Number.isInteger(ms) || ms < 0 || ms > 18e4)) throw new Error("--ready-after-ms must be 0..180000 (or a comma list of such values)");
if (!Number.isInteger(setupRound) || setupRound < 2 || setupRound > 15) throw new Error("--round must be 2..15");
if (!Number.isInteger(seed) || seed < 1 || seed > 4294967295) throw new Error("--seed must be 1..4294967295");
// --prepare-only sends no traffic: one run per scenario.
const runs = configs.flatMap((config) => !scenario(config).manual ? [{ config, readyAfterMs: null }]
  : options.prepareOnly ? [{ config, readyAfterMs: readyAfterList[0] }] : readyAfterList.map((readyAfterMs) => ({ config, readyAfterMs })));
const output = path.resolve(options.output || path.join(root, ".cache", "scheduling-bench"));
await fs.mkdir(output, { recursive: true });
const { bundleWorker } = await import(pathToFileURL(path.join(root, "tools/build-worker.mjs")));
const { createAccountHarness } = await import(pathToFileURL(path.join(root, "test/worker/helpers/account-harness.js")));
const { SimClient } = await import(pathToFileURL(path.join(root, "test/match/simClient.js")));
const { getDefaultSource } = await import(pathToFileURL(path.join(root, "server/sim/simdata.js")));
const tempRoot = path.resolve(tmpdir());
const dir = await fs.mkdtemp(path.join(tempRoot, "sp-scheduling-bench-"));
const entry = path.join(dir, "entry.mjs"), bundle = path.join(dir, "bundle.mjs");
const prefix = root.replaceAll("\\", "/");
try {
  await fs.writeFile(entry, `
import { RoomDurableObject as ProductionRoom } from ${JSON.stringify(prefix + "/worker/index.js")};
import { Room } from ${JSON.stringify(prefix + "/server/lobby.js")};
import { Session } from ${JSON.stringify(prefix + "/server/net.js")};
import { Battle } from ${JSON.stringify(prefix + "/server/sim/Battle.js")};
import { createHash } from "node:crypto";
// Battle steps run in this isolate: server fields, HeadlessJobs, Boss pacing and catch-up, AI rehearsals. Only the
// main room runs a match; the light room has none. Counting adds one call per step and changes no state.
const steps = { n: 0 };
const step = Battle.prototype.step;
Battle.prototype.step = function() {
  if (!this.finished && !this._stepping) steps.n++;
  return step.call(this);
};
function counted(ctx, self) {
  const sql = new Proxy(ctx.storage.sql, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (k === "exec") return (...a) => {
      if (/^INSERT INTO match_events/i.test(a[0])) self.rows = (self.rows || 0) + 1;
      return v.apply(t, a);
    };
    return typeof v === "function" ? v.bind(t) : v;
  } });
  const storage = new Proxy(ctx.storage, { get(t, k) {
    if (k === "sql") return sql;
    const v = Reflect.get(t, k, t);
    if (k === "transaction") return (fn) => {
      self.transactions = (self.transactions || 0) + 1;
      return v.call(t, fn);
    };
    return typeof v === "function" ? v.bind(t) : v;
  } });
  return new Proxy(ctx, { get(t, k) {
    if (k === "storage") return storage;
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  } });
}
class TestObject extends ProductionRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = counted(ctx, this);
  }
  startJobs() {
  }
  // Fixture has no external account/archive services; core event/timers/save/flush are production.
  jobsDue() {
    return Infinity;
  }
  event(fn) {
    this.eventCalls = (this.eventCalls || 0) + 1;
    return super.event(fn);
  }
  // Every event's critical section starts here (RoomDurableObject.event; load() once, before any trace exists) and
  // ends in commit(). An event that threw never reaches commit: the next event closes its record as failed.
  refreshAutoResponses() {
    this.traceBegin();
    return super.refreshAutoResponses();
  }
  async commit() {
    const closed = this.trace?.open ? this.traceClose(false) : null;
    await super.commit();
    if (closed) {
      closed.rec.sqlRows = (this.rows || 0) - closed.rows0;
      closed.rec.commitMs = Date.now() - this.trace.originUnixMs - closed.rec.atMs - closed.rec.workMs;
    }
  }
  benchMatch() {
    return this.runtime?.lobby.getRoom(this.runtime.code)?.match;
  }
  async route(req) {
    const u = new URL(req.url), rt = this.runtime;
    if (this.trace?.open) {
      this.trace.open.ticksAtInput ??= steps.n;
      this.trace.open.rec.fetch = u.pathname;
    }
    if (u.pathname === "/bench/init") {
      const x = await req.json();
      rt.code = x.code;
      rt.publicRoom = false;
      const room = new Room(x.code, "coop", "NORMAL", Date.now(), x.seats);
      rt.lobby.rooms.set(x.code, room);
      room.hostId = "p0";
      for (let i = 0; i < x.seats; i++) {
        const bot = i >= x.humans;
        room.seats[i] = { seat: i, playerId: "p" + i, name: "P" + i, isBot: bot, connected: true, ready: true, left: false };
        if (!bot) {
          const s = new Session({ playerId: "p" + i, token: (i + 1).toString(16).padStart(32, "0"), name: "P" + i });
          s.roomCode = x.code;
          s.accountId = "a" + i;
          s.disconnectedAt = null;
          rt.registry.byPlayerId.set(s.playerId, s);
          rt.registry.byTokenMap.set(s.token, s);
        }
      }
      return Response.json({ ok: true });
    }
    if (u.pathname === "/bench/prepare") {
      const x = await req.json(), room = rt.lobby.getRoom(rt.code);
      rt.lobby.seedFn = () => ${seed};
      const started = rt.lobby.startMatch(room);
      if (started.error) throw new Error(JSON.stringify(started));
      const m = room.match;
      const measuredWorkSlice = m.workSlice;
      m.workSlice = null;
      m._recordOutput.muted = true;
      for (const p of m.order) if (!p.isBot) m.handle(p.playerId, { t: "g.autoplay", on: true });
      let n = 0;
      const deadline = Date.now() + 6e4;
      while (!m.ended && m.round < ${setupRound} && n++ < 25e4) {
        if (Date.now() > deadline) throw new Error("setup deadline");
        const at = m.sched.nextAt();
        if (at == null) throw new Error("setup no timer");
        m.pump(at, 1);
      }
      if (m.round !== ${setupRound}) throw new Error("setup ended " + m.round);
      // The setup ran server fields and AI rehearsals: no counted step means the counter patched another Battle copy.
      if (!steps.n) throw new Error("Battle step counter is not linked to the match's Battle class");
      m.workSlice = measuredWorkSlice;
      this.clockOffset = m.sched.now() - Date.now();
      m._wallNow = () => Date.now() + this.clockOffset;
      this.installWitness(m);
      this.installTrace();
      const pump = rt.pump.bind(rt), due = rt.timerDue.bind(rt);
      rt.pump = (now = Date.now(), workBudget) => {
        const rec = this.trace?.open?.rec, remaining = workBudget?.remaining;
        const result = pump(now + this.clockOffset, workBudget);
        // Older engines take no allowance: budgetStart/budgetUsed stay null.
        if (rec && typeof remaining === "number") {
          rec.budgetStart ??= remaining;
          rec.budgetUsed = (rec.budgetUsed ?? 0) + remaining - workBudget.remaining;
        }
        this.observeWitness();
        return result;
      };
      rt.timerDue = () => {
        const at = due();
        return at == null ? null : at - this.clockOffset;
      };
      for (const p of m.order) if (!p.isBot && x.manual) m.handle(p.playerId, { t: "g.autoplay", on: false });
      this.observeWitness();
      m._recordOutput.muted = false;
      for (const p of m.order) if (!p.isBot) m.onReconnect(p.playerId);
      this.baseline = { eventCalls: this.eventCalls, transactions: this.transactions, rows: this.rows, events: m.recording.events.length };
      return Response.json(this.metrics());
    }
    if (u.pathname === "/bench/metrics") return Response.json(this.metrics());
    // The traced events strictly between two metrics requests (both excluded).
    if (u.pathname === "/bench/trace") {
      const x = await req.json(), t = this.trace;
      return Response.json({ originUnixMs: t?.originUnixMs ?? null, events: (t?.events || []).filter((e) => e.seq > x.after && e.seq < x.before) });
    }
    return super.route(req);
  }
  // Read-only fixture witnesses: no extra event, timer, message or storage write is introduced.
  installWitness(m) {
    this.witness = { timeOriginUnixMs: Date.now(), virtualOriginMs: m.sched.now(), phases: [], prep: [], serverFields: [], serverBatches: [] };
    const readyChanged = m.onReadyChanged, prepDeadline = m.prepDeadline, fieldDone = m._fieldDone;
    m.onReadyChanged = (p) => {
      this.observeWitness(p.ready ? p.playerId : null);
      return readyChanged.call(m, p);
    };
    m.prepDeadline = () => {
      this.observeWitness();
      const prep = this.witness.prep.find((x) => x.round === m.round);
      const pending = m.order.filter((p) => p.alive && !p.ready);
      const at = this.witnessTime();
      if (prep && m.phase === "PREP") {
        prep.end = { ...at, deadlineRemainingMs: prep.deadlineAtMs == null ? null : prep.deadlineAtMs - at.atMs,
          pendingSeats: pending.map((p) => p.seat), pendingAiSeats: pending.filter((p) => p.botControlled).map((p) => p.seat) };
      }
      const result = prepDeadline.call(m);
      if (prep) for (const p of pending) if (p.ready) this.recordReadyWitness(prep, p, "forcedAtPrepEnd", at);
      this.observeWitness();
      return result;
    };
    // The last released field can immediately replace m.fields; retain its result witness before it disappears.
    m._fieldDone = (f) => {
      this.observeWitness();
      const result = fieldDone.call(m, f);
      const at = this.witnessTime();
      const field = this.witness.serverFields.find((x) => x.battleId === f?.battleId);
      if (field && f.done) {
        field.resultDone ||= at;
        field.last = { ...at, job: !!f.job, battleFinished: !!f.battle?.finished, resultDone: true, endGt: f.endGt ?? null };
        for (const batch of this.witness.serverBatches) if (!batch.resultsDone && batch.fields.every((id) => this.witness.serverFields.find((x) => x.battleId === id)?.resultDone)) batch.resultsDone = at;
      }
      this.observeWitness();
      return result;
    };
  }
  // Read-only event trace (see the file header): the inputs each event handled, keyed as the client keys its samples.
  installTrace() {
    const rt = this.runtime, message = rt.message.bind(rt);
    const t = this.trace = { originUnixMs: this.witness.timeOriginUnixMs, seq: 0, open: null, events: [] };
    rt.message = (adapter, raw) => {
      const o = t.open;
      if (o) {
        o.ticksAtInput ??= steps.n;
        let key = "?";
        try {
          const x = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          key = x.t === "ping" && x.c != null ? "p" + x.c : x.rid != null ? "o" + x.rid : String(x.t);
        } catch {
        }
        o.rec.inputs.push(key);
      }
      return message(adapter, raw);
    };
  }
  traceBegin() {
    const t = this.trace;
    if (!t) return;
    if (t.open) this.traceClose(true);
    const m = this.benchMatch();
    t.open = { ticks0: steps.n, ticksAtInput: null, events0: m?.recording?.events.length ?? 0, rows0: this.rows || 0,
      rec: { seq: ++t.seq, atMs: Date.now() - t.originUnixMs, phase: m?.phase ?? null, round: m?.round ?? null, inputs: [], fetch: null, budgetStart: null, budgetUsed: null } };
  }
  traceClose(failed) {
    const t = this.trace, o = t.open, m = this.benchMatch(), rec = o.rec;
    t.open = null;
    rec.endPhase = m?.phase ?? null;
    rec.endRound = m?.round ?? null;
    rec.ticks = steps.n - o.ticks0;
    // Steps of the timers that came due before the event's input (all of them for a timer-only event).
    rec.ticksBeforeInput = (o.ticksAtInput ?? steps.n) - o.ticks0;
    rec.logRows = Math.max(0, (m?.recording?.events.length ?? 0) - o.events0);
    // A failed event's record closes when the next one begins: its duration is not known.
    rec.workMs = failed ? null : Date.now() - t.originUnixMs - rec.atMs;
    if (failed) rec.failed = true;
    t.events.push(rec);
    return o;
  }
  witnessTime() {
    const m = this.benchMatch();
    return { atMs: Date.now() - this.witness.timeOriginUnixMs, virtualAtMs: m.sched.now() - this.witness.virtualOriginMs };
  }
  recordReadyWitness(prep, p, source, at) {
    const seat = prep.seats.find((x) => x.seat === p.seat);
    if (!seat || seat.ready) return;
    seat.ready = { ...at, source, deadlineRemainingMs: prep.deadlineAtMs == null ? null : prep.deadlineAtMs - at.atMs,
      virtualDeadlineRemainingMs: prep.deadlineVirtualMs > 0 ? prep.deadlineVirtualMs - (this.witness.virtualOriginMs + at.virtualAtMs) : null };
    const ai = prep.seats.filter((x) => x.aiControlled);
    if (ai.length && !prep.allAiReady && ai.every((x) => x.ready)) {
      prep.allAiReady = { ...at, natural: ai.every((x) => x.ready.source !== "forcedAtPrepEnd"),
        deadlineRemainingMs: prep.deadlineAtMs == null ? null : prep.deadlineAtMs - at.atMs };
    }
  }
  observeWitness(readyPlayerId = null) {
    const w = this.witness, m = this.benchMatch();
    if (!w || !m) return;
    const at = this.witnessTime();
    const deadlineAtMs = m.deadline > 0 ? m.deadline - this.clockOffset - w.timeOriginUnixMs : null;
    const previous = w.phases.at(-1);
    if (previous?.phase === "PREP" && m.phase !== "PREP") {
      const prep = w.prep.find((x) => x.round === previous.round);
      if (prep && !prep.exited) prep.exited = { ...at, phase: m.phase };
    }
    if (!previous || previous.phase !== m.phase || previous.round !== m.round || previous.deadlineVirtualMs !== m.deadline) {
      w.phases.push({ ...at, phase: m.phase, round: m.round, deadlineVirtualMs: m.deadline, deadlineAtMs });
    }
    if (m.phase === "PREP") {
      let prep = w.prep.find((x) => x.round === m.round);
      if (!prep) {
        prep = { round: m.round, entered: at, deadlineVirtualMs: m.deadline, deadlineAtMs, seats: m.order.filter((p) => p.alive).map((p) => ({
          seat: p.seat, playerId: p.playerId, isBot: p.isBot, aiControlled: p.botControlled, connected: p.connected, ready: null })) };
        w.prep.push(prep);
      }
      for (const p of m.order) if (p.alive && p.ready) this.recordReadyWitness(prep, p, p.playerId === readyPlayerId ? "setReady" : "observedReady", at);
    }
    const server = m.fields.filter((f) => f.mode === "server");
    for (const f of server) {
      let field = w.serverFields.find((x) => x.battleId === f.battleId);
      if (!field) {
        field = { battleId: f.battleId, fieldId: f.fieldId, round: m.round, kind: f.kind, observed: at, calculationFinished: null, resultDone: null };
        w.serverFields.push(field);
      }
      field.last = { ...at, job: !!f.job, battleFinished: !!f.battle?.finished, resultDone: !!f.done, endGt: f.endGt ?? null };
      if (!field.calculationFinished && !f.job && f.battle?.finished) field.calculationFinished = at;
      if (!field.resultDone && f.done) field.resultDone = at;
    }
    if (server.length) {
      const ids = server.map((f) => f.battleId).sort();
      const key = ids.join(",");
      let batch = w.serverBatches.find((x) => x.key === key);
      if (!batch) {
        batch = { key, round: m.round, phase: m.phase, fields: ids, observed: at, calculationFinished: null, resultsDone: null };
        w.serverBatches.push(batch);
      }
      if (!batch.calculationFinished && server.every((f) => !f.job && f.battle?.finished)) batch.calculationFinished = at;
      if (!batch.resultsDone && server.every((f) => f.done)) batch.resultsDone = at;
    }
  }
  metrics() {
    const m = this.benchMatch(), b = this.baseline || {};
    const workload = m && { stageId: m.stageId, round: m.round, players: m.order.map((p) => ({ input: p.battleInput(), alive: p.alive, lp: p.lp, funds: p.funds, level: p.shop.level, hand: p.hand, temp: p.temp, layers: p.layers })) };
    const fingerprint = workload && createHash("sha256").update(JSON.stringify(workload)).digest("hex");
    return { phase: m?.phase, round: m?.round, deadline: m?.deadline, soloUntimed: m?.soloUntimed, events: m?.recording?.events.length, eventCalls: (this.eventCalls || 0) - (b.eventCalls || 0), transactions: (this.transactions || 0) - (b.transactions || 0), rows: (this.rows || 0) - (b.rows || 0), matchEvents: (m?.recording?.events.length || 0) - (b.events || 0), engineErrors: m?.errorCount, alive: m?.order.filter((p) => p.alive).length, units: m?.order.map((p) => p.deployCount), workloadFingerprint: fingerprint, workSlice: m?.recording?.options?.workSlice ?? m?.workSlice ?? null, verify: m?.verifyStats, steps: steps.n, traceSeq: this.trace?.open?.rec.seq ?? null, witness: this.witness, fields: m?.fields.map((f) => ({ kind: f.kind, mode: f.mode, done: f.done, time: f.battle?.time, finished: f.battle?.finished, endGt: f.endGt, job: !!f.job, authority: f.authority })) };
  }
}
var stdin_default = { async fetch(req, env) {
  const u = new URL(req.url), code = u.searchParams.get("room") || "ABCD", stub = env.TEST.get(env.TEST.idFromName(code));
  if (req.headers.get("Upgrade") === "websocket") {
    const i = Number(u.searchParams.get("seat"));
    return stub.fetch(new Request("https://room.internal/_ws?room=" + code, { headers: { Upgrade: "websocket", "X-Account-ID": "a" + i, "X-Account-Name": "P" + i, "X-Room-IP": "127.0.0." + (i + 1) } }));
  }
  return stub.fetch(new Request("https://room.internal" + u.pathname, { method: "POST", body: await req.text() }));
} };
export {
  TestObject,
  stdin_default as default
};
`);
  await bundleWorker({ root, entry: path.relative(root, entry), outfile: bundle });
  const ds = getDefaultSource(), results = [];
  let rid = 1e3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Nearest-rank percentiles; every latency summary keeps its tail (p99, max) next to the mean.
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  const summarize = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    if (!s.length) return { n: 0, mean: null, p50: null, p95: null, p99: null, max: null, over50: 0, over100: 0, over250: 0 };
    return { n: s.length, mean: s.reduce((a, x) => a + x, 0) / s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s.at(-1), over50: s.filter((x) => x > 50).length, over100: s.filter((x) => x > 100).length, over250: s.filter((x) => x > 250).length };
  };
  // Per-DO-event distributions. The counts (steps, log rows) are deterministic for a given event sequence; the
  // durations and spacing are wall time.
  const distribution = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length ? { n: s.length, total: s.reduce((a, x) => a + x, 0), mean: s.reduce((a, x) => a + x, 0) / s.length, p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99), max: s.at(-1) } : { n: 0, total: 0, mean: null, p50: null, p90: null, p99: null, max: null };
  };
  const groupBy = (xs, key, value = (x) => x.ms) => {
    const groups = new Map();
    for (const x of xs) {
      const k = key(x);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(value(x));
    }
    return Object.fromEntries([...groups].map(([k, v]) => [k, summarize(v)]));
  };
  const phaseLabel = (e) => e.phase === e.endPhase ? String(e.phase) : e.phase + ">" + e.endPhase;
  const serverLabel = (x) => x.server ? x.server.phase : "unmatched";
  const blockingLabel = (x) => {
    if (!x.server) return "unmatched";
    const n = x.server.ticks + x.server.queuedTicks;
    return n === 0 ? "0 steps" : n <= 128 ? "1-128 steps" : n <= 512 ? "129-512 steps" : ">512 steps";
  };
  // Label each sample by the server event that handled its input. Events that began after the sample was sent and
  // before its own were run first: it queued behind them (inFlight began before the send and may still have run).
  function labelSamples(samples, events, originUnixMs) {
    const handled = new Map();
    events.forEach((e, i) => {
      for (const key of e.inputs) handled.set(key, i);
    });
    return samples.map((x) => {
      const i = handled.get(x.key);
      if (i == null) return { ...x, server: null };
      const e = events[i], sentAtMs = x.sentUnixMs - originUnixMs;
      let j = i - 1, queued = 0, queuedTicks = 0;
      for (; j >= 0 && events[j].atMs >= sentAtMs; j--) {
        queued++;
        queuedTicks += events[j].ticks;
      }
      return { ...x, server: { seq: e.seq, phase: phaseLabel(e), round: e.round, atMs: e.atMs, waitMs: e.atMs - sentAtMs, workMs: e.workMs, commitMs: e.commitMs, ticks: e.ticks, ticksBeforeInput: e.ticksBeforeInput, budgetUsed: e.budgetUsed, logRows: e.logRows, queued, queuedTicks, inFlightTicks: j >= 0 ? events[j].ticks : 0 } };
    });
  }
  function serverSummary(events) {
    const work = events.filter((e) => e.ticks > 0 || e.budgetUsed > 0);
    const byPhase = new Map();
    for (const e of events) {
      const k = phaseLabel(e);
      if (!byPhase.has(k)) byPhase.set(k, []);
      byPhase.get(k).push(e);
    }
    const spacing = events.slice(1).map((e, i) => e.atMs - events[i].atMs);
    return {
      events: events.length, workEvents: work.length, inputEvents: events.filter((e) => e.inputs.length).length, failedEvents: events.filter((e) => e.failed).length,
      // Steps per event: the work one event ran before its commit (and before every input queued behind it).
      ticks: distribution(events.map((e) => e.ticks)), workEventTicks: distribution(work.map((e) => e.ticks)),
      budgetUsed: events.some((e) => e.budgetUsed != null) ? distribution(events.map((e) => e.budgetUsed ?? 0)) : null,
      logRows: distribution(events.map((e) => e.logRows)), sqlRows: distribution(events.map((e) => e.sqlRows ?? 0)),
      // Durations on the local Worker clock; spacing is begin to begin (idle gaps included).
      workMs: distribution(events.filter((e) => e.workMs != null).map((e) => e.workMs)), commitMs: distribution(events.filter((e) => e.commitMs != null).map((e) => e.commitMs)),
      spacingMs: distribution(spacing),
      slowest: events.filter((e) => e.workMs != null).sort((a, b) => b.workMs + (b.commitMs ?? 0) - a.workMs - (a.commitMs ?? 0)).slice(0, 5)
        .map((e) => ({ seq: e.seq, atMs: e.atMs, phase: phaseLabel(e), round: e.round, workMs: e.workMs, commitMs: e.commitMs, ticks: e.ticks, logRows: e.logRows, inputs: e.inputs.length, fetch: e.fetch })),
      byPhase: Object.fromEntries([...byPhase].map(([k, xs]) => [k, { events: xs.length, workEvents: xs.filter((e) => e.ticks > 0 || e.budgetUsed > 0).length, ticks: distribution(xs.map((e) => e.ticks)), logRows: distribution(xs.map((e) => e.logRows)) }])),
    };
  }
  // "Last connected human ready -> PREP end" for every PREP whose humans (not autoplaying at its start) all readied
  // themselves before it ended. A PREP that the deadline ended first reports byDeadline instead of a wait.
  function humanWaits(witness, events) {
    return (witness?.prep || []).map((prep) => {
      const humans = prep.seats.filter((s) => !s.isBot && !s.aiControlled && s.connected !== false);
      if (!humans.length || !prep.exited) return null;
      const entry = { round: prep.round, deadlineVirtualMs: prep.deadlineVirtualMs, prepMs: prep.exited.atMs - prep.entered.atMs, aiReadyAfterEntryMs: prep.allAiReady ? prep.allAiReady.atMs - prep.entered.atMs : null };
      if (humans.some((s) => !s.ready || s.ready.source === "forcedAtPrepEnd")) return { ...entry, byDeadline: true };
      const last = humans.map((s) => s.ready).reduce((a, x) => x.atMs > a.atMs ? x : a);
      return { ...entry, humansReadyAfterEntryMs: last.atMs - prep.entered.atMs, waitMs: prep.exited.atMs - last.atMs, virtualWaitMs: prep.exited.virtualAtMs - last.virtualAtMs,
        eventsAfterReady: events.filter((e) => e.atMs >= last.atMs && e.atMs <= prep.exited.atMs).length, byDeadline: false };
    }).filter(Boolean);
  }
  function printReport(r) {
    const f = (x) => x == null ? "-" : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1);
    const cols = ["n", "mean", "p50", "p95", "p99", "max", ">50", ">100"];
    const row = (name, s) => name.padEnd(36) + [String(s.n), f(s.mean), f(s.p50), f(s.p95), f(s.p99), f(s.max), String(s.over50), String(s.over100)].map((v) => v.padStart(8)).join("");
    const counts = (d) => d ? "mean " + f(d.mean) + " p50 " + f(d.p50) + " p90 " + f(d.p90) + " p99 " + f(d.p99) + " max " + f(d.max) : "-";
    const s = r.server, lines = [];
    lines.push("== " + r.config + " (" + r.seats + " seats, " + r.humans + " connected human" + (r.humans > 1 ? "s" : "") + ", " + (r.manual ? "ready +" + r.readyAfterMs + " ms" : "autoplay") + ") R" + r.setupRound + " seed " + r.seed + ": window " + r.durationMs + " ms, wall " + Math.round(r.wallMs) + " ms");
    lines.push("server events " + s.events + " (with work " + s.workEvents + ", inputs " + s.inputEvents + ", failed " + s.failedEvents + "); work allowance used/event " + counts(s.budgetUsed));
    lines.push("  steps/event " + counts(s.ticks) + "; total " + s.ticks.total);
    lines.push("  match log rows/event " + counts(s.logRows) + "; total " + s.logRows.total + "; SQL rows " + s.sqlRows.total);
    lines.push("  event work ms " + counts(s.workMs) + "; commit ms " + counts(s.commitMs) + "; spacing ms " + counts(s.spacingMs));
    for (const e of s.slowest.slice(0, 3)) lines.push("  slow event #" + e.seq + " at " + e.atMs + " ms " + e.phase + " R" + e.round + ": work " + e.workMs + " + commit " + e.commitMs + " ms, " + e.ticks + " steps, " + e.logRows + " log rows" + (e.fetch ? ", " + e.fetch : e.inputs ? ", " + e.inputs + " inputs" : ""));
    lines.push("latency (ms)".padEnd(36) + cols.map((v) => v.padStart(8)).join(""));
    lines.push(row("ping main", r.main.ping));
    for (const [k, v] of Object.entries(r.main.pingByServerPhase)) lines.push(row("  server " + k, v));
    for (const [k, v] of Object.entries(r.main.pingByBlockingTicks)) lines.push(row("  behind " + k, v));
    lines.push(row("  send -> its event start", r.main.pingQueueWaitMs));
    lines.push(row("ping light room", r.probe.ping));
    lines.push(row("ping main - light (paired)", r.paired.mainMinusProbe));
    for (const [k, v] of Object.entries(r.paired.byServerPhase)) lines.push(row("  server " + k, v));
    lines.push(row("op main", r.main.op));
    for (const [k, v] of Object.entries(r.main.opByServerPhase)) lines.push(row("  server " + k, v));
    lines.push(row("op light room", r.probe.op));
    lines.push("paired pings over 50 ms: both " + r.paired.bothOver50 + ", main only " + r.paired.mainOnlyOver50 + ", light only " + r.paired.probeOnlyOver50 + " (of " + r.paired.n + ")");
    for (const w of r.humanWait) {
      lines.push("PREP R" + w.round + ": " + (w.byDeadline ? "ended by its deadline before every human readied" : "last human ready -> PREP end " + Math.round(w.waitMs) + " ms (virtual " + Math.round(w.virtualWaitMs) + " ms, " + w.eventsAfterReady + " DO events)") + "; PREP " + Math.round(w.prepMs) + " ms; all AI ready at +" + (w.aiReadyAfterEntryMs == null ? "-" : Math.round(w.aiReadyAfterEntryMs)) + " ms");
    }
    const m = r.main;
    if (m.pending || m.rejected.length || m.closed.length || m.simErrors.length || r.probe.pending || r.probe.rejected.length) lines.push("pending " + m.pending + "/" + r.probe.pending + ", rejected " + JSON.stringify(m.rejected) + "/" + JSON.stringify(r.probe.rejected) + ", closed " + m.closed.length + ", SimClient errors " + m.simErrors.length);
    console.log(lines.join("\n"));
  }
  for (const { config, readyAfterMs } of runs) {
    let send = function(p, msg, kind, pair = null) {
      if (p.closed) return;
      if (kind === "ping") {
        msg.c = ++rid;
        p.pending.set("p" + msg.c, performance.now());
        p.pingTypes.set(msg.c, { key: "p" + msg.c, pair, sentUnixMs: Date.now(), clientPhase: p.phase, clientRound: p.round });
      }
      if (kind === "op") {
        msg.rid = ++rid;
        p.pending.set("o" + msg.rid, performance.now());
        p.operationTypes.set(msg.rid, { key: "o" + msg.rid, type: msg.t, sentUnixMs: Date.now(), clientPhase: p.phase, clientRound: p.round });
      }
      p.ws.send(JSON.stringify(msg));
    };
    const { seats, humans, manual } = scenario(config);
    const h = await createAccountHarness(`export {default,TestObject} from ${JSON.stringify(bundle.replaceAll("\\", "/"))};`);
    const sockets = [], clients = [], readyTimers = new Set();
    let interval, opInterval, probeOpInterval;
    const api = async (code, name, body = {}) => {
      const r = await h.request("https://test.example/bench/" + name + "?room=" + code, { method: "POST", body: JSON.stringify(body) });
      const s = await r.text();
      if (r.status !== 200) throw new Error(s);
      return JSON.parse(s);
    };
    async function connect(code, seat) {
      const r = await h.request("https://test.example/ws?room=" + code + "&seat=" + seat, { headers: { Upgrade: "websocket" } });
      assert.equal(r.status, 101);
      const ws = r.webSocket;
      ws.accept();
      const p = { ws, code, seat, frames: [], pending: /* @__PURE__ */ new Map(), pingTypes: new Map(), pingSamples: [], operationTypes: new Map(), operationSamples: [], phaseEvents: [], rtts: [], ops: [], rejected: [], phase: "LOBBY", lastReady: null, simErrors: [] };
      sockets.push(p);
      ws.addEventListener("message", (e) => {
        const f = JSON.parse(e.data);
        p.frames.push(f);
        if (f.t === "m.public") {
          if (p.phase !== f.phase || p.round !== f.round) p.phaseEvents.push({ phase: f.phase, round: f.round, deadline: f.deadline, at: performance.now() });
          p.phase = f.phase;
          p.round = f.round;
          if (manual && code === "ABCD" && f.phase === "PREP" && p.lastReady !== f.round) {
            p.lastReady = f.round;
            const timer = setTimeout(() => {
              readyTimers.delete(timer);
              send(p, { t: "g.ready", ready: true }, "op");
            }, readyAfterMs);
            readyTimers.add(timer);
          }
        }
        if (f.t === "pong" && p.pending.has("p" + f.c)) {
          const x = p.pending.get("p" + f.c);
          p.pending.delete("p" + f.c);
          const ms = performance.now() - x;
          p.rtts.push(ms);
          p.pingSamples.push({ ...p.pingTypes.get(f.c), ms, seat: p.seat });
          p.pingTypes.delete(f.c);
        }
        if ((f.t === "ok" || f.t === "error") && p.pending.has("o" + f.rid)) {
          const x = p.pending.get("o" + f.rid);
          p.pending.delete("o" + f.rid);
          const ms = performance.now() - x;
          p.ops.push(ms);
          p.operationSamples.push({ ...p.operationTypes.get(f.rid), ms, reply: f.t, error: f.code ?? null, seat: p.seat });
          p.operationTypes.delete(f.rid);
          if (f.t === "error") p.rejected.push(f.code);
        }
        if (p.sc) try {
          p.sc.onMessage(f);
        } catch (e2) {
          p.simErrors.push(String(e2));
        }
      });
      ws.addEventListener("close", (e) => p.closed = { code: e.code, reason: e.reason });
      send(p, { t: "hello", name: "P" + seat, token: code + "." + (seat + 1).toString(16).padStart(32, "0") });
      for (let i = 0; i < 250 && !p.frames.some((f) => f.t === "welcome"); i++) await sleep(10);
      assert.ok(p.frames.some((f) => f.t === "welcome"), "welcome");
      return p;
    }
    try {
      await api("ABCD", "init", { code: "ABCD", seats, humans });
      for (let i = 0; i < humans; i++) {
        const p = await connect("ABCD", i);
        p.sc = new SimClient("p" + i, { ds, pace: "paced", speed: 2, send: (msg) => send(p, msg), setTimeout, clearTimeout });
        clients.push(p.sc);
      }
      await api("WXYZ", "init", { code: "WXYZ", seats: 4, humans: 1 });
      const probe = await connect("WXYZ", 0);
      const setupStart = performance.now();
      await api("ABCD", "prepare", { manual });
      const setupMs = performance.now() - setupStart;
      const before = await api("ABCD", "metrics");
      const probeBefore = await api("WXYZ", "metrics");
      if (config === "ai8timed") assert.equal(before.soloUntimed, false, "ai8timed must retain multiplayer phase deadlines");
      if (humans === 1) assert.equal(before.soloUntimed, true, config + " must be a single-human room without prep deadlines");
      if (options.prepareOnly) {
        const result = { tag, root, config, seats, humans, manual, seed, setupRound, setupMs, readyAfterMs, prepareOnly: true, before };
        results.push(result);
        await fs.writeFile(path.join(output, tag + "-results.json"), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(result));
        continue;
      }
      for (const p of sockets) {
        p.rtts = [];
        p.pingSamples = [];
        p.pingTypes.clear();
        p.ops = [];
        p.operationSamples = [];
        p.operationTypes.clear();
        p.phaseEvents = [];
        p.rejected = [];
        p.pending.clear();
      }
      let pingIndex = 0, opIndex = 0, ready = false;
      const started = performance.now();
      const measurementStartedAtUnixMs = Date.now();
      interval = setInterval(() => {
        const pair = pingIndex;
        send(sockets[pingIndex++ % humans], { t: "ping" }, "ping", pair);
        send(probe, { t: "ping" }, "ping", pair);
      }, 50);
      opInterval = setInterval(() => {
        const p = sockets[opIndex++ % humans];
        if (["ROUND_START", "SP_DRAFT", "PREP"].includes(p.phase)) send(p, { t: "g.unitStats", seq: rid }, "op");
      }, 250);
      probeOpInterval = setInterval(() => {
        ready = !ready;
        send(probe, { t: "room.ready", ready }, "op");
      }, 500);
      await sleep(durationMs);
      clearInterval(interval);
      clearInterval(opInterval);
      clearInterval(probeOpInterval);
      await sleep(750);
      const after = await api("ABCD", "metrics"), probeAfter = await api("WXYZ", "metrics");
      const wallMs = performance.now() - started;
      const trace = await api("ABCD", "trace", { after: before.traceSeq, before: after.traceSeq });
      const events = trace.events;
      const main = sockets.filter((p) => p.code === "ABCD");
      const mainPings = labelSamples(main.flatMap((p) => p.pingSamples), events, trace.originUnixMs);
      const mainOps = labelSamples(main.flatMap((p) => p.operationSamples), events, trace.originUnixMs);
      const probePairs = new Map(probe.pingSamples.map((x) => [x.pair, x]));
      const pairs = mainPings.filter((x) => probePairs.has(x.pair)).map((x) => ({ main: x, probe: probePairs.get(x.pair) }));
      const paired = { n: pairs.length, note: "Main and light pings sent by the same callback; diff = main - light. Both slow: the shared workerd process. Main only: queueing in the main room.",
        main: summarize(pairs.map((x) => x.main.ms)), probe: summarize(pairs.map((x) => x.probe.ms)), mainMinusProbe: summarize(pairs.map((x) => x.main.ms - x.probe.ms)),
        byServerPhase: groupBy(pairs, (x) => serverLabel(x.main), (x) => x.main.ms - x.probe.ms),
        bothOver50: pairs.filter((x) => x.main.ms > 50 && x.probe.ms > 50).length, mainOnlyOver50: pairs.filter((x) => x.main.ms > 50 && x.probe.ms <= 50).length, probeOnlyOver50: pairs.filter((x) => x.main.ms <= 50 && x.probe.ms > 50).length };
      const result = { tag, root, config, seats, humans, manual, seed, setupRound, durationMs, readyAfterMs, setupMs, wallMs, measurementStartedAtUnixMs, before, after, clientPhaseTimeline: main[0].phaseEvents.filter((x) => x.at >= started).map(({ at, ...x }) => ({ ...x, ms: at - started })), delta: { eventCalls: after.eventCalls - before.eventCalls, transactions: after.transactions - before.transactions, rows: after.rows - before.rows, matchEvents: after.matchEvents - before.matchEvents }, counterBoundaryNote: "Before/after metrics run production events; counters can include about one sampling event boundary. The server trace excludes both requests.",
        labelNote: "Samples are labelled by the server event that handled them (phase at its start > after its work); 'behind N steps' counts that event's Battle steps plus those of the events it queued behind.",
        server: serverSummary(events), humanWait: humanWaits(after.witness, events), paired,
        main: { ping: summarize(mainPings.map((x) => x.ms)), pingByServerPhase: groupBy(mainPings, serverLabel), pingByBlockingTicks: groupBy(mainPings, blockingLabel), pingQueueWaitMs: summarize(mainPings.filter((x) => x.server).map((x) => x.server.waitMs)), pingByClientPhase: groupBy(mainPings, (x) => x.clientPhase), op: summarize(mainOps.map((x) => x.ms)), opByServerPhase: groupBy(mainOps, serverLabel), opByClientPhase: groupBy(mainOps, (x) => x.clientPhase), pending: main.reduce((n, p) => n + p.pending.size, 0), rejected: main.flatMap((p) => p.rejected), closed: main.map((p) => p.closed).filter(Boolean), simErrors: main.flatMap((p) => p.simErrors) },
        probe: { ping: summarize(probe.rtts), op: summarize(probe.ops), pending: probe.pending.size, rejected: probe.rejected, eventCalls: probeAfter.eventCalls - probeBefore.eventCalls, transactions: probeAfter.transactions - probeBefore.transactions },
        raw: { mainPingSamples: mainPings, mainOperationSamples: mainOps, probePingSamples: probe.pingSamples, probeOperationSamples: probe.operationSamples, serverEvents: events } };
      results.push(result);
      await fs.writeFile(path.join(output, tag + "-results.json"), JSON.stringify(results, null, 2));
      const { raw, ...printed } = result;
      console.log(JSON.stringify(printed));
      printReport(result);
    } finally {
      clearInterval(interval);
      clearInterval(opInterval);
      clearInterval(probeOpInterval);
      for (const timer of readyTimers) clearTimeout(timer);
      for (const c of clients) c.close();
      for (const p of sockets) try {
        p.ws.close(1e3, "done");
      } catch {
      }
      await h.dispose();
    }
  }
} finally {
  if (path.dirname(path.resolve(dir)) !== tempRoot || !path.basename(dir).startsWith("sp-scheduling-bench-")) throw new Error("Unexpected temporary directory");
  await fs.rm(dir, { recursive: true, force: true });
}
