# khyos 前端技术栈规范（Vue 3 + Element Plus）

本文档是 frontend-beautify skill 的技术栈单一真源。**动手前先读本文件**，确保改动符合 khyos 既有体系。

## 共享设计 token（ai-frontend 为准）

`apps/ai-frontend/src/styles/newapi-theme.css` 定义了完整的 `--khy-*` token 体系（新 API 风格、oklch 派生、亮暗双主题）。这是 khyos 主前端的**设计语言真源**，所有视觉改动必须复用它。

### 核心 token（亮色）

| Token | 值 | 用途 |
|---|---|---|
| `--khy-bg-main` | `#f4f7fc` | 页面主背景 |
| `--khy-bg-elevated` / `--khy-bg-card` | `#ffffff` | 卡片/浮层背景 |
| `--khy-bg-soft` | `#eff4ff` | 选中/激活的软背景 |
| `--khy-text-main` | `#1f2937` | 正文 |
| `--khy-text-strong` | `#101828` | 强文本/标题 |
| `--khy-text-secondary` | `#475467` | 次要文本 |
| `--khy-text-muted` | `#667085` | 辅助/弱化文本 |
| `--khy-border` | `#d6e0ef` | 常规边框 |
| `--khy-border-light` | `#e5ebf5` | 细分隔线 |
| `--khy-primary` | `#2f7ef7` | 品牌主色 |
| `--khy-primary-strong` | `#1f68df` | 主色 hover/按下 |
| `--khy-primary-soft` | `#eaf2ff` | 主色软背景 |
| `--khy-success` | `#079455` | 成功/上涨 |
| `--khy-warning` | `#dc6803` | 警告 |
| `--khy-danger` | `#d92d20` | 危险/下跌 |

### 双主题机制

- 主题切换 = 在 `<html>` 上加/去 `dark` class（`src/composables/useTheme.js` 单例管理）。
- `:root` 定义亮色 token；`html.dark` 覆盖同一组变量。
- Element Plus 的暗色 css-vars 已在 main.js 引入（`element-plus/theme-chalk/dark/css-vars.css`）。
- **改配色 = 改 `newapi-theme.css` 里的 token**，让所有页面跟随。不要在单页里发明新颜色。

## Element Plus 使用约定

### ai-frontend（按需加载）
- `unplugin-vue-components` 自动引入模板里 `<el-*>` 的组件和样式。
- **命令式 API 需手动引样式**（main.js 已引）：`ElMessage`、`ElMessageBox`、`ElOverlay`。
- 新增 `<el-*>` 组件直接在模板用即可，无需手动 import。

### khyquant frontend（全量引入）
- main.js `import 'element-plus/dist/index.css'` 全量引入。
- 使用 Element Plus 图标：`import * as ElementPlusIconsVue from '@element-plus/icons-vue'`。
- 中文语言包：`import zhCn from 'element-plus/dist/locale/zh-cn.mjs'`。

## 通用样式规则

### 字体
- 中文优先，拉丁在前系统栈：
  ```css
  font-family: -apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  ```
- 中文正文行高 1.7–1.8；标题 1.3–1.4。
- 数字对齐：`font-variant-numeric: tabular-nums`（表格/行情数字列）。

### 布局
- 强推 flex/grid + `gap`。`display: flex; gap: 8px` 而不是 `margin-left`。
- 间距节奏：4 / 8 / 12 / 16 / 24 / 32 / 48。
- 卡片统一圆角（Element Plus 默认 4px 或 token 化）。

### 数据密集页面（行情/监控/回测）
- 表格 `size="small"` + 紧凑 padding。
- 关键数值用语义色：上涨 `--khy-success`、下跌 `--khy-danger`。
- 次要信息用 `--khy-text-secondary` / `--khy-text-muted` 降级，不要全部一样黑。

### 移动端（khy-mobile）
- 触控目标 ≥ 44px。
- 慎用 hover；交互依赖 tap 状态。
- 实时数据（SSE）用卡片层级组织，连接状态统一走 `ConnectionStatus.vue`。

## 验证命令

| 项目 | dev | build 检查 |
|---|---|---|
| ai-frontend | `cd apps/ai-frontend && npm run dev` | `cd apps/ai-frontend && npx vite build` |
| khyquant | `cd software/khyquant/frontend && npm run dev` | `cd software/khyquant/frontend && npx vite build` |
| khy-mobile | `cd apps/khy-mobile && npm run dev` | `cd apps/khy-mobile && npx vite build` |

每次改动后至少跑一次 build 检查确认无编译错误。
