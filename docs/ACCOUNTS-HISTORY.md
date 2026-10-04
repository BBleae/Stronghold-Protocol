# GitHub 账号、续局、历史与回放

这些功能用于 Cloudflare 部署。Node 本地模式继续使用原匿名流程。账号以 GitHub 数值 ID 关联，改名不创建新账号；玩家主动点击「继续对局」后接管原席位，旧设备停止写入。浏览主页不会自动接管。

首页展示租约有效且有真人在线的公开同盟大厅，10 秒刷新一次；后台标签页暂停轮询。申请必须由房主批准，邀请码也不能绕过审批。申请有效期 120 秒，批准后预留 30 秒；开始游戏、转私密或过期会使未完成的申请失效。

## 账号偏好与跨设备同步

登录后，干员技能和模组调配、大厅模式、难度、最近 4 个房间、上次使用的表情主题保存在 Account DO。新设备登录同一账号会在进入大厅前读取配置。音量、语音语言、静音、伤害数字、画质和资源下载方式继续由各设备单独保存；Node 本地模式与未登录状态仍使用浏览器本地偏好。

首次使用时，若账号没有云端配置，会导入当前浏览器的旧偏好；同一浏览器的旧数据只归属首次迁移的账号。已有云端配置优先，其他设备的旧配置不会覆盖它。缓存和待同步修改按账号隔离；修改自动保存，断网时留在本机并在恢复后重试，刷新页面也能继续提交。关闭页面前可在干员调配页确认「已保存到账号」；「已同步到对局」单独表示房间已收到调配。浏览器关闭期间无法重试，未同步内容仍须回到原设备联网后上传。

`GET /api/me/preferences` 读取配置；`POST /api/me/preferences` 按项目合并更新。写入校验登录账号、同源请求、字段和大小，服务端只在持久化成功后返回确认。并行设备修改不同项目会保留彼此结果；同一项目（包括整份干员调配）采用服务端最后接受的修改。账号切换后旧页面的写入会被拒绝，需刷新后继续。

账号偏好不包含在下述历史/回放导出工具中；它使用 Account DO 的持久存储和 PITR。

## 配置与首次发布

1. 先让现有匿名对局结束。旧匿名会话不能自动归属 GitHub 账号，旧版内存对局不能迁移成持久对局。
2. 创建 GitHub OAuth App，Homepage URL 设为 `https://stronghold.lunar.ag`，Authorization callback URL 为 `https://stronghold.lunar.ag/api/auth/github/callback`。其他部署域名应同时替换这两项和 `AUTH_ORIGIN`，不要混用生产与本地 OAuth App。
3. 在 Worker 环境设置 `AUTH_ORIGIN=https://stronghold.lunar.ag` 和 `GITHUB_CLIENT_ID`；通过 `npx wrangler secret put GITHUB_CLIENT_SECRET` 配置密钥。可以用 Wrangler Dashboard 配置变量，或在自己的环境配置中加入非秘密 vars。不要把 secret 写入仓库。未配置完整 OAuth 时，浏览大厅可用，登录按钮明确显示未配置，线上不能匿名创建房间。
4. 保留原 `v1` migration 和 namespace，部署新增的 `v2-accounts` migration；它只增加 `SITES`、`ACCOUNTS`、`MATCH_ARCHIVES` SQLite 类。不要删除/重命名现有类或使用删除存储的迁移。
5. `npm ci`、`npm test`、`npm run build:worker`，确认资源包齐全后按 [Cloudflare 部署指南](CLOUDFLARE.md) 发布。
6. 在真实 GitHub 完成登录、取消登录、退出后重新登录，以及两设备同账号接管、两账号申请审批的上线验收。本地测试通过不代表真实 OAuth App 或生产域名已经验证。

登录使用一次性 state、S256 PKCE，临时事务 10 分钟；会话默认 30 天，服务端仅保存会话 token 哈希。Cookie 为 HttpOnly、Secure、SameSite=Lax；写 API 验证 Origin。GitHub token 只用于读取公开身份，不持久保存，也不申请仓库权限。参考 [GitHub OAuth 授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

## 持久化与统计口径

| 存储 | 保存内容 |
| --- | --- |
| Room DO | 房间、账号席位、连接 epoch、审批、完整有序对局输入/计时日志、待归档 outbox |
| SiteDirectory DO | GitHub ID 映射、会话哈希、短期公开大厅租约、归档目录 |
| Account DO | 账号资料、调配与账号偏好、当前席位/申请、每场个人事实；统计由事实计算 |
| MatchArchive DO | 不可变结算、参与者、带 SHA-256 的回放块及原规则版本 |

对局变更提交成功后才发送确认/状态；写失败由实例重建回到已提交状态。结算先持久化 outbox，再分发档案与个人索引，失败可重试；同一 matchId 不重复计数。历史可能在结算后短暂延迟显示，刷新即可。回放和结算不随空房间清理删除，只有同局参与者可读。

胜率只计算已完成的胜负对局；提前离开、中断单列。常用干员按每场实际参战去重计数。客户端战场录制实际 tick 输入，服务端接管战场录制实际帧；缺失或损坏片段会明确标记不可播放，不用随机种子伪造完整回放。回放实例独立于当前对局。

## 回放压缩

新归档先将 JSON 的 UTF-8 字节分块压成 gzip，再以 base64 存入现有不可变块接口；读取时先验 SHA-256，再在大小上限内解压。每块最多处理 256 KiB 原始字节，不易压缩的数据自动拆小，避免超过单块存储限制。manifest 记录编码和原始字节数，旧版纯 JSON 块继续可读。

服务端帧沿用原有 5fps 录制频率，每 150 tick（5 秒）保存关键帧；中间保存变化的属性、单位元组字段掩码、生成/消失以及必要的顺序变化。所有原始事件保留，不额外量化浮点数，也不降低录制频率。关键帧有 tick/index 索引及共用单位资料字典，便于后续增加进度跳转；当前界面仍提供暂停、倍速、选战场和从头播放。

完整测试局含普通战斗、联防、首领与隐秘核心，30 个战场、12,890 帧；该测试调整了生命值/隐秘核心门槛以覆盖所有阶段，结果不代表所有阵容。逐帧还原状态及事件完全相等。相同内容的实测 UTF-8/存储文本大小如下，包含 base64 开销，不含 SQLite 页与 manifest 元数据：

| 格式 | 字节 |
| --- | ---: |
| 原完整帧 JSON | 8,768,104 |
| 仅 gzip + base64 | 1,191,232 |
| 关键帧 + 增量 JSON | 4,285,762 |
| 增量 + gzip + base64 | 1,074,592 |

最终相对原始数据减少约 **87.7%**，比仅 gzip 再少约 **9.8%**。压缩后的确切块/manifest 在首次远端写入前持久化；重试不重新编码，避免未来调整压缩参数导致归档冲突。旧格式的待发布 outbox 继续使用原始分块格式。

## 规则版本与容量边界

`replay-versions.json` 和 `replay-versions/*.json.gz` 必须一同提交、备份。构建保留浏览器回放引擎和服务端恢复引擎的原代码/数据，并校验哈希；不能用新规则读取旧局。首次发布前的未使用实验产物可整理，**已发布版本不得直接删除**。

当前恢复通过重执行完整的有序输入与计时日志来重建技能闭包及共享对象，详细归属见 [持久状态说明](persistence-fields.md)。这是完整事件恢复，尚未实现固定成本的模拟状态快照。日志上限为 200,000 条；恢复耗时随对局长度/服务端战斗量增长。测试的完整合作局包含 28,829 条事件；本机简化首领血量的完整普通难度/隐秘核心恢复约 1.7 秒，该数字不是 Cloudflare CPU/内存保证。长局与大量掉线托管应在生产配额下压测，不能承诺无限长度或免费运行。

构建检查单文件 25 MiB、Workers Paid 套餐的 100,000 个静态文件，以及 Worker 未压缩包体 64 MiB 限额（Cloudflare 2026-09-04 更新后 gzip 大小仅作参考）。构建默认使用付费套餐限制，无需额外环境变量。保留版本会增大包体，接近限额时必须设计独立版本服务/存储迁移，不能删除仍被历史或活跃局引用的引擎来绕过检查。参考 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) 和 [DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)。

房间只写入变化：每个事件结束时比较房间快照，与对局日志的新事件在同一事务提交，提交后才发出该事件的消息（ping 等只更新存活时间的消息不写入，存活时间最多每 30 秒随其他变化保存）。有人连接或下一个对局计时器 60 秒内到期时，计时器在内存中运行；否则房间休眠，存储闹钟在下一个截止时间唤醒它（唤醒需重执行日志恢复）。实测（Miniflare，单人 FUNNY）：标签页开着的未计时准备阶段约 240 行写入/小时，暂停的战斗约 720 行/小时，玩家离开的对局休眠到恢复期限，进行中的对局约 3.6 万行/小时（其中三分之二是日志事件本身）。服务端回放保留 5fps 的关键帧/增量序列；结束的对局在结束的同一事务中编码一次，存进房间自己的 archive_outbox / archive_chunks 表，不进入房间快照，发布成功后删除。浏览器下载所有回放块后播放，解压总量上限 128 MiB；个人统计扫描该账号全部历史。当前面向少量朋友的房间，尚未完成大规模容量验收；这些成本不会因使用 DO 自动消失。

## 独立备份与恢复

DO 持久存储可跨休眠与重启保留，但误删 namespace、破坏性迁移及业务代码错误仍可能损坏数据。SQLite DO 的 PITR 有过去 30 天的恢复窗口，**不是永久独立备份**，各对象恢复点也不构成跨 DO 事务。参考 [SQLite 存储与 PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

配置不同的随机管理凭据 `ARCHIVE_EXPORT_TOKEN`、`ARCHIVE_IMPORT_TOKEN`（各至少 32 字符），分别用 `wrangler secret put` 写入。玩家登录 Cookie 不能调用管理备份 API。备份工具仅写入显式指定的本地目录，不会自动发到第三方；备份不含 session、OAuth 事务、GitHub token 或 secret。

```powershell
# 在当前终端环境安全设置 SP_ARCHIVE_EXPORT_TOKEN 后：
npm run archives:backup -- export --origin https://stronghold.lunar.ag --dir C:\Backups\stronghold\2026-10-03

# 目标环境配置相同规则版本及 SP_ARCHIVE_IMPORT_TOKEN 后，先 dry-run：
npm run archives:backup -- import --origin https://restore.example --dir C:\Backups\stronghold\2026-10-03
# 确认上述校验通过后实际导入：
npm run archives:backup -- import --origin https://restore.example --dir C:\Backups\stronghold\2026-10-03 --apply
```

每次导出使用空目录，文件不覆盖。工具预检所有对象后，先恢复身份映射、再恢复归档并重建个人历史；冲突和未知规则版本拒绝覆盖。重复导入不会重复统计，可用于失败后续跑。导入身份时撤销目标环境旧会话，所有玩家重新登录。导出历史期间仍可能产生新结算，应在停止新开局、等待 outbox 清空后做最终一次完整导出；PITR 回退后也应复核目录、档案和个人索引并用导入重建索引。

独立导出覆盖账号身份及已归档历史/回放，**不包含正在进行的对局**；活跃局使用 Room 的持久日志和 PITR。备份尚未被自动排程，运维需定期导出并在独立环境演练。单局导入请求上限 32 MiB，超大回放需要分块导入工具的后续扩展，不应声称已经备份成功。

## 验证命令

```powershell
npm test
npm run build:worker
$env:SP_ACCOUNTS_E2E = '1'
node --test test/ui/account-history.e2e.test.js
node --test test/ui/preferences.e2e.test.js
```

浏览器测试使用系统 Chrome（或 `CHROME_PATH`），覆盖大厅审批、真实 WebSocket、两设备接管、对局历史/统计及独立回放。测试账号注入只在测试包装器存在，生产没有测试登录入口。没有素材的 checkout 使用渲染回退，发布前仍须检查真实素材和字体。
