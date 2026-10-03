# Assets: sources, layout, manifest, credits

Owner: `tools/fetch-assets.mjs` and `tools/assets/*`. Research background: `docs/research/07-assets.md`.

All art, Spine models and audio are **downloaded at install time**. They are never committed; `public/assets/` is git-ignored.
Everything the client needs is listed in **`data/assets.json`**. The client should only request URLs that appear in that manifest.

## Running

```bash
npm install          # also vendors pixi / pixi-spine / preact / three (tools/vendor.mjs; three.js is fetched by
                     # browsers only when data/local-assets.json lists the board atlas — the 3D board, DESIGN §15)
npm run assets       # = node tools/vendor.mjs && node tools/fetch-assets.mjs
```

| Option | Effect |
|---|---|
| `--concurrency=N` | Parallel downloads (default 16). |
| `--force` | Re-download everything. |
| `--offline` | No network. Re-runs post-processing (atlas fixes, skeleton parsing, WOFF2) on what is already on disk, then rebuilds `data/assets.json`. |
| `--dry-run` | Print the plan (file and model counts, alias notes) and exit. |
| `--refresh-index` | Re-download the upstream indexes: `audio_data.json`, `models_data.json` and (with voice) `charword_table.json`. |
| `--voice=LANGS` | Operator battle voice: `cn,jp` (default: 中文 and 日文, ~73 MB), `cn` (~32 MB), `jp` (~41 MB) or `none`. See [Operator voice](#operator-voice). |
| `--prune` | Delete files under `public/assets/` that the manifest no longer references, for example after a mapping change. Without this flag they are only listed in the report. |

The script is **idempotent**. A file on disk is kept, not re-downloaded, when any one of these holds:
- its size matches the ledger entry from a previous download (`.cache/assets-ledger.json`);
- its size matches the byte count recorded in research;
- no size is known, but the file passes format validation. Validation checks the PNG signature and `IEND`, the MP3 header, the sfnt header, the atlas page line, and that a skel is not an HTML error page.

Every download is written to a temp file, then renamed into place. A partial download therefore never reaches its final path.

How downloads are fetched:
- 16 connections at a time.
- Each source gets 3 attempts with exponential backoff.
- If `raw.githubusercontent.com` fails, the jsDelivr mirror (`cdn.jsdelivr.net/gh/…`) is tried.
- There is no mirror for the ArknightsAssets2 `voice` branch, because jsDelivr returns 404 for it.
- A manifest entry with fallbacks (for example an enemy icon that falls back to its base enemy's icon) only moves on to the next alternative after a **definitive 404**. When the primary fails transiently (network error, 5xx or an invalid payload after all retries), no fallback is fetched. The path is listed under `downloadErrors` in the report, and the next run retries the primary.
- A skeleton that fails to parse is deleted and removed from the ledger, so the next online run downloads it again.

The first run downloads about **306 MiB in about 6,800 files** (of which the operator voice, both languages: ~73 MB in
2,880 files). Without voice it was 242 MiB in about 3,700 files, 134 s on a ~3 MB/s link. A re-run takes about 1 s.

Outputs:
- `data/assets.json`: the manifest (committed).
- `public/assets/**`: art and audio (git-ignored).
- `public/fonts/*`: fonts and `fonts.css`.
- `.cache/assets-report.json`: misses, fallbacks and notes from the last run.
- `.cache/spine-info.json`: skeleton parse cache.

The run exits with code 1 if any pool operator is missing its avatar, its portrait or its Front Spine.

Upstream indexes are cached under `.cache/`. They are downloaded when missing:
- `.cache/gamedata/excel/audio_data.json`, from `Kengxxiao/ArknightsGameData` (zh_CN).
- `.cache/ark-models/models_data.json`, from `isHarryh/Ark-Models`.

The research JSONs in `docs/research/` (03, 05, 07) define **which** ids are needed.

## What is downloaded

| Class | Source | Local path (under `public/assets/`) |
|---|---|---|
| Operator avatars, 180×180. Base, plus E2 when it exists. | yuanyan3060/ArknightsGameResource `avatar/` | `char/avatar/{charId}.png`, `char/avatar/{charId}_2.png` |
| Operator half-body portraits, 180×360 | yuanyan `portrait/` | `char/portrait/{charId}_1.png`, `_2.png` |
| Default-skill icons, including backup operators' skills | yuanyan `skill/` | `skill/{iconId sanitized}.png` |
| Enemy icons | yuanyan `enemy/`. Fallbacks: the handbook id, then the base id. | `enemy/icon/{enemyId}.png` |
| Token avatars | yuanyan `avatar/` | `token/avatar/{tokenId}.png` |
| Bond icons (the real autochess glyphs) | ArknightsAssets2 `cn` `ui/autochess/[uc]autochesscommon/arts/bondicon/`. Fallback: the camp logo. | `bond/{bondId}.png` |
| Shop item icons | AA2 `…/arts/shopitemicon/` | `item/{trapId}.png` |
| Band (strategy) icons | AA2 `…/arts/bandicon/` | `band/{bandId}.png` |
| Profession, sub-profession and battle-card icons | AA2 `arts/profession_hub`, `arts/ui/subprofessionicon`, `ui_battle_new/battlecard` | `prof/icon_{p}.png`, `prof/large_{p}.png`, `prof/battlecard_{p}.png`, `prof/sub/{subProfessionId}.png` |
| UI sprites (see below) | AA2 `ui/autochess/**`, `arts/**`, `activity/[uc]act2autochess/**`, `battle/[pack]common/sprites` | `ui/{group}/{key}.png` |
| Operator battle Spine (Front, Back) | fexli/ArknightsResource `spine/{id}/{id}/{Front,Back}/` | `spine/op/{charId}/{front,back}/{stem}.{skel,atlas,png}` |
| Token Spine | fexli: the default model, or else the first skin variant (`spine/{tokenId}/{variant}/Spine/`) | `spine/token/{tokenId}/{stem}.*` |
| Enemy Spine (PC build, premultiplied alpha) | isHarryh/Ark-Models `models_enemies/{key}/`, file names from `models_data.json` | `spine/enemy/{enemyId}/{stem}.*` |
| BGM | AA2 `voice` branch `audio/sound_beta_2/music/**` | `audio/bgm/{file}.mp3` |
| SFX (UI, battle, per unit) | AA2 `voice` `audio/sound_beta_2/**`, mapped from `audio_data.json` banks | `audio/sfx/{same sub-path}.mp3` |
| Operator battle voice (中文, 日文; see below) | AA2 `voice` `audio/sound_beta_2/voice_cn/**` and `voice/**`, lines from `charword_table.json` | `voice/{cn,jp}/{wordKey}/cn_{NNN}.mp3` |
| Fonts: Bender Regular and Light, Novecento Wide | TimWangZi/The-font-of-Arknights | `public/fonts/*.{otf,ttf,woff2}`, `public/fonts/fonts.css` |

The `stem` of a Spine model is the upstream file name. Two examples: `char_107_liskam` has the stem `char_107_liskarm`, and `enemy_9032_aclionk` uses `enemy_1559_vtlionk`. The skel and atlas of a model always share one stem. pixi-spine locates the atlas by swapping the extension, so this matters.

### Id scope

- **Operators:** all 138 pool charIds from `activity_table` (`charShopChessDatas[*].charId ∪ backupCharId`), including hidden chess and backup operators.
- **Tokens:** the 20 pool tokens.
- **Enemies:** 253 ids planned, 252 in the manifest (心烛 has no assets). The set is the union of:
  - the 07 enemy list;
  - every enemy in the `act1autochess_*` wave, boss and 联防 levels that act2 modes use (from `05-maps.json`; the tutorial is excluded);
  - the bosses (`boss_1..10`);
  - the closure of their summons (`randomEnemyAttribute` spawns and blackboard `enemy_key` references);
  - every key of `data/enemies.json` (built by `tools/build-data.mjs`, when present), which adds for example the enemies swapped in by 机变 effects;
  - the bosses' handbook/model ids, such as `enemy_1559_vtlionk`;
  - enemy units spawned by operator kits (research 03 skills/talents). For example, 隐德来希's default S3 summons 心烛 `enemy_5601_entlec` through the talent key `take_extra_enemy_key`. 心烛 has no icon and no Spine in any dump, so it has no manifest entry: it is reported as a miss, and the client must draw a glyph.
- **Extra tokens:** any `token_*` key of `data/tokens.json` that research does not list gets the default avatar and Spine locations.
  - The non-token summons in that file (`enemy_9012_acloon` 炎佑, `char_605_cmedic`, `char_613_acmedc`) are found under `enemies` and `chars`.
- **Skill icons:** the default skill of every chess (`defaultSkillIndex`), plus each backup operator's `skillIndex`. That makes 144 icons.
- **UI:**
  - every group from `07-assets.json → autochessUi`: rarity, elite and chess-level sprites, the shop panel and cards, HUD, bond board, equip slot, round dialog, band choose, settlement, prepare backdrop;
  - `arts` (rarity stars, elite icons, the camp logos of pool nations, the loading illustrations used by the act2 modes, battle common sprites, act2 entry backdrops and season logo, item rarity frames);
  - extras: mode choice art, battle-ready backdrops, battle UI (speed, pause, HP slider, attack range, boss avatar frame, skill ready), `empty_skill`, the 机变 panel and cards, the equip-replace dialog, the bond detail dialog, the prep-ready panel, stage-info titles.

## Operator voice

`tools/assets/voice.mjs` takes each pool operator's **in-battle lines** from the official `excel/charword_table.json`
(Kengxxiao/ArknightsGameData, cached under `.cache/gamedata/excel/`), picked by the official `placeType` — the moment the
game plays a line — and downloads them from the ArknightsAssets2 `voice` branch:

| Role | Line (placeType) | Played by the client (`public/js/audio.js`) — voice type |
|---|---|---|
| `select` | 选中干员1 / 2 (`BATTLE_SELECT`) | tapping an own operator during a battle phase (not in 结算) — `FOCUS_CHAR` |
| `deploy` | 部署1 / 2 (`BATTLE_PLACE`) | an operator successfully deployed from the bench in prep, once its direction is confirmed (buying or dragging one says nothing) — `PLACE_CHAR` |
| `combat` | 作战中1–4 (`BATTLE_SKILL_1..4`) | an own operator's skill starts, after the battle's 行动开始 — `SKILL_PASSIVE_IMP` (SP cost ≥ 10) / `SKILL_PASSIVE_NOR` |
| `start` | 行动开始 (`BATTLE_FACE_ENEMY`) | once per battle: the squad leader, when its first enemy appears — `ENCOUNTER_ENEMY` |
| `win3` / `win` / `fail` | 3星结束行动 / 非3星结束行动 / 行动失败 (`THREE_STAR` / `TWO_STAR` / `LOSE`) | once per match, on the result screen once `m.result` has arrived: the squad leader — won without LP lost / won / lost |

- **When a line may play** follows the official battle voice rules, `audio_data.json` `battleVoice` (copied to
  `data/assets.json` `audio.voiceRules`; `BATTLE_VOICE` in `audio.js` when absent): each voice type has a priority, a
  cooldown and `overlapIfSamePriority`. One line plays at a time; a line of a higher priority cuts in (0.1 s
  cross-fade), one of the same priority only when its type overlaps, a lower one is dropped. A tap (`FOCUS_CHAR`,
  priority 10) never cuts a skill line.
- **作战中 stays occasional, with clear gaps** (the official per-type rule alone gave back-to-back lines: an important
  line cut a normal one, and each type had its own 10 s): the two passive types share **one** 10 s cooldown (start to
  start) and one 作战中 never cuts another — about 2–4 per battle, never two in a row.

  | Voice type | Priority | Same priority replaces | Cooldown |
  |---|---|---|---|
  | `BATTLE_START` (行动出发, not used) | 100 | yes | 0 |
  | `ENCOUNTER_ENEMY` | 90 | no | 0 (`minTimeDeltaForEnemyEncounter` 3 s after the battle starts) |
  | `SKILL_ACTIVE` (a skill the player activates — none in this mode) | 70 | yes | 0 |
  | `SKILL_PASSIVE_IMP` (`minSpCostForImportantPassiveSkill` 10) | 60 | no | 10 s |
  | `SKILL_PASSIVE_NOR` | 50 | no | 10 s |
  | `PLACE_CHAR` | 20 | yes | 0 |
  | `FOCUS_CHAR` | 10 | yes | 0 |
  | `NORMAL_ATTACK` (not used) | 5 | no | 36000 s |

- **The moments follow a recording of the official mode** (卫戍协议 gameplay): buying or dragging a bench operator says
  nothing; a successful deployment says 部署; every battle opens with the leader's 行动开始; 作战中 now and then, with
  clear gaps; the end line only once, when the match is settled.
- Every skill of this mode is cast automatically (技能策略), so 作战中 uses the passive types, important or normal by
  the equipped skill's SP cost. Skills are cast from the first second of a battle; no 作战中 is said before the
  battle's 行动开始 (held at most 15 s), and 行动开始 (priority 90) is never cut by one.
- All voice timing is real time (battles run at 2x, so 10 s is 20 s of battle time). A battle screen that re-mounts
  mid-battle (reconnect) does not say 行动开始 again; no line starts while the page is hidden.
- Only own operators speak: a teammate's operator on a shared field (最终攻势) or a watched one (前往查看) says nothing
  on this client.
- The squad leader (队长) of a normal stage has no slot in this mode: it is the rarest operator on the board (then 精锐,
  then the highest tier) when a battle starts.
- Voice has its own channel (设置 → 角色语音, 语音语言 中文 / 日文 / 关闭). Summons, enemies and the reserve operators
  (预备干员, no voice in the game) say nothing.
- Lines outside a battle (编入队伍, 任命队长, 行动出发, 精英化晋升, home and base lines) and 完成高难行动 (`FOUR_STAR`, 突袭
  clears) are not downloaded.
- Languages: `cn` = `CN_MANDARIN` (folder `voice_cn/`), `jp` = `JP` (`voice/`); a linkage operator with only its own
  `LINKAGE` voice uses it in both. 120 of the 138 pool operators have voice: 12 lines each, ~0.26 MB (中文) and
  ~0.34 MB (日文).

## Post-processing

- **Atlases** (research 07 §5.3):
  - Insert `size: W,H` right after each page name. fexli atlases omit it; the value is read from the PNG header. An existing size that disagrees with the PNG is corrected.
  - Ark-Models enemy atlases get `pma: true`, because their textures are premultiplied. pixi-spine reads this and sets `ALPHA_MODES.PMA`.
  - Page names are sanitized to safe file names.
  - All of this is idempotent.
- **Skeletons:** every `.skel` (Spine 3.8.99 binary) is parsed in Node with `@pixi-spine/runtime-3.8`, the parser the client ships.
  - The parse extracts animation names and durations, event names, `OnAttack` times per animation, and bounds.
  - Attachment paths are checked against the atlas regions.
  - Then the animation-role resolver runs. See `tools/assets/anim-roles.mjs` and research 07 §5.4.
- **Fonts:** OTF/TTF files are converted to WOFF2 by a built-in encoder (`tools/assets/woff2.mjs`: Brotli with null transforms).
  - Its output was verified lossless against Google's reference `woff2` decoder.
  - `fonts.css` lists WOFF2 first and falls back to the original file.
- Images stay PNG. WebP conversion is not done: it would need a native dependency.

## Manifest schema (`data/assets.json`)

All paths are URL paths relative to the site root, for example `/assets/char/avatar/char_002_amiya.png`. **Only entries whose files exist on disk are emitted.** When a key is missing, the client should use its fallback (research 07 §5.6).

```js
{
  version: 1,                       // schema version
  hash: 'a1b2c3d4e5f6',             // content hash (cache busting)
  generator: 'tools/fetch-assets.mjs',
  stats: { files, bytes, chars, charsWithBack, enemies, enemiesWithSpine, tokens, tokensWithSpine,
           spineModels, bonds, items, bands, skills, ui, sfxUnits },
  chars:   { [charId]: { avatar, avatarE2?, portrait, portraitE2?, spine: { front: Spine, back?: Spine } } },
  enemies: { [enemyId]: { icon, spine?: Spine, spineAliasOf?: enemyId } },
  tokens:  { [tokenId]: { owner: charId|null, avatar?, spine?: Spine, spineVariant?: string } },
  bonds:   { [bondId]: url },       // white glyphs; tint in CSS/canvas
  items:   { [trapId]: url },
  bands:   { [bandId]: url },
  skills:  { [iconId]: url },       // iconId = skill_table iconId ?? skillId
  skillsById: { [skillId]: iconId },
  ui:      { ['group/key']: url },  // e.g. 'hudPanel/icon_hp', 'shopCard/frame_lv1', 'loading/loading_ac_core'
  prof:    { icon: {caster…warrior}, large: {…}, battlecard: {…, token}, sub: {[subProfessionId]: url} },
  audio: {
    bgm:     { lobby, prep, combat, boss: { intro?, loop } },  // intro then crossfade to loop (1 s)
    bossBgm: { [bossId]: { intro?, loop } },                   // per-boss track of its R14/R15 level
    sfx: {
      ui:     { click, back, confirm, tab, pick, drop, error, buy, sell, income, refresh, freeze, levelup,
                merge, equip, itemMerge, bondUp, artPlace, ready, timer, draft, yourTurn, yourTurnCircle,
                target, broadcast, danger, emote, roundStart, rest, battleStart, battleStartBoss,
                bossRoundTeam, bossRoundSingle, bossRoundSecret, killBoss, killBossAll, killBossNormal,
                defenceStart, defenceUnite, battleOverReduce, battleOverNoReduce, battleOverNormal, goFirst,
                disconnect, settlementSucceed, settlementFail, settlementTeam, settlementBossSign,
                goodEvaluation, load, start, matchSucceed, matchFail, matchCancel, joinRoom },
      battle: { deploy, tokenDeploy, charDie, enemyDie, enemyDieHeavy, enemyHit, heal, win, lose, killCoin },
      units:  { [charId|tokenId|enemyId]: { attack?, hit?, skill?, skills?: {[skillIndex]: url}, die?, born? } }
    },
    // operator battle voice (tools/assets/voice.mjs; absent with --voice=none); arrays are played at random
    voice?: { [cn|jp]: { [charId]: { select: [url], deploy: [url], combat: [url], start, win3, win, fail } } }
  },
  // units' attack / hit (tools/assets/audio.mjs pickUnitSfx): operators get normal-mode banks only — the plain
  // `attack` / `combat` ability first, never a bank holding a skill-mode file (`_d` / `_h` / `_s`; the normal attack's end
  // in `_n`) — with their own projectile banks (ON_PROJECTILE_BORN / _HIT.projectile_chr_<name>) as fallbacks
  // (DESIGN §18.4: 纯烬艾雅法拉's S3 impact used to be her `hit`); enemies and tokens take the first attack-like bank
  fonts: { css: '/fonts/fonts.css', faces: { [name]: { family, weight, woff2?, original } } }
}
```

### The `Spine` object

```js
{
  skel, atlas, textures: [url],       // load with PIXI.Assets.load(skel); atlas/png sit next to it
  pma: boolean,                       // true for enemies (atlas already carries `pma: true`)
  anims: Roles,                       // resolved roles, below
  animations: { [name]: seconds },    // every animation with its duration
  events: [name],                     // e.g. ['OnAttack', 'OnStart']
  hits: { [animName]: [seconds] },    // OnAttack event times (apply damage / spawn projectile)
  bounds: { x, y, width, height } | null  // skeleton AABB (setup pose, skeleton units)
}
```

### The `Roles` object

```js
Clip      = { begin: string|null, loop: string, end: string|null, via?: 'combat'|'attackAny'|'skill'|'idle'|'attack' }
SkillClip = Clip & { index: number /* 0-based skill index */, idle: string|null /* Skill_n_Idle */ }
Roles = {
  idle: string, deploy: string,
  attack: Clip,            // play begin once, loop per attack, end when stopping; `via:'idle'` ⇒ add a flash
  attackDown: Clip|null,   // _Down variants (target below the unit)
  skill: SkillClip|null,   // for the chess's default skill (primary index)
  skills?: { [index]: SkillClip },   // when the char is used with several default skills (backups)
  die: string|null,        // null ⇒ use the Front model's Die (Back lacks it) or fade out 0.5 s
  move: Clip|null,         // enemies: Move_Begin|Move_Start + Move_Loop|Move + Move_End → Run_*
  stun: Clip|null          // null ⇒ freeze the track (timeScale 0)
}
```

`via` marks a fallback:

| `via` | The attack is actually… |
|---|---|
| `combat` | `Combat` |
| `attackAny` | a numbered attack such as `Attack_01`, possibly framed by `Attack_Begin`/`Attack_End` (`char_1045_svash2`) |
| `skill` | `Skill_1_Loop` (pure supporters) |
| `idle` | `Idle` (no attack animation at all) |

On a skill clip, `via: 'attack'` means the model has no skill animation, so the attack clip is reused.
A skill clip may also come from directional-only animations when a model has no undirected ones: for example `Skill_Right_Loop` (`char_279_excu`) or `Skill_Loop_Up` (the Back model of `char_431_ashlok`).

The resolver's full precedence list is in the header of `tools/assets/anim-roles.mjs`.

Other renderer rules from research 07 §5.4–5.5:
- **Choosing the model:** Front when the unit faces right or down; Front mirrored when facing left; Back when facing up.
- **Attacks (as the original, `render/spine.js`):** the battle is drawn 0.5 s behind the sim (`render/app.js` RENDER_DELAY, 1 game s at 2×), so every attack is known before it is shown: a swing starts only for a real attack (no swing at nothing), from its first frame, timed so that its strike frame (`hits`, the OnAttack event) lands on the attack. A one-shot clip (`Attack`, a lone skill clip such as `Skill_2`) plays once per attack at its natural speed — sped up when the attack interval is shorter, stretched at most ×1.25 (`ATTACK_STRETCH` 0.8) when longer — then the unit idles until its next swing. A begin / loop / end set (德克萨斯 Attack_Start → Attack_Loop → Attack_End, authored as one continuous motion) plays its begin clip when the unit engages, cycles the loop once per attack and, when no attack follows, ends at the end of the cycle with the end clip. Blends are given in real seconds (`MIX`) and never start before the strike frame. A clip is never fast-forwarded or re-phased, and a model never moves off its tile to attack (only the placeholder diamond lunges).
- **Skill-long effects (`render/fx.js` SUSTAINED):** fx the sim emits once at a skill's start but that last the whole skill are held until the caster's skill ends, it dies or the view clears: 余's S3 fire wall (`firewall`: a burning line across the field on the tile edge in front of him), and the fields 浊心斯卡蒂 `tide`, 白面鸮 / 流明 `healField`, 灵知 `coldWind`, 银灰 `snow` around their caster.
- **Down clips:** a target below the operator (more below than beside) takes `Attack_Down` and the `Skill_Down_*` clips.
- **Skills:** the begin clip always plays out (attacks wait), an instant skill still plays its skill clip once, and the end clip plays out. A skill mode (begin / loop / end) stays in its loop for the whole skill; a skill clip without a strike frame (德克萨斯' `Skill`, a sustained skill animation) is a pose held through the skill, never replayed per attack. A stance skill whose begin clip has the strike frame and whose loop has none (星熊, 泡泡, 白面鸮, 莫斯提马 S1, …) swings its begin clip at each attack and holds the loop in between.
- **Model size:** every skeleton is drawn at one `UNIT.modelScale` (render/style.js, 320 skeleton units per tile), which stands for the official standard. The official client also scales each enemy model in its battle prefab: the Graphic / FaceSwitcher / Spine transforms multiply to 0.27 for most enemies and for the operators' battle skins, but not for all of them. For example, 威龙 is 0.16, 妖怪 0.20 and 青铜镜 0.6. The skeletons themselves carry no such scale, because every enemy SkeletonDataAsset uses 0.01. So an enemy is drawn × data/enemies.json `modelScale` (its prefab's product ÷ 0.27, see docs/DATA.md; user playtest #6: 威龙 used to be drawn 1.35× a 妖怪 instead of 1.08×), and its HP bar sits on that model: at its setup-pose bounds' height × the same factors, or, for a skeleton without bounds, at the chibi headroom × `modelScale` (bosses 2.2 tiles). `tools/local-extract/enemy_scales.py` reads the products from a local client, and `tools/build-data.mjs MODEL_SCALES` keeps them.
- **Enemy aliases:** `enemies[id].spineAliasOf` means the model belongs to another enemy. Two cases:
  - `enemy_1305_mhslim` has no Spine anywhere, so it uses the slime model. Tint it.
  - `_2` boss variants reuse the base model.

### Other fallbacks

- **Tokens:**
  - Without an avatar, use `chars[owner].avatar` with a 召唤物 badge, or `prof.battlecard.token`.
  - Without a Spine, draw the avatar sprite with a bob tween.
  - `spineVariant` names the skin-variant model that stands in for the missing default model.
- **Enemies without a spine** (for example `enemy_9016_acstmr`): draw `icon` in a diamond. Enemies with no manifest entry at all (`enemy_5601_entlec` 心烛): draw a procedural glyph.
- **Battle effects** (projectiles per kind, hit sparks and slashes, skill bursts and auras, 蕾缪安's lock reticles and shells, 回环射手 boomerangs — DESIGN §17.3) are procedural: the FX atlas is drawn at run time (`public/js/render/textures.js`), so they need no downloaded or local art. The local client does have battle effect art — `battle/[pack]common.ab` holds per-weapon projectile sprites (`projectile_arrow(_new)`, `projectile_crossbow(_new)`, `projectile_yuki`, `img_fx_light_01/02`, `trail_11`), and the per-character `battle/prefabs/effects/*.ab` are particle systems whose textures live in other bundles — but none of it is extracted: the sim's `arrow` also covers gun snipers, and friends joining a game may not have the local art.
- **Spine memory** (`public/js/assets.js`): skeletons are refcounted in an LRU with an idle budget (`SPINE_IDLE_BYTES`, 48 MB) and a 15 s grace; eviction runs `SPINE_EVICT_DELAY_MS` (1 s) after a release, the "no scene on screen" budget (0 bytes) applies after `SPINE_QUIET_DELAY_MS` (3 s) with nothing referenced, and a skeleton whose unload is still in flight is never handed out again — a new load waits for the unload (DESIGN §17.1; it used to leave operators invisible after a battle → prep switch).

### Looking up `data/chess.json` asset ids

`data/chess.json` stores asset **ids** in `chess[*].assets` (docs/DATA.md). They map onto this manifest as follows (checked for all 258 chess):

| `assets` field | Example id | Manifest URL |
|---|---|---|
| `avatar` | `char_498_inside` / `char_498_inside_2` | `chars[id].avatar` / `chars[id minus "_2"].avatarE2` |
| `portrait` | `char_498_inside_1` / `char_498_inside_2` | `chars[id minus "_1"].portrait` / `chars[id minus "_2"].portraitE2` |
| `spine` | `char_498_inside` | `chars[id].spine.front` (and `.back`) |
| `skillIcon` | `skchr_inside_2` | `skills[id]` (the id is the skill's `iconId`) |
| `subProfIcon` | `sub_fastshot_icon` | `prof.sub[id minus "sub_" and "_icon"]` |
- **Missing unit SFX:** use `audio.sfx.battle.enemyHit` or a WebAudio blip (research 07 §6.4).
- **Bond icons:** if the real glyph ever fails, the stored file is the nation camp logo.

## Verification

`node --test test/assets.test.js` covers the pure helpers: the resolver, the atlas normalizer, the format sniffers, WOFF2, audio banks, the plan id sets, the downloader against a fake network, and the self-heal of corrupt skeletons.
When `public/assets` exists, the same file also checks the generated output:
- Every manifest path exists on disk.
- Every pool operator has an avatar, a portrait and a Front model.
- Every atlas has `size:` lines, plus `pma: true` for enemies.
- Every Spine model loads the way the client loads it. That means pixi-spine's atlas reader with real page sizes, where a region outside its page throws, then `SkeletonBinary` with `AtlasAttachmentLoader`, where a missing region throws. Every resolved role is then posed.

The 2026-09-27 verification pass also checked:
- **PNG:** all 2,211 PNGs pass a full CRC and inflate check.
- **Audio:** all 467 MP3s decode with ffmpeg without errors.
- **Browser:** headless Chrome loads and animates all 529 Spine models with the vendored PixiJS 7.4.2 and pixi-spine 4.0.6, with no console errors. Chrome's font sanitizer also accepts the three WOFF2 files.
- **Official data:** 771 provenance checks against the official data (`activity_table`, `skill_table`, `models_data.json`) all match: avatars, portraits, E2 art, bond, band and item icons, and enemy skeleton files.

## Licensing and credits

The project's code is GPL-3.0-or-later (`LICENSE`); none of the items below is covered by it. Details: `NOTICE.md` (scope, non-commercial terms) and `THIRD-PARTY-NOTICES.md` (libraries, fonts, licence texts).

- **Game assets.** All images, Spine models, audio and game data are © **Hypergryph (上海鹰角网络)**. The overseas publisher is **Yostar**.
  - This is an **unofficial, non-commercial fan project**: no ads, donations or paywall.
  - Assets are fetched from public community dumps at install time and are not redistributed in this repository. The plug-and-play bundle attached to a GitHub release does carry them (with the local-client art) under the same non-commercial terms, with `NOTICE.md` inside.
  - Assets will be removed on request from the rights holders.
  - The client must show a credits screen: "Arknights © Hypergryph / Yostar. This is an unofficial fan project; all game assets belong to their owners."
- **Asset dumps and tools.** Credit to:
  - [yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)
  - [fexli/ArknightsResource](https://github.com/fexli/ArknightsResource) (ArkResourceAutoUpdateBot)
  - [isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models) (ArkUnpacker). Not for commercial use.
  - [ArknightsAssets/ArknightsAssets2](https://github.com/ArknightsAssets/ArknightsAssets2) (ArknightsStudio)
  - [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)
- **Spine runtime.** pixi-spine is MIT-licensed. It embeds Spine Runtime code under the [Spine Runtimes License](http://esotericsoftware.com/spine-runtimes-license), which formally expects a Spine Editor licence. This is commonly tolerated for non-commercial fan tools, and the Spine Runtimes License must be credited (`THIRD-PARTY-NOTICES.md`). The project's GPL carries an additional permission (section 7) to combine it with the Spine Runtimes (`NOTICE.md`).
- **Fonts.**
  - **Bender:** © Jovanny Lemonad (Oleg Zhuravlev, Ivan Gladkikh). Free for personal and commercial use.
  - **Novecento Wide:** © Jan Tonellato / Synthview. Free licence.
  - Both are mirrored from TimWangZi/The-font-of-Arknights.
  - Noto Sans SC and Noto Serif SC (SIL OFL) are loaded from Google Fonts, not self-hosted.
