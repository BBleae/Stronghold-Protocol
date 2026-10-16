// Per-operator dubs (设置 此干员语音; upstream 0.2.3 #440 ported onto the fork's voice engine, docs/design/fork.md §F7):
// public/js/voicePrefs.js keeps charId → a dub of the fork's voice tree (cn / jp / en / kr), and AudioManager._voiceUrl
// plays an operator in its own dub when the site has that line, else in the global 语音语言.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';
import { sanitizeVoiceOverrides, VOICE_LANGS, VOICE_PICKS } from '../../public/js/voicePrefs.js';
import { AudioManager, VOICE_LANGS as AUDIO_VOICE_LANGS } from '../../public/js/audio.js';
const a = 'char_263_skadi', b = 'char_103_angel';

test('the dubs are the fork voice tree\'s; old settings migrate to inherit, malformed or prototype entries are discarded', () => {
  assert.deepEqual([...VOICE_LANGS], AUDIO_VOICE_LANGS.map(([k]) => k), 'the same dubs as the 语音语言 setting');
  assert.deepEqual(sanitizeSettings({ voiceLang: 'jp' }).voiceOverrides, {});
  assert.deepEqual(sanitizeVoiceOverrides(Object.assign(Object.create({ [b]: 'jp' }), { [a]: 'jp', bad: 'cn', char_1_no: 'en', char_2_x: 'fr' })),
    { [a]: 'jp', char_1_no: 'en' });
  // upstream 0.3.0: an operator's own-language dub ('native') is a per-operator pick too
  assert.deepEqual(sanitizeVoiceOverrides({ [a]: 'en', [b]: 'native', char_9_kr: 'kr' }), { [a]: 'en', [b]: 'native', char_9_kr: 'kr' });
  assert.deepEqual([...VOICE_PICKS], ['cn', 'jp', 'en', 'kr', 'native']);
  for (const raw of [null, [], 1, 'jp']) assert.deepEqual(sanitizeVoiceOverrides(raw), {});
});

test('an operator speaks its own dub; a line that dub lacks, an unknown operator or a removed override follow the global setting', () => {
  const v = (lang, id) => `/assets/voice/${lang}/${id}/cn_021.mp3`;
  const manifest = { audio: { voice: {
    cn: { [a]: { select: v('cn', a) }, [b]: { select: v('cn', b) } },
    jp: { [a]: { select: v('jp', a) } },
  } } };
  const settings = sanitizeSettings(JSON.parse(JSON.stringify({ voiceLang: 'cn', voiceOverrides: { [a]: 'jp', [b]: 'jp' } })));
  const manager = new AudioManager({ getManifest: () => manifest });
  manager.setVolumes(settings);
  manager.setVoiceOverrides(settings.voiceOverrides);
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('jp', a), 'its own dub');
  assert.equal(manager._voiceUrl(manifest, b, 'select'), v('cn', b), 'a line its dub lacks: the global one');
  delete settings.voiceOverrides[a];
  manager.setVoiceOverrides(settings.voiceOverrides);
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('cn', a), 'the override removed: the global dub again');
  manager.setVolumes({ voiceLang: 'jp' });
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('jp', a), 'the global dub changed');
  assert.equal(manager._voiceUrl(manifest, 'char_x_unknown', 'select'), null);
  assert.ok(manager.hasVoice(a, 'select'), 'hasVoice follows the same lookup');
  assert.equal(manager.hasVoice(b, 'select'), false, 'no 日文 line of its own nor in the global 日文: silent, like the global setting alone');
});

test('本土语言 (upstream 0.3.0) on the fork engine: the own pick, then the own-language dub, then the global dub', () => {
  const v = (lang, id) => `/assets/voice/${lang}/${id}/cn_021.mp3`;
  const manifest = { audio: { voice: {
    cn: { [a]: { select: v('cn', a) }, [b]: { select: v('cn', b) } },
    en: { [a]: { select: v('en', a) }, [b]: { select: v('en', b) } },
    native: { [a]: { select: v('native', a) } },
  } } };
  const manager = new AudioManager({ getManifest: () => manifest });
  manager.setVolumes({ voiceLang: 'en' });
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('en', a), 'the switch off: the global dub');
  manager.setVoiceNative(true);
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('native', a), '本土语言 beats the global dub');
  assert.equal(manager._voiceUrl(manifest, b, 'select'), v('en', b), 'an operator without an own-language dub keeps the global one');
  manager.setVoiceOverrides({ [a]: 'cn' });
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('cn', a), "the operator's own pick wins over 本土语言");
  manager.setVoiceNative(false);
  manager.setVoiceOverrides({ [a]: 'native' });
  assert.equal(manager._voiceUrl(manifest, a, 'select'), v('native', a), 'an own native pick wins with the switch off');
  manager.setVoiceOverrides({ [b]: 'native' });
  assert.equal(manager._voiceUrl(manifest, b, 'select'), v('en', b), 'a native pick the operator lacks: the global dub');
});
