// Protocol caps for rooms of up to MAX_SEATS (8) players (owner's decision; 5–8 players are a remake extension, the
// official room has 1–4): room.create { capacity? } / room.setCapacity { capacity } take DEFAULT_SEATS..MAX_SEATS, seat
// indexes reach MAX_SEATS − 1, the per-player result maps hold MAX_SEATS entries (a 联防 field's `left`: up to 7
// leakers), and a 机变 pick reaches the 10th card (co-op max(6, alive + 2)). Everything valid before stays valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S, RESULT_LIMITS, SP_CARDS_MAX, isBattleResult } from '../shared/protocol.js';
import { MAX_SEATS, DEFAULT_SEATS } from '../shared/constants.js';

const ok = (msg) => assert.equal(validateC2S(msg), null, JSON.stringify(msg));
const bad = (msg) => assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));

test('the seat constants: 8 seats at most, 4 by default (the official room)', () => {
  assert.equal(MAX_SEATS, 8);
  assert.equal(DEFAULT_SEATS, 4);
});

test('room.create: an optional capacity DEFAULT_SEATS..MAX_SEATS; the 1–4 message is unchanged', () => {
  ok({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
  ok({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  for (let n = DEFAULT_SEATS; n <= MAX_SEATS; n++) ok({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: n });
  ok({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', capacity: 4 }); // ignored by the lobby (one seat)
  for (const capacity of [0, 1, 3, 9, 4.5, '4', null, true]) bad({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity });
});

test('room.setCapacity { capacity }: required, DEFAULT_SEATS..MAX_SEATS', () => {
  for (let n = DEFAULT_SEATS; n <= MAX_SEATS; n++) ok({ t: 'room.setCapacity', capacity: n });
  bad({ t: 'room.setCapacity' });
  for (const capacity of [3, 9, -1, 6.5, '8', null]) bad({ t: 'room.setCapacity', capacity });
});

test('seat indexes reach MAX_SEATS − 1 (room.removeBot / room.kick)', () => {
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    ok({ t: 'room.removeBot', seat });
    ok({ t: 'room.kick', seat, playerId: 'p_0123456789' });
  }
  bad({ t: 'room.removeBot', seat: MAX_SEATS });
  bad({ t: 'room.kick', seat: MAX_SEATS, playerId: 'p_0123456789' });
  bad({ t: 'room.removeBot', seat: -1 });
});

test('RESULT_LIMITS.players = MAX_SEATS: a 联防 field reports every leaker (up to 7) in b.progress `left`', () => {
  assert.equal(RESULT_LIMITS.players, MAX_SEATS);
  const progress = (left) => ({ t: 'b.progress', battleId: 'u:9', gt: 12, killed: 3, total: 40, left });
  const leakers = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p_leaker${i}`, 5 + i]));
  ok(progress(leakers(3))); // the 1–4 player maximum
  ok(progress(leakers(4)));
  ok(progress(leakers(MAX_SEATS - 1)));
  ok(progress(leakers(MAX_SEATS)));
  bad(progress(leakers(MAX_SEATS + 1)));
  // b.result perPlayer: a field never has more than 2 players, but the bound is the room's
  const perPlayer = { killed: 1, total: 2, leaked: [], perfect: false, layerGains: {}, unitsEnd: [] };
  const result = (n) => ({ reason: 'cleared', time: 30, perPlayer: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p_${i}`, perPlayer])) });
  assert.equal(isBattleResult(result(2)), true);
  assert.equal(isBattleResult(result(MAX_SEATS)), true);
  assert.equal(isBattleResult(result(MAX_SEATS + 1)), false);
});

test('g.choice: a 机变 pick reaches the last of up to 10 cards (co-op max(6, alive + 2))', () => {
  assert.equal(SP_CARDS_MAX, Math.max(6, MAX_SEATS + 2));
  assert.equal(SP_CARDS_MAX, 10);
  for (let idx = 0; idx < SP_CARDS_MAX; idx++) ok({ t: 'g.choice', idx });
  bad({ t: 'g.choice', idx: SP_CARDS_MAX });
  bad({ t: 'g.choice', idx: -1 });
  // g.reward (a player's own reward offer) keeps its 0..5
  ok({ t: 'g.reward', idx: 5 });
  bad({ t: 'g.reward', idx: 6 });
});
