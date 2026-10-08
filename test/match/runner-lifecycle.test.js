import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { makeBattle } from '../helpers/battleHarness.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Real empty battles keep the lifecycle checks cheap; only loading, RAF and transport are controlled.
function rig({ loading = false, kind = 'normal', accountMode = false } = {}) {
  let now = 1000, seq = 0, release;
  const frames = new Map(), intervals = new Map(), handlers = new Map(), created = [], starts = new Set();
  const gate = loading ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const net = {
    sent: [], accountMode,
    on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
    send(type, msg) { this.sent.push({ t: type, ...msg }); return true; },
    request(type, msg) { this.sent.push({ t: type, ...msg }); return Promise.resolve({ t: 'ok' }); },
  };
  const store = createStore({ ...initialState, match: { ...initialState.match, public: { phase: 'COMBAT' } } });
  const runner = createBattleRunner({
    net, store, now: () => now, doc: { hidden: false, addEventListener() {}, removeEventListener() {} },
    raf: (fn) => { const id = ++seq; frames.set(id, fn); return id; }, caf: (id) => frames.delete(id),
    setInterval: (fn) => { const id = ++seq; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    loadSim: async () => {
      await gate;
      return { ds: null, spec: { ...specMod, createBattleFromSpec(value) {
        const b = makeBattle({ kind, fieldId: value.fieldId, content: 'none', timeLimit: 120,
          sharedBoss: kind === 'boss' ? new specMod.LocalBossPool(100, 100) : null }).battle;
        created.push(b);
        return b;
      } } };
    },
  });
  const start = (id = 'own', extra = {}) => {
    const pending = runner.onStart({ battleId: id, fieldId: id, kind,
      authoritative: id === 'own', watch: id !== 'own', elapsed: 40, speed: 2,
      spec: { battleId: id, fieldId: id, kind, players: [{ playerId: 'p1' }] }, ...extra });
    starts.add(pending);
    pending.then(() => starts.delete(pending), () => starts.delete(pending));
    return pending;
  };
  return { runner, store, net, created, frames, intervals, start,
    release: () => release?.(),
    event: (type, msg) => handlers.get(type)?.({ t: type, ...msg }),
    async frame(ms = 0) { now += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(now); await settle(); },
    async finish() { release?.(); for (let i = 0; i < 100 && starts.size; i++) await this.frame(); assert.equal(starts.size, 0, 'all start continuations settled'); },
  };
}

for (const loading of [false, true]) for (const action of ['PREP', 'leave', 'dispose']) {
  test(`${action} invalidates a battle awaiting ${loading ? 'engine loading' : 'a preparation frame'}`, async () => {
    const r = rig({ loading });
    try {
      const pending = r.start();
      await settle();
      if (!loading) await r.frame(); // silent preparation now shares the runner's scheduled work budget
      if (!loading) assert.ok(r.created[0].tickCount > 0, 'the battle is partway through preparation');
      if (action === 'dispose') r.runner.dispose();
      else r.store.patch('match', { public: action === 'leave' ? null : { phase: action } });
      const sent = r.net.sent.length;
      r.release();
      await r.frame();
      await pending;
      await r.frame(1000);
      assert.equal(r.runner._entries.size, 0, 'an invalidated battle must not return');
      assert.equal(r.net.sent.length, sent, 'nothing is reported after its lifecycle ended');
      assert.equal(r.frames.size, 0, 'no preparation or simulation RAF survives');
      assert.equal(r.intervals.size, 0, 'no hidden-tab pump survives');
    } finally { r.runner.dispose(); }
  });
}

for (const loading of [false, true]) {
  test(`watching another field retains own authority during ${loading ? 'engine loading' : 'preparation'}`, async () => {
    const r = rig({ loading });
    try {
      const own = r.start(); await settle();
      const watch = r.start('watched', { elapsed: 0 });
      r.release(); await settle(); await r.finish(); await own; await watch;
      assert.equal(r.runner.state().battleId, 'watched');
      assert.equal(r.runner._entries.get('own')?.authoritative, true);
      const before = r.runner._entries.get('own').battle.tickCount;
      await r.frame(1000);
      assert.ok(r.runner._entries.get('own').battle.tickCount > before, 'off-screen authority continues');
    } finally { r.runner.dispose(); }
  });

  for (const reason of ['takeover', 'forced']) test(`${reason} reaches a battle during ${loading ? 'engine loading' : 'preparation'}`, async () => {
    const r = rig({ loading });
    try {
      const pending = r.start(); await settle();
      r.event('b.end', { battleId: 'own', reason });
      await r.finish(); await pending;
      const e = r.runner._entries.get('own');
      assert.ok(e);
      if (reason === 'takeover') {
        assert.equal(e.authoritative, false);
        const reports = r.net.sent.length;
        await r.frame(1000);
        assert.equal(r.net.sent.length, reports, 'a taken-over client sends no further reports');
      } else {
        assert.equal(e.battle.finished, true);
        assert.equal(e.battle.reason, 'forced');
      }
    } finally { r.runner.dispose(); }
  });

  test(`pool and end retain arrival order during ${loading ? 'engine loading' : 'preparation'}`, async () => {
    const r = rig({ loading, kind: 'boss' });
    try {
      const pending = r.start(); await settle();
      r.event('b.pool', { hp: 70, acked: { own: 0 } });
      r.event('b.end', { battleId: 'own', reason: 'forced' });
      r.event('b.pool', { hp: 30, acked: { own: 0 } });
      await r.finish(); await pending;
      const e = r.runner._entries.get('own');
      assert.equal(e.battle.finished, true);
      assert.deepEqual(e.inputs.map((x) => x.kind), ['pool', 'end'], 'the post-end pool is not a live replay input');
      assert.equal(e.inputs[0].hp, 70);
      assert.equal(e.battle.sharedBoss.hp, 30, 'the latest pool still updates the displayed total');
    } finally { r.runner.dispose(); }
  });

  test(`a repeated start shares the battle still ${loading ? 'loading' : 'preparing'}`, async () => {
    const r = rig({ loading });
    try {
      const first = r.start(); await settle();
      const second = r.start('own', { authoritative: false });
      await r.finish(); await first; await second;
      assert.equal(r.created.length, 1, 'a resend must not construct and advance a second battle');
      assert.equal(r.runner._entries.get('own')?.authoritative, false, 'the latest start updates authority');
    } finally { r.runner.dispose(); }
  });
}

// Review of the worker scheduling change, item 8: an end that reached a battle still loading its engine went out as a
// complete tick-0 client replay (source client, complete) of a battle never played here.
for (const loading of [true, false]) test(`a boss b.end during ${loading ? 'engine loading sends the result alone' : 'preparation still reports the replay up to it'}`, async () => {
  const r = rig({ loading, kind: 'boss', accountMode: true });
  try {
    let ownDone = null;
    r.runner.on('ownDone', (m) => { ownDone = m; });
    const pending = r.start(); await settle();
    if (!loading) await r.frame(16); // a first batch of the catch-up
    const ticks = r.created[0]?.tickCount ?? 0;
    assert.equal(ticks > 0, !loading);
    let lost = loading;
    if (loading) {
      // the first try is lost with the socket: the next session sends the result again, still alone
      r.net.request = function (type, msg) { this.sent.push({ t: type, ...msg }); if (!lost) return Promise.resolve({ t: 'ok' }); lost = false; return Promise.reject(Object.assign(new Error('gone'), { code: 'DISCONNECTED' })); };
    }
    r.event('b.end', { battleId: 'own', reason: 'cleared' });
    await r.finish(); await pending;
    const e = r.runner._entries.get('own');
    assert.equal(e.battle.finished, true);
    assert.equal(e.battle.tickCount, ticks, 'ended where it stood');
    assert.deepEqual(ownDone, { battleId: 'own', fieldId: 'own', late: true });
    // the first end counts (upstream R21G): a later b.end of the ended battle changes neither its reason nor its reports
    r.event('b.end', { battleId: 'own', reason: 'forced' });
    assert.equal(e.endReason, 'cleared', 'settlement() bossDown keeps reading the first end');
    if (loading) {
      r.event('welcome', {}); await settle();
      assert.deepEqual(r.net.sent.map((m) => m.t), ['b.result', 'b.result'], 'no b.progress: the server keeps its own record');
      assert.equal(r.net.sent[1].result.time, 0);
    } else {
      assert.deepEqual(r.net.sent.map((m) => m.t).slice(-2), ['b.progress', 'b.result']);
      const { replay } = r.net.sent.at(-2);
      assert.equal(replay.tick, ticks);
      assert.deepEqual(replay.inputs.at(-1), { tick: ticks, kind: 'end', reason: 'forced' }, 'the replay segment carries the end');
    }
  } finally { r.runner.dispose(); }
});

test('a superseded display preparation never overwrites the newer field', async () => {
  const r = rig({ loading: true });
  try {
    const old = r.start('old');
    const current = r.start('current', { elapsed: 0 });
    await r.finish(); await old; await current;
    assert.equal(r.runner.state().battleId, 'current');
    assert.equal(r.runner._entries.has('old'), false);
  } finally { r.runner.dispose(); }
});
