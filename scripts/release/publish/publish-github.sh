#!/usr/bin/env bash
# publish-github.sh — 引导式 GitHub 源码发布（薄封装 _git-forge.sh）。
#
# 引导设置 GitHub 仓库地址并输入 token（GITHUB_TOKEN/GH_TOKEN 环境变量优先，
# 否则隐藏输入），随后在 fresh-machine 上自动 `khy restore` 还原完整源码、
# git init/commit（若快照无 .git），并用一次性 token URL 推送。
#
# 用法： bash scripts/release/publish/publish-github.sh [--repo owner/repo] [--dry-run] ...
#        --help 查看完整参数。
#
# shellcheck shell=bash
PLATFORM='github'
# shellcheck source=scripts/release/publish/_git-forge.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_git-forge.sh"
