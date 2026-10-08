# DESIGN §F1, §F2, §F3, §F4 — This fork's own sections (BBleae/Stronghold-Protocol)

Part of [DESIGN.md](../DESIGN.md) (the index). Upstream's section numbers are global and stay as upstream gives them;
this fork's own sections have fork ids, §F1 … §F4, so they never take a number upstream gives a later release. Code,
tests and the other documents cite them as "DESIGN §F1.4" and so on.

**Ids before 2026-10-08.** Until the merge of upstream 0.2.1 the fork numbered these sections inside the global sequence
and had renumbered upstream's 0.1.4 reports. Commit messages and notes from before the merge use the old ids:

| fork-era id | now | section |
|---|---|---|
| §24, §24.1 … §24.7 | §F1, §F1.1 … §F1.7 | co-op rooms of 5–8 players |
| §25, §25.1 … §25.9 | §24, §24.1 … §24.9 | upstream's 0.1.4 community reports ([history/0.1.4.md](../history/0.1.4.md)) |
| §26, §26.1 … §26.7 | §F2, §F2.1 … §F2.7 | phones |
| §27 | §F3 | 外援 / 甄选 (retired) |
| §28, §28.1, §28.2 | §F4, §F4.1, §F4.2 | 匹配 (matchmaking queue) |

---

## F1. Co-op rooms of 5–8 players (a remake extension, unreleased)

The official 同盟模拟 has 1–4 players (research 09 §3.1; the room's four seat cards, research 06 §3.2). The owner asked for bigger groups (owner's decisions 2026-10-05): a co-op room holds up to `MAX_SEATS` = **8** seats. **Hard rule:** a match of 1–4 players — whatever its room's capacity — keeps every rule, number, timer, layout and random draw of before (the same seeds give the same match; the 1–4 tests are unchanged). Everything below applies only above 4 players and is the remake's linear extrapolation, f = max(1, n / 4) (5 → 1.25, 6 → 1.5, 7 → 1.75, 8 → 2); which n each rule reads (the seats at the start, the players alive at a phase's start) is given with the rule. The match-side constants are `server/match/gamedata.js DEFAULTS.largeRoom` = `{ players: 4, spCardsPlus: 2, bandTurn: 20, spTurn: 12 }` (`config.largeRoom` — not generated — may override any key); `GameData.isLargeRoom(n)` = co-op and n > `largeRoom.players`, `largeRoomFactor(n)` = f (exactly 1 for 1–4, solo, or a missing count).

### F1.1 Room capacity — `shared/constants.js MAX_SEATS / DEFAULT_SEATS`, `shared/protocol.js` (`room.create {capacity?}`, `room.setCapacity`), `server/lobby.js` (`coopCapacity`, `Room.capacity / resize`, `Lobby.setCapacity`, `BOT_NAMES`), `worker/room-runtime.js socketLimits / admission`, `worker/index.js` (listing), `screens/room.js` (`roomCapacity`, `CapacityPicker`), `screens/lobby.js`, `ui/components.js SEAT_HUES / seatHue`, `ui/teamPanel.js teamCompact`

- `MAX_SEATS` = 8 is the protocol maximum (seat indexes 0–7); `DEFAULT_SEATS` = 4 is the official room — the size every co-op room starts with and the fewest seats a host may choose. `room.create {mode, difficulty, capacity?}`: `capacity` DEFAULT_SEATS…MAX_SEATS (else `BAD_MSG`; absent ⇒ 4; a solo room has one seat whatever it says). `room.setCapacity {capacity}` (host, LOBBY, co-op; `NOT_HOST`, `ROOM_STARTED`, `BAD_MSG` outside 4–8, `BAD_TARGET` for a solo room or fewer seats than the occupied ones — on Workers also fewer than the members plus the approved applicants): shrinking moves the members seated at an index ≥ capacity to the lowest free seats, in seat order; nobody is un-readied (the seat count decides nothing of the match, its players do). `Room.seats.length` is the capacity and `room.state.capacity` carries it; `freeSeat`, `room.addBot` / `ROOM_FULL`, `room.kick`, `room.removeBot` and the listings all read the room's own seats.
- AI teammates may fill every free seat (up to 7): `BOT_NAMES` has 8 names — the first three unchanged (a 4-seat room names its ≤ 3 bots as before), then `AI·杜宾`, `AI·德克萨斯`, `AI·银灰`, `AI·能天使`, `AI·陈` (the unreachable 凯尔希 / 可露希尔 of the old list had no art and were replaced); every name matches an operator or a strategy, which is the bot's portrait (test/lobby.test.js checks the art of all of them). The seat colours (`SEAT_HUES`) have 8 hues: P1–P4 the official four (mint, cyan, amber, violet), P5–P8 rose, blue, lime, magenta. Spectator seats stay `MAX_SPECTATORS` = 2 whatever the capacity.
- Client: the room shows one seat card per seat — 4 in one row as in the official room, 5–8 in two rows of 4 smaller cards (`seats--wide`) — and the host's **同盟席位** picker 4–8 (sizes below the occupied seats disabled; the bar's difficulty labels never wrap and its ready row's icons are smaller above 4 humans, so 8 humans leave the host's pickers their room at 640×360); the lobby's co-op card reads 「默认 4 席 · 创建者可扩至 8 席」. The in-match screens fit 8 players (the team panel's compact rows above 4 players, the strategy-draft order, the 机变 order strip and its up to 10 cards, the briefing, the result screen, history and replays), at 640×360 and on phones too; 1–4 players keep their layouts.
- Room Worker (account mode): a room saved before rooms had a capacity (its 4-slot `seats`) restores as a 4-seat room. The socket limits follow the capacity (`socketLimits(seats)`): the members keep `reserve` = capacity + 1 sockets (every player seat plus one overlap during a reconnect) and strangers share the rest — sockets = reserve + 11, socketsPerIp = reserve + 3 — so a 4-seat room keeps 16 / 8 as before and an 8-seat room has 20 / 12. The public listing's capacity is `room.seats.length` (`x/4` for a 4-seat room as before). Sign-up / login rate limits are unchanged (owner's decision).

### F1.2 The shared pool — `gamedata.js poolCopies(baseId, players)`, `pool.js SharedPool({ players })`, `Match` constructor

Copies per chess = ceil(official × n / 4), n = the match's seats (humans + bots) at the match start — every tier and the per-operator overrides (缪尔赛思 4): 5 seats 15 / 18 / 23 / 20 / 10 / 7 (缪尔赛思 5), 6 seats 18 / 21 / 27 / 24 / 12 / 8 (6), 7 seats 21 / 25 / 32 / 28 / 14 / 9 (7), 8 seats 24 / 28 / 36 / 32 / 16 / 10 (8). Sized once: an elimination returns the seat's copies as before and never shrinks the pool. A player's 自选编队 stock (§25.4, `match/player/diy.js`: 8 at tier 5, 5 at tier 6 per slot) is that player's own and never enters the shared pool, so the seat count does not size it (until 2026-10-08 the same held for the retired 外援 entries of §F3).

### F1.3 Drafts — `Match.bandTurnSeconds`, `gamedata.js bandTurnSeconds / spTurnSeconds`, `choices.js spDraftCardCount / bountyDraftCards / shopDraftCards`, `shared/protocol.js SP_CARDS_MAX`

- Strategy draft: a match of more than 4 seats has `largeRoom.bandTurn` = **20 s** turns (`BAND_TURN_SECONDS` 30 otherwise — 8 × 30 s would take 4 minutes); `draft.turnSeconds` shows it.
- 机变: co-op card count = max(the round's cards (6), alive + 2), alive = the players alive at the draft start — 6 for 1–4 (official), 7 / 8 / 9 / 10 for 5–8, so the last picker still chooses from 3; the former hard `Math.min(…, 6)` cap is gone. Structured drafts fill the extra cards: a 悬赏决策 tops its official structure up with other eligible bounty cards of the same kind, a 机密商店 draws its slot pattern again from the start (VI, VI, V, 盟约之币 …), 战术决策 / 道具补给 draw every card on its own anyway. `g.choice` takes `idx` < `SP_CARDS_MAX` (10). A later pick lasts `largeRoom.spTurn` = **12 s** when more than 4 are alive at the draft start (`spFirst` 30 s unchanged, `spTurn` 16 s for 1–4); `m.public.sp.turnSeconds` (5–8 only) is the current turn's length.

### F1.4 联防 with more than 4 alive players — `server/match/unite.js` (`uniteFieldBudget`, `uniteHelperGroups`, `assignLeakers`, `uniteFieldId`, `uniteGroups / uniteGroupOf`, `uniteBills / uniteResultFor`), `Match` (UNITE: `_uniteHomeField`, `settle(plan, results)`, `_watchClient`), `audit.js`, `sim/spec.js fitResult`, `battle/observe.js` (`multiUnite`, `uniteFields`, `uniteHomeField`, `uniteLocalFor`, `uniteSwitchFields`, `backTarget`), `ui/gameLogic.js fieldLabel`, `ui/combatHud.js UniteFieldSwitch`, `ui/teamPanel.js`, `screens/replay.js replayBattleLabel`

- Alive ≤ 4 → exactly §6.1 / META §4: one field `'u'`, ≤ 2 helpers, every leaker's counted leaks.
- Alive > 4 → k = ⌈alive / 4⌉ (2 for 5–8). k is first capped by the number of leakers (`uniteFieldCount`: 1 leaker → one field, the official layout). Helpers = the top 2k perfect players by `helperOrder` (units on the field > an active bond > standing units > seat); fields = min(k, ⌈H / 2⌉), H = the helpers selected — never a field without a helper, so 1–2 perfect players still make one field, and never one without a leaker. Helpers go 2 per field in ranking order (the first two on `'u'`, the next two on `'u2'`); inside a field the sides, the templates (1 helper → escaped_single, 2 → escaped_multi) and the colOffsets work as today (the pair's first on the right-hand field). The leakers are spread over the fields balancing the counted leaks (`assignLeakers`): the largest leaker first (equal counted leaks: by seat), each to the field with the fewest counted leaks so far (equal loads: the lowest field index). Every leaker has ≥ 1 counted leak, so the greedy gives each field at least one leaker (e.g. 1 leaker and ≥ 3 perfect players among 5–8 alive → one field with the top 2 helpers, exactly the official 联防). Each field is a normal 联防 battle with only its own leakers' enemies — on the round's battlefield (upstream 0.2.1, §26.2), a two-helper field opening both halves to a 突袭 landing (§26.1) —; settlement bills each leaker from its own field's result (`settle(plan, results)` with the fields' results in field order; `uniteBills`: survivors to their source, ≤ `lpCapPerRound` as before; a field whose battle could not run charges its leakers their own counted leaks). Coins, kills and damage of a helper and onBattleResult's `unite` come from its own field (`uniteResultFor`). No helper at all → no 联防, as today. Field ids `'u'`, `'u2'`, `'u3'` …, battle seeds `u:<round>`, `u2:<round>` …, battleIds ending `.u2` …. Each field runs on its own like the single one: in streaming mode one FieldRunner steps them all; under client-side combat each field gets its own authority (its lowest-seat connected helper) or the server, so one field may be client-run while another is server-run, and a helper's disconnect takes over only its own field. `audit.js` re-checks the budget, the helper groups and their order, the field ids, the leaker split (an independent greedy) and the per-field settlement; `m.fields` must equal the plan's fields.
- View: `m.public.unite = { helpers, leakers }` stays the union (helpers in field order, leakers in seat order); `unite.fields: [{ fieldId, helpers, leakers }]` is added **only** when there is more than one unite field (a field's `leakers` may be `[]`). `m.public.fields[]` has one `kind: 'unite'` entry per field (`players` = its helpers, the right-hand one first); `players[].fieldId` stays null for leakers.
- Frames: a field's b.progress `left` has one key per leaker of that field (≤ 7, within `RESULT_LIMITS.players`). A 联防 b.result still over `RESULT_FRAME_BUDGET` after `fitResult` dropped the unit statistics and the leaks' `mods` keeps only what settlement reads per leak / never-spawned entry (`enemyKey`, `sourcePlayerId`, a non-default `counted` / `lpr` / `boss` — `validateClientResult` takes the rest from the spec); 1–4 player results never get that far. Measured (8 humans on AI 托管, client combat, LP boosted so leakers live long): the largest 联防 b.result — 7 leakers on one field, HARD round 12 — was 38.9 KB before `fitResult`, so the 64 KB inbound frame limit (`WS_MAX_PAYLOAD`, `ROOM_LIMITS.messageBytes`) stays as it is.
- Client: each helper plays (and, as its authority, reports) its own field and may not look at another 联防 field while its own runs (client-side combat: the server answers `WRONG_PHASE 'own battle running'`, the team row says 「联防作战中无法查看其他联防阵地，作战结束后可前往查看」); a leaker watches the field holding its enemies — its team row leads there and 返回战场 brings it back there — and its `uniteLeft` / `pendingLp` (the capsule's ×N, the team row) come from that field: the replica on screen counts a leaker only when it shows that leaker's field (`uniteLocalFor`), otherwise the row reads m.public; everyone else — eliminated players, spectators — starts on the first field. Whoever may switch gets 「‹ 联防阵地 N ›」 above the ‹ › halves pill (`UniteFieldSwitch`, client-side combat; `g.watch 'u2'`); the server-run switcher and labels read 联防阵地 1 / 2 (the helper's own field stays 联防（自己）), the phase banner 「联防：A、B / C、D」. After a reload a viewer keeps the 联防 field it watched (`resumedWatch`). Replays list every 联防 field; a round with more than one labels them 「联防 1」/「联防 2」 (one 联防 per round: unlabelled, as before).

### F1.5 Final Assault and Hidden Core — `finalAssault.js`, `gamedata.js bossPoolShare / bossOvertimeDrainFor / bossOvertimeDue / hiddenThreshold`, `Match.startFinalAssault / _applyOvertime` (`bossAlive`, `hiddenLayerPlayers`)

- Pairing unchanged: seat pairs `b1` … `b4` (5–8 players: 3–4 fields), an odd last player alone on the `_s` template.
- Leader pool = bloodPoint per player alive, 1 to 8. Upstream 0.2.0 (PR #209, §25.13.4) made the pool bloodPoint × the
  players alive at the start of that boss phase, counting at most `bossHpScale.aliveFull` (4); above 4 alive this
  section's factor max(1, alive / 4) multiplies on top, so 4 × alive / 4 = alive and the pool keeps growing linearly
  (the Final Assault and the Hidden Core each read their own count; e.g. 终极 hidden 假想敌：胄, 7 200 000 per player:
  28 800 000 at 4 alive, 57 600 000 at 8). Until the 0.2.1 merge the fork multiplied upstream's former fixed pool
  (bloodPoint whatever the count, 「保持固定血量」, §20.10) by the factor. What derives from the pool's size follows: the
  per-field damage plausibility budget (the pool per `BOSS_MIN_CLEAR_GS`) and the BOSS_HIT 20 / 50 / 80 % shares.
- Overtime drain = `bossOvertimeDrainPerSec` × max(1, alive / 4) team LP per real second from 150 real s, alive at the boss phase's start; the cumulative total is floored to whole LP (5 alive: 1, 2, 3, 5, 6, 7, 8, 10 … at 1.25 LP/s). `m.public.overtimeDrainPerSec` carries the rate (5–8 only); the HUD's red DOT warning shows it (`matchStatus.js overtimeDrainPerSec(config, pub)`, its 已流失 total floored like the server's; its per-second "−N" tick, `overtimeTick`, is the whole LP that second took — 1, 1, 1, 2 … at 1.25 — never the fractional rate; a whole rate ticks the rate as before).
- Hidden Core: Σ activated layers > `hiddenCore.multi` (1200) × max(1, players / 4), players = those whose layers are summed (alive at the end of the boss round's prep): 1500 / 1800 / 2100 / 2400 for 5–8.

### F1.6 Results, limits and the rest — `results.js assignTitles`, `shared/protocol.js RESULT_LIMITS`, `audit.js`

- Titles: after the one-title-each pass (unchanged), a match of more than 4 players runs a second pass: each player still without a title gets its best-ranked eligible title even if a teammate holds it (a player with no eligible title stays without one). 1–4 players: unchanged.
- `RESULT_LIMITS.players` = `MAX_SEATS`: b.result `perPlayer`, b.progress `by` / `left` (a 联防 field's `left` has one key per leaker, up to 7); the client's former 4-entry caps use it. Every payload valid for 1–4 players stays valid.
- Team tactic cards ("若存在其他队友则他们也获得", `team: true`) still reach every alive teammate.
- The bot needs no change (boss fields stay pairs); a room with many AI seats costs proportionally more server CPU (one rehearsal and one headless battle per AI seat — DEPLOY.md §0).
- Tools: `tools/matchrun.mjs --players 1..8` and `tools/botbench.mjs coopN` (N ≤ 8) run large rooms; `tools/balance.mjs` keeps measuring co-op at 4 boards (BALANCE.md), so its 联防 stays one field.
- `PROTOCOL_VERSION` stays 1: the change is additive (an optional `room.create` field, a new C→S type, new optional view fields, wider bounds).

### F1.7 Tests and docs

- Soak: `test/match/fullmatch-coop-5seats.test.js` (1 human on AI 托管 + 4 AI, NORMAL) and `test/match/fullmatch-coop-8seats.test.js` (2 humans + 6 AI, HARD — a timed match), `min(MATCH_SEEDS, 6)` seeds each so the full suite grows little, two files so `node --test` runs them in parallel: the real simulation with client combat to RESULT with zero errors (`fullmatchRun.js`), and each phase's view checked against this section (`fullmatchLarge.js`: pool copies, the 20 s draft turn, max(6, alive + 2) 机变 cards, the 联防 helpers / fields / leaker split / `unite.fields`, boss pairs and pools, a result row per seat and — above 4 — a title for every player who spent funds). Unit tests: `test/match/largeroom.test.js` (every scaled count and timer, the 1–4 side of each rule on the same code path, the titles' second pass), `test/protocol-capacity.test.js` (capacity, seat indexes, the per-player result maps, the 10th 机变 card), `test/worker/room-capacity.test.js` (the Worker's capacity, socket limits, approved applicants, snapshots and pre-capacity rooms), `test/lobby.test.js` / `test/client-static.test.js` / `test/match/finalAssault.test.js` (the room size, the seat helpers, 5–8 pairings), `test/match/unite-large.test.js` (the 联防 planning and leaker balance, several fields server-run and client-run with one of each, a field that cannot run, an empty field, 7 leakers on one field, per-field settlement, fitResult's lean stage), `test/match/fuzz.test.js` (a block of 5–8-seat rooms with their extra field ids and 机变 indexes), `test/ui/eight-players.test.js` (seat hues, the compact panels and orders, the 10-card 机变 grid and its turn, the overtime rate, replay labels) and `test/ui/unite-fields.test.js` (the client's 联防 field helpers); in a browser (`SP_E2E=1`) `test/ui/eight-players.e2e.test.js` and `test/ui/unite-fields.e2e.test.js` at 640×360 / 844×390 / 1920×1080.
- Docs: README, PLAYING §12 (+ §1, §3, §5, §7, §8, §9), META (§1 timers, §1.2, §1.3, §3, §4, §5, §6), DATA (`largeRoom`), DEPLOY §0, CLOUDFLARE, BALANCE (the tables are measured at 4), CHANGELOG (unreleased).

---

## F2. Phones (player report and phone audit, 2026-10-06)

A player tested on phones: Safari on iPhone, and Chrome and Firefox on Android. The report: "根本点不到干员。整个棋盘位于中间位置，缩放过小". An audit then ran the game in Chrome device emulation at 640×360 … 915×412, portrait, and an iPad. It covered screens, touch, platform quirks and performance. The items below are the ones that make the board hard to use or cover it. Everything here applies to touch screens only, unless it says otherwise; desktop framing and sizes are unchanged.

### F2.1 Pieces big enough to tap — `render/projection.js clearHud`, `ui/fieldHost.js hudBands`, `render/app.js` (pinch, battle taps), `render/pick.js pickBody`, `render/drag.js`

**Cause.** The HUD is sized in rem with the 40 px floor (§19.8). A phone in landscape with the browser's bars showing is about 780×300 CSS px. There the HUD takes 86 px at the top and 109 px at the bottom. `clearHud` zoomed the prep camera out until the bench-to-back-row band fitted the remaining 105 px: ×0.6 of the official framing, about 15 px pieces.

**Zoom floor.**
- With the shop bar shown, `hudBands` adds `minZoom: 1` on touch screens, so `clearHud` never zooms the board out below the official framing.
- The bench's near edge stays above the bottom band, and the back rows may go under the top HUD.
- Owner's decision 2026-10-07: on a phone (`device.js isPhone`) the bond strip starts **folded** at the start of each 休整期 (`gameLogic.bondStripFolded`, `screens/game.js` phase effect), so the back row of the zoomed prep board is not under the bond discs; the strip's collapse button — since upstream 0.2.1 a bare half-transparent ‹ / › arrow with the 44 × 44 touch target kept (§26.13, 0983e780), which replaced the boxed 「盟约」 / 「收起」 tab — unfolds and folds it by hand, and every other phase keeps the player's choice (issue #142). Tests: `test/ui/gameLogic.test.js`, `test/ui/bond-collapse.e2e.test.js` (640×360 starts folded), `test/ui/playtest2.e2e.test.js` #8.
- At 780×300 the pieces are about 2× bigger.
- Folded, the shop-collapsed camera of public issue #5 is bigger already and keeps the whole board in view: no floor there.

**Pinch zoom and pan.**
- A second finger on the field starts a pinch: an image transform of the camera (focal length × z, the principal point moved), the same as `clearHud`. Picking, the three.js board and every layer stay consistent.
- Zoom range 1× to `USER_ZOOM_MAX` 3×. The point under the fingers stays under them. The pan reaches `USER_PAN_SLACK` 30 % of the viewport past the framing.
- The pinch is that pair of fingers: a third finger is ignored, and the pinch ends when one of the two lifts.
- A piece being pressed or dragged goes home, and no finger counts again (no new pinch either) until all have lifted.
- Any camera request or resize resets the view.

**Taps in battle.** A touch picks a unit on release, when the release is within `TAP_SLOP_PX` 12 of the press, so the first finger of a pinch and a swipe open nothing. The mouse still picks on press. With nothing under the finger, the same release goes on to the round's leader or a pen figure, and then to the ground: a special terrain tile opens its card (§24.5).

**Taps on the empty prep ground.** A finger that no piece, boss leader or pen figure took explains the terrain tile under it (§24.5) at its release, under the same tap rule (`touchTap`: the same finger, within `TAP_SLOP_PX`, the same field mode, no pinch). The prep press itself is unchanged: drag-first.

**A finger on an empty tile** picks the unit whose drawn body it is on (`pickBody`).
- The body is an upright box `BODY_HALF_W` 0.4 tile either side of the feet, from the feet to the head; the front-most unit wins.
- This applies to prep pieces and battle allies.
- A unit on the pressed tile always wins, so the tile rule of §18.1 stays the rule. The mouse keeps it strictly.

**Long press, decided at the next frame** (`drag.js nextFrame`).
- The 480 ms timer is wall-clock. On a busy phone's long frame the finger's release arrives with the next frame, after the timer: the tap became a long press, which opened the detail instead of selecting the unit.
- The decision now waits for that frame. Input events are dispatched before its animation callbacks, so a finger already lifted is still a tap.

### F2.2 The engine on a slow link — `render/app.js STARTUP_WAIT_MS`, `ui/fieldHost.js`, `main.js warmGameData`

- **What went wrong.** The flat DOM fallback board (24 px tiles in the middle of the screen) is what the report also described. `createFieldView` waited for its optional parts one after another: the asset and local-art manifests 4 s, fonts 1.5 s, the board art 2.5 s and the 3D board 6 s. That is 14 s, more than `ui/fieldHost.js`'s 12 s engine timeout, which then mounted the fallback for the whole match.
- **Now.** Those waits share one 4 s budget (`STARTUP_WAIT_MS`). Each part still upgrades the view in place when it lands.
- **Timeout.** The engine gets 30 s for the whole mount — one deadline shared by the imports and the view's startup. An engine that resolves after it is destroyed, because the fallback owns the host by then.
- **Warm-up.** Entering a room warms the render engine's modules and Pixi / pixi-spine together with the game data.

### F2.3 Covered controls and wrong taps — `css/devices.css`, `css/screens/game-shop.css`, `screens/game.js`

**The room's 复制密钥 / 复制链接 buttons.**
- Problem: they are stacked, and the generic 44 px hit area of 复制链接 covered 复制密钥. A tap on the key copied the link.
- Fix: each button's area now ends in the middle of the gap between them.

**The promotion reward's tag.**
- Problem: the vertical title shrank to one glyph.
- Fix: `flex: none`, and short screens hide its English micro line.

**A shop card's or an item's detail card.**
- Problem: it stayed over the battlefield into combat.
- Fix: it closes when combat starts.

### F2.4 Type floor — `css/devices.css` §6 (short touch screens)

The root is clamped at 40 px, so on a phone every rem size is 0.4 of its 1080p value: names, counts and descriptions in the match HUD came out at 4.4–7.6 px. The root cannot grow (the layout would not fit). So text that carries information gets `max(<its rem>, N px)`; boxes keep their sizes and long names ellipsize.

| Text | Floor |
|---|---|
| Shop-card name | 10 px |
| Shop-card bonds | 8 px |
| Bond-strip names (slots widened to 35 px so 4-character names stay apart) and layer counts | 8 px |
| Team names | 9 px |
| Funds, round, remaining placements, the ready count, effect stacks | 8–9 px |
| Detail card: stat values | 9 px |
| Detail card: stat labels | 7 px |
| Detail card: 特质 text | 9 px |

Decorations make room:
- Keyboard hints are hidden on devices without hover.
- The HUD's English captions (COUNTDOWN, LEVEL, ms) are hidden on short screens.

### F2.5 Phone keyboards — `ui/components.js TextField`

`TextField` sets `autocorrect="off"` and `autocapitalize` off by default (iOS rewrote typed room codes). It passes `autoCapitalize` / `enterKeyHint` / `inputMode` through:
- room code: `characters` + `go`;
- callsign: `go`;
- loadout search: `search`.

### F2.6 Screen awake, sound with the silent switch, locked rotation, graphics default, frame cap — `ui/device.js keepScreenAwake / useWakeLock / isPhone`, `audio.js _playbackSession`, `index.html` + `css/theme.css .rotate-hint__fs`, `ui/gameLogic.js defaultQuality`, `ui/settings.js`, `render/app.js MAX_FPS`

**Screen wake lock.** Held while the match or the room screen is mounted, and re-requested when the page is visible again. The player mostly watches a battle: the phone dimmed, locked and dropped the socket.

**The iPhone silent switch.** Before the first `AudioContext` is created, `navigator.audioSession.type = 'playback'` (iOS 16.4+). The switch no longer mutes every sound.

**The rotate hint.**
- A line on rotation lock: iPhone, 控制中心 → 竖屏方向锁定; Android, 自动旋转.
- Where the Fullscreen API exists (`html.sp-fs`), a 全屏并横屏 button enters fullscreen from the tap and locks landscape where allowed.

**Graphics default.** `quality` defaults to `medium` on phones (`isPhone`: touch and a screen side under 500 CSS px), only while no quality was saved.

**Frame cap.** `app.ticker.maxFPS = 62` on every device, so 90 / 120 Hz phones no longer draw 120 fps through a nearly static prep. It is 62, not 60, because PIXI's limiter compares whole milliseconds and a cap of exactly 60 drops frames on a 60 Hz display.

### F2.7 Not done here (from the audit)

- Portrait play: only the rotate hint shows.
- Cold-load size: about 19 MB to the first battle, plus a 6.7 MB 3D board atlas.
- Memory growth over many rounds.
- The briefing / draft / result screens' type sizes.
- Back-gesture and backgrounding handling beyond the wake lock.

**[ASSUMED]:**
- The 3× zoom limit and the 30 % pan reach.
- The 0.4-tile body box.
- The official framing as the floor, rather than a minimum tile size in px.
- The 4 s startup budget and the 30 s engine timeout.
- Each type floor.
- The 500 px phone threshold.
- 62 fps.
- `playback` audio interrupting other apps' audio.

---

## F3. 外援 / 甄选 (DIY) slots — retired on 2026-10-08 (history only)

**Retired.** On 2026-10-08, merging upstream 0.2.1, the maintainer decided that upstream's 自选编队 (§25.4, upstream
0.2.0: `room.diy`, `shared/diy.js`, data/backups.json `diy`, `server/match/player/diy.js`, `screens/diy.js`,
`kits/ops/op-*.js`) replaces this section's 外援 / 甄选: one implementation of the official four DIY slots, not two.
Nothing of 外援 runs any more. This section keeps what it was, so the fork's commits, CHANGELOG entries, tests and the
comments citing it by its fork-era id (§27) can still be read. A match recorded with 外援 picks before the retirement replays
and recovers on the rules version it was played with (the Worker keeps the earlier rules engines, docs/CLOUDFLARE.md,
docs/ACCOUNTS-HISTORY.md), never on the current engine.

**What it was** (Slapq's PR #17, written on upstream 0.1.3 and merged 2026-10-06; PR #19, the kits, and PR #20, the
shop / combat / elite fixes, merged 2026-10-07; the fork's §27 up to fork/master b8c8025):

- **Candidates and records.** The official four DIY slots — 2 at tier V, 2 at tier VI (`diyChessDict` = `TIER_6`,
  research 03 §C4) — filled by a free choice among the 87 6★ operators of `character_table` that the shop pool does not
  field (the remake had no account roster). Records `chess_char_diy_<tier>_<charId>[_b]` built by the shop's own
  `chessRecord()` into `data/waiguan.json` (`candidates`, the tier VI records, the tier V overlays;
  `tools/build-data.mjs buildWaiguan`; DATA §14b): normal = phase 2 / Lv1 / skill 4, elite = Lv60 / skill 7 with the
  operator's own module at the slot's level (tier V 1, tier VI 3); bonds derived from `mainPower` and every `subPower`
  entry (34 with a core bond, 53 协防; checked 80 of 80 against the pool operators the mode states), no 特质.
- **Match.** `room.pick { picks }` (`shared/protocol.js checkWaiguanPicks`, `shared/waiguan.js WAIGUAN_SLOTS`),
  accepted until the strategy draft (`Match.setPicks`, recorded with the checkpoint); only the picked records joined that
  match's chess table (`GameData.addChess`, normal and elite), every battle data source resolved them
  (`server/sim/simdata.js` with `waiguan`, the browser runner, the Worker's replay / recovery engines); each pick was a
  private pool entry of its owner (`SharedPool.addOwned` / `pool.owned`, the official 8 / 5 copies), drawn only with
  that `playerId`; every bot brought four (`botWaiguanPicks`).
- **Client.** The 干员调配 screen's four slot tiles and picker (`screens/loadout.js WaiguanSlots` / `WaiguanPicker`),
  `ui/loadoutModel.js waiguanPickChess` / `withWaiguan`, `data.lookup('chess', id)` falling back to the records; the
  picks stored with the account (`public/js/preferenceSchema.js PREFERENCE_KEYS` `waiguan`) or per browser
  (`sp.pref.waiguan`).
- **Kits.** One file per operator, `server/sim/content/kits/waiguan/<charId>.js`: 15 hand-written (凯尔希、煌、焰狐龙梓兰、
  推进之王、伊芙利特、早露、年、令、阿、老鲤、嵯峨、可露希尔、灰烬、琴柳、郁金香), the other 72 on the generic skill spec,
  the generic talents (`server/sim/content/genericTalents.js`) and the generic summoner
  (`server/sim/content/genericSummons.js`); a 外援 summon coming back during a battle paid its deploy cost; the
  maintainer's rules and conventions in docs/WAIGUAN-KITS.md (deleted with the kits, 2026-10-08). Placement: no module
  widened placement; 温蒂 (推击手) stood on a 高台 by her trait (§24.2).
- **Voice and art.** The 78 外援-only operators spoke the pool's 14 lines (§21.30; 1,092 files per language); their art
  came from `tools/assets/waiguan-operators.json` (`buildPlan({ extraOperators, extraTokens })`,
  `tools/probe-waiguan-assets.mjs`, `tools/gen-waiguan-operators.mjs`; 126 MiB).

**What replaces each part** (upstream 0.2.0, §25.4 and §25.3):

| 外援 / 甄选 (this fork, retired) | 自选编队 (upstream) |
|---|---|
| a free choice among the 87 6★ the pool does not field | the player's own 6★ with a kit (71 picks) or one of the official 6★ prototypes, data/backups.json `diy` |
| `room.pick { picks }`, `checkWaiguanPicks`, `Match.setPicks` | `room.diy { picks }`, `checkDiyPicks`, fixed for the match |
| a private pool entry per owner (`SharedPool.addOwned` / `pool.owned`) | a per-player stock outside the shared pool, drawn from the slot's 调度中心 level (`match/player/diy.js`) |
| the slot tiles and picker on the 干员调配 screen | the 自选编队 tab of 干员调配 (`screens/diy.js`), beside 干员持有 (补位, §25.3) |
| 15 hand-written kits + the generic talents / summoner | 71 hand-written kits, `kits/ops/op-*.js` |
| bots bring four 外援 | bots field no 自选 piece; under AI 托管 a human's own picks score more (§6) |
| the 外援 operators' voice | the 自选 operators' voice (§25.12) on this fork's engine (§21.30; a 自选 slot speaks with its operator, a 补位 piece with its stand-in) |
| the account preference `waiguan` (`sp.pref.waiguan`) | the account preferences `diy` (`sp.pref.diy`) and `ownership` (`sp.pref.ownership`), synced the way `waiguan` was (`PREFERENCE_KEYS`, Worker `POST /api/me/preferences`, docs/ACCOUNTS-HISTORY.md) |

PR #17's other half, the 匹配 queue (§F4), is not part of 外援 and stays, as does the mirror retry tool
`tools/fetch-assets-retry.mjs` (docs/ASSETS.md).

---

## F4. 匹配 (matchmaking queue) — a remake addition

§0 listed a **matchmaking queue** as out of scope for v1. This section adds one: a player waits for other players instead
of collecting a 4-letter 同盟密钥 by hand, and the server groups the waiting sessions into a fresh 同盟 room. **This is a
remake feature — the official mode has no such queue.**

### F4.1 The Node server's queue — `server/lobby.js`, `shared/protocol.js`, `public/js/screens/lobby.js` / `room.js`

| Piece | Where | Rule |
|---|---|---|
| `queue.join { difficulty }` | `shared/protocol.js`, `server/lobby.js queueJoin` | Enters (or re-enters) the queue with the difficulty the lobby has selected. Refused while a match runs (`ROOM_STARTED`: leave it first). Joining twice keeps ONE entry |
| `queue.leave` | `queueLeave` | Leaves the queue and is **always answered** with a `queue.status` — a cancel must not leave the client waiting for a frame. Never an error when the session was not queued (the client sends it on unload too) |
| `queue.status` | per session | `{ waiting, difficulty, count, total, waitedMs, minSeats, seats }`. `count` = sessions waiting for the **same** difficulty (what a group is built from), `total` = everybody waiting. Sent on join / leave and to every waiting session whenever the queue changes |
| `queue.matched` | per member | `{ code, difficulty, seated }` once a group is formed. The client then joins that code like any 同盟密钥 (`main.js` reuses the deep-link join path) and `screens/room.js` takes over (below) |
| Grouping | `queueTick` (every `queueTickMs`, only while somebody waits: an idle lobby keeps no timer) | Walks the queue in arrival order: the oldest entry heads a group, later entries of the **same difficulty** fill it up to `DEFAULT_SEATS` (4: a matched room is the official 4-seat 同盟 room; rooms of 5–8 seats (§F1) are made by hand). A group starts when it is full, or — with at least `queueMinSeats` humans — once the grace has passed, or when the head waited `queueTimeoutMs` |
| Grace | `queueGraceMs` | Measured from the **last arrival** in the queue, not from the head's own arrival: a second player whose `queue.join` is still in flight must not be split off into a group of its own (a real race the tests caught) |
| Timeout | `queueTimeoutMs` | A lone player always gets a room: the seats the queue cannot fill are left to be filled with AI teammates, so nobody waits forever |
| Liveness | `queueSilentMs` | A waiting session that disconnected or went silent is dropped by the tick, and `onDisconnect` drops it at once: the queue must never seat an unreachable player |
| Leaving the queue | `removeMember` | Entering a room (join / create / placePlayer) takes the session out of the queue automatically |
| Readiness | `startQueuedMatch` | Every matched human is `ready` before the room state is announced (it asked to be matched), so the room opens ready |
| Auto-start | `screens/room.js` | In a room whose `queue.matched` the client saw, the HOST fills the free seats with AI teammates (`room.addBot`, up to the room's capacity) and then starts (`room.start`) once every other human is ready and connected. Runs once per room code, never for a hand-made room |
| Observability | `GET /healthz` | `queued` = sessions waiting right now |
| Tests | `test/matchmaking.test.js` (each test boots its own server: the queue and the room registry are per server), `test/ui/matchmaking.e2e.test.js` (browser: queue panel → auto-join → AI fill → the match starts; and 取消匹配) |

**Deliberate choices.** Only same-difficulty players are grouped (mixing 标准 with 终极 would decide a match's difficulty by
arrival order). A group never exceeds `DEFAULT_SEATS`; a player that could not be seated keeps waiting instead of being
dropped. The queue lives in memory like every room — a server restart empties it. The room is a normal 同盟 room: it has
a code, it can be shared, and its AI teammates can still be removed by hand.

### F4.2 匹配 in the room Worker (account mode) — `worker/matchmaker.js`, `worker/rooms/queue-routes.js`, `public/js/room-net.js`

The Worker has no lobby every session is connected to: each room is its own Durable Object, and the menu of an account
page has no socket (room-net.js). Its queue is one more Durable Object, `MATCHMAKER` (instance `'queue'`, binding and
migration `v4-matchmaker` in `wrangler.jsonc`), reached over the account API; the room's own `Lobby` has no queue
(`queueTickMs: 0`: a `queue.join` on a room socket is refused, and no queue clock keeps a room awake).

| Piece | Rule |
|---|---|
| `POST /api/queue { action, difficulty?, code? }` | Signed in, from the game's own page (Origin), counted per network against its own `QUEUE_LIMIT` (a waiting page polls 40 times a minute: the queue does not use up `API_LIMIT`). `join` (the 匹配 click) is refused from a seat in a live room (`ALREADY_SEATED`, as applying elsewhere is) and starts over: a group the account was in before is left first. Answers the account's status: §F4.1's `queue.status` fields, plus `matched` once a group was formed |
| Polling | The menu page polls (`poll`, carrying the difficulty) every `QUEUE_POLL_MS` (1.5 s) while it waits; a page silent for `silentMs` (6 s) is dropped — from the queue, and from a group still waiting for its room (`expect` counts the live members only) — which is how the Worker learns of a closed page. The queue is memory only: an evicted instance starts empty and the next poll re-enters the player, except within `leftMs` (5 s) of a `leave` (a poll that crossed it). Entering a room any other way (an application, 继续对局) leaves the queue |
| Grouping | `MatchQueue.tick`, run on every call (no timer): §F4.1's rules — same difficulty, ≤ `DEFAULT_SEATS`, ≥ 2 after the grace, a lone player after the timeout. The grace runs from the last arrival **of the group** (the Node queue takes the whole queue's): players of another difficulty never hold a group back |
| The room | The group's first account is its **host**: `matched { role: 'host', code: null, expect, members }`. Its page creates a co-op room the normal way (`POST /api/rooms`, `room.create`) and reports it (`hosted { code }`, refused unless the host sits in that room); a host that does not report within `hostMs` (20 s), or whose page went away before it was told, is dropped and the others go back to the front of the queue, keeping their waiting time. A host that cancels (its page leaves the room it opened) or queues again ends the group the same way. Members get `matched { role: 'member', code }` and join it like an invite (`main.js` pendingJoin → `room.join` → a join application); a room that could not be opened or reported is a toast |
| Admission | The host's page approves the join applications of **its group's accounts only** (`QUEUE_APPROVE_MS`, 60 s); a stranger's application waits for the host as always. Nothing in the queue seats, approves or creates anything: every room write is one of the players' own requests, with its usual checks |
| Readiness and start | A matched member says `room.ready` itself once inside (the Node server marks it; a failed try is repeated once the room is online again). The host's `screens/room.js` sequence first waits (≤ 30 s) until the `expect`ed humans are in — their seats must not go to AI teammates first — then fills the free seats and starts once the others are ready |
| Tests | `test/worker/matchmaker.test.js` (MatchQueue rules, the Durable Object's answers), `test/worker/matchmaking.test.js` (workerd: queue → host opens and reports → the member is approved in), `test/worker-client.test.js` (the page: polling, leaving, host / member hand-over, approvals of the group only, a cancel while the host opens its room, entering another way, errors) |
