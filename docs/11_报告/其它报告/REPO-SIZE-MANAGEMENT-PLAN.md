# khy-os 项目体积管理方案（完整版）

> 生成日期: 2026-09-13 | v2 版本 | 基于 GitHub/Gitee/知乎/CSDN/Stack Overflow/GitLab 等多平台调研 + 项目实测数据

---

## 1. 现状诊断

### 1.1 体积总览

| 指标 | 数值 | 说明 |
|------|------|------|
| 工作目录总大小 | **7.99 GB** | 139,531 个文件 |
| Git 追踪文件数 | 8,593 | .gitignore 生效良好 |
| .git 目录 | 0.7 GB | 正常范围 |
| 未追踪/未提交文件 | 1,680 | 大量临时文件堆积 |

### 1.2 工作目录体积分布（Top 20）

| 目录 | 大小 | Git 追踪? | 问题 |
|------|------|-----------|------|
| `apps/khy-os-client-app/build/` | **3.19 GB** | ✗ 已忽略 | Flutter 构建产物，每次 build 重建 |
| `node_modules/` | **1.64 GB** | ✗ 已忽略 | pnpm 依赖缓存（.pnpm store + 符号链接） |
| `.git/` | 0.70 GB | - | Git 对象库 |
| `dist/` | 0.65 GB | ✗ 已忽略 | 构建输出 |
| `apps/khy-mobile` | 0.73 GB | 部分 | 移动端项目 |
| `dist-electron/` | 0.32 GB | ✗ 已忽略 | Electron 构建输出 |
| `apps/khyos-desktop` | 0.37 GB | 部分 | 桌面端项目 |
| `services/` | 0.18 GB | ✓ 追踪 | 后端服务源码 |
| `apps/khy-os-client-app/.dart_tool/` | 325 MB | ✗ 已忽略 | Dart 工具缓存 |
| `lib/` | 0.12 GB | ✓ 追踪 | 共享库 |
| `tmp-*` 文件（252个） | 16 MB | ✗ 已忽略 | 临时脚本/日志 |
| `classes*.dex`（13个） | 9.76 MB | ✗ 已忽略 | Android 构建残留 |

### 1.3 关键发现

**✅ 做得好的地方：**
- `.gitignore` 已正确排除 `build/`、`node_modules/`、`dist/`、`dist-electron/`、`tmp-*`、`classes*.dex`
- 追踪文件数（8,593）控制合理
- Git 仓库本身（0.7GB）在健康范围

**⚠️ 需要解决的问题：**
1. **工作目录膨胀**：构建产物（3.19GB）+ 缓存（325MB + 1.64GB）+ 构建输出（0.97GB）= **6.13 GB** 占用磁盘但非源码
2. **临时文件堆积**：252 个 `tmp-*` 文件（16MB）虽然被忽略但仍占磁盘
3. **Flutter 应用（khy-os-client-app）**占工作目录 57%，是最大体积来源
4. **无自动化清理机制**：依赖手动清理，容易遗忘
5. **1,680 个未追踪文件**：包括 IDE 文件、日志、coverage 报告等

---

## 2. 多平台调研结果

### 2.1 核心认知：Git 体积的本质

> 来源：CSDN、知乎、Stack Overflow 多篇实战文章

**关键原理（所有平台一致强调）：**

1. **`.gitignore` 不会追溯**：想忽略一个已追踪文件，得先 `git rm --cached`
2. **删文件 ≠ 删历史**：工作区删掉只是新增一个「删除」提交，旧版本仍在
3. **体积由可达性决定**：clone 只拉可达对象，分支和 tag 是唯二的入口
4. **Git 不是网盘**：二进制文件应避免直接提交，Git 对二进制几乎不产生 diff 增量
5. **大文件一旦进历史，仓库只增不减**

> 来源：知乎专栏、Gitee 帮助中心、腾讯云开发者社区

### 2.2 工具全景对比

#### 历史重写工具（清理已提交的大文件）

| 工具 | 语言 | 速度 | 安全性 | 推荐度 | 适用场景 |
|------|------|------|--------|--------|----------|
| **[git-filter-repo](https://github.com/newren/git-filter-repo)** | Python | ⚡ 10万提交: 2分钟 | ✅ 原子操作+备份 | ⭐⭐⭐⭐⭐ | **默认首选**，Git 官方推荐 |
| **[BFG Repo-Cleaner](https://github.com/rtyley/bfg-repo-cleaner)** | Java | ⚡ 10万提交: 5分钟 | ⚠️ 无自动备份 | ⭐⭐⭐⭐ | 紧急清理大文件，无需 Python |
| **[git repo-clean (Gitee)](https://gitee.com/oschina/git-repo-clean)** | Go | ⚡ 快 | ✅ 交互式安全 | ⭐⭐⭐⭐ | **Gitee 平台专用**，中文友好 |
| ~~git filter-branch~~ | Shell | 🐌 10万提交: 60分钟 | ❌ 易残留备份 | ❌ 已废弃 | 避免使用 |

> 来源：CSDN 多篇 2026 年文章、Gitee 帮助中心、知乎实战复盘

#### 诊断分析工具

| 工具 | 用途 | 推荐度 |
|------|------|--------|
| **[github/git-sizer](https://github.com/github/git-sizer)** | 计算 Git 仓库各项体积指标，标记潜在问题 | ⭐⭐⭐⭐⭐ |
| **[git-repo-doctor](https://github.com/LaughingisLaughing/git-repo-doctor)** | 只读诊断，输出清理计划（安全） | ⭐⭐⭐⭐ |
| **[reposizer](https://www.npmjs.com/package/reposizer)** | 不克隆即可分析远程仓库大小 | ⭐⭐⭐ |
| **git count-objects -vH** | 内置命令，快速查看存储摘要 | ⭐⭐⭐⭐⭐ |

#### 预防工具

| 工具 | 用途 | 推荐度 |
|------|------|--------|
| **[pre-commit](https://pre-commit.com/) + check-added-large-files** | 提交前自动检测大文件 | ⭐⭐⭐⭐⭐ |
| **Git LFS** | 大文件存储，仓库只留指针 | ⭐⭐⭐⭐ |
| **Husky (Node.js)** | Git hooks 管理 | ⭐⭐⭐⭐ |

### 2.3 大厂实战案例

#### 案例一：Dropbox（2026-03）
- **问题**：87GB monorepo，clone 超过 1 小时
- **根因**：Git 的 delta 压缩启发式算法对 i18n 文件路径处理不当
- **方案**：与 GitHub 合作，服务端 aggressive repack（`--depth=250 --window=250`）
- **结果**：87GB → 20GB（77%），clone 从 1h 降到 15 分钟

> 来源：Dropbox Tech Blog 2026-03-25

#### 案例二：Grab（2025-09）
- **问题**：10 年 Go monorepo，12.7M commits，176GB blobs
- **方案**：自定义迁移脚本，保留 tag + 近期历史，清理旧 commit
- **结果**：commit 数减少 99.9%，存储减少 59%，Gitaly 复制延迟从分钟级降到毫秒级

> 来源：Grab Engineering Blog 2025-09-16

#### 案例三：阿里云 Springboot-Notebook（CSDN 实战）
- **问题**：683MB 仓库，全是 demo 代码
- **方案**：BFG 清理大文件 → git gc → `--orphan` 创建全新无历史分支
- **结果**：683MB → 6.33MB（99%）

> 来源：阿里云开发者社区 2023-04-11

#### 案例四：博客仓库 1.5GB 瘦身（知乎/个人博客 2026-06）
- **问题**：`.git` 1.1GB，工作区 370MB，二进制媒体反复提交
- **方案**：
  1. `git filter-repo --path-glob '*.mp4' --invert-paths` 清理历史
  2. PNG 转 WebP（70MB → 15MB）
  3. mp4 外链化（83MB 移出仓库）
  4. 配置 Git LFS 防复发
- **结果**：`.git` 1.1GB → 几十 MB
- **关键教训**：filter-repo 后必须手动 `reflog expire` + `repack -adf` + `prune`

> 来源：王若风的技术博客 2026-06-29

### 2.4 常见踩坑（知乎/CSDN 高频问题）

#### 坑 1：filter-repo 后 .git 反而变大
**原因**：filter-repo 写了新 pack，但旧 pack 未被清除
**解决**：
```bash
git reflog expire --expire=now --all
git repack -adf
git prune --expire=now
```

#### 坑 2：漏推 tag 导致 clone 仍然很大
**原因**：filter-repo 重写了本地 tag，但只 force push 了分支，远程旧 tag 仍指向含大文件的旧历史
**解决**：
```bash
git push origin --force --all
git push origin --force --tags  # 必须！
```
**验证**：真实 clone 一次，别信本地 `du`

#### 坑 3：团队成员未同步导致大文件回流
**原因**：有人 `git pull && git push` 把旧历史合并回来
**解决**：
- 改写历史前通知全员冻结推送
- 提供 `git reset --hard origin/main` 或重新 clone 方案
- 建议用 `--force-with-lease` 代替裸 `--force`

#### 坑 4：Gitee 配额限制（免费版 500MB）
**方案**：升级套餐 或 历史改写瘦身 + Git LFS
**Gitee 专用工具**：`git repo-clean`（Gitee 自研，中文界面）

### 2.5 大型开源项目策略

| 项目 | Monorepo 工具 | 体积管理策略 |
|------|---------------|-------------|
| **Google** | Piper（自研） | 20 亿行代码，自研构建系统 Bazel |
| **Facebook/Meta** | Sapling + Mercurial | 大文件用 Diffsnapper，自研工具链 |
| **React** | Yarn Workspaces | 不追踪 build 产物，严格 .gitignore |
| **Vue 3** | pnpm Workspaces | 硬链接节省磁盘，monorepo 管理 |
| **TypeScript** | Lerna + pnpm | 严格区分 src 和 build 产物 |
| **Angular** | Nx | 增量构建，受影响分析，远程缓存 |

> 来源：腾讯云开发者社区、SegmentFault、OSCHINA

---

## 3. 针对 khy-os 的体积管理方案

### 3.1 立即可做（P0 - 本周）

#### 3.1.1 自动清理脚本

创建 `scripts/maintenance/clean-workdir.sh`：

```bash
#!/bin/bash
# khy-os 工作目录清理脚本
# 用法: bash scripts/maintenance/clean-workdir.sh
# 注意: 项目已有 scripts/maintenance/clean.js（白名单制），本脚本是补充

set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "=== khy-os 工作目录清理 ==="

# 1. 清理 Flutter 构建产物（最大收益 ~3.4GB）
echo "  [1/9] 清理 Flutter build/ 和 .dart_tool/"
rm -rf "$REPO_ROOT/apps/khy-os-client-app/build/"
rm -rf "$REPO_ROOT/apps/khy-os-client-app/.dart_tool/"

# 2. 清理 Electron/Vite 构建产物（~1GB）
echo "  [2/9] 清理 dist/ 和 dist-electron/"
rm -rf "$REPO_ROOT/dist/"
rm -rf "$REPO_ROOT/dist-electron/"
rm -rf "$REPO_ROOT/apps/khyos-desktop/dist-electron/"

# 3. 清理 node_modules（可选，需 pnpm install 重建）
# echo "  [3/9] 清理 node_modules/"
# rm -rf "$REPO_ROOT/node_modules/"

# 4. 清理 tmp-* 临时文件（~16MB）
echo "  [4/9] 清理 tmp-* 临时文件"
find "$REPO_ROOT" -maxdepth 1 -name "tmp-*" -type f -delete 2>/dev/null || true

# 5. 清理 Android 构建残留（~10MB）
echo "  [5/9] 清理 classes*.dex 和 resources.arsc"
find "$REPO_ROOT" -maxdepth 1 -name "classes*.dex" -type f -delete 2>/dev/null || true
find "$REPO_ROOT" -maxdepth 1 -name "resources.arsc" -type f -delete 2>/dev/null || true

# 6. 清理 coverage 报告
echo "  [6/9] 清理 coverage/ 和 tmp-cov/"
rm -rf "$REPO_ROOT/coverage/"
rm -rf "$REPO_ROOT/tmp-cov/"

# 7. 清理临时日志
echo "  [7/9] 清理 *.log 临时日志"
find "$REPO_ROOT" -maxdepth 1 -name "*.log" -type f -delete 2>/dev/null || true

# 8. 清理 Python 缓存
echo "  [8/9] 清理 __pycache__"
find "$REPO_ROOT" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# 9. 清理 APK 历史版本（保留最新一个，~270MB）
echo "  [9/9] 清理 APK 历史版本（保留最新）"
cd "$REPO_ROOT/apps/khy-mobile/release/" 2>/dev/null && {
  ls -t *.apk 2>/dev/null | tail -n +2 | xargs rm -f 2>/dev/null || true
} || true

echo ""
echo "=== 清理完成 ==="
echo "预计释放: ~4.8 GB（不含 node_modules）"
echo "重建命令:"
echo "  Flutter:  cd apps/khy-os-client-app && flutter pub get"
echo "  前端:     corepack pnpm install --frozen-lockfile --filter khy-ai-frontend..."
echo "  后端:     corepack pnpm install --frozen-lockfile --filter khy-os-backend..."
echo "  全量:     corepack pnpm install --frozen-lockfile"
```

#### 3.1.2 补全 clean.js 的 Flutter 目录

项目已有 `scripts/maintenance/clean.js`（白名单制，默认干跑），但 **TARGETS 表漏了 Flutter 目录**——3.05 GB 的 `apps/khy-os-client-app/build/` 和 325 MB 的 `.dart_tool/` 都不在清理列表中。

需在 `clean.js` 的 `TARGETS` 数组中补充以下条目：

```javascript
// 在 TARGETS 数组中添加（位置：apps/khy-mobile/android/app/build 之后）
{
  rel: 'apps/khy-os-client-app/build',
  group: 'build',
  what: 'Flutter Android 构建缓存（3.05 GB：native libs、DEX、APK 中间产物）',
  rebuild: 'flutter build apk / flutter run（自动重建，首次 ~5 分钟）',
},
{
  rel: 'apps/khy-os-client-app/.dart_tool',
  group: 'build',
  what: 'Flutter/Dart 工具链缓存（325 MB：build_runner、hooks）',
  rebuild: 'flutter pub get（自动重建）',
},
{
  rel: 'dist-electron',
  group: 'build',
  what: 'Electron 构建输出（~320 MB）',
  rebuild: 'pnpm run electron:dev 或 electron-builder',
},
{
  rel: 'apps/khyos-desktop/dist-electron',
  group: 'build',
  what: '桌面端 Electron 构建输出',
  rebuild: 'pnpm run electron:dev',
},
```

补充后，`pnpm run clean:apply` 一条命令即可自动清理所有构建产物（含 Flutter）。

> **注意**：`clean.js` 的 `PROTECTED_SUBTREE` 已正确保护 `node_modules`、`.git`、源码等，新增条目安全。

#### 3.1.3 增强 .gitignore

在现有 `.gitignore` 基础上补充：

```gitignore
# === Flutter 构建产物（加强） ===
**/build/
.dart_tool/
.flutter-plugins
.flutter-plugins-dependencies
!pubspec.lock

# === Android 构建残留 ===
*.dex
resources.arsc

# === 临时文件和日志 ===
tmp-*
*.log
coverage/
.nyc_output/

# === IDE 文件（补充） ===
*.swp
*.swo
*.bak
*~

# === Python 缓存 ===
__pycache__/
*.pyc
*.pyo

# === Electron 构建 ===
dist/
dist-electron/
```

#### 3.1.4 安装 pre-commit 大文件防护

```bash
# 安装 pre-commit
pip install pre-commit

# 在项目根目录创建 .pre-commit-config.yaml
cat > .pre-commit-config.yaml << 'EOF'
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-added-large-files
        args: ['--maxkb=500']  # 500KB 阈值
      - id: trailing-whitespace
      - id: end-of-file-fixer
EOF

# 安装 hooks
pre-commit install
```

#### 3.1.5 安装 git-sizer

```bash
# 下载 git-sizer
# https://github.com/github/git-sizer/releases

# 运行诊断
git sizer --verbose
```

### 3.2 短期优化（P1 - 本月内）

#### 3.2.1 Git 性能优化

```bash
cd "D:\Portable\khy-os"

# 启用 commit-graph（加速 log/merge-base）
git config core.commitGraph true
git config gc.writeCommitGraph true

# 启用 fsmonitor（加速 git status，从 3s 降到 <200ms）
git config core.fsmonitor true
git config core.untrackedCache true

# 生成 commit-graph
git commit-graph write --reachable

# 启动后台维护（自动 gc、prefetch、commit-graph 更新）
git maintenance start

# 优化 pack 文件（可选，需时间，建议在空闲时运行）
git gc --aggressive
```

> 来源：GitFlow 2026 年 Monorepo Git 技术指南

#### 3.2.2 Sparse Checkout 配置

为团队成员提供按需检出：

```bash
# 全量克隆（只获取 commit 图，不下载 blob）
git clone --filter=blob:none --no-checkout <repo-url>
cd khy-os

# 按需检出（示例：只检出后端服务）
git sparse-checkout init --cone
git sparse-checkout set services docs scripts kernel
git checkout main

# 角色推荐路径：
# 后端开发者: services/ docs/ scripts/ kernel/ platform/
# 前端开发者: apps/ docs/ extensions/ electron/
# 全栈开发者: git sparse-checkout disable
```

> 来源：GitFlow、7Tech 2026 年 Monorepo 性能指南

#### 3.2.3 定期清理自动化

```bash
# Windows Task Scheduler（每周日凌晨 3 点自动清理）
schtasks /create /tn "khyos-cleanup" /tr "bash D:\Portable\khy-os\scripts\maintenance\clean-workdir.sh" /sc weekly /d SUN /st 03:00
```

### 3.3 中期改进（P2 - 季度内）

#### 3.3.1 Git LFS 迁移

```bash
# 安装 Git LFS
git lfs install

# 追踪大文件类型
git lfs track "*.psd"
git lfs track "*.mp4"
git lfs track "*.zip"
git lfs track "*.tar.gz"
git lfs track "*.so"
git lfs track "*.dll"

# 提交 .gitattributes
git add .gitattributes
git commit -m "chore: enable Git LFS for binary assets"
```

#### 3.3.2 CI/CD 体积门禁

```yaml
# .github/workflows/size-check.yml
name: Repository Size Check
on: [push, pull_request]
jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - name: Check tracked files size
        run: |
          SIZE=$(git ls-files | xargs wc -c | tail -1 | awk '{print $1}')
          echo "Tracked files size: $SIZE bytes"
          if [ "$SIZE" -gt 524288000 ]; then  # 500MB
            echo "⚠️ Warning: Repository tracked files exceed 500MB"
          fi
      - name: Check for large files in commit
        uses: actionsdesk/lfs-warning@v2.0
        with:
          filesizelimit: '5242880'  # 5MB
```

#### 3.3.3 多仓库拆分评估

当前 khy-os 是 monorepo，包含：
- `services/` - 后端（5,807 文件，最大）
- `docs/` - 文档（1,035 文件）
- `software/` - 软件资源（455 文件）
- `apps/` - 前端应用（413 文件）
- `scripts/` - 脚本（265 文件）
- `kernel/` - 内核模块（204 文件）
- `platform/` - 平台模块（168 文件）

**评估建议**：当前规模（8,593 追踪文件，0.7GB .git）仍在合理范围，暂不拆分。但建议：
- 保持 `services/` 和 `apps/` 独立构建
- 考虑将 `software/`（455 个资源文件）迁移到外部存储

### 3.4 长期监控（P3 - 持续）

#### 3.4.1 体积监控脚本

```bash
#!/bin/bash
# scripts/maintenance/size-report.sh
echo "=== khy-os 体积报告 ==="
echo "日期: $(date)"
echo ""

echo "=== 工作目录体积 ==="
du -sh "D:\Portable\khy-os" --exclude=.git
echo ""

echo "=== Git 仓库体积 ==="
git count-objects -vH
echo ""

echo "=== 追踪文件 Top 10 大小 ==="
git ls-files -z | xargs -0 ls -lS 2>/dev/null | head -10
echo ""

echo "=== 未追踪文件体积 (Top 10) ==="
git ls-files --others --exclude-standard -z | xargs -0 ls -lS 2>/dev/null | head -10
echo ""

echo "=== 历史中最大对象 Top 10 ==="
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '/^blob/ {print $2, $3}' \
  | sort -rn | head -10
```

#### 3.4.2 团队规范（CONTRIBUTING.md）

```markdown
## 体积管理规范

### 禁止提交的文件
- `build/`、`dist/`、`dist-electron/` 目录
- `node_modules/` 目录
- `tmp-*` 临时文件
- `*.log` 日志文件
- `*.dex`、`resources.arsc` Android 构建产物
- `coverage/` 测试覆盖率报告
- Flutter `.dart_tool/` 目录

### 大文件处理
- 超过 500KB 的二进制文件使用 Git LFS
- 超过 10MB 的文件需团队评审

### 定期清理
- 每周运行 `pnpm run clean:apply`（或 `bash scripts/maintenance/clean-workdir.sh`）
- 每月运行 `git gc --aggressive`

### 按需安装依赖（统一 pnpm）
- 后端开发: `corepack pnpm install --frozen-lockfile --filter khy-os-backend... --filter khy-ai-backend... --filter @khy/shared...`
- 前端开发: `corepack pnpm install --frozen-lockfile --filter khy-ai-frontend... --filter quant-trading-frontend...`
- 全量开发: `corepack pnpm install --frozen-lockfile`
- 服务器部署: `corepack pnpm install --prod --filter khy-os-backend... --frozen-lockfile`

### 提交前检查
- 运行 `pre-commit run --all-files` 检查
- 确认无大文件进入暂存区
```

---

## 4. 实施路线图

```
Week 1 (P0):
  - 补全 clean.js 的 Flutter 目录 + 增强 .gitignore
  - 安装 pre-commit + check-added-large-files
  - 安装 git-sizer 运行诊断

Week 2 (P1):
  - Git 性能优化 (commit-graph, fsmonitor, maintenance)
  - Git pack 压缩优化 (compression=0→6, repack)
  - 配置 Sparse Checkout 文档
  - 团队培训：pnpm install profiles 按需安装

Week 3 (P1):
  - 团队培训：体积管理规范
  - 体积监控脚本部署
  - 历史幽灵文件清理（filter-repo / BFG）

Week 4 (P2):
  - CI 体积门禁上线
  - 评估 Git LFS 迁移

Month 2+:
  - 评估多仓库拆分（如需要）
  - 持续监控和优化
```

---

## 5. 预期收益

### 5.1 全量清理（含构建产物）

| 指标 | 当前 | 优化后 | 改善 |
|------|------|--------|------|
| 工作目录大小 | 7.99 GB | **~1.5 GB** | **-81%** |
| `git status` 速度 | 慢 | **< 200ms** | **10x+** |
| 全量克隆时间 | 较长 | **< 5 分钟**（sparse） | **-80%** |
| 大文件误提交 | 无防护 | **pre-commit 自动拦截** | 从 0 到 1 |

### 5.2 按需裁剪（不破坏开发 + 可正常构建）

| 清理项 | 大小 | 影响开发？ | 影响构建？ | 恢复方式 |
|--------|------|----------|----------|---------|
| 删 Flutter `build/` | **3,050 MB** | ❌ 不影响 | ❌ 不影响（重建 ~5min） | `flutter build` |
| 删 Flutter `.dart_tool/` | **325 MB** | ❌ 不影响 | ❌ 不影响 | `flutter pub get` |
| 删 `dist/` + `dist-electron/` | **970 MB** | ❌ 不影响 | ❌ 不影响 | `pnpm run build` |
| 删 `electron@32.3.3` + `app-builder-bin` | **473 MB** | ❌ 不影响 | ⚠️ 不能打包 Electron | `pnpm install` |
| 删 APK 历史版本 | **270 MB** | ❌ 不影响 | ❌ 不影响 | 保留最新版 |
| 删 tmp-*/coverage/缓存 | **~50 MB** | ❌ 不影响 | ❌ 不影响 | 自动重建 |
| **合计** | **~5.1 GB** | | | |
| **优化后工作目录** | **~2.9 GB** | | | |

### 5.3 node_modules 按场景裁剪

| 开发场景 | node_modules 体积 | 节省 |
|---------|-------------------|------|
| 全量（当前） | 1,640 MB | — |
| 后端 + 前端（推荐） | ~700 MB | ~940 MB |
| 仅后端 | ~400 MB | ~1.2 GB |
| 仅前端 | ~300 MB | ~1.3 GB |

---

## 6. 不清理构建产物的优化方案

> 本节聚焦于**不删除 build/、node_modules/、dist/ 等构建产物**的前提下，从 Git 历史、配置、非构建文件等角度进一步缩小仓库体积。

### 6.1 Git 历史幽灵文件分析

> 基于 `git verify-pack` 实测数据

**发现：`.git` 中存在大量已删除但仍占空间的历史大文件**

| 大小 | 文件类型 | 识别方式 | 对应历史文件 |
|------|----------|----------|-------------|
| **177.7 MB** | Windows PE (MZ头) | `cat-file -p` 首字节 | `tools/khyos-markdown/KhyosMarkdown.exe` |
| **103.9 MB** | Git Bundle | `# v2 git bundle` 头 | 某次备份 bundle |
| **37.0 MB** | ZIP/JAR (PK头) | `cat-file -p` 首字节 | `alpine-rootfs.tar.gz` / `proot-static.zip` |
| **29.6 MB** | 未知大文件 | verify-pack | 历史中的大对象 |
| **19.3 MB** | 未知大文件 | verify-pack | 历史中的大对象 |
| **15.97 MB** | ZIP (PK头) | 第二个 pack | `sample-linear.zip` |
| **13.63 MB** | ZIP (PK头) | 第二个 pack | 历史 ZIP |
| **12.28 MB** | ZIP (PK头) | 第二个 pack | 历史 ZIP |

**总计：~410 MB 的幽灵文件** 占据 `.git/objects/pack/` 空间，但这些文件在当前工作目录中已不存在。

**已确认的历史删除文件**（来自 `git log --diff-filter=D`）：
- `apps/khy-mobile/android/app/src/main/assets/alpine-rootfs.tar.gz`
- `apps/khy-mobile/android/app/src/main/jniLibs/arm64-v8a/libproot.so`
- `apps/khy-mobile/linux-bin/alpine-minirootfs.tar.gz`
- `apps/khy-mobile/linux-bin/proot-static.apk`
- `apps/khy-mobile/linux-bin/proot-static.zip`
- `tools/khyos-markdown/KhyosMarkdown.exe`
- `services/ai-backend/test/fixtures/coze/sample-linear.zip`

### 6.2 Git 配置优化（立即可做）

#### 6.2.1 启用压缩（当前为 0！）

```bash
cd "D:\Portable\khy-os"

# 当前状态：pack.compression=0（无压缩！）
# 启用 zlib 压缩，推荐级别 6（平衡速度和压缩率）
git config pack.compression 6

# 对 delta 对象启用更大的缓存（Git 2.46+ 支持）
# 低版本 Git 可跳过此步
git config gc.deltaBaseCache 256m

# 重新打包（合并两个 pack 文件 + 压缩）
git reflog expire --expire=now --all
git repack -adf
git prune --expire=now
```

> **预期效果**：`pack.compression=0` → `6` 可将 619MB pack 压缩至 ~300-400MB（节省 30-50%）

#### 6.2.2 启用 Git 性能优化

```bash
# commit-graph：加速 log/merge-base（从 O(n) 降到 O(1)）
git config core.commitGraph true
git config gc.writeCommitGraph true
git commit-graph write --reachable

# fsmonitor：加速 git status（Windows 上从 3-5s 降到 <200ms）
git config core.fsmonitor true
git config core.untrackedCache true

# 启动后台维护（自动 gc、prefetch、commit-graph 更新）
git maintenance start
```

#### 6.2.3 合并双 Pack 文件

当前存在两个 pack 文件（619MB + 97MB），合并可减少索引开销：

```bash
# 合并所有 pack 为一个（需在 repack 时指定 -a）
git repack -a -d --depth=250 --window=250
```

> 来源：Dropbox 实践，`--depth=250 --window=250` 可显著改善 delta 压缩

### 6.3 历史大文件清理（保留构建产物）

> **目标**：只清理已删除的历史幽灵文件，不触碰当前构建产物

#### 方案 A：git-filter-repo 清理（推荐）

> ⚠️ **重要**：`git filter-repo` 每次运行都是**全量重写历史**，多次调用是**错误的**——
> 第二次调用基于第一次已重写的历史，会导致不可预期的结果。
> **必须将所有过滤规则合并为一次调用。**

```bash
# 安装 git-filter-repo
pip install git-filter-repo

# 合并所有清理规则为一次调用
# 注意：--path 精确路径匹配；--path-glob 通配符匹配
git filter-repo --path apps/khy-mobile/linux-bin/ --invert-paths \
                --path tools/khyos-markdown/KhyosMarkdown.exe --invert-paths \
                --path services/ai-backend/test/fixtures/coze/sample-linear.zip --invert-paths \
                --path apps/khy-mobile/android/app/src/main/assets/ --invert-paths \
                --path-glob '*.exe' --invert-paths

# 清理后必须执行（防止 .git 反而变大）
git reflog expire --expire=now --all
git repack -adf
git prune --expire=now

# 验证：重新检查 pack 大小
git count-objects -vH
```

> **关于 104MB 的 git bundle 幽灵文件**：该 blob（hash `01bd80a4`）无法通过路径定位
> （`git log --find-object` 无结果，说明它可能是孤立的或路径未知）。
> 需要用 BFG 的 `--strip-blobs-bigger-than` 按大小清理（见方案 B），
> 或运行 `git verify-pack` 进一步定位其路径。

#### 方案 B：BFG Repo-Cleaner（更快，适合大仓库）

```bash
# 下载 BFG
# https://github.com/rtyley/bfg-repo-cleaner/releases

# 清理 >10MB 的文件（保留当前构建产物）
# 注意：BFG 接受仓库根目录，不是 .git 目录
java -jar bfg.jar --strip-blobs-bigger-than 10M D:\Portable\khy-os

# 或按文件类型清理（逐个执行）
java -jar bfg.jar --delete-files "*.exe" D:\Portable\khy-os
java -jar bfg.jar --delete-files "*.bundle" D:\Portable\khy-os
java -jar bfg.jar --delete-files "*.zip" D:\Portable\khy-os

# 清理后
git reflog expire --expire=now --all
git gc --aggressive
```

#### 方案 C：仅 repack 优化（最安全，不改历史）

```bash
# 不删除任何历史，只优化存储
git reflog expire --expire=now --all
git repack -a -d -f
git gc --aggressive --prune=now
```

> **预期效果**：方案 A/B 可节省 ~400MB；方案 C 可节省 ~100-200MB（仅压缩优化）

### 6.4 非构建产物的工作目录优化

#### 6.4.1 APK 文件管理（~300MB）

当前 `apps/khy-mobile/release/` 目录有 **10+ 个 APK 文件**（每个 23-35MB），总计 ~300MB。

**验证结果**：APK 文件**未被 git 追踪，也未被 .gitignore 忽略**——即 untracked 状态。
它们占磁盘空间但不影响仓库体积，清理它们不影响 git 历史。

**建议**：
1. 将 APK 模式添加到 `.gitignore`（防止误提交）
2. 保留最新版本，删除历史版本（磁盘清理，不影响 git）
3. 或迁移到外部存储（网盘/CDN）

```gitignore
# 在 .gitignore 中添加（防止 APK 误提交）
apps/khy-mobile/release/*.apk
```

```bash
# 磁盘清理（不影响 git，仅释放磁盘空间）
# 保留最新 1 个 APK，删除历史版本
cd apps/khy-mobile/release/
ls -t *.apk | tail -n +2 | xargs rm -f
```

#### 6.4.2 sessions.db 清理（26MB）

`.khy/sessions.db` 是会话数据库（26MB），虽已被 `.gitignore` 忽略，但可定期清理：

```bash
# 清理旧会话（保留最近 7 天）
# 需要项目提供清理脚本或手动删除
```

#### 6.4.3 Flutter 运行时文件（非构建产物）

以下文件是 Flutter 运行时依赖，**不是构建产物**，不应删除：
- `assets/flutter_assets/kernel_blob.bin`（66MB）- Dart VM 内核
- `lib/x86_64/libflutter.so`（38MB）- Flutter 引擎
- `lib/arm64-v8a/libflutter.so`（37MB）- ARM64 引擎

这些是调试/开发时需要的运行时文件，如果不需要本地运行 Flutter 可以删除。

### 6.5 Flutter 构建缓存精细分析

> 基于实测：`apps/khy-os-client-app/build/` = 3,050 MB，`.dart_tool/` = 325 MB

#### 6.5.1 build/ 目录 — **全部可删，100% 可重建**

| 子目录 | 大小 | 是什么 | 开发要吗 | 怎么重建 |
|--------|------|--------|---------|---------|
| `intermediates/merged_native_libs/` | **1,815 MB** | 4 种 CPU 架构的 .so 合并文件 | ❌ | `flutter build` 自动 |
| `intermediates/stripped_native_libs/` | 181 MB | 裁剪后的 .so | ❌ | 同上 |
| `intermediates/intermediary_bundle/` | 134 MB | JS bundle 中间产物 | ❌ | 同上 |
| `intermediates/flutter/` | 105 MB | Flutter 编译缓存 | ❌ | 同上 |
| `intermediates/assets/` | 83 MB | 合并的 assets | ❌ | 同上 |
| `intermediates/native_symbol_tables/` | 69 MB | 原生调试符号 | ❌ | 同上 |
| `intermediates/module_bundle/` | 58 MB | JS module bundle | ❌ | 同上 |
| `intermediates/compressed_assets/` | 28 MB | 压缩后的 assets | ❌ | 同上 |
| `intermediates/merged_jni_libs/` | 25 MB | JNI 库 | ❌ | 同上 |
| `intermediates/dex/` | 10 MB | 编译后的 DEX | ❌ | 同上 |
| `intermediates/其他` | ~30 MB | Gradle 杂项缓存 | ❌ | 同上 |
| `outputs/flutter-apk/` | 213 MB | APK 输出（debug 156MB + release 57MB） | ❌ | `flutter build apk` |
| `outputs/apk/` | 213 MB | **完全重复**的 APK（与 flutter-apk 相同） | ❌ | 同上 |
| `outputs/bundle/` | 54 MB | AAB 输出 | ❌ | `flutter build appbundle` |
| `outputs/native-debug-symbols/` | 26 MB | 原生调试符号 | ❌ | 同上 |
| `outputs/mapping/` | 9 MB | R8/ProGuard 映射 | ❌ | 同上 |
| `test_cache/` | 97 MB | 测试构建缓存 | ❌ | `flutter test` |
| `generated/` | 25 MB | 代码生成输出 | ❌ | `flutter pub run build_runner build` |

> **结论：build/ 全部 3,050 MB 是 Gradle/Flutter 缓存。删了之后 `flutter run` / `flutter build` 会自动从源码重建，只是第一次慢 ~5 分钟。日常开发完全不需要它。**

#### 6.5.2 .dart_tool/ 目录 — **全部可删，100% 可重建**

| 子目录 | 大小 | 是什么 | 开发要吗 | 怎么重建 |
|--------|------|--------|---------|---------|
| `flutter_build/` | 250 MB | build_runner 缓存 | ❌ | `flutter pub get` |
| `hooks_runner/` | 75 MB | hooks 缓存 | ❌ | 同上 |
| `package_config.json` | 29 KB | 包解析配置 | ❌ | `flutter pub get` |

> **结论：.dart_tool/ 全部 325 MB 是工具链缓存。删了之后 `flutter pub get` 会重建。**

#### 6.5.3 安全清理命令

```bash
# 清理 Flutter 构建缓存（不影响开发，下次 build 自动重建）
cd apps/khy-os-client-app
rm -rf build/ .dart_tool/

# 重建命令（需要时执行）
flutter pub get          # 重建 .dart_tool/
flutter run              # 重建 build/（debug 模式）
flutter build apk        # 重建 build/（release 模式）
```

### 6.6 node_modules 裁剪策略（统一 pnpm 管理）

> 项目使用 **pnpm workspace**，`.pnpm/` 是虚拟存储（所有包的真实文件在此），其他目录是符号链接。

#### 6.6.1 项目已有的 install profiles

项目 `package.json` 已定义按需安装配置，**无需全量安装 1.64 GB**：

| Profile | 命令 | 安装范围 | 预计大小 | 适用场景 |
|---------|------|---------|---------|---------|
| `install:prod` | `pnpm install --prod --filter khy-os-backend... --frozen-lockfile` | 仅后端运行时依赖 | ~200 MB | 自建服务器部署 |
| `install:core` | `pnpm install --frozen-lockfile --filter khy-os-backend... --filter khy-ai-backend... --filter @khy/shared...` | 后端 + AI 后端 + 共享包 | ~400 MB | 后端日常开发 |
| `install:frontend` | `pnpm install --frozen-lockfile --filter khy-ai-frontend... --filter quant-trading-frontend...` | 前端工作区 | ~300 MB | 前端日常开发 |
| `install:mobile` | `pnpm install --frozen-lockfile --filter @khy-os/mobile-companion...` | 移动端伴侣 | ~100 MB | 移动端开发 |
| `install:all` | `pnpm install --frozen-lockfile` | 全部（当前状态） | 1,640 MB | 全量构建 / Electron 打包 |

> **注意**：以上命令需通过 `corepack` 调用，即 `corepack pnpm install --frozen-lockfile --filter ...`

#### 6.6.2 node_modules 中的大包分析

| 包 | 大小 | 开发需要？ | 可删条件 |
|----|------|----------|---------|
| `electron@44.2.0` | 369 MB | ✅ 跑桌面端 dev 模式要用 | 如果不跑桌面端可删 |
| `electron@32.3.3` | 266 MB | ❌ 仅 `electron-builder` 打包用 | **不打包可删** |
| `app-builder-bin` | 207 MB | ❌ 仅 `electron-builder` 打包用 | **不打包可删** |
| `node-pty` | 65 MB | ✅ 终端功能要用 | 不可删 |
| `element-plus` | 41 MB | ✅ 前端 UI 框架 | 不可删 |
| `lucide-react × 2` | 66 MB | ✅ React 图标库 | pnpm 会去重 |
| `typescript × 2` | 46 MB | ✅ 类型检查 | pnpm 会去重 |
| `@esbuild/win32-x64 × 2` | 20 MB | ✅ 前端构建 | pnpm 会去重 |
| `better-sqlite3` | 10 MB | ✅ SQLite 数据库 | 不可删 |
| `prettier` | 9 MB | ⚠️ 格式化工具 | 不用 prettier 可删 |

#### 6.6.3 按开发场景的裁剪方案

**场景一：只开发后端（最大节省）**
```bash
# 先删全量 node_modules
rm -rf node_modules/
# 只装后端 + AI 后端 + 共享包
corepack pnpm install --frozen-lockfile --filter khy-os-backend... --filter khy-ai-backend... --filter @khy/shared...
# 结果：1,640 MB → ~400 MB（节省 ~1.2 GB）
```

**场景二：只开发前端**
```bash
rm -rf node_modules/
corepack pnpm install --frozen-lockfile --filter khy-ai-frontend... --filter quant-trading-frontend...
# 结果：1,640 MB → ~300 MB（节省 ~1.3 GB）
```

**场景三：后端 + 前端都开发**
```bash
rm -rf node_modules/
corepack pnpm install --frozen-lockfile \
  --filter khy-os-backend... --filter khy-ai-backend... --filter @khy/shared... \
  --filter khy-ai-frontend... --filter quant-trading-frontend...
# 结果：1,640 MB → ~700 MB（节省 ~940 MB）
```

**场景四：全量开发但不打包 Electron（日常推荐）**
```bash
# 保留全量 node_modules，只删打包专用的大包
rm -rf node_modules/.pnpm/electron@32.3.3*
rm -rf node_modules/.pnpm/app-builder-bin*
# 结果：1,640 MB → ~1,170 MB（节省 ~470 MB）
# 需要打包时再 corepack pnpm install --frozen-lockfile 补回
```

> **风险提示**：手动删 `.pnpm/` 中的包可能破坏 pnpm 的一致性。更安全的做法是使用 install profiles（场景一~三），或编辑 `package.json` 的 devDependencies 临时移除 electron-builder，然后 `pnpm install`。

### 6.7 .gitignore 增强（防复发）

> ⚠️ **注意**：以下规则针对仓库根目录，不会影响 `node_modules/`（已被全局忽略）
> 和 `build/`、`dist/` 等已忽略的目录中的子文件。

```gitignore
# === 历史大文件类型防护（精确匹配，避免误伤合法文件） ===
# 仅匹配根目录和特定子目录，不匹配 build/node_modules 内
/tools/**/*.exe
*.bundle
apps/khy-mobile/release/*.apk

# === 压缩包防护（精确匹配项目已知的大压缩包） ===
# 不全局禁止 *.zip，而是针对性禁止已知的历史大文件路径
apps/khy-mobile/linux-bin/*.zip
apps/khy-mobile/linux-bin/*.tar.gz
apps/khy-mobile/linux-bin/*.apk
apps/khy-mobile/android/app/src/main/assets/*.tar.gz

# === Git LFS 配合（可选） ===
# 如果使用 Git LFS，取消以下注释
# *.psd filter=lfs diff=lfs merge=lfs -text
# *.mp4 filter=lfs diff=lfs merge=lfs -text
```

> **审核要点**：
> - ❌ **不要全局禁止 `*.bin`** — Flutter 的 `kernel_blob.bin`（66MB）是合法运行时文件
> - ❌ **不要全局禁止 `*.so`** — `lib/x86_64/libflutter.so` 等是合法依赖
> - ❌ **不要全局禁止 `*.zip`** — node_modules 中可能有合法的 .zip 依赖
> - ✅ 用**路径前缀**精确匹配已知的历史大文件位置

### 6.8 pre-commit 大文件防护

> ⚠️ **审核要点**：pre-commit-hooks 中没有 `forbidden-files` 这个 hook ID。
> 需要自定义一个本地脚本来实现禁止特定文件类型的功能。

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-added-large-files
        args: ['--maxkb=500']  # 500KB 阈值
      - id: trailing-whitespace
      - id: end-of-file-fixer

  # 自定义本地 hook：禁止提交特定二进制文件
  - repo: local
    hooks:
      - id: forbid-binary-files
        name: "禁止提交二进制文件"
        entry: bash -c 'for f in "$@"; do case "$f" in *.exe|*.dll|*.so|*.bundle) echo "❌ 禁止提交二进制文件: $f"; exit 1;; esac; done'
        language: system
        types: [text, binary]
        args: []
        pass_filenames: true
        fail_msg: "请使用 Git LFS 或外部存储，不要直接提交二进制文件"
```

> **替代方案**（更简洁）：只依赖 `check-added-large-files` 的 500KB 阈值即可拦截大部分大文件，无需额外的文件类型检查。

### 6.9 预期收益（不清理构建产物 vs 按需裁剪）

| 优化项 | 当前 | 优化后 | 节省 | 说明 |
|--------|------|--------|------|------|
| Git pack 压缩（0→6） | 716 MB | ~400 MB | **~300 MB** | `pack.compression=0` 是无压缩 |
| 历史幽灵文件清理 | - | - | **~400 MB** | filter-repo / BFG 移除已删除的大 blob |
| 双 pack 合并 | 2 个文件 | 1 个文件 | 索引开销减少 | 合并 pack 文件 |
| **Git 仓库总计** | 716 MB | ~216 MB | **~500 MB** | pack 压缩 + 历史清理 |

> 以下为工作目录优化（不影响 git 历史）：

| 优化项 | 当前 | 优化后 | 节省 | 影响开发/构建 |
|--------|------|--------|------|-------------|
| Flutter build/ | 3,050 MB | 0 | **3,050 MB** | ❌ 不影响（`flutter build` 重建） |
| Flutter .dart_tool/ | 325 MB | 0 | **325 MB** | ❌ 不影响（`flutter pub get` 重建） |
| dist/ + dist-electron/ | 970 MB | 0 | **970 MB** | ❌ 不影响（`pnpm run build` 重建） |
| Electron 打包专用包 | 473 MB | 0 | **473 MB** | ⚠️ 不能打包（`pnpm install` 补回） |
| APK 历史版本 | 300 MB | 30 MB | **270 MB** | ❌ 不影响（保留最新版） |
| node_modules 裁剪（后端+前端） | 1,640 MB | 700 MB | **940 MB** | ❌ 不影响（按需 install） |
| **工作目录总计** | 7.99 GB | ~2.0 GB | **~6.0 GB** | |

> **关键区分**：
> - **Git 仓库瘦身**（pack 压缩 + 历史清理）= 不影响工作目录，仅缩小 `.git/`
> - **构建缓存清理**（build/.dart_tool/dist）= 不影响 git 历史，删了能重建
> - **node_modules 裁剪** = 按 install profiles 按需安装，日常开发不受影响
> - 三者可独立执行，互不冲突

---

## 7. 参考资源

### GitHub/GitLab 官方（第 7 节参考）
- [github/git-sizer](https://github.com/github/git-sizer) - 仓库体积诊断
- [git-filter-repo](https://github.com/newren/git-filter-repo) - 历史重写（Git 官方推荐）
- [BFG Repo-Cleaner](https://github.com/rtyley/bfg-repo-cleaner) - 快速清理大文件
- [pre-commit-hooks](https://github.com/pre-commit/pre-commit-hooks) - check-added-large-files
- [GitLab: Reduce repository size](https://docs.gitlab.com/17.9/topics/git/repository/)

### Gitee/中文社区
- [Gitee: 仓库体积过大，如何减小](https://help.gitee.com/questions/仓库体积过大，如何减小)
- [Gitee: git repo-clean 工具](https://gitee.com/oschina/git-repo-clean)
- [CSDN: git-filter-repo 历史重写工具介绍](https://blog.csdn.net/weixin_42849849/article/details/157615922)
- [CSDN: Git LFS + Submodule + Repo 工具最佳实践](https://blog.csdn.net/qq_42104026/article/details/159918030)
- [知乎: 博客仓库 1.5GB 体检报告](https://wangruofeng007.com/blog/2026-06/tech-blog-repo-diet/)
- [知乎: git-filter-repo 把 .git 从 112MB 砍到 1.4MB](https://wangruofeng007.com/blog/2026-07/git-history-slim-filter-repo/)
- [CSDN: 从 Git 历史里彻底删掉大文件](https://zikunblog.pages.dev/tech/git-filter-repo-remove-large-files/)
- [腾讯云: Git 仓库瘦身与 LFS](https://developer.cloud.tencent.cn/article/2348067)
- [阿里云: 600M 瘦身到 6M](https://developer.aliyun.com/article/1191172)
- [技术栈: Git 仓库减肥指南](https://jishuzhan.net/article/1967484431943909377)

### 大厂实践
- [Dropbox: Reducing monorepo from 87GB to 20GB](https://dropbox.tech/infrastructure/reducing-our-monorepo-size-to-improve-developer-velocity)
- [Grab: Taming the monorepo beast](https://engineering.grab.com/taming-monorepo-beast)
- [InfoQ: Dropbox 与 GitHub 合作优化](https://www.infoq.com/news/2026/04/dropbox-reduces-git-optimization/)

### Monorepo 策略
- [Monorepo 单体仓库开发策略与实践指南](https://cloud.tencent.com/developer/article/2435025)
- [Monorepo 架构实践——项目管理策略](https://cloud.tencent.com.cn/developer/article/2636330)
- [Monorepo 在网易的工程改造实践](https://openharmonycrossplatform.csdn.net/6940ba5696fa167eeece27ca.html)

### 最佳实践指南
- [GitFlow: Monorepo Git techniques (2026)](https://www.gitflow.dev/blog/monorepo-git-techniques)
- [7Tech: Git Monorepo Performance in 2026](https://www.7tech.co.in/git-monorepo-performance-2026-partial-clone-sparse-checkout-maintenance/)
- [Scaling Git: Complete Guide 2026](https://mdsanwarhossain.me/blog-git-monorepo-lfs-submodules-sparse-checkout.html)
- [High Performance Git: Chapter 16](https://gitperf.com/chapter-16.html)
- [DeployHQ: Remove Large Files from Git History](https://www.deployhq.com/git/removing-large-files-from-git-history)
