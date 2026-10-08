export const STAT_FIELDS = Object.freeze([
  'dmgDealt',
  'healing',
  'kills',
  'leaks',
  'bossDamage',
  'perfectRounds',
  'gold',
  'refreshes',
  'merges',
  'lpLost',
  'buys',
  'sells',
]);

/**
 * A fork-era 外援 piece's record id (DESIGN §F3, retired 2026-10-08): chess_char_diy_<tier>_<charId>_a (_b: its elite).
 * The deployed Worker archived 外援 operators under it from 2026-10-06 until the retirement; data/waiguan.json, which
 * named them, is gone.
 */
const LEGACY_WAIGUAN_ID = /^chess_char_diy_[56]_(char_[A-Za-z0-9_]+)_[ab]$/;

/**
 * The 常用干员 entry an archived operator id counts as: a chess's base id or a 自选 operator's charId as recorded
 * (server/match/checkpoint.js usedOperators); an old 外援 record id as its operator's charId — the id the same operator
 * fielded through 自选编队 has, which the history screen names from data/backups.json.
 * @param {any} id
 */
export function historyOperatorId(id) {
  const m = typeof id === 'string' ? LEGACY_WAIGUAN_ID.exec(id) : null;
  return m ? m[1] : id;
}

export function aggregateStats(facts) {
  const out = {
    total: facts.length,
    completed: 0,
    wins: 0,
    left: 0,
    interrupted: 0,
    winRate: null,
    highestRound: 0,
    hiddenCleared: 0,
    totals: {},
    operators: [],
  };
  const operators = new Map();
  for (const fact of facts) {
    if (fact.status === 'completed') {
      out.completed++;
      if (fact.victory) out.wins++;
    } else if (fact.status === 'left') out.left++;
    else out.interrupted++;
    out.highestRound = Math.max(out.highestRound, Number(fact.round) || 0);
    if (fact.hiddenCleared && fact.status === 'completed') out.hiddenCleared++;
    for (const key of STAT_FIELDS)
      if (Number.isFinite(fact.stats?.[key])) out.totals[key] = (out.totals[key] || 0) + fact.stats[key];
    for (const id of new Set((fact.operators || []).map(historyOperatorId))) operators.set(id, (operators.get(id) || 0) + 1);
  }
  out.winRate = out.completed ? out.wins / out.completed : null;
  out.operators = [...operators]
    .map(([id, matches]) => ({ id, matches }))
    .sort((a, b) => b.matches - a.matches || a.id.localeCompare(b.id));
  return out;
}
