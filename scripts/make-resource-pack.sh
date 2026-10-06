#!/usr/bin/env bash
# 卫戍协议：盟约 · build a resource ZIP for friends from the public asset sources (macOS / Linux). Docs: docs/CLOUDFLARE.md
# It lacks the local client extraction: the site's 下载资源包 ZIP is the complete pack.
# Installs dependencies on the first run, downloads every game asset (incl. 中文 + 日文 operator voice; resumable: run it
# again after an interruption), then writes stronghold-resources-<version>.zip into the project folder.
# Slow or blocked GitHub downloads: set a proxy first, e.g.  HTTPS_PROXY=http://127.0.0.1:7890 scripts/make-resource-pack.sh
# or, without a local proxy, the gh-proxy mirror (a third-party proxy, docs/DEPLOY.md):  SP_ASSET_SOURCE=mirror scripts/make-resource-pack.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_USE_ENV_PROXY=1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js（需要 22 或更高）：https://nodejs.org/zh-cn/download"
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo "Node.js $(node -v) 太旧，需要 22 或更高：https://nodejs.org/zh-cn/download"
  exit 1
fi
if [ ! -f node_modules/@zip.js/zip.js/package.json ]; then
  echo "[首次运行] 正在安装依赖 npm ci ..."
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi
echo "正在下载素材（约 340 MiB，中断后再次运行会续传）..."
node tools/vendor.mjs
node tools/fetch-assets.mjs
echo "正在打包 ..."
node tools/resource-pack.mjs --out=.
echo
echo "完成：$(ls -1t stronghold-resources-*.zip | head -1)"
echo "发给朋友后，在网站的「资源管理 → 导入本地 ZIP」导入。"
