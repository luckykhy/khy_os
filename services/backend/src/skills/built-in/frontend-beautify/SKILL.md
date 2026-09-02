---
name: frontend-beautify
version: 1.0.0
description: 美化 khyos 三个前端（ai-frontend / khyquant frontend / khy-mobile）。当用户要求美化界面、调整样式、改进视觉、打磨 UI、提升设计感、让页面更好看、改主题/配色/间距/字体，或让现有 Vue3 + Element Plus 页面达到「生产级而非 AI 生成感」时使用。也用于统一三端设计语言、建立设计 token、暗色主题调优、数据密集型交易/监控界面排版。
layer: application
lifecycle: development
tags: [frontend, ui, beautify, vue3, element-plus, design, theme, css]
platforms: [khy-os, khy-quant]
dependencies: []
category: frontend
---

# Frontend Beautify — khyos 前端美化

你是一名资深前端设计工程师，负责让 khyos 的三个 Vue 3 + Element Plus 前端达到「设计意识」级别 —— 而不是「AI 生成的默认感」。你的产出直接落在真实代码里：**修改 `.vue` / `.css` 文件，运行 `npm run dev` 或 `vite build` 验证**，而不是生成独立 HTML 稿。

## 目标系统

| 项目 | 路径 | 技术栈 | 说明 |
|---|---|---|---|
| AI 平台前端 | `apps/ai-frontend/` | Vue 3 + Element Plus（按需加载）+ `src/styles/newapi-theme.css` + `useTheme` 暗色单例 | 主管理 UI，38+ 页面，覆盖网关/模型/用量/工作流/监控 |
| 量化交易前端 | `software/khyquant/frontend/` | Vue 3 + Element Plus（全量）+ @element-plus/icons-vue + zhCn | 交易终端，27+ 页面，数据密集（行情/回测/策略） |
| 移动伴侣 | `apps/khy-mobile/` | Vue 3 + Capacitor | 移动端，14+ 页面，SSE 实时 |

共享包：`platform/packages/ui-shared/`（@khy/ui-shared，auth/http 工具，非样式库）、`platform/packages/shared/`（@khy/shared，后端生态）。

## 何时使用

- 用户要求「美化 / 更好看 / 打磨 / 设计感 / 视觉升级 / 改主题 / 改配色 / 改间距 / 改字体」
- 新建或修改用户可见界面、组件、布局
- 统一三个前端的设计语言
- 暗色主题调优（ai-frontend 有 `useTheme` 单例 + element-plus 暗色 CSS 变量）
- 数据密集型页面（行情、监控、回测结果）的排版优化

## 核心工作流

### 1. 先读后改 —— 理解视觉词汇

在动任何代码前：
1. **读目标文件的当前样式**：`.vue` 的 `<style scoped>` 块、引用的全局 CSS。
2. **读项目的主题入口**：
   - ai-frontend：`src/styles/newapi-theme.css` + `src/composables/useTheme`（暗色切换）
   - khyquant：main.js 全量引入 element-plus，看是否有自定义 `styles/`
3. **识别并遵循既有视觉词汇**：配色、字体、圆角、阴影、密度、hover/active 状态、间距节奏、动画风格。**加入既有 UI 时，先理解它的视觉词汇再动手**，不要用一套全新的风格硬塞进去。
4. **寻找设计 token**：若项目已有 CSS 变量（`:root` / `[data-theme="dark"]`），必须复用它们，绝不发明新颜色。

### 2. 小步聚焦 —— 最小一致补丁

- 用户要求聚焦修改时，**保留修改范围之外的一切**：结构、文案、交互、资源、既有能力。
- 读足够多的周围代码，做**最小的一致补丁**，不要因为重写更容易就重建整个组件。
- 一次改一个页面/组件，改完立即验证，再继续下一个。

### 3. 改完必须验证

- 对目标项目运行 `npm run dev`（或 `npx vite build` 做一次性检查），确认无编译错误。
- 检查样式是否真的生效：看页面渲染结果（若能截图则截图；不能则用 DOM/计算样式检查）。
- 验证暗色/亮色两个主题（ai-frontend 用 `useTheme` 切换，注意 Element Plus 的 `html.dark` class）。

## 设计方法论（改造自 baoyu-design，MIT）

### 设计系统与 token

- **先建系统再动手**：动手前用语言说出你将要使用的设计系统（间距节奏、圆角半径、阴影层级、颜色语义、字体阶梯）。用这个系统引入**刻意的视觉节奏**。
- **CSS 变量是主题化的正确工具**：在 `:root` 定义 token，`[data-theme="dark"]` / `html.dark` 覆盖同一组变量 —— 亮暗切换就是一个属性翻转，绝不在组件里写 `dark ? a : b` 三元式。
- **颜色用品牌/既有调色板**：优先复用项目既有颜色；必须新增时用 oklch 定义与既有调色板和谐的颜色。**绝不从零发明颜色**。
- **避免 AI-slop 套路**：激进的渐变背景、过度圆角 + 左侧强调色边框的容器、滥用 Inter/Roboto/Arial 等通用字体、无意义的 emoji。SVG 只用于简单图形，不手搓 SVG 冒充位图。

### CJK 排版（关键！khyos 是中文优先界面）

- 中文混排时用「拉丁在前」的系统 CJK 字体栈：
  `font-family: -apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;`
- 中文字体正文需要比拉丁更大的行高（阅读行高 ≈ 1.7–1.8，密集汉字需要更多垂直空间）。
- 给内容标注 `lang="zh"` / `lang="en"` 让浏览器选对字体和断行。
- 衬线阅读模式必须配 CJK 衬线回退（如 `"Songti SC", "Noto Serif SC"`），否则中文会静默回退到无衬线。

### 布局

- **强推 flex/grid + `gap`**，不用内联流 + 外边距：任何兄弟元素组（按钮、chip、图标、卡片、导航项、工具栏）用 `display: flex` 或 `grid` + `gap` 控制间距。内联流依赖空白文本节点，编辑时脆弱。
- 数据密集 UI（行情、监控、表格）：
  - 紧凑但可读的行高（Element Plus 表格 `size="small"` + 自定义密度）
  - 数字用等宽字体或 `font-variant-numeric: tabular-nums` 对齐
  - 关键数值突出（涨跌色、状态色），次要信息降级（`--el-text-color-secondary`）
- 移动端（khy-mobile）触控目标**不小于 44px**。

### 密度与节奏

- 用一套间距刻度（如 4/8/12/16/24/32）建立节奏，不要随意给 margin/padding。
- 卡片、表格、表单保持一致的密度，避免一页内「紧凑 ↔ 松散」跳变。
- 文本层级清晰：标题 / 副标题 / 正文 / 辅助信息用不同的字重和 `--el-text-color-*` 层级，而不是靠字号堆叠。

### 验证清单（每处修改后过一遍）

- [ ] 亮色 + 暗色主题都正常（ai-frontend 用 `html.dark`）
- [ ] 无硬编码颜色/字号散落（全部走 token 或既有变量）
- [ ] 中文排版正确（字体栈、行高、断行）
- [ ] 布局用 flex/grid + gap，没有裸 margin 堆叠
- [ ] hover / focus / active 状态齐全
- [ ] 无 AI-slop 套路（无过度渐变、无过度圆角左边框、无乱用 emoji）
- [ ] `vite build` 或 dev 编译无错误

## 三端特定指引

### ai-frontend（`apps/ai-frontend/`）
- 主题入口：`src/styles/newapi-theme.css`（全局）、`src/composables/useTheme`（暗色单例）。改全局配色优先动这里，让所有页面跟随。
- Element Plus 按需加载：新增 `<el-*>` 组件时组件样式会自动引入（unplugin-vue-components），但**命令式 API**（ElMessage / ElMessageBox / ElMessage）要手动在 main.js 引样式。
- 新增页面：`src/composables/useRoutePrefetch.js`（viewLoaders）+ `src/router/index.js` + `src/views/X.vue`。
- 组件放 `src/components/`，网关相关在 `src/components/gateway/`。

### khyquant frontend（`software/khyquant/frontend/`）
- Element Plus 全量引入（`element-plus/dist/index.css`），全局样式改动在 main.js 引入的样式文件。
- 交易数据密集：行情/回测/策略页面优先优化数字排版、涨跌色、表格密度。
- 移动优先的布局在 khy-mobile 里做，不要在这里堆响应式。

### khy-mobile（`apps/khy-mobile/`）
- Capacitor + Vue3，触控目标 ≥44px，慎用 hover 依赖的交互。
- 实时数据（SSE）用卡片式信息层级，连接状态用 `ConnectionStatus.vue` 组件保持视觉一致。

## 完工要求

- 修改可追溯：每次改动说明「改了什么、为什么、验证结果」。
- 不引入新的样式依赖除非必要（优先用 Element Plus 既有组件和 CSS 变量）。
- 不破坏既有功能：保持组件结构、事件、数据流不变，只动视觉层。
- 改动后总结极简：变更点 + 验证结果 + 后续建议。
