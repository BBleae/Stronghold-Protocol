// Full co-op match with 5 seats (a remake extension: the official mode stops at 4) — the REAL simulation, client-side
// combat, 1 human on "AI 托管" + 4 AI teammates, to RESULT with zero errors, and the 5–8-player rules (DESIGN §24) checked
// on what the match did (fullmatchLarge.js). An odd count: the last player of the Final Assault fights alone on the _s
// template. min(MATCH_SEEDS, 6) seeds, so the full suite grows little; split from the 8-seat file so node --test runs
// the two in parallel.
import { test, after } from 'node:test';
import { reportSimIssues } from './fullmatchRun.js';
import { LARGE_SEEDS, runLarge } from './fullmatchLarge.js';

after(reportSimIssues);

for (const [humans, bots, difficulty] of [[1, 4, 'NORMAL']]) {
  test(`co-op ${humans} human(s) + ${bots} AI = ${humans + bots} seats (${difficulty}): ${LARGE_SEEDS} seeds to RESULT with zero errors and the 5–8 rules`, (t) => {
    const total = { drafts: 0, sp: 0, unite: 0, multiUnite: 0, boss: 0, hidden: 0 };
    for (let seed = 1; seed <= LARGE_SEEDS; seed++) {
      const s = runLarge({ difficulty, humans, bots, seed: 100 + seed });
      for (const k of Object.keys(total)) total[k] += Number(s[k]) || 0;
    }
    t.diagnostic(`views checked: band draft ${total.drafts}, 机变 ${total.sp}, 联防 ${total.unite} (several fields ${total.multiUnite}), Final Assault ${total.boss}, Hidden Core ${total.hidden}`);
  });
}
