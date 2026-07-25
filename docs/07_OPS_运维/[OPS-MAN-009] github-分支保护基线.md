<!-- 文档分类: OPS-MAN-009 | 阶段: 运维 | 原路径: docs/指南/github-分支保护基线.md -->
# GitHub Branch Protection Baseline

本指南定义了 `main` 分支的最小化 branch protection 策略，用于强制执行 CI/CD 质量门禁。

## 目标分支

- `main`

## 必需的 Pull Request 规则

在 GitHub branch protection 中为 `main` 启用以下选项：

1. 合并前必须经过 pull request
2. 必需的审批数：至少 `1`
3. 当推送新提交时，自动撤销过期的 pull request 审批
4. 合并前必须解决所有评论会话（conversation resolution）
5. 合并前必须通过 status check
6. 合并前分支必须为最新（up to date）
7. 包含管理员（administrators，推荐）

## 必需的 Status Check

将以下检查标记为 **required**：

1. `Quality Gates`
2. `Security Audit`
3. `Agent Rules Check`
4. `Backend Tests`
5. `Frontend Build`
6. `Python Package Check`
7. `CodeQL Analyze (javascript-typescript)`
8. `CodeQL Analyze (python)`

说明：

- `Backend Tests` 是一个聚合门禁作业。任何一个后端分片（shard）失败时它都会失败。
- 不要直接选择分片作业名称（`Backend Tests (Shard x/3)`）作为必需的检查。
- `Dependency Review` 仅在 pull request 时运行；在 CI 中保持启用，但不要将其设为 push 事件的必需检查。

## 可选但推荐的规则

1. 要求签名提交（signed commits）
2. 限制可推送到匹配分支的人员
3. 要求线性历史（linear history）
4. 不允许强制推送（force push）
5. 不允许删除（deletions）

## Release 工作流权限

对于 release 相关的工作流（`release-preflight.yml`、`release.yml`），需要配置仓库 secrets：

1. `PYPI_API_TOKEN`（仅在 `publish_pypi=true` 时必需）

## 操作流程

1. 所有 feature 分支都向 `main` 提交 PR。
2. CI（`CI` 工作流）必须通过必需的检查。
3. 开启 PR 前先运行本地门禁：`npm run check:quality-gates`。
4. 在计划发布前手动运行 `Release Preflight`。
5. 先以 `dry_run=true` 运行 `Release`。
6. 在 dry run 通过后，再以 `dry_run=false` 运行 `Release`。
