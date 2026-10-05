// Audio manager (public/js/audio.js): BGM selection, manifest resolution, SFX limiter, the manager's never-throw
// behaviour with a fake Web Audio implementation, and which operator voice line plays when.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bgmKeyFor, resolveBgm, SfxLimiter, AudioManager, normalAttackSfx, voiceUrl, voiceLangsIn, endVoiceRole,
  voiceRulesOf, voiceMayStart, voiceBattleKey } from '../../public/js/audio.js';
import { mediaUrl } from '../../public/js/media.js';
import { createStore, initialState, emptyMatch } from '../../public/js/store.js';
import { voiceLeader } from '../../public/js/ui/gameLogic.js';
import { PHASE } from '../../shared/constants.js';

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


describe('operator voice', () => {
  const LEADER = 'char_8_lead';
  const OP = 'char_9_op';
  const OP2 = 'char_7_op';
  const ROLE_OF = { '020': 'start', '021': 'select', '022': 'select', '023': 'deploy', '025': 'combat', '030': 'win3', '031': 'win', '032': 'fail' };
  const line = (op, n, lang = 'cn') => `/assets/voice/${lang}/${op}/cn_${n}.mp3`;
  const lines = (op) => ({
    select: [line(op, '021')], deploy: [line(op, '023')], combat: [line(op, '025')],
    start: line(op, '020'), win3: line(op, '030'), win: line(op, '031'), fail: line(op, '032'),
  });
  // three operators' lines, with the shipped rules (data/assets.json audio.voiceRules)
  const vm = { audio: { voiceRules: manifest.audio.voiceRules, voice: { cn: { [LEADER]: lines(LEADER), [OP]: lines(OP), [OP2]: lines(OP2) } } } };

  test('voiceUrl picks a line of the role (arrays at random); voiceLangsIn lists the languages the manifest has', () => {
    const m = { audio: { voice: { cn: { [OP]: { select: [line(OP, '021'), line(OP, '022')], start: line(OP, '020') } }, jp: { [OP]: { select: [line(OP, '021', 'jp')] } } } } };
    assert.equal(voiceUrl(m, 'cn', OP, 'start'), line(OP, '020'));
    assert.equal(voiceUrl(m, 'cn', OP, 'select', () => 0), line(OP, '021'));
    assert.equal(voiceUrl(m, 'cn', OP, 'select', () => 0.99), line(OP, '022'));
    assert.equal(voiceUrl(m, 'jp', OP, 'start'), null);
    assert.equal(voiceUrl(null, 'cn', OP, 'select'), null);
    assert.deepEqual(voiceLangsIn(m).map(([k]) => k), ['cn', 'jp']);
    assert.deepEqual(voiceLangsIn({ audio: { voice: { jp: { [OP]: {} } } } }).map(([k]) => k), ['jp']);
  });

  test('the rules are data/assets.json audio.voiceRules (the official battleVoice) plus the end lines', () => {
    const r = voiceRulesOf(manifest);
    assert.equal(r.encounterDelay, 3);
    assert.equal(r.crossfade, 0.1);
    assert.deepEqual(r.types.ENCOUNTER_ENEMY, { priority: 90, overlap: false, cooldown: 0 }, '行动开始');
    assert.deepEqual(r.types.SKILL_PASSIVE_IMP, { priority: 60, overlap: false, cooldown: 10 }, '作战中');
    assert.deepEqual(r.types.PLACE_CHAR, { priority: 20, overlap: true, cooldown: 0 }, '部署');
    assert.deepEqual(r.types.FOCUS_CHAR, { priority: 10, overlap: true, cooldown: 0 }, '选中干员');
    assert.deepEqual(r.types.RESULT, { priority: 100, overlap: true, cooldown: 0 }, 'the end lines');
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
    assert.equal(voiceMayStart(types.RESULT, { priority: 90 }, undefined, 0), true, 'the end line over anything');
  });

  test('endVoiceRole: 行动失败 when lost, 3星结束行动 only without own LP lost over the match', () => {
    const players = [{ playerId: 'me', stats: { lpLost: 0 } }, { playerId: 'mate', stats: { lpLost: 5 } }];
    assert.equal(endVoiceRole({ victory: false, players }, 'me'), 'fail');
    assert.equal(endVoiceRole({ victory: true, players }, 'me'), 'win3');
    assert.equal(endVoiceRole({ victory: true, players }, 'mate'), 'win');
  });

  test('voiceBattleKey: the own battles that open with 行动开始 (not 联防, not once eliminated, not a spectator)', () => {
    const s = (phase, players = [{ playerId: 'me', alive: true }], me = 'me') => ({ me: { playerId: me }, match: { public: { phase, round: 3, players } } });
    assert.equal(voiceBattleKey(s(PHASE.COMBAT)), 'COMBAT:3');
    assert.equal(voiceBattleKey(s(PHASE.FINAL_ASSAULT)), 'FINAL_ASSAULT:3');
    assert.equal(voiceBattleKey(s(PHASE.HIDDEN_CORE)), 'HIDDEN_CORE:3');
    assert.equal(voiceBattleKey(s(PHASE.UNITE)), null, '联防 goes on with the round\'s battle');
    assert.equal(voiceBattleKey(s(PHASE.PREP)), null);
    assert.equal(voiceBattleKey(s(PHASE.COMBAT, [{ playerId: 'me', alive: false }])), null, 'eliminated');
    assert.equal(voiceBattleKey(s(PHASE.COMBAT, [{ playerId: 'p1', alive: true }], 'watcher')), null, 'a spectator');
    assert.equal(voiceBattleKey({ me: { playerId: 'me' }, match: { public: null } }), null);
  });

  // ---- one client, on a virtual clock -----------------------------------------------------------------------

  // aux: 盟约·辅助干员, the pool's operator without voice lines
  const CHESS = { lead: { charId: LEADER, rarity: 6 }, op: { charId: OP, rarity: 5 }, op2: { charId: OP2, rarity: 4 },
    aux: { charId: 'char_616_pithst', rarity: 4 } };
  const getChess = (id) => CHESS[id] ?? null;

  /**
   * A player's client on a virtual clock (mock timers; performance.now follows the mocked Date): the store fed as
   * main.js feeds it from m.public / m.private / m.result and followed as installAudio follows it, battle events as
   * game.js forwards them, the page's visibility, and the voice lines that actually start (a fake Web Audio graph;
   * every line lasts 2 s). The board's rarest operator, LEADER, is the squad leader.
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
    const a = new AudioManager({ win, getManifest: () => m, getPlayerId: () => store.get().me.playerId,
      getLeader: () => voiceLeader(store.get().match.private, getChess) });
    a.install();
    winOn.get('pointerdown')();
    store.subscribe((s, prev) => a.followMatch(s, prev));
    const board = (...ids) => store.patch('match', { private: { board: ids.map((id, i) => ({ uid: i + 1, kind: 'chess', id, row: 10, col: i })) } });
    // the battle field as game.js tracks it on entering: own operators, a teammate's, an enemy, an own summon
    const units = () => a.setFieldUnits([
      { id: 1, side: 'ally', kind: 'chess', spine: LEADER, defId: 'lead', ownerId: 'me' },
      { id: 2, side: 'ally', kind: 'chess', spine: OP, defId: 'op', ownerId: 'me' },
      { id: 3, side: 'ally', kind: 'chess', spine: OP2, defId: 'op2', ownerId: 'me' },
      { id: 4, side: 'ally', kind: 'chess', spine: OP, defId: 'op', ownerId: 'mate' },
      { id: 5, side: 'enemy', kind: 'enemy', spine: OP2 },
      { id: 6, side: 'ally', kind: 'token', spine: OP2, defId: 'token_x', ownerId: 'me' },
    ]);
    board('lead', 'op', 'op2');
    units();
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    return {
      a, store, net, fetched, board, units,
      /** m.public of a phase (the own player alive unless said otherwise). */
      phase: (phase, round, alive = true) => store.patch('match', { public: { phase, round, players: [{ playerId: 'me', alive }] } }),
      result: (result) => store.patch('match', { result }),
      enemy: (id = 50) => a.handleBattleEvents([['spawn', { id, side: 'enemy', kind: 'enemy', spine: 'enemy_x' }]]),
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
      /** The voice lines started so far: [role, charId, ms]. */
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

  test('行动开始 at the first enemy, 3 s into the battle at the earliest; 作战中 waits for it, then one per 10 s', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(2000);
    r.skill(2); // operators cast from the first second: held until 行动开始
    await r.at(3500);
    r.skill(2); // 行动开始 is playing
    await r.at(5500);
    r.skill(2);
    await r.at(6000);
    r.skill(3); // one 作战中 never cuts another
    await r.at(8000);
    r.skill(3); // within 10 s of the last 作战中
    await r.at(15600);
    r.skill(3);
    await r.at(16000);
    assert.equal(r.a.voice(OP, 'select'), false, 'a tap never cuts a 作战中');
    await r.at(18000);
    assert.equal(r.a.voice(OP, 'select'), true);
    await r.at(18100);
    assert.deepEqual(r.played(), [['start', LEADER, 3000], ['combat', OP, 5500], ['combat', OP2, 15600], ['select', OP, 18000]]);
  });

  test('only own operators speak: a teammate\'s operator (a shared or watched field), an enemy or a summon says nothing', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(16000); // no enemy: the opening is over, 作战中 is free
    r.skill(4);
    r.skill(5);
    r.skill(6);
    await r.at(16500);
    r.skill(2);
    await r.at(17000);
    assert.deepEqual(r.played(), [['combat', OP, 16500]]);
  });

  test('a battle that faces no enemy says no 行动开始; 作战中 waits for it 15 s at most', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.skill(2);
    await r.at(14900);
    r.skill(2);
    await r.at(15000);
    r.skill(2);
    await r.at(15100);
    assert.deepEqual(r.played(), [['combat', OP, 15000]]);
  });

  test('a squad leader without voice lines says no 行动开始; 作战中 waits only until it was due', async (t) => {
    const r = voiceRig(t);
    r.board('aux');
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(3500);
    r.skill(2);
    await r.at(4000);
    assert.deepEqual(r.played(), [['combat', OP, 3500]]);
  });

  test('a tab hidden before the first enemy keeps the battle\'s 行动开始, and 作战中 still waits for it', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.hide();
    await r.at(800);
    r.show();
    await r.at(1000);
    r.enemy();
    await r.at(2000);
    r.skill(2);
    await r.at(5500);
    r.skill(2);
    await r.at(6000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000], ['combat', OP, 5500]]);
  });

  test('行动开始 that comes due on a hidden page is said on return, within the battle\'s opening', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(2500);
    r.hide();
    await r.at(4000);
    r.show();
    await r.at(4100);
    assert.deepEqual(r.played(), [['start', LEADER, 4000]]);
  });

  test('a page hidden for the whole opening says no late 行动开始; 作战中 then plays', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    r.hide();
    await r.at(1000);
    r.enemy(); // a server-run battle streams its events to a hidden page
    await r.at(16000);
    r.show();
    await r.at(16500);
    r.skill(2);
    await r.at(17000);
    assert.deepEqual(r.played(), [['combat', OP, 16500]]);
  });

  test('a solo pause holds the battle\'s opening: 行动开始 and the wait of 作战中 go on after it', async (t) => {
    const r = voiceRig(t);
    const pause = (paused) => r.store.patch('match', { public: { ...r.store.get().match.public, paused } });
    r.phase(PHASE.COMBAT, 1);
    await r.at(500);
    pause(true);
    await r.at(30500);
    pause(false);
    await r.at(31000);
    r.enemy();
    await r.at(31500);
    r.skill(2);
    await r.at(34000);
    assert.deepEqual(r.played(), [['start', LEADER, 33000]]);
  });

  test('a re-mounted battle screen (its field entered again, spawns replayed) neither repeats nor loses 行动开始', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.units(); // re-mounted before the first enemy
    r.phase(PHASE.COMBAT, 1); // m.public sent again (a resync)
    await r.at(1500);
    r.enemy(50);
    await r.at(2000);
    r.skill(2);
    await r.at(6000);
    r.units(); // re-mounted after 行动开始: the battle's early spawns are replayed
    r.enemy(50);
    await r.at(10000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000]]);
  });

  test('a match cleared from the screen keeps its battle: 行动开始 is said once across a reconnect past the restore grace', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(2000);
    r.store.set({ match: emptyMatch() }); // no m.public within the restore grace: back to the room
    await r.at(4000);
    r.board('lead', 'op', 'op2');
    r.phase(PHASE.COMBAT, 1); // the match is pushed again
    await r.at(4500);
    r.units();
    r.enemy(); // the battle's spawns seen again
    await r.at(6000);
    r.store.set({ match: emptyMatch() });
    r.phase(PHASE.COMBAT, 1);
    await r.at(6500);
    r.enemy();
    await r.at(10000);
    assert.deepEqual(r.played(), [['start', LEADER, 4500]], 'not in the room, once after the return');
  });

  test('a battle left for the lobby is over for the next match, even one whose first battle has the same round', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(4000);
    r.store.set({ room: null, match: emptyMatch() }); // 放弃模拟
    await r.at(10000);
    r.phase(PHASE.INFO_CHECK, 0); // the next match
    r.board('lead');
    r.phase(PHASE.COMBAT, 1);
    await r.at(11000);
    r.enemy();
    await r.at(14000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000], ['start', LEADER, 13000]]);
  });

  test('leaving a battle drops its pending 行动开始 (none on the settle or result screen); every battle has its own', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(2000);
    r.phase(PHASE.SETTLE, 1); // over before its 行动开始 was due
    await r.at(10000);
    r.board('op', 'op2'); // the next prep changed the board: OP is the rarest now
    r.phase(PHASE.COMBAT, 2);
    await r.at(10500);
    r.enemy(51);
    await r.at(20000);
    r.phase(PHASE.FINAL_ASSAULT, 3);
    await r.at(20100);
    r.enemy(52);
    await r.at(24000);
    assert.deepEqual(r.played(), [['start', OP, 13000], ['start', OP, 23000]]);
  });

  test('the squad leader is the one on the board when 行动开始 is said (m.private after m.public, as after a reload)', async (t) => {
    const r = voiceRig(t);
    r.store.patch('match', { private: null });
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(2000);
    r.board('op', 'op2');
    await r.at(4000);
    assert.deepEqual(r.played(), [['start', OP, 3000]]);
  });

  test('a 作战中 still loading when its battle ends never plays', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '025'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(5500);
    r.skill(2);
    await r.at(5600);
    r.phase(PHASE.SETTLE, 1);
    release();
    await r.at(8000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000]]);
    assert.deepEqual(r.a.voiceLog.map((l) => l.role), ['start'], 'voiceLog lists the lines that started, not the ones requested');
  });

  test('the 作战中 cooldown runs from the start of the line that played (a slow load starts it late)', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(OP, '025'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(16000); // no enemy: the opening is over
    r.skill(2);
    await r.at(18000);
    release();
    await r.at(27900);
    r.skill(3);
    await r.at(28000);
    r.skill(3);
    await r.at(28100);
    assert.deepEqual(r.played(), [['combat', OP, 18000], ['combat', OP2, 28000]]);
  });

  test('the end line: once per match when m.result arrives, said by the leader who opened the latest battle', async (t) => {
    const r = voiceRig(t);
    r.phase(PHASE.COMBAT, 14);
    await r.at(1000);
    r.enemy();
    await r.at(6000);
    // the lost battle's settlement eliminates the player, and its board is cleared, before the result
    r.phase(PHASE.SETTLE, 14, false);
    r.board();
    r.phase(PHASE.RESULT, 14, false);
    r.result({ victory: false, players: [{ playerId: 'me', stats: { lpLost: 30 } }] });
    await r.at(7000);
    // a reconnect that went past the restore grace: the match is cleared, then the result comes again
    r.store.set({ match: emptyMatch() });
    r.phase(PHASE.RESULT, 14, false);
    r.result({ victory: false, players: [] });
    await r.at(10000);
    // the next match
    r.store.set({ match: emptyMatch() });
    r.board('op');
    r.phase(PHASE.COMBAT, 1);
    await r.at(11000);
    r.enemy();
    await r.at(20000);
    r.phase(PHASE.RESULT, 15);
    r.result({ victory: true, players: [{ playerId: 'me', stats: { lpLost: 0 } }] });
    await r.at(21000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000], ['fail', LEADER, 6000], ['start', OP, 13000], ['win3', OP, 20000]]);
  });

  test('an end line still loading when the player goes back to the room never plays there', async (t) => {
    const r = voiceRig(t);
    const release = holdFile(r, line(LEADER, '032'));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(6000);
    r.phase(PHASE.RESULT, 1);
    r.result({ victory: false, players: [] });
    await r.at(6500);
    r.store.set({ match: emptyMatch() }); // 返回房间
    release();
    await r.at(8000);
    assert.deepEqual(r.played(), [['start', LEADER, 3000]]);
  });

  test('a line that fails to load plays nothing, is logged and starts no cooldown', async (t) => {
    const r = voiceRig(t);
    const warn = t.mock.method(console, 'warn', () => {});
    const ok = r.net.respond;
    r.net.respond = (url) => (url === line(OP, '025') ? { ok: false, status: 503 } : ok(url));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(5500);
    r.skill(2);
    await r.at(6000);
    r.skill(3); // no cooldown from the line that never played
    await r.at(6100);
    assert.deepEqual(r.played(), [['start', LEADER, 3000], ['combat', OP2, 6000]]);
    assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes(line(OP, '025'))), 'the failure is logged');
  });

  test('a 行动开始 that failed to load plays in the next battle: a failed file is fetched again after a short backoff', async (t) => {
    const r = voiceRig(t);
    t.mock.method(console, 'warn', () => {});
    let down = true;
    const ok = r.net.respond;
    r.net.respond = (url) => (down && url === line(LEADER, '020') ? { ok: false, status: 503 } : ok(url));
    r.phase(PHASE.COMBAT, 1);
    await r.at(1000);
    r.enemy();
    await r.at(6000);
    r.phase(PHASE.SETTLE, 1);
    down = false;
    await r.at(30000);
    r.phase(PHASE.COMBAT, 2);
    await r.at(31000);
    r.enemy(51);
    await r.at(34000);
    assert.deepEqual(r.played(), [['start', LEADER, 33000]]);
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
      assert.equal(r.a.voice(OP, role), true);
      r.a.setVolumes(silent);
      assert.equal(r.a.voice(OP2, role), false, 'nothing is requested meanwhile');
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

  test('a saved language the site lacks falls back to the one it has; 关闭 says nothing', async (t) => {
    const jpOnly = { audio: { voiceRules: manifest.audio.voiceRules, voice: { jp: { [OP]: { select: [line(OP, '021', 'jp')] } } } } };
    const r = voiceRig(t, { m: jpOnly });
    assert.equal(r.a.voice(OP, 'select'), true, '中文 saved, only 日文 on the site');
    await r.at(100);
    r.a.setVolumes({ voiceLang: 'off' });
    assert.equal(r.a.voice(OP, 'select'), false);
    assert.deepEqual(r.fetched, [line(OP, '021', 'jp')]);
    assert.deepEqual(r.played(), [['select', OP, 0]]);
  });
});
