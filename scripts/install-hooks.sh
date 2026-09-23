#!/bin/bash
# 安装 Git hooks
# 用法：npm run hooks:install

set -e

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "🔧 安装 Git hooks...\n"

# 配置 git 使用 .githooks 目录
git config core.hooksPath .githooks

# 确保 hook 脚本有执行权限
chmod +x .githooks/*

echo "✅ Git hooks 已安装\n"
echo "已安装的 hooks："
ls -la .githooks/
