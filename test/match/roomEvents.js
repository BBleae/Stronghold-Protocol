// test/match/roomEvents.js — drive a RecordedMatch the way the Cloudflare room does (worker/index.js event): one event
// = pump(now, budget) → the event's inputs → pump(now, budget), sharing one work allowance `{ remaining: 1 }`. Events
// happen at the next due timer or scripted input, on a virtual clock (the match work costs no virtual time, so waits
// are lower bounds of the real ones). Humans act only through recorded inputs, so every prefix restores exactly.
//
//   const room = roomEvents(match, clock, { readyAfterMs: 1200 });
//   room.runUntil(() => match.round > 3);   room.rounds[1].waitAfterReady …
//
// Humans (non-bot seats not on autoplay): 准备就绪 in INFO_CHECK, the first band they may take in BAND_DRAFT, the first
// free card in SP_DRAFT (all after 500 ms), g.ready `readyAfterMs` (scaled) after each PREP starts. Per round:
// prepStart, readyAt (the last human's g.ready), prepEnd, waitAfterReady = prepEnd − readyAt.

export function roomEvents(match, clock, { readyAfterMs = 1200, humans = null, onEvent = null } = {}) {
  const ids = humans ?? match.order.filter((p) => !p.isBot).map((p) => p.playerId);
  const actions = [];
  const queued = new Set();
  const rounds = {};
  let lastPhase = null;
  let events = 0;
  const act = (key, at, fn) => {
    if (queued.has(key)) return;
    queued.add(key);
    actions.push({ at, fn });
    actions.sort((a, b) => a.at - b.at);
  };
  const plan = () => {
    const m = match;
    if (m.phase === 'PREP' && lastPhase !== 'PREP') {
      const r = (rounds[m.round] = { prepStart: m.sched.now(), readyAt: null, prepEnd: null, waitAfterReady: null });
      for (const pid of ids) {
        act(`ready:${m.round}:${pid}`, r.prepStart + m.scaled(readyAfterMs), () => {
          const ps = m.players.get(pid);
          if (m.phase !== 'PREP' || !ps.alive || ps.ready || ps.botControlled || !ps.connected) return;
          m.handle(pid, { t: 'g.ready', ready: true });
          if (ps.ready) r.readyAt = m.sched.now();
        });
      }
    }
    if (lastPhase === 'PREP' && m.phase !== 'PREP') {
      const r = rounds[m.round];
      if (r && r.prepEnd == null) {
        r.prepEnd = m.sched.now();
        if (r.readyAt != null) r.waitAfterReady = r.prepEnd - r.readyAt;
      }
    }
    for (const pid of ids) {
      const ps = m.players.get(pid);
      if (!ps || ps.botControlled || !ps.connected) continue;
      const soon = m.sched.now() + 500;
      if (m.phase === 'INFO_CHECK' && !ps.infoReady)
        act(`info:${pid}`, soon, () => { if (m.phase === 'INFO_CHECK') m.handle(pid, { t: 'g.infoReady' }); });
      if (m.phase === 'BAND_DRAFT' && m.draftTurn() === pid)
        act(`band:${pid}`, soon, () => {
          for (const bandId of m.gd.bandIds()) {
            if (m.phase !== 'BAND_DRAFT' || m.draftTurn() !== pid) return;
            m.handle(pid, { t: 'g.band', bandId });
          }
        });
      if (m.phase === 'SP_DRAFT' && m.sp && m.spTurn() === pid)
        act(`sp:${m.round}:${pid}`, soon, () => {
          if (m.phase !== 'SP_DRAFT' || m.spTurn() !== pid) return;
          const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
          if (idx != null) m.handle(pid, { t: 'g.choice', idx });
        });
    }
    lastPhase = m.phase;
  };
  /** One room event at the next due timer or input; false when nothing is due anymore. */
  const step = () => {
    plan();
    const next = match.sched.nextAt();
    const at = Math.min(next ?? Infinity, actions.length ? actions[0].at : Infinity);
    if (at === Infinity || match.ended) return false;
    clock.now = Math.max(clock.now, at);
    const budget = { remaining: 1 };
    const rows = match.recording.events.length;
    match.pump(clock.now, 100, budget);
    while (actions.length && actions[0].at <= clock.now) actions.shift().fn();
    match.pump(clock.now, 100, budget);
    events++;
    onEvent?.({ budget, rows: match.recording.events.length - rows, phase: match.phase, round: match.round });
    plan();
    return true;
  };
  const runUntil = (done, max = 200000) => {
    for (let n = 0; n < max && !done(); n++) if (!step()) return false;
    return done();
  };
  return { step, runUntil, rounds, get events() { return events; } };
}
