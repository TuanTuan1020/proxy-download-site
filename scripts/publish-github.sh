#!/usr/bin/env bash
# 一键发布到 GitHub：创建仓库 → 推送 → 开启 Pages（Actions 方式）
# 用法：./scripts/publish-github.sh [仓库名] [private|public]
# 前提：已在本机执行 gh auth login（令牌需含 repo + workflow 权限）
set -euo pipefail

REPO_NAME="${1:-proxy-download-site}"
VISIBILITY="${2:-public}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ 未检测到 GitHub 登录状态，请先运行：gh auth login" >&2
  exit 1
fi

OWNER="$(gh api user --jq .login)"
FULL="$OWNER/$REPO_NAME"
echo "👤 账号：$OWNER"
echo "📦 目标仓库：$FULL（$VISIBILITY）"

# 1) 创建或复用仓库
if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "ℹ️  仓库已存在，复用"
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "https://github.com/$FULL.git"
else
  echo "🆕 创建仓库..."
  gh repo create "$FULL" "--$VISIBILITY" --source=. --remote=origin --description "代理客户端下载站：Windows/macOS/Android 开源客户端，安装包同步与校验" --push
  echo "✅ 仓库创建并推送完成"
fi

# 2) 推送 main
git branch -M main
if ! git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git push -u origin main
else
  git push -u origin main
fi

# 3) 开启 Pages（Source = GitHub Actions）
if gh api "repos/$FULL/pages" >/dev/null 2>&1; then
  echo "ℹ️  Pages 已启用"
else
  echo "🚀 启用 Pages（build_type=workflow）..."
  if gh api -X POST "repos/$FULL/pages" -f build_type=workflow >/dev/null 2>&1; then
    echo "✅ Pages 已启用"
  else
    echo "⚠️  自动启用 Pages 失败，请到 Settings → Pages → Source 选择 “GitHub Actions”"
  fi
fi

# 4) 允许 Actions 写仓库（更新状态与数据需要 push 权限）
gh api -X PUT "repos/$FULL/actions/permissions/workflow" \
  -f default_workflow_permissions=write >/dev/null 2>&1 \
  && echo "✅ Actions 默认权限已设为 write" \
  || echo "⚠️  请手动把 Settings → Actions → Workflow permissions 设为 Read and write"

echo
echo "📍 仓库： https://github.com/$FULL"
echo "📍 页面： https://$OWNER.github.io/$REPO_NAME/"
echo "📍 Actions：https://github.com/$FULL/actions"
echo
echo "下一步（可选，让“本站下载”真正可用）："
echo "  1. 建好对象存储桶（R2/OSS/COS）"
echo "  2. 仓库 Settings → Secrets and variables → Actions 填 S3_* 与 PUBLIC_DOWNLOAD_BASE"
echo "  3. 手动 Run workflow 一次，检查下载链接与 SHA-256"
