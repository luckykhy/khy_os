#!/usr/bin/env bash
# publish-gitlab.sh — 引导式 GitLab 源码发布（薄封装 _git-forge.sh）。
#
# 引导设置 GitLab 仓库地址并输入 token（GITLAB_TOKEN/GL_TOKEN/CI_JOB_TOKEN
# 环境变量优先，否则隐藏输入）。token 以 oauth2 用户名推送。fresh-machine 上
# 自动 `khy restore` 还原完整源码后再推送。
#
# 用法： bash scripts/release/publish/publish-gitlab.sh [--repo owner/repo] [--dry-run] ...
#        --help 查看完整参数。
#
# shellcheck shell=bash
PLATFORM='gitlab'
# shellcheck source=scripts/release/publish/_git-forge.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_git-forge.sh"
