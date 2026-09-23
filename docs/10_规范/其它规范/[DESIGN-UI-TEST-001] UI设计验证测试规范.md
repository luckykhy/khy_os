# [DESIGN-UI-TEST-001] UI 设计验证测试规范

> **定位**：定义 khy-os 项目 UI 设计验证的**测试策略、分层架构、不变量清单与可执行验证规则**。
> **适用边界**：覆盖 TUI（Ink/React 终端界面）与 Web 前端（Vue 3 + Element Plus）两条 UI 路径；
> 不替代 `[DESIGN-TEST-001]`（通用测试规范），而是在其上叠加 UI 专有的设计验证层。
> **关联真源**：
> - TUI 布局/组件/颜色 → `[DESIGN-ARCH-079] TUI界面设计规范`
> - TUI 区域划分 → `[DESIGN-ARCH-016] AI_Agent显示规范` §7
> - Web 前端令牌/组件/API → `[DESIGN-FE-001] 前端页面规范`
> - Web 前端组件 API 目标态 → `[DESIGN-FE-002] 前端组件库规范`
> - 可访问性 → `[DESIGN-A11Y-001] 可访问性规范`
> - CC TUI 工程约束 → `services/backend/src/cli/tui/AGENTS.md`
>
> **设计原则**：规范定义的不变量必须有可执行的测试守护；没有测试的不变量只是建议。

---

## 0. 术语表

| 术语 | 含义 |
|------|------|
| **设计不变量 (Design Invariant)** | 规范中定义的、不可漂移的 UI 约束（尺寸、颜色、结构、行为） |
| **设计验证 (Design Verification)** | 通过自动化测试验证 UI 实现是否符合规范定义的不变量 |
| **契约测试 (Contract Test)** | 验证模块间接口契约不变（如 REGION 枚举、组件 props/emits） |
| **合规测试 (Compliance Test)** | 验证代码是否遵守规范禁令（如禁止硬编码颜色） |
| **渲染冒烟测试 (Render Smoke Test)** | 验证组件能无异常挂载并输出非空帧 |
| **Wiring Test** | 验证「声明的数据/路由/调用」与「真实接线」一致（khy-os 前端既有测试范式） |

---

## 1. 测试金字塔（UI 专版）

```
                    ┌─────────────┐
                    │  E2E / 手动  │   ← 发版前回归清单 (TEST-RPT-005)
                    │  回归测试    │
                  ┌─┴───────────┐ │
                  │  渲染冒烟    │   ← inkRenderSmoke.test.js (TUI)
                  │  测试       │     组件 SSR 渲染测试 (Web)
                ┌─┴──────────┐  │
                │  契约测试    │   ← regionLayout.test.js (TUI)
                │  (Contract) │     KhyIcon.test.js (Web)
              ┌─┴──────────┐  │
              │  合规测试    │   ← designTokenCompliance.test.js (NEW)
              │(Compliance) │     themeParity.test.js (NEW)
            ┌─┴────────────┘  │
            │  纯叶子单元测试  │   ← sidebarLayout.test.js (TUI)
            │  (Pure Leaf)    │     effectiveCols.test.js (TUI)
            └─────────────────┘
```

| 层级 | 关注点 | 工具 | 文件后缀 | 何时跑 |
|------|--------|------|----------|--------|
| **L0 纯叶子** | 几何计算/布局数学的确定性输出 | `node:test` (TUI) / vitest (Web) | `*.test.js` | 每次提交 |
| **L1 合规** | 设计令牌/颜色/主题一致性 | vitest (Web) / `node:test` (TUI) | `*.compliance.test.js` 或 `*Compliance.test.js` | 含样式改动时 |
| **L2 契约** | REGION 枚举/组件 props/模块接口冻结 | `node:test` (TUI) / vitest (Web) | `*.test.js` / `*.wiring.test.js` | 每次提交 |
| **L3 渲染冒烟** | 组件能挂载 + 输出非空帧 | jest + `--experimental-vm-modules` (TUI) / vitest SSR (Web) | `*Render*.test.js` / `*Smoke.test.js` | TUI 专属 CI Job |
| **L4 E2E/手动** | 跨页面交互流、Windows 兼容性 | Playwright (手动) / 人工 | 回归清单 | 发版前 |

---

## 2. 设计不变量清单

### 2.1 TUI 不变量（来自 `[DESIGN-ARCH-079]` + `[DESIGN-ARCH-016]` §7）

| # | 不变量 | 来源 | 验证方式 | 测试文件 |
|---|--------|------|----------|----------|
| T1 | REGION 枚举 25 个 ID 冻结（9 顶层 + 6 大区 + 10 小区） | ARCH-016 §7.2-7.4 | 契约测试 | `regionLayout.test.js` ✅ |
| T2 | 三层结构：大区值是小区值的前缀 | ARCH-016 §7.1 | 契约测试 | `regionLayout.test.js` ✅ |
| T3 | OWNING_OVERLAYS 6 个 key 全声明，hideChrome 为 boolean | ARCH-016 §7.5 | 契约测试 | `regionLayout.test.js` ✅ |
| T4 | TOP_LEVEL_ORDER 自顶向下顺序 = REGION 顶层顺序 | ARCH-016 §7.2 | 契约测试 | `regionLayout.test.js` ✅ |
| T5 | PromptFrame 宽度 = `cols - 1`（留 1 列 slack） | ARCH-079 §2.2 | 合规测试 | `uiDesignContract.test.js` 🆕 |
| T6 | PromptFrame 最小高度 = 4 rows，最大高度 = `vrows - 10` | ARCH-079 §2.2 | 合规测试 | `uiDesignContract.test.js` 🆕 |
| T7 | FooterBar 高度 = 2 rows（Legacy）/ 1 row（三栏） | ARCH-079 §2.6 | 合规测试 | `uiDesignContract.test.js` 🆕 |
| T8 | 看板宽度 clamp(24, 36)，默认 ratio 0.16 | ARCH-079 §3.2 | 纯叶子测试 | `sidebarLayout.test.js` ✅ |
| T9 | 看板最小激活列宽 = 120 cols | ARCH-079 §3.1 | 纯叶子测试 | `sidebarLayout.test.js` ✅ |
| T10 | 响应式分类：超窄 <80 / 窄屏 80-119 / 标准 120-159 / 宽屏 ≥160 | ARCH-079 §8.1 | 合规测试 | `uiDesignContract.test.js` 🆕 |
| T11 | effectiveCols 永不抛（缺失/损坏降级） | effectiveCols.js | 纯叶子测试 | `effectiveCols.test.js` ✅ |
| T12 | sidebarTopAnchorRows 永不抛（WelcomeBanner 缺失 → 0） | ARCH-016 §7.6 | 契约测试 | `regionLayout.test.js` ✅ |
| T13 | CC 模式品牌文本不含 "Claude Code" / "Claude" | tui/AGENTS.md §0.4 | 合规测试 | `uiDesignContract.test.js` 🆕 |
| T14 | TUI 禁止 DECSTBM 滚动区（`\x1B[...r`）除非备用缓冲区 | AGENTS.md 规则 4 | 合规测试 | `check-agent-rules.js` ✅ |

### 2.2 Web 前端不变量（来自 `[DESIGN-FE-001]` + `[DESIGN-A11Y-001]`）

| # | 不变量 | 来源 | 验证方式 | 测试文件 |
|---|--------|------|----------|----------|
| W1 | 所有 `--khy-*` token 在 `:root` 和 `html.dark` 成对定义 | FE-001 §3.1 | 合规测试 | `themeParity.test.js` 🆕 |
| W2 | `--khy-white` 必须有定义（已知缺口 G1） | FE-001 §12 G1 | 合规测试 | `themeParity.test.js` 🆕 |
| W3 | `.vue`/`.css` 中不得出现字面量 hex 颜色（真源文件除外） | FE-001 §3.2 | 合规测试 | `designTokenCompliance.test.js` 🆕 |
| W4 | 样式必须使用 `var(--khy-*)`，禁止内联 hex | FE-001 §5.3 | 合规测试 | `designTokenCompliance.test.js` 🆕 |
| W5 | Khy* 组件必须有 `<script setup>` + scoped 样式 | FE-001 §5.3 | 契约测试 | `componentContract.wiring.test.js` 🆕 |
| W6 | Khy* 组件 props 带 validator | FE-001 §5.3 | 契约测试 | `componentContract.wiring.test.js` 🆕 |
| W7 | 新页面必须登记 `src/nav/index.js` | FE-001 §4 | Wiring test | `nav.wiring.test.js` ✅ |
| W8 | 交互元素键盘可达，focus 态可见 | A11Y §4 | 手动 + 自动化 | `a11yContract.test.js` 🆕 |
| W9 | 状态变化区有 `aria-live`，加载区有 `aria-busy` | A11Y §3.1/§7.1 | 合规测试 | `a11yContract.test.js` 🆕 |
| W10 | 尊重 `prefers-reduced-motion` | A11Y §5.3 | 合规测试 | `a11yContract.test.js` 🆕 |
| W11 | 文本对比度满足 WCAG AA（正文 ≥4.5:1） | A11Y §5.1 | 手动 | 回归清单 |
| W12 | 前端体积只降不升 | FE-001 §9 | CI 门禁 | `check:frontend-size` ✅ |

### 2.3 khyquant 前端不变量（来自 `[DESIGN-FE-001]` §3.3）

| # | 不变量 | 来源 | 验证方式 | 测试文件 |
|---|--------|------|----------|----------|
| K1 | khyquant 新代码使用 `--khy-*` 命名 | FE-001 §3.3 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| K2 | khyquant 不新增平行令牌命名（`--primary-color` 等） | FE-001 §3.3 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| K3 | 移动端触控目标 ≥44px | FE-001 §8 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| K4 | 移动端输入框字号 ≥16px（防 iOS 自动缩放） | FE-001 §8 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |

### 2.4 移动端不变量（手机 / Capacitor / PWA）

> **真源**：`[DESIGN-FE-001]` §8（响应式与移动端）、`software/khyquant/frontend/` 实测代码。

| # | 不变量 | 来源 | 验证方式 | 测试文件 |
|---|--------|------|----------|----------|
| M1 | 触控目标 ≥44px（`min-height: 44px; min-width: 44px`） | FE-001 §8 + mobile.css | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| M2 | 移动端输入框字号 ≥16px（防 iOS 自动缩放） | FE-001 §8 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| M3 | 响应式断点存在（768px 手机 / 1024px 平板 / 480px 小屏） | FE-001 §8 + responsive.css | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| M4 | PWA manifest 含必需字段（name/short_name/theme_color/display/icons） | vite.config.js PWA 配置 | 合规测试 | `mobileUiCompliance.test.js` 🆕 |
| M5 | Capacitor 配置含 appId / appName / webDir | `capacitor.config.ts` | 契约测试 | `mobileUiCompliance.test.js` 🆕 |
| M6 | Mobile* 组件族存在（MobileLayout / MobileNav / MobileToast 等） | FE-001 §5.2 | 契约测试 | `mobileUiCompliance.test.js` 🆕 |
| M7 | PWA 更新提示组件（PwaUpdatePrompt）与离线指示器（OfflineIndicator）存在 | FE-001 §8 | 契约测试 | `mobileUiCompliance.test.js` 🆕 |
| M8 | 移动端滚动行为使用 `-webkit-overflow-scrolling: touch` | mobile-scroll.css | 合规测试 | `mobileUiCompliance.test.js` 🆕 |

### 2.5 桌面端不变量（Electron / khyos-desktop）

> **真源**：`[DESIGN-ARCH-078]`（桌面端与 CLI/TUI 互联方案）、`apps/khyos-desktop/` 实测代码、
> `apps/khyos-desktop/CLAUDE.md`、`electron/main.js`（旧 ai-frontend 壳）。

| # | 不变量 | 来源 | 验证方式 | 测试文件 |
|---|--------|------|----------|----------|
| D1 | BrowserWindow 尺寸：khyos-desktop 1216×808（min 800×600）；旧壳 1280×800（min 900×600） | main/index.ts + electron/main.js | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D2 | khyos-desktop 无框窗口（`frame: false`）；旧壳有框 | main/index.ts:28 + electron/main.js:18 | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D3 | 安全配置：`contextIsolation: true` + `nodeIntegration: false` | Electron 安全最佳实践 | 合规测试 | `desktopUiContract.test.js` 🆕 |
| D4 | Preload 通过 `contextBridge.exposeInMainWorld('__KHYOS__', api)` 暴露 API | preload/index.ts:39 | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D5 | Preload 必需方法集：窗口控制 + 设置 + 主题 + 文件 + AI + 会话 + 平台/版本 | preload/index.ts | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D6 | IPC 通道命名约定：`namespace:action`（如 `window:minimize`、`ai:send`） | main/index.ts | 合规测试 | `desktopUiContract.test.js` 🆕 |
| D7 | 菜单含四组（文件/视图/窗口/帮助） | menu.ts | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D8 | TitleBar 含窗口控制按钮（最小化/最大化/关闭） | layout/TitleBar.tsx | 契约测试 | `desktopUiContract.test.js` 🆕 |
| D9 | 品牌文本不含 "ZCode" / "Zhipu" / "智谱"（仅结构复刻，不复用品牌） | khyos-desktop/CLAUDE.md 品牌规则 | 合规测试 | `desktopUiContract.test.js` 🆕 |
| D10 | 源码不得硬编码 `localhost:3000` / `localhost:9222` 等端点字面量 | AGENTS.md 规则 1 | 合规测试 | `desktopUiContract.test.js` 🆕 |

---

## 3. 测试文件组织

### 3.1 TUI 测试

```
services/backend/tests/cli/tui/
├── regionLayout.test.js              # T1-T4, T12 — REGION SSOT 契约 ✅
├── sidebarLayout.test.js             # T8-T9 — 看板宽度/激活阈值 ✅
├── effectiveCols.test.js            # T11 — 有效列宽降级 ✅
├── uiDesignContract.test.js          # T5-T7, T10, T13 — 尺寸/响应式/品牌合规 🆕
├── footerStability.test.js           # Footer 行数稳定 ✅
├── promptPlaceholder.test.js         # PromptFrame 占位符 ✅
├── railLayout.test.js                # Rail 几何/绘制 ✅
├── sidebarPanel.test.js              # 看板面板渲染 ✅
├── sidebarRailRuntime.test.js        # Rail 运行时 ✅
├── liveRegionBudget.test.js          # Live 区高度预算 ✅
├── inkRenderSmoke.test.js (在 tests/tui/)  # L3 渲染冒烟 ✅
└── ...
```

### 3.2 Web 前端测试

```
apps/ai-frontend/src/
├── __tests__/
│   ├── designTokenCompliance.test.js  # W3-W4 — 颜色/令牌合规 🆕
│   ├── themeParity.test.js            # W1-W2 — 双主题成对定义 🆕
│   ├── a11yContract.test.js           # W8-W10 — 可访问性合规 🆕
│   └── vitest.sanity.test.js          # 环境健全性 ✅
├── components/
│   ├── KhyIcon.test.js                # W5-W6 — 组件契约（示例）✅
│   └── __tests__/
│       └── componentContract.wiring.test.js  # W5-W6 — 所有 Khy* 组件契约 🆕
├── compos/
│   └── *.wiring.test.js               # W7 — wiring tests ✅
└── router/
    └── nav.wiring.test.js             # W7 — 导航数据 wiring ✅
```

### 3.3 移动端测试（khyquant 前端）

```
software/khyquant/frontend/src/
├── __tests__/
│   ├── mobileUiCompliance.test.js     # M1-M8 — 移动端 UI 合规 + 契约 🆕
│   └── example.test.js                 # placeholder（待替换）✅
├── vitest.config.js                    # vitest 配置（jsdom, 80% 阈值）✅
└── components/
    ├── MobileLayout.vue
    ├── MobileNav.vue
    ├── MobileToast.vue
    └── ...（Mobile* 组件族）
```

### 3.4 桌面端测试（khyos-desktop）

```
apps/khyos-desktop/
├── tests/
│   └── desktopUiContract.test.js       # D1-D10 — 桌面端 UI 契约 + 合规 🆕
├── scripts/ci/
│   ├── brand-replace.cjs              # 品牌替换校验 ✅
│   └── check-api-drift.mjs            # preload API 漂移守卫 ✅
└── src/
    ├── main/index.ts                   # 主进程
    ├── preload/index.ts                # preload
    └── renderer/
        ├── components/layout/TitleBar.tsx  # 无框窗口标题栏
        └── ...
```

### 3.3 命名规范

| 类型 | 命名模式 | 示例 |
|------|----------|------|
| 契约测试 | `{module}.test.js` | `regionLayout.test.js` |
| 合规测试 | `{concern}Compliance.test.js` | `designTokenCompliance.test.js` |
| 主题测试 | `themeParity.test.js` | — |
| 可访问性 | `a11yContract.test.js` | — |
| Wiring | `{module}.wiring.test.js` | `nav.wiring.test.js` |
| 渲染冒烟 | `{module}RenderSmoke.test.js` 或 `inkRenderSmoke.test.js` | — |

---

## 4. 测试编写规范

### 4.1 TUI 测试（node:test）

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 路径相对于 tests/cli/tui/
const modPath = '../../../src/cli/tui/someModule';

test('不变量描述', () => {
  const mod = require(modPath);
  // Arrange
  const input = ...;
  // Act
  const result = mod.function(input);
  // Assert
  assert.strictEqual(result, expected);
});
```

**规范**：
1. 使用 `node:test` + `node:assert/strict`（非 jest）
2. 模块路径用 `require('../../../src/...')` 相对引用
3. 每个 test 描述一个不变量，名称包含「不变量」关键词
4. 测试不依赖终端状态（mock `process.stdout` / `process.env`）
5. 永不抛的函数必须有 null/undefined 入参降级测试

### 4.2 Web 前端测试（vitest）

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 设计令牌测试读取 CSS 真源文件
const themeCss = readFileSync(
  join(import.meta.dirname, '../styles/newapi-theme.css'),
  'utf-8'
);

describe('设计令牌合规', () => {
  it(':root 中定义的 --khy-* token 必须在 html.dark 中有成对定义', () => {
    // 解析 :root 和 html.dark 块
    // 断言每个 :root --khy-* 在 html.dark 也有定义
  });
});
```

**规范**：
1. 使用 vitest ESM 语法（`import`）
2. 合规测试读取真源文件（CSS/JS），不 mock
3. 组件渲染测试用 SSR（`renderToString`），避免 jsdom 依赖
4. 每个 describe 块覆盖一个不变量域
5. 失败消息包含规范条目编号（如 `W1`、`T5`）

### 4.3 移动端测试（vitest + jsdom）

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..');

describe('M1: Touch Target ≥44px', () => {
  const mobileCss = readFileSync(join(srcRoot, 'styles/mobile.css'), 'utf-8');
  it('button/a/clickable 的 min-height 和 min-width 为 44px', () => {
    expect(mobileCss).toContain('44px');
  });
});
```

**规范**：
1. 使用 vitest ESM 语法（`import`），khyquant 前端有 `vitest.config.js`（jsdom 环境）
2. 合规测试读取 CSS 真源文件（`mobile.css` / `responsive.css` / `mobile-scroll.css`）
3. 组件存在性测试用 `existsSync` 检查文件存在
4. PWA/Capacitor 配置测试解析 `vite.config.js` / `capacitor.config.ts` 源码文本

### 4.4 桌面端测试（node:test，源码文本审计）

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const mainSrc = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf-8');

test('D1: BrowserWindow 尺寸 1216×808, min 800×600', () => {
  assert.match(mainSrc, /width:\s*1216/);
  assert.match(mainSrc, /height:\s*808/);
  assert.match(mainSrc, /minWidth:\s*800/);
  assert.match(mainSrc, /minHeight:\s*600/);
});
```

**规范**：
1. 使用 `node:test` + `node:assert/strict`（无框架依赖）
2. 测试读取 TypeScript 源码文本（不编译，不 import Electron）
3. 契约测试验证 BrowserWindow 配置、preload API、IPC 通道命名
4. 合规测试扫描品牌文本、硬编码端点
5. 安全测试验证 `contextIsolation` / `nodeIntegration` 配置

### 4.5 测试边界

| 必须测试 | 不必测试 |
|----------|----------|
| 规范定义的尺寸约束（min/max/fixed） | 视觉像素级对齐 |
| 枚举/ID 冻结 | 性能基准（另有 CI 门禁） |
| 降级行为（缺失依赖时不崩） | 具体颜色值（令牌真源已锁定） |
| 禁令合规（无硬编码、无滚动区） | 用户主观体验 |
| 双主题成对定义 | 截图对比（khy-os 暂不采用） |

---

## 5. 设计验证 CI 流水线

### 5.1 提交前（本地）

```bash
# TUI 测试
cd services/backend && npm run test:tui

# Web 前端测试
cd apps/ai-frontend && npx vitest run

# 移动端测试（khyquant 前端）
cd software/khyquant/frontend && npx vitest run

# 桌面端测试（khyos-desktop）
cd apps/khyos-desktop && node --test tests/desktopUiContract.test.js

# 全仓红线
node scripts/ci/check-agent-rules.js --changed

# 前端体积门禁
npm run check:frontend-size
```

### 5.2 CI 门禁

| 门禁 | 命令 | 阻断级别 |
|------|------|----------|
| TUI 契约 + 合规 | `npm run test:tui` | error |
| Web 前端 vitest | `npx vitest run`（ai-frontend） | error |
| 移动端 vitest | `npx vitest run`（khyquant frontend） | error |
| 桌面端契约 | `node --test tests/desktopUiContract.test.js`（khyos-desktop） | error |
| 桌面端品牌替换 | `node scripts/ci/brand-replace.cjs`（khyos-desktop） | error |
| 桌面端 API 漂移 | `node scripts/check-api-drift.mjs`（khyos-desktop） | error |
| 硬编码端点 | `check-agent-rules.js --changed` | error |
| ANSI 滚动区 | `check-agent-rules.js --changed` | error |
| 前端体积 | `check:frontend-size` | error |
| 含糊状态文案 | `check-agent-rules.js --changed` | warning (strict → error) |

### 5.3 发版前（手动 + 回归清单）

| 步骤 | 文档 |
|------|------|
| Windows UI 回归 | `[TEST-RPT-005] windows-ui-聊天回归清单` |
| 双主题肉眼检查 | FE-001 §3.4 |
| 可访问性手动清单 | A11Y §8.1 |
| 响应式断点检查 | FE-001 §8 |
| 移动端真机测试 | Capacitor `mobile:run:android`，检查 44px 触控 / 16px 字号 / 滚动行为 |
| 桌面端窗口行为测试 | 无框窗口拖拽/最大化/还原/关闭，菜单快捷键 |

---

## 6. 已知缺口与收敛方向

> 新增缺口视同违规；收敛一条划掉一条。

| # | 缺口 | 影响 | 收敛方向 | 优先级 |
|---|------|------|----------|--------|
| G1 | 无视觉回归/截图测试基础设施 | 无法自动检测视觉漂移 | 评估引入 Playwright 截图对比（当前用渲染冒烟 + 契约测试替代） | P2 |
| G2 | ai-frontend 无 vitest 配置（用默认值） | 无 jsdom 环境，DOM 依赖测试无法运行 | 新增 `vitest.config.js` 配置 jsdom（仅对需要 DOM 的测试） | P2 |
| G3 | Topbar.js 组件无测试 | 覆盖缺口 | 补 `topbar.test.js` 契约测试 | P2 |
| G4 | khyquant 前端仅有 placeholder 测试 | 移动端 UI 无守护 | ✅ 已补 `mobileUiCompliance.test.js`（M1-M8） | 已收敛 |
| G5 | 无自动化对比度检查 | WCAG AA 靠手动 | 评估 axe-core 集成（当前用 `a11yContract.test.js` 检查 ARIA 结构） | P3 |
| G6 | 组件库（FE-002）尚未落地 | W5-W6 的全面验证依赖组件库存在 | 组件库落地后扩展 `componentContract.wiring.test.js` | P3 |
| G7 | 桌面端无测试 | khyos-desktop UI 无守护 | ✅ 已补 `desktopUiContract.test.js`（D1-D10） | 已收敛 |
| G8 | 两个 Capacitor appId 冲突（`com.khy.quant.mobile` vs `com.khyos.companion`） | 可能导致应用商店冲突 | 统一为一个 appId 或明确两个独立应用 | P2 |
| G9 | khyos-desktop 所有 IPC handler 为 stub | 桌面端功能不可用 | 按 ARCH-078 P1-P4 计划逐步落地 | P1 |

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.0.0 | 2026-09-10 | 扩展为四端全覆盖：新增移动端不变量 M1-M8、桌面端不变量 D1-D10、移动端测试编写规范 §4.3、桌面端测试编写规范 §4.4、移动端/桌面端测试目录 §3.3-3.4、CI 流水线新增移动端/桌面端门禁、缺口 G7-G9 |

---

*本规范由 khy-os UI 方向维护；与代码冲突时以代码为准并登记 §6 缺口。*
