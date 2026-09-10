# CLAUDE.md — Khy OS 项目上下文

> 本文件为 opencode / Claude Code / Codex 等 AI 编码助手提供项目上下文。
> 开始工作前，**必须**阅读以下文件。

---

## 项目概述

**Khy OS** 是一个通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）分发的 AI 平台操作系统。

---

## 当前工作重点：CC TUI 复刻

当前任务：在 `services/backend/src/cli/tui/` 下实现 Claude Code TUI 的 1:1 复刻（Khy 品牌版）。

### 必读文件（按优先级）

1. **`services/backend/src/cli/tui/AGENTS.md`** — CC TUI 工程约束（红线、门控、渲染、性能）
2. **`docs/03_DESIGN_设计/[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md`** — 完整设计规范
3. **`D:\Portable\Docs\design\claude-code-tui\`** — Claude Code TUI 设计素材（5 个参考文件）

### 核心约束（速览）

| 约束 | 要求 |
|------|------|
| **零破坏** | 所有 CC 模式代码通过 `KHY_CC_TUI=1` 门控，默认行为不变 |
| **渲染安全** | 禁止 DECSTBM 滚动区、`\x1B[2J`；使用 ED0 + 绝对定位 |
| **性能底线** | 冷启动 < 100ms、渲染 < 16ms、内存 < 50MB |
| **品牌合规** | 使用 "Khy" 品牌，禁止 "Claude Code" 文本 |
| **调整大小** | Resize 无残影（防抖 50ms + 增量更新） |

### 文件组织

```
services/backend/src/cli/tui/
├── AGENTS.md              ← 工程约束真源
├── app.js                 ← 入口
├── ink-components/        ← Ink 组件（Cc 前缀 = CC 模式专用）
├── utils/                 ← 工具函数（cc 前缀 = CC 模式专用）
├── hooks/                 ← React Hooks
└── theme/                 ← 主题
```

### 门控模式

```javascript
// ✅ 正确
if (process.env.KHY_CC_TUI === '1') {
  return <CcComponent />;
}
return <LegacyComponent />;

// ❌ 错误
const color = isCcMode ? '#00D4D4' : '#00BCD4'; // 禁止在组件内判断
```

### 验收标准

- `KHY_CC_TUI=1 khy` 启动后显示 CC 风格 UI
- Legacy 模式（无门控）行为与修改前逐字节相同
- 冷启动 < 100ms
- Resize 无残影
- 所有设计素材中的视觉规范对齐

---

## 其他工作规范

### 语言策略
- 用户用中文，回复用中文
- 代码、标识符、注释用英文
- 面向用户的字符串用中文

### 代码风格
- JS：2 空格缩进、单引号、分号
- 命名：camelCase（JS）、snake_case（Python）

### 安全
- 不提交 `.env`、凭据、`node_modules/`
- API key 存于 `~/.khyquant/config.json`

---

*最后更新：2026-09-09*
