# Cloudflare 部署

**入口：[卫.rinko.ai](https://xn--rlr.rinko.ai)**（punycode `xn--rlr.rinko.ai`，两种写法是同一个地址）。`workers.dev` 在中国大陆基本无法访问，所以 `wrangler.jsonc` 关闭了 `workers_dev` 和预览地址，只绑定这一个自定义域名。`rinko.ai` 需要托管在部署所用的 Cloudflare 账号下（不需要备案）。账号由 `wrangler login` 决定，也可以用环境变量 `CLOUDFLARE_ACCOUNT_ID` 指定，配置里不写死。

发到群里时用 `https://xn--rlr.rinko.ai/` 这种写法：微信 / QQ 不一定能把中文域名识别成链接。游戏里复制的房间邀请链接（`?room=`）本来就是这种写法。

适用场景：4–20 位朋友，分为多个最多 4 人的游戏房间。静态页面、游戏代码和素材由 **Workers Static Assets** 分发；每个房间使用独立的 **SQLite Durable Object + WebSocket**，复用原有房间、经济、回合和战斗协议。玩家浏览器计算正常战斗，AI / 掉线玩家由服务端处理。

## 为什么这样分配

- 当前素材约 321 MiB（其中干员战斗语音中文 + 日文约 73 MB），拆分为约 6,800 个小文件，构建后连代码共约 8,000 个。Static Assets 的限制按文件大小 / 数量计算，当前文件均小于 25 MiB、总数低于免费计划 20,000 个文件限制。素材不计入 Worker JS 包体，也不经过房间对象。
- 当前版本不需要 R2。后续若需要公开下载数百 MiB 的完整 ZIP，或资源频繁更新且需要独立生命周期，可把完整包或素材迁往 R2 并配置自定义域名 / 缓存。完整 ZIP 不能放进 Static Assets。
- 一个房间一个 DO 保证房间事件顺序，避免多个 Worker 实例各自保有不同状态，也无需 WebRTC 的 NAT 穿透、信令与 TURN。等待房间使用 WebSocket Hibernation，活跃对局的定时器会保持实例运行。
- 亚太 `locationHint` 是尽力提示，不能保证落在指定地区。大陆用户的实际连通性和延迟取决于网络线路，资源本地导入只能减少素材下载等待；部署后请电信 / 联通 / 移动的朋友在晚高峰实测自定义域名。

参考：[Static Assets 限额](https://developers.cloudflare.com/workers/static-assets/platform/limits/)、[DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。静态资源和房间计算是不同的计费项，不承诺多人长时间游戏一定完全免费。本项目不会自动升级收费计划。

## 网页一站式部署（推荐，不需要本地环境）

全部在 Cloudflare 控制台里完成：Cloudflare 从 GitHub 拉代码，构建时自动下载素材（含中文 + 日文语音），再部署到 卫.rinko.ai。游戏素材不在仓库里：`npm run build:worker`（`wrangler deploy` 的构建步骤）发现 `data/assets.json` 引用的文件不在磁盘上时，会先运行 `tools/fetch-assets.mjs` 补齐；下载失败或没有任何素材时构建直接失败，不会部署一个没有素材的站点。

1. 打开 <https://dash.cloudflare.com>，用管理 `rinko.ai` 的账号登录。左侧 **Workers 和 Pages** → **创建** → **导入存储库（Import a repository）** → 连接 GitHub，授权仓库 `Slapq/Stronghold-Protocol`。
2. 设置构建：

   | 项目 | 填写 |
   |---|---|
   | 项目 / Worker 名称 | `stronghold-protocol`（必须与 `wrangler.jsonc` 的 `name` 一致） |
   | 生产分支 | 包含本配置的分支（例如 `claude/gallant-sagan-37hyv3`，合并后改为 `master`） |
   | 构建命令 | `npm run assets`（留空也可以：部署时缺素材会自动下载） |
   | 部署命令 | `npx wrangler deploy`（默认值） |
   | 根目录 | `/`（默认值） |

3. **保存并部署**。首次构建要安装依赖、从 GitHub 下载约 306 MiB 素材、上传约 8,000 个文件，几分钟内完成（上限 20 分钟）。部署时按 `wrangler.jsonc` 自动绑定 卫.rinko.ai 并签发证书。如果日志提示自定义域名无权限或冲突：Worker → **设置** → **域和路由** → **添加** → **自定义域**，填 `卫.rinko.ai`（这个主机名事先不能有别的 DNS 记录）。
4. 打开 <https://xn--rlr.rinko.ai/healthz>，看到 `{"ok":true,…}` 即部署成功。之后每次向生产分支推送都会自动重新构建、部署；素材会重新下载（约 1 分钟），但只上传有变化的文件。
5. 发群用的素材包也在网页上做：用电脑上的 Chrome / Edge 打开 卫.rinko.ai → 右下角 **资源管理** → **在线下载** → 完成后点 **导出 ZIP（发给朋友）**，选择保存位置即可（约 321 MiB，直接写入磁盘）。其他浏览器会先在内存里生成再下载，手机上可能内存不足。朋友打开网站后在同一个窗口点 **导入本地 ZIP**。

构建失败时先看日志：从 GitHub 下载素材偶尔会被限流或超时，直接在控制台点 **重试部署**。素材有变化（重新部署后资源版本不同）时，旧 ZIP 无法导入，需要重新导出、重新发。

## 本地构建和部署

需要 Node.js 22+、npm、一个 Cloudflare 账号，以及托管在这个账号下的域名（Cloudflare 控制台「添加站点」，把域名的 NS 改到 Cloudflare；国内注册商的域名同样可以，不需要备案）。仓库不含受版权保护的游戏素材，先在本机准备：

```powershell
npm ci
npm run setup        # 首次：依赖、前端库、素材（含中文 + 日文干员战斗语音，约 321 MiB）
npm run assets       # 已有素材的旧目录：补下战斗语音（只下载缺的文件）
npx wrangler login   # 浏览器里登录要部署到的 Cloudflare 账号
```

`wrangler.jsonc` 的 `routes` 已经是 `xn--rlr.rinko.ai`（卫.rinko.ai），第一次部署时 Wrangler 会自动创建 DNS 记录并签发证书；这个主机名事先不能有别的 DNS 记录。换域名就改这一行（中文域名要写成 punycode，可以用 `node -e "console.log(new URL('https://卫.rinko.ai').hostname)"` 换算）。本地试玩用 `npm run dev:worker`，访问它输出的 localhost 地址；Windows 上先停止 `dev:worker` 再部署，避免它的目录监视器占用构建输出。部署：

```powershell
npm run deploy:worker
```

账号下有多个 Cloudflare 账户时，Wrangler 会让你选择，也可以先设置 `CLOUDFLARE_ACCOUNT_ID`。

Wrangler 执行构建、上传本地静态文件，并初始化两个 SQLite DO 绑定：`ROOMS`（房间）和 `ADMISSION`（短期 IP 限流）。Cloudflare 插件可用于账号、Worker 配置和部署版本的管理、检查；本地批量文件上传使用 Wrangler。

构建只发布 `dist/client/` 以及 `dist/worker/index.mjs`。前端保持 `/data/`、`/shared/`、`/sim/` 的既有路径；Node 文件系统数据读取由构建时 JSON 导入替换。`public/dev/`、ZIP、日志、source map 和服务端私有数据读取模块不会发布。不要手动把整个仓库上传为静态站点。

## 给朋友准备资源包

网页上：**资源管理** → 下载完成后 **导出 ZIP（发给朋友）**（见上文第 5 步）。本地有完整素材时也可以：

```powershell
npm run resources:pack
```

输出为 `.cache/stronghold-resources-<内容版本>.zip`（约 321 MiB，含中文 + 日文语音）。把这个文件发到群里。ZIP 必须和站点当前的素材一致：每次 `npm run assets` 后重新部署，就要重新打包、重新发。玩家第一次进入站点时可以：

1. 在线下载 / 继续下载：逐文件校验 SHA-256，已经完成的文件不重复下载；中断文件会从该文件重新下载。
2. 导入本地 ZIP：文件只在浏览器本地读取，按站点清单逐项校验，**不会上传**。完整包须与站点资源匹配，部分完成的导入可以重试。
3. 暂时跳过，按需加载：直接进入游戏，日后通过「资源管理」补齐或清理资源。

缓存使用 Cache Storage 和 Service Worker，支持音频 Range。完整缓存会跳过下次首次安装界面；更新时相同哈希的文件可复用。缓存按站点来源隔离，换域名需重新导入；隐私模式、空间不足或浏览器清理会导致缓存丢失。资源包只包含素材与字体，网站代码、API、联机仍需联网；这不是完整的离线游戏。

## 对局与更新限制

普通断网可使用房间前缀的会话 token 重连，房间代码 / token 不与其他房间共用。等候房间、玩家席位和会话会保存以支持 DO 休眠唤醒；过期房间会让客户端重新建立大厅连接。

**进行中的对局仍使用内存状态，不能跨部署、运行时重启或实例故障恢复。** 此时会清除失效会话并提示房间关闭，需重新开局。请在朋友结束游戏后部署更新。长时间对局、AI 计算与 DO 请求 / 存储写入仍受 Cloudflare 配额限制。

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
