// The roster / DIY voice dropdown lists only the dubs this server has, names an own-language dub from the
// official voiceLangType, and still shows a saved choice whose tree is absent. FORK: the voice tree is
// audio.voice.<lang>.<charId> (tools/assets/voice.mjs), the language names are js/audio.js VOICE_LANGS'.
// Run: node --test test/ui/operator-voice.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorVoiceOptions } from '../../public/js/ui/operatorVoice.js';

const id = 'char_102_texas';
const cnOnly = { voice: { cn: { [id]: { select: ['/cn.mp3'] } } } };
const audio = {
  voice: {
    cn: { [id]: { select: ['/cn.mp3'] } },
    jp: { [id]: { select: ['/jp.mp3'] } },
    en: { [id]: { select: ['/en.mp3'] } },
    native: { [id]: { select: ['/n.mp3'] } },
  },
  voiceNativeLangType: { [id]: 'ITA' },
};

test('the dropdown lists 跟随全局 and only the dubs this operator has here', () => {
  const rows = operatorVoiceOptions(audio, id, '');
  assert.deepEqual(rows.map((r) => r.value), ['', 'cn', 'jp', 'en', 'native']);
  assert.equal(rows.find((r) => r.value === 'native').label, '意大利语');
  assert.equal(rows.find((r) => r.value === 'cn').label, '中文');
  assert.ok(rows.every((r) => !r.unavailable));
  assert.deepEqual(operatorVoiceOptions(cnOnly, id, '').map((r) => r.value), ['', 'cn']);
  assert.deepEqual(operatorVoiceOptions(null, id, '').map((r) => r.value), [''], 'assets not loaded: 跟随全局 only');
  assert.deepEqual(operatorVoiceOptions({}, 'char_616_pithst', '').map((r) => r.value), [''], 'a stand-in with no tree');
});

test('a saved choice this server lacks stays listed and is marked unavailable', () => {
  const rows = operatorVoiceOptions(cnOnly, id, 'kr');
  const saved = rows.find((r) => r.value === 'kr');
  assert.equal(saved.unavailable, true);
  assert.match(saved.label, /韩文/);
  assert.match(saved.label, /此服务器没有/);
  const native = operatorVoiceOptions(cnOnly, id, 'native').find((r) => r.value === 'native');
  assert.equal(native.unavailable, true);
  assert.match(native.label, /本土语言/);
});

test('an unknown own-language type falls back to 本土语言; a known one uses the official name', () => {
  const ger = { ...audio, voiceNativeLangType: { [id]: 'GER' } };
  assert.equal(operatorVoiceOptions(ger, id, '').find((r) => r.value === 'native').label, '德文');
  const unknown = { ...audio, voiceNativeLangType: { [id]: 'OTHER' } };
  assert.equal(operatorVoiceOptions(unknown, id, '').find((r) => r.value === 'native').label, '本土语言');
  for (const [type, name] of [['RUS', '俄文'], ['FRE', '法语'], ['SPA', '西班牙语'], ['CN_TOPOLECT', '中文-方言']]) {
    const tree = { ...audio, voiceNativeLangType: { [id]: type } };
    assert.equal(operatorVoiceOptions(tree, id, '').find((r) => r.value === 'native').label, name, type);
  }
});
