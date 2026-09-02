# [DESIGN-SIZE-001] khy-os 体积优化方案

> **状态**: Draft  
> **日期**: 2026-08-28  
> **目标**: 从 ~1.25 GB 开发盘占 → 分发 bundle < 15 MB，开发环境 < 500 MB  
> **策略**: 删除可弃物 + 用更小依赖替代重型库 + 架构级懒加载  

---

## 一、现状诊断

### 1.1 体积构成（开发机全量）

| 来源 | 大小 | 是否进 git | 可操作 |
|------|------|-----------|--------|
| `.git/objects` | 326 MB | ✅ | `git gc` 可压缩 |
| node_modules（根 + workspace） | ~370 MB | ❌ gitignore | 可删重装 / 瘦依赖 |
| `apps/khy-mobile/` 构建产物 | 217 MB（其中 build/ 118 MB） | ❌ | 可删，随时重建 |
| `apps/ai-frontend/` | 105 MB（其中 .ignored/ 75 MB） | ❌ | 可清理 |
| `khy-Trajectory/` 运行时数据 | 81 MB | ❌ | 可删，运行时重建 |
| `.khy/` 运行时数据 | 81 MB | ❌ | 可删，运行时重建 |
| `services/` | 51 MB | 混合 | 部分可清理 |
| `docs/` | 28 MB | 混合 | 部分可精简 |
| `packaging/npm/bundle.mjs` | 17 MB | ❌ | 可删，发布时重建 |
| `extensions/tools/khy-markdown/` | 13 MB | 混合 | 可优化 |
| 源码本身（.js/.vue/.md/.py） | ~50 MB | ✅ | 不可压缩 |

**总计**: ~1,250 MB 开发盘占。git 跟踪源码仅 ~50 MB。

### 1.2 分发体积（用户实际下载）

| 产物 | 大小 | 说明 |
|------|------|------|
| `khy` bundle (--prod) | **13.12 MB** | 完整平台（6 模块之一，已 externalize express/pg/sequelize/ws 等） |
| `khy-gateway` bundle | **10.67 MB** | 网关（仅 bundled 业务逻辑） |
| `khy-tools` bundle | **11.90 MB** | 开发者工具 |
| `khy-server` bundle | **11.62 MB** | Web 管理后台 |
| gzip 后全平台 | ~3.2 MB | 实际网络传输（~75% 压缩率） |
| node_modules（运行时） | ~80 MB | npm install 拉入的外部依赖（开发盘占，不进 bundle） |

**核心问题已解决**: 从单一 16.7 MB 进化为 6 个独立模块，full platform 降至 13.12 MB（-21.5%）。用户可按需加载单个模块（gateway 仅 10.67 MB）。外部依赖在运行时通过 npm install 提供，不进 bundle。

---

## 二、三层优化策略

```
┌─────────────────────────────────────────────────────┐
│  第一层：删除（零代码风险，立刻省 ~370 MB）            │
│  构建产物 + 运行时数据 + 重复缓存                      │
├─────────────────────────────────────────────────────┤
│  第二层：替代（改依赖配置，省 ~50 MB bundle）          │
│  用更小库替换重型依赖 + 清理僵尸依赖                   │
├─────────────────────────────────────────────────────┤
│  第三层：架构（改源码结构，省 ~10 MB bundle + 更快）   │
│  懒加载 + 三档分发 + 模块拆分                         │
└─────────────────────────────────────────────────────┘
```

---

## 三、第一层：删除可弃物（零代码改动）

### 3.1 构建产物清理

| 操作 | 路径 | 省多少 | 恢复方式 |
|------|------|--------|----------|
| Android clean | `apps/khy-mobile/android/` | -123 MB | `./gradlew assembleDebug` |
| 删除 bundle.mjs | `packaging/npm/bundled/` | -17 MB | `npm run prepack` 自动重建 |
| 删除 .ignored/ | `apps/ai-frontend/node_modules/.ignored/` | -75 MB | 前端重装时自动清理 |
| 删除 public/vendor/ | `apps/ai-frontend/public/vendor/` | -11 MB | `npm run predev` 同步 |

### 3.2 运行时数据清理

| 操作 | 路径 | 省多少 | 恢复方式 |
|------|------|--------|----------|
| 清理 khy-Trajectory/ | 删除 logs/ + 旧 checkpoints | -81 MB | 运行时自动重建 |
| 清理 .khy/ | 删除 logs/ + audit/ | -76 MB | 运行时自动重建 |

**注意**: `.khy/` 和 `khy-Trajectory/` 内容镜像，建议确认是否为迁移残留。若确认重复，可全删一个。

### 3.3 参考文件清理

| 操作 | 路径 | 省多少 |
|------|------|--------|
| 删除测试视频 | `docs/_ref/*/测试视频.mp4` | -12 MB |

### 3.4 git 历史压缩

```bash
git gc --aggressive --prune=now
# 预期从 326 MB → ~200 MB
```

---

## 四、第二层：依赖替代（改配置，不改核心逻辑）

### 4.1 终端 TUI 框架：Ink(React) → 外部化

**现状**: `ink` (v6.8) + `react` (v19.2) 打包进主 bundle，占 ~18 MB。
实际上只有 TUI 交互模式需要它们，服务端模式完全不需要。

**方案**: esbuild bundle 时把 ink/react 标记为 external：

```js
// packaging/npm/build/esbuild-modules.js
// 当前（全打入 bundle）:
//   build({ entryPoints: ['src/cli/khy.js'], bundle: true, ... })

// 改为分档打包:
build({
  entryPoints: ['src/cli/khy.js'],
  bundle: true,
  external: ['ink', 'react', 'react-dom', 'react-reconciler'],
  // ink 留在 node_modules，不进入 bundle.mjs
});
```

**效果**: `bundle.mjs` 从 16.7 MB → ~12 MB。终端用户仍然 require 到本地 node_modules 的 ink，行为不变。

**备选（长期）**: 逐步替换 `cli/tui/ink-components/` 下的组件为原生实现。优先级：
1. `PromptFrame`（输入框）→ 原生 readline + 光标控制
2. `StreamingBlock`（流式输出）→ ansi-escapes + 直接 stdout
3. `CompletionMenu`（自动补全菜单）→ 原生列表渲染

每替换一个组件，bundle 减少对应 react 组件树的体积。

### 4.2 日志框架：winston → pino

**现状**: `winston` (3.19.0) + `winston-daily-rotate-file` (5.0.0)，合计 ~2.5 MB。

**引用点**:
- `services/backend/src/services/` — 多处 logger 实例
- `platform/packages/shared/src/utils/logger.js` — 共享 logger
- `services/ai-backend/` — 间接使用

**方案**: 不急着全量替换，先在 `@khy/shared` 的 logger 层做适配：

```js
// src/utils/logger.js — 现有接口不变，底层切换
// 当前:
//   const winston = require('winston');
//   const DailyRotateFile = require('winston-daily-rotate-file');

// 改为:
//   const pino = require('pino');
//   const pinoDaily = require('pino-daily-rotate-file');
//   包装成兼容 winston 的 transport 接口
```

**效果**: 运行时 -2 MB + 日志写入速度提升 ~100x。

### 4.3 颜色库：chalk → picocolors

**现状**: `chalk` (4.1.2) 在 backend、ai-backend、shared 三处声明。依赖链 supports-color → has-flag → [...] 拉入 ~10 个小包。

**方案**: 全局替换：

```bash
# 1. 安装替代
pnpm add picocolors -D
# 2. 搜索所有使用点
grep -rl "require('chalk')" services/ src/ --include="*.js"
# 3. 批量替换 require('chalk') → require('picocolors')
# 4. API 差异: chalk.red(text) → picocolors.red(text)  (兼容)
#                chalk.bold.cyan(text) → picocolors.bold.cyan(text) (兼容)
```

**效果**: 每个引用点省 ~50 KB 依赖树。bundle 里 chalk 及其依赖被 tree-shake 后接近零。

### 4.4 日期库：moment → dayjs

**现状**: `moment` (2.30.1, ~300 KB) 在 `services/backend/dependencies` 里，实际只在 `software/khyquant/` 的 klineDataService.js 中使用。属于后端"代持"的依赖。

**方案**: 把 moment 从 backend/dependencies 移到 software/khyquant 自身的声明（如果 khyquant 有自己的 package.json），或替换为 dayjs：

```js
// 当前: const moment = require('moment');
// 改为: const dayjs = require('dayjs');
// API 兼容度: 80% (format, diff, add, subtract, utc)
```

**效果**: -300 KB（单副本）。khy-mobile 里还有一个 typescript 副本 8.7 MB，但那是不相关的。

### 4.5 Markdown 编辑器：同步预打包 → 按需动态加载

**现状**:
- `extensions/tools/khy-markdown/muya-embed/` — 12.7 MB（含 10 MB esbuild.exe 重复）
- `apps/ai-frontend/public/vendor/khyos-muya.js` — 6.1 MB（打包产物）
- `apps/ai-frontend/public/vendor/khyos-muya.css` — 4.4 MB

合计 ~23 MB markdown 相关资产，其中大部分在首屏加载时进入内存，但用户可能一辈子不打开编辑器。

**方案**: 前端改为动态 import：

```js
// 当前: prebuild 脚本把 muya 复制到 public/vendor/，index.html 同步加载
// <script src="/vendor/khyos-muya.js"></script>

// 改为: 用户点击编辑按钮时才加载
async function openMarkdownEditor(container) {
  const [{ default: Editor }, css] = await Promise.all([
    import('@khy/markdown-editor'),
    import('@khy/markdown-editor/style.css')
  ]);
  // 注入编辑器
}
```

**效果**: 首屏 bundle -10 MB。编辑器在后台预加载，用户点击时 ~100ms 可见。

---

## 五、第三层：架构改造（改动较大，收益最高）

### 5.1 三档分发架构

**现状**: 单一 `bundle.mjs`（16.7 MB），包含所有功能。

**目标**: 按功能裁剪，用户只需下载自己需要的部分。

| 档位 | 内容 | 入口 | 目标体积 |
|------|------|------|----------|
| **lite** | AI 网关 + CLI 核心命令（无 TUI、无浏览器引擎） | `khy` 命令默认 | ~6 MB |
| **standard** | lite + Ink TUI + 基础工具 + SQLite | 终端交互用户 | ~12 MB |
| **full** | standard + Playwright 浏览器引擎 + 扩展系统 | 完整平台 | ~22 MB |

**实现**:

```js
// packaging/npm/build/esbuild-modules.js

const SHARED_EXTERNALS = ['express', 'sequelize', 'ws', 'pg', 'pg-hstore'];
const LITE_EXTERNALS = [...SHARED_EXTERNALS];
const STANDARD_EXTERNALS = [...SHARED_EXTERNALS, 'ink', 'react', 'react-dom'];
const FULL_EXTERNALS = [...SHARED_EXTERNALS, 'playwright', 'playwright-core'];

build('bundle.lite.mjs',     { entryPoints: ['src/cli/khy.js'], external: LITE_EXTERNALS });
build('bundle.standard.mjs', { entryPoints: ['src/cli/khy.js'], external: STANDARD_EXTERNALS });
build('bundle.browser.mjs',  { entryPoints: ['src/tools/WebBrowserTool/index.js'], external: FULL_EXTERNALS });
```

**安装入口**:

```bash
# pip/npm 默认装 lite
pip install khy-os          # → bundle.lite.mjs, 6 MB

# 需要终端交互
khy install ui              # → 下载 bundle.standard.mjs + ink/react

# 需要浏览器引擎
khy install browser         # → 下载 bundle.browser.mjs + playwright
```

### 5.2 数据库适配器懒加载

**现状**: Sequelize + pg (PostgreSQL) + mysql2 + better-sqlite3 全在 bundle 闭包里。即使只用 SQLite，也打包了 pg 和 mysql2 驱动。

**引用点**:
- `platform/packages/shared/src/config/database.js` — dialect 加载
- `services/backend/src/services/backup/sqliteHotCopy.js` — better-sqlite3
- `services/backend/src/tools/databaseQuery.js` — 多数据库查询

**方案**: 在 `database.js` 层做按需加载：

```js
// 当前: 顶部一次性 require 所有 dialect
// const { PostgresDialect } = require('./dialects/postgres');
// const { MySQLDialect } = require('./dialects/mysql');

// 改为: 工厂函数按需加载
function createDialect(type, config) {
  const dialectMap = {
    sqlite: () => require('./dialects/sqlite').create(config),
    postgres: () => require('./dialects/postgres').create(config),
    mysql: () => require('./dialects/mysql').create(config),
  };
  const factory = dialectMap[type];
  if (!factory) throw new Error(`Unknown dialect: ${type}`);
  return factory();
}
```

**esbuild 配置**: `external: ['pg', 'mysql2', 'better-sqlite3', 'sqlite3']`

**效果**: bundle -5 MB（pg + mysql2 驱动各 ~2.5 MB）。

### 5.3 AI 网关适配器懒加载

**现状**: `services/backend/src/services/gateway/adapters/` 下有 cursorAdapter、kiroAdapter、traeAdapter、codewhispererAdapter 等。每个都 require 自己的客户端库（@aws/codewhisperer-streaming-client 等）。

**方案**: 适配器注册表改为按需加载：

```js
// 当前: 顶部 require 所有适配器
// const cursorAdapter = require('./cursorAdapter');
// const kiroAdapter = require('./kiroAdapter');

// 改为: 注册表按名称懒加载
const adapterRegistry = new Map();
function registerAdapter(name, loader) {
  adapterRegistry.set(name, loader); // loader 是 () => require('./xxxAdapter')
}
function getAdapter(name) {
  if (!adapterRegistry.has(name)) throw new Error(`Unknown adapter: ${name}`);
  return adapterRegistry.get(name)();
}
```

**esbuild 配置**: 所有 `adapters/*` 标记为 external，bundle 只包含注册表框架 (~5 KB)。

**效果**: bundle -3 MB（adapter 客户端库总和）。

---

## 六、esbuild 重复二进制去重

### 6.1 现状

`@esbuild/win32-x64/esbuild.exe` 在 4 个位置出现，合计 ~40 MB：

| 位置 | 大小 |
|------|------|
| `node_modules/@esbuild/win32-x64/esbuild.exe` | 10.1 MB |
| `extensions/tools/khy-markdown/muya-embed/node_modules/@esbuild/win32-x64/esbuild.exe` | 10.1 MB |
| `apps/khy-mobile/node_modules/@esbuild/win32-x64/esbuild.exe` | 9.5 MB |
| `node_modules/vite/node_modules/@esbuild/win32-x64/esbuild.exe` | 9.5 MB |

### 6.2 方案

这不是源码问题，是 pnpm/npm 的依赖提升策略差异。

**pnpm 严格模式下**，同一包应该硬链接到全局 store，只算一次。检查 `.npmrc`：

```ini
# 确保 pnpm 严格模式 + 全局 store
shared-workspace-lockfile=true
hoist-pattern=[]          # 不提升到顶层
public-hoist-pattern=[]   # 不公开提升
```

如果已经是严格模式仍有 4 份，可能是 workspace 之间的 peer 组合不同导致 pnpm 认为是不同实例。需要检查 `pnpm-lock.yaml` 中 esbuild 的 peer 组合数。

**短期**: 不影响功能，仅在磁盘空间紧张时清理。  
**长期**: 统一 esbuild 版本到单一版本号，消除 peer 组合差异。

---

## 七、执行路线图

### Phase 1：立刻执行（本周，零代码风险）

```
1. 清理构建产物
   cd apps/khy-mobile/android && ./gradlew clean
   Remove-Item packaging/npm/bundled/ -Recurse -Force
   Remove-Item apps/ai-frontend/node_modules/.ignored/ -Recurse -Force

2. 清理运行时数据
   # 确认 .khy/ 和 khy-Trajectory/ 是否重复
   # 安全地清理 logs/ + audit/ + old checkpoints

3. 清理参考文件
   Remove-Item docs/_ref/*/测试视频.mp4 -Force

4. git gc
   git gc --aggressive --prune=now
```

**预期收益**: -370 MB 开发盘占。

### Phase 2：配置优化（本周，改 package.json + 构建脚本）

```
5. esbuild external 化 ink/react（bundle 从 16.7 MB → 12 MB）
6. 数据库 dialect 按需加载（bundle -5 MB）
7. 网关适配器懒加载（bundle -3 MB）
```

**预期收益**: bundle.mjs 从 16.7 MB → ~9 MB。

**实际结果 (2026-08-28)** — 分三个阶段逐步 externalize:

| 阶段 | khy (full) | khy-gateway | 说明 |
|------|-----------|-------------|------|
| 旧（单 bundle） | 16.7 MB | — | 全部打入 |
| Phase 2.1（per-module excludeDeps） | 15.90 MB | 13.12 MB | 仅排除 ink/react 等 UI 依赖 |
| Phase 2.5（RUNTIME_SERVICE_MODULES） | **13.12 MB** | **10.67 MB** | express/pg/sequelize/ws/winston 等全部 external |

核心架构变更：
1. `computeExternals()` 新增 `RUNTIME_SERVICE_MODULES` 全局 external 列表（express, pg, sequelize, ws, winston, axios, cors, helmet, jsonwebtoken, bcryptjs, multer, node-cron, chalk, ora, inquirer 等）
2. `modules.json` 的 `excludeDeps` 精简为仅含不在全局列表中的特殊依赖（ink/react 用于 TUI, @aws/* 用于 tools）
3. npm 包 (`packaging/npm/package.json`) 声明了所有 external 依赖，安装后 alongside bundle 提供
4. pip wheel 的 `package-data` 包含所有 6 个 bundle + `package.json`，bootstrap 首次启动时跑 `npm install`
5. `_bootstrap.py` 在 pip-bundled 模式下也从 `bundled/` 目录跑 `npm install`
6. `cli.py` 在 pip-bundled 模式下设置 `NODE_PATH` 指向 `bundled/node_modules/`

### Phase 3：依赖替换（下周，改源码 import）

```
8. chalk → picocolors（全局 grep + 替换）
9. moment → dayjs（在 khyquant 层替换）
10. winston → pino（logger 层适配）
```

**预期收益**: 运行时依赖树 -5 MB，日志性能 +100x。

### Phase 4：架构升级（本月）

```
11. Markdown 编辑器动态加载（首屏 -10 MB）
12. 三档 bundle profile（lite 6 MB / standard 12 MB / full 22 MB）
13. 扩展按需安装机制
```

**预期收益**: 用户按需下载，非全量。

### Phase 5：长期

```
14. Ink TUI 逐步替换为原生实现（bundle -15 MB）
15. muya-embed → CodeMirror 6（extensions -10 MB）
16. check:dep-size 加入 CI 防止回归
```

---

## 八、预算线（CI 门禁）

在 `scripts/ci/check-dependency-size.js` 基础上新增 bundle 预算：

| 档位 | 预算 | 阻断条件 |
|------|------|----------|
| `bundle.lite.mjs` | < 8 MB | 超限 → CI 失败 |
| `bundle.standard.mjs` | < 15 MB | 超限 → CI 失败 |
| `bundle.browser.mjs` | < 25 MB | 超限 → CI 失败 |
| 开发安装（pnpm install） | < 600 MB 磁盘 | 仅报告，不阻断 |
| 前端首屏 chunk | < 500 KB | 超限 → CI 失败 |

---

## 九、风险与回退

| 改动 | 风险 | 回退方式 |
|------|------|----------|
| 清理构建产物 | 零 | 重建即可 |
| ink/react external | 低 | 改回 internal |
| 数据库懒加载 | 中（触及核心 I/O） | 保持同步 require 作为 fallback |
| 适配器懒加载 | 低 | 保持同步 require |
| chalk → picocolors | 低（API 兼容） | 保留 chalk 作为 fallback |
| winston → pino | 中（日志格式变更） | 双写过渡 |
| moment → dayjs | 低（API 80% 兼容） | 保留 moment 作为 fallback |
| 三档 bundle | 中（分发流程变更） | 保留全量 bundle 作为 fallback |

---

## 十、参考

- `scripts/ci/check-dependency-size.js` — 依赖体积预算 CI
- `scripts/ci/check-frontend-size.js` — 前端体积检查
- `packaging/npm/build/` — esbuild 打包脚本
- `services/backend/esbuild.config.js` — 后端 bundle 配置
- `.gitignore` — 已排除的构建产物和运行时数据
