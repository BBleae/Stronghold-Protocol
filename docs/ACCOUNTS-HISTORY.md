# 账号（用户名密码 / GitHub）、续局、历史与回放

这些功能用于 Cloudflare 部署。Node 本地模式继续使用原匿名流程。账号用用户名和密码登录，GitHub OAuth App 配置有效时也可用 GitHub 登录（以 GitHub 数值 ID 关联，GitHub 改名不创建新账号）；玩家主动点击「继续对局」后接管原席位，旧设备停止写入。浏览主页不会自动接管。

## 登录方式与博士代号

- **用户名和密码**：始终可用（标题页的账号卡片：登录 / 注册）。用户名为 3–20 位字母、数字或下划线，不区分大小写唯一（保存输入时的大小写），只用于登录，从不展示给其他玩家。密码 8–128 位（任意字符），以 PBKDF2-SHA256 存储：100,000 次迭代（Cloudflare Workers 的上限；本地 workerd/Miniflare 不限制，不要调高）、16 字节随机盐、32 字节密钥，连同参数一起保存；参数变化后，下次登录成功时按新参数重新存储。哈希在 Worker 请求里计算，不在 SiteDirectory DO 里计算。用户名不存在时同样计算一次哈希；用户名不存在与密码错误给出同一个答复「用户名或密码错误」。注册要写两个对象：先在该账号的 Account DO 记下注册，再由 SiteDirectory 登记用户名、密码哈希与编号，最后保存账号资料；中途中断（例如部署时对象重启）的注册在第一次登录时补完。
- **GitHub**：只有 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`AUTH_ORIGIN`（不带路径的 https 源）都已配置、且凭据未被判定无效时，账号卡片才显示「使用 GitHub 登录」。Worker 用一个虚构的授权码向 GitHub 的 token 接口检查凭据，不需要用户：返回 `bad_verification_code` 表示有效，`incorrect_client_credentials` 或 `redirect_uri_mismatch` 表示无效，其他答复或网络错误为未知（照常显示，稍后再查），见 [GitHub 文档](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors)。结论按配置指纹（client id、secret 与 `AUTH_ORIGIN` 的 SHA-256）保存在 SiteDirectory DO 与各 isolate：有效 24 小时、无效 1 小时、未知 5 分钟，`/api/me` 最多约每个有效期等一次 GitHub。真实登录换取令牌时若 GitHub 给出上述「无效」答复，Worker 会立即检查一次凭据并记录检查结论：授权码是访问者带来的，可能是为其他回调地址签发的，只有检查结论对所有玩家生效（检查认为凭据没问题时，只有这次登录失败，记入运行日志 `github_code_refused`）。更换 secret 或 client id 即是新配置，会重新检查。无效凭据记入运行日志 `github_credentials_invalid`，检查失败记入 `github_check_failed`。
- **博士代号**：每个账号在所有地方都显示为「代号#NNNN」（如 `晴猫#1145`）。代号为 1–12 个字（按名字规则规范化后，须含可见字符，不能包含 #），可以重名；编号 NNNN 为随机的 0000–9999，同一代号的编号全站唯一，由 SiteDirectory DO 统一分配。判断是否同一代号时，先去掉不可见字符（Unicode 的 Default_Ignorable_Code_Point），再做 NFKC 规范化并转小写，因此形近字、大小写变体和夹带不可见字符的代号共用一组编号，两个账号的「代号#编号」不会看起来相同。一个代号的 10000 个编号都被占用时，提示换一个代号。
- GitHub 账号的代号取 GitHub 名称（没有或只有不可见字符时取登录名），去掉 #、截到 12 字。之前登录过、还没有编号的 GitHub 账号，下次打开页面或登录时自动分配并保存编号。GitHub 名称变化时，新代号下原编号空闲则保留，否则重新分配；玩家自己修改过代号后，GitHub 名称不再覆盖它。
- 大厅的账号菜单可「修改代号」（新代号下原编号空闲时保留，否则重新分配，旧的「代号#编号」随即释放）和「修改密码」（仅用户名密码账号；需当前密码，该账号其他设备的登录随即失效，本设备保持登录）。
- 房间、加入申请、在线大厅、观战和对局记录里的名字都由服务器按账号资料决定：Worker 在建立房间连接时读取账号资料，客户端 hello 里的名字不再使用。名字最长 17 个字（12 字代号 + `#NNNN`），服务器任何地方都不截断；界面上一行放不下时只省略代号的末尾，`#NNNN` 总是完整显示（编号才是区分同名玩家的部分）。Node 模式手动输入的代号仍为最多 12 字。改代号后，房间里的名字从下一次连接起更新（对局进行中不变）。
- 登录尝试另外限流（Cloudflare rate limiting 绑定，每分钟计数，超过时答复「尝试次数过多，请稍后再试」）：注册每个网络每分钟 3 次；密码校验（登录、修改密码）每个网络每分钟 10 次，其中同一用户名每分钟 5 次。用户名的次数也按网络分别计算：别人的尝试只用掉他自己网络的次数，不能借限流把玩家挡在门外。绑定只能按 10 秒或 60 秒计数，因此没有按小时 / 15 分钟的窗口。

## 在线大厅与加入申请

首页的在线大厅列出公开、有真人在线的同盟房间。房间状态变化时立即更新目录，在大厅可见期间每 20 秒续一次租约，一分钟没有续约的条目自动隐藏（休眠的房间因此一分钟后从大厅消失，下次唤醒时重新发布）；页面可见时每 10 秒刷新，后台标签页暂停轮询。

加入必须由房主批准，邀请码也不能绕过审批。每个账号同一时间只有一条待审批的申请，单个房间最多 20 条。申请有效期 120 秒，批准后为申请者预留席位 120 秒（批准时申请者已在别的房间入座，则申请失效并告知房主）；开始游戏、转私密、房间关闭或过期会使未完成的申请失效。创建房间失败后留下的未使用预留不会阻止再次创建（直接沿用）或申请加入别的房间（申请时放弃该预留）。「继续对局」接管后席位换用新 token，被接管的设备醒来后无法凭旧 token 夺回席位（收到 4001）。

## 管理员重置密码

为忘记密码的玩家设置新密码，需要单独的管理凭据 `ACCOUNT_ADMIN_TOKEN`（至少 32 个字符，与备份用的 `ARCHIVE_EXPORT_TOKEN` / `ARCHIVE_IMPORT_TOKEN` 分开：各自只有需要的权限），用 `npx wrangler secret put ACCOUNT_ADMIN_TOKEN` 配置。未配置时重置接口一律拒绝。

```powershell
# 在当前终端环境安全设置 SP_ACCOUNT_ADMIN_TOKEN（与 ACCOUNT_ADMIN_TOKEN 相同）后：
npm run accounts:reset-password -- --origin https://stronghold.lunar.ag --username <用户名>
# 或由工具生成随机密码，并只显示这一次：
npm run accounts:reset-password -- --origin https://stronghold.lunar.ag --username <用户名> --generate
```

工具不回显输入的密码（需输入两次），也不保存或打印凭据。重置后该账号的所有登录立即失效，房间连接最迟约一分钟后断开。每次重置记入运行日志 `account_password_reset`（带账号 ID，不含密码）。

## 账号偏好与跨设备同步

登录后，干员技能和模组调配、大厅模式、难度、最近 4 个房间、上次使用的表情主题保存在 Account DO。新设备登录同一账号会在进入大厅前读取配置。音量、语音语言、静音、伤害数字和画质继续由各设备单独保存；Node 本地模式与未登录状态仍使用浏览器本地偏好。

首次使用时，若账号没有云端配置，会导入当前浏览器的旧偏好；同一浏览器的旧数据只归属首次迁移的账号。已有云端配置优先，其他设备的旧配置不会覆盖它。缓存和待同步修改按账号隔离；修改自动保存，断网时留在本机并在恢复后重试，刷新页面也能继续提交。关闭页面前可在干员调配页确认「已保存到账号」；「已同步到对局」单独表示房间已收到调配。浏览器关闭期间无法重试，未同步内容仍须回到原设备联网后上传。

`GET /api/me/preferences` 读取配置；`POST /api/me/preferences` 按项目合并更新。写入校验登录账号、同源请求、字段和大小，服务端只在持久化成功后返回确认。并行设备修改不同项目会保留彼此结果；同一项目（包括整份干员调配）采用服务端最后接受的修改。账号切换后旧页面的写入会被拒绝，需刷新后继续。

账号偏好不包含在下述历史/回放导出工具中；它使用 Account DO 的持久存储和 PITR。

## 配置与首次发布

1. （可选，GitHub 登录）创建 GitHub OAuth App，Homepage URL 设为 `https://stronghold.lunar.ag`，Authorization callback URL 为 `https://stronghold.lunar.ag/api/auth/github/callback`。其他部署域名应同时替换这两项和 `AUTH_ORIGIN`，不要混用生产与本地 OAuth App。在该回调地址的设置里关闭「Allow wildcard matching」：开启时 GitHub 也会把授权码发往回调地址的任意子路径和子域名（2026 年 8 月 3 日之前只登记了一个回调地址的应用默认开启），GitHub 建议关闭。
2. （可选，GitHub 登录）在 Worker 环境设置 `AUTH_ORIGIN=https://stronghold.lunar.ag` 和 `GITHUB_CLIENT_ID`；通过 `npx wrangler secret put GITHUB_CLIENT_SECRET` 配置密钥。可以用 Wrangler Dashboard 配置变量，或在自己的环境配置中加入非秘密 vars。不要把 secret 写入仓库。未配置或凭据无效时，用户名密码登录照常可用，「使用 GitHub 登录」不显示；线上不能匿名创建房间。
3. 通过 `npx wrangler secret put ACCOUNT_ADMIN_TOKEN` 配置管理员重置密码的凭据（见上文）。
4. `wrangler.jsonc` 的 `migrations` 只能追加：`v2-accounts` 增加 `SITES`、`ACCOUNTS`、`MATCH_ARCHIVES` SQLite 类，`v3-ratelimits` 删除只存短期计数的 `AdmissionDurableObject`。不要修改、删除或重排已有条目，也不要删除或重命名仍在使用的类。用户名、密码哈希与代号编号的表由 SiteDirectory DO 自行创建，已有账号、会话和存档照常读取。
5. `npm ci`、`npm test`、`npm run build:worker`，按 [Cloudflare 部署指南](CLOUDFLARE.md) 发布（`wrangler.jsonc` 的 `ratelimits` 含登录限流 1007–1009）。
6. 上线验收：注册、登录、退出、修改代号与密码、管理员重置密码；配置 GitHub 时，在真实 GitHub 完成登录、取消登录、退出后重新登录；以及两设备同账号接管、两账号申请审批。本地测试通过不代表真实 OAuth App 或生产域名已经验证。

GitHub 登录使用一次性 state、S256 PKCE，临时事务 10 分钟。会话默认 30 天，服务端仅保存会话 token 哈希与账号 ID（名字等资料每次从账号读取）。Cookie 为 HttpOnly、Secure、SameSite=Lax；写 API 验证 Origin。GitHub token 只用于读取公开身份，不持久保存，也不申请仓库权限。参考 [GitHub OAuth 授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

## 持久化与统计口径

| 存储 | 保存内容 |
| --- | --- |
| Room DO | 房间、账号席位、连接 epoch、审批、完整有序对局输入/计时日志、待归档 outbox |
| SiteDirectory DO | GitHub ID 映射、用户名与密码哈希、代号编号分配、GitHub 凭据检查结果、会话哈希、短期公开大厅租约、归档目录 |
| Account DO | 账号资料（登录方式、代号与编号、头像）、调配与账号偏好、当前席位/申请、每场个人事实；统计由事实计算 |
| MatchArchive DO | 不可变结算、参与者、带 SHA-256 的回放块及原规则版本 |

只用 Durable Object 存储：全部历史放在房间对象中改动少，但房间回收与长期查询耦合在一起；D1 加 R2 便于大规模分析与归档，却给少量朋友的站点增加配置和维护。存储访问集中在 `worker/accounts`、`worker/archive` 等适配层，需要时可以迁移。

对局变更提交成功后才发送确认/状态；写失败由实例重建回到已提交状态。结算先持久化 outbox，再分发档案与个人索引；失败记入运行日志（`archive_publish_failed`），按退避重试（30 秒起，最多每小时一次），不阻塞之后对局的归档；同一 matchId 不重复计数。历史可能在结算后短暂延迟显示，刷新即可。回放和结算不随空房间清理删除，只有同局参与者可读。

胜率只计算已完成的胜负对局；提前离开、中断单列。「最高到达回合」是到达过的回合，不是通过的回合。常用干员按出场的对局数计算：同一局只计一次，精英化合并到基础干员，不含召唤物。「消耗资金」是累计花费，不是累计获得。提前离开的玩家按离开时的数据统计；AI 队友没有个人统计。统计来自服务端接受的对局结果，沿用当前的客户端战斗模型，不具备完整的反作弊验证。

每个战场的回放都能按原规则重新模拟：玩家浏览器计算的战斗记录战斗规格和实际的 tick 输入，服务端运行的战斗记录战斗规格和结束 tick；只有共享首领血池的战场（多个战场同时扣同一个血池，单独重算不出结果）另存服务端帧。缺失或损坏片段会明确标记不可播放，不用随机种子伪造完整回放。回放实例独立于当前对局。

## 回放压缩

新归档先将 JSON 的 UTF-8 字节分块压成 gzip，再以 base64 存入现有不可变块接口；读取时先验 SHA-256，再在大小上限内解压。每块最多处理 256 KiB 原始字节，不易压缩的数据自动拆小，避免超过单块存储限制。manifest 记录编码和原始字节数，旧版纯 JSON 块继续可读。

共享首领血池战场的服务端帧沿用原有 5fps 录制频率，每 150 tick（5 秒）保存关键帧；中间保存变化的属性、单位元组字段掩码、生成/消失以及必要的顺序变化。所有原始事件保留，不额外量化浮点数，也不降低录制频率。关键帧有 tick/index 索引及共用单位资料字典，便于后续增加进度跳转；当前界面仍提供暂停、倍速、选战场和从头播放。

下表是帧编码本身的测量：测试局的 30 个战场（普通战斗、联防、首领与隐秘核心）全部按帧录制，共 12,890 帧；该测试调整了生命值/隐秘核心门槛以覆盖所有阶段，结果不代表所有阵容。现在只有共享首领血池的战场录制帧，实际回放比表中小得多。逐帧还原状态及事件完全相等。相同内容的实测 UTF-8/存储文本大小如下，包含 base64 开销，不含 SQLite 页与 manifest 元数据：

| 格式 | 字节 |
| --- | ---: |
| 原完整帧 JSON | 8,768,104 |
| 仅 gzip + base64 | 1,191,232 |
| 关键帧 + 增量 JSON | 4,285,762 |
| 增量 + gzip + base64 | 1,074,592 |

最终相对原始数据减少约 **87.7%**，比仅 gzip 再少约 **9.8%**。压缩后的确切块/manifest 在首次远端写入前持久化；重试不重新编码，避免未来调整压缩参数导致归档冲突。旧格式的待发布 outbox 继续使用原始分块格式。

## 规则版本与容量边界

`replay-versions.json` 列出生产环境运行过的每个规则版本；`replay-versions/<id>.json.gz` 是该版本的浏览器回放引擎和服务端恢复引擎。二者一同提交、备份，永不修改或删除。版本号是这两个引擎打包结果的哈希（`tools/build-replay.mjs`）：只有引擎实际包含的代码和数据会改变版本号，文档、Worker 的 HTTP 代码、构建脚本、`data/assets.json`（美术与语音清单）和本机未提交的文件都不会。

- **回放**：每个归档版本的回放引擎都作为静态资源永久发布，旧对局始终用它自己的规则回放。
- **恢复**：Worker 只内置当前版本和最近 3 个旧版本的恢复引擎（每个约 5 MiB，Worker 约 22 MiB，远低于 64 MiB 上限）。对局期间又经历了更多次规则变更部署的对局无法恢复，按中断结束并释放座位。
- **部署**：只用 `npm run deploy:worker`。它先运行 `node tools/build-replay.mjs --release`：工作区必须干净；当前代码若是新版本，会先归档并提示提交 `replay-versions.json` 和新的 `.json.gz`，提交后再部署一次。Cloudflare 控制台 / CI 构建遇到未归档的版本直接失败；`wrangler dev` 和测试不写这些文件。
- **回滚**：不要用 Cloudflare 控制台的版本回滚越过一次规则变更，旧 Worker 不认识新版本的对局。用 `git revert` 提交后正常部署：撤回到旧代码就是旧版本号，较新版本的恢复引擎仍在保留范围内。

当前恢复通过重执行完整的有序输入与计时日志来重建技能闭包及共享对象，详细归属见 [持久状态说明](persistence-fields.md)。这是完整事件恢复，尚未实现固定成本的模拟状态快照。日志上限为 200,000 条；恢复耗时随对局长度/服务端战斗量增长。测试中一局简化了首领血量、打到隐秘核心的完整普通难度对局有 924 条事件，本机恢复约 1.5 秒；该数字不是 Cloudflare CPU/内存保证。长局与大量掉线托管应在生产配额下压测，不能承诺无限长度或免费运行。

构建检查单个静态文件 25 MiB、Workers Paid 的 100,000 个静态文件和 Worker 未压缩 64 MiB 限额（gzip 大小仅作参考）。参考 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/) 和 [DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)。

房间只写入变化：每个事件结束时比较房间快照，与对局日志的新事件在同一事务提交，提交后才发出该事件的消息（ping 等只更新存活时间的消息不写入，存活时间最多每 30 秒随其他变化保存）。有人连着进行中的对局时，房间一直留在内存，未计时的阶段和暂停的战斗也一样（内存计时器至多 60 秒触发一次，没有变化就不写入）；无人连接时，只有下一个对局计时器 60 秒内到期才留在内存，否则房间休眠，存储闹钟在下一个截止时间唤醒它（唤醒需重执行日志恢复）。休眠的对局不会为刷新在线大厅列表而唤醒：列表一分钟后从大厅消失，房间下次唤醒时重新发布。实测（Miniflare，单人 FUNNY）：标签页开着的未计时准备阶段约 240 行写入/小时，暂停的战斗约 400 行/小时，玩家离开的对局休眠到恢复期限，进行中的对局约 3.6 万行/小时（其中三分之二是日志事件本身）。结束的对局在结束的同一事务中编码一次回放，存进房间自己的 archive_outbox / archive_chunks 表，不进入房间快照，发布成功后删除。浏览器下载所有回放块后播放，解压总量上限 128 MiB；个人统计扫描该账号全部历史。当前面向少量朋友的房间，尚未完成大规模容量验收；这些成本不会因使用 DO 自动消失。

## 独立备份与恢复

DO 持久存储可跨休眠与重启保留，但误删 namespace、破坏性迁移及业务代码错误仍可能损坏数据。SQLite DO 的 PITR 有过去 30 天的恢复窗口，**不是永久独立备份**，各对象恢复点也不构成跨 DO 事务。参考 [SQLite 存储与 PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

配置不同的随机管理凭据 `ARCHIVE_EXPORT_TOKEN`、`ARCHIVE_IMPORT_TOKEN`（各至少 32 字符），分别用 `wrangler secret put` 写入。玩家登录 Cookie 不能调用管理备份 API。备份工具仅写入显式指定的本地目录，不会自动发到第三方；备份不含 session、OAuth 事务、GitHub token 或 secret。导出的每个账号是其账号资料（含代号与编号）；用户名密码账号另含用户名、密码哈希（PBKDF2，不含明文）与创建时间，因此备份目录应与凭据同等妥善保管。首次 GitHub 登录中途中断、还没有账号资料的 GitHub 账号，导出其 GitHub 身份，导入后与较早的无编号资料一样在读取时分配编号。

```powershell
# 在当前终端环境安全设置 SP_ARCHIVE_EXPORT_TOKEN 后：
npm run archives:backup -- export --origin https://stronghold.lunar.ag --dir C:\Backups\stronghold\2026-10-03

# 目标环境配置相同规则版本及 SP_ARCHIVE_IMPORT_TOKEN 后，先 dry-run：
npm run archives:backup -- import --origin https://restore.example --dir C:\Backups\stronghold\2026-10-03
# 确认上述校验通过后实际导入：
npm run archives:backup -- import --origin https://restore.example --dir C:\Backups\stronghold\2026-10-03 --apply
```

每次导出使用空目录，文件不覆盖。工具预检所有对象后，先恢复身份映射（GitHub 用户或用户名与密码哈希、代号编号、账号资料）、再恢复归档并重建个人历史；冲突（GitHub 用户、用户名或「代号#编号」已属于目标环境的另一个账号，或该账号已有另一种身份）报 `IDENTITY_CONFLICT`，未知规则版本拒绝覆盖。较早的、只含 GitHub 资料（无编号）的备份照常导入，账号在下次读取时分配编号。重复导入不会重复统计，可用于失败后续跑。导入的账号在目标环境的旧会话随即失效，玩家重新登录；其他账号的会话不受影响。导出历史期间仍可能产生新结算，应在停止新开局、等待 outbox 清空后做最终一次完整导出；PITR 回退后也应复核目录、档案和个人索引并用导入重建索引。

独立导出覆盖账号身份及已归档历史/回放，**不包含正在进行的对局**；活跃局使用 Room 的持久日志和 PITR。备份尚未被自动排程，运维需定期导出并在独立环境演练。单局导入请求上限 32 MiB：导出遇到更大的对局时报 `BACKUP_TOO_LARGE` 并停止（带对局 ID），不会留下看似完整却无法导入的备份。

## 验证命令

```powershell
npm test
npm run build:worker
$env:SP_ACCOUNTS_E2E = '1'
node --test test/ui/password-accounts.e2e.test.js test/ui/account-flows.e2e.test.js test/ui/account-history.e2e.test.js test/ui/preferences.e2e.test.js test/ui/github-account.e2e.test.js
```

浏览器测试使用系统 Chrome（或 `CHROME_PATH`），覆盖注册、登录、退出、修改代号与密码、大厅审批、真实 WebSocket、两设备接管、对局历史/统计及独立回放。测试账号注入只在测试包装器存在，生产没有测试登录入口。这些测试不依赖素材（多数测试站点不发布素材，显示占位图）；发布前仍须在站点上检查真实素材、字体和资源包下载。
