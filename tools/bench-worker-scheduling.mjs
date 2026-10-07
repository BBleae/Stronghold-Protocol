#!/usr/bin/env node
// Local workerd benchmark for RoomDO scheduling. Never sends requests to a deployed Worker.
//
// Usage:
//   node tools/bench-worker-scheduling.mjs --tag before --output .cache/scheduling-bench
//   node tools/bench-worker-scheduling.mjs --root /path/to/other/checkout --tag after --output /same/output
//   node tools/bench-worker-scheduling.mjs --configs ai8,human8 --duration-ms 14000 --round 11 --seed 17
//   node tools/bench-worker-scheduling.mjs --configs ai8timed,mixed8 --duration-ms 140000 --ready-after-ms 120000
//   node tools/bench-worker-scheduling.mjs --root /baseline/checkout --prepare-only --tag baseline-lineups
//
// Scenarios: ai4/ai8 = one connected human on autoplay plus 3/7 AI seats (4/8 AI-controlled seats);
// human8 = eight connected humans, autoplay disabled in the measured window;
// mixed8 = four connected humans with autoplay disabled plus four AI seats.
// ai8timed = eight connected human protocol seats on autoplay: eight AI preparation jobs with the real
// multiplayer prep deadline. Their combat fields run on the eight SimClients, not as server AI fields.
// Preparation uses the same seed and autoplay to reach the requested round with non-empty lineups.
// Fixed work slicing is disabled only during preparation, then restored for the measured window.
// The preparation log is NOT a valid recovery fixture; recovery is covered by separate engine tests.
// --prepare-only records initial workload fingerprints without generating measured traffic.
// It is excluded from RTT measurements. SimClients then run real, paced client battles and submit
// progress through WebSockets. They do not make AI decisions in the human/mixed measured window.
//
// Production RoomDO event(), its two pump() calls, timers, save(), SQLite/KV storage and socket flush
// remain intact. Only local fixture account provisioning and the clock origin are adapted; external
// account/listing/archive background jobs are disabled. A second room receives ping/ready traffic
// concurrently. Both rooms share one local workerd process: this does not measure production isolate
// placement, network latency, client rendering, or total CPU. The test reports elapsed measurement
// wall time and actual progress instead of treating fast request replies as proof that work completed.
//
// Every 50ms: timestamp ping to each room (main room rotates human sockets).
// Every 250ms: unitStats while the last client-visible phase allows it; manual humans ready after
// --ready-after-ms (default 1200). This delay is relative to each client's first PREP message per round.
// Every 500ms: ready toggle in the independent lobby room. A queued operation can cross a phase
// boundary; WRONG_PHASE replies are retained, together with pending replies and closed sockets.
//
// Output: <output>/<tag>-results.json includes RTT p50/p95/max, raw samples, pending/errors,
// initial/final lineups, phases, match events, transactions and SQL append counts. Each completed
// scenario also records fixture-only witnesses at existing pump/ready/phase-end boundaries: each
// seat's natural/forced ready time and deadline margin, and server calculation finished vs result done.
// Witness times use the local Worker clock and are event-boundary observations, not a CPU profiler.
// No additional sampling requests are sent. The before/after metrics requests themselves run normal
// production events: transaction/event deltas can differ by about one boundary sampling event.
// A short duration does not validate a full prep deadline; use up to 180000ms for complete windows.
// Preparation can end early when all seats ready; the tool does not keep them artificially unready.
// Each completed
// scenario is saved immediately. Compare identical configs/seed/round/duration on the same idle host;
// run only one benchmark/test process at a time. Small samples do not establish a production p95.
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
    console.log("Usage: node tools/bench-worker-scheduling.mjs [--root DIR] [--tag LABEL] [--output DIR] [--configs ai4,ai8,ai8timed,human8,mixed8] [--duration-ms 14000 (4000..180000)] [--ready-after-ms 1200 (0..180000)] [--round 11] [--seed 17] [--prepare-only]");
    process.exit(0);
  }
  if (!["--root", "--tag", "--output", "--configs", "--duration-ms", "--ready-after-ms", "--round", "--seed"].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error("Unknown or incomplete option: " + arg);
  options[arg.slice(2)] = process.argv[++i];
}
const root = path.resolve(options.root || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const tag = options.tag || "run";
if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error("--tag must contain only letters, numbers, underscore or hyphen");
const configs = (options.configs || "ai4,ai8,human8,mixed8").split(",");
if (!configs.length || configs.some((c) => !["ai4", "ai8", "ai8timed", "human8", "mixed8"].includes(c))) throw new Error("Unknown --configs scenario");
const durationMs = Number(options["duration-ms"] || 14e3), setupRound = Number(options.round || 11), seed = Number(options.seed || 17);
const readyAfterMs = Number(options["ready-after-ms"] ?? 1200);
if (!Number.isInteger(durationMs) || durationMs < 4e3 || durationMs > 18e4) throw new Error("--duration-ms must be 4000..180000");
if (!Number.isInteger(readyAfterMs) || readyAfterMs < 0 || readyAfterMs > 18e4) throw new Error("--ready-after-ms must be 0..180000");
if (!Number.isInteger(setupRound) || setupRound < 2 || setupRound > 15) throw new Error("--round must be 2..15");
if (!Number.isInteger(seed) || seed < 1 || seed > 4294967295) throw new Error("--seed must be 1..4294967295");
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
import { createHash } from "node:crypto";
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
  async route(req) {
    const u = new URL(req.url), rt = this.runtime;
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
      m.workSlice = measuredWorkSlice;
      this.clockOffset = m.sched.now() - Date.now();
      m._wallNow = () => Date.now() + this.clockOffset;
      this.installWitness(m);
      const pump = rt.pump.bind(rt), due = rt.timerDue.bind(rt);
      rt.pump = (now = Date.now(), workBudget) => {
        const result = pump(now + this.clockOffset, workBudget);
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
  witnessTime() {
    const m = this.runtime.lobby.getRoom(this.runtime.code)?.match;
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
    const w = this.witness, m = this.runtime.lobby.getRoom(this.runtime.code)?.match;
    if (!w || !m) return;
    const at = this.witnessTime();
    const deadlineAtMs = m.deadline > 0 ? m.deadline - this.clockOffset - w.timeOriginUnixMs : null;
    const previous = w.phases.at(-1);
    if (!previous || previous.phase !== m.phase || previous.round !== m.round || previous.deadlineVirtualMs !== m.deadline) {
      w.phases.push({ ...at, phase: m.phase, round: m.round, deadlineVirtualMs: m.deadline, deadlineAtMs });
    }
    if (m.phase === "PREP") {
      let prep = w.prep.find((x) => x.round === m.round);
      if (!prep) {
        prep = { round: m.round, entered: at, deadlineVirtualMs: m.deadline, deadlineAtMs, seats: m.order.filter((p) => p.alive).map((p) => ({
          seat: p.seat, playerId: p.playerId, isBot: p.isBot, aiControlled: p.botControlled, ready: null })) };
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
    const m = this.runtime.lobby.getRoom(this.runtime.code)?.match, b = this.baseline || {};
    const workload = m && { stageId: m.stageId, round: m.round, players: m.order.map((p) => ({ input: p.battleInput(), alive: p.alive, lp: p.lp, funds: p.funds, level: p.shop.level, hand: p.hand, temp: p.temp, layers: p.layers })) };
    const fingerprint = workload && createHash("sha256").update(JSON.stringify(workload)).digest("hex");
    return { phase: m?.phase, round: m?.round, deadline: m?.deadline, soloUntimed: m?.soloUntimed, events: m?.recording?.events.length, eventCalls: (this.eventCalls || 0) - (b.eventCalls || 0), transactions: (this.transactions || 0) - (b.transactions || 0), rows: (this.rows || 0) - (b.rows || 0), matchEvents: (m?.recording?.events.length || 0) - (b.events || 0), engineErrors: m?.errorCount, alive: m?.order.filter((p) => p.alive).length, units: m?.order.map((p) => p.deployCount), workloadFingerprint: fingerprint, workSlice: m?.workSlice ?? null, verify: m?.verifyStats, witness: this.witness, fields: m?.fields.map((f) => ({ kind: f.kind, mode: f.mode, done: f.done, time: f.battle?.time, finished: f.battle?.finished, endGt: f.endGt, job: !!f.job, authority: f.authority })) };
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
  const pct = (xs, p) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)] : null;
  const summarize = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null, over50: xs.filter((x) => x > 50).length, over100: xs.filter((x) => x > 100).length, over250: xs.filter((x) => x > 250).length });
  const byPhase = (xs) => Object.fromEntries([...new Set(xs.map((x) => x.phase))].map((phase) => [phase, summarize(xs.filter((x) => x.phase === phase).map((x) => x.ms))]));
  for (const config of configs) {
    let send = function(p, msg, kind) {
      if (p.closed) return;
      if (kind === "ping") {
        msg.c = ++rid;
        p.pending.set("p" + msg.c, performance.now());
        p.pingTypes.set(msg.c, { phase: p.phase, round: p.round });
      }
      if (kind === "op") {
        msg.rid = ++rid;
        p.pending.set("o" + msg.rid, performance.now());
        p.operationTypes.set(msg.rid, { type: msg.t, phase: p.phase, round: p.round });
      }
      p.ws.send(JSON.stringify(msg));
    };
    const seats = config === "ai4" ? 4 : 8, humans = config === "ai8timed" ? 8 : config.startsWith("ai") ? 1 : config === "mixed8" ? 4 : 8, manual = !config.startsWith("ai");
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
        send(sockets[pingIndex++ % humans], { t: "ping" }, "ping");
        send(probe, { t: "ping" }, "ping");
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
      const main = sockets.filter((p) => p.code === "ABCD");
      const result = { tag, root, config, seats, humans, manual, seed, setupRound, durationMs, readyAfterMs, setupMs, wallMs, measurementStartedAtUnixMs, before, after, clientPhaseTimeline: main[0].phaseEvents.filter((x) => x.at >= started).map(({ at, ...x }) => ({ ...x, ms: at - started })), delta: { eventCalls: after.eventCalls - before.eventCalls, transactions: after.transactions - before.transactions, rows: after.rows - before.rows, matchEvents: after.matchEvents - before.matchEvents }, counterBoundaryNote: "Before/after metrics run production events; counters can include about one sampling event boundary.", main: { ping: summarize(main.flatMap((p) => p.rtts)), pingByPhase: byPhase(main.flatMap((p) => p.pingSamples)), op: summarize(main.flatMap((p) => p.ops)), opByPhase: byPhase(main.flatMap((p) => p.operationSamples)), pending: main.reduce((n, p) => n + p.pending.size, 0), rejected: main.flatMap((p) => p.rejected), closed: main.map((p) => p.closed).filter(Boolean), simErrors: main.flatMap((p) => p.simErrors) }, probe: { ping: summarize(probe.rtts), op: summarize(probe.ops), pending: probe.pending.size, rejected: probe.rejected, eventCalls: probeAfter.eventCalls - probeBefore.eventCalls, transactions: probeAfter.transactions -probeBefore.transactions }, raw: { mainPings: main.flatMap((p) => p.rtts), mainPingSamples: main.flatMap((p) => p.pingSamples), mainOps: main.flatMap((p) => p.ops), mainOperationSamples: main.flatMap((p) => p.operationSamples), probePings: probe.rtts, probePingSamples: probe.pingSamples, probeOps: probe.ops, probeOperationSamples: probe.operationSamples } };
      results.push(result);
      await fs.writeFile(path.join(output, tag + "-results.json"), JSON.stringify(results, null, 2));
      const { raw, ...printed } = result;
      console.log(JSON.stringify(printed));
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
