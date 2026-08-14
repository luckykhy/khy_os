# Contributing to Khy-OS

Thanks for your interest in contributing! Please refer to [AGENTS.md](../AGENTS.md) for the main developer guide, architecture overview, and contribution workflows.

## Quick Start

1. Fork the repository
2. Run `npm install` at the project root
3. Initialize the database: `cd services/backend && node setup.js`
4. Start developing: `cd services/backend && node server.js` (or `npm run dev` if nodemon is configured)

## Code Quality

- JavaScript: ESLint + Prettier
- Python: flake8 + black
- Shell scripts: shellcheck

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure all CI checks pass
4. Get review from a maintainer

## License

This project uses a source-available license. See LICENSE file for details.

## 多人协作规范

### 1. 分支命名规范
- 主干: `main` — 唯一可部署分支
- 特性分支: `feat/<area-id>/<简述>` — area-id 来自 `docs/维护者/维护映射表.json`
- 修复分支: `fix/<area-id>/<简述>`
- 个人实验: `dev/<姓名>/<简述>`

### 2. PR 生命周期约束
- 分支不超过 3 天存活
- 每个 PR 变更文件数: 8 个以内为佳，超过 20 个将被 CI 阻断
- 鼓励频繁小 PR，禁止"憋大招"
- 合并前必须 rebase 到最新 main

### 3. 贡献者分级

| 级别 | 权限 | 必须通过的 Gate | 审批要求 |
|------|------|----------------|----------|
| 新手 | 仅文档/测试/非核心模块 | 全部 CI 检查 | CODEOWNER 审批 |
| 成员 | 自有模块内全功能 | 全部 CI 检查 | 自有模块内可自审，跨模块需 owner 审批 |
| 核心 | 全模块 | 版本同步 + 语法检查 | 紧急修复可 self-merge |

### 4. 跨模块变更处理
- 当 PR 触及 3+ 个顶层目录时，自动标记为"跨模块变更"
- 要求所有涉及模块的 CODEOWNER 审批
- 建议拆分为多个 PR

### 5. 离线协作（双机同步）
- 导出: `scripts\sync\export-sync.bat`
- 合入: `scripts\sync\import-sync.bat --bundle <file> --merge`
- 多人合入: `scripts\sync\merge-contributions.bat <bundle1> <bundle2> ...`

### 6. 冲突处理
- 启用 `git rerere`（`git config rerere.enabled true`）记忆冲突解决
- 短分支 + 区域隔离最小化冲突概率
- 冲突无法自解时由区域 owner 代为解决
