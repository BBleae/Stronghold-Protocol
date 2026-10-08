# Cloudflare 部署

当前账号使用 **Workers Paid** 套餐；构建按最新 Worker 未压缩包体 64 MiB、100,000 个静态文件限额检查，无需设置套餐环境变量。

当前唯一公开入口：[stronghold.lunar.ag](https://stronghold.lunar.ag)。`workers.dev` 和版本预览入口均关闭；目前未启用密码或 Cloudflare Access。

适用场景：4–20 位朋友，分为多个游戏房间（每个同盟房间默认 4 个席位，和官方一样；房主可以在等待室扩到 8 个，5–8 人是本作的扩展，规则见 [玩法指南](PLAYING.md) 第 12 节）。网页、游戏代码和素材（美术、音频、字体）由 **Workers Static Assets** 提供；每个房间使用独立的 **SQLite Durable Object + WebSocket**，复用原有房间、经济、回合和战斗协议。玩家浏览器计算正常战斗，AI / 掉线玩家由服务端处理。玩家可以在「资源管理」在线下载全部素材、下载完整资源包 ZIP 或导入本地 ZIP，也可以按需加载（见下文「资源包」）。

## 为什么这样分配

- 静态资源包括网页、游戏代码、游戏数据、资源清单所列的素材与字体、资源包分块和各规则版本的回放引擎，不计入 Worker JS 包体，也不经过房间对象。素材拆成数千个小文件，均小于 Static Assets 单文件 25 MiB 的限制，总数远低于 Paid 套餐 100,000 个文件的限制（构建会检查）。
- 当前版本不需要 R2。完整 ZIP 超过 25 MiB，不能作为单文件放进 Static Assets；下文的整包下载通过分块存储并由 Worker 拼接提供。后续若资源频繁更新且需要独立生命周期，可把完整包或素材迁往 R2 并配置自定义域名 / 缓存。
- 一个房间一个 DO 保证房间事件顺序，避免多个 Worker 实例各自保有不同状态，也无需 WebRTC 的 NAT 穿透、信令与 TURN。等待房间使用 WebSocket Hibernation；无人连接的对局休眠到下一个计时器，详见 [规则版本与容量边界](ACCOUNTS-HISTORY.md#规则版本与容量边界)。
- 亚太 `locationHint` 是尽力提示，不能保证落在指定地区。大陆用户的实际连通性和延迟取决于网络线路，提前下载或导入资源只能减少素材加载等待；请朋友实测自定义域名的可达性。

参考：[Static Assets 限额](https://developers.cloudflare.com/workers/static-assets/platform/limits/)、[DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。静态资源和房间计算是不同的计费项；当前按已有 Workers Paid 套餐部署。

## 构建和部署

需要 Node.js 22+、npm 和现有 Cloudflare 账号。仓库不含受版权保护的游戏素材，构建从本机的完整素材生成资源清单、发布清单所列文件并打包资源 ZIP：沿用原有 `npm run setup` 准备素材，或使用已有完整本地项目。`npm run build:worker` 会检查 `data/assets.json` 引用的素材，缺失时自动运行 `tools/fetch-assets.mjs` 下载；下载失败或素材目录为空时构建失败。`SP_SKIP_ASSETS=1` 可跳过自动下载，但不会跳过空素材检查。

```powershell
npm ci
npm run setup
npx wrangler login
npm run build:worker
npm run dev:worker
```

`wrangler.jsonc` 当前指向用户选择的「晴猫」账号，Worker 名为 `stronghold-protocol`；`workers_dev` 与 `preview_urls` 均为 `false`。域名由 Cloudflare 控制台管理，配置文件不写 `route` / `routes`，后续部署会保留控制台已有的域名绑定（[官方说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)）。迁移到其他账号前应修改 `account_id`。开发访问 Wrangler 输出的 localhost 地址。Windows 上先停止 `dev:worker` 再部署，避免它的目录监视器占用构建输出。

部署只在维护者自己的机器上进行，用干净的提交：

```powershell
npm run deploy:worker
```

`deploy:worker` 只部署干净的提交；代码产生新规则版本时，它先归档该版本并要求提交 `replay-versions.json` 与新的 `replay-versions/<id>.json.gz`，提交后再运行一次（见 [规则版本与容量边界](ACCOUNTS-HISTORY.md#规则版本与容量边界)）。不要把仓库接到 Cloudflare 控制台的自动构建或其他 CI 部署：它们不能提交新规则版本，遇到未归档的版本会直接失败。

首次部署到新 Worker 后，在 **Workers & Pages → stronghold-protocol → Settings → Domains & Routes → Add → Custom domain** 中绑定自己的域名。已有 Worker 可在同一位置更换或增加域名，无需修改仓库。由于 `workers.dev` 和版本预览入口已关闭，新 Worker 绑定域名前没有公开访问入口。不要用 `"routes": []` 代替省略字段，否则部署会移除已有路由。

这些命令使用 `npm ci` 按 `package-lock.json` 安装的项目内 Wrangler，使本地开发、配置校验与部署使用相同版本。更新 Wrangler 时，应更新锁文件并完成构建与测试后再部署。若已安装 Bun，也可在完成上述 `npm ci` 后运行 `bun run dev:worker` 和 `bun run deploy:worker`，同样调用项目内 Wrangler；Bun 是可选工具，不是部署前提。

Wrangler 执行构建、上传本地静态文件，保留 `ROOMS`（房间），并通过追加迁移增加 `SITES`（身份/目录）、`ACCOUNTS`（个人索引）、`MATCH_ARCHIVES`（历史/回放）SQLite DO。按网络（IPv4 地址 / IPv6 /64）和账号的请求限流使用 Cloudflare 的 rate limiting 绑定（`wrangler.jsonc` 的 `ratelimits`，每分钟计数，不写存储）：每个 `/api` 请求和房间连接先按网络计数，再接触任何 DO（包括登录查询）；注册、登录和修改密码另按网络计数（`REGISTER_LIMIT`、`LOGIN_LIMIT`），登录和修改密码再按「用户名 + 网络」计数（`USERNAME_LIMIT`，别人的尝试不会用掉玩家自己的次数）；原来的 `ADMISSION` 限流 DO 由迁移 `v3-ratelimits` 删除（它只存短期计数）。快速匹配的队列是 `MATCHMAKER` DO（迁移 `v4-matchmaker`，单个实例，只在内存里排队，不写存储），页面在大厅通过 `POST /api/queue` 轮询，按网络另计 `QUEUE_LIMIT`，不占用 `API_LIMIT`（[DESIGN §F4.2](design/fork.md)）。限流绑定的 `namespace_id` 在同一 Cloudflare 账号内必须唯一。账号的两种登录方式（用户名密码，以及配置有效时的 GitHub）、管理员重置密码的凭据 `ACCOUNT_ADMIN_TOKEN` 与 `npm run accounts:reset-password`、迁移、独立备份见 [账号与历史指南](ACCOUNTS-HISTORY.md)。

构建只发布 `dist/client/` 以及 `dist/worker/index.mjs`。前端保持 `/data/`、`/shared/`、`/sim/` 的既有路径；Node 文件系统数据读取由构建时 JSON 导入替换（`worker/data-loader.js`：服务器和模拟读取的数据文件，包括补位与自选编队用的 `data/backups.json`；`data/assets.json`、`data/emotes.json` 只给客户端，不进 Worker 和规则版本引擎）。内容加载器按路径动态导入的模块（`server/sim/content/index.js` 的 kit 注册表与各领域模块，`kits/index.js` 按 `KIT_FILES` / `STANDIN_KIT_FILES` / `OPERATOR_KIT_FILES` 逐个导入的 `kits/ops/*.js`，`bands.js`、`bonds.js` 的分块）由 `tools/build-worker.mjs` 换成字面导入，三份 kit 列表直接从 `kits/index.js` 读取：漏掉的模块在 Worker 里会悄悄退回通用 kit（`test/content/kit-registry.test.js` 检查）。语言包按静态文件发布：`public/i18n/<code>.json`（界面文字）、`data/i18n/<code>.json`（游戏文字）和 `/packs/index.json`（Node 服务器由 `server/packs.js` 实时回答，这里在构建时按同样内容写出，`packs/<id>/` 文件夹包清单所列的文件一并发布）；没有这个索引时语言菜单只有中文。`public/assets/`、`public/fonts/` 发布资源清单列出的全部文件，包括本机客户端提取的 `public/assets/local/`；`data/local-assets.json` 原样发布，游戏优先使用其中列出的本地提取素材（官方 3D 棋盘、模组图标、表情、指南等），清单缺少它列出的文件时构建失败；`public/dev/`、ZIP、日志、source map 和服务端私有数据读取模块不会发布。不要手动把整个仓库上传为静态站点。

## 资源包

站点发布资源清单 `/resource-manifest.json`（每个文件的路径、大小与 SHA-256）和清单所列的全部文件。清单收录本机 `public/assets/`、`public/fonts/` 下的全部美术、音频与字体文件，包括本地提取素材（大小与文件数以本站清单为准）。部署机器上的素材以合并后的完整资源包为准（维护者主检出根目录的 `网页卫戍资源包baseline.zip`）：所有历史资源包的并集，同名文件取高清版本。完整资源包有三种拿法，内容相同：

1. **直接下载**：本站的 `/stronghold-resources.zip`（资源管理窗口里的「下载资源包 ZIP」）。部署时构建把资源包切成 24 MiB 的分块放进静态资源，Worker 把分块按顺序拼成一个文件返回：每次下载只算一次 Worker 请求（分块本身是免费的静态资源），支持断点续传和 Range，迅雷 / IDM / aria2 等工具可以多线程下载。文件名带资源版本，和站点当前的素材一致。
2. **本地脚本**：取与站点相同版本的本仓库，Windows 双击 `scripts\make-resource-pack.bat`，macOS / Linux 运行 `scripts/make-resource-pack.sh`（或 `npm run resources:zip`）。脚本会安装依赖、从 GitHub 下载素材与字体（中断后再次运行会续传），在项目文件夹里生成 `stronghold-resources-<版本>.zip`；已有素材时只打包用 `npm run resources:pack`（输出在 `.cache/`）。国内下载 GitHub 慢时先设置代理，例如 PowerShell 中 `$env:HTTPS_PROXY = 'http://127.0.0.1:7890'; $env:NODE_USE_ENV_PROXY = '1'`（后者让 Node.js 使用该代理）；没有本地代理时也可以先设 `$env:SP_ASSET_SOURCE = 'mirror'` 改走 gh-proxy 镜像（第三方代理，见 [DEPLOY.md](DEPLOY.md)「国内镜像下载」）。这样生成的 ZIP 不含本地提取素材；来源仓库也会更新，晚些下载的个别文件可能与站点清单不一致。导入时不一致的跳过并提示数量，缺的文件点「在线下载」补齐。
3. **网页导出**：在「资源管理」把资源全部保存（在线下载或导入）后，点「导出 ZIP（发给朋友）」，从浏览器缓存生成与站点相同的资源包；导出前逐个核对缓存文件的大小与 SHA-256，缺失或损坏时需先重新下载。Chrome / Edge 直接写入所选文件，其他浏览器在内存中生成后下载。

拿到 ZIP 的朋友打开网站后在「资源管理」点「导入本地 ZIP」。

玩家第一次进入站点时可以：

1. **在线下载 / 继续下载**：同时下载 6 个文件，逐文件校验大小与 SHA-256，已经完成的文件不重复下载；失败的文件稍后重试，下载中站点更新时按新清单继续。音频走无扩展名的 `/media/` 路径（Worker 映射到 `/assets/audio/`），避免被下载工具拦截。
2. **导入本地 ZIP**：文件只在浏览器本地读取，**不会上传**：只取出清单内的文件，逐个校验大小与 SHA-256，其余条目直接跳过。其他版本的资源包也能导入：与本站清单一致的文件照常导入，不一致的跳过并提示数量，剩下的点「在线下载」补齐；一个都对不上时拒绝导入。
3. **暂时跳过，按需加载**：直接进入游戏，素材在用到时从站点加载。

之后随时可在标题页、大厅或房间顶部的「资源管理」下载、导入、导出或清理。选择保存全部资源的玩家，站点更新后缺少的文件会在进入时提示，可在「资源管理」继续下载。

缓存使用 Cache Storage 和 Service Worker：缓存里有的文件直接从本地返回，没有的从站点加载；同一浏览器多个标签页的检查、下载、导入与清理依次进行。站点更新后，内容变化的文件从缓存删除，哈希相同的文件继续使用。缓存按站点来源隔离，换域名需重新下载或导入；隐私模式、空间不足或浏览器清理会导致缓存丢失。资源包只包含素材与字体，网站代码、API、联机仍需联网；这不是完整的离线游戏。

## 对局与更新限制

登录后普通断网使用绑定账号的房间 token 重连，换设备可点击「继续对局」接管原席位。房间连接被拒绝或结束时，服务器以 WebSocket 关闭码说明原因（席位被接管 4001、登录失效 4003、房间不存在或已结束 4004、连接过多 1013 等），浏览器读不到被拒绝升级请求的 HTTP 状态，所以拒绝也先接受连接再关闭；完整列表见 `worker/close-codes.js`。每个房间的连接数按它的席位数计算：每个玩家席位加 1 个（重连时新旧连接重叠）留给房间成员，其余 11 个连接给观战者等房间外的账号（同一网络最多 3 个）；所以 4 席的房间最多 16 个连接、同一网络 8 个（与以前相同），8 席的房间 20 个、同一网络 12 个。部署前保存的房间按 4 席恢复。登录只在建立连接时由 Worker 验证；之后房间在后台每分钟向账号目录确认一次（退出登录最迟约一分钟后以 4003 断开），会话到期则在下一条消息时断开，游戏消息从不等待账号目录。等候房间、玩家席位、审批和活动对局日志持久化，支持 DO 休眠/重启后恢复。房间代码 / token 不与其他房间共用。

补位（干员持有，`room.ownership`）和自选编队（`room.diy`）与 Node 服务器相同（[DESIGN §25.3 / §25.4](history/0.2.0.md)，取代了 fork 的外援 / 甄选，见 [DESIGN §F3](design/fork.md)）：房间运行时把大厅的 `welcome.diyKitted`（可上场的自选干员）带给每个连接；页面在菜单里还没有连上房间，构建把同一份列表（kit 注册表的 `KITTED_CHARS`）写进页面的 `data-sp-diy-kitted`，大厅的干员调配在进房前就能挑选。进房后页面在 `welcome` 之后发送 `room.ownership` 和 `room.diy`，服务器存到会话和席位上，开局时交给对局（`seats[].notOwned` / `seats[].diy`，随对局记录保存，恢复时取记录里的值）；对局进行中再发只对下一局生效（`ROOM_STARTED`）。账号偏好同步的是 `diy` 和 `ownership`（`public/js/preferenceSchema.js`，`POST /api/me/preferences`）；账号里旧的 `waiguan` 值读取时不再返回，下一次保存时从存储中删除。Worker 模式下页面在 `room.create` 时才连上房间，这两项在随后的 `welcome` 之后约 50 ms 发出：在此之前到达的 `room.start` 开的对局不带它们。

进行中的对局通过原版本规则及完整有序日志恢复；构建会保留旧规则引擎。无法恢复的对局按中断结束并释放席位（见 [持久状态说明](persistence-fields.md)）：在 Cloudflare 上回滚到更早的部署会中断所有在新规则版本上进行的对局（玩家看到「服务器版本已回退」），修复问题应提交回退改动重新部署（前滚）。Worker 只有账号模式（房间都属于账号，对局都有日志）；Node 本地模式保持原匿名流程。部署会断开所有 WebSocket，客户端自动重连。恢复成本随对局长度增长，长时间对局、AI 计算、回放体积和 DO 请求 / 存储写入仍受 Cloudflare 配额限制，具体边界见 [规则版本与容量边界](ACCOUNTS-HISTORY.md#规则版本与容量边界)。PITR 不能代替独立备份。

## 公开对局观战

公开同盟房开局后，登录玩家可在主界面在线大厅点击「进入观战」，无需房主审批，也不占玩家席位。观战者看到玩家（包括已淘汰的队友）观看战场时看到的内容：对局的公开画面、所选战场的战斗（浏览器按对局的规则版本模拟），准备阶段为所选玩家的阵地；看不到任何玩家的手牌、商店等私有信息，也不能操作。观战者的界面提示与 Node 服务器的观战席相同（「观战中 · 点击左侧成员头像切换查看」；作战中显示正在观看的博士「👁 名字」），没有表情和准备按钮。观战者选过的玩家在阶段切换后继续被跟随（上游 0.2.0 第 56 项）：所看的战场在新阶段不存在时（联防、首领战之后），转到该玩家的阵地或战场；没选过玩家、或所选玩家已出局时，照旧显示第一个战场或第一名在场玩家的阵地。观战人数在有人观战时显示给玩家，观战者自己总能看到人数和「退出观战」。私密房、独立模拟和未开局房间不开放此入口。Node 本地模式没有这个入口，改为在大厅凭同盟密钥进入观战席（每个同盟最多 2 名，见 [玩法说明](PLAYING.md) §8）；Cloudflare 部署的大厅不显示观战席的「观战」按钮。

对局结束时观战者与玩家一样收到结算（先 `room.closed {ended}`，再是最终画面与结算），随后连接关闭（4004），闲置的观战页不会占用下一局的观战名额；掉线的观战者下次连接时收到同样的结束通知，不会进入下一局。观战者的 hello / room.spectate 只回复其本人，观战人数的变化合并后最多每秒向房间广播一次。观战身份与玩家、战斗结果和历史记录分离，不进入对局日志；保留的旧版本恢复引擎恢复的对局同样可以观战。

## 运行日志

`wrangler.jsonc` 开启 Workers Logs（`observability`），每次部署都会带上该设置；只在控制台打开会被下一次部署关掉。URL 的查询字符串不记录（`/ws` 带房间票据，OAuth 回调带授权码）。Worker 自己写一行一个 JSON 对象，`event` 说明发生了什么，其余字段给出房间代码、对局编号、规则版本等上下文，从不记录 Cookie、会话或票据：

| event | 含义 |
| --- | --- |
| `request_failed` / `request_unavailable` | 请求以 500 INTERNAL（程序错误）/ 503 UNAVAILABLE（DO 过载或重启）结束；带方法和路径。客户端错误（4xx）不记录 |
| `room_event_failed` / `room_load_failed` | 房间 DO 处理事件 / 唤醒加载时出错，实例回到最后一次提交 |
| `match_restored` / `match_restore_failed` | 进行中对局恢复成功 / 无法恢复而按中断结束（带规则版本、事件数、尝试次数和原因）。`ms` 是重放日志用的毫秒数（DO 唤醒有 30 秒上限）；失败行只在重放本身出错时带它 |
| `match_log_large` | 警告：进行中对局的事件日志超过 150,000 条，每局一次（带房间、日志 ID、规则版本、事件数和上限 `limit` 200000）。超过 200,000 条的日志无法恢复（`CHECKPOINT_EVENT_LIMIT`），对局会在下次重启时按中断结束 |
| `application_cleanup_failed` | 警告：房间已经做出决定之后，收尾的账号调用失败（带房间、`action` approve / reject、`op` clearApplication / releaseSeat 和错误）。房间的答复照常有效；残留的申请记录或席位指针由下一个读到它的请求清掉 |
| `archive_publish_failed` | 对局归档发布失败；30 秒后重试，之后每次加倍，最多每小时一次，其他对局的归档照常发布 |
| `listing_publish_failed` | 在线大厅列表更新失败，按同样的退避重试（带下次重试时间 `retryAt`） |
| `login_check_failed` | 房间向账号目录复核已连接的登录失败；不断开任何连接，按同样的退避重试（带 `retryAt`） |
| `room_runtime` | 规则代码（大厅、连接、对局）的警告和错误；恢复时重放出的行带 `restoring: true` |
| `github_credentials_invalid` | GitHub OAuth App 的凭据无效（`incorrect_client_credentials` / `redirect_uri_mismatch`）：「使用 GitHub 登录」不再显示，1 小时后再检查；更换 secret 后立即重新检查 |
| `github_check_failed` | 检查 GitHub 凭据时没有得到明确答复（网络错误或其他答复）；照常显示 GitHub 登录，5 分钟后再检查 |
| `github_code_refused` | 一次 GitHub 登录的授权码被以「凭据无效」类答复拒绝，随即的凭据检查却认为凭据没问题（授权码可能是为其他回调地址签发的）：只有这次登录失败，GitHub 登录照常显示（带 GitHub 的答复和检查结论） |
| `account_password_reset` | 管理员重置了一个账号的密码（带账号 ID），该账号的登录全部失效 |
| `backup_profile_missing` | 导出备份时某个用户名密码账号没有账号资料（带账号 ID），导出失败。只会在导入该账号时写入账号资料失败之后出现：重新导入该账号即可 |

## 房间计算调度

新对局的 `RecordedMatch` 使用确定性工作分片：AI 准备每片 1 个生成器操作、预演每片 128 tick；普通／联防 HeadlessJob 每片 128 tick，按时钟推进的 FieldRunner／HeadlessPacer 每片最多 128 个场 tick（包括 Boss 正常推进和接管追帧，配置更小时沿用更小值）；准备截止补完 AI 准备时，预演在这个事件里共用 1024 tick（`deadlineRehearsalTicks`，见下文）。这些值在开局时记入 `options.workSlice`，恢复按记录的值切分：HeadlessJob 记录为 512 tick 的已开局对局仍按 512 恢复。Room DO 一次事件前后的两次 `pump()` 共用一份工作额度；普通到期定时器不消耗计算额度，定向测试覆盖准备截止后拒绝购买。每次 pump 原有的 100 回调上限保留。发送仍在持久化提交之后。

额度没有覆盖的计算在房间的工作队列里等到本次处理时间范围之后（`Match.laterWork`）。房间只挂一个 gate timer，定在最早可运行的一项上；被拒的工作留在队列原位，不新建 timer，也不写日志行。gate 按队列顺序尝试每个到期项，所以受间隔约束的 AI 准备不会挡住排在后面的战斗分片；准入的工作排出的续片排到队尾，在同一个 gate 回调里接着尝试，各 AI 轮流。这样每个 DO 事件约写 1 行日志：8 AI NORMAL 整局约 1.2 万行（虚拟时间模型；被拒的工作各自重挂 timer 时为 10.9 万行），离 200,000 条的恢复上限很远，超过 150,000 条时写 `match_log_large` 警告。

AI 的一次布阵不可分割：从撤下不上场的棋子到按方案放完，以及从收起召唤物到重新放好，生成器的这些 yield 都标为 `TRANSIENT`（`server/match/bot.js`），固定额度的分片在同一个回调里走到下一个稳定点，这些步也不计入每片的步数。准备截止、关托管或队友侦察都不会碰到放了一半的棋盘。

同房 AI 计算片之间主动间隔 25 ms，依据记录的事件时间范围计算，避免过期 timer 把休息时间折叠掉。有真人只在等 AI 时，取消主动间隔，一个事件的额度最多可连续准入 5 片 AI 准备（`prepBurst`，记入 `options.workSlice`），这几片之外不能再跑别的计算。布阵那一片（生成器在布阵前一步 yield `HEAVY`，排队时记为 `prepArrange`，后期 10–20 ms）不参与连片：它单独占用一个事件的额度，不会叠在别的分片后面。"只在等 AI"的判断（`Match._prepUrgent`）只读已记录的状态：PREP 中至少有一名已连接的真人（存活，或已出局在观战），并且存活、已连接、没开托管的真人都已 ready；开着托管的已连接真人也算在等。没有已连接真人时没人在等，AI 仍按原节奏错峰。距准备截止 5 秒时同样取消主动间隔，但每事件仍只准入 1 片。两段时间都沿用 timerScale 缩放。没有准备倒计时的单人／单真人房，AI 在真人 ready 之前错峰分片，真人 ready 之后连片做完，完成即 ready。目标是在准备窗口内完成并降低玩家操作延迟，不追求 AI 提前 ready。准备截止时，开始时间已到的 AI 准备任务（已经开始，或开始时间已到、还在工作队列里排队）由截止回调接着完成（`Match._finishBotPrep`），不会把半成品留给战斗：经济决策和默认布阵（`botPrepBeginSteps`）以及收尾（`botPrepEndSteps`：选定的方案、临时区、ready）都做到底，所以棋盘总是完整的，经济决策也都执行完。剩下的预演只用截止事件的预演 tick 预算（`deadlineRehearsalTicks`，默认 1024，记入 `options.workSlice`；没记录这一项的对局恢复时用默认值），这个事件补完的各席按座位顺序共用这份预算。预算用完时预演还没跑完的席位就此截断（`job.cut`），采用已经完整预演过的候选里最好的方案，一个都没有就用默认方案。截止前预演跑到哪一步取决于宿主快慢，但只经由已记录的准入起作用，恢复会重放出同一块棋盘。开始时间还没到的任务不再开始，这一席保留原有棋盘。这些同步计算只出现在临截止才开托管的席位上，算在截止那个事件里；这时真人都已被置为 ready，房间里没有在跑的战斗。

截止事件有多长，取决于各席在截止时停在哪一步，下面的数字都随路径变化。Node 桌面机的实测（8 席房后期 R8–R13，多为 4 真人 + 4 AI；`.cache/deadline/`、`.cache/deadline-verify-latency-behaviour/`、`.cache/deadline-fix/`）：
- 1024 tick 的预演约 10–50 ms，个别 65 ms。
- 截止时还停在经济决策和默认布阵里的席位不受预算约束，每席还要 15–40 ms。其中约一半是最后一次布阵为预演准备的另外 4 个布阵方案和预演战斗；分不到预演 tick 的席位也照样准备。
- 三名真人在截止前 1.5 秒开托管时，最慢回合的截止事件从 e68bbca 的约 200 ms（一次跑完全部剩余预演）降到约 35–65 ms。
- 三四名真人在截止前约 1 秒开托管时会超过约 80 ms 的目标。900 ms 的 `BOT_ACTION` 延迟让这些任务的开始时间恰好落在截止前，截止时三四席都还在经济决策或布阵之前。最慢回合的截止事件从 e68bbca 的 0.65–1.1 s 降到：固定路径重放、不含提交时最少约 70–75 ms，整局运行（含提交）约 90–170 ms。两名真人这样开托管时也到过 90–100 ms，8 名真人时 130–270 ms。预算取 0 也还剩 60–110 ms，调预算压不到目标以内；要压下来，还需要另行决定怎样约束截止时的经济决策和布阵。
- 代价是这些席位大多跑不完预演，多数按默认方案上场。四名真人在截止前 1 秒开托管时，截止补完的席位没有一个跑完预演。

真人的实际等待 ≈ 剩余计算 + 剩余事件数 × 每事件的提交开销，所以连片的意义在于减少事件数。下面是 Node 上的模型实验（seed 17、NORMAL，真人在 PREP 开始 1.2 秒后 ready，每个事件按实测 CPU 加一个固定的提交开销占用宿主，`.cache/fix-2026-10-08/prep2/hwc.mjs`）：
- 1 真人 + 7 AI：不计提交开销时每回合等约 1.8–2.0 秒（改动前的错峰下界 1.8 秒）。提交开销 5 ms 时，后期 R8–R13 为 2.0–2.4 秒，每回合都不比改动前长（改动前 2.3–2.5 秒，其中单个事件 0.5–0.7 秒）。提交开销 9 ms 时为 2.2–3.0 秒，R8、R10、R11 比改动前长 0.3–0.5 秒。盈亏点约为每事件 6–7 ms。
- 4 真人 + 4 AI（计时房）：提交开销 5 ms 时前期约 0.8 秒，后期 1.1–1.4 秒，与改动前相差 −0.07 至 +0.13 秒。
- 后期每回合真人 ready 之后约 115–160 个事件（改动前 7 个）。Node 上 8 席房后期单事件最长约 30–33 ms，多是 5 片较重的预演。

所以 workerd 上的真实等待取决于每事件的提交开销，必须实测（见下面的验收第 1 条）。每个事件的提交都要重新序列化并写入整个房间快照（含对局的公开视图和 RNG 状态），这是每事件开销的主要来源。

分片额度、连片剩余数和延期时间范围记录在 timer 事件中，中途恢复会重建相同的生成器、战斗状态、RNG、工作队列、Boss pacer 的排队工作和定时器顺序，不依赖恢复机器的 CPU 速度。构建会生成新的规则版本；已开始的旧版本对局继续使用保留的旧恢复引擎，不在进行中切换调度。Node 服务原有调度不变。

Boss 保持场次顺序，接管先完成较早加入场的既定追帧目标；正常推进按逻辑到期时间累计，预算等待不丢弃模拟时间，暂停时间另行扣除。追帧和欠下的推进轮次按时间先后执行：接管时 pacer 还欠着更早的轮次，就先补这些轮次，再追帧。已经到期的轮次在同一次准入里接着跑，直到 128 个场 tick 的上限（轮次结束也计入），所以积压按分片速度补回，不再每个事件只补 1 轮。场结束、停止或重入接管会取消旧工作链；单人暂停时工作链停下，不挂 timer、不写日志行，恢复时重新挂上。

服务端场按 pacer 的逻辑时间推进。pacer 欠着 tick 时（有排队的追帧，或有到期未跑的轮次：`HeadlessPacer.behind`），boss clock 的超时扣血和预算入账、真人场 b.progress／b.result 的池伤害和 LP，都不立即执行，而是带着到达时刻排进 pacer 的队列（`Match._bossInOrder`）。它们和追帧按到达顺序排队，在 pacer 推进到该时刻之后的第一个轮次之前执行；pacer 不欠 tick 时立即执行，与改动前相同。这样每个事件的结算顺序，与改动前那种同步追帧、先模拟完所有到期 tick 再处理下一个事件的理想宿主相同：池先空还是团队 LP 先归零只取决于记录下来的状态，不随每个事件的耗时变化。超时扣血只发生在 boss clock 的 250 ms 节拍上，这一点也与改动前相同。追帧也逐 tick 判终局：追帧中漏怪使团队 LP 归零，即判负。判定终局之后，客户端结果宽限期内不再扣超时 LP。一场被服务端接管时，它还在排队的上报（以及 boss clock 为它排的预算入账）照样在各自的时刻入账：服务端运行的伤害基线（`CreditPool` 的 `acked`）实时读取该场已确认的伤害，接管的追帧排在这些上报之后，所以不会重复计入。丢掉它们会把这段伤害推迟到接管时刻，中间排队的超时点或别场的漏怪就可能先判终局。共享血池、伤害抵扣、LP、结算顺序和中途恢复由定向测试覆盖（`test/match/boss-settlement-order.test.js`、`boss-work-budget.test.js`）。

模型实验（review 的 verify3 网格，`drive2.mjs`）：S1 是两场在 150 s 同时被接管，之后只剩服务端场；S2 是一场被接管，另一场的真人继续上报。参数为 LP 5／6／8／12、血池 2.55–2.80M，每个 128 tick 的事件约耗时 1／8／22／37 ms。对照理想保序基线（改动前、每事件 1 ms）：S1 在 1／22／37 ms 档 0/204 翻转，S2 在四档都是 0/104 翻转；团队 LP、决胜时刻的池血量全部相同，单事件最多 128 个场 tick。改动前的代码自身在 37 ms 档有 S1 6/204、S2 2/104 翻转，单事件要跑约 9,000 tick。

已知限制：
- pacer 追帧期间，真人场排队中的伤害要等 pacer 推进到对应时刻才计入血池，其他玩家从 b.pool 看到的血量相应滞后，最多滞后一次追帧的时长（150 s 时接管、每事件 37 ms 时约 2.6 s）。真人自己的客户端照常显示自己的伤害。
- 几场同时被接管、排在前面的场在追帧中打空了血池时，排在后面的接管场按当时的进度结束（可能一个 tick 都没跑），该场玩家的击杀、伤害、CHAR_DAMAGE 播报和赏金（coins→pendingFunds）会少算；胜负、团队 LP 和隐秘核心资格不受影响。真人场的上报这时在排队，不会插进追帧打空血池。这与 Node 宿主的语义相同：它的旧路径（每 interval 追 240 tick）有同类截断。要补齐，只能在决胜时同步排空追帧，这会产生长事件（每事件数千 tick），因此没有做。

工作量预算不是固定毫秒上限。分片用于降低同房操作和同宿主其他房间的阻塞，具体改善以同负载测量为准；它会增加 DO 事件和提交次数（日志由工作队列控制在约每事件 1 行），AI 与玩家买棋的交错也可能改变后续阵容，不能要求不同输入时序产生同一对局结果。相同战斗输入的结果、时间线以及同一日志的恢复结果仍须一致。整局冷恢复与归档的同步计算暂未改变。

浏览器的每次 RAF 或隐藏页 pump 是一批工作（`public/js/battle/runner.js` runBatch），分两级：
- 先给运行中的场（权威场和当前显示的场）实时份额：前台每帧最多 ticksPerFrameCap（2 倍速为 8 tick），隐藏页每次 pump 最多 240 tick（与加预算之前相同）。准备中的场先拿收敛下限：自上一批以来目标增长量的 2 倍，最多 240 tick；隐藏期间收到的权威准备（接管或重连的 b.start）另得 240 tick。这一级不受软预算截断，所以前台运行场的单帧上界回到加预算之前的 cap·c；隐藏页即使被节流到约 1 Hz，单 tick 16 ms 以内的权威场也能跟上，准备总能收敛。
- 超出实时的追帧和其余准备工作再共用软预算：前台有场按正常速度显示时（包括新场在它后面加载时）约 4 ms；只有加载视图、显示已结束的场或正在快进时约 10 ms；隐藏页约 64 ms。逐 tick 检查，权威场排在展示副本之前，同类之内轮转；普通追帧 240 tick 与整批 600 tick 的上限保留。

隐藏页仍用一个 250 ms interval。页面被挂起，或单 tick 慢到任何份额都跟不上时，仍会落后：普通场由服务器截止或静默接管兜底，持续上报的 Boss 场不会因落后被接管。加载中收到的非接管 b.end，如果该场一个 tick 都还没走，只发 b.result、不发重放段，服务器保留它已有的重放，也不必等完结果宽限期：这个页面接替了同一玩家先前的会话时（刷新、换设备"继续对局"），已有的是旧页面上报的片段，归档为不完整的客户端重放，与这份结果并存；没有任何片段时记为 missing。单个 tick、战斗构造和画面渲染不可由预算抢占，低配设备仍需关注这些开销；预算限制主线程连续补算，不保证整个画面帧耗时低于 4 ms。准备中的场接收有序控制消息，离房或阶段切换会取消旧准备任务。

本地对照压测（`tools/bench-worker-scheduling.mjs`）使用真实 workerd、Room DO、WebSocket 和 SQLite/KV，另开一个轻房测同宿主的交互。它不测生产网络、存储复制或浏览器渲染；预热关闭分片以生成可比阵容，该预热日志不能用作恢复测试。场景（`--configs`，默认 `ai4,ai8,h1ai7,human8,mixed8`）：

| 场景 | 座位 | 准备阶段 |
| --- | --- | --- |
| `ai4` / `ai8` | 1 名已连接真人开托管，加 3 / 7 个 AI | 单真人房，没有倒计时；全部是 AI 准备任务，没有人在等 |
| `h1ai3` / `h1ai7` | 1 名已连接真人不托管，加 3 / 7 个 AI | 单真人房，没有倒计时：真人 ready 之后，PREP 要等 AI 做完才结束 |
| `mixed8`（即 `h4ai4`） | 4 名真人不托管，加 4 个 AI | 有倒计时 |
| `human8`（即 `h8ai0`） | 8 名真人不托管 | 有倒计时 |
| `hNaiM` | N 名真人不托管，加 M 个 AI（N ≥ 1，共 4–8 席） | N > 1 时有倒计时 |
| `ai8timed` | 8 名已连接真人全部托管 | 保留多人倒计时；战斗由 8 个模拟客户端计算 |

不托管的真人在每回合收到 PREP 后 `--ready-after-ms` 毫秒 ready（默认 1200，即比 AI 先 ready）；写成列表（`0,1200`）时每个值各跑一遍。只有真人比 AI 先 ready，才看得出真人是否在等 AI。30000 这类晚于 AI 的值让真人决定阶段切换，会把等待掩盖掉：只能用它测完整的准备窗口，不能当作没人等的证据。

样本按服务端事件归类，不按客户端最后收到的 `m.public` 归类：`m.public` 有 100 ms 节流，开战那一刻的计算会被记到 PREP 名下。主房记录测量期间的每个 DO 事件：
- 开始时的本地 Worker 时钟，事件本身与提交各自的耗时；
- 开始时与做完时的阶段。`PREP>COMBAT` 表示这个事件里到期的计时器切换了阶段；
- 跑了多少战斗 tick（服务端场、HeadlessJob、Boss 推进与追帧、AI 预演），用掉多少工作额度，新增多少日志行与 SQL 行，处理了哪些输入。

每个 ping 或操作样本挂到处理它的那个事件上，并带上它排队等过的事件及这些事件的 tick 数。主房与轻房的 ping 由同一个回调成对发出，报告逐对相减：两边一起变慢，说明同一 workerd 进程被占住；只有主房变慢，才是同房排队。每个均值旁都打印 p99 与最大值。样本只有几百个时，p99 就是最大的那几个值，不能当作生产环境的 p95 或 p99。`humanWait` 是每回合"最后一名已连接真人 ready → PREP 结束"的时长，同时给出 Worker 时钟、虚拟时钟和期间的 DO 事件数。每事件 tick 数、工作事件数、每事件日志行数不随宿主速度变化：选分片大小这类配置，先看这些数，再看墙钟。

```powershell
node tools/bench-worker-scheduling.mjs --root <旧版目录> --tag before --output .cache/scheduling-bench
node tools/bench-worker-scheduling.mjs --tag after --output .cache/scheduling-bench
node tools/bench-worker-scheduling.mjs --configs h1ai7,mixed8 --ready-after-ms 0,1200 --round 11 --duration-ms 180000 --tag wait --output .cache/scheduling-bench
```

需要比较的项：
- 起始 `workloadFingerprint`；
- 按服务端阶段分组的 ping 与操作 RTT，尾部和均值一起看，以及主房减轻房的差值；
- 未回应、被拒绝和断线的请求；
- 真人等待、AI 自然完成与截止余量；
- 服务端计算完成与结果释放的时刻；
- 事务与日志的增长。

不要只看 ping。事务和日志计数有约一个采样事件的边界误差；服务端事件统计不含测量前后的两次采样请求。压测与其他测试争用 CPU，每次只运行一个压测或测试进程。原始结果留在本地的忽略目录里。

改动房间计算调度（准备分片、工作额度、Boss 推进、浏览器预算）时，按下面的场景和阈值验收。确定性用例使用虚拟时间和每事件固定额度，不用墙钟计时；workerd 上的数值只用于同一台机器上的对照。定向测试：

```powershell
node --test test/match/cooperative-checkpoint.test.js test/match/deterministic-slices.test.js test/match/checkpoint.test.js test/match/boss-*.test.js test/match/runner-*.test.js
```

1. **真人不等 AI**
   - 确定性模型：用虚拟时间、按 Room DO 的方式逐事件驱动（每事件两次 pump，共用一份工作额度），跑两种房间：1 真人 + 7 AI 的单真人房，4 真人 + 4 AI 的计时房。真人在 PREP 开始后 0 s 和 1.2 s 两个时刻 ready。阈值："最后一名已连接真人 ready → PREP 结束"不超过旧版 +1 s。旧版约为 1.8 s 和 0.75 s，目标分别约 1.8 s 和 0.8 s。
   - 没有已连接真人在等时（全托管或全部断线），AI 仍按原节奏错峰，`cooperative-checkpoint` 的间隔用例照常通过。
   - 虚拟时间不计每事件的提交开销，所以另算事件数：真人 ready 之后，连片要填满（事件数不超过 准入片数／`prepBurst` + 布阵片数 + 每个 AI 约 3 个不满的事件），布阵片单独占一个事件（`test/match/prep-human-wait.test.js`）。在给每个事件加固定提交开销的模型里，5 ms 时后期等待不长于旧版。
   - Node 上 8 席房 R11–R13 的单事件耗时最长不超过约 30 ms。
   - workerd：用上面的 `h1ai7,mixed8` 和 `--ready-after-ms 0,1200`，分别以 `--round 11`、`12`、`13` 起跑，记录 `humanWait` 的墙钟，以及主房与轻房 ping 的 p99 和最大值。全托管房的 PREP 时长是否可以接受，由维护者判断。
2. **Boss 结算不随宿主速度变化**
   - 确定性用例：
     - 同一组输入，每事件额度 1，每事件额外耗时 0／10／20／50／100 ms，`_finalEnding`、团队 LP 和各场结果必须相同，并且等于改动前代码的结果（池先空、超时点先到、boss clock 不在整秒网格上、真人场在追帧期间继续上报，各取一例）；
     - 积压 N tick，要在 ceil(N/128)+k 个事件内追平；
     - 追帧中 LP 归零时判负；判定终局之后不再扣超时 LP；
     - 暂停期间，服务端推进不再每 33 ms 写一行日志。
   - 实验网格：
     - 场景有两个：S1 是两场在 150 s 同时被接管，之后只剩服务端场；S2 是一场被接管，另一场的真人继续上报。
     - 参数：LP 取 5 / 6 / 8 / 12，血池取 2.55–2.80M，每个 128 tick 的事件约耗时 1 / 8 / 22 / 37 ms。
     - 阈值：S1、S2 都对照理想保序基线，胜负翻转 0 次，LP 差全为 0（S2 的残余至少不能超过旧版自身：37 ms 档 ≤2/104）；追帧中途导出再恢复的两个实例，锁步运行时状态始终一致。
   - workerd 另测两项：已有服务端场时，真实 12 s 静默触发的接管；追帧中途的检查点恢复。
3. **日志不放大**
   - 8 AI 整局，覆盖 NORMAL、HARD、ABYSS、隐秘核心和 `SP_COMBAT=server` 回退配置。阈值：整局日志约 3 万行以内，每个 DO 事件新增日志行数 p50 ≤ 2（即压测报告里的 `match log rows/event`）。
   - 单测断言：8 个 bot 的备战回合中，每准入一片对应的日志行数有上限。
   - 200,000 行的恢复上限不变，运行中超过 150,000 行时写一次 `match_log_large` 警告。
   - 修复后重跑事件前缀中途恢复（生成器中途、预演中途、HeadlessJob 片中途、Boss 追帧中途、暂停）和整局锁步对照。
4. **浏览器后台场不持续落后**
   - runner 的假时钟稳态用例：
     - 隐藏页每 1000 ms 唤醒一次，单 tick 1.1 / 1.5 / 2 / 4 ms 时，60 s 内落后有界且不增长；
     - 前台 12 fps、单 tick 1 ms 时，落后 ≤8 tick；
     - 前台 30 fps、两个场、单 tick 2 ms 时，落后不增长；
     - 单独准备，60 Hz、单 tick 0.2 ms、80 游戏秒，1 s 内完成；
     - 30 fps、单 tick 1 ms、旧场仍在运行时，切场必须能完成。
   - 真机另测：低端 Android 在后期联防场和 Boss 场的单 tick 成本；真实后台标签页（包括 WebView onPause）下，权威场落后量的增长斜率。
5. **普通场与联防场的切片**
   - HeadlessJob 默认每片 128 tick。已经开始、记录了 512 的对局按记录恢复。只改片长时，HeadlessJob 的结果作为多重集必须与 512 相同，终局摘要也必须相同。
   - Node 上 8 AI R8–R13 的单片耗时，最大值从约 97 ms（512 tick）降到约 22 ms（128 tick）。
   - workerd 测两项：R12 联防开战时主房 ping 的最大值；每事件的提交开销（压测报告的 `commit ms`，或连续 1,000 个单片事件的墙钟）。第 1 条中真人的实际等待和第 2 条中的追平时间都取决于它。

## 验证

```powershell
npm test
node --test test/worker-client.test.js test/worker-build.test.js test/worker/*.test.js test/resources/*.test.js
$env:SP_RESOURCES_E2E = '1'
node --test test/resources/browser.e2e.test.js
$env:SP_ACCOUNTS_E2E = '1'
node --test test/ui/password-accounts.e2e.test.js test/ui/account-flows.e2e.test.js test/ui/account-history.e2e.test.js test/ui/preferences.e2e.test.js test/ui/github-account.e2e.test.js
$env:SP_SPECTATORS_E2E = '1'
node --test test/ui/spectators.e2e.test.js
```

浏览器测试使用系统 Chrome，可用 `CHROME_PATH` 指定路径。后端集成测试使用生产打包方式与 Miniflare / workerd。部署后应检查 `/healthz`、资源清单、素材与 `/stronghold-resources.zip` 的响应，并实测注册登录、两个玩家加入同一房间、准备、开局与断线重连。
