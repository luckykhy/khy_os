# [DESIGN-GIT-003] Git 规范与自动化治理

> 版本: 1.0.0
> 状态: 生效
> 负责人: khy
> 创建日期: 2026-09-13

---

## 1. 概述

本文档定义 khy-os 仓库的 Git 使用规范，包括提交信息、分支管理、文件组织和自动化治理。规范既支持手动执行，也支持通过脚本自动生成和检查。

---

## 2. Commit Message 规范

### 2.1 格式（Conventional Commits + 中文）

```
<type>(<scope>): <中文描述>

[可选正文]

[可选脚注]
```

### 2.2 Type 类型

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(gateway): 新增 DeepSeek 适配器` |
| `fix` | 修复 bug | `fix(cli): 修复中文别名匹配失败` |
| `docs` | 文档更新 | `docs: 更新 CONTRIBUTING.md` |
| `style` | 代码格式（不影响功能） | `style: 统一单引号风格` |
| `refactor` | 重构（不新增功能/修复 bug） | `refactor(services): 拆分 aiGateway` |
| `perf` | 性能优化 | `perf: 优化 RAG 检索速度` |
| `test` | 测试相关 | `test: 补充 gateway 单测` |
| `chore` | 构建/工具/依赖变更 | `chore: 升级 pnpm 到 10.18` |
| `ci` | CI/CD 配置 | `ci: 添加 PR 安全门禁` |
| `revert` | 回滚 | `revert: 回滚 feat(gateway)` |

### 2.3 Scope 范围（可选）

按模块/目录命名：

| Scope | 对应目录 |
|-------|----------|
| `cli` | `services/backend/src/cli/` |
| `gateway` | `services/backend/src/services/gateway/` |
| `backend` | `services/backend/` |
| `frontend` | `apps/ai-frontend/` |
| `desktop` | `apps/khyos-desktop/` |
| `mobile` | `apps/khy-os-client-app/` |
| `kernel` | `kernel/` |
| `platform` | `platform/` |
| `docs` | `docs/` |
| `scripts` | `scripts/` |
| `ext` | `extensions/` |

### 2.4 描述规范

**中文 + 动词前置 + 一句话说完**：

```bash
# ✅ 正确
feat(gateway): 新增 Ollama 本地模型适配器
fix(cli): 修复中文拼音别名冲突导致命令路由错误
docs: 补充 AGENTS.md 工程规则说明

# ❌ 错误
fix: bug 修复                    # 无具体描述
update code                      # 无 type
feat: 添加了一些新功能            # 冗余修饰
```

### 2.5 脚注规范

```bash
# 关联 Issue
Closes #123
Fixes #456

# 破坏性变更
BREAKING CHANGE: 移除 khy quant 命令，改用 khy quant:run

# AI 辅助标记（可选）
Co-authored-by: Claude Opus 4 <noreply@anthropic.com>
```

---

## 3. Branch 命名规范

### 3.1 格式

```
<type>/<ticket-id>-<简短描述>
```

### 3.2 Type 分类

| Type | 说明 | 示例 |
|------|------|------|
| `feat/` | 新功能开发 | `feat/123-add-deepseek-adapter` |
| `fix/` | Bug 修复 | `fix/456-alias-conflict` |
| `docs/` | 文档更新 | `docs/update-contributing` |
| `refactor/` | 重构 | `refactor/split-aigateway` |
| `chore/` | 杂项维护 | `chore/upgrade-pnpm` |
| `release/` | 发布准备 | `release/v1.6.0` |
| `hotfix/` | 紧急修复 | `hotfix/critical-auth-bug` |

### 3.3 命名规则

- 全小写，单词用 `-` 连接
- 描述部分不超过 5 个单词
- ticket-id 可选（有 Issue 时必填）

```bash
# ✅ 正确
feat/123-add-deepseek-adapter
fix/456-alias-conflict
docs/update-contributing

# ❌ 错误
Feature/Add_DeepSeek_Adapter    # 大写+下划线
fix-123                          # 缺少 type
feat/                            # 缺少描述
```

---

## 4. 文件组织规范

### 4.1 临时文件管理

**禁止提交的临时文件类型**：

| 文件模式 | 说明 | 清理方式 |
|----------|------|----------|
| `tmp-*` | 调试/测试产物 | 手动或脚本删除 |
| `*.log` | 日志文件 | `.gitignore` 已排除 |
| `*.tmp` | 临时文件 | 手动删除 |
| `coverage/` | 测试覆盖率 | `npm run clean` |
| `dist/` | 构建产物 | `npm run clean` |
| `node_modules/` | 依赖 | `pnpm install` 重装 |

### 4.2 构建产物管理

**必须纳入 `.gitignore` 的构建产物**：

```gitignore
# 依赖
node_modules/
__pycache__/
*.pyc

# 构建输出
dist/
build/
*.egg-info/

# 测试覆盖率
coverage/
.nyc_output/

# 日志
*.log
logs/

# 临时文件
tmp/
.tmp/
tmp-*

# 环境配置
.env
.env.local
.env.*.local

# IDE 配置
.idea/
.vscode/
*.swp
```

### 4.3 大文件管理

**超过 100MB 的文件必须**：

1. 使用 Git LFS 管理
2. 或移至外部存储（网盘/对象存储）
3. 在 `.gitignore` 中排除

**当前大文件清单**：

| 文件 | 大小 | 处理方式 |
|------|------|----------|
| `node_modules/` | 1.68GB | `.gitignore` 排除 |
| `.git-backup-*/` | 720MB | `.gitignore` 排除 |
| `apps/khy-mobile/release/*.apk` | 450MB | 保留最新，删除历史 |

---

## 5. 自动化治理

### 5.1 Pre-commit Hook

```bash
#!/bin/bash
# .githooks/pre-commit

# 1. 检查是否有 tmp-* 文件
if git diff --cached --name-only | grep -q "^tmp-"; then
  echo "❌ 错误：检测到 tmp-* 临时文件，请先清理"
  exit 1
fi

# 2. 检查是否有大文件（>10MB）
LARGE_FILES=$(git diff --cached --name-only | while read f; do
  if [ -f "$f" ]; then
    SIZE=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null)
    if [ "$SIZE" -gt 10485760 ]; then
      echo "$f"
    fi
  fi
done)

if [ -n "$LARGE_FILES" ]; then
  echo "❌ 错误：检测到大文件（>10MB）："
  echo "$LARGE_FILES"
  echo "请使用 Git LFS 或移至外部存储"
  exit 1
fi

# 3. 检查 commit message 格式
COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Conventional Commits 正则
PATTERN="^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\([a-z]+\))?: .+"

if ! echo "$COMMIT_MSG" | head -1 | grep -qE "$PATTERN"; then
  echo "❌ 错误：Commit message 格式不正确"
  echo "正确格式：<type>(<scope>): <中文描述>"
  echo "示例：feat(gateway): 新增 DeepSeek 适配器"
  exit 1
fi
```

### 5.2 Commit Message 检查脚本

创建 `scripts/ci/check-commit-message.js`：

```javascript
#!/usr/bin/env node
/**
 * 检查 commit message 是否符合规范
 * 用法：node check-commit-message.js <commit-msg-file>
 */

const fs = require('fs');

const COMMIT_MSG_FILE = process.argv[2];
if (!COMMIT_MSG_FILE) {
  console.error('用法: node check-commit-message.js <commit-msg-file>');
  process.exit(1);
}

const msg = fs.readFileSync(COMMIT_MSG_FILE, 'utf8');
const firstLine = msg.split('\n')[0];

// Conventional Commits 正则
const PATTERN = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\([a-z]+\))?: .+/;

if (!PATTERN.test(firstLine)) {
  console.error('❌ Commit message 格式不正确');
  console.error('正确格式: <type>(<scope>): <中文描述>');
  console.error('示例: feat(gateway): 新增 DeepSeek 适配器');
  process.exit(1);
}

// 检查描述长度
const description = firstLine.replace(/^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\([a-z]+\))?: /, '');
if (description.length > 72) {
  console.error('❌ 描述部分超过 72 字符');
  process.exit(1);
}

console.log('✅ Commit message 格式正确');
```

### 5.3 临时文件清理脚本

创建 `scripts/maintenance/clean-temp.js`：

```javascript
#!/usr/bin/env node
/**
 * 清理临时文件
 * 用法：node clean-temp.js [--apply]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();

const TEMP_PATTERNS = [
  'tmp-*',
  '*.tmp',
  '*.log',
  'coverage/',
  '.nyc_output/',
];

console.log('🔍 扫描临时文件...\n');

let totalSize = 0;
let fileCount = 0;

TEMP_PATTERNS.forEach(pattern => {
  const cmd = `find . -name "${pattern}" -not -path "./node_modules/*" -not -path "./.git/*"`;
  try {
    const output = execSync(cmd, { encoding: 'utf8' }).trim();
    if (output) {
      output.split('\n').forEach(file => {
        if (file) {
          const fullPath = path.join(ROOT, file);
          try {
            const stat = fs.statSync(fullPath);
            totalSize += stat.size;
            fileCount++;
            
            if (APPLY) {
              fs.rmSync(fullPath, { recursive: true, force: true });
              console.log(`  🗑️  删除: ${file}`);
            } else {
              console.log(`  📄 ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
            }
          } catch (e) {
            // 文件可能已被删除
          }
        }
      });
    }
  } catch (e) {
    // find 命令可能失败
  }
});

console.log(`\n📊 统计: ${fileCount} 个文件, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

if (!APPLY) {
  console.log('\n💡 运行 `node clean-temp.js --apply` 执行清理');
} else {
  console.log('\n✅ 清理完成');
}
```

---

## 6. Gitignore 最佳实践

### 6.1 分层排除策略

```gitignore
# 1. 依赖（可重装）
node_modules/
__pycache__/
*.pyc

# 2. 构建产物（可重建）
dist/
build/
*.egg-info/
coverage/

# 3. 日志（运行时生成）
*.log
logs/

# 4. 临时文件（调试产物）
tmp/
.tmp/
tmp-*

# 5. 环境配置（含密钥）
.env
.env.local
.env.*.local
.env.bak-*

# 6. IDE 配置（个人偏好）
.idea/
.vscode/
*.swp
*.swo

# 7. 大文件（外部存储）
**/_source/*.tar.gz.enc
_bs3_prebuild.tar.gz
```

### 6.2 反选规则

```gitignore
# 排除所有 build/
build/

# 但保留 packaging/build/（CI 脚本）
!packaging/build/
!packaging/build/*.js
!packaging/build/*.json
```

---

## 7. 分支管理策略

### 7.1 分支类型

| 分支 | 用途 | 命名 | 生命周期 |
|------|------|------|----------|
| `master` | 主干 | `master` | 永久 |
| `release/*` | 发布准备 | `release/v1.6.0` | 临时 |
| `feat/*` | 新功能 | `feat/123-add-deepseek` | 临时 |
| `fix/*` | Bug 修复 | `fix/456-alias-conflict` | 临时 |
| `hotfix/*` | 紧急修复 | `hotfix/critical-auth-bug` | 临时 |

### 7.2 工作流

```
master ← release/* ← feat/* (PR)
  ↑
  └── hotfix/* (PR, 直接合并到 master)
```

### 7.3 PR 合并策略

- **feat/fix 分支**：Squash and merge（保持 master 历史整洁）
- **release 分支**：Create a merge commit（保留发布历史）
- **hotfix 分支**：Squash and merge

---

## 8. 自动化检查清单

### 8.1 Pre-commit 检查

- [ ] 无 `tmp-*` 临时文件
- [ ] 无大文件（>10MB）
- [ ] Commit message 格式正确
- [ ] 无敏感信息（密钥、密码）

### 8.2 PR 检查（CI 自动）

- [ ] 版本同步检查
- [ ] Agent 规则检查
- [ ] 叶子契约检查
- [ ] 架构债务检查
- [ ] 仓库布局检查
- [ ] 治理规则检查
- [ ] 模式覆盖检查
- [ ] Node/Python 语法检查
- [ ] 依赖漏洞扫描
- [ ] 密钥扫描

### 8.3 定期清理（每周）

```bash
# 清理临时文件
node scripts/maintenance/clean-temp.js --apply

# 清理已合并的本地分支
git branch --merged master | grep -v "master" | xargs git branch -d

# 清理过期的远程引用
git fetch --prune
```

---

## 9. 违规处理

### 9.1 Pre-commit 违规

- 阻止提交，提示修复方法
- 开发者修复后重新提交

### 9.2 CI 违规

- PR 标记为 "needs-fix"
- 自动添加评论说明问题
- 阻止合并直到修复

### 9.3 紧急情况

- 使用 `--no-verify` 跳过 pre-commit（仅限紧急修复）
- 在 PR 描述中说明跳过原因
- 后续补充检查

---

## 10. 参考资料

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Branching Strategies](https://www.atlassian.com/git/tutorials/comparing-workflows)
- [Gitignore Best Practices](https://git-scm.com/docs/gitignore)

---

## 附录 A: 快速参考卡

### Commit Message

```bash
# 新功能
feat(gateway): 新增 DeepSeek 适配器

# 修复 bug
fix(cli): 修复中文别名匹配失败

# 文档更新
docs: 更新 CONTRIBUTING.md

# 重构
refactor(services): 拆分 aiGateway 模块

# 紧急修复
fix(auth): 修复登录漏洞
Closes #789
BREAKING CHANGE: 移除旧版登录接口
```

### Branch 命名

```bash
# 新功能
git checkout -b feat/123-add-deepseek-adapter

# Bug 修复
git checkout -b fix/456-alias-conflict

# 紧急修复
git checkout -b hotfix/critical-auth-bug
```

### 清理命令

```bash
# 清理临时文件
node scripts/maintenance/clean-temp.js --apply

# 清理已合并分支
git branch --merged master | grep -v "master" | xargs git branch -d

# 清理远程引用
git fetch --prune
```
