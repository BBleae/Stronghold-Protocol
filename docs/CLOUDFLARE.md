# Cloudflare 部署

适用场景：4–20 位朋友，分为多个最多 4 人的游戏房间。静态页面、游戏代码和素材由 **Workers Static Assets** 分发；每个房间使用独立的 **SQLite Durable Object + WebSocket**，复用原有房间、经济、回合和战斗协议。玩家浏览器计算正常战斗，AI / 掉线玩家由服务端处理。

## 为什么这样分配

- 当前素材约 313 MiB，拆分为约 5,500 个小文件。Static Assets 的限制按文件大小 / 数量计算，当前文件均小于 25 MiB、总数低于免费计划 20,000 个文件限制。素材不计入 Worker JS 包体，也不经过房间对象。
- 当前版本不需要 R2。后续若需要公开下载数百 MiB 的完整 ZIP，或资源频繁更新且需要独立生命周期，可把完整包或素材迁往 R2 并配置自定义域名 / 缓存。完整 ZIP 不能放进 Static Assets。
- 一个房间一个 DO 保证房间事件顺序，避免多个 Worker 实例各自保有不同状态，也无需 WebRTC 的 NAT 穿透、信令与 TURN。等待房间使用 WebSocket Hibernation，活跃对局的定时器会保持实例运行。
- 亚太 `locationHint` 是尽力提示，不能保证落在指定地区。大陆用户的实际连通性和延迟取决于网络线路，资源本地导入只能减少素材下载等待。`workers.dev` 的可达性应由朋友实测；有域名时可后续绑定自定义域名。

参考：[Static Assets 限额](https://developers.cloudflare.com/workers/static-assets/platform/limits/)、[DO WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。静态资源和房间计算是不同的计费项，不承诺多人长时间游戏一定完全免费。本项目不会自动升级收费计划。

## 构建和部署

需要 Node.js 22+、npm 和现有 Cloudflare 账号。仓库不含受版权保护的游戏素材；沿用原有 `npm run setup` 准备素材，或使用已有完整本地项目。

```powershell
npm ci
npm run setup
bun x wrangler@latest login
npm run build:worker
npm run dev:worker
```

`wrangler.jsonc` 当前指向用户选择的「晴猫」账号，Worker 名为 `stronghold-protocol`；迁移到其他账号前应修改 `account_id`。开发访问 Wrangler 输出的 localhost 地址。Windows 上先停止 `dev:worker` 再部署，避免它的目录监视器占用构建输出。部署：

```powershell
bun x wrangler@latest deploy
```

Wrangler 执行构建、上传本地静态文件，并初始化两个 SQLite DO 绑定：`ROOMS`（房间）和 `ADMISSION`（短期 IP 限流）。Cloudflare 插件可用于账号、Worker 配置和部署版本的管理、检查；本地批量文件上传使用 Wrangler。

构建只发布 `dist/client/` 以及 `dist/worker/index.mjs`。前端保持 `/data/`、`/shared/`、`/sim/` 的既有路径；Node 文件系统数据读取由构建时 JSON 导入替换。`public/dev/`、ZIP、日志、source map 和服务端私有数据读取模块不会发布。不要手动把整个仓库上传为静态站点。

## 给朋友准备资源包

```powershell
npm run resources:pack
```

输出为 `.cache/stronghold-resources-<内容版本>.zip`。把这个文件通过朋友之间现有的文件传输方式分发。玩家第一次进入站点时可以：

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
