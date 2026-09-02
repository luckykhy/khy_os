# khyos 三个前端项目指引

本文档描述 khyos 三个前端的**项目结构、文件定位、典型改动点**，供 frontend-beautify skill 在美化时快速定位。

## 1. AI 平台前端（apps/ai-frontend）

### 结构
```
apps/ai-frontend/src/
├── main.js                  # 入口：引 EP 暗色 css-vars + newapi-theme.css + useTheme
├── styles/
│   └── newapi-theme.css     # ★ 设计 token 真源（--khy-* 亮暗双主题）
├── composables/
│   ├── useTheme.js          # ★ 暗色单例（html.dark 切换）
│   ├── useRoutePrefetch.js  # ★ viewLoaders（新增页面的 SSOT）
│   └── useUserGateway.js    # 个人网关数据
├── router/index.js          # 路由表（新增页面两处：viewLoaders + 这里）
├── views/                   # 38+ 页面
├── components/
│   └── gateway/             # 网关相关组件（含 CcSwitchCard.vue）
├── api/
│   └── request.js           # axios 封装
└── utils/safeStorage.js
```

### 典型美化改动点
- **全局配色/主题**：`styles/newapi-theme.css` 的 `--khy-*` token。改一处全站跟随。
- **暗色细节**：`html.dark` 覆盖块。所有新增颜色必须同时给亮暗两版。
- **页面级**：`views/X.vue` 的 `<style scoped>`（用 `--khy-*` 变量，不写死色值）。
- **组件级**：`components/gateway/*.vue` 等。

### 常用页面速查
| 页面 | 文件 | 风格要点 |
|---|---|---|
| 个人网关 | `views/MyGateway.vue` | tabs + 卡片 + 表单，含供应商卡片 |
| AI 网关管理 | `views/AIGateway.vue` | 管理面板、表格密集 |
| 用量日志 | `views/UsageLogs.vue` | 表格 + 统计 |
| 监控 | `views/AIMonitor.vue` | 实时流、状态面板 |
| 工作流 | `views/WorkflowEditor.vue` | 画布（VueFlow） |
| 桌面壳 | `views/KhyOsDesktop.vue` / `KhyOsTerminal.vue` | 终端 + 窗口 |

### 验证
```bash
cd apps/ai-frontend && npx vite build   # 无编译错误
cd apps/ai-frontend && npm run dev      # 目视检查
```

## 2. 量化交易前端（software/khyquant/frontend）

### 结构
```
software/khyquant/frontend/src/
├── main.js                  # 全量引入 EP + 图标 + zhCn
├── router/index.js          # 路由（/dashboard /trading /strategies /backtest ...）
├── views/                   # 27+ 页面
├── components/
├── services/
│   └── websocketService.js  # 实时行情
├── assets/
│   └── markdown.scss
└── utils/errorMessage.js
```

### 典型美化改动点
- **交易数据密集**：`views/Trading.vue`、`views/MarketQuotes.vue`、`views/BacktestDetail.vue`。
  - 数字用 `tabular-nums` 对齐。
  - 涨跌语义色：`#079455` 涨 / `#d92d20` 跌（对齐 ai-frontend 语义）。
  - 表格 `size="small"`。
- **回测结果**：`views/BacktestAnalysis.vue`（图表 + 指标卡）。
- **管理后台**：`views/Admin*.vue`（用户/系统/日志）。

### 验证
```bash
cd software/khyquant/frontend && npx vite build
cd software/khyquant/frontend && npm run dev
```

## 3. 移动伴侣（apps/khy-mobile）

### 结构
```
apps/khy-mobile/
├── capacitor.config.ts      # Capacitor（appId: com.khyos.companion）
├── src/
│   ├── styles.css           # ★ 全局样式（暗色设计：#0b1118 底 + #68d5c0 强调）
│   ├── App.vue
│   ├── views/               # 14+ 页面
│   ├── components/
│   │   └── ConnectionStatus.vue  # 连接状态（视觉一致源）
│   ├── api/                 # client/sse/secureSession/runtime/status/trading
│   └── layouts/
└── android/                 # Capacitor Android 壳
```

### 既有设计语言（必须遵循）
- 背景 `#0b1118`（深蓝黑），表面 `#111a24`，边框 `#243241`。
- 强调色 `#68d5c0`（青绿），正文 `#e9eef5`，次要 `#8ca0b5`。
- 顶栏 sticky + 底部 5 格 nav，内容宽 `min(760px, 100%)`。
- 触控目标 ≥ 44px。

### 典型美化改动点
- 全局：`src/styles.css` 的 `:root` token 与 `.topbar`/`.bottom-nav`/`.shell-content`。
- 实时页：`views/TradingHubView.vue`、`views/ApprovalsView.vue`（审批卡片）、`views/TasksView.vue`。
- 连接状态：统一用 `ConnectionStatus.vue`。

### 验证
```bash
cd apps/khy-mobile && npx vite build
# 真机/模拟器：npm run dev + Capacitor（可选）
```

## 跨端统一注意

- 三个前端**各自独立**，没有共享样式包（ui-shared 只含 auth/http 工具）。美化时保持各端既有设计语言一致即可，不必强求三端像素级相同。
- ai-frontend 与 khyquant 都基于 Element Plus：优先用 EP 既有组件 + CSS 变量，少写自定义样式。
- khy-mobile 是纯自定义样式（非 EP），遵循它自己的暗色 token。
