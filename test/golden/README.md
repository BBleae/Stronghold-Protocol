# Golden results

The simulation is deterministic: the same seed and inputs give the same battle and the same match, bit for bit. These
files record the exact outcome of a fixed corpus of seeded scenarios, so a change that alters gameplay — even one meant
to be a pure refactor that only reorders random draws, hook order or iteration order — fails loudly instead of slipping
through.

- `tools/golden.mjs` builds the corpus from `data/*.json` (fixed order, fixed seeds) and reduces every scenario to a
  digest. Its header documents the families and the digest fields.
- `test/golden/<family>.json` hold the digests (`roster`, `bonds`, `fields`, `matches`).
- `test/golden.test.js` recomputes them and compares. On a mismatch it prints the scenario, the field and old → new.

## The corpus

| family | what runs |
|---|---|
| `roster` | 49 battles: every visible chess record (normal and elite) with every selectable skill and module (DESIGN §16), 12 operators per battle on a real stage (all 11 in turn) against the round's real wave three times over, every non-leader enemy kind of `data/enemies.json` as extra spawns (half of them bounties), placeable summons on the board, every equipment item, band, battle-side 机变 card and stage map card in turn, bonds from the board |
| `bonds` | 46 battles: every bond at its activation threshold (1 layer) and at its top tier (999 layers) |
| `fields` | 22 battles: every Final Assault / Hidden Core leader on a pair and a solo template (shared pool, 200 s cap) and the 联防 field with 1 and 2 helpers (carried HP / SP, a knocked-out operator, two leakers' enemies) |
| `matches` | 16 bot-only matches to the end in virtual time: solo 标准 / 险境 / 绝境 / 终极 × 2 seeds, co-op 2 / 3 / 4, one server-run combat match, two runs boosted to the Hidden Core |

Battles go through the production BattleSpec path (`server/sim/spec.js`, as browsers and the server's headless fields
run them); matches construct `Match` directly with a `VirtualScheduler`. Every option is explicit, so a change to a
test-harness default never moves a digest.

What a digest ignores on purpose (it does not affect gameplay): object key order, engine unit ids (snapshot ids are
renumbered by first appearance, units are named by board uid or def id), board piece uids, the order of client events
within a tick (they are counted, not hashed) and wall-clock time. Damage / healing sums are rounded to integers and HP
to 2 decimals.

`npm test` runs the fast subset (the scenarios marked `"fast": true`: every chess record with its default loadout,
every stage and every non-leader enemy kind, every bond at its top tier, six fields, five matches — 53 of the 133). `GOLDEN_FULL=1` checks everything.

## Workflow

```sh
GOLDEN_FULL=1 node --test test/golden.test.js   # the whole corpus (≈ 20 s with 4 worker threads)
node --test test/golden.test.js                 # the fast subset
npm run golden                                  # the same comparison from the tool (all families, a short report)
npm run golden:update                           # recompute and rewrite test/golden/*.json
node tools/golden.mjs --twice                   # determinism: the corpus twice in one process, the second pass reversed
```

- **A refactor commit must never change these files.** Run `GOLDEN_FULL=1 node --test test/golden.test.js` before
  committing it. If a digest moves, the refactor changed behaviour: find out why (the first differing value of `snaps`
  says when two runs parted, in 10-game-second steps) instead of updating the files.
- **An intended gameplay change** (a fix, new content, a data rebuild): run `npm run golden:update` and commit the
  changed files together with the change, saying in the commit message which scenarios moved and why.
- **Reviewing the diff:** every scenario is a block of its own and every unit / enemy / round is one line, so a diff
  shows which scenarios moved and which values changed. A change confined to the scenarios that contain the touched
  operator, enemy or rule is expected; a change everywhere (every `rngDraws`, every `snaps`) means something global
  moved — the RNG draw order, the tick order, a shared rule.
- **Adding to the corpus** (a new family, more scenarios, a new digest field) changes the files by design: do it in a
  commit of its own, never together with a refactor.
- A new engine hook, event or chess record does not change the digests of the existing scenarios by itself — the
  hook list is frozen in the tool and the corpus is regenerated only on `golden:update` — but new data records do join
  the corpus there (the roster family enumerates `data/chess.json`).

## This fork

The digests in this directory are the fork's own (BBleae/Stronghold-Protocol), regenerated after merging upstream
0.1.4 and then fork PRs #15–#20. They differ from upstream's files in two ways, and in no other:

- **Client effect counts** (`events.fx` and the `fx` kinds) of 31 scenarios (roster 13, bonds 5, fields 13): the fork's
  sim sends extra cosmetic effect events and parameters (fork commit 6d5c094, PR #5 — `snowTiles`, `motes`, the
  同盟支援 `link`, `shell` → `helmShell`, `beam` → `sentryRecall`). Every gameplay field of the roster, bonds and
  fields families (units, enemies, players, hooks, `rngDraws`, `snaps`) equals upstream's.
- **15 of the 16 matches** — all but `solo-FUNNY-1` — because the bots bring 外援 / 甄选 picks (DESIGN §27): since
  fork PR #17 every bot seat brings its own picks (`botWaiguanPicks` in `server/match/Match.js`; all bots of a match
  pick alike), and since PR #19's 524fb56 (2026-10-07) those picks are really in play: every player's picks are pool
  entries of its own (`SharedPool.owned`, keyed by owner — each bot now holds its 4 entries, where only the first bot's
  were accepted before), its shop, rewards and effect draws offer them (`Match.rollPool`, `choices.js`,
  `effectsMeta.js` with the player id), and the bot heuristics (`server/match/bot.js` `refreshValue`,
  `bondPoolStats`) and `Match.bondInPool` count the shared pool plus the player's own picks only. So the bots refresh,
  buy and field their bonds differently: different `rng.shop` / `rng.bots` / `rng.meta` counts, boards and bond
  layers; `solo-HARD-2` ends in an elimination in round 11 instead of a victory, `coop2-NORMAL-8-serverrun` in a
  victory instead of both seats' elimination in round 13, and in `coop4-FUNNY-6` a bot fields a 甄选 chess (`ai_2`'s
  阿, tier V from round 11, tier VI from round 12). With `data/waiguan.json` left out of the data all 16 matches equal
  upstream's again (checked on 2026-10-07 against upstream 9f93096's `matches.json`).

After each merge, run `npm run golden:update` and compare with upstream's files (`git show
<upstream commit>:test/golden/<family>.json`): in the roster, bonds and fields families a moved value outside
`events.fx` / `fx` is a merge bug unless a fork change explains it — check by rerunning the moved scenarios with that
change left out, then record the cause here. For the matches, rerun the family in a copy of the tree without
`data/waiguan.json` and with upstream's `matches.json` in place (`node tools/golden.mjs --family matches`): all 16 must
match; one that does not is a merge bug unless a fork change explains it.
