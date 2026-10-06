// server/match/invariants.js — engine invariants (DESIGN §11) as a non-throwing check. Used by the test harness
// (test/match/harness.js checkInvariants asserts the list is empty) and by tools/matchrun.mjs --check sweeps.
//
// collectViolations(m) → string[] (empty when every invariant holds):
//   pool     cap = gd.poolCopies(base, seats) (5–8 seats scale it; a player's own 甄选 entry: WAIGUAN_POOL_COPIES of its
//            tier); 0 ≤ left ≤ cap and left + Σ copies held by
//            pieces == cap per base chess (per owner for 甄选 entries: only the owner's pieces hold their copies); no
//            甄选 chess in the shared pool; non-pool chess hold 0 copies
//   economy  funds / pendingFunds non-negative integers, LP finite, shop level in range, prices ≥ 0
//   pieces   unique uids; hand 10 / temp 5 slots; chess carry ≤ equipPerChess known items; a normal piece holds ≤ 1
//            copy, an elite ≤ goldenCopies; merges are immediate (never `mergeCount` normal copies of one chess, never
//            two copies of a mergeable normal item); every token's owner chess is deployed
//   board    tiles inside the own region and legal for the piece (a range-bound summon inside its owner's attack
//            range); no items on the board; chess count ≤ deploy cap
//            (where a merge's elite goes — a consumed deployed copy's tile, else the hand — needs the state before the
//            merge: audit.js checks it per merge)
//   bonds    ps.bonds equals a fresh computeBonds() (every mutation recomputed them); every bond's layers 0 … BOND_LAYER_CAP
//   shop     slot count follows the rolled layout; ids known; banned chess never offered by the shop / rewards; a 甄选
//            chess only in its owner's shop / merge rewards
//   elim.    an eliminated player owns nothing (board, hand, temp, shop, offers, bounties, funds)
//   match    phase known; teamLp / boss pool within range; combat fields match the alive players

import { PHASE, BOND_LAYER_CAP } from '../../shared/constants.js';
import { FIELD, canPlace, placeClass, positionClass, parseKey } from './board.js';
import { computeBonds } from './bondsMeta.js';
import { WAIGUAN_POOL_COPIES } from '../../shared/waiguan.js';

const PHASES = new Set(Object.values(PHASE));
/** `held` key of a copy taken from `owner`'s own 甄选 entry of `base`. */
const ownKey = (owner, base) => `${base}@${owner}`;

/**
 * @param {import('./Match.js').Match} m
 * @param {{ limit?: number }} [opts]
 * @returns {string[]}
 */
export function collectViolations(m, { limit = 25 } = {}) {
  const out = [];
  const fail = (msg) => { if (out.length < limit) out.push(msg); };
  const gd = m.gd;
  const held = new Map();
  const uids = new Set();
  const banned = new Set(m.bannedChess || []);
  const note = (ps, p) => {
    if (!Number.isInteger(p.uid) || p.uid <= 0) fail(`${ps.playerId}: bad uid ${p.uid}`);
    else if (uids.has(p.uid)) fail(`${ps.playerId}: duplicate uid ${p.uid}`);
    uids.add(p.uid);
  };

  if (!PHASES.has(m.phase)) fail(`unknown phase ${m.phase}`);
  if (m.teamLp != null && !(Number.isFinite(m.teamLp) && m.teamLp >= 0)) fail(`teamLp ${m.teamLp}`);
  if (m.bossPool && !(m.bossPool.hp >= 0 && m.bossPool.hp <= m.bossPool.maxHp)) fail(`boss pool ${m.bossPool.hp}/${m.bossPool.maxHp}`);

  for (const ps of m.players.values()) {
    const id = ps.playerId;
    if (!Number.isInteger(ps.funds) || ps.funds < 0) fail(`${id}: funds ${ps.funds}`);
    if (!Number.isInteger(ps.pendingFunds) || ps.pendingFunds < 0) fail(`${id}: pendingFunds ${ps.pendingFunds}`);
    if (!Number.isFinite(ps.lp)) fail(`${id}: lp ${ps.lp}`);
    if (ps.alive && m.phase !== PHASE.SETTLE && ps.lp <= 0 && m.teamLp == null && m.round > 0 && ps.bandId) fail(`${id}: alive with lp ${ps.lp}`);
    if (ps.hand.length !== gd.benchSize) fail(`${id}: hand has ${ps.hand.length} slots`);
    if (ps.temp.length !== gd.tempSize) fail(`${id}: temp has ${ps.temp.length} slots`);
    if (!(ps.shop.level >= 1 && ps.shop.level <= gd.maxShopLevel)) fail(`${id}: shop level ${ps.shop.level}`);
    if (!(ps.shop.upgradePrice >= 0)) fail(`${id}: upgradePrice ${ps.shop.upgradePrice}`);
    if (!Number.isInteger(ps.shop.freeRefreshes) || ps.shop.freeRefreshes < 0) fail(`${id}: freeRefreshes ${ps.shop.freeRefreshes}`);
    // the official per-bond layer cap (shared/constants.js): no writer may pass it
    for (const [b, v] of Object.entries(ps.layers || {})) {
      if (!(Number.isFinite(v) && v >= 0 && (!(BOND_LAYER_CAP > 0) || v <= BOND_LAYER_CAP))) fail(`${id}: ${b} layers ${v}`);
    }

    if (!ps.alive) {
      if (ps.board.size) fail(`${id}: eliminated but keeps ${ps.board.size} board pieces`);
      if (ps.hand.some(Boolean) || ps.temp.some(Boolean)) fail(`${id}: eliminated but keeps hand/temp pieces`);
      if (ps.shop.slots.length || ps.offers.length || ps.bounties.length) fail(`${id}: eliminated but keeps shop/offers/bounties`);
      if (ps.funds || ps.pendingFunds) fail(`${id}: eliminated with funds ${ps.funds}+${ps.pendingFunds}`);
    }

    // pieces
    const all = [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)];
    const boardChessUids = new Set();
    for (const p of ps.board.values()) if (p.kind === 'chess') boardChessUids.add(p.uid);
    const itemCounts = new Map();
    // A copy gained as the previous prep ended (PlayerState.acquireItem deferMerge) waits until the next prep.
    // It does not count toward "merges are immediate" until that prep's checkItemMerges consumes it.
    const countItem = (it) => { if (it.deferMerge) return; itemCounts.set(it.id, (itemCounts.get(it.id) || 0) + 1); };
    for (const p of all) {
      note(ps, p);
      if (p.kind === 'chess') {
        const rec = gd.chess(p.id);
        if (!rec) { fail(`${id}: unknown chess ${p.id}`); continue; }
        if (!Array.isArray(p.items) || p.items.length > gd.equipPerChess) fail(`${id}: ${p.id} carries ${p.items && p.items.length} items`);
        for (const it of p.items || []) {
          note(ps, it);
          if (it.kind !== 'item' || !gd.item(it.id)) fail(`${id}: ${p.id} carries a bad item ${it.kind}:${it.id}`);
          else if (gd.item(it.id).itemType !== 'EQUIP') fail(`${id}: ${p.id} carries a non-equipment item ${it.id}`);
          countItem(it);
        }
        const maxCopies = rec.isGolden ? gd.goldenCopies : 1;
        if (!Number.isInteger(p.poolCopies) || p.poolCopies < 0 || p.poolCopies > maxCopies) fail(`${id}: ${p.id} holds ${p.poolCopies} copies`);
        const base = gd.baseIdOf(p.id);
        // a copy of a player's own 甄选 entry is counted against that player's entry; the shared pool's per base
        const own = m.pool.ownedBy(id).has(base);
        const key = own ? ownKey(id, base) : base;
        held.set(key, (held.get(key) || 0) + (p.poolCopies || 0));
      } else if (p.kind === 'item') {
        if (!gd.item(p.id)) fail(`${id}: unknown item ${p.id}`);
        countItem(p);
      } else if (p.kind === 'token') {
        if (!gd.token(p.id)) fail(`${id}: unknown token ${p.id}`);
        if (!(p.count >= 1)) fail(`${id}: token stack count ${p.count}`);
        // summons exist only while their owner is deployed (withdrawing / selling / merging it removes them)
        if (!boardChessUids.has(p.ownerUid)) fail(`${id}: token ${p.uid} without a deployed owner (${p.ownerUid})`);
      } else {
        fail(`${id}: piece of unknown kind ${p.kind}`);
      }
    }
    // board
    let deployed = 0;
    // a pure read (Match.deployMapFor: the field the player deploys on now) — PlayerState.deployMap() would update the
    // player's cached field / legality flag, and this checker must not change when a later recompute moves pieces
    const dmap = typeof m.deployMapFor === 'function' ? m.deployMapFor(ps) : ps.deployMap();
    for (const [k, p] of ps.board) {
      const [r, c] = parseKey(k);
      if (!(r >= FIELD.r0 && r <= FIELD.r1 && c >= FIELD.c0 && c <= FIELD.c1)) fail(`${id}: piece outside the board at ${k}`);
      if (p.kind === 'item') { fail(`${id}: item ${p.id} stands on the board`); continue; }
      const rec = p.kind === 'token' ? gd.token(p.id) : gd.chess(p.id);
      const cls = p.kind === 'chess' ? placeClass(ps, rec) : positionClass(rec);
      if (rec && !canPlace(dmap, cls, r, c)) fail(`${id}: ${p.id} on an illegal tile ${k}`);
      // a "只能部署在召唤者攻击范围内" summon inside its owner's attack range (PlayerState.summonRange: a pure read)
      const range = p.kind === 'token' && typeof ps.summonRange === 'function' ? ps.summonRange(p) : null;
      if (range && !range.has(k)) fail(`${id}: ${p.id} on ${k}, outside its owner's attack range`);
      if (p.kind === 'chess') deployed++;
    }
    if (deployed > ps.deployCap) fail(`${id}: ${deployed} chess deployed > cap ${ps.deployCap}`);
    // merges are immediate
    const copies = new Map();
    for (const p of all) if (p.kind === 'chess' && gd.chess(p.id) && !gd.isGolden(p.id)) { const b = gd.baseIdOf(p.id); copies.set(b, (copies.get(b) || 0) + 1); }
    for (const [b, n] of copies) {
      const need = gd.mergeCount(b);
      if (need > 1 && gd.goldenIdOf(b) && n >= need) fail(`${id}: owns ${n} normal copies of ${b} (merges at ${need})`);
    }
    for (const [itemId, n] of itemCounts) {
      const rec = gd.item(itemId);
      if (!rec || rec.isGolden || rec.itemType !== 'EQUIP' || !rec.mergeable) continue;
      const need = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : gd.itemMergeCount;
      const gid = rec.upgradeChessId || rec.goldenId;
      if (need > 1 && need < 100 && gid && gd.item(gid) && n >= need) fail(`${id}: owns ${n} copies of item ${itemId} (merges at ${need})`);
    }
    // bonds are up to date
    try {
      const fresh = computeBonds(gd, ps);
      if (JSON.stringify(fresh) !== JSON.stringify(ps.bonds)) fail(`${id}: stale bonds (missing recompute)`);
    } catch (e) {
      fail(`${id}: computeBonds threw ${e && e.message}`);
    }
    // shop
    if (ps.alive) {
      const layout = ps.shop.layout;
      if (layout && ps.shop.slots.length !== layout.chess + layout.item) fail(`${id}: ${ps.shop.slots.length} shop slots for layout ${layout.chess}+${layout.item}`);
      ps.shop.slots.forEach((s, i) => {
        if (!s) return;
        if (s.kind === 'chess' ? !gd.chess(s.id) : !gd.item(s.id)) fail(`${id}: shop slot ${i} unknown ${s.kind} ${s.id}`);
        if (!Number.isInteger(s.basePrice) || s.basePrice < 0) fail(`${id}: shop slot ${i} basePrice ${s.basePrice}`);
        if (s.kind === 'chess' && banned.has(gd.baseIdOf(s.id))) fail(`${id}: banned chess ${s.id} in the shop`);
        // a 甄选 chess is only ever in its owner's shop (DESIGN §27)
        if (s.kind === 'chess' && gd.chess(s.id)?.isDiy && !m.pool.ownedBy(id).has(gd.baseIdOf(s.id))) fail(`${id}: another player's 甄选 ${s.id} in the shop`);
      });
      for (const o of ps.offers) {
        for (const s of o.slots || []) {
          if (s.kind === 'item' ? !gd.item(s.id) : !gd.chess(s.id)) fail(`${id}: bad reward slot ${s.kind} ${s.id}`);
          if (s.kind !== 'item' && banned.has(gd.baseIdOf(s.id)) && o.source === 'merge') fail(`${id}: banned chess ${s.id} offered as a merge reward`);
          if (s.kind !== 'item' && o.source === 'merge' && gd.chess(s.id)?.isDiy && !m.pool.ownedBy(id).has(gd.baseIdOf(s.id))) fail(`${id}: another player's 甄选 ${s.id} offered as a merge reward`);
        }
        if (!o.slots || !o.slots.length || o.slots.length > 6) fail(`${id}: reward offer with ${o.slots && o.slots.length} slots`);
      }
    }
  }

  // shared pool accounting
  // the copies per chess were sized for the match's seats at its start (1–4 official, 5–8 × seats / 4: gamedata.js)
  const seats = Array.isArray(m.order) ? m.order.length : undefined;
  const counted = new Set();
  for (const [base, e] of m.pool.entries) {
    if (e.owner != null) fail(`pool ${base}: a shared entry owned by ${e.owner}`);
    if (gd.chess(base)?.isDiy) fail(`pool ${base}: a 甄选 chess in the shared pool`);
    if (typeof gd.poolCopies === 'function' && e.cap !== gd.poolCopies(base, seats)) fail(`pool ${base}: cap ${e.cap} != ${gd.poolCopies(base, seats)} for ${seats} seats`);
    if (!(e.left >= 0 && e.left <= e.cap)) fail(`pool ${base}: left ${e.left} cap ${e.cap}`);
    const h = held.get(base) || 0;
    counted.add(base);
    if (e.left + h !== e.cap) fail(`pool ${base}: left ${e.left} + held ${h} != cap ${e.cap}`);
  }
  // each player's own 甄选 entries (pool.js addOwned): the official per-tier copies, never scaled by the seats, held by
  // their owner only (a teammate given such a piece holds no copy of it)
  for (const [owner, mine] of m.pool.owned) {
    if (!m.players.has(owner)) fail(`pool: 甄选 entries of an unknown player ${owner}`);
    for (const [base, e] of mine) {
      if (e.owner !== owner) fail(`pool ${base}: own entry of ${owner} marked ${e.owner}`);
      if (m.pool.entries.has(base)) fail(`pool ${base}: both shared and owned by ${owner}`);
      if (e.cap !== WAIGUAN_POOL_COPIES[e.tier]) fail(`pool ${base}: own entry of ${owner} cap ${e.cap} != ${WAIGUAN_POOL_COPIES[e.tier]} (tier ${e.tier})`);
      if (!(e.left >= 0 && e.left <= e.cap)) fail(`pool ${base}@${owner}: left ${e.left} cap ${e.cap}`);
      const key = ownKey(owner, base);
      const h = held.get(key) || 0;
      counted.add(key);
      if (e.left + h !== e.cap) fail(`pool ${base}@${owner}: left ${e.left} + held ${h} != cap ${e.cap}`);
    }
  }
  for (const [key, n] of held) if (!counted.has(key) && n !== 0) fail(`non-pool chess ${key} holds ${n} copies`);

  // combat fields
  if (m.phase === PHASE.COMBAT) {
    // one field per alive player (+ the force-ended field of a player who quit during this combat)
    const alive = m.order.filter((p) => p.alive || (p.left && m.fields.some((f) => f.fieldId === `n:${p.playerId}`))).map((p) => `n:${p.playerId}`).sort();
    const ids = m.fields.map((f) => f.fieldId).sort();
    if (JSON.stringify(alive) !== JSON.stringify(ids)) fail(`combat fields ${ids.join(',')} != alive ${alive.join(',')}`);
  }
  return out;
}
