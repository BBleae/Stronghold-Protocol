// The 在线人数 readout next to the release version (ported from Jerryzhu1234510's fork, 4f4e848f): the pure formatting of
// public/js/ui/presence.js (in every interface language), the /healthz reader and its poll, the wiring the two screens,
// the store and main.js need. The frame itself is driven against a real server by test/presence.test.js; the browser
// view by test/ui/presence.e2e.test.js.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  presenceFacts, presenceLabel, presenceHint, fetchPresence, startPresencePoll, presencePushed, PRESENCE_POLL_MS,
  PRESENCE_FETCH_TIMEOUT_MS, UNKNOWN_PRESENCE,
} from '../../public/js/ui/presence.js';
import { initialState, createStore } from '../../public/js/store.js';
import { C2S, S2C } from '../../shared/protocol.js';
import { setLang, setMessages } from '../../shared/i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PACKS = ['en', 'ja', 'ko', 'zh-TW'];

afterEach(() => { setLang('zh'); for (const l of PACKS) setMessages(l, {}); });

/** A store with the slices the poll reads. */
const makeStore = (presence = UNKNOWN_PRESENCE, status = 'connected') => createStore({ ...initialState, presence, connection: { ...initialState.connection, status } });
const flush = () => new Promise((r) => setImmediate(r));

describe('presence readout (在线人数)', () => {
  test('presenceFacts keeps whole, non-negative numbers and reports the rest as unknown', () => {
    assert.deepEqual(presenceFacts({ online: 3, inRoom: 1 }), { online: 3, inRoom: 1 });
    assert.deepEqual(presenceFacts({ online: 0, inRoom: 0 }), { online: 0, inRoom: 0 }, 'zero is a known number');
    assert.deepEqual(presenceFacts({ online: 2.7, inRoom: -1 }), { online: 2, inRoom: null }, 'floored, negative → unknown');
    assert.deepEqual(presenceFacts({ online: '4', inRoom: NaN }), { online: null, inRoom: null }, 'only numbers count');
    assert.deepEqual(presenceFacts({ online: null }), { online: null, inRoom: null }, 'null from a server that does not know');
    assert.deepEqual(presenceFacts(null), { online: null, inRoom: null }, 'no frame yet');
    assert.deepEqual(presenceFacts(undefined), { online: null, inRoom: null });
    assert.deepEqual(presenceFacts({}), { online: null, inRoom: null });
  });

  test('presenceLabel names both counters and shows — while a number is unknown', () => {
    assert.equal(presenceLabel({ online: 3, inRoom: 1 }), '在线 3 人 · 房间内 1 人');
    assert.equal(presenceLabel({ online: 0, inRoom: 0, via: 'frame' }), '在线 0 人 · 房间内 0 人');
    assert.equal(presenceLabel(null), '在线 — 人 · 房间内 — 人');
    assert.equal(presenceLabel({ online: 5 }), '在线 5 人 · 房间内 — 人', 'a half-known frame still shows what it has');
  });

  test('the readout and its tooltip are translated in every shipped interface language', () => {
    for (const lang of PACKS) {
      const pack = JSON.parse(read(`public/i18n/${lang}.json`));
      setMessages(lang, pack);
      setLang(lang);
      const label = presenceLabel({ online: 12, inRoom: 3 });
      assert.notEqual(label, '在线 12 人 · 房间内 3 人', `${lang}: translated`);
      assert.match(label, /12/, `${lang}: ${label}`);
      assert.match(label, /3/, `${lang}: ${label}`);
      assert.match(presenceLabel(null), /—.*—/, `${lang}: unknown shows —`);
      assert.notEqual(presenceHint(), '本服务器当前的在线人数，以及其中在房间里（含观战）的人数', `${lang}: tooltip translated`);
    }
    setLang('en');
    assert.equal(presenceLabel({ online: 12, inRoom: 3 }), '12 online · 3 in rooms');
  });

  test('the frame is part of the protocol and main.js stores it as pushed', () => {
    assert.ok(S2C.includes('presence'), 'S2C lists presence');
    assert.equal(C2S.presence, undefined, 'presence is server → client only');
    const main = read('public/js/main.js');
    assert.match(main, /net\.on\('presence', \(msg\) => store\.set\(\{ presence: \{ \.\.\.presenceFacts\(msg\), via: 'frame' \} \}\)\)/, 'main.js stores the frame');
    assert.match(main, /import \{ presenceFacts \} from '\.\/ui\/presence\.js'/, 'main.js imports the helper');
  });

  test('the store carries a presence slice that starts unknown', () => {
    assert.deepEqual(initialState.presence, { online: null, inRoom: null, via: null });
    assert.deepEqual(initialState.presence, { ...UNKNOWN_PRESENCE });
  });

  test('both screens render the readout from the store and poll /healthz while they are up', () => {
    const title = read('public/js/screens/title.js');
    const lobby = read('public/js/screens/lobby.js');
    for (const [name, src] of [['title', title], ['lobby', lobby]]) {
      assert.match(src, /import \{ presenceLabel, presenceHint, usePresencePoll \} from '\.\.\/ui\/presence\.js'/, `${name}: imports the helper`);
      assert.match(src, /useStore\(\(s\) => s\.presence, shallowEqual\)/, `${name}: reads the presence slice`);
      assert.match(src, /usePresencePoll\(\);/, `${name}: polls while no frame comes`);
      assert.match(src, /presenceLabel\(presence\)/, `${name}: renders the stored numbers`);
      assert.match(src, /class="presence num"/, `${name}: renders the readout`);
      assert.match(src, /title=\$\{presenceHint\(\)\}/, `${name}: explains it`);
    }
    assert.match(title, /data-testid="title-presence"/);
    assert.match(lobby, /data-testid="lobby-presence"/);
    // the release version stays where test/version.test.js expects it, next to the counters
    assert.match(title, /v\$\{APP_VERSION\}/);
    assert.match(read('server/http/routes.js'), /\.\.\.lobby\.presence\(\)/, '/healthz serves the same counters');
    assert.ok(PRESENCE_POLL_MS >= 5000 && PRESENCE_POLL_MS <= 60_000, `a sane poll interval (${PRESENCE_POLL_MS} ms)`);
  });

  test('fetchPresence reads /healthz and answers unknown for anything that is not a good answer', async () => {
    const okFetch = async (url, init) => {
      assert.equal(url, '/healthz');
      assert.equal(init.cache, 'no-store');
      return { ok: true, json: async () => ({ ok: true, app: '0.2.1', online: 4, inRoom: 2 }) };
    };
    assert.deepEqual(await fetchPresence(okFetch), { online: 4, inRoom: 2 });
    // a healthz without the counters (an older server, a Worker that does not count) is unknown, not zero
    assert.deepEqual(await fetchPresence(async () => ({ ok: true, json: async () => ({ ok: true, sessions: 3 }) })), { online: null, inRoom: null });
    assert.deepEqual(await fetchPresence(async () => ({ ok: true, json: async () => ({ online: null, inRoom: null }) })), { online: null, inRoom: null });
    assert.equal(await fetchPresence(async () => ({ ok: false, status: 404, json: async () => ({}) })), null, '404 → unknown');
    assert.equal(await fetchPresence(async () => { throw new Error('offline'); }), null, 'a dead server → unknown');
    assert.equal(await fetchPresence(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), null, 'broken JSON → unknown');
    assert.equal(await fetchPresence(async () => ({ ok: true, json: async () => 'text' })), null, 'not an object → unknown');
    // a hanging answer is abandoned (its own timeout, which aborts the request), so the next poll is not queued behind it
    let aborted = false;
    const hang = (url, init) => { init.signal?.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); };
    const cleared = [];
    const r = await fetchPresence(hang, { timeoutMs: 10, clearTimeout: (h) => { cleared.push(h); clearTimeout(h); } });
    assert.equal(r, null, 'a slow server → unknown');
    assert.equal(aborted, true, 'the request is aborted');
    assert.equal(cleared.length, 1, 'its timer is cleared');
    assert.ok(PRESENCE_FETCH_TIMEOUT_MS >= 1000, 'the production timeout leaves room for a slow start');
  });

  test('startPresencePoll: reads now and every interval, marks the source, shows unknown on a failure', async () => {
    const st = makeStore();
    let answer = { online: 2, inRoom: 1 };
    let calls = 0;
    const fetchFn = async () => { calls++; return answer ? { ok: true, json: async () => answer } : { ok: false }; };
    let tick = null;
    const stop = startPresencePoll({ store: st, fetchFn, doc: null, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; } });
    await flush();
    assert.equal(calls, 1, 'one read at once');
    assert.deepEqual(st.get().presence, { online: 2, inRoom: 1, via: 'healthz' });
    answer = null;
    tick();
    await flush();
    assert.deepEqual(st.get().presence, { online: null, inRoom: null, via: 'healthz' }, 'a failed read is unknown, not stale');
    stop();
    assert.equal(tick, null, 'stop clears the interval');
  });

  test('startPresencePoll: no reads while the frames reach the page, or while the page is hidden', async () => {
    // a session that got the frame: the server pushes every change, nothing to poll
    const pushed = makeStore({ online: 5, inRoom: 2, via: 'frame' }, 'online');
    assert.equal(presencePushed(pushed.get()), true);
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ online: 9, inRoom: 9 }) }; };
    let tick = null;
    const stop = startPresencePoll({ store: pushed, fetchFn, doc: null, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {} });
    await flush();
    tick();
    await flush();
    assert.equal(calls, 0, 'no /healthz read while pushed');
    assert.deepEqual(pushed.get().presence, { online: 5, inRoom: 2, via: 'frame' });
    // the connection drops (or the account mode's room ends: status menu): the poll takes over
    pushed.set({ connection: { ...pushed.get().connection, status: 'reconnecting' } });
    tick();
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(pushed.get().presence, { online: 9, inRoom: 9, via: 'healthz' });
    stop();

    // a hidden tab asks nothing; becoming visible reads at once
    const listeners = {};
    const doc = { visibilityState: 'hidden', addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: (k) => { delete listeners[k]; } };
    const st = makeStore();
    calls = 0;
    const stop2 = startPresencePoll({ store: st, fetchFn, doc, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {} });
    await flush();
    tick();
    await flush();
    assert.equal(calls, 0, 'hidden: no reads');
    doc.visibilityState = 'visible';
    listeners.visibilitychange();
    await flush();
    assert.equal(calls, 1, 'visible again: one read at once');
    stop2();
    assert.equal(listeners.visibilitychange, undefined, 'stop removes the listener');
  });

  test('the readout has a style shared by both screens, with a phone floor (scaled by 文字大小, --t)', () => {
    assert.match(read('public/css/components.css'), /\.presence \{[^}]*font-size: max\(calc\(\.15 \* var\(--t\)\), 10px\)/, 'components.css styles .presence');
    assert.match(read('public/css/screens/title.css'), /\.title-foot \.presence \{ font-size: max\(calc\(\.13 \* var\(--t\)\), 10px\); \}/);
  });
});
