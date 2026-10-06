// shared/waiguan.js — 外援 / 甄选 (DIY) roster helpers, pure ESM shared by the server and the browser
// (docs/DESIGN.md §27, research 03 §C4).
//
// The official mode gives every player four 甄选 (DIY) slots — two at tier V and two at tier VI — filled with their own
// 6★ operators (`diyChessDict` = TIER_6). The remake has no account roster, so the player picks among the 6★ operators
// that are NOT in this mode's shop pool; tools/build-data.mjs emits them as data/waiguan.json:
//
//   { candidates: [ { charId, name, profession, bonds, chessIds: { 5, 6 } } … ],
//     chess:   { '<tier VI chessId>': <full chess record> … },
//     chessT5: { '<tier V chessId>':  { from: '<tier VI chessId>', …nine tier fields } … } }
//
// The two tiers of one operator differ ONLY in those nine fields (position in the shop, price, status), so the tier V
// records are stored as overlays on the tier VI ones. `waiguanTier5Records` rebuilds them; the server merges the result
// into the match's own chess table when a player's picks are known.

/** Fields the tier changes on an otherwise identical 甄选 record (must match tools/build-data.mjs WAIGUAN_TIER_FIELDS). */
export const WAIGUAN_TIER_FIELDS = Object.freeze([
  'chessId', 'baseId', 'goldenId', 'tier', 'identifier', 'price', 'sellPrice', 'upgradeChessId', 'status',
]);

/** The four 甄选 slots of the official mode, in screen order: `{ slot, chessId, tier }` (the ids data/chess.json carries). */
export const WAIGUAN_SLOTS = Object.freeze([
  { slot: 'diy5a', chessId: 'chess_char_5_diy1_a', tier: 5 },
  { slot: 'diy5b', chessId: 'chess_char_5_diy2_a', tier: 5 },
  { slot: 'diy6a', chessId: 'chess_char_6_diy1_a', tier: 6 },
  { slot: 'diy6b', chessId: 'chess_char_6_diy2_a', tier: 6 },
]);

/** The slots of one tier, in screen order. */
/**
 * Copies a 甄选 pick holds in its own private pool — the official per-tier pool copies (research 01 §6). Never scaled
 * by the room's seats: the entry is one player's, not the shared pool's (server/match/pool.js addOwned).
 */
export const WAIGUAN_POOL_COPIES = Object.freeze({ 5: 8, 6: 5 });

export const waiguanSlotsOfTier = (tier) => WAIGUAN_SLOTS.filter((s) => s.tier === tier);

/**
 * Reconstruct the tier V 甄选 records from their tier VI twins plus `chessT5` (see the header).
 * @param {Record<string, any>} chessT6 data/waiguan.json `.chess`
 * @param {Record<string, any>} chessT5 data/waiguan.json `.chessT5`
 * @param {(msg: string) => void} [warn] called for an overlay whose base is missing (the record is skipped)
 * @returns {Record<string, any>} tier V records, keyed by chessId
 */
export function waiguanTier5Records(chessT6, chessT5, warn = null) {
  const out = {};
  for (const [id, ov] of Object.entries(chessT5 && typeof chessT5 === 'object' ? chessT5 : {})) {
    const base = chessT6 && typeof chessT6 === 'object' ? chessT6[ov?.from] : null;
    if (!base) { if (warn) warn(`waiguan: tier V record ${id} has no tier VI base ${ov?.from}`); continue; }
    const rec = { ...base };
    for (const f of WAIGUAN_TIER_FIELDS) if (f in ov) rec[f] = ov[f];
    out[id] = rec;
  }
  return out;
}

/**
 * Every 甄选 record of a roster (tier V and tier VI), keyed by chessId — what a match injects into its chess table.
 * @param {any} waiguan data/waiguan.json
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, any>}
 */
export function waiguanRecords(waiguan, warn = null) {
  if (!waiguan || typeof waiguan !== 'object') return {};
  return { ...(waiguan.chess || {}), ...waiguanTier5Records(waiguan.chess, waiguan.chessT5, warn) };
}

/**
 * The candidate a chessId belongs to (`chess_char_diy_<tier>_<charId>[_ab]`), or null.
 * @param {Record<string, any>} candidates data/waiguan.json `.candidates`
 * @param {string} chessId
 * @returns {{ candidate: any, tier: number, golden: boolean }|null}
 */
export function waiguanPickOf(candidates, chessId) {
  if (typeof chessId !== 'string') return null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.chessIds) continue;
    for (const tier of [5, 6]) {
      const base = c.chessIds[tier];
      if (chessId === base) return { candidate: c, tier, golden: false };
      if (chessId === `${String(base).slice(0, -1)}b`) return { candidate: c, tier, golden: true };
    }
  }
  return null;
}

/**
 * Whether a chess record is a REAL 甄选 operator rather than one of the four empty SLOT TEMPLATES data/chess.json carries
 * (`chess_char_5_diy1_a` …: `isDiy`, no `stats`, no `skills`, `visible: false` — they only name the slot).
 *
 * The distinction is what makes a DIY operator a loadout target: a player's chosen operator has full combat data and is
 * legitimately可调配 (loadout slots are keyed by the chess id, DESIGN §16/§27), while a template must never be one.
 * @param {any} rec a chess record
 */
export function isWaiguanRecord(rec) {
  return !!rec && typeof rec === 'object' && rec.isDiy === true && !!rec.stats && typeof rec.chessId === 'string';
}
