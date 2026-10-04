# Cloudflare 部署

当前账号使用 **Workers Paid** 套餐；构建按最新 Worker 未压缩包体 64 MiB、100,000 个静态文件限额检查，无需设置套餐环境变量。

当前唯一公开入口：[stronghold.lunar.ag](https://stronghold.lunar.ag)。`workers.dev` 和版本预览入口均关闭；目前未启用密码或 Cloudflare Access。

适用场景：4–20 位朋友，分为多个最多 4 人的游戏房间。网页与游戏代码由 **Workers Static Assets** 提供；每个房间使用独立的 **SQLite Durable Object + WebSocket**，复用原有房间、经济、回合和战斗协议。玩家浏览器计算正常战斗，AI / 掉线玩家由服务端处理。**站点不提供游戏素材**（美术、音频、字体）：玩家把资源 ZIP 导入浏览器本地，没有导入时游戏使用占位图、没有声音（见下文「资源包」）。

## 为什么这样分配

- 静态资源只有网页、游戏代码、游戏数据、资源清单和各规则版本的回放引擎，不计入 Worker JS 包体，也不经过房间对象。游戏素材受版权保护，本站不分发：资源 ZIP 由玩家用本仓库的脚本从素材来源下载生成，或由朋友转发，只在浏览器本地读取。
- 一个房间一个 DO 保证房间事件顺序，避免多个 Worker 实例各自保有不同状态，也无需 WebRTC 的 NAT 穿透、信令与 TURN。等待房间使用 WebSocket Hibernation；无人连接的对局休眠到下一个计时器，详见 [规则版本与容量边界](ACCOUNTS-HISTORY.md#规则版本与容量边界)。
- 亚太 `locationHint` 是尽力提示，不能保证落在指定地区。大陆用户的实际连通性和延迟取决于网络线路（素材在本地，不受影响）；请朋友实测自定义域名的可达性。

参考：[Static Assets 限额](https://developers.cloudflare.com/workers/static-assets/platform/limits/)、[DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。静态资源和房间计算是不同的计费项；当前按已有 Workers Paid 套餐部署。

## 构建和部署

需要 Node.js 22+、npm 和现有 Cloudflare 账号。仓库不含受版权保护的游戏素材，但构建要用本机的完整素材生成资源清单（玩家导入的 ZIP 按它逐个校验）：沿用原有 `npm run setup` 准备素材，或使用已有完整本地项目。`npm run build:worker` 会检查 `data/assets.json` 引用的素材，缺失时自动运行 `tools/fetch-assets.mjs` 下载；下载失败或素材目录为空时构建失败。`SP_SKIP_ASSETS=1` 可跳过自动下载，但不会跳过空素材检查。

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

Wrangler 执行构建、上传本地静态文件，保留 `ROOMS`（房间），并通过追加迁移增加 `SITES`（身份/目录）、`ACCOUNTS`（个人索引）、`MATCH_ARCHIVES`（历史/回放）SQLite DO。按网络（IPv4 地址 / IPv6 /64）和账号的请求限流使用 Cloudflare 的 rate limiting 绑定（`wrangler.jsonc` 的 `ratelimits`，每分钟计数，不写存储）：每个 `/api` 请求和房间连接先按网络计数，再接触任何 DO（包括登录查询）；注册、登录和修改密码另按网络计数（`REGISTER_LIMIT`、`LOGIN_LIMIT`），登录和修改密码再按「用户名 + 网络」计数（`USERNAME_LIMIT`，别人的尝试不会用掉玩家自己的次数）；原来的 `ADMISSION` 限流 DO 由迁移 `v3-ratelimits` 删除（它只存短期计数）。限流绑定的 `namespace_id` 在同一 Cloudflare 账号内必须唯一。账号的两种登录方式（用户名密码，以及配置有效时的 GitHub）、管理员重置密码的凭据 `ACCOUNT_ADMIN_TOKEN` 与 `npm run accounts:reset-password`、迁移、独立备份见 [账号与历史指南](ACCOUNTS-HISTORY.md)。

构建只发布 `dist/client/` 以及 `dist/worker/index.mjs`。前端保持 `/data/`、`/shared/`、`/sim/` 的既有路径；Node 文件系统数据读取由构建时 JSON 导入替换。游戏素材（`public/assets/`、`public/fonts/`）、`public/dev/`、ZIP、日志、source map 和服务端私有数据读取模块都不会发布。不要手动把整个仓库上传为静态站点。

## 资源包

站点只发布资源清单 `/resource-manifest.json`（每个文件的路径、大小与 SHA-256），不发布文件本身。资源 ZIP 由玩家自备：

1. **本地脚本**：Windows 双击 `scripts\make-resource-pack.bat`，macOS / Linux 运行 `scripts/make-resource-pack.sh`（或 `npm run resources:zip`）。脚本会安装依赖、从 GitHub 下载素材（中断后再次运行会续传）、在项目文件夹里生成 `stronghold-resources-<版本>.zip`。国内下载 GitHub 慢时先设置代理，例如 `set HTTPS_PROXY=http://127.0.0.1:7890`（脚本会让 Node.js 使用它）。已有完整素材时只打包：`npm run resources:pack`（输出在 `.cache/`）。
2. **朋友转发**：已经有 ZIP 的玩家直接发给朋友。

玩家第一次进入站点时，资源窗口提供两个选择：**导入本地 ZIP**，或**暂时跳过**（使用占位图）。之后随时可在标题页、大厅或房间顶部的「资源管理」导入或清理。导入时文件只在浏览器本地读取，**不会上传**：只取出清单内的文件，逐个校验大小与 SHA-256，其余条目直接跳过。其他版本的资源包也能导入：与本站清单一致的文件照常导入，不一致的跳过并提示数量，缺少的文件需要换一个与本站版本一致的 ZIP 补齐。

缓存使用 Cache Storage 和 Service Worker；同一浏览器多个标签页的检查、导入与清理依次进行。站点更新后，内容变化的文件从缓存删除，哈希相同的文件继续使用。缓存按站点来源隔离，换域名需重新导入；隐私模式、空间不足或浏览器清理会导致缓存丢失。资源包只包含素材与字体，网站代码、API、联机仍需联网；这不是完整的离线游戏。

## 对局与更新限制

登录后普通断网使用绑定账号的房间 token 重连，换设备可点击「继续对局」接管原席位。房间连接被拒绝或结束时，服务器以 WebSocket 关闭码说明原因（席位被接管 4001、登录失效 4003、房间不存在或已结束 4004、连接过多 1013 等），浏览器读不到被拒绝升级请求的 HTTP 状态，所以拒绝也先接受连接再关闭；完整列表见 `worker/close-codes.js`。登录只在建立连接时由 Worker 验证；之后房间在后台每分钟向账号目录确认一次（退出登录最迟约一分钟后以 4003 断开），会话到期则在下一条消息时断开，游戏消息从不等待账号目录。等候房间、玩家席位、审批和活动对局日志持久化，支持 DO 休眠/重启后恢复。房间代码 / token 不与其他房间共用。

进行中的对局通过原版本规则及完整有序日志恢复；构建会保留旧规则引擎。无法恢复的对局按中断结束并释放席位（见 [持久状态说明](persistence-fields.md)）：在 Cloudflare 上回滚到更早的部署会中断所有在新规则版本上进行的对局（玩家看到「服务器版本已回退」），修复问题应提交回退改动重新部署（前滚）。Worker 只有账号模式（房间都属于账号，对局都有日志）；Node 本地模式保持原匿名流程。部署会断开所有 WebSocket，客户端自动重连。恢复成本随对局长度增长，长时间对局、AI 计算、回放体积和 DO 请求 / 存储写入仍受 Cloudflare 配额限制，具体边界见 [规则版本与容量边界](ACCOUNTS-HISTORY.md#规则版本与容量边界)。PITR 不能代替独立备份。

## 公开对局观战

公开同盟房开局后，登录玩家可在主界面在线大厅点击「进入观战」，无需房主审批，也不占玩家席位。观战者看到玩家（包括已淘汰的队友）观看战场时看到的内容：对局的公开画面、所选战场的战斗（浏览器按对局的规则版本模拟），准备阶段为所选玩家的阵地；看不到任何玩家的手牌、商店等私有信息，也不能操作。观战人数在有人观战时显示给玩家，观战者自己总能看到人数和「退出观战」。私密房、独立模拟和未开局房间不开放此入口，Node 本地模式没有观战。

对局结束时观战者与玩家一样收到结算（先 `room.closed {ended}`，再是最终画面与结算），随后连接关闭（4004），闲置的观战页不会占用下一局的观战名额；掉线的观战者下次连接时收到同样的结束通知，不会进入下一局。观战者的 hello / room.spectate 只回复其本人，观战人数的变化合并后最多每秒向房间广播一次。观战身份与玩家、战斗结果和历史记录分离，不进入对局日志；保留的旧版本恢复引擎恢复的对局同样可以观战。

## 运行日志

`wrangler.jsonc` 开启 Workers Logs（`observability`），每次部署都会带上该设置；只在控制台打开会被下一次部署关掉。URL 的查询字符串不记录（`/ws` 带房间票据，OAuth 回调带授权码）。Worker 自己写一行一个 JSON 对象，`event` 说明发生了什么，其余字段给出房间代码、对局编号、规则版本等上下文，从不记录 Cookie、会话或票据：

| event | 含义 |
| --- | --- |
| `request_failed` / `request_unavailable` | 请求以 500 INTERNAL（程序错误）/ 503 UNAVAILABLE（DO 过载或重启）结束；带方法和路径。客户端错误（4xx）不记录 |
| `room_event_failed` / `room_load_failed` | 房间 DO 处理事件 / 唤醒加载时出错，实例回到最后一次提交 |
| `match_restored` / `match_restore_failed` | 进行中对局恢复成功 / 无法恢复而按中断结束（带规则版本、事件数、尝试次数和原因） |
| `archive_publish_failed` | 对局归档发布失败；30 秒后重试，之后每次加倍，最多每小时一次，其他对局的归档照常发布 |
| `listing_publish_failed` | 在线大厅列表更新失败，按同样的退避重试（带下次重试时间 `retryAt`） |
| `login_check_failed` | 房间向账号目录复核已连接的登录失败；不断开任何连接，按同样的退避重试（带 `retryAt`） |
| `room_runtime` | 规则代码（大厅、连接、对局）的警告和错误；恢复时重放出的行带 `restoring: true` |
| `github_credentials_invalid` | GitHub OAuth App 的凭据无效（`incorrect_client_credentials` / `redirect_uri_mismatch`）：「使用 GitHub 登录」不再显示，1 小时后再检查；更换 secret 后立即重新检查 |
| `github_check_failed` | 检查 GitHub 凭据时没有得到明确答复（网络错误或其他答复）；照常显示 GitHub 登录，5 分钟后再检查 |
| `github_code_refused` | 一次 GitHub 登录的授权码被以「凭据无效」类答复拒绝，随即的凭据检查却认为凭据没问题（授权码可能是为其他回调地址签发的）：只有这次登录失败，GitHub 登录照常显示（带 GitHub 的答复和检查结论） |
| `account_password_reset` | 管理员重置了一个账号的密码（带账号 ID），该账号的登录全部失效 |
| `backup_profile_missing` | 导出备份时某个用户名密码账号没有账号资料（带账号 ID），导出失败。只会在导入该账号时写入账号资料失败之后出现：重新导入该账号即可 |

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

浏览器测试使用系统 Chrome，可用 `CHROME_PATH` 指定路径。后端集成测试使用生产打包方式与 Miniflare / workerd。部署后应检查 `/healthz` 与资源清单，并实测注册登录、两个玩家加入同一房间、准备、开局与断线重连。
