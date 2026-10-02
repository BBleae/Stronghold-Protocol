// Audio manager (public/js/audio.js): BGM selection, manifest resolution, SFX limiter, and the manager's
// never-throw behaviour with a fake Web Audio implementation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bgmKeyFor, resolveBgm, SfxLimiter, AudioManager, normalAttackSfx, voiceUrl, voiceLangsIn, endVoiceRole } from '../../public/js/audio.js';
import { PHASE } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));

describe('bgm selection', () => {
  test('route and phase → key', () => {
    assert.equal(bgmKeyFor('title', null), 'lobby');
    assert.equal(bgmKeyFor('room', null), 'lobby');
    assert.equal(bgmKeyFor('game', null), 'lobby');
    assert.equal(bgmKeyFor('game', { phase: PHASE.INFO_CHECK }), 'lobby');
    assert.equal(bgmKeyFor('game', { phase: PHASE.PREP }), 'prep');
    assert.equal(bgmKeyFor('game', { phase: PHASE.SP_DRAFT }), 'prep');
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT }), 'combat');
    assert.equal(bgmKeyFor('game', { phase: PHASE.UNITE }), 'combat');
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT, bossId: 'boss_4' }), 'boss:boss_4');
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT }), 'boss');
    assert.equal(bgmKeyFor('game', { phase: PHASE.HIDDEN_CORE, bossId: 'boss_1', hiddenBossId: 'boss_9' }), 'boss:boss_9');
    assert.equal(bgmKeyFor('game', { phase: PHASE.RESULT }), 'lobby');
    assert.equal(bgmKeyFor('weird', null), null);
  });
  test('resolveBgm uses the manifest (boss fallback, intro optional)', () => {
    const lobby = resolveBgm(manifest, 'lobby');
    assert.ok(lobby && typeof lobby.loop === 'string');
    const b4 = resolveBgm(manifest, 'boss:boss_4');
    assert.equal(b4.loop, manifest.audio.bossBgm.boss_4.loop);
    assert.equal(resolveBgm(manifest, 'boss:nope').loop, manifest.audio.bgm.boss.loop);
    assert.equal(resolveBgm(manifest, 'prep').intro, manifest.audio.bgm.prep.intro ?? null);
    assert.equal(resolveBgm(null, 'lobby'), null);
    assert.equal(resolveBgm(manifest, null), null);
    assert.equal(resolveBgm(manifest, 'nope'), null);
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
    decodeAudioData(ab, ok) { ok({ duration: 1.5 }); }
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
      assert.ok(urls.includes(manifest.audio.bgm.prep.loop), 'BGM fetched after unlock');
      a.sfx('buy');
      a.sfx('nonexistent');
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(urls.includes(manifest.audio.sfx.ui.buy));
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
      assert.ok(urls.includes(manifest.audio.sfx.units[charId].attack));
      assert.ok(urls.includes(manifest.audio.sfx.battle.enemyDie), 'fallback death sound');
      assert.ok(a.limiter.active <= a.limiter.maxVoices);
      a.setVolumes({ muted: true });
      const n = urls.length;
      a.sfx('refresh');
      assert.equal(urls.length, n, 'muted ⇒ nothing requested');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
  test('fetch failures are swallowed', async () => {
    const fw = fakeWindow();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    const origWarn = console.warn;
    let warns = 0;
    console.warn = () => { warns++; };
    try {
      const a = new AudioManager({ win: fw.win, getManifest: () => manifest });
      a.install();
      fw.fire('keydown');
      a.playBgm('lobby');
      a.sfx('buy');
      a.sfx('buy');
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(warns >= 1);
    } finally {
      globalThis.fetch = origFetch;
      console.warn = origWarn;
    }
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
      const own = new Set(Object.values(manifest.audio.sfx.units[AGOAT2]).filter((x) => typeof x === 'string'));
      a.handleBattleEvents([['atk', 1, 2, 'orb'], ['heal', 2, 300], ['dmg', 2, 120, 'phys'], ['dmg', 2, 80, 'arts']]);
      await settle();
      assert.ok(urls.includes(manifest.audio.sfx.units[AGOAT2].attack), 'her cast sound');
      assert.ok(!urls.some((x) => x === manifest.audio.sfx.units[AGOAT2].hit), 'no impact sound of hers on the ally');
      assert.ok(!urls.some((x) => own.has(x) && /_s\.mp3$/.test(x)), 'nothing of her S3');
      // a hostile attack still authors its impact — once, and only for a real hit (not an element gauge fill)
      a.handleBattleEvents([['atk', 3, 2, 'none'], ['dmg', 2, 900, 'burn']]);
      await settle();
      assert.ok(!urls.includes(manifest.audio.sfx.units[enemyId].hit), 'a gauge fill is no impact');
      a.handleBattleEvents([['dmg', 2, 200, 'phys']]);
      await settle();
      assert.equal(urls.filter((x) => x === manifest.audio.sfx.units[enemyId].hit).length, 1, 'the impact');
      a.limiter.lastByUnit.clear(); a.limiter.lastByUrl.clear();
      a.handleBattleEvents([['dmg', 2, 50, 'phys']]);
      await settle();
      assert.equal(urls.filter((x) => x === manifest.audio.sfx.units[enemyId].hit).length, 1, 'a later tick is not the same attack\'s impact');
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
      assert.ok(!urls.includes(manifest.audio.sfx.units[enemyId].attack), 'the bounce is not an enemy attack');
      a.handleBattleEvents([['atk', 1, 5, 'arrow']]);
      fakeNow += 4000;
      a.handleBattleEvents([['dmg', 5, 100, 'phys']]);
      await settle();
      assert.ok(!urls.includes(manifest.audio.sfx.units[charId].hit), '4 s later: not that attack\'s impact');
    } finally { globalThis.performance = perf; restore(); }
  });
});

describe('operator voice', () => {
  const OP = 'char_9_test';
  const line = (lang, n) => `/assets/voice/${lang}/${OP}/cn_${n}.mp3`;
  const vm = {
    audio: {
      voice: {
        cn: { [OP]: { select: [line('cn', '021'), line('cn', '022')], deploy: [line('cn', '023')], combat: [line('cn', '025'), line('cn', '026')],
          start: line('cn', '020'), win3: line('cn', '030'), win: line('cn', '031'), fail: line('cn', '032') } },
        jp: { [OP]: { select: [line('jp', '021')] } },
      },
    },
  };

  test('voiceUrl picks a line of the role (arrays at random); voiceLangsIn lists the languages the manifest has', () => {
    assert.equal(voiceUrl(vm, 'cn', OP, 'start'), line('cn', '020'));
    assert.equal(voiceUrl(vm, 'cn', OP, 'select', () => 0), line('cn', '021'));
    assert.equal(voiceUrl(vm, 'cn', OP, 'select', () => 0.99), line('cn', '022'));
    assert.equal(voiceUrl(vm, 'jp', OP, 'start'), null);
    assert.equal(voiceUrl(vm, 'off', OP, 'select'), null);
    assert.equal(voiceUrl(null, 'cn', OP, 'select'), null);
    assert.deepEqual(voiceLangsIn(vm).map(([k]) => k), ['cn', 'jp']);
    assert.deepEqual(voiceLangsIn({ audio: { voice: { jp: { [OP]: {} } } } }).map(([k]) => k), ['jp']);
    assert.deepEqual(voiceLangsIn(manifest).filter(([k]) => k !== 'cn' && k !== 'jp'), []);
  });

  test('endVoiceRole: 3星结束行动 without LP lost, 非3星结束行动 with, 行动失败 at LP 0 or a lost match', () => {
    assert.equal(endVoiceRole({ lost: false, dead: false }), 'win3');
    assert.equal(endVoiceRole({ lost: true, dead: false }), 'win');
    assert.equal(endVoiceRole({ lost: true, dead: true }), 'fail');
    assert.equal(endVoiceRole({ lost: false }, true), 'win3');
    assert.equal(endVoiceRole({ lost: true }, true), 'win');
    assert.equal(endVoiceRole({ lost: false }, false), 'fail');
  });

  test('battleStart: the leader says 行动开始; battleEnd: its end line, once', async () => {
    const { a, urls, settle, restore } = await voiceRig();
    try {
      a.battleStart(OP, { lp: 30 });
      await settle();
      assert.deepEqual(urls, [line('cn', '020')]);
      a.battleVoice.lost = true;
      a.battleEnd();
      a.battleEnd({ victory: true });
      await settle();
      assert.deepEqual(urls, [line('cn', '020'), line('cn', '031')], '非3星结束行动, once');
      a.battleStart(OP);
      a.battleEnd({ victory: false });
      await settle();
      assert.equal(urls.at(-1), line('cn', '032'), 'the match was lost: 行动失败');
      const n = urls.length; // (the cached 行动开始 of the second battle fetched nothing)
      a.battleStart(null);
      a.battleEnd();
      await settle();
      assert.equal(urls.length, n, 'no operator on the board: silence');
    } finally { restore(); }
  });

  async function voiceRig(m = vm) {
    const fw = fakeWindow();
    const urls = [];
    const origFetch = globalThis.fetch;
    const perf = globalThis.performance;
    let now = 1000;
    globalThis.performance = { now: () => now };
    globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    const a = new AudioManager({ win: fw.win, getManifest: () => m });
    a.install();
    fw.fire('pointerdown');
    const settle = () => new Promise((r) => setTimeout(r, 5));
    return { a, urls, settle, advance: (ms) => { now += ms; }, restore: () => { globalThis.fetch = origFetch; globalThis.performance = perf; } };
  }

  test('one line at a time: a player action cuts the line, 作战中 never does', async () => {
    const { a, urls, settle, restore } = await voiceRig();
    try {
      assert.equal(a.voice(OP, 'start'), true);
      await settle();
      assert.ok(urls.includes(line('cn', '020')));
      assert.ok(a.voiceNow, 'playing');
      assert.equal(a.voice(OP, 'combat', { auto: true }), false, 'never over a playing line');
      assert.equal(a.voice(OP, 'deploy'), true, 'a player action cuts it');
      await settle();
      assert.ok(urls.includes(line('cn', '023')));
      a.stopVoice();
      assert.equal(a.voice(OP, 'combat', { auto: true }), true, 'silence: 作战中 plays');
      assert.equal(a.voice(OP, 'squad'), false, 'no such line');
      assert.equal(a.voice('char_other', 'select'), false, 'an operator without voice');
    } finally { restore(); }
  });

  test('作战中 never takes the place of a player\'s line that is still loading', async () => {
    const { a, urls, settle, restore } = await voiceRig();
    try {
      a.battleStart(OP);
      assert.equal(a.voice(OP, 'combat', { auto: true }), false, '行动开始 is loading');
      await settle();
      assert.deepEqual(urls, [line('cn', '020')]);
      assert.ok(a.voiceNow && !a.voiceNow.auto, '行动开始 plays');
    } finally { restore(); }
  });

  test('a skill start of an operator says 作战中; summons and enemies say nothing', async () => {
    const { a, urls, settle, restore } = await voiceRig();
    try {
      a.setFieldUnits([{ id: 1, side: 'ally', kind: 'chess', spine: OP }, { id: 2, side: 'enemy', kind: 'enemy', spine: OP },
        { id: 3, side: 'ally', kind: 'token', spine: 'token_x', defId: 'token_x' }]);
      a.handleBattleEvents([['skill', 2, true], ['skill', 3, true]]);
      await settle();
      assert.ok(!urls.some((u) => u.includes('/voice/')), 'enemy / summon: no voice');
      a.handleBattleEvents([['skill', 1, true]]);
      await settle();
      assert.ok(urls.some((u) => u === line('cn', '025') || u === line('cn', '026')), '作战中');
    } finally { restore(); }
  });

  test('language: off is silent; a language the site lacks falls back to the one it has', async () => {
    const { a, urls, settle, restore } = await voiceRig({ audio: { voice: { jp: vm.audio.voice.jp } } });
    try {
      a.setVolumes({ voiceLang: 'off' });
      assert.equal(a.voice(OP, 'select'), false);
      a.setVolumes({ voiceLang: 'cn' });
      assert.equal(a.voice(OP, 'select'), true);
      await settle();
      assert.deepEqual(urls, [line('jp', '021')]);
      a.setVolumes({ voice: 0 });
      assert.equal(a.voice(OP, 'select'), false, 'volume 0');
    } finally { restore(); }
  });
});
