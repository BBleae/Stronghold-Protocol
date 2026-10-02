# Cloudflare 与本地资源包迁移设计

用户已确认：朋友范围使用（4–20 人，以中国大陆为主），部署到 Cloudflare Workers；静态素材通过 Workers Static Assets 分发，WSS 连接每房间一个 Durable Object；首次进入支持在线下载/续传、本地 ZIP 导入、按需加载。

## 边界与接口

- 保留 Node.js 启动方式、现有游戏协议和浏览器战斗计算。
- Worker 只路由 API、WebSocket 和健康检查；静态文件直接由 Assets 提供。构建产物不得包含服务器私有文件、开发录像或凭据。
- `POST /api/rooms` 预留四位房间码，返回 `{code,ticket}`；`GET /api/rooms/:code` 检查房间状态；`GET /ws?room=CODE&ticket=...` 连接指定房间。票据只允许预留者创建房间。
- WebSocket welcome 中 reconnect token 使用 `CODE.<32 hex token>`，仍满足原协议 64 字符限制；token 只给所属玩家。房间内部复用 Lobby / Network / Match。
- 浏览器只在 Workers 构建中启用 RoomNet，负责创建/加入房间时切换连接和错误回退。Node 客户端行为不变。
- 等待房间可使用 Hibernation 并恢复已保存会话；活跃对局的定时器与状态保留在实例内。初版不承诺跨部署/实例重启恢复正在进行的对局，必须明确告知并在客户端清除失效状态。普通断线重连保留现有行为。
- 使用 SQLite-backed DO，亚太位置提示；不自动开通收费计划、不创建 R2。

## 资源安装

- 构建 `/resource-manifest.json`：格式版本、内容哈希版本、各文件的 URL、大小、SHA-256、MIME，总字节数。范围仅素材和字体，排除可执行程序与用户私密数据。
- 在线下载按清单逐文件写入 Cache Storage，继续下载只处理缺失文件；旧版本相同哈希可复用。
- 本地 ZIP 逐文件解包，使用站点可信清单校验，拒绝越界/未知路径与异常体积，不把本地文件上传到服务端；不一次展开整个包到内存。
- Service Worker 只接管清单内资源，支持音频 Range；代码、API、WS 不走资源离线缓存。磁盘配额不足时给出可理解提示，可选择按需加载。
- 首次资源准备界面和后续资源管理入口均可取消、补下载、导入、清理。缓存存在的判断依据实际 Cache Storage。
- 完整 ZIP 输出到本地供朋友分发，超过 Static Assets 单文件 25 MiB 时禁止打入部署目录。

## 验证

测试资源校验、部分下载续传、ZIP 导入、版本复用、Range；用本地 Workers runtime 验证两个独立房间、多人加入、开局和重连。运行原有 node:test 套件，区分基线问题与引入问题。部署需现有 Cloudflare 账号登录，成功后验证线上资源、健康检查和 WSS。
