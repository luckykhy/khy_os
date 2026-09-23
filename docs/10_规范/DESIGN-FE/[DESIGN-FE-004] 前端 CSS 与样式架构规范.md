# [DESIGN-FE-004] 前端 CSS 与样式架构规范

<!-- RULES-REGISTRY: FE-004 -->

> **用途**：定义 khy-os 前端项目（ai-frontend / khyquant-frontend）的 CSS 架构与样式规范。
> FE-001 §3 已定义设计令牌体系，本文档补全架构、分层、命名、响应式、动画等样式工程规范。

---

## 1. CSS 架构原则

1. **令牌优先**：颜色/圆角/阴影全部走 `var(--khy-*)`，禁止硬编码值
2. **分层组织**：Base → Tokens → Layout → Components → Utilities → Overrides
3. **就近原则**：组件样式 `scoped`，全局样式仅放布局/令牌/动画
4. **无 !important**：通过特异性顺序管理优先级
5. **移动优先**：默认移动端样式，`min-width` 渐进增强

---

## 2. 分层架构

### 2.1 六层模型（ITCSS 变体）

```
┌──────────────────────────────────────────────────────┐
│  6. Overrides — 第三方组件覆盖（仅 Element Plus 主题）  │
├──────────────────────────────────────────────────────┤
│  5. Utilities — 工具类（间距、排版、显示）              │
├──────────────────────────────────────────────────────┤
│  4. Components — 业务组件样式（Khy*、业务组件）        │
├──────────────────────────────────────────────────────┤
│  3. Layout — 页面布局壳（AuthenticatedLayout 等）     │
├──────────────────────────────────────────────────────┤
│  2. Tokens — 设计令牌（newapi-theme.css）             │
├──────────────────────────────────────────────────────┤
│  1. Base — 元素默认样式（normalize + 字体）            │
└──────────────────────────────────────────────────────┘
```

### 2.2 层间规则

| 规则 | 说明 |
|------|------|
| 高层可覆盖低层 | Components → Layout → Tokens → Base |
| 低层不得依赖高层 | Base 层不知道任何组件存在 |
| 令牌是唯一真源 | 任何视觉值必须在 §3 令牌层定义 |
| 工具类不创造新值 | `.mt-16` = `margin-top: var(--khy-space-4)` |

---

## 3. 设计令牌（CSS 自定义属性）

### 3.1 命名约定

```css
--khy-{category}-{variant}
```

| 分类 | 前缀 | 示例 |
|------|------|------|
| 表面 | `--khy-bg-*` | `--khy-bg-main`、`--khy-bg-elevated` |
| 文本 | `--khy-text-*` | `--khy-text-main`、`--khy-text-muted` |
| 线条 | `--khy-border-*` | `--khy-border`、`--khy-border-light` |
| 品牌 | `--khy-primary-*` | `--khy-primary`、`--khy-primary-strong` |
| 状态 | `--khy-{status}` | `--khy-success`、`--khy-warning`、`--khy-danger` |
| 几何 | `--khy-radius-*` | `--khy-radius`、`--khy-radius-sm` |
| 阴影 | `--khy-shadow-*` | `--khy-shadow`、`--khy-shadow-lift` |
| 字体 | `--khy-font-*` | `--khy-font`、`--khy-font-mono` |

### 3.2 双主题强制

**任何颜色/阴影 token 必须同时定义浅色和深色**：

```css
/* ✅ 正确 — 双主题 */
:root {
  --khy-bg-main: #f4f7fc;
  --khy-text-main: #1f2937;
}
html.dark {
  --khy-bg-main: #0f172a;
  --khy-text-main: #e2e8f0;
}

/* ❌ 错误 — 仅浅色 */
:root {
  --khy-bg-white: #ffffff;  /* 暗色下静默失效 */
}
```

### 3.3 新增令牌流程

1. 在 `newapi-theme.css` 的 `:root` 和 `html.dark` 中同时定义
2. 在消费端使用 `var(--khy-new-token)`
3. 不得在组件内创建新的悬空变量

---

## 4. 命名方案

### 4.1 BEM（Block Element Modifier）

```
.block__element--modifier
.is-state         用于状态类
.has-child        用于子元素指示
```

```css
/* Block */
.khy-card { }

/* Element */
.khy-card__header { }
.khy-card__body { }
.khy-card__footer { }

/* Modifier */
.khy-card--elevated { }
.khy-card--compact { }

/* State */
.khy-card.is-loading { }
.khy-card.is-error { }
```

### 4.2 作用域前缀

| 前缀 | 用途 | 示例 |
|------|------|------|
| `khy-` | khy-os 全局组件 | `.khy-page-header` |
| `c-` | 业务组件 | `.c-agent-dashboard` |
| `l-` | 布局 | `.l-page-layout` |
| `u-` | 工具类 | `.u-sr-only`、`.u-mt-16` |
| `t-` | 主题覆盖（临时） | `.t-legacy-dark` |

### 4.3 类名风格

| 类型 | 风格 | 示例 |
|------|------|------|
| 复合词 | kebab-case | `.agent-dashboard` |
| 数字 | 避免纯数字 | `.col-3` ✅、`.col3` ❌ |
| 布尔 | `is-` / `has-` | `.is-active`、`.has-error` |

---

## 5. 样式来源优先级

优先级从高到低（低层可被高层覆盖）：

```css
/* 1. Inline style（最差，禁止） */
<div style="color: red">  /* ❌ 禁止 */

/* 2. 组件 scoped style */
<style scoped>
.khy-button { }  /* 特异性: 0,0,1,0 */
</style>

/* 3. 全局组件样式 */
.khy-button { }  /* 特异性: 0,0,1,0 */

/* 4. 令牌层 */
:root { --khy-primary: #2f7ef7; }  /* var() 引用 */

/* 5. 浏览器默认（最弱） */
button { }
```

**特异性控制**：
- 组件 scoped：`0,0,1,0`
- 全局组件：`0,0,1,0`
- 状态类：`0,0,2,0`（`.khy-card.is-active`）
- 工具类：`0,0,0,1`（`.mt-16`）

> **禁止使用 `!important`**。如必须提升优先级，使用更高特异性的选择器。

---

## 6. 响应式断点

### 6.1 断点定义

| 断点 | 范围 | 前缀 | 说明 |
|------|------|------|------|
| Mobile | < 640px | `m-` | 手机竖屏 |
| Tablet | 640–1023px | `t-` | 平板 |
| Desktop | ≥ 1024px | `d-` | 桌面 |

### 6.2 移动优先

```css
/* Mobile first — 默认样式 */
.c-layout { display: block; }

/* Tablet */
@media (min-width: 640px) {
  .c-layout { display: grid; grid-template-columns: 1fr 3fr; }
}

/* Desktop */
@media (min-width: 1024px) {
  .c-layout { grid-template-columns: 240px 1fr; }
}
```

### 6.3 流式值

```css
/* 优先 clamp() 而非媒体查询 */
.c-page-content {
  padding: clamp(12px, 2vw, 32px);
  font-size: clamp(14px, 1.2vw, 16px);
}
```

---

## 7. 工具类规范

### 7.1 间距工具类

| 工具类 | 值 | CSS |
|--------|-----|-----|
| `.m-0` / `.m-auto` | — | `margin: 0` |
| `.mt-8` | 8px | `margin-top: var(--khy-space-2)` |
| `.mx-16` | 16px | `margin-inline: var(--khy-space-4)` |
| `.p-0` / `.p-24` | 24px | `padding: var(--khy-space-6)` |
| `.gap-8` | 8px | `gap: var(--khy-space-2)` |

> 间距工具类映射到 `--khy-space-*` 令牌（当前 4px 为基数：2=8px, 4=16px, 6=24px）。

### 7.2 展示工具类

| 工具类 | 值 |
|--------|-----|
| `.u-sr-only` | `position: absolute; width: 1px; overflow: hidden;` |
| `.u-text-center` | `text-align: center` |
| `.u-truncate` | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` |
| `.u-clickable` | `cursor: pointer` |

---

## 8. 动画规范

### 8.1 动画参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 过渡时长 | `150ms` / `200ms` / `300ms` | 短/中/长 |
| 缓动函数 | `cubic-bezier(0.4, 0, 0.2, 1)` | 标准（ease-out-ish）|
| 关闭时长 | 与开启相同 | 对称过渡 |

### 8.2 动画令牌

```css
:root {
  --khy-duration-fast: 150ms;
  --khy-duration-normal: 200ms;
  --khy-duration-slow: 300ms;
  --khy-easing-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --khy-easing-enter: cubic-bezier(0, 0, 0.2, 1);
  --khy-easing-exit: cubic-bezier(0.4, 0, 1, 1);
}
```

### 8.3 prefers-reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 8.4 骨架屏 shimmer

```css
.khy-skeleton {
  background: linear-gradient(
    90deg,
    var(--khy-skeleton-base) 25%,
    var(--khy-skeleton-highlight) 50%,
    var(--khy-skeleton-base) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

---

## 9. 样式组织（Vue SFC）

### 9.1 文件内顺序

```vue
<style scoped>
/* 1. 变量/混合（如有） */
/* 2. Block 样式 */
.c-my-component { }

/* 3. Element 样式 */
.c-my-component__header { }
.c-my-component__body { }

/* 4. Modifier 样式 */
.c-my-component--compact { }

/* 5. 子组件样式（仅含子组件类） */
.c-child { }

/* 6. 状态样式 */
.c-my-component.is-loading { }

/* 7. 媒体查询 */
@media (min-width: 640px) { }
</style>
```

### 9.2 SCSS 使用

khyquant 使用 SCSS（`sass`），ai-frontend 不预装。规范：

- 嵌套 ≤ 3 层（避免特异性爆炸）
- `@mixin` 用于重复模式（如 flex 居中）
- `@extend` 禁止使用（性能差）
- 变量引用令牌（不新造 SCSS 变量）

```scss
.c-trading-chart {
  @include flex-center;
  height: 400px;
  
  @media (min-width: 640px) {
    height: 600px;
  }
}
```

---

## 10. 遗留代码收敛

### 10.1 硬编码 hex 收敛

使用 `npm run frontend:fix-colors` 扫描，逐步替换为 `var(--khy-*)`：

```bash
# 预览（不改文件）
npm run frontend:fix-colors

# 执行替换
npm run frontend:fix-colors:apply
```

### 10.2 悬空变量修复

FE-001 §12 缺口表中的悬空引用（`--khy-white`、khyquant 的 `var(--khy-*)` 无定义）须逐步收敛。

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义前端 CSS 与样式架构规范 |

---

*本规范由 khy-os 前端团队维护*
