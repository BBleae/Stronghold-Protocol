// test/feedback7-voices.test.js — upstream 0.2.2's voice changes as the fork keeps them (merge of 2026-10-10,
// docs/design/fork.md §F7): tools/package.mjs FULL_ZIP_JP_VOICE decides whether the full zip ships the Japanese dub
// (the fork's audio.voice.jp; default: yes) — held back, its files are neither missing nor deleted by an update — and
// 选中干员 on every card tap (gameLogic cardVoiceKey). Upstream's audio.voiceJp tree and its 中文 / 日本語 setting are
// not used: the fork's voice engine has its own dubs (test/assets.test.js, test/ui/audio.test.js).
// Run: node --test test/feedback7-voices.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artPlan, FULL_ZIP_JP_VOICE, JP_VOICE_DIR } from '../tools/package.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('package: the full zip ships the JP dub by default; FULL_ZIP_JP_VOICE off holds it back (not missing, not an orphan, never removed by an update); the lite zip has no art', () => {
  assert.equal(FULL_ZIP_JP_VOICE, true, '0.2.2 ships both dubs in the full zip');
  assert.equal(JP_VOICE_DIR, 'public/assets/voice/jp/');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-voicejp-'));
  try {
    const cnRel = 'public/assets/voice/cn/char_263_skadi/cn_021.mp3';
    const jpRel = 'public/assets/voice/jp/char_263_skadi/cn_021.mp3';
    const jpRel2 = 'public/assets/voice/jp/char_263_skadi/cn_022.mp3';
    for (const rel of [cnRel, jpRel]) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'ID3'); }
    fs.mkdirSync(path.join(dir, 'data'));
    const url = (rel) => `/${rel.slice('public/'.length)}`;
    fs.writeFileSync(path.join(dir, 'data', 'assets.json'), JSON.stringify({ audio: {
      voice: { cn: { char_263_skadi: { select: url(cnRel) } }, jp: { char_263_skadi: { select: [url(jpRel), url(jpRel2)] } } } } }));
    const on = artPlan(dir);
    assert.ok(on.files.includes(cnRel) && on.files.includes(jpRel), 'both dubs ship');
    assert.deepEqual(on.missing, [jpRel2], 'a listed JP file not on disk is missing, like any art');
    assert.deepEqual(on.held, []);
    const off = artPlan(dir, { jpVoice: false });
    assert.ok(off.files.includes(cnRel), 'the Chinese dub ships');
    assert.ok(!off.files.includes(jpRel), 'the JP files stay out of the full zip');
    assert.deepEqual(off.held, [jpRel, jpRel2], 'held back on purpose (setup downloads them; an update never deletes them)');
    assert.deepEqual(off.missing, [], 'not missing');
    assert.deepEqual(off.orphans, [], 'not orphans either');
    assert.deepEqual(artPlan(dir, { lite: true }).files, [], 'the lite zip carries no art');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // the update zip keeps a held file out of `removed` (tools/package.mjs buildUpdate)
  const src = fs.readFileSync(path.join(ROOT, 'tools/package.mjs'), 'utf8');
  assert.match(src, /removable: \(rel\) => !removalProblem\(rel\) && !heldBack\.has\(rel\)/);
});

test('选中干员 on every card tap (review of fb7-voices): two shop / reward cards of one operator are two taps, a re-render is none', async () => {
  // shop / reward cards hand only the chess id to the detail target (no piece, no unit): game.js numbers every card it opens
  // (`tap`), resolveDetail keeps it, and the panel's 选中 key (selectVoiceKey) includes it — the second 斯卡蒂 card spoke
  // nothing before, nor replaced the first card's line (the pool deals duplicates)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop();
    let body;
    try { body = readJson(`data/${name}`); } catch { return { ok: false, status: 404, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const { resolveDetail } = await import('../public/js/ui/detailPanel.js');
    const { cardVoiceKey: selectVoiceKey } = await import('../public/js/ui/gameLogic.js');
    const { data } = await import('../public/js/data.js');
    await data.loadAll('chess', 'backups');
    const id = Object.values(readJson('data/chess.json')).find((c) => c.charId === 'char_263_skadi' && !c.isGolden).chessId;
    const card = (tap) => resolveDetail({ kind: 'chess', id, hint: null, tap }, new Map(), { priv: null });
    const a = card(1), b = card(2);
    assert.equal(a.chess.charId, 'char_263_skadi');
    assert.deepEqual([a.tap, b.tap], [1, 2], 'the tap rides along');
    assert.notEqual(selectVoiceKey(a), selectVoiceKey(b), 'the second card of the same operator is a new opening');
    assert.equal(selectVoiceKey(card(1)), selectVoiceKey(a), 'the same tap resolved again (a re-render) says nothing more');
    assert.equal(resolveDetail({ kind: 'chess', id }, new Map(), { priv: null }).tap, undefined, 'no tap, no field');
    // pieces and battle units keep their own identity; a non-operator card has no key
    assert.equal(selectVoiceKey({ type: 'chess', chess: { chessId: 'x' }, piece: { uid: 4 } }), 'card:x:4:');
    assert.equal(selectVoiceKey({ type: 'chess', chess: { chessId: 'x' }, unitId: 9 }), 'card:x:9:');
    assert.equal(selectVoiceKey({ type: 'item' }), null);
    assert.equal(selectVoiceKey(null), null);
    // the panel keys its 选中 effect on it, and the game screen numbers every operator card it opens
    // FORK: the game screen hands the panel gameLogic detailSelectVoice's { charId, key } (cardVoiceKey for a card)
    assert.match(fs.readFileSync(path.join(ROOT, 'public/js/ui/gameLogic/voice.js'), 'utf8'), /return \{ charId, key: cardVoiceKey\(resolved\) \};/);
    const game = fs.readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
    assert.match(game, /onDetail=\$\{\(id, kind, hint\) => setDetail\(\{ kind: kind === 'item' \? 'item' : 'chess', id, hint: hint \|\| null, tap: \+\+cardTap\.current \}\)\}/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
