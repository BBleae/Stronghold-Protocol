// Audio manager (public/js/audio.js): BGM selection, manifest resolution, SFX limiter, the manager's never-throw
// behaviour with a fake Web Audio implementation, and which operator voice line plays when.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bgmKeyFor, resolveBgm, SfxLimiter, AudioManager, normalAttackSfx, voiceUrl, voiceLangsIn, combatSlot,
  voiceRulesOf, voiceMayStart, voiceBattleKey, resultVoiceRole, resultSpeaker, settlementVoice, installAudio, audio,
  combatTrackFor, COMBAT_TRACK_SWITCH_ROUND } from '../../public/js/audio.js';
import { mediaUrl } from '../../public/js/media.js';
import { createStore, initialState, emptyMatch } from '../../public/js/store.js';
import { PHASE } from '../../shared/constants.js';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));

// audio.js 取音频时**先请求无扩展名的 /media/…**（正是为了躲开下载管理器对 .mp3 后缀的嗅探），
// 只有那样 404 了才回退到 manifest 里的原始地址。所以「某个音效响了没有」不能拿原始地址去比对——
// 那样断言的是一个客户端永远不会请求的 URL。下面两个助手把比对放到同一条换算上。
/** 这个 manifest 地址被请求过吗（/media/ 形式或 404 后的原始形式）。 */
const asked = (urls, raw) => urls.includes(mediaUrl(raw)) || urls.includes(raw);
/** 这个 manifest 地址被请求了几次。 */
const askedCount = (urls, raw) => urls.filter((u) => u === mediaUrl(raw) || u === raw).length;

describe('bgm selection', () => {
  test('route and phase → key', () => {
    assert.equal(bgmKeyFor('title', null), 'lobby');
    assert.equal(bgmKeyFor('room', null), 'lobby');
    assert.equal(bgmKeyFor('game', null), 'lobby');
    assert.equal(bgmKeyFor('game', { phase: PHASE.INFO_CHECK }), 'lobby');
    assert.equal(bgmKeyFor('game', { phase: PHASE.PREP }), 'prep');
    assert.equal(bgmKeyFor('game', { phase: PHASE.SP_DRAFT }), 'prep');
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT }), 'combat');
    // 联防 has its own track: the official escaped_single / escaped_multi levels declare bgmEvent = corrosion
    assert.equal(bgmKeyFor('game', { phase: PHASE.UNITE }), 'unite');
    // 开战 BGM: the round's own track (combatTrackFor) indexes the manifest's `bgm.combatAlts`
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT }, 0), 'combat:0');
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT }, 1), 'combat:1');
    assert.equal(bgmKeyFor('game', { phase: PHASE.UNITE }, 1), 'unite', '联防 keeps its own track, not the round index');
    assert.equal(bgmKeyFor('game', { phase: PHASE.PREP }, 1), 'prep');
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT, bossId: 'boss_4' }, 1), 'boss:boss_4');
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT, bossId: 'boss_4' }), 'boss:boss_4');
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT }), 'boss');
    assert.equal(bgmKeyFor('game', { phase: PHASE.HIDDEN_CORE, bossId: 'boss_1', hiddenBossId: 'boss_9' }, 1), 'boss:boss_9');
    assert.equal(bgmKeyFor('game', { phase: PHASE.RESULT }), 'lobby');
    assert.equal(bgmKeyFor('weird', null), null);
  });
  test('开战 BGM: the track is fixed per round, not drawn (无畏者 1–7, 骑士之日 8–13)', () => {
    // The mode does not draw its battle theme: the official schedule plays 无畏者 through the early rounds and
    // 骑士之日 from round 8 on (reviewer note — review had this as a per-match 0.5 draw before).
    for (const r of [1, 2, 3, 4, 5, 6, 7]) assert.equal(combatTrackFor(r), 1, `round ${r} plays 无畏者`);
    for (const r of [8, 9, 10, 11, 12, 13]) assert.equal(combatTrackFor(r), 0, `round ${r} plays 骑士之日`);
    assert.equal(COMBAT_TRACK_SWITCH_ROUND, 7, 'the switch sits between round 7 and 8');
    // the boss rounds (14 最终攻势 / 15 隐秘核心) have their own tracks and never ask for combat:<i>
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT, round: 14 }, combatTrackFor(14)), 'boss');
    // an unknown round falls back to the manifest's plain combat track (older manifest / no round yet)
    for (const bad of [null, undefined, 0, -1, NaN, 'x']) assert.equal(combatTrackFor(bad), null, `${bad} ⇒ no index`);
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT, round: 3 }, combatTrackFor(null)), 'combat');
    // both ends of a real run: a solo 标准 match is 9 rounds, so it hears 无畏者 and then 骑士之日
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT, round: 7 }, combatTrackFor(7)), 'combat:1');
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT, round: 8 }, combatTrackFor(8)), 'combat:0');
    // the index↔track mapping this table assumes, from docs/ASSETS.md: combatAlts[0] = m_bat_kazimierz2_1 骑士之日,
    // combatAlts[1] = m_bat_kazimierz2_2 无畏者 (a reordering upstream breaks this test, not the players' ears)
    const alt = manifest.audio.bgm.combatAlts;
    assert.ok(alt[0].loop.includes('m_bat_kazimierz2_1'), `combatAlts[0] is 骑士之日: ${alt[0].loop}`);
    assert.ok(alt[1].loop.includes('m_bat_kazimierz2_2'), `combatAlts[1] is 无畏者: ${alt[1].loop}`);
  });
  test('resolveBgm uses the manifest (boss fallback, intro optional)', () => {
    const lobby = resolveBgm(manifest, 'lobby');
    assert.ok(lobby && typeof lobby.loop === 'string');
    const b4 = resolveBgm(manifest, 'boss:boss_4');
    assert.equal(b4.loop, manifest.audio.bossBgm.boss_4.loop);
    assert.equal(resolveBgm(manifest, 'boss:nope').loop, manifest.audio.bgm.boss.loop);
    // 开战 BGM: combat:<i> → bgm.combatAlts[i], and back to the default combat track when the index (or the whole
    // array, e.g. an older manifest) is missing
    const alts = manifest.audio.bgm.combatAlts;
    assert.ok(Array.isArray(alts) && alts.length >= 2, 'manifest carries the mode’s own battle tracks');
    assert.equal(resolveBgm(manifest, 'combat:0').loop, alts[0].loop);
    assert.equal(resolveBgm(manifest, 'combat:1').loop, alts[1].loop);
    assert.notEqual(alts[0].loop, manifest.audio.bgm.combat.loop, 'a real battle track, not the shop loop');
    assert.equal(resolveBgm(manifest, 'combat:9').loop, manifest.audio.bgm.combat.loop);
    assert.equal(resolveBgm({ audio: { bgm: { combat: { loop: '/shop.mp3' } } } }, 'combat:0').loop, '/shop.mp3');
    assert.equal(resolveBgm(manifest, 'prep').intro, manifest.audio.bgm.prep.intro ?? null);
    // 联防's own track (bgm.unite = corrosion, the official escaped levels' bgmEvent), and the fallback for an older
    // manifest that has no `unite` entry (the music must not go silent)
    const unite = manifest.audio.bgm.unite;
    assert.ok(unite && typeof unite.loop === 'string', 'the manifest carries 联防’s own track');
    assert.equal(resolveBgm(manifest, 'unite').loop, unite.loop);
    assert.equal(resolveBgm(manifest, 'unite').intro, unite.intro ?? null);
    assert.notEqual(unite.loop, manifest.audio.bgm.combat.loop, 'not the shop / default combat loop');
    assert.equal(resolveBgm({ audio: { bgm: { combat: { loop: '/shop.mp3' } } } }, 'unite').loop, '/shop.mp3');
    assert.equal(resolveBgm(null, 'lobby'), null);
    assert.equal(resolveBgm(manifest, null), null);
    assert.equal(resolveBgm(manifest, 'nope'), null);
  });
  test('installAudio: the round\'s own 开战 track, fixed per round and the same on every client', () => {
    const calls = [];
    const origPlay = audio.playBgm;
    audio.playBgm = (k) => { calls.push(k); };
    try {
      const pub = (o) => ({ phase: PHASE.PREP, round: 1, stageId: 'st1', players: [{ playerId: 'p1' }], ...o });
      // `me`: the store always has it
      const state = { route: 'game', me: { playerId: 'p1' }, match: { public: pub({}) } };
      let fire = null;
      /** One client: its own store subscription (the expected keys below are what its own round yields — the point of
       * the test is that the track follows the round, never moves inside a battle and never differs between clients). */
      const wire = () => installAudio({
        getManifest: () => manifest, getState: () => state, selectRoute: (s) => s.route,
        subscribe: (fn) => { fire = fn; return () => {}; },
      });
      wire();
      assert.equal(calls.at(-1), 'prep', 'the prep keeps the shop track');
      // round 1 ⇒ 无畏者 (combatAlts[1])
      state.match.public = pub({ phase: PHASE.COMBAT });
      fire(state, {}); assert.equal(calls.at(-1), 'combat:1');
      // a re-render / teammate view inside the same battle never moves
      fire(state, {}); assert.equal(calls.at(-1), 'combat:1');
      // 联防 has its OWN track (#110, the official escaped levels' `bgmEvent = corrosion`) — it does not inherit the
      // round's 开战 track
      state.match.public = pub({ phase: PHASE.UNITE });
      fire(state, {}); assert.equal(calls.at(-1), 'unite');
      // …and back to the round's own track in the 作战
      state.match.public = pub({ phase: PHASE.COMBAT });
      fire(state, {}); assert.equal(calls.at(-1), 'combat:1', "back to the round's own track");
      // a second client of the same room hears the same track (its own installAudio, same round)
      calls.length = 0; wire();
      assert.deepEqual(calls, ['combat:1'], 'every client of the match hears the same track');
      // round 7 is the last on 无畏者, round 8 switches to 骑士之日 (combatAlts[0]) — whoever sits in seat 1
      state.match.public = pub({ round: 7, phase: PHASE.COMBAT });
      fire(state, {}); assert.equal(calls.at(-1), 'combat:1');
      state.match.public = pub({ round: 8, phase: PHASE.COMBAT });
      fire(state, {}); assert.equal(calls.at(-1), 'combat:0');
      state.match.public = pub({ round: 8, phase: PHASE.COMBAT, players: [{ playerId: 'p2' }] });
      fire(state, {}); assert.equal(calls.at(-1), 'combat:0', 'the track does not depend on the seats');
      // the boss rounds keep their own tracks
      state.match.public = pub({ phase: PHASE.FINAL_ASSAULT, bossId: 'boss_4' });
      fire(state, {}); assert.equal(calls.at(-1), 'boss:boss_4');
    } finally { audio.playBgm = origPlay; }
  });
});

describe('SfxLimiter', () => {
  test('caps concurrent voices', () => {
    const l = new SfxLimiter({ maxVoices: 3, unitCooldownMs: 0, urlGapMs: 0 });
    assert.ok(l.tryAcquire(0, 1, 'a'));
    assert.ok(l.tryAcquire(0, 2, 'b'));
    assert.ok(l.tryAcquire(0, 3, 'c'));
    assert.equal(l.tryAcquire(0, 4, 'd'), false);
    l.release();
    assert.ok(l.tryAcquire(0, 4, 'd'));
    l.release(); l.release(); l.release(); l.release(); l.release();
    assert.equal(l.active, 0, 'never negative');
  });
  test('per-unit cooldown and per-url gap', () => {
    const l = new SfxLimiter({ maxVoices: 99, unitCooldownMs: 100, urlGapMs: 30 });
    assert.ok(l.tryAcquire(0, 'u1', 'x'));
    assert.equal(l.tryAcquire(50, 'u1', 'y'), false, 'same unit too soon');
    assert.equal(l.tryAcquire(10, 'u2', 'x'), false, 'same url too soon');
    assert.ok(l.tryAcquire(40, 'u2', 'x'));
    assert.ok(l.tryAcquire(120, 'u1', 'z'));
    assert.ok(l.tryAcquire(121, null, 'w'), 'no unit key ⇒ only url gap');
  });
  test('at most 2 overlapping copies of one sound (official banks: maxSoundAllowed 2)', () => {
    const l = new SfxLimiter({ maxVoices: 99, unitCooldownMs: 0, urlGapMs: 0 });
    assert.equal(l.maxPerUrl, 2);
    assert.ok(l.tryAcquire(0, 'a', 'heal'));
    assert.ok(l.tryAcquire(1, 'b', 'heal'));
    assert.equal(l.tryAcquire(2, 'c', 'heal'), false, 'a third copy waits');
    assert.ok(l.tryAcquire(2, 'c', 'other'), 'other sounds are not affected');
    l.release('heal');
    assert.ok(l.tryAcquire(3, 'c', 'heal'), 'one ended: room again');
  });
});

// ---- fake Web Audio -------------------------------------------------------------------------------------

function fakeWindow() {
  const listeners = new Map();
  const made = { sources: 0, started: 0 };
  class Param { constructor() { this.value = 1; } setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node { constructor() { super(); this.playbackRate = new Param(); made.sources++; } start() { made.started++; } stop() {} }
  class Ctx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    // an empty file does not decode (old WebKit's error callback gets no error)
    decodeAudioData(ab, ok, fail) { if (ab.byteLength) ok({ duration: 1.5 }); else fail(null); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  return {
    made,
    win: {
      AudioContext: Ctx,
      document: { hidden: false, addEventListener() {} },
      addEventListener(t, fn) { listeners.set(t, fn); },
      removeEventListener(t) { listeners.delete(t); },
    },
    fire(t) { listeners.get(t)?.(); },
  };
}

describe('AudioManager', () => {
  test('no AudioContext / no manifest: every call is a silent no-op', () => {
    const a = new AudioManager({ win: null, getManifest: () => null });
    a.install();
    a.playBgm('prep');
    a.sfx('buy');
    a.battle('enemyDie');
    assert.equal(a.unit('char_x', 'attack', 1), false);
    a.handleBattleEvents([['atk', 1, 2, 'arrow'], 'junk', null]);
    a.setVolumes({ bgm: 5, sfx: -1, muted: true });
    assert.deepEqual(a.volumes, { bgm: 1, sfx: 0, voice: 0.8, voiceLang: 'cn', muted: true });
    assert.equal(a.voice('char_x', 'select'), false);
    assert.equal(a.unlocked, false);
  });
  test('unlocks on the first gesture, then plays BGM and SFX from the manifest', async () => {
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    try {
      const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
      a.install();
      a.playBgm('prep'); // remembered while locked
      assert.equal(urls.length, 0);
      fw.fire('pointerdown');
      assert.equal(a.unlocked, true);
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(asked(urls, manifest.audio.bgm.prep.loop), 'BGM fetched after unlock');
      a.sfx('buy');
      a.sfx('nonexistent');
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(asked(urls, manifest.audio.sfx.ui.buy));
      // same loop URL ⇒ no restart
      const before = fw.made.started;
      a.playBgm('combat');
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(fw.made.started, before, 'prep → combat shares the loop');
      // battle events map to unit sounds (UnitInfo.spine = char id)
      const charId = Object.keys(manifest.audio.sfx.units).find((k) => k.startsWith('char_') && normalAttackSfx(k, manifest.audio.sfx.units[k].attack));
      a.setFieldUnits([{ id: 1, side: 'ally', spine: charId }, { id: 2, side: 'enemy', spine: 'enemy_nope' }]);
      a.handleBattleEvents([['atk', 1, 2, 'arrow'], ['dmg', 2, 100, 'phys'], ['die', 2], ['spawn', { id: 3, side: 'enemy', spine: 'x' }], ['bounty', 'p', 1]]);
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(asked(urls, manifest.audio.sfx.units[charId].attack));
      assert.ok(asked(urls, manifest.audio.sfx.battle.enemyDie), 'fallback death sound');
      assert.ok(a.limiter.active <= a.limiter.maxVoices);
      a.setVolumes({ muted: true });
      const n = urls.length;
      a.sfx('refresh');
      assert.equal(urls.length, n, 'muted ⇒ nothing requested');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
  test('phone audit T5: navigator.audioSession becomes "playback" before the context exists (the iPhone silent switch no longer mutes everything)', () => {
    const fw = fakeWindow();
    const session = { type: 'auto' };
    const seen = [];
    const Base = fw.win.AudioContext;
    fw.win.AudioContext = class extends Base { constructor() { super(); seen.push(session.type); } };
    fw.win.navigator = { audioSession: session };
    const a = new AudioManager({ win: fw.win, getManifest: () => null });
    a.install();
    assert.equal(session.type, 'auto', 'not before the first gesture');
    fw.fire('pointerdown');
    assert.equal(a.unlocked, true);
    assert.deepEqual(seen, ['playback'], 'already "playback" when the AudioContext is created');
    assert.equal(session.type, 'playback');
  });
  test('audioSession: absent (every browser but iOS 16.4+ Safari) or throwing never breaks the unlock', () => {
    const none = fakeWindow();
    none.win.navigator = {};
    const a = new AudioManager({ win: none.win, getManifest: () => null });
    a.install();
    none.fire('pointerdown');
    assert.equal(a.unlocked, true);
    const bad = fakeWindow();
    bad.win.navigator = { audioSession: Object.defineProperty({}, 'type', { get: () => 'auto', set() { throw new TypeError('read-only'); } }) };
    const b = new AudioManager({ win: bad.win, getManifest: () => null });
    b.install();
    assert.doesNotThrow(() => bad.fire('pointerdown'));
    assert.equal(b.unlocked, true, 'the context is created anyway');
  });
  test('a file that cannot be fetched or decoded plays nothing and is logged once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warn = t.mock.method(console, 'warn', () => {});
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    const buy = manifest.audio.sfx.ui.buy;
    globalThis.fetch = async (u) => {
      if (u === mediaUrl(buy) || u === buy) throw new Error('offline');
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    t.after(() => { globalThis.fetch = origFetch; });
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('keydown');
    a.sfx('buy');
    a.sfx('buy');
    a.sfx('refresh');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fw.made.started, 0);
    const logged = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.deepEqual(logged, [`[audio] ${buy} unavailable`, `[audio] ${manifest.audio.sfx.ui.refresh} unavailable`]);
  });
  test('a BGM track that failed to load plays at a later phase change, once a short backoff has passed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'warn', () => {});
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    const loop = manifest.audio.bgm.prep.loop;
    let down = true;
    let asks = 0;
    globalThis.fetch = async (u) => {
      if (u === mediaUrl(loop)) asks += 1;
      return down ? { ok: false, status: 503 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    t.after(() => { globalThis.fetch = origFetch; });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    a.playBgm('prep');
    await flush();
    down = false;
    a.playBgm('combat'); // the same loop, within the backoff
    await flush();
    assert.equal(asks, 1);
    assert.equal(fw.made.started, 0, 'no BGM');
    t.mock.timers.tick(10000);
    a.playBgm('prep');
    await flush();
    assert.equal(asks, 2, 'fetched again');
    assert.ok(fw.made.started > 0, 'the BGM plays');
  });
  test('音频先走无扩展名的 /media/ 路由；只有它 404 才回退到带扩展名的原地址', async () => {
    const raw = manifest.audio.bgm.prep.loop;
    const media = mediaUrl(raw);
    assert.notEqual(media, raw, '前提：manifest 地址确实会被换算成 /media/ 路径');

    // 第一发 404：必须看到 /media/ 在前、原地址在后，两者都请求过
    {
      const fw = fakeWindow();
      const urls = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (u) => {
        urls.push(u);
        return u === media ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      };
      try {
        const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
        a.install();
        fw.fire('pointerdown');
        a.playBgm('prep');
        await new Promise((r) => setTimeout(r, 25));
        const first = urls.indexOf(media);
        const fallback = urls.indexOf(raw);
        assert.ok(first !== -1, '先试无扩展名路径');
        assert.ok(fallback !== -1, '404 后回退到原地址');
        assert.ok(first < fallback, '顺序必须是先 /media/ 再原地址');
      } finally { globalThis.fetch = origFetch; }
    }

    // 第一发 200：不该再去碰带扩展名的地址（否则白白多一次请求，也正是 IDM 会拦的那个 URL）
    {
      const fw = fakeWindow();
      const urls = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
      try {
        const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
        a.install();
        fw.fire('pointerdown');
        a.playBgm('prep');
        await new Promise((r) => setTimeout(r, 25));
        assert.ok(urls.includes(media), '走了 /media/');
        assert.ok(!urls.includes(raw), '/media/ 成功就不该再请求 .mp3 地址');
      } finally { globalThis.fetch = origFetch; }
    }

    // 第一发 200 但内容不是音频：有些静态托管对不存在的路径回 200 + index.html，解码会静默失败，也要回退。
    {
      const fw = fakeWindow();
      const urls = [];
      let cancelled = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (u) => {
        urls.push(u);
        if (u !== media) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
          body: { cancel: async () => { cancelled += 1; } },
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      };
      try {
        const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
        a.install();
        fw.fire('pointerdown');
        a.playBgm('prep');
        await new Promise((r) => setTimeout(r, 25));
        assert.ok(urls.includes(raw), '内容不是音频时回退到原地址');
        assert.equal(cancelled, 1, '丢掉那个用不上的响应，别把连接挂着');
      } finally { globalThis.fetch = origFetch; }
    }

    // /media/ 直接给出 audio/*（服务端真实行为）：不回退，也不去 cancel 一个能用的响应
    {
      const fw = fakeWindow();
      const urls = [];
      let cancelled = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (u) => {
        urls.push(u);
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
          body: { cancel: async () => { cancelled += 1; } },
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      };
      try {
        const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
        a.install();
        fw.fire('pointerdown');
        a.playBgm('prep');
        await new Promise((r) => setTimeout(r, 25));
        assert.ok(urls.includes(media));
        assert.ok(!urls.includes(raw), 'audio/* 就是成功，不该再回退');
        assert.equal(cancelled, 0);
      } finally { globalThis.fetch = origFetch; }
    }
  });
  test('the buffer cache keeps a decoded-PCM budget (64 MB) beside its entry count, never evicting the playing BGM', async () => {
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    try {
      const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
      a.install();
      fw.fire('pointerdown');
      // every file decodes to 32 MB of PCM (4 Mi frames × 2 channels × 4 bytes): two fit the budget, a third does not
      a.ctx.decodeAudioData = (ab, ok) => ok({ duration: 1, length: 4 * 1024 * 1024, numberOfChannels: 2 });
      a.bgm = { loopUrl: '/v/bgm.mp3' };
      for (const u of ['/v/bgm.mp3', '/v/a.mp3', '/v/b.mp3']) { await a._buffer(u); await new Promise((r) => setTimeout(r, 0)); }
      assert.deepEqual([...a.buffers.keys()], ['/v/bgm.mp3', '/v/b.mp3'], 'the oldest buffer that is not the BGM went');
      assert.equal([...a.bufBytes.values()].reduce((s, n) => s + n, 0), 64 * 1024 * 1024);
    } finally { globalThis.fetch = origFetch; }
  });
});

// user playtest #4 item 6: 纯烬艾雅法拉's skill sound rang outside her skill — her manifest `hit` is her S3 impact
// (p_imp_gtshpbrnch_s, the audio bank ON_ABILITY_HIT.attack.2) and every damage on an ally she had just healed was
// attributed to her ('atk' healer → ally), so ordinary enemy hits on healed allies played it.
describe('impact sounds (user playtest #4 item 6)', () => {
  const AGOAT2 = 'char_1016_agoat2';
  async function rig(units) {
    const fw = fakeWindow();
    const urls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    a.setFieldUnits(units);
    const settle = () => new Promise((r) => setTimeout(r, 5));
    return { a, urls, settle, restore: () => { globalThis.fetch = origFetch; } };
  }

  test('an operator never plays a skill-mode file (_d / _h / _s) as its normal attack or impact; enemies keep their _h', () => {
    const u = manifest.audio.sfx.units;
    // her impact: the S3 file (built before tools/assets/audio.mjs preferred normal-mode banks) is refused, the normal
    // one (projectile_chr_agoat2: p_imp_gtshpbrnch_n) plays
    assert.equal(normalAttackSfx(AGOAT2, '/assets/audio/sfx/player/p_imp/p_imp_gtshpbrnch_s.mp3'), false);
    assert.equal(normalAttackSfx(AGOAT2, '/assets/audio/sfx/player/p_imp/p_imp_gtshpbrnch_n.mp3'), true);
    if (u[AGOAT2].hit) assert.equal(normalAttackSfx(AGOAT2, u[AGOAT2].hit), !/_s\.mp3$/.test(u[AGOAT2].hit));
    assert.equal(normalAttackSfx(AGOAT2, u[AGOAT2].attack), true, 'p_atk_gtshpbrnch_n');
    assert.equal(normalAttackSfx('char_1014_nearl2', '/x/p_atk_goldspear_s.mp3'), false);
    assert.equal(normalAttackSfx('char_1028_texas2', '/x/p_imp_reticentsword_h.mp3'), false);
    assert.equal(normalAttackSfx('char_1045_svash2', '/x/p_atk_snwlprdg_n1.mp3'), true);
    assert.equal(normalAttackSfx('enemy_1045_hammer', '/x/e_atk_bigaxe_h.mp3'), true, 'enemy _h = heavy weapon');
    assert.equal(normalAttackSfx('char_x', null), false);
  });

  test('a heal never makes the healer the author of the next damage on the healed ally', async () => {
    const enemyId = Object.keys(manifest.audio.sfx.units).find((k) => k.startsWith('enemy_') && manifest.audio.sfx.units[k].hit);
    const { a, urls, settle, restore } = await rig([
      { id: 1, side: 'ally', kind: 'chess', spine: AGOAT2 }, { id: 2, side: 'ally', kind: 'chess', spine: 'char_x' },
      { id: 3, side: 'enemy', kind: 'enemy', spine: enemyId },
    ]);
    try {
      // 她的技能形态（_s）文件：这条断言要盯住它们一个都没响，所以先确认音效表里真的有 _s ——
      // 否则集合为空，断言会永远成立、形同虚设。
      const ownSkill = Object.values(manifest.audio.sfx.units[AGOAT2]).filter((x) => typeof x === 'string' && /_s\.mp3$/.test(x));
      assert.ok(ownSkill.length > 0, '前提：她的音效表里确实有 _s（技能形态）文件');
      a.handleBattleEvents([['atk', 1, 2, 'orb'], ['heal', 2, 300], ['dmg', 2, 120, 'phys'], ['dmg', 2, 80, 'arts']]);
      await settle();
      assert.ok(asked(urls, manifest.audio.sfx.units[AGOAT2].attack), 'her cast sound');
      assert.ok(!asked(urls, manifest.audio.sfx.units[AGOAT2].hit), 'no impact sound of hers on the ally');
      assert.ok(!ownSkill.some((p) => asked(urls, p)), 'nothing of her S3');
      // a hostile attack still authors its impact — once, and only for a real hit (not an element gauge fill)
      a.handleBattleEvents([['atk', 3, 2, 'none'], ['dmg', 2, 900, 'burn']]);
      await settle();
      assert.ok(!asked(urls, manifest.audio.sfx.units[enemyId].hit), 'a gauge fill is no impact');
      a.handleBattleEvents([['dmg', 2, 200, 'phys']]);
      await settle();
      assert.equal(askedCount(urls, manifest.audio.sfx.units[enemyId].hit), 1, 'the impact');
      a.limiter.lastByUnit.clear(); a.limiter.lastByUrl.clear();
      a.handleBattleEvents([['dmg', 2, 50, 'phys']]);
      await settle();
      assert.equal(askedCount(urls, manifest.audio.sfx.units[enemyId].hit), 1, 'a later tick is not the same attack\'s impact');
    } finally { restore(); }
  });

  test('a chain bounce plays no attack sound of the previous target; a stale attack is no impact', async () => {
    const enemyId = Object.keys(manifest.audio.sfx.units).find((k) => k.startsWith('enemy_') && manifest.audio.sfx.units[k].attack && manifest.audio.sfx.units[k].hit);
    const charId = Object.keys(manifest.audio.sfx.units).find((k) => k.startsWith('char_') && normalAttackSfx(k, manifest.audio.sfx.units[k].hit) && manifest.audio.sfx.units[k].hit);
    const { a, urls, settle, restore } = await rig([
      { id: 1, side: 'ally', kind: 'chess', spine: charId }, { id: 5, side: 'enemy', kind: 'enemy', spine: enemyId },
      { id: 6, side: 'enemy', kind: 'enemy', spine: enemyId },
    ]);
    const perf = globalThis.performance;
    let fakeNow = 1000;
    globalThis.performance = { now: () => fakeNow };
    try {
      a.handleBattleEvents([['atk', 5, 6, 'chain']]);
      await settle();
      assert.ok(!asked(urls, manifest.audio.sfx.units[enemyId].attack), 'the bounce is not an enemy attack');
      a.handleBattleEvents([['atk', 1, 5, 'arrow']]);
      fakeNow += 4000;
      a.handleBattleEvents([['dmg', 5, 100, 'phys']]);
      await settle();
      assert.ok(!asked(urls, manifest.audio.sfx.units[charId].hit), '4 s later: not that attack\'s impact');
    } finally { globalThis.performance = perf; restore(); }
  });
});


// Operator voice: upstream #73's moments (DESIGN §21.30) on this fork's engine — the official battleVoice rules
// (audio.voiceRules), the opening window, hidden-page / reconnect / re-mount continuity, the failed-file backoff.
describe('operator voice', () => {
  const LEAD = 'char_8_lead';
  const OP = 'char_9_op';
  const OP2 = 'char_7_op';
  const OP3 = 'char_6_op';
  // 盟约·辅助干员: the pool's operator without voice lines
  const AUX = 'char_616_pithst';
  // the official file numbers of the roles (tools/assets/voice.mjs); 作战中1–4 are cn_025–cn_028, in order
  const ROLE_OF = { '019': 'depart', '020': 'start', '021': 'select', '022': 'select', '023': 'deploy',
    '025': 'combat1', '026': 'combat2', '027': 'combat3', '028': 'combat4', '029': 'win4', '030': 'win3', '031': 'win', '032': 'fail' };
  const line = (op, n, lang = 'cn') => `/assets/voice/${lang}/${op}/cn_${n}.mp3`;
  const lines = (op) => ({
    select: [line(op, '021')], deploy: [line(op, '023')], combat: ['025', '026', '027', '028'].map((n) => line(op, n)),
    start: line(op, '020'), depart: line(op, '019'), win4: line(op, '029'), win3: line(op, '030'), win: line(op, '031'), fail: line(op, '032'),
  });
  // four operators' lines, with the shipped rules (data/assets.json audio.voiceRules)
  const vm = { audio: { voiceRules: manifest.audio.voiceRules,
    voice: { cn: { [LEAD]: lines(LEAD), [OP]: lines(OP), [OP2]: lines(OP2), [OP3]: lines(OP3) } } } };

  test('voiceUrl picks a line of the role (arrays at random, 作战中N by position); voiceLangsIn lists the languages', () => {
    const m = { audio: { voice: {
      cn: { [OP]: { select: [line(OP, '021'), line(OP, '022')], start: line(OP, '020'), depart: line(OP, '019'), combat: lines(OP).combat },
        [OP2]: { combat: [line(OP2, '025'), line(OP2, '026')] } },
      jp: { [OP]: { select: [line(OP, '021', 'jp')] } },
    } } };
    assert.equal(voiceUrl(m, 'cn', OP, 'start'), line(OP, '020'));
    assert.equal(voiceUrl(m, 'cn', OP, 'depart'), line(OP, '019'), '行动出发 is its own role');
    assert.equal(voiceUrl(m, 'cn', OP, 'select', () => 0), line(OP, '021'));
    assert.equal(voiceUrl(m, 'cn', OP, 'select', () => 0.99), line(OP, '022'));
    // `combat` is positional: entry k-1 is 作战中k
    assert.equal(voiceUrl(m, 'cn', OP, 'combat', () => 0.99, 0), line(OP, '025'), '作战中1');
    assert.equal(voiceUrl(m, 'cn', OP, 'combat', () => 0.99, 2), line(OP, '027'), '作战中3');
    assert.equal(voiceUrl(m, 'cn', OP, 'combat', () => 0, 3), line(OP, '028'), '作战中4');
    assert.equal(voiceUrl(m, 'cn', OP, 'combat', () => 0.99), line(OP, '028'), 'no index: drawn');
    assert.equal(voiceUrl(m, 'cn', OP, 'combat', () => 0, 7), line(OP, '025'), 'an index out of range: drawn');
    // an array that is not the 4 positional lines (an older manifest) is drawn whatever the index
    assert.equal(voiceUrl(m, 'cn', OP2, 'combat', () => 0, 1), line(OP2, '025'));
    assert.equal(voiceUrl(m, 'cn', OP2, 'combat', () => 0.99, 0), line(OP2, '026'));
    assert.equal(voiceUrl(m, 'jp', OP, 'start'), null);
    assert.equal(voiceUrl(null, 'cn', OP, 'select'), null);
    assert.deepEqual(voiceLangsIn(m).map(([k]) => k), ['cn', 'jp']);
    assert.deepEqual(voiceLangsIn({ audio: { voice: { jp: { [OP]: {} } } } }).map(([k]) => k), ['jp']);
    // the EN / KR dubs (DESIGN §21.30): offered when the site has them, after 中文 / 日文
    assert.deepEqual(voiceLangsIn({ audio: { voice: { kr: { [OP]: {} }, en: { [OP]: {} }, cn: { [OP]: {} } } } }),
      [['cn', '中文'], ['en', '英文'], ['kr', '韩文']]);
  });

  test('combatSlot: the equipped skill (UnitInfo.skillIndex, 0-based) is 作战中N', () => {
    assert.equal(combatSlot(0), 1);
    assert.equal(combatSlot(1), 2);
    assert.equal(combatSlot(2), 3);
    assert.equal(combatSlot(3), 4);
    assert.equal(combatSlot(9), 4, 'there are four lines');
    for (const bad of [null, undefined, -1, 1.5, '1', NaN]) assert.equal(combatSlot(bad), 1, `${bad} ⇒ 作战中1`);
  });

  test('the rules are data/assets.json audio.voiceRules (the official battleVoice) plus the settlement lines', () => {
    const r = voiceRulesOf(manifest);
    assert.equal(r.crossfade, 0.1);
    assert.equal('encounterDelay' in r, false, '行动开始 is no longer held back from the battle start');
    // minTimeDeltaForEnemyEncounter: the least time between two 行动开始 lines, start to start
    assert.equal(manifest.audio.voiceRules.minTimeDeltaForEnemyEncounter, 3);
    assert.deepEqual(r.types.ENCOUNTER_ENEMY, { priority: 90, overlap: false, cooldown: 3 }, '行动开始');
    assert.equal(manifest.audio.voiceRules.voiceTypeOptions.find((o) => o.voiceType === 'ENCOUNTER_ENEMY').cooldown, 0,
      'the manifest itself is not changed');
    assert.deepEqual(r.types.BATTLE_START, { priority: 100, overlap: true, cooldown: 0 }, '行动出发');
    assert.deepEqual(r.types.SKILL_PASSIVE_IMP, { priority: 60, overlap: false, cooldown: 10 }, '作战中');
    assert.deepEqual(r.types.PLACE_CHAR, { priority: 20, overlap: true, cooldown: 0 }, '部署');
    assert.deepEqual(r.types.FOCUS_CHAR, { priority: 10, overlap: true, cooldown: 0 }, '选中干员');
    assert.deepEqual(r.types.RESULT, { priority: 100, overlap: true, cooldown: 0 }, 'the settlement lines');
    assert.equal(voiceRulesOf({ audio: { voice: vm.audio.voice } }), null, 'a manifest without rules has none');
  });

  test('voiceMayStart: cooldown per type; a higher priority cuts in, the same only when it overlaps, a lower never', () => {
    const { types } = voiceRulesOf(manifest);
    assert.equal(voiceMayStart(types.SKILL_PASSIVE_IMP, null, 1000, 5000), false, 'within 10 s of the last 作战中');
    assert.equal(voiceMayStart(types.SKILL_PASSIVE_IMP, null, 1000, 11001), true);
    assert.equal(voiceMayStart(types.SKILL_PASSIVE_IMP, { priority: 60 }, undefined, 0), false, 'one 作战中 never cuts another');
    assert.equal(voiceMayStart(types.SKILL_PASSIVE_IMP, { priority: 90 }, undefined, 0), false, 'nor 行动开始');
    assert.equal(voiceMayStart(types.FOCUS_CHAR, { priority: 60 }, undefined, 0), false, 'a tap never cuts a 作战中');
    assert.equal(voiceMayStart(types.FOCUS_CHAR, { priority: 10 }, undefined, 0), true, 'taps replace each other');
    assert.equal(voiceMayStart(types.PLACE_CHAR, { priority: 10 }, undefined, 0), true, '部署 over 选中');
    assert.equal(voiceMayStart(types.PLACE_CHAR, { priority: 60 }, undefined, 0), false, 'an in-battle 部署 never cuts 作战中');
    // several operators engaging at once: the first one's 行动开始 plays, the others never cut it
    assert.equal(voiceMayStart(types.ENCOUNTER_ENEMY, { priority: 90 }, undefined, 0), false, 'engage vs engage');
    assert.equal(voiceMayStart(types.ENCOUNTER_ENEMY, null, 1000, 3999), false, '2.999 s after the last 行动开始 started');
    assert.equal(voiceMayStart(types.ENCOUNTER_ENEMY, null, 1000, 4000), true, '3 s after');
    assert.equal(voiceMayStart(types.ENCOUNTER_ENEMY, { priority: 60 }, undefined, 0), true, '行动开始 cuts a 作战中');
    // 行动出发 against 行动开始
    assert.equal(voiceMayStart(types.ENCOUNTER_ENEMY, { priority: 100 }, undefined, 0), false, 'an engage while 行动出发 plays');
    assert.equal(voiceMayStart(types.BATTLE_START, { priority: 90 }, undefined, 0), true, '行动出发 cuts 行动开始');
    // the settlement over anything; the next battle's 行动出发 (same priority, overlaps) may cut it
    assert.equal(voiceMayStart(types.RESULT, { priority: 90 }, undefined, 0), true);
    assert.equal(voiceMayStart(types.RESULT, { priority: 100 }, undefined, 0), true);
    assert.equal(voiceMayStart(types.BATTLE_START, { priority: 100 }, undefined, 0), true);
  });

  test('voiceBattleKey: every battle phase is a battle of its own, for everyone in the match', () => {
    const s = (phase, players = [{ playerId: 'me', alive: true }], me = 'me') => ({ me: { playerId: me }, match: { public: { phase, round: 3, players } } });
    assert.equal(voiceBattleKey(s(PHASE.COMBAT)), 'COMBAT:3');
    assert.equal(voiceBattleKey(s(PHASE.UNITE)), 'UNITE:3', '联防 has its own 行动出发, opening and settlement');
    assert.equal(voiceBattleKey(s(PHASE.FINAL_ASSAULT)), 'FINAL_ASSAULT:3');
    assert.equal(voiceBattleKey(s(PHASE.HIDDEN_CORE)), 'HIDDEN_CORE:3');
    // eliminated players and spectators hear the field they watch
    assert.equal(voiceBattleKey(s(PHASE.COMBAT, [{ playerId: 'me', alive: false }])), 'COMBAT:3', 'eliminated');
    assert.equal(voiceBattleKey(s(PHASE.COMBAT, [{ playerId: 'p1', alive: true }], 'watcher')), 'COMBAT:3', 'a spectator');
    for (const p of [PHASE.PREP, PHASE.SETTLE, PHASE.RESULT, PHASE.SP_DRAFT, PHASE.INFO_CHECK]) assert.equal(voiceBattleKey(s(p)), null, p);
    assert.equal(voiceBattleKey({ me: { playerId: 'me' }, match: { public: null } }), null);
  });

  // ---- the settlement line (结算): upstream #73's mapping and speaker, 9d56342's chess → charId step ---------------

  test('resultVoiceRole: 完美 → 3星 (绝境 / 终极: 完成高难行动), nothing killed → 行动失败, a leak → 非3星; a boss that survived → 行动失败', () => {
    assert.equal(resultVoiceRole({ perfect: true }), 'win3');
    assert.equal(resultVoiceRole({ perfect: true, hard: true }), 'win4', '绝境 / 终极 报 完成高难行动');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 2, killed: 10, total: 12 }), 'win');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 2, killed: 10, total: 12, hard: true }), 'win', 'a leak is 非3星 on any difficulty');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 0, killed: 0, total: 12 }), 'fail');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 3, killed: 0, total: 12 }), 'fail', 'nothing killed before a leak');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 0, killed: 5, total: 5 }), 'win3', 'no leak ⇒ the 3星 line');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 0, killed: 5, total: 5, hard: true }), 'win4');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 0, killed: 0, total: 0 }), 'win3', 'a battle without enemies');
    assert.equal(resultVoiceRole(), 'win3');
    assert.equal(resultVoiceRole(null), 'win3');
    // [ASSUMED] beside upstream's mapping: a boss battle whose boss survived is 行动失败, whatever else
    assert.equal(resultVoiceRole({ perfect: true, hard: true, boss: true, bossDown: false }), 'fail');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 0, killed: 9, total: 10, boss: true, bossDown: false }), 'fail');
    assert.equal(resultVoiceRole({ perfect: true, hard: true, boss: true, bossDown: true }), 'win4', 'the boss down: as usual');
    assert.equal(resultVoiceRole({ perfect: false, leaked: 1, killed: 3, total: 4, boss: true, bossDown: true }), 'win');
    assert.equal(resultVoiceRole({ perfect: true, boss: false, bossDown: null }), 'win3', 'not a boss battle');
  });

  test('resultSpeaker: the operators of THAT battle (survivors first), never the field on screen; canSpeak skips the voiceless', () => {
    // `unitsEnd` of the finished own battle: operators (char_*) and the board's summon pieces (token_*, no voice)
    const mine = { unitsEnd: [
      { defId: 'char_fallen', alive: false },
      { defId: 'token_1001', alive: true },
      { defId: 'char_a', alive: true },
      { defId: 'char_b', alive: true },
    ] };
    assert.equal(resultSpeaker(mine, () => 0), 'char_a');
    assert.equal(resultSpeaker(mine, () => 0.999), 'char_b', 'a drawn operator, still only the ones standing');
    assert.equal(resultSpeaker(mine, () => 0.4), 'char_a');
    const drawn = new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => resultSpeaker(mine, () => r)));
    assert.deepEqual([...drawn].sort(), ['char_a', 'char_b'], 'a fallen operator or a summon never speaks');
    // the whole squad fell: only then does a fallen operator report the result
    const wiped = { unitsEnd: [{ defId: 'char_fallen', alive: false }, { defId: 'char_also', alive: false }] };
    assert.equal(resultSpeaker(wiped, () => 0), 'char_fallen');
    assert.equal(resultSpeaker(wiped, () => 0.999), 'char_also');
    // no operator on that field at all — summons only, an empty list, or a payload without `unitsEnd`: no line, and
    // deliberately NO fallback to the field on screen (a watched teammate's operator would say the viewer's line)
    assert.equal(resultSpeaker({ unitsEnd: [{ defId: 'token_1', alive: true }] }, () => 0), null);
    assert.equal(resultSpeaker({ unitsEnd: [] }), null);
    assert.equal(resultSpeaker({}), null);
    assert.equal(resultSpeaker(null), null);
    assert.equal(resultSpeaker(undefined), null);
    assert.equal(resultSpeaker({ unitsEnd: [{ alive: true }] }, () => 0), null, 'a unit without a defId');
    assert.equal(resultSpeaker({ unitsEnd: [{ defId: 'enemy_1007_slime', alive: true }] }, () => 0), null, 'an enemy');
    // canSpeak (fork): an operator without the line (预备干员, 盟约·辅助干员) is skipped, not drawn into silence
    assert.equal(resultSpeaker(mine, () => 0, null, (id) => id !== 'char_a'), 'char_b');
    assert.equal(resultSpeaker(mine, () => 0, null, (id) => id === 'char_fallen'), 'char_fallen', 'no survivor can: a fallen one that can');
    assert.equal(resultSpeaker(mine, () => 0, null, () => false), null);
    // charOf maps a chess id to its operator; one that maps to nothing (or to a non-operator) is no speaker
    const chess = { unitsEnd: [{ defId: 'chess_x', alive: true }, { defId: 'chess_y', alive: true }] };
    assert.equal(resultSpeaker(chess, () => 0.999, (id) => ({ chess_x: 'char_x', chess_y: 'token_y' })[id] ?? null), 'char_x');
  });

  test('resultSpeaker on a real battle result: unitsEnd names the chess, the chess record gives the speaking operator', () => {
    // the sim reports each unit by its chess id (sim/Battle.js unitsEnd defId = the chess record's id), so the line needs
    // the chess → charId step the game screen passes (getChess(id).charId); without it no battle ever spoke (9d56342)
    const chessTable = JSON.parse(readFileSync(path.join(ROOT, 'data', 'chess.json'), 'utf8'));
    const id = 'chess_char_1_01_a';
    assert.equal(chessTable[id]?.charId, 'char_498_inside');
    const h = makeBattle({ defs: { chess: { [id]: chessRec({ id }) } }, units: [{ chessId: id, row: 10, col: 4 }], content: 'none' });
    const mine = Object.values(h.runToEnd(30).perPlayer)[0];
    assert.equal(mine.unitsEnd[0].defId, id, 'the result carries the chess id, not the charId');
    assert.equal(resultSpeaker(mine, () => 0), null, 'no chess → charId step: silent (the 0.1.4 bug)');
    const charOf = (defId) => chessTable[defId]?.charId ?? null;
    assert.equal(resultSpeaker(mine, () => 0, charOf), 'char_498_inside');
    // …and the whole step the game screen takes, with the shipped manifest's voice lines
    const v = settlementVoice({ perfect: !!mine.perfect, leaked: (mine.leaked || []).length, killed: mine.killed, total: mine.total,
      unitsEnd: mine.unitsEnd }, { charOf, canSpeak: (c, r) => voiceUrl(manifest, 'cn', c, r) != null, random: () => 0 });
    assert.equal(v?.charId, 'char_498_inside');
    assert.ok(['win3', 'win', 'fail', 'win4'].includes(v.role));
    assert.ok(voiceUrl(manifest, 'cn', v.charId, v.role), 'the shipped manifest has that line');
  });

  test('settlementVoice: the line of a finished own battle — its role, and a speaker of that battle that has it', () => {
    const charOf = (id) => ({ chess_a: 'char_a', chess_b: 'char_b' })[id] ?? null;
    const st = { perfect: true, leaked: 0, killed: 10, total: 10, boss: false, bossDown: null,
      unitsEnd: [{ defId: 'chess_a', alive: true }, { defId: 'chess_b', alive: false }] };
    assert.deepEqual(settlementVoice(st, { charOf, random: () => 0 }), { charId: 'char_a', role: 'win3' });
    assert.deepEqual(settlementVoice(st, { hard: true, charOf, random: () => 0 }), { charId: 'char_a', role: 'win4' });
    assert.deepEqual(settlementVoice({ ...st, perfect: false, leaked: 1 }, { charOf, random: () => 0 }), { charId: 'char_a', role: 'win' });
    assert.deepEqual(settlementVoice({ ...st, boss: true, bossDown: false }, { hard: true, charOf, random: () => 0 }), { charId: 'char_a', role: 'fail' });
    // canSpeak is asked about the role decided: the survivor without 完成高难行动 leaves it to the fallen one
    const asked = [];
    const canSpeak = (c, r) => { asked.push([c, r]); return c !== 'char_a'; };
    assert.deepEqual(settlementVoice(st, { hard: true, charOf, canSpeak, random: () => 0 }), { charId: 'char_b', role: 'win4' });
    assert.deepEqual(asked, [['char_a', 'win4'], ['char_b', 'win4']]);
    assert.equal(settlementVoice(st, { charOf, canSpeak: () => false }), null, 'nobody can say it');
    assert.equal(settlementVoice(st, { random: () => 0 }), null, 'chess ids without charOf: no speaker');
    assert.equal(settlementVoice({ ...st, unitsEnd: [] }, { charOf }), null);
    assert.equal(settlementVoice(null, { charOf }), null, 'no settlement (not finished, not own, a replica)');
    assert.equal(settlementVoice(undefined), null);
  });

  // ---- one client, on a virtual clock -----------------------------------------------------------------------

  // the battle field as game.js tracks it on entering: own operators (skillIndex: the equipped skill, 0-based), a
  // teammate's, an enemy, an own summon, a voiceless operator and one whose skill is unknown
  const FIELD = [
    { id: 1, side: 'ally', kind: 'chess', spine: LEAD, defId: 'lead', ownerId: 'me', skillIndex: 0 },
    { id: 2, side: 'ally', kind: 'chess', spine: OP, defId: 'op', ownerId: 'me', skillIndex: 1 },
    { id: 3, side: 'ally', kind: 'chess', spine: OP2, defId: 'op2', ownerId: 'me', skillIndex: 2 },
    { id: 4, side: 'ally', kind: 'chess', spine: OP, defId: 'op', ownerId: 'mate', skillIndex: 0 },
    { id: 5, side: 'enemy', kind: 'enemy', spine: OP2 },
    { id: 6, side: 'ally', kind: 'token', spine: OP2, defId: 'token_x', ownerId: 'me' },
    { id: 7, side: 'ally', kind: 'chess', spine: AUX, defId: 'aux', ownerId: 'me', skillIndex: 0 },
    { id: 8, side: 'ally', kind: 'chess', spine: OP3, defId: 'op3', ownerId: 'me' },
  ];
  const info = (id) => FIELD.find((u) => u.id === id);

  /**
   * A player's client on a virtual clock (mock timers; performance.now follows the mocked Date): the store fed as
   * main.js feeds it from m.public / m.result and followed as installAudio follows it, the field entered and its battle
   * events as game.js forwards them, the page's visibility, and the voice lines that actually start (a fake Web Audio
   * graph; every line lasts 2 s). The rig enters the field 'n:me' of battle 'b1' at 0.
   */
  function voiceRig(t, { m = vm } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const perf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    Object.defineProperty(globalThis, 'performance', { value: { now: () => Date.now() }, configurable: true, writable: true });
    const origFetch = globalThis.fetch;
    const fetched = [];
    const net = { respond: (url) => ({ ok: true, arrayBuffer: async () => ({ url }) }) };
    globalThis.fetch = async (url) => { fetched.push(url); return net.respond(url); };
    t.after(() => { globalThis.fetch = origFetch; Object.defineProperty(globalThis, 'performance', perf); });

    const started = [];
    const winOn = new Map();
    const docOn = new Map();
    class Param { constructor() { this.value = 1; } setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
    class Node { connect() {} disconnect() {} }
    class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
    class Src extends Node {
      start() {
        started.push({ url: this.buffer.url, at: Date.now() });
        this.end = setTimeout(() => this.onended?.(), this.buffer.duration * 1000);
      }
      stop() {
        clearTimeout(this.end);
        this.end = setTimeout(() => this.onended?.(), 0);
      }
    }
    class Ctx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node(); this.onState = []; }
      addEventListener(type, fn) { if (type === 'statechange') this.onState.push(fn); }
      setState(state) { this.state = state; for (const fn of this.onState) fn(); }
      createGain() { return new Gain(); }
      createBufferSource() { return new Src(); }
      decodeAudioData(ab, ok) { ok({ duration: 2, url: ab.url }); }
      resume() { this.setState('running'); return Promise.resolve(); }
      suspend() { this.setState('suspended'); return Promise.resolve(); }
    }
    const doc = { hidden: false, addEventListener: (type, fn) => docOn.set(type, fn) };
    const win = { AudioContext: Ctx, document: doc, addEventListener: (type, fn) => winOn.set(type, fn), removeEventListener: (type) => winOn.delete(type) };

    const store = createStore(initialState);
    store.set({ me: { playerId: 'me', name: '博士', token: null } });
    // the player IS known (as installAudio once told the manager through getPlayerId): the engine ignores it — any
    // operator of the field on screen speaks — so an own-operators filter that came back would mute the teammate's unit 4
    // ('the field on screen speaks') instead of passing on an unknown player
    const a = new AudioManager({ win, getManifest: () => m, getPlayerId: () => 'me' });
    a.install();
    winOn.get('pointerdown')();
    store.subscribe((s, prev) => a.followMatch(s, prev));
    /** game.js entering a field (its units, its fieldId / battleId). */
    const field = (fieldId = 'n:me', battleId = 'b1') => a.setFieldUnits(FIELD, { fieldId, battleId });
    field();
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    return {
      a, store, net, fetched, field,
      /** m.public of a phase (the own player alive unless said otherwise). */
      phase: (phase, round, alive = true) => store.patch('match', { public: { phase, round, players: [{ playerId: 'me', alive }] } }),
      pause: (paused) => store.patch('match', { public: { ...store.get().match.public, paused } }),
      result: (result) => store.patch('match', { result }),
      /** A first deployment: each unit's 'spawn' right before its 'deploy', all in one batch (Battle._deploy). */
      burst: (...ids) => a.handleBattleEvents(ids.flatMap((id) => [['spawn', info(id)], ['deploy', id]])),
      /** A later deployment of a unit already on the field (no 'spawn'). */
      redeploy: (id) => a.handleBattleEvents([['deploy', id]]),
      /** First engages, in one batch (sim ai.js performAttack). */
      engage: (...ids) => a.handleBattleEvents(ids.map((id) => ['engage', id])),
      skill: (unitId) => a.handleBattleEvents([['skill', unitId, true]]),
      hide: () => { doc.hidden = true; docOn.get('visibilitychange')(); },
      show: () => { doc.hidden = false; docOn.get('visibilitychange')(); },
      /** Run the virtual clock to `ms`: timers fire in order, loads settle in between. */
      async at(ms) {
        await flush();
        while (Date.now() < ms) {
          t.mock.timers.tick(Math.min(10, ms - Date.now()));
          await flush();
        }
      },
      /** The voice lines started so far: [role (作战中N as combatN), charId, ms]. */
      played: () => started.map(({ url, at }) => {
        const [, op, n] = /\/voice\/\w+\/([^/]+)\/cn_(\d+)\.mp3$/.exec(url);
        return [ROLE_OF[n], op, at];
      }),
    };
  }

  /** Answer `url` only once the returned function is called (a slow load); other files at once. */
  const holdFile = (r, url) => {
    const ok = r.net.respond;
    let release = null;
    r.net.respond = (u) => (u === url ? new Promise((resolve) => { release = () => resolve(ok(u)); }) : ok(u));
    return () => release();
  };

  // ---- 行动出发 / 部署 -------------------------------------------------------------------------------------------

  test('a battle opens with one 行动出发 by its first deployed operator; the burst\'s 部署 lose to it; a redeploy says 部署', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1, 2, 3, 6); // the initial deployment: operators, then the summons
    await r.at(3000);
    r.redeploy(2); // a redeploy, a 突袭 jump, a 不屈 / 阿戈尔 revive
    await r.at(5500);
    r.redeploy(6); // a summon says nothing
    await r.at(6000);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['deploy', OP, 3000]]);
    assert.deepEqual(r.a.voiceLog[0], { role: 'depart', charId: LEAD, type: 'BATTLE_START', battle: 'COMBAT:1', t: 500 });
  });

  test('a voiceless first operator is skipped: the next operator of the burst says 行动出发', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(7, 6, 2, 3);
    await r.at(3000);
    assert.deepEqual(r.played(), [['depart', OP, 500]]);
  });

  test('a deploy without its spawn is a 部署, and so is a first deployment after the opening', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.a.handleBattleEvents([['spawn', info(1)]]); // the spawn came in an earlier batch (a replayed buffer)
    r.redeploy(1);
    await r.at(16000); // the battle's opening is over, and the field was entered 16 s ago
    r.burst(2);
    await r.at(18500);
    r.burst(3);
    await r.at(19000);
    assert.deepEqual(r.played(), [['deploy', LEAD, 500], ['deploy', OP, 16000], ['deploy', OP2, 18500]]);
  });

  test('a 联防 field\'s first deployment that comes before m.public names the 联防 still says 行动出发; 联防 is a battle of its own', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1, 2);
    await r.at(60000);
    const release = holdFile(r, line(OP, '019'));
    r.field('u', 'b2'); // the 联防 field, entered on its start message
    r.burst(2, 3); // before the (throttled) phase change arrives: the 作战's opening is long over
    await r.at(60050);
    r.phase(PHASE.UNITE, 1); // the new battle keeps its 行动出发 still loading
    await r.at(60100);
    release();
    await r.at(63000);
    r.redeploy(3);
    await r.at(64000);
    r.burst(8); // a later first deployment in the 联防's opening: its 行动出发 was said before UNITE arrived
    await r.at(66500);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['depart', OP, 60100], ['deploy', OP2, 63000], ['deploy', OP3, 64000]]);
    assert.deepEqual(r.a.voiceLog.map((l) => l.battle), ['COMBAT:1', 'UNITE:1', 'UNITE:1', 'UNITE:1']);
  });

  test('the opening burst that came before the field was entered (its early buffer) says 行动出发 when replayed — nothing else', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.field('n:me', 'b2'); // entered after the runner's first frames: the initial deployment is in the early buffer
    r.a.replayEarly([7, 1, 2, 6].flatMap((id) => [['spawn', info(id)], ['deploy', id]]).concat([['deploy', 3], ['skill', 1, true]]));
    r.a.handleBattleEvents([7, 1, 2, 6].map((id) => ['spawn', info(id)])); // the view hears the quiet replay's spawns only
    await r.at(3000);
    r.redeploy(2);
    await r.at(5500);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['deploy', OP, 3000]], 'the voiceless first operator is skipped; a replayed deploy or skill says nothing');
    // the same field entered again (a re-mount, a resync): its replay never says 行动出发 twice
    r.field('n:me', 'b2');
    r.a.replayEarly([['spawn', info(3)], ['deploy', 3]]);
    await r.at(8000);
    assert.equal(r.played().length, 2);
  });

  test('an early buffer replayed after the opening (a field entered mid-battle) says nothing', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(40000);
    r.a.replayEarly([['spawn', info(1)], ['deploy', 1]]); // the rig's field was entered at 0: its window is over
    r.a.replayEarly([['deploy', 2]]);
    await r.at(42000);
    assert.deepEqual(r.played(), []);
  });

  test('a field without a battleId (server-run combat) opens every battle with its own 行动出发', async (t) => {
    const r = voiceRig(t);
    r.field('n:me', null);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1, 2);
    await r.at(40000);
    r.phase(PHASE.PREP, 2);
    await r.at(70000);
    r.field('n:me', null); // the next battle's m.field: the same voice field
    r.phase(PHASE.COMBAT, 2);
    await r.at(70500);
    r.burst(2, 3);
    await r.at(73000);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['depart', OP, 70500]]);
  });

  test('a re-mounted battle screen (its field entered again, spawns replayed) neither repeats 行动出发 nor says it for a redeploy', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1, 2, 3);
    await r.at(3000);
    r.field(); // re-mounted: the same field and battle
    r.a.handleBattleEvents([1, 2, 3].map((id) => ['spawn', info(id)])); // the early buffer's spawns (game.js)
    r.phase(PHASE.COMBAT, 1); // m.public sent again (a resync)
    await r.at(3500);
    r.redeploy(2);
    await r.at(6000);
    r.burst(8); // a later first deployment within the opening
    await r.at(8500);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['deploy', OP, 3500], ['deploy', OP3, 6000]]);
  });

  // ---- 行动开始 / 作战中N --------------------------------------------------------------------------------------------

  test('several operators engaging at once say one 行动开始; the next comes ≥ 3 s after it started, with nothing playing above it', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(1, 2, 3); // a wave reaches the line: the first engager speaks, the others never get another engage
    await r.at(3900);
    r.engage(8); // 2.9 s after the last 行动开始 started
    await r.at(4000);
    r.engage(4); // 3 s after, nothing playing
    await r.at(5000);
    r.engage(1); // its line plays (90): dropped
    await r.at(6500);
    assert.deepEqual(r.played(), [['start', LEAD, 1000], ['start', OP, 4000]]);
  });

  test('an engage while 行动出发 plays is dropped and does not end the opening; 作战中 waits for the first 行动开始', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1, 2, 3);
    await r.at(1500);
    r.engage(2); // 行动出发 (100) plays
    await r.at(2600);
    r.skill(3); // the opening's 行动开始 is still to come
    await r.at(3000);
    r.engage(3);
    await r.at(5500);
    r.skill(2);
    await r.at(6000);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['start', OP2, 3000], ['combat2', OP, 5500]]);
  });

  test('作战中 waits for the first 行动开始 15 s at most, then says the equipped skill\'s line (skillIndex 0 → 作战中1, 2 → 作战中3)', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.skill(2);
    await r.at(14900);
    r.skill(2);
    await r.at(15000);
    r.skill(2); // S2
    await r.at(24900);
    r.skill(3); // within 10 s of the last 作战中
    await r.at(25000);
    r.skill(3); // S3
    await r.at(35000);
    r.skill(8); // no skillIndex: 作战中1
    await r.at(40000);
    r.skill(1); // within 10 s
    await r.at(45000);
    r.skill(1); // S1
    await r.at(45100);
    assert.deepEqual(r.played(), [['combat2', OP, 15000], ['combat3', OP2, 25000], ['combat1', OP3, 35000], ['combat1', LEAD, 45000]]);
    assert.deepEqual(r.a.voiceLog[0], { role: 'combat', charId: OP, type: 'SKILL_PASSIVE_IMP', slot: 2, battle: 'COMBAT:1', t: 15000 });
    assert.deepEqual(r.a.voiceLog.map((l) => l.slot), [2, 3, 1, 1]);
  });

  test('the field on screen speaks: a teammate\'s operator does; an enemy or a summon never', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(5, 6); // an enemy, a summon
    r.skill(5);
    r.skill(6);
    r.redeploy(6);
    await r.at(1500);
    r.engage(4); // the teammate's operator (a shared or watched field)
    await r.at(4000);
    r.skill(4);
    await r.at(4500);
    assert.deepEqual(r.played(), [['start', OP, 1500], ['combat1', OP, 4000]]);
  });

  test('a field switch drops the line still loading and the opening\'s pending 行动开始; the new field has its own 行动出发', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    const release = holdFile(r, line(OP, '023'));
    await r.at(500);
    r.redeploy(2); // 部署 loading
    await r.at(600);
    r.field('n:mate', 'b2'); // watching a teammate
    release();
    await r.at(1000);
    r.hide();
    r.engage(1); // came on a hidden page within the opening: pending
    await r.at(1500);
    r.field('n:me', 'b1'); // back to the own field: that engage was another field's
    await r.at(2000);
    r.show();
    await r.at(2500);
    r.burst(3); // the own field's first deployment (its key is new to the voice again)
    await r.at(5000);
    r.engage(2);
    await r.at(5500);
    assert.deepEqual(r.played(), [['depart', OP2, 2500], ['start', OP, 5000]]);
  });

  test('a tab hidden before the first engage keeps the battle\'s opening, and 作战中 still waits for its 行动开始', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.hide();
    await r.at(800);
    r.show();
    await r.at(1000);
    r.skill(2);
    await r.at(2000);
    r.engage(1);
    await r.at(3500);
    r.skill(2);
    await r.at(4000);
    r.skill(3);
    await r.at(4100);
    assert.deepEqual(r.played(), [['start', LEAD, 2000], ['combat3', OP2, 4000]]);
  });

  test('the opening\'s first 行动开始 that came on a hidden page is said on return, within the opening; later engages are not heard', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.hide();
    r.engage(1);
    r.engage(2); // the first one is pending
    await r.at(4000);
    r.show();
    await r.at(7000);
    r.hide();
    r.engage(3); // after the opening's first: not heard, never said later
    await r.at(8000);
    r.show();
    await r.at(9000);
    assert.deepEqual(r.played(), [['start', LEAD, 4000]]);
  });

  test('a page hidden for the whole opening says no late 行动开始; 作战中 then plays, and the next engage speaks', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.hide();
    await r.at(1000);
    r.engage(1); // a hidden page still simulates
    await r.at(16000);
    r.show();
    await r.at(16500);
    r.skill(2);
    await r.at(19000);
    r.engage(3);
    await r.at(19500);
    assert.deepEqual(r.played(), [['combat2', OP, 16500], ['start', OP2, 19000]]);
  });

  test('a voiceless operator engaging first on a hidden page never takes the opening\'s pending 行动开始 from the voiced one', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.hide();
    r.engage(7, 1); // 7: 盟约·辅助干员, no voice lines — the pending line is the next one's
    await r.at(2000);
    r.show();
    await r.at(2500);
    assert.deepEqual(r.played(), [['start', LEAD, 2000]]);
  });

  test('the opening\'s pending 行动开始 waits out a solo pause: said when the pause ends, the page shown during it or after', async (t) => {
    for (const showFirst of [true, false]) {
      await t.test(showFirst ? 'shown during the pause' : 'shown after it', async (st) => {
        const r = voiceRig(st);
        r.phase(PHASE.COMBAT, 1);
        await r.at(1000);
        r.hide();
        r.engage(1); // pending
        await r.at(1500);
        r.pause(true);
        await r.at(2000);
        if (showFirst) r.show(); // heard again, but paused: held
        await r.at(5000);
        r.pause(false);
        if (!showFirst) { await r.at(5500); r.show(); }
        await r.at(6500);
        assert.deepEqual(r.played(), [['start', LEAD, showFirst ? 5000 : 5500]]);
      });
    }
  });

  test('the opening\'s pending 行动开始 is forgotten when the match leaves the screen; the battle itself is kept for its return', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.hide();
    r.engage(1); // pending
    await r.at(1500);
    r.store.set({ match: emptyMatch() }); // a reconnect past the restore grace: the room screen
    await r.at(2000);
    r.show(); // heard again on the room screen: nothing
    await r.at(2500);
    r.phase(PHASE.COMBAT, 1); // the match is pushed again (the same battle)
    r.field();
    await r.at(3000);
    r.engage(2); // the battle's first 行动开始 is still to come
    await r.at(3500);
    assert.deepEqual(r.played(), [['start', OP, 3000]]);
  });

  test('a solo pause holds the battle\'s opening: the wait of 作战中 goes on after it', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.pause(true);
    await r.at(30500);
    r.pause(false);
    await r.at(31000);
    r.skill(2); // 1 s into the opening (0.5 s before the pause, 0.5 s after): waits
    await r.at(31500);
    r.engage(1);
    await r.at(34000);
    r.skill(2);
    await r.at(34100);
    assert.deepEqual(r.played(), [['start', LEAD, 31500], ['combat2', OP, 34000]]);
    assert.equal(r.a.voiceLog[0].t, 1500, 'voiceLog t: ms into the battle, the pause left out');
  });

  test('a match cleared from the screen keeps its battle across a reconnect past the restore grace; the line loading is dropped', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(1);
    await r.at(3000);
    const release = holdFile(r, line(OP, '021'));
    r.a.voice(OP, 'select', { key: 'n:me:2' });
    await r.at(3100);
    r.store.set({ match: emptyMatch() }); // no m.public within the restore grace: back to the room
    release();
    await r.at(4000);
    r.phase(PHASE.COMBAT, 1); // the match is pushed again
    r.field();
    r.a.handleBattleEvents([1, 2].map((id) => ['spawn', info(id)]));
    await r.at(5500);
    r.skill(2); // its 行动开始 was said before: 作战中 does not wait
    await r.at(6000);
    assert.deepEqual(r.played(), [['start', LEAD, 1000], ['combat2', OP, 5500]]);
  });

  test('a battle left for the lobby is over for the next match, even one whose first battle has the same round', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.burst(1);
    await r.at(3000);
    r.engage(1);
    await r.at(4000);
    r.store.set({ room: null, match: emptyMatch() }); // 放弃模拟
    await r.at(10000);
    r.phase(PHASE.INFO_CHECK, 0); // the next match
    r.phase(PHASE.COMBAT, 1);
    r.field('n:me', 'c1');
    await r.at(10500);
    r.burst(2);
    await r.at(13000);
    r.skill(3); // a new opening: 作战中 waits for its 行动开始
    await r.at(13500);
    r.engage(3);
    await r.at(14000);
    assert.deepEqual(r.played(), [['depart', LEAD, 500], ['start', LEAD, 3000], ['depart', OP, 10500], ['start', OP2, 13500]]);
  });

  test('a 作战中 still loading when its battle ends never plays', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '026'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(1);
    await r.at(5500);
    r.skill(2);
    await r.at(5600);
    r.phase(PHASE.SETTLE, 1);
    release();
    await r.at(8000);
    assert.deepEqual(r.played(), [['start', LEAD, 1000]]);
    assert.deepEqual(r.a.voiceLog.map((l) => l.role), ['start'], 'voiceLog lists the lines that started, not the ones requested');
  });

  test('the 作战中 cooldown runs from the start of the line that played (a slow load starts it late)', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '026'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(16000); // no engage: the opening is over
    r.skill(2);
    await r.at(18000);
    release();
    await r.at(27900);
    r.skill(3);
    await r.at(28000);
    r.skill(3);
    await r.at(28100);
    assert.deepEqual(r.played(), [['combat2', OP, 18000], ['combat3', OP2, 28000]]);
  });

  // ---- 结算 (settle) ----------------------------------------------------------------------------------------------

  test('settle: one settlement line per battle, whatever asks again; a hidden page settles it silently', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    assert.equal(r.a.settle('b1', OP, 'win3'), true);
    await r.at(4000);
    assert.equal(r.a.settle('b1', OP, 'win3'), false, 'the drawn end after the runner\'s end, a re-mount, a replay');
    assert.equal(r.a.settle(null, OP, 'win3'), false);
    assert.equal(r.a.settle('b2', OP2, 'fail'), true);
    await r.at(7000);
    r.hide();
    assert.equal(r.a.settle('b3', LEAD, 'win4'), false);
    r.show();
    assert.equal(r.a.settle('b3', LEAD, 'win4'), false, 'never said late');
    await r.at(8000);
    assert.deepEqual(r.played(), [['win3', OP, 1000], ['fail', OP2, 4000]]);
    assert.deepEqual(r.a.voiceLog[0], { role: 'win3', charId: OP, type: 'RESULT', battle: 'COMBAT:1', t: 1000 });
  });

  test('a settlement still loading survives a field switch and COMBAT → SETTLE → RESULT; m.result itself says nothing', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '030'));
    r.phase(PHASE.COMBAT, 14);
    await r.at(1000);
    r.a.settle('b1', OP, 'win3'); // the own battle ended in the runner while a teammate's field is on screen
    r.field('n:mate', 'b2');
    r.phase(PHASE.SETTLE, 14);
    r.phase(PHASE.RESULT, 14);
    r.result({ victory: true, players: [{ playerId: 'me', stats: { lpLost: 0 } }] });
    await r.at(1500);
    release();
    await r.at(5000);
    // a reconnect that went past the restore grace: the match is cleared, then the result comes again
    r.store.set({ match: emptyMatch() });
    r.phase(PHASE.RESULT, 14);
    r.result({ victory: true, players: [] });
    await r.at(8000);
    assert.deepEqual(r.played(), [['win3', OP, 1500]]);
  });

  test('a settlement still loading survives the next battle key: COMBAT → UNITE (no SETTLE between — the own battle finished last)', async (t) => {
    // the server's UNITE m.public can come ~1 s after the own battle's drawn end (Match._finishCombat → COMBAT_END), while
    // the settlement file still loads: a new battle drops the lines loading for the one before — a settlement only by
    // the rules (the 联防's own 行动出发 may cut it); entering the 联防 field changes nothing of that either
    for (const enter of [false, true]) {
      await t.test(enter ? 'UNITE, then its field entered' : 'UNITE', async (st) => {
        const r = voiceRig(st);
        const release = holdFile(r, line(OP, '030'));
        r.phase(PHASE.COMBAT, 5);
        await r.at(1000);
        r.a.settle('b1', OP, 'win3');
        await r.at(1200);
        r.phase(PHASE.UNITE, 5);
        if (enter) r.field('u', 'b2');
        await r.at(1500);
        release();
        await r.at(4000);
        assert.deepEqual(r.played(), [['win3', OP, 1500]]);
      });
    }
  });

  test('the rules decide what cuts a settlement: the next battle\'s 行动出发 does, 行动开始 does not', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.a.settle('b1', OP, 'win');
    await r.at(1500);
    r.phase(PHASE.UNITE, 1); // the 联防 starts while it plays
    r.field('u', 'b2');
    r.burst(2, 3);
    await r.at(6000);
    r.a.settle('b2', OP2, 'win3');
    await r.at(6500);
    r.engage(1); // 行动开始 (90) never cuts a settlement (100)…
    await r.at(8500);
    r.engage(3); // …and did not end the opening: the next engage is the battle's first 行动开始
    await r.at(9000);
    assert.deepEqual(r.played(), [['win', OP, 1000], ['depart', OP, 1500], ['win3', OP2, 6000], ['start', OP2, 8500]]);
  });

  test('a settlement still loading when the player goes back to the room never plays there', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(LEAD, '032'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.a.settle('b1', LEAD, 'fail');
    r.phase(PHASE.RESULT, 1);
    await r.at(1500);
    r.store.set({ match: emptyMatch() }); // 返回房间
    release();
    await r.at(3000);
    assert.deepEqual(r.played(), []);
  });

  // ---- 选中干员 ---------------------------------------------------------------------------------------------------

  test('选中干员: one line per unit key within 1 s (the tap and the detail card it opens); another unit or later speaks', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(16000);
    assert.equal(r.a.voice(OP, 'select', { key: 'n:me:2' }), true, 'the tap');
    assert.equal(r.a.voice(OP, 'select', { key: 'n:me:2' }), false, 'the detail card it opened');
    await r.at(16500);
    assert.equal(r.a.voice(OP, 'select', { key: 'n:me:2' }), false, 'a double tap');
    await r.at(17000);
    assert.equal(r.a.voice(OP, 'select', { key: 'n:me:2' }), true, '1 s after the line asked for');
    await r.at(17500);
    assert.equal(r.a.voice(OP2, 'select', { key: 'n:me:3' }), true, 'another unit');
    await r.at(17600);
    r.field('n:mate', 'b2');
    assert.equal(r.a.voice(OP2, 'select', { key: 'n:me:3' }), true, 'another field forgets the last tap');
    await r.at(17700);
    assert.equal(r.a.voice(OP, 'select'), true, 'a select without a key is never de-duplicated');
    assert.equal(r.a.voice(OP, 'select'), true);
    await r.at(17800);
    assert.deepEqual(r.played(), [['select', OP, 16000], ['select', OP, 17000], ['select', OP2, 17500], ['select', OP2, 17600],
      ['select', OP, 17700]]);
  });

  // ---- failures, settings, the page --------------------------------------------------------------------------------

  test('a line that fails to load plays nothing, is logged and starts no cooldown', async (t) => {
    const r = voiceRig(t);
    const warn = t.mock.method(console, 'warn', () => {});
    const ok = r.net.respond;
    r.net.respond = (url) => (url === line(OP, '026') ? { ok: false, status: 503 } : ok(url));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(1);
    await r.at(5500);
    r.skill(2);
    await r.at(6000);
    r.skill(3); // no cooldown from the line that never played
    await r.at(6100);
    assert.deepEqual(r.played(), [['start', LEAD, 1000], ['combat3', OP2, 6000]]);
    assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes(line(OP, '026'))), 'the failure is logged');
  });

  test('a 行动开始 that failed to load plays in the next battle: a failed file is fetched again after a short backoff', async (t) => {
    const r = voiceRig(t);
    t.mock.method(console, 'warn', () => {});
    let down = true;
    const ok = r.net.respond;
    r.net.respond = (url) => (down && url === line(LEAD, '020') ? { ok: false, status: 503 } : ok(url));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.engage(1);
    await r.at(6000);
    r.phase(PHASE.SETTLE, 1);
    down = false;
    await r.at(30000);
    r.phase(PHASE.COMBAT, 2);
    r.field('n:me', 'b3');
    await r.at(31000);
    r.engage(1);
    await r.at(34000);
    assert.deepEqual(r.played(), [['start', LEAD, 31000]]);
  });

  test('while a failure is remembered the file is not fetched on every use', async (t) => {
    const r = voiceRig(t);
    t.mock.method(console, 'warn', () => {});
    let down = true;
    const ok = r.net.respond;
    r.net.respond = (url) => (down ? { ok: false, status: 404 } : ok(url));
    for (let ms = 0; ms < 10000; ms += 500) {
      await r.at(ms);
      r.a.voice(OP, 'select');
    }
    down = false;
    await r.at(10000);
    r.a.voice(OP, 'select');
    await r.at(10100);
    assert.equal(r.fetched.filter((u) => u === line(OP, '021')).length, 2, 'once, then once more after 10 s');
    assert.deepEqual(r.played(), [['select', OP, 10000]]);
  });

  test('voice turned off, to 0 or muted: the line still loading never plays; lines play again once it is back on', async (t) => {
    const r = voiceRig(t);
    const silences = [['deploy', { voiceLang: 'off' }, { voiceLang: 'cn' }], ['select', { voice: 0 }, { voice: 0.8 }],
      ['combat', { muted: true }, { muted: false }]];
    for (const [i, [role, silent, back]] of silences.entries()) {
      const release = holdFile(r, lines(OP)[role][0]);
      await r.at(i * 1000);
      assert.equal(r.a.voice(OP, role, { slot: 1 }), true);
      r.a.setVolumes(silent);
      assert.equal(r.a.voice(OP2, role, { slot: 1 }), false, 'nothing is requested meanwhile');
      release();
      await r.at(i * 1000 + 500);
      r.a.setVolumes(back);
    }
    assert.deepEqual(r.played(), []);
    await r.at(3000);
    r.a.voice(OP2, 'deploy');
    await r.at(3100);
    assert.deepEqual(r.played(), [['deploy', OP2, 3000]]);
  });

  test('a hidden page says nothing: the line playing stops, and none starts until the page shows again', async (t) => {
    const r = voiceRig(t);
    r.a.voice(OP, 'deploy');
    await r.at(500);
    r.hide();
    assert.equal(r.a.voice(OP2, 'deploy'), false);
    await r.at(1000);
    r.show();
    assert.equal(r.a.voice(OP, 'select'), true, 'the 部署 line was stopped: a 选中 line may start');
    await r.at(1100);
    assert.deepEqual(r.played(), [['deploy', OP, 0], ['select', OP, 1000]]);
  });

  test('a line still loading when the page is hidden never plays, not even once the page shows again', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '023'));
    r.a.voice(OP, 'deploy');
    await r.at(500);
    r.hide();
    await r.at(1000);
    r.show();
    release();
    await r.at(1500);
    assert.deepEqual(r.played(), []);
  });

  test('a saved language the site lacks falls back to the one it has; 关闭 says nothing; hasVoice follows the language played', async (t) => {
    const jpOnly = { audio: { voiceRules: manifest.audio.voiceRules, voice: { jp: { [OP]: { select: [line(OP, '021', 'jp')] } } } } };
    const r = voiceRig(t, { m: jpOnly });
    assert.equal(r.a.hasVoice(OP, 'select'), true, '中文 saved, only 日文 on the site');
    assert.equal(r.a.hasVoice(OP, 'start'), false);
    assert.equal(r.a.hasVoice(AUX, 'select'), false, 'a voiceless operator');
    assert.equal(r.a.voice(OP, 'select'), true);
    await r.at(100);
    r.a.setVolumes({ voiceLang: 'off' });
    assert.equal(r.a.voice(OP, 'select'), false);
    assert.deepEqual(r.fetched, [line(OP, '021', 'jp')]);
    assert.deepEqual(r.played(), [['select', OP, 0]]);
  });
});

// =====================================================================================================================
// 漏怪 sound (user request "接下来加漏怪的音效", then "应该是原版明日方舟关卡中的怪进蓝门的音效"). The sim emits
// `['leak', id]` when an enemy reaches its goal (Battle.leak) — NOT a `die` — so until now an escape was completely
// silent, for the player's own field and for a 联防 the helpers could not hold alike.
//
// The cue is the ORIGINAL Arknights stage alarm an enemy entering the exit plays in any normal stage: the manifest's
// `sfx.battle.leak`, bank `battle.ON_ENEMY_REACHED_EXIT`, file `Battle/b_ui/b_ui_alarmenter`. (The autochess banks
// have nothing named for an escape — all 13,948 SFX banks searched — but the stage itself does.) The official bank is
// a one-shot: `maxSoundAllowed: 1` with `popOldest: true` on the `Battle_UI_Important` mixer.

describe('漏怪 sound', () => {
  async function rig() {
    const fw = fakeWindow();
    const urls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
    a.install();
    fw.fire('pointerdown');
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { a, fw, urls, settle, restore: () => { globalThis.fetch = origFetch; } };
  }

  test('an escaped enemy plays the original stage exit alarm — and no death sound (a leak is not a `die`)', async () => {
    const { a, urls, settle, restore } = await rig();
    try {
      const url = manifest.audio.sfx.battle.leak;
      assert.ok(url, '前提：清单里有 sfx.battle.leak');
      assert.match(url, /b_ui_alarmenter\.mp3$/, '就是原版关卡里怪进蓝门那一声');
      a.handleBattleEvents([['leak', 7]]);
      await settle();
      assert.ok(asked(urls, url), `漏怪 plays ${url}`);
      assert.equal(askedCount(urls, manifest.audio.sfx.battle.enemyDie), 0, 'a leak is not a death — no death sound');
    } finally { restore(); }
  });

  test('leaks of one disaster are ONE alarm (the cue is 1.44 s long), a later one rings again', async () => {
    const { a, fw, urls, settle, restore } = await rig();
    try {
      const url = manifest.audio.sfx.battle.leak;
      a.handleBattleEvents([['leak', 1]]);
      await settle();
      assert.equal(askedCount(urls, url), 1, 'the first escape rings');
      // the plays themselves, not the fetches: the buffer is cached after the first one
      const before = fw.made.started;
      // six more at once — a wiped board, or a 联防 the helpers could not hold
      a.handleBattleEvents([['leak', 2], ['leak', 3], ['leak', 4], ['leak', 5], ['leak', 6], ['leak', 7]]);
      await settle();
      assert.equal(fw.made.started - before, 0, 'one disaster never stacks alarms (the official bank allows 1)');
      // a genuine later leak is a new disaster and rings again, once the cue (1.44 s) has finished
      await new Promise((r) => setTimeout(r, 1600));
      a.handleBattleEvents([['leak', 8]]);
      await settle();
      assert.equal(fw.made.started - before, 1, 'a later leak rings again');
      assert.ok(a.limiter.active <= a.limiter.maxVoices);
    } finally { restore(); }
  });

  test('a field\'s early buffer (replayEarly: what came before it was entered) plays no sound effect — no deploy, death or alarm', async () => {
    const { a, fw, urls, settle, restore } = await rig();
    try {
      a.setVolumes({ voiceLang: 'off' }); // the voice part (行动出发) is the operator voice suite's
      const op = { id: 1, side: 'ally', kind: 'chess', spine: Object.keys(manifest.audio.voice?.cn || { char_002_amiya: 1 })[0], defId: 'chess_x' };
      const en = { id: 2, side: 'enemy', kind: 'enemy', spine: 'enemy_1007_slime' };
      a.setFieldUnits([], { fieldId: 'n:me', battleId: 'b1' });
      a.replayEarly([['spawn', op], ['deploy', 1], ['spawn', en], ['die', 2, 'killed'], ['leak', 3], ['skill', 1, 1]]);
      await settle();
      assert.deepEqual(urls, [], 'nothing fetched');
      assert.equal(fw.made.started, 0, 'nothing played');
      assert.equal(a.units.size, 2, 'its spawns fill the unit map');
      a.handleBattleEvents([['leak', 4]]);
      await settle();
      assert.ok(asked(urls, manifest.audio.sfx.battle.leak), 'a live leak after it rings');
    } finally { restore(); }
  });

  // fork: the alarm belongs to the field on screen, and the screen can change field mid-burst — the ‹ 联防阵地 N › switch
  // of a 5–8 player 联防 (DESIGN §24.4), a spectator or an eliminated player picking another field. A switch is a new
  // unit map (setFieldUnits), never a second alarm on top of the one still ringing.
  test('a field switch mid-burst keeps the one-alarm gap (several 联防 fields, a spectator switching)', async () => {
    const { a, fw, urls, settle, restore } = await rig();
    const perf = globalThis.performance;
    let fakeNow = 1000;
    globalThis.performance = { now: () => fakeNow };
    try {
      const url = manifest.audio.sfx.battle.leak;
      a.setFieldUnits([{ id: 1, side: 'enemy', kind: 'enemy', spine: 'enemy_1007_slime' }]);
      a.handleBattleEvents([['leak', 1]]);
      await settle();
      assert.equal(askedCount(urls, url), 1, 'the first escape rings');
      const before = fw.made.started;
      fakeNow += 500;
      a.setFieldUnits([{ id: 9, side: 'enemy', kind: 'enemy', spine: 'enemy_1007_slime' }]); // another 联防 field on screen
      a.handleBattleEvents([['leak', 9]]);
      await settle();
      assert.equal(fw.made.started - before, 0, 'the other field\'s leak 0.5 s later shares the alarm still ringing');
      fakeNow += 1100;
      a.handleBattleEvents([['leak', 10]]);
      await settle();
      assert.equal(fw.made.started - before, 1, 'past the cue it rings again');
    } finally { globalThis.performance = perf; restore(); }
  });
});
