// 外援 / 甄选 (DIY) pieces in a running match, client side (DESIGN §27): a bought 外援 is a chess id that data/chess.json
// does not carry (`chess_char_diy_<tier>_<charId>_a/_b`), so every in-match lookup has to resolve it from
// data/waiguan.json — the shop card, the hand / board piece, the unit detail, the bond popup rows, the deploy voice
// (pieceCharId) and the leader voice. And the player's picks follow the account like the loadout does (account mode),
// while the plain Node server keeps them in this browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDataStore } from '../../public/js/data.js';
import { bondMembers, pieceCharId, voiceLeader } from '../../public/js/ui/gameLogic.js';
import { waiguanRecords } from '../../shared/waiguan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => JSON.parse(readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const CHESS = read('chess.json');
const BONDS = read('bonds.json');
const WAIGUAN = read('waiguan.json');
const RECORDS = waiguanRecords(WAIGUAN);
/** A candidate with a core bond (its derived bond is what the bond popup must list). */
const CAND = WAIGUAN.candidates.find((c) => c.bonds.some((b) => BONDS[b]?.isCore));
const A6 = CAND.chessIds[6];
const B6 = A6.replace(/_a$/, '_b');
const A5 = CAND.chessIds[5];
const B5 = A5.replace(/_a$/, '_b');

const fakeFetch = (files) => async (url) => {
  const name = String(url).replace(/^.*\//, '').replace(/\.json$/, '');
  if (!Object.hasOwn(files, name)) return { ok: false, status: 404, json: async () => null };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(files[name])) };
};

test('data.lookup(chess): a 外援 id resolves (both tiers, normal and elite) once waiguan.json is loaded; list(chess) stays chess.json', async () => {
  const store = createDataStore({ fetch: fakeFetch({ chess: CHESS, waiguan: WAIGUAN }), retryDelays: [] });
  await store.load('chess');
  assert.equal(store.lookup('chess', A6), null, 'not before the roster is loaded');
  assert.ok(store.lookup('chess', 'chess_char_1_01_a'), 'pool chess as before');
  await store.load('waiguan');
  for (const id of [A6, B6, A5, B5]) {
    const rec = store.lookup('chess', id);
    assert.ok(rec, `${id} resolves`);
    assert.equal(rec.chessId, id);
    assert.equal(rec.charId, CAND.charId, 'the operator (portrait, avatar, voice key)');
    assert.equal(rec.name, CAND.name);
    assert.ok(Array.isArray(rec.skills) && rec.skills.length, 'skills for the detail card');
  }
  assert.equal(store.lookup('chess', A5).tier, 5);
  assert.equal(store.lookup('chess', B6).isGolden, true);
  assert.equal(store.lookup('chess', 'chess_char_diy_6_char_nobody_a'), null);
  // the roster screens keep listing data/chess.json only (they add the player's OWN picks themselves)
  assert.ok(!store.list('chess').some((c) => /^chess_char_diy_/.test(c.chessId)), 'list(chess) holds no 外援 record');
  // a lookup in another file never falls through to the roster
  assert.equal(store.lookup('items', A6), null);
});

test('in-match helpers resolve a 外援 piece: the deploy / leader voice (pieceCharId) and the bond popup rows', () => {
  const getChess = (id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : RECORDS[id] || null);
  const piece = { uid: 7, kind: 'chess', id: A6, items: [] };
  assert.equal(pieceCharId(piece, getChess), CAND.charId, 'the deploy voice names the operator');
  const priv = { board: [{ ...piece, r: 10, c: 5 }], hand: [{ uid: 8, kind: 'chess', id: B5, items: [] }], temp: [] };
  assert.equal(voiceLeader(priv, getChess), CAND.charId, 'a lone 外援 on the board leads the squad voice');
  const bondId = CAND.bonds.find((b) => BONDS[b]?.isCore);
  const rows = bondMembers({ ...BONDS[bondId], bondId }, priv, [], getChess, () => null);
  const own = rows.filter((r) => r.diy);
  assert.deepEqual(own.map((r) => [r.id, r.onBoard, r.owned]).sort(), [[A5, false, true], [A6, true, true]].sort(),
    'each owned 外援 operator is a row of the bonds its record derives (the server counts it there)');
  assert.ok(own.every((r) => r.name === CAND.name));
  // a bond the 外援 does not derive lists no such row
  const other = Object.keys(BONDS).find((b) => BONDS[b].isCore && !CAND.bonds.includes(b));
  assert.equal(bondMembers({ ...BONDS[other], bondId: other }, priv, [], getChess, () => null).filter((r) => r.diy).length, 0);
});

test('preferences: the 甄选 picks are an account-synced key with a structural check (account mode); the Node server keeps them local', async () => {
  const { PREFERENCE_KEYS, validPreference, validatePreferencePatch } = await import('../../public/js/preferenceSchema.js');
  assert.ok(PREFERENCE_KEYS.includes('waiguan'));
  const ok = { v: 1, picks: { diy5a: CAND.charId, diy6a: CAND.charId } };
  assert.equal(validPreference('waiguan', ok), true, 'the same operator in a tier V and a tier VI slot');
  assert.equal(validPreference('waiguan', { v: 1, picks: {} }), true, 'an empty selection');
  for (const bad of [
    { v: 1, picks: { diy5a: CAND.charId, diy5b: CAND.charId } }, // one operator in both slots of a tier
    { v: 1, picks: { diy9z: CAND.charId } },
    { v: 1, picks: { diy5a: 'not an id!' } },
    { v: 1, picks: { diy5a: null } },
    { v: 1, picks: { diy5a: 42 } },
    { v: 2, picks: {} },
    { v: 1, picks: {}, extra: true },
    { v: 1 },
    { v: 1, picks: { diy5a: 'char_a', diy5b: 'char_b', diy6a: 'char_c', diy6b: 'char_d', diy7a: 'char_e' } },
    JSON.parse('{"v":1,"picks":{"__proto__":"char_x"}}'),
    'diy5a',
  ]) assert.equal(validPreference('waiguan', bad), false, JSON.stringify(bad));
  assert.doesNotThrow(() => validatePreferencePatch({ waiguan: ok }));
  assert.throws(() => validatePreferencePatch({ waiguan: { v: 1, picks: { diy5a: CAND.charId, diy5b: CAND.charId } } }), /INVALID_PREFERENCES/);
});

const memStorage = () => {
  const values = new Map();
  return { values, getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
};
const cloud = () => {
  const accounts = new Map();
  return {
    accounts,
    forAccount: (accountId) => async (body) => {
      if (body && (!body.initialize || !accounts.has(accountId))) accounts.set(accountId, { ...(accounts.get(accountId) || {}), ...body.patch });
      return { accountId, preferences: accounts.get(accountId) ?? null };
    },
  };
};
const timers = { setTimeout: () => 1, clearTimeout: () => {} };

test('preferences: picks follow the account across devices; an account cached before picks were synced uploads this browser’s old local picks once (never over a cloud value)', async () => {
  const { createPreferences } = await import('../../public/js/preferences.js');
  const picks = { v: 1, picks: { diy6a: CAND.charId } };
  const server = cloud();
  // device 1 (signed in): a pick is saved to the account, not to sp.pref.waiguan
  const local1 = memStorage();
  const one = createPreferences({ storage: () => local1, request: server.forAccount('a'), timers });
  await one.start('a');
  one.save('waiguan', picks);
  await one.flush();
  assert.deepEqual(server.accounts.get('a').waiguan, picks, 'stored on the account');
  assert.equal(local1.getItem('sp.pref.waiguan'), null, 'not in the device-local key');
  // device 2 restores it
  const two = createPreferences({ storage: () => memStorage(), request: server.forAccount('a'), timers });
  await two.start('a');
  assert.deepEqual(two.load('waiguan', null), picks);
  // signed out / the Node server: the browser keeps it
  const guestStorage = memStorage();
  const guest = createPreferences({ storage: () => guestStorage, request: () => assert.fail('no account API'), timers });
  guest.save('waiguan', picks);
  assert.deepEqual(JSON.parse(guestStorage.getItem('sp.pref.waiguan')), picks);
  assert.deepEqual(guest.load('waiguan', null), picks);

  // an account whose cache predates the synced key: the browser's old local picks fill the cloud's gap ...
  const old = memStorage();
  old.setItem('sp.accountPrefs.legacyOwner', JSON.stringify('b'));
  old.setItem('sp.accountPrefs.b', JSON.stringify({ values: { 'lobby.mode': 'coop' }, pending: {} }));
  old.setItem('sp.pref.waiguan', JSON.stringify(picks));
  const srv = cloud();
  srv.accounts.set('b', { 'lobby.mode': 'coop' });
  const b = createPreferences({ storage: () => old, request: srv.forAccount('b'), timers });
  await b.start('b');
  assert.deepEqual(b.load('waiguan', null), picks);
  assert.deepEqual(srv.accounts.get('b').waiguan, picks, 'uploaded where the cloud had none');
  // ... but never over a value the cloud already holds (another device synced picks first)
  const other = { v: 1, picks: { diy5a: CAND.charId } };
  const old2 = memStorage();
  old2.setItem('sp.accountPrefs.legacyOwner', JSON.stringify('c'));
  old2.setItem('sp.accountPrefs.c', JSON.stringify({ values: {}, pending: {} }));
  old2.setItem('sp.pref.waiguan', JSON.stringify(picks));
  const srv2 = cloud();
  srv2.accounts.set('c', { waiguan: other });
  const c = createPreferences({ storage: () => old2, request: srv2.forAccount('c'), timers });
  await c.start('c');
  assert.deepEqual(srv2.accounts.get('c').waiguan, other, 'the cloud value wins');
  assert.deepEqual(c.load('waiguan', null), other);
  // and another account on this browser never inherits the first account's local picks
  const d = createPreferences({ storage: () => old, request: srv.forAccount('d'), timers });
  await d.start('d');
  assert.equal(srv.accounts.get('d')?.waiguan, undefined);
});

test('loadoutSync: a hydrated (account) selection reaches the 外援 store the sync sends from', async () => {
  const storage = memStorage();
  const prev = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const { preferences } = await import('../../public/js/preferences.js');
    const { loadoutStore } = await import('../../public/js/ui/loadoutSync.js');
    const { PICKS_PREF } = await import('../../public/js/ui/loadoutModel.js');
    // what a cloud hydration does: the preference store changes and announces the key
    preferences.save(PICKS_PREF, { v: 1, picks: { diy6b: CAND.charId } });
    assert.deepEqual(loadoutStore.get().picks, { diy6b: CAND.charId });
  } finally {
    globalThis.localStorage = prev;
  }
});
