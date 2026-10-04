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
    for (const id of new Set(fact.operators || [])) operators.set(id, (operators.get(id) || 0) + 1);
  }
  out.winRate = out.completed ? out.wins / out.completed : null;
  out.operators = [...operators]
    .map(([id, matches]) => ({ id, matches }))
    .sort((a, b) => b.matches - a.matches || a.id.localeCompare(b.id));
  return out;
}
