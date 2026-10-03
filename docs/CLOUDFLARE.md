# Cloudflare 部署

当前账号使用 **Workers Paid** 套餐；构建按最新 Worker 未压缩包体 64 MiB、100,000 个静态文件限额检查，无需设置套餐环境变量。

当前唯一公开入口：[stronghold.lunar.ag](https://stronghold.lunar.ag)。`workers.dev` 和版本预览入口均关闭；目前未启用密码或 Cloudflare Access。

适用场景：4–20 位朋友，分为多个最多 4 人的游戏房间。静态页面、游戏代码和素材由 **Workers Static Assets** 分发；每个房间使用独立的 **SQLite Durable Object + WebSocket**，复用原有房间、经济、回合和战斗协议。玩家浏览器计算正常战斗，AI / 掉线玩家由服务端处理。

## 为什么这样分配

- 当前素材约 313 MiB，拆分为约 5,500 个小文件。Static Assets 的限制按文件大小 / 数量计算，当前文件均小于 25 MiB、总数低于Paid 套餐 100,000 个文件限制。素材不计入 Worker JS 包体，也不经过房间对象。
- 当前版本不需要 R2。后续若需要公开下载数百 MiB 的完整 ZIP，或资源频繁更新且需要独立生命周期，可把完整包或素材迁往 R2 并配置自定义域名 / 缓存。完整 ZIP 不能作为单文件放进 Static Assets；下文的整包下载通过分块存储并由 Worker 拼接提供。
- 一个房间一个 DO 保证房间事件顺序，避免多个 Worker 实例各自保有不同状态，也无需 WebRTC 的 NAT 穿透、信令与 TURN。等待房间使用 WebSocket Hibernation，活跃对局的定时器会保持实例运行。
- 亚太 `locationHint` 是尽力提示，不能保证落在指定地区。大陆用户的实际连通性和延迟取决于网络线路，资源本地导入只能减少素材下载等待；请朋友实测自定义域名的可达性。

参考：[Static Assets 限额](https://developers.cloudflare.com/workers/static-assets/platform/limits/)、[DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。静态资源和房间计算是不同的计费项；当前按已有 Workers Paid 套餐部署。

## 构建和部署

需要 Node.js 22+、npm 和现有 Cloudflare 账号。仓库不含受版权保护的游戏素材；沿用原有 `npm run setup` 准备素材，或使用已有完整本地项目。

```powershell
npm ci
npm run setup
npx wrangler login
npm run build:worker
npm run dev:worker
```

`wrangler.jsonc` 当前指向用户选择的「晴猫」账号，Worker 名为 `stronghold-protocol`；`workers_dev` 与 `preview_urls` 均为 `false`。域名由 Cloudflare 控制台管理，配置文件不写 `route` / `routes`，后续部署会保留控制台已有的域名绑定（[官方说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)）。迁移到其他账号前应修改 `account_id`。开发访问 Wrangler 输出的 localhost 地址。Windows 上先停止 `dev:worker` 再部署，避免它的目录监视器占用构建输出。部署：

```powershell
npm run deploy:worker
```

首次部署到新 Worker 后，在 **Workers & Pages → stronghold-protocol → Settings → Domains & Routes → Add → Custom domain** 中绑定自己的域名。已有 Worker 可在同一位置更换或增加域名，无需修改仓库。由于 `workers.dev` 和版本预览入口已关闭，新 Worker 绑定域名前没有公开访问入口。不要用 `"routes": []` 代替省略字段，否则部署会移除已有路由。

这些命令使用 `npm ci` 按 `package-lock.json` 安装的项目内 Wrangler，使本地开发、配置校验与部署使用相同版本。更新 Wrangler 时，应更新锁文件并完成构建与测试后再部署。

若已安装 Bun，也可在完成上述 `npm ci` 后运行 `bun run dev:worker` 和 `bun run deploy:worker`，同样调用项目内 Wrangler；Bun 是可选工具，不是部署前提。

Wrangler 执行构建、上传本地静态文件，保留 `ROOMS`（房间）和 `ADMISSION`（短期 IP 限流），并通过追加迁移增加 `SITES`（身份/目录）、`ACCOUNTS`（个人索引）、`MATCH_ARCHIVES`（历史/回放）SQLite DO。GitHub OAuth 配置、迁移、独立备份见 [账号与历史指南](ACCOUNTS-HISTORY.md)。Cloudflare 插件可用于账号、Worker 配置和部署版本的管理、检查；本地批量文件上传使用 Wrangler。

构建只发布 `dist/client/` 以及 `dist/worker/index.mjs`。前端保持 `/data/`、`/shared/`、`/sim/` 的既有路径；Node 文件系统数据读取由构建时 JSON 导入替换。`public/dev/`、ZIP、日志、source map 和服务端私有数据读取模块不会发布。不要手动把整个仓库上传为静态站点。

## 给朋友准备资源包

完整资源包包含素材、字体及中文 / 日文语音（大小与文件数以本站清单为准），三种拿法，内容相同：

1. **直接下载**：本站的 `/stronghold-resources.zip`。部署时构建把资源包切成 24 MiB 的分块放进静态资源，Worker 把分块按顺序拼成一个文件返回：每次下载只算一次 Worker 请求（分块本身是免费的静态资源），支持断点续传和 Range，迅雷 / IDM / aria2 等工具可以多线程下载。文件名带资源版本，和站点当前的素材一致。
2. **本地脚本**：Windows 双击 `scripts\make-resource-pack.bat`，macOS / Linux 运行 `scripts/make-resource-pack.sh`（或 `npm run resources:zip`）。脚本会安装依赖、从 GitHub 下载素材（中断后再次运行会续传）、在项目文件夹里生成 `stronghold-resources-<版本>.zip`。国内下载 GitHub 慢时先设置代理，例如 `set HTTPS_PROXY=http://127.0.0.1:7890`（脚本会让 Node.js 使用它）。已有完整素材时只打包：`npm run resources:pack`（输出在 `.cache/`）。
3. **网页导出**：**资源管理** → 下载完成后 **导出 ZIP（发给朋友）**。

把 ZIP 发到群里，朋友打开网站后在 **资源管理** 点 **导入本地 ZIP**。


玩家第一次进入站点时可以：

1. 在线下载 / 继续下载：同时下载 6 个文件，逐文件校验 SHA-256，已经完成的文件不重复下载；中断的文件会重新下载。
2. 导入本地 ZIP：文件只在浏览器本地读取，仅提取并校验清单内文件，其余条目直接跳过，**不会上传**。别的版本的资源包也能用：与站点清单一致的文件会导入，不一致的跳过并提示数量，剩下的点「在线下载」补齐；一个都对不上时拒绝导入。
3. 暂时跳过，按需加载：直接进入游戏，日后通过「资源管理」补齐或清理资源。

缓存使用 Cache Storage 和 Service Worker，支持音频 Range。完整缓存会跳过下次首次安装界面；更新时相同哈希的文件可复用。缓存按站点来源隔离，换域名需重新导入；隐私模式、空间不足或浏览器清理会导致缓存丢失。资源包只包含素材与字体，网站代码、API、联机仍需联网；这不是完整的离线游戏。

## 对局与更新限制

登录后普通断网使用绑定账号的房间 token 重连，换设备可点击「继续对局」接管原席位。等候房间、玩家席位、审批和活动对局日志持久化，支持 DO 休眠/重启后恢复。房间代码 / token 不与其他房间共用。

账号模式的进行中对局通过原版本规则及完整有序日志恢复；构建会保留旧规则引擎。首次从匿名版本迁移时仍须先结束旧局，不能为旧内存对局补造历史。恢复成本随对局长度增长，长时间对局、AI 计算、回放体积和 DO 请求 / 存储写入仍受 Cloudflare 配额限制，具体边界见 [持久化与备份说明](ACCOUNTS-HISTORY.md)。PITR 不能代替独立备份。

## 验证

```powershell
npm test
node --test test/worker-client.test.js test/worker-build.test.js test/worker/*.test.js test/resources/*.test.js
$env:SP_RESOURCES_E2E = '1'
node --test test/resources/browser.e2e.test.js
$env:SP_WORKER_URL = 'http://127.0.0.1:8787'
node --test test/worker-browser.e2e.test.js
```

资源浏览器测试使用系统 Chrome，可用 `CHROME_PATH` 指定路径。后端集成测试使用生产打包方式与 Miniflare / workerd。部署后应检查 `/healthz`、清单和素材响应，并实测两个玩家加入同一房间、准备、开局与断线重连。

## 网页构建与资源导出

可以在 Cloudflare 控制台连接本仓库，选择要部署的生产分支；构建命令使用 `npm run assets`，部署命令使用 `npm run deploy:worker`。部署目标沿用本 fork 的配置，请勿使用来源仓库的账号或域名。

`npm run build:worker` 会检查 `data/assets.json` 引用的素材，缺失时自动运行 `tools/fetch-assets.mjs` 下载。下载失败或资源目录为空时构建失败。`SP_SKIP_ASSETS=1` 可跳过自动下载，但不会跳过空素材检查。干员战斗语音包含中文和日文，可在游戏设置中选择；旧素材目录运行 `npm run assets` 补齐。

资源管理窗口下载完成后，可点击「导出 ZIP（发给朋友）」。Chrome / Edge 支持直接保存到磁盘；其他浏览器在内存中生成 ZIP 后下载。接收方在相同版本站点导入即可。导出前会核对缓存文件及 SHA-256，缺失或损坏时需先重新下载。

## 公开对局观战

公开同盟房开局后，登录玩家可在主界面在线大厅点击「进入观战」，无需房主审批，也不占玩家席位。观战界面可选择玩家阵地，所有玩家和观战者都实时看到在线观战人数；退出或断线会更新人数。私密房、独立模拟和未开局房间不开放此入口。对局结束后观战者返回大厅。

观战身份与原有玩家、战斗结果和历史记录分离，旧版本对局继续使用保留的恢复引擎。部署仍会触发平台 WebSocket 自动重连；已验证玩家和观战者在服务重启后恢复。已有页面需重新载入才能显示新增的观战人数界面。
