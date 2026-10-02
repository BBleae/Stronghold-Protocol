# Cloudflare Workers Implementation Plan

**Goal:** 完成已批准的 Workers 迁移及浏览器资源安装，并部署到用户账号。

**Spec:** ../specs/2026-10-03-cloudflare-design.md

**Architecture:** Static Assets + 每房间 SQLite Durable Object；Cache Storage + Service Worker + ZIP 资源包。

**Tech Stack:** Node.js 22、Wrangler 4、esbuild、fflate、原生浏览器 API。

## 任务与验证

- [ ] 资源安装：tools/resource-pack.mjs 生成可信清单与 ZIP；public/js/resources/ 处理校验、导入、下载和界面；public/resource-sw.js 提供缓存响应。先写失败测试，再实现，验证损坏文件、版本复用、续传和 Range。
- [ ] 房间服务：worker/ 下实现路由、数据适配和每房间 DO；仅必要时为 server/net.js 增加关闭自动计时器的选项。先写测试，再验证隔离、容量、票据、重连和空闲恢复。
- [ ] 客户端与构建：public/js/room-net.js 提供 Net 子类；构建仅部署公开文件，将 Node 数据加载替换为 Worker 数据加载，生成清单并启用首次资源界面。验证 Node 启动不变，Wrangler dry-run 成功，真实浏览器联调成功。
- [ ] 总体验证与发布：运行完整测试，独立审查改动，修复重要问题；认证后部署并验证线上地址。

## 实施记录

- 2026-10-03：工作区初始干净。为保留现有本机约 325 MiB 素材与依赖，在当前 checkout 创建 codex/cloudflare-workers 分支实施；不复制独立 worktree。
- 已确认 Wrangler 未认证。待可部署产物验证完成后执行登录流程。
- 两个独立模块按 dispatching-parallel-agents 技能并行实现，根代理负责公共依赖、构建和客户端集成，避免编辑相同文件。
