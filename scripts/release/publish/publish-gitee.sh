#!/usr/bin/env bash
# publish-gitee.sh — 引导式 Gitee 源码发布（薄封装 _git-forge.sh）。
#
# 引导设置 Gitee 仓库地址并输入 token（GITEE_TOKEN 环境变量优先，否则隐藏
# 输入）。Gitee 的 token 推送需要真实账号用户名（--user，或提示输入，默认取
# owner 段）。fresh-machine 上自动 `khy restore` 还原完整源码后再推送。
#
# 用法： bash scripts/release/publish/publish-gitee.sh [--repo owner/repo] [--user NAME] [--dry-run] ...
#        --help 查看完整参数。
#
# shellcheck shell=bash
PLATFORM='gitee'
# shellcheck source=scripts/release/publish/_git-forge.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_git-forge.sh"
