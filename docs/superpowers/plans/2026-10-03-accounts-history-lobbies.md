# GitHub 账号、对局档案与公开大厅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Cloudflare 游戏中提供 GitHub 登录、跨设备续局、持久对局与回放、个人统计和需审批的公开大厅，保持现有视觉设计。

**Architecture:** 现有 Room DO 继续拥有房间与游戏状态；SiteDirectory DO 管理身份映射与在线目录，Account DO 管理个人索引与席位，MatchArchive DO 管理单局事实与回放。持久化有序事件、版本化检查点和幂等 outbox 连接这些对象。前端复用 Preact/htm 和既有组件。

**Tech Stack:** Node.js >=22、JavaScript ES modules、Preact/htm、SQLite Durable Objects、WebSocket、node:test、Miniflare、Puppeteer、Wrangler。

**Spec:** docs/superpowers/specs/2026-10-03-accounts-history-lobbies-design.md（用户已于 2026-10-03 批准）。

**执行记录（2026-10-03）：** 功能已按任务 1–10 在 `codex/accounts-history` 实现，并追加用户要求的 gzip 与关键帧/增量压缩。下文保留最初实施清单用于追溯；实际文件、验证证据和替代设计见 [交付记录](../reports/2026-10-03-accounts-history-lobbies.md)。其中闭包状态恢复采用完整有序日志重执行，未实施原计划的固定成本模拟状态快照；真实 OAuth 与生产部署仍需环境配置和上线验收。

## Global Constraints

- 用户明确要求：必须完全符合现有设计风格，不改变原有组件的设计风格。这是验收条件。
- 复用 theme.css 的颜色、字体、层级和动效变量；沿用 1920×1080 设计尺寸对应的 rem 缩放、1px 细线和 150–250ms 动效。
- 同一账号至多一个有效席位；新设备由用户点击继续后接管，旧设备不可继续写入。
- 公开大厅需要房主批准，开局后不允许新玩家中途加入；邀请码不能绕过审批。
- 房间每 20 秒续约，60 秒过期；前台列表每 10 秒刷新；申请 120 秒过期，批准后席位预留 30 秒。
- 会话有效期默认 30 天；OAuth 临时事务 10 分钟过期且只消费一次。
- 回放和结算默认长期保留，个人和同局参与者才可访问，不静默删除。
- 完整在线能力面向 Cloudflare；Node 本地模式保留旧流程，不假装已接入线上账号。
- 保留现有 docs/CLOUDFLARE.md 和 wrangler.jsonc 的用户改动，不更换域名、账号或删除已有 DO namespace。
- 不创建云资源、部署或索取 secret 来代替本地实现与验证；真实 OAuth 配置是上线前的外部依赖。

## Review Focus

1. GitHub 改名、Unicode 昵称或头像缺失：身份仍按数值 ID，展示有回退（任务 2、9）。
2. 旧设备迟到结果与重试操作：不能改变新设备已确认状态或重复扣款（任务 3、5）。
3. 申请批准后账号索引写入失败：不能双占席位，重试或过期必须收敛（任务 6）。
4. 对局结算部分成功后进程退出：记录最终可见、统计只增加一次（任务 7）。
5. 版本更新、后台标签页与丢失回放块：旧回放仍按原规则播放，损坏记录明确报错，不能污染当前局（任务 8、9）。

## 文件与接口约定

新文件按职责分组，不把所有新逻辑塞入 worker/index.js 或 Match.js。下列路径为计划新增；既有文件修改只限接入点。

- worker/accounts/{directory,account,auth,routes}.js：DO、身份验证与路由。
- worker/rooms/{directory,applications}.js：大厅租约与审批状态机。
- worker/archive/{archive,outbox,routes}.js：档案 DO、跨对象发布与读取权限。
- worker/storage/{journal,backup}.js：提交日志、备份序列化与校验。
- server/match/{checkpoint,durable-scheduler}.js：游戏状态白名单和可恢复调度。
- server/sim/checkpoint.js：战斗状态及事件恢复。
- shared/account-protocol.js：JSON 版本、分页与错误码；不包含 secret 或持久化私有字段。
- public/js/{account,history-client}.js、public/js/screens/{history,statistics,replay}.js：客户端能力。
- public/js/battle/replay-runner.js：隔离的只读播放实例。
- public/css/screens/{history,statistics,replay}.css：页面布局补充。
- tools/{build-replay,archive-backup}.mjs：版本化引擎构建和运维导出/导入。

公共数据形状：

```js
// UTC 毫秒时间戳；所有 ID 是服务端生成的不透明字符串。
const activeSeat = { roomId: 'ABCD', roomGeneration: 'g1', matchId: null,
  seatId: 's1', claimId: 'c1', connectionEpoch: 1 };
const version = { schemaVersion: 1, rulesVersion: 'content-hash', dataVersion: 'content-hash' };
const event = { seq: 1, commandId: 'c1', at: 1000, kind: 'command', payload: {} };
const page = { items: [], nextCursor: null };
```

实施顺序按依赖串行进行，每个任务独立验证和提交。任务 1–3 为账号基础，4–5 为持久续局，6 为大厅，7–8 为历史，9 为界面，10 为恢复与整体交付。未完成的在线入口不提前向玩家开放。

## Task 1: 存储协议与真实运行时测试底座

**Files:** 新建 shared/account-protocol.js、worker/storage/journal.js、test/worker/helpers/account-harness.js、test/worker/journal.test.js；修改 test/worker/miniflare.test.js 的可复用启动部分。

**Interfaces:** `appendEvent(storage, event) → Promise<{seq,duplicate}>`，同一 commandId 返回原序号；`readEvents(storage, afterSeq) → Promise<Event[]>`。测试 `createAccountHarness()` 返回 `{fetch, restart, dispose, failNextWrite, clock}`，clock 提供 now()/advance(ms)，restart 保留 Miniflare 磁盘目录，failNextWrite 只在测试注入依赖中可用，不暴露生产后门。

- [ ] 写失败测试，覆盖同一 ID 重复提交、乱序读取、写入失败以及重启保留。

```js
assert.deepEqual(await appendEvent(storage, event), {seq: 1, duplicate: false});
assert.deepEqual(await appendEvent(storage, event), {seq: 1, duplicate: true});
assert.equal((await readEvents(storage, 0)).length, 1);
```

- [ ] 执行 `node --test test/worker/journal.test.js`，确认因新能力缺失失败。
- [ ] 事务内分配 seq，commandId 建唯一约束；存储失败向上抛出，响应不得宣称成功。分页游标验证版本和长度，拒绝负页长、超长 ID 与未知字段。

```sql
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
```

- [ ] 重跑该测试和既有 worker 测试，验证测试底座没有改变原行为；提交本任务文件。

## Task 2: GitHub OAuth 与账号会话

**Files:** 新建 worker/accounts/{directory,account,auth,routes}.js、test/worker/auth.test.js；修改 worker/index.js、wrangler.jsonc、test/worker/helpers/account-harness.js。

**Interfaces:** `handleAuth(request, env) → Promise<Response|null>`；`authenticate(request, env) → Promise<{accountId,sessionId}|null>`。Directory 的内部 `resolveGithubUser({id,login,avatarUrl})` 按 GitHub 数值 ID 返回 accountId；Account 的 `createSession({hash,expiresAt})`、`revokeSession({hash})`、`checkSession({hash,now})` 只接受内部调用。

- [ ] 为 OAuth 成功、取消、重放、state 不匹配、PKCE、过期、logout、GitHub 502 和改名添加失败测试。GitHub fetch 注入固定响应；生产不支持客户端指定 provider URL。

```js
assert.equal(firstUser.accountId, renamedUser.accountId);
assert.equal(replayedCallback.status, 400);
assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/);
assert.equal((await authenticate(afterLogoutRequest, env)), null);
```

- [ ] 执行 `node --test test/worker/auth.test.js` 确认失败。
- [ ] 实现 state/PKCE、固定 `/api/auth/github/callback`、公开身份读取、会话哈希与 30 天有效期；临时事务先原子消费后换 token，失败重试须重新开始登录。cookie 含 Secure、HttpOnly、SameSite=Lax、Path=/，返回地址白名单限定站内。

```js
const githubId = String(profile.id);
if (!/^\d+$/.test(githubId)) throw new Error('INVALID_PROVIDER_ID');
// display name never participates in the identity lookup.
const accountId = await directory.resolveGithubUser({id: githubId, login: profile.login, avatarUrl: profile.avatar_url});
```

- [ ] 新增 SITES/ACCOUNTS SQLite DO 绑定及新 migration tag，保留原 migrations；未配置 OAuth 时返回明确 capability unavailable，不能回退为线上匿名可写身份。
- [ ] 重跑 auth 与 http 测试，验证不把 token、cookie、secret 写日志或返回 JSON；提交。

## Task 3: 可信席位与跨设备接管

**Files:** 修改 worker/index.js、worker/room-runtime.js、worker/accounts/account.js、server/net.js、public/js/room-net.js；新建 test/worker/account-seats.test.js。

**Interfaces:** Account `claimSeat({claimId,seat,expiresAt})`、`releaseSeat({claimId})`、`getActiveSeat()`；RoomRuntime `connect(ws,{ip,accountId,connectionEpoch,ticket})`，新增 `resumeAccount(accountId)` 返回席位与提升后的 epoch。HTTP `/api/me/resume` 从 cookie 获取身份，不接受 body.accountId。

- [ ] 测试两账号隔离、双设备恢复同一 playerId、旧连接关闭、旧 epoch 的 g.* / b.* 被拒绝、旧 token 不能冒用账号、同账号并发创建两个房间只有一个成功。

```js
assert.equal(secondDevice.playerId, firstDevice.playerId);
assert.ok(secondDevice.connectionEpoch > firstDevice.connectionEpoch);
assert.equal(oldDeviceResult.error, 'SESSION_REPLACED');
assert.equal(otherAccountResume.status, 403);
```

- [ ] 运行 `node --test test/worker/account-seats.test.js` 确认失败。
- [ ] 边缘校验会话后重新构造内部 headers，丢弃外部伪造身份头；房间串行提升 epoch，关闭旧连接。Account 声明以 claimId 幂等，释放检查 claimId，过期引用验证房间 generation 后清理。
- [ ] 新设备浏览主页不自动踢掉旧设备；只有 resume 操作接管。cookie 身份失效时关闭写入能力，logout 不伪造永久离局。
- [ ] 重跑席位、现有网络和房间隔离测试；提交。此阶段恢复活跃内存局可验证，但尚不能宣称服务重启可恢复。

## Task 4: 随机状态、计时器与完整检查点

**Files:** 新建 server/match/{checkpoint,durable-scheduler}.js、server/sim/checkpoint.js、test/match/checkpoint.test.js；修改 server/match/{Match,PlayerState,pool,scheduler}.js、server/sim/{Battle,rng}.js。

**Interfaces:** `exportMatch(match) → MatchCheckpoint`、`restoreMatch(checkpoint,deps) → Match`；`exportBattle(battle)`、`restoreBattle(checkpoint,deps)`；rng 增加 `getState()/setState(state)` 且不改变现有序列；持久调度条目 `{id,kind,dueAt,payload,completed}`，`restoreTimers(match,entries)` 重建命名动作。

- [ ] 先列出 Match、PlayerState、Battle 中每个可变字段的持久化归属和恢复方式，写入 docs/persistence-fields.md。逐个审查 Map/Set、共享引用、技能闭包、临时增益、召唤物、AI、首领池和随机流，拒绝用渲染 snapshot 代替完整模拟状态。
- [ ] 为 INFO_CHECK、策略选择、休整、普通战斗、联防、最终攻势写恢复测试；虚拟时钟和同一输入驱动原实例与恢复实例，比较后续结果。

```js
const checkpoint = JSON.parse(JSON.stringify(exportMatch(original)));
const restored = restoreMatch(checkpoint, freshDependencies);
assert.deepEqual(exportMatch(restored), checkpoint);
assert.deepEqual(original.rngShop.getState(), restored.rngShop.getState());
// Both instances receive identical commands and advance to the next checkpoint.
assert.deepEqual(exportMatch(restoredAfter), exportMatch(originalAfter));
```

- [ ] 执行 `node --test test/match/checkpoint.test.js` 确认失败。
- [ ] 白名单序列化字段，以 ID 重建共享引用，通过技能/阶段注册表重建行为；随机数内部状态显式可读写。替换需跨重启的匿名计时闭包为命名动作；保持 Node 原调度接口兼容。

```js
const timer = {id: 'phase:7', kind: 'phase.advance', dueAt: 1700000000000,
  payload: {expectedPhase: 'PREP', round: 7}, completed: false};
// On fire, compare phase/round and mark completed in the same committed transition.
```

- [ ] 验证未知 schema/rules 版本拒绝加载且原始数据保留；跑 checkpoint、现有 fullmatch 与模拟测试，确认规则/随机序列未变化；提交。

## Task 5: 持久化操作、自动阶段与实例恢复

**Files:** 修改 worker/room-runtime.js、worker/index.js、worker/storage/journal.js、server/match/durable-scheduler.js；新建 test/worker/match-recovery.test.js。

**Interfaces:** `commitTransition({commandId,at,kind,payload}, apply) → Promise<{seq,result}>`；`loadRoom(storage) → Promise<{checkpoint,events}>`。apply 只在受控状态上执行，输出帧缓冲至提交成功；写入失败停用该内存实例并从已提交状态重建，不能带着未提交变更继续运行。

- [ ] 测试提交前/后强制中断、重复扣款指令、过期阶段任务、旧 b.result、共享首领恢复和 24 小时/同盟断线窗口。

```js
assert.equal(recoveredPlayer.gold, committedPlayer.gold);
assert.equal(retriedPurchase.result.unitId, originalPurchase.result.unitId);
assert.equal(recoveredEvents.filter(e => e.commandId === purchaseId).length, 1);
assert.equal(ackBeforeFailedWrite, false);
```

- [ ] 执行 `node --test test/worker/match-recovery.test.js` 确认失败。
- [ ] 所有外部指令与自动定时转换通过同一提交路径；相同 commandId 返回已存结果。每次阶段切换和每 100 条事件建立检查点；战斗检查点每 5 秒建立，间隔内输入日志在确认前落盘。清理只删除已被提交检查点覆盖的事件。
- [ ] Room DO 唤醒加载 checkpoint+tail，重建 WS 绑定和计时动作；移除“running 就关闭房间”的旧分支。时间到期动作按顺序、每项一次执行，限制单次补处理量并用 alarm 续跑。
- [ ] Miniflare 使用真实磁盘目录重启验证所有战场。测试不通过则不能开放线上续局入口；提交。

## Task 6: 在线目录与房主审批

**Files:** 新建 worker/rooms/{directory,applications}.js、test/worker/applications.test.js；修改 worker/index.js、worker/room-runtime.js、worker/accounts/{directory,account}.js、shared/account-protocol.js。

**Interfaces:** `publishRoom({roomId,generation,public,connectedHumans,occupied,capacity,inMatch,expiresAt})`；`listRooms({cursor,limit,now})`；`applyToRoom(accountId,roomId)`、`decideApplication(hostId,id,decision)`、`cancelApplication(accountId,id)`。状态和时限严格按 spec。

- [ ] 测试无真人/仅 AI/租约过期不显示，私密邀请码仍审批，未登录可读不可写，非房主拒绝、重复申请、最后席位并发、开始游戏竞争、批准中途写入失败。

```js
assert.equal(listedRooms.some(r => r.roomId === botsOnlyRoom), false);
assert.equal(approvals.filter(r => r.ok).length, 1);
assert.equal(afterStartApproval.error, 'MATCH_STARTED');
assert.equal(recoveredAccountClaims.length, 1);
```

- [ ] 执行 `node --test test/worker/applications.test.js` 确认失败。
- [ ] Account 先以申请 ID 声明短期席位，Room 复核所有条件再提交；失败以同 ID 释放，超时补偿检查最终 Room 状态。只有提交批准后才发一次性入席票据，绑定账号/generation/预留期限。
- [ ] 申请取消/过期/拒绝清理账号 pending 索引；房主交接保留 pending，新开局或转私密统一失效。心跳与列表使用既有 Admission 限流结构，分页最大 50。
- [ ] 跑审批及既有 lobby/worker 测试，确认 Node 旧直连流程只在本地模式保留；提交。

## Task 7: 独立档案、历史与统计

**Files:** 新建 worker/archive/{archive,outbox,routes}.js、test/worker/archive.test.js；修改 worker/accounts/account.js、worker/index.js、wrangler.jsonc、server/match/{Match,results}.js、server/lobby.js。

**Interfaces:** Archive `appendChunk({index,hash,bytes})`、`finalize({matchId,participants,result,manifest,version})`；Account `applyMatch({matchId,revision,facts})`、`listMatches({cursor,filters})`、`getStats(filters)`。`drainOutbox(storage,send)` 执行持久 pending 消息，完成后标记投递；幂等 key 为 matchId+revision+accountId。

- [ ] 测试结算重复、finalize 后索引写入失败重启、提前离开、隐秘核心、零场次、常用干员去重、跨账号读取、房间删除后档案仍在。

```js
await account.applyMatch(facts); await account.applyMatch(facts);
assert.equal((await account.getStats({})).completed, 1);
assert.equal((await emptyAccount.getStats({})).winRate, null);
assert.equal(nonParticipantResponse.status, 403);
assert.equal(historyAfterRoomCleanup.items[0].matchId, facts.matchId);
```

- [ ] 执行 `node --test test/worker/archive.test.js` 确认失败。
- [ ] Match finish 与永久离开时冻结个人事实；持久 outbox 在 dispose 之前写入，account 索引是可重建派生数据。Archive manifest 只有块齐全且 hash 一致才标记 playable。普通失败与主动退出分别统计，未知指标显示缺失而不是编造 0。
- [ ] 增加 MATCH_ARCHIVES DO binding 和 migration，历史 API 全部校验参与关系、分页与大小限制。相同 finalize 不得覆盖冲突结果，返回冲突并留诊断。
- [ ] 重跑 archive 与 results/fullmatch 测试；提交。

## Task 8: 版本化录制与只读回放

**Files:** 新建 server/match/recorder.js、public/js/battle/replay-runner.js、tools/build-replay.mjs、test/match/replay.test.js；修改 public/js/battle/runner.js、server/match/Match.js、tools/build-worker.mjs。

**Interfaces:** `record({matchId,round,fieldId,tick,seq,kind,payload})`；`createReplayRunner({manifest,loadChunk,loadVersion,onFrame}) → {selectRound,selectPlayer,play,pause,setSpeed,dispose}`。loadVersion 校验 manifest 中 rulesVersion/dataVersion，不能 fallback 到最新版本。

- [ ] 测试普通/联防/首领 tick 输入、召唤位置、共享池更新、暂停与倍速、缺块/损坏块、旧版本、新局并行时互不修改。

```js
assert.deepEqual(replayedFinalResult, recordedFinalResult);
assert.equal(networkWritesDuringReplay.length, 0);
assert.deepEqual(liveMatchAfterReplay, liveMatchBeforeReplay);
assert.equal(corruptedReplay.error, 'REPLAY_INCOMPLETE');
```

- [ ] 运行 `node --test test/match/replay.test.js` 确认失败。
- [ ] 录制边界包括客户端模拟真实应用的 tick 和全部影响结果的外部输入；补充客户端日志上传，服务端验证 battleId、epoch、单调 tick、块序和大小，再按序存档。断线恢复/服务端接管记录为显式事件。只有 seed 不算完成录制。
- [ ] 回放创建独立 store 和模拟实例，使用现有 renderer 帧格式；dispose 清理所有监听和时钟。暂停不推进 tick，倍速只改变推进速率。
- [ ] 构建输出不可变 `/replay-engines/<rulesVersion>/` 及 dataVersion 数据；打包旧引擎目录进入新 dist，构建缺少历史 manifest 所需版本时失败。服务端版本恢复实现同样注册保留，未知版本部署阻断。
- [ ] 重跑 replay、runner、worker-build 和模拟回归测试；提交。

## Task 9: 账号、大厅、历史与回放界面

**Files:** 新建 public/js/{account,history-client}.js、public/js/screens/{history,statistics,replay}.js、public/css/screens/{history,statistics,replay}.css、test/ui/account-history.e2e.test.js；修改 public/js/{main,store,room-net}.js、public/js/screens/{title,lobby,room,result}.js、public/css/screens/{lobby,room}.css、public/index.html。

**Interfaces:** `loadAccount() → Promise<{user,capabilities,activeSeat}>`、`listHistory(filters,cursor)`、`loadStatistics(filters)`、`loadReplayManifest(matchId)`。屏幕使用独立路由状态，退出回放恢复原页面；不覆盖 store.match 的在线局状态。

- [ ] 先捕获既有标题/大厅/房间/结算在 1920×1080、1366×768 和 844×390 的基线截图；固定资源、时钟、头像和动画状态。
- [ ] 浏览器测试登录失败重试、缺头像/长昵称、首页在线大厅、审批所有状态、主动点击续局、个人统计空态、回放返回与后台停止轮询。

```js
assert.equal(await page.$$eval('[data-action="resume"]', nodes => nodes.length), 1);
assert.equal(await page.$$eval('[data-action="join"][disabled]', nodes => nodes.length), fullOrPlayingRooms);
assert.deepEqual(originalButtonComputedStyle, updatedButtonComputedStyle);
assert.equal(apiCallsAfterPageHidden, apiCallsAtPageHidden);
```

- [ ] 沿用 Button/Panel/Tabs/AvatarFrame/Modal/toast；仅添加 scoped layout CSS。大厅保留现有模式选择和邀请码，房主面板增加审批列表；历史详情复用结算卡，统计沿用数值样式，回放仅追加原风格控制栏。
- [ ] CSS 不修改 theme.css 或 components.css 的既有定义；如需图标仅添加与现有同规格路径。长文本截断+Tooltip，手机列表滚动，键盘焦点和错误提示沿用现有规范。
- [ ] 运行 `node --test test/ui/account-history.e2e.test.js` 及既有设备/大厅测试；逐张检查新增页面和原有组件截图。未配置能力的 Node 模式入口隐藏；提交。

## Task 10: 独立导出、恢复验证与上线文档

**Files:** 新建 worker/storage/backup.js、tools/archive-backup.mjs、test/worker/backup.test.js、docs/ACCOUNTS-HISTORY.md；修改 docs/CLOUDFLARE.md、README.md、package.json、test/worker-browser.e2e.test.js。

**Interfaces:** `exportArchive({matchId}) → {formatVersion,manifest,chunks,hash}`；`validateBackup(backup)`；`importArchive(backup,{dryRun})`。账号映射/索引单独导出，不导出 session、OAuth 临时事务或 token；恢复后撤销旧会话并重建统计。运维访问使用专用受限凭据，不能使用普通玩家 session 提升为管理员。

- [ ] 测试导出后删除测试数据、恢复并验证 hash/参与者/回放，未知版本拒绝、冲突不覆盖、默认 dry-run、断点恢复不重复统计、非管理员拒绝。

```js
assert.equal(validateBackup(exported).ok, true);
assert.equal((await importArchive(exported, {dryRun: true})).written, 0);
assert.equal(restoredReplayHash, exported.manifest.hash);
assert.equal(restoredStatistics.completed, originalStatistics.completed);
```

- [ ] 执行 `node --test test/worker/backup.test.js` 确认失败后实现格式校验、逐对象导入和重建。导出目的地由 CLI 参数明确指定，默认不自动发送外部存储。
- [ ] 文档写明 callback URL、secret 配置方式、迁移顺序、匿名旧局切换、备份步骤、PITR 30 天恢复窗口及跨对象一致性复核。不得称 PITR 为永久独立备份。
- [ ] 执行 `npm test`、`npm run build:worker`；在本机 Worker 启动后运行 `test/worker-browser.e2e.test.js` 与新增账户浏览器测试。模拟 GitHub 仅在测试注入层存在。
- [ ] 真实 OAuth App 未配置时明确列为未验证，不将其当成测试通过。配置后验收两设备同账号接管、重启恢复、两账号审批、结束后历史/回放和统计，确认无活跃旧局再发布。
- [ ] 提交本任务文件，汇总实际验证结果和外部依赖；部署与实际云资源配置单独报告，不能因本地测试通过就宣称线上完成。

## 自查与执行交接

所有 spec 章节已对应任务：身份 2–3、风格 9、持久化 4–5、目录 6、历史与统计 7、回放 8、备份与部署 10。Review Focus 五项分别有测试归属。测试示例中的 fixture 值由各任务的真实场景产生，不使用常量返回伪造成功。

建议主助手在当前会话串行实施：这些任务共享身份、持久化和游戏事件接口，连续上下文有利于一致性；完成后按执行技能要求安排整体复核。另一种选择是逐任务使用子代理实现与独立复核，隔离更强但上下文与协调成本更高。

开始实施前等待用户审阅本计划并选择执行方式。设计批准不能替代对这份新计划的审阅。
