import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences } from '../../public/js/preferences.js';

const storage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
const timers = { setTimeout: () => 1, clearTimeout: () => {} };
function cloud() {
  const accounts = new Map(),
    calls = [];
  return {
    accounts,
    calls,
    forAccount: (accountId) => async (body) => {
      calls.push(body);
      if (body && (!body.initialize || !accounts.has(accountId)))
        accounts.set(accountId, { ...(accounts.get(accountId) || {}), ...body.patch });
      return { accountId, preferences: accounts.get(accountId) ?? null };
    },
  };
}
const client = (local, request) => createPreferences({ storage: () => local, request, timers });

test('first login migrates only selected preferences; a clean second device restores them', async () => {
  const local = storage(),
    server = cloud();
  const expected = {
    loadout: { v: 1, entries: { chess_test: { skill: 0, module: 'none' } } },
    'lobby.mode': 'solo',
    'lobby.difficulty': 'HARD',
    recentRooms: ['ABCD'],
    emoteTheme: 'emoticon_originium_slug',
  };
  for (const [key, value] of Object.entries({ ...expected, settings: { muted: true } }))
    local.setItem('sp.pref.' + key, JSON.stringify(value));
  const first = client(local, server.forAccount('a'));
  await first.start('a');
  assert.deepEqual(server.accounts.get('a'), expected);
  const second = client(storage(), server.forAccount('a'));
  await second.start('a');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(second.load(key, null), value);
  assert.equal(second.load('settings', null), null);
  second.save('lobby.difficulty', 'ABYSS');
  await second.flush();
  assert.equal(server.accounts.get('a')['lobby.difficulty'], 'ABYSS');
  assert.deepEqual(server.accounts.get('a').loadout, expected.loadout);
  second.save('loadout', { v: 1, entries: {} });
  await second.flush();
  assert.deepEqual(server.accounts.get('a').loadout, { v: 1, entries: {} });
});

test('cloud wins over old local values; switching accounts cannot migrate someone else’s choices', async () => {
  const local = storage(),
    server = cloud();
  local.setItem('sp.pref.lobby.mode', '"solo"');
  server.accounts.set('a', { 'lobby.mode': 'coop' });
  await client(local, server.forAccount('a')).start('a');
  const b = client(local, server.forAccount('b'));
  await b.start('b');
  assert.equal(b.load('lobby.mode', 'coop'), 'coop');
  assert.deepEqual(server.accounts.get('b'), {});
  const again = client(local, server.forAccount('a'));
  await again.start('a');
  assert.equal(again.load('lobby.mode', null), 'coop');
});

test('offline edits survive reload, recovery merges cloud fields, and account mismatch never sends edits', async () => {
  const local = storage(),
    server = cloud();
  server.accounts.set('a', { 'lobby.mode': 'solo', emoteTheme: 'emoticon_originium_slug' });
  const down = client(local, async () => {
    throw new Error('offline');
  });
  await down.start('a');
  down.save('lobby.difficulty', 'HARD');
  await down.flush();
  const recovered = client(local, server.forAccount('a'));
  await recovered.start('a');
  await recovered.flush();
  assert.deepEqual(server.accounts.get('a'), {
    'lobby.mode': 'solo',
    'lobby.difficulty': 'HARD',
    emoteTheme: 'emoticon_originium_slug',
  });
  const writes = [];
  const mismatch = client(local, async (body) => {
    writes.push(body);
    return { accountId: 'b', preferences: {} };
  });
  await mismatch.start('a');
  mismatch.save('lobby.mode', 'coop');
  await mismatch.flush();
  assert.equal(writes.filter(Boolean).length, 0);
});

test('a newer edit during a save is sent afterwards and a failed save retries', async () => {
  const server = cloud(),
    local = storage();
  server.accounts.set('a', {});
  let release,
    fail = false;
  const c = client(local, async (body) => {
    if (body && !release)
      await new Promise((resolve) => {
        release = resolve;
      });
    if (fail) {
      fail = false;
      throw new Error('offline');
    }
    return server.forAccount('a')(body);
  });
  await c.start('a');
  c.save('lobby.difficulty', 'NORMAL');
  const saving = c.flush();
  await Promise.resolve();
  c.save('lobby.difficulty', 'ABYSS');
  release();
  await saving;
  assert.equal(server.accounts.get('a')['lobby.difficulty'], 'ABYSS');
  fail = true;
  c.save('lobby.mode', 'solo');
  await c.flush();
  assert.equal(c.status, 'error');
  await c.flush();
  assert.equal(server.accounts.get('a')['lobby.mode'], 'solo');
  assert.equal(c.status, 'synced');
});

test('guest/local mode keeps ordinary preferences usable without network or storage', async () => {
  const local = storage(),
    c = client(local, () => assert.fail('guest must not use account API'));
  c.save('settings', { muted: true });
  c.save('lobby.mode', 'solo');
  assert.deepEqual(c.load('settings', null), { muted: true });
  assert.equal(c.load('lobby.mode', null), 'solo');
  const noStorage = createPreferences({
    storage: () => {
      throw new Error('disabled');
    },
    timers,
  });
  assert.doesNotThrow(() => noStorage.save('settings', { muted: true }));
});

test('repeated outages notify once, and late recovery updates preference subscribers', async () => {
  const server = cloud(),
    notifications = [],
    changes = [];
  server.accounts.set('a', { 'lobby.mode': 'solo' });
  let offline = true;
  const c = createPreferences({
    storage: () => storage(),
    timers,
    onError: (e) => notifications.push(e.message),
    request: (body) => {
      if (offline) throw new Error('offline');
      return server.forAccount('a')(body);
    },
  });
  c.subscribe((key) => changes.push(key));
  await c.start('a');
  await c.flush();
  await c.flush();
  assert.equal(notifications.length, 1);
  changes.length = 0;
  offline = false;
  await c.flush();
  assert.ok(changes.includes('lobby.mode'));
  assert.equal(c.load('lobby.mode', null), 'solo');
});

// ---- the 干员调配 overlay's other two settings: 自选编队 (sp.pref.diy) and 干员持有 (sp.pref.ownership) ------------------

test('the 自选编队 picks and the 干员持有 list follow the account in their stored forms', async () => {
  const local = storage(),
    server = cloud();
  const diy = { v: 1, picks: { chess_char_6_diy1_a: { charId: 'char_003_kalts', skillIndex: 2, uniEquipId: null } } };
  local.setItem('sp.pref.diy', JSON.stringify(diy));
  // an older build stored the 干员持有 list as a bare array: it moves to the account in today's envelope
  local.setItem('sp.pref.ownership', JSON.stringify(['chess_char_3_05_a', 'chess_char_3_01_a']));
  const first = client(local, server.forAccount('a'));
  await first.start('a');
  assert.deepEqual(server.accounts.get('a').diy, diy);
  assert.deepEqual(server.accounts.get('a').ownership, { v: 1, notOwned: ['chess_char_3_01_a', 'chess_char_3_05_a'] });
  const second = client(storage(), server.forAccount('a'));
  await second.start('a');
  assert.deepEqual(second.load('diy', null), diy);
  second.save('ownership', { v: 1, notOwned: [] });
  await second.flush();
  assert.deepEqual(server.accounts.get('a').ownership, { v: 1, notOwned: [] });
});

test('preferenceSchema: diy / ownership are checked structurally (the Worker uses the same schema); 外援 is gone', async () => {
  const { PREFERENCE_KEYS, validPreference, validatePreferencePatch } = await import('../../public/js/preferenceSchema.js');
  assert.ok(PREFERENCE_KEYS.includes('diy') && PREFERENCE_KEYS.includes('ownership'));
  assert.ok(!PREFERENCE_KEYS.includes('waiguan'), 'the 外援 / 甄选 picks were replaced by 自选编队');
  assert.equal(validPreference('waiguan', { v: 1, picks: { diy6a: 'char_003_kalts' } }), false);
  // 自选编队
  assert.equal(validPreference('diy', { v: 1, picks: {} }), true);
  assert.equal(validPreference('diy', { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_601_cguard' } } }), true);
  assert.equal(validPreference('diy', { v: 1, picks: { chess_char_6_diy2_a: { charId: 'char_003_kalts', skillIndex: 0, uniEquipId: 'uniequip_002_kalts' } } }), true);
  assert.equal(validPreference('diy', { v: 2, picks: {} }), false, 'an unknown version');
  assert.equal(validPreference('diy', { v: 1, picks: {}, extra: 1 }), false, 'nothing but v and picks');
  assert.equal(validPreference('diy', { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_601_cguard', note: 'x' } } }), false, 'nothing but a pick\'s fields');
  assert.equal(validPreference('diy', { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char 601' } } }), false);
  assert.equal(validPreference('diy', { v: 1, picks: { chess_char_5_diy1_a: { charId: 'char_601_cguard', skillIndex: 12 } } }), false);
  assert.equal(validPreference('diy', JSON.parse('{"v":1,"picks":{"__proto__":{"charId":"char_601_cguard"}}}')), false);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`slot_${i}`, { charId: 'char_601_cguard' }]));
  assert.equal(validPreference('diy', { v: 1, picks: nine }), false, 'at most DIY_LIMITS.slots slots');
  // 干员持有
  assert.equal(validPreference('ownership', { v: 1, notOwned: [] }), true);
  assert.equal(validPreference('ownership', { v: 1, notOwned: ['chess_char_3_05_a'] }), true);
  assert.equal(validPreference('ownership', ['chess_char_3_05_a']), false, 'the account holds the envelope only');
  assert.equal(validPreference('ownership', { v: 1, notOwned: ['chess_char_3_05_a', 'chess_char_3_05_a'] }), false, 'each id once');
  assert.equal(validPreference('ownership', { v: 1, notOwned: ['__proto__'] }), false);
  assert.equal(validPreference('ownership', { v: 1, notOwned: Array.from({ length: 161 }, (_, i) => `c${i}`) }), false, 'at most OWNERSHIP_LIMITS.notOwned');
  assert.throws(() => validatePreferencePatch({ diy: { v: 1, picks: { a: 'char_003_kalts' } } }), /INVALID_PREFERENCES/);
  assert.doesNotThrow(() => validatePreferencePatch({ diy: { v: 1, picks: {} }, ownership: { v: 1, notOwned: [] } }));
});

test('loadoutSync: a hydrated (account) 干员调配 / 自选编队 / 干员持有 setting reaches the store the syncs send from', async () => {
  const local = storage();
  const prev = globalThis.localStorage;
  globalThis.localStorage = local;
  try {
    const { preferences } = await import('../../public/js/preferences.js');
    const { loadoutStore } = await import('../../public/js/ui/loadoutSync.js');
    // what a cloud hydration does: the preference store changes and announces the key (guest mode here: this browser)
    preferences.save('diy', { v: 1, picks: { chess_char_6_diy2_a: { charId: 'char_003_kalts' } } });
    assert.deepEqual(loadoutStore.get().diy, { chess_char_6_diy2_a: { charId: 'char_003_kalts' } });
    preferences.save('ownership', { v: 1, notOwned: ['chess_char_3_05_a'] });
    assert.deepEqual(loadoutStore.get().notOwned, ['chess_char_3_05_a']);
    preferences.save('loadout', { v: 1, entries: { chess_char_1_01_a: { skill: 0 } } });
    assert.deepEqual(loadoutStore.get().entries, { chess_char_1_01_a: { skill: 0 } });
    // the same content again is no change (the sync would otherwise send a frame for nothing)
    const before = loadoutStore.get().diy;
    preferences.save('diy', { v: 1, picks: { chess_char_6_diy2_a: { charId: 'char_003_kalts' } } });
    assert.equal(loadoutStore.get().diy, before);
  } finally {
    globalThis.localStorage = prev;
  }
});
