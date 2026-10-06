@echo off
rem Stronghold Protocol - double-click to build a resource ZIP for friends from the public asset sources (Windows).
rem Docs: docs\CLOUDFLARE.md. It lacks the local client extraction: the site's 下载资源包 ZIP is the complete pack.
rem Installs dependencies on the first run, downloads every game asset (incl. 中文 + 日文 operator voice; resumable:
rem run it again after an interruption), then writes stronghold-resources-<version>.zip into the project folder.
rem Slow or blocked GitHub downloads: set a proxy first, e.g.  set HTTPS_PROXY=http://127.0.0.1:7890
rem or, without a local proxy, the gh-proxy mirror (a third-party proxy, docs\DEPLOY.md):  set SP_ASSET_SOURCE=mirror
chcp 65001 >nul
setlocal EnableExtensions
title 卫戍协议：盟约 - 生成资源包
cd /d "%~dp0.."
set NODE_USE_ENV_PROXY=1

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 goto :oldnode

if not exist "node_modules\@zip.js\zip.js\package.json" (
  echo [首次运行] 正在安装依赖 npm ci ...
  call npm ci --no-audit --no-fund || call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

echo 正在下载素材（约 340 MiB，中断后再次运行会续传）...
node tools\vendor.mjs
if errorlevel 1 goto :fail
node tools\fetch-assets.mjs
if errorlevel 1 goto :fail
echo 正在打包 ...
node tools\resource-pack.mjs --out=.
if errorlevel 1 goto :fail
echo.
echo 完成：资源包在本文件夹里（stronghold-resources-*.zip），发给朋友后在网站的「资源管理 - 导入本地 ZIP」导入。
start "" explorer "%CD%"
pause
exit /b 0

:nonode
echo 未找到 Node.js（需要 22 或更高）。安装：winget install OpenJS.NodeJS.LTS 或 https://nodejs.org/zh-cn/download
pause
exit /b 1
:oldnode
echo Node.js 版本太旧，需要 22 或更高：https://nodejs.org/zh-cn/download
pause
exit /b 1
:fail
echo.
echo 失败了。网络问题可以直接再运行一次（已下载的文件会保留）；GitHub 下载慢可先设置代理再运行：
echo   set HTTPS_PROXY=http://127.0.0.1:7890
echo 没有本地代理时也可以改走 gh-proxy 镜像（第三方代理）：
echo   set SP_ASSET_SOURCE=mirror
pause
exit /b 1
