# [DESIGN-FE-003] 前端快速参考卡（实测对齐版）

> 一页速查 khy-os 网页端规范。**只收录代码中真实存在的东西**——每项都能在下注的路径里找到。细则真源：`[DESIGN-FE-001]`；IA 真源：`[DESIGN-ARCH-080]`。

---

## 两个前端与共享层

| 应用 | 路径 | 特点 |
|------|------|------|
| ai-frontend | `apps/ai-frontend/` | Vue3 + Vite5 + Element Plus + Pinia + axios；@vue-flow、xterm |
| khyquant-frontend | `software/khyquant/frontend/` | 同基座 + Capacitor(Android) + PWA + sass + lightweight-charts |
| @khy/ui-shared | `platform/packages/ui-shared/` | 共享 http/auth 原语（无 UI 组件），子路径导入 |

两前端**不得互相 import**；共用逻辑只能下沉 `@khy/ui-shared`。

---

## 设计令牌速查

**真源文件**：`apps/ai-frontend/src/styles/newapi-theme.css`（`:root` 浅色 + `html.dark` 深色，尾部是 Element Plus `--el-*` 映射）。

```css
/* 表面 */
var(--khy-bg-main)      /* #f4f7fc 页面底 */
var(--khy-bg-elevated)  /* 卡片/浮层 */
var(--khy-bg-soft)      /* #eff4ff 浅填充 */
/* 文本四级 */
var(--khy-text-main)  var(--khy-text-strong)
var(--khy-text-secondary)  var(--khy-text-muted)
/* 线条 */
var(--khy-border)  var(--khy-border-light)
/* 品牌与状态 */
var(--khy-primary)        /* #2f7ef7 */
var(--khy-primary-strong) var(--khy-primary-soft)
var(--khy-success)  var(--khy-warning)  var(--khy-danger)
/* 几何 */
var(--khy-radius)     /* 12px */   var(--khy-radius-sm)  /* 8px */
var(--khy-radius-lg)  /* 16px */
var(--khy-shadow)  var(--khy-shadow-lift)
/* 字体 */
var(--khy-font)       /* Public Sans 栈 */
var(--khy-font-mono)  /* JetBrains Mono 栈：Key/ID/模型名 */
/* 骨架屏 */
var(--khy-skeleton-base)  var(--khy-skeleton-highlight)
```

**纪律**：
- 新样式一律 `var(--khy-*)`，禁字面量 hex（扫存量：`npm run frontend:fix-colors`）；
- 新 token 必须 `:root` + `html.dark` **成对定义**；
- 间距/字号**没有 token**——间距用 4px 倍数（8/12/16/24），正文 14px、页标题 20px；不要引用不存在的 `--khy-space-*`；
- `--khy-accent*` 紫色族只用于浮动球等品牌场景；
- ⚠️ `--khy-white` 当前被引用但未定义（缺口 G1），收敛前写 `#fff` 以外的表面色请用 `--khy-bg-elevated`。

---

## 组件速查

**基座是 Element Plus，不要重新封装。** 不存在 `KhyButton/KhyInput/KhyCard`，需要按钮就 `el-button`（颜色随 `--el-*` 映射自动跟主题）。

| 共享组件（真实存在） | 用途 |
|------|------|
| `KhyPageHeader` | 管理页顶部：标题+描述+右侧操作区 |
| `KhyEmpty` | 空态：标题+描述+操作插槽 |
| `KhyIcon` | 统一图标出口 |
| `LoadErrorBanner` | 区块加载失败内联条（配 `api/loadError.js`） |
| `GlobalProgressBar` | 全局 HTTP 进度条（自动，axios 拦截器驱动） |
| `KhyFloatBall` | 品牌浮动球 |

- 新组件：跨 ≥2 页复用才进 `components/`；`Khy` 前缀只给通用壳；`<script setup>` + props validator + `scoped` 样式 + 全 token。
- 可复用逻辑抽 composable 进 `src/composables/`（`use*.js` 现状 26 个）。
- khyquant 移动端独立交互 → 造 `Mobile*` 变体（`MobileLayout`/`MobileNav`/`MobileToast` …），触控 ≥44px。

---

## API 与服务发现速查

**零硬编码**：端点只能来自 env / 运行时 JSON / `serviceDefaults.js`。

```js
// 标准调用（ai-frontend 模板）
import request from '@/api/request';   // axios 实例：30s 超时、GET 网络错误重试一次、
const data = await request.get('/api/channels');          // 401 自动跳登录、失败集中 toast
const data2 = await request.get('/api/x', { silent: true }); // 自带降级 UI 时抑制 toast
```

- `baseURL`：生产留空（同源，后端托管 `dist/`）；dev 设 `VITE_AI_API_BASE_URL`（**必须带 `/api` 前缀**）。
- dev proxy 目标由 `backendDiscovery.mjs` 发现：显式 env → `ai_manage_runtime.json` 的 `apiPort` → 端口 env → 兜底 `127.0.0.1:9090`（镜像 `serviceDefaults.js`）。
- 端口真源：`services/backend/src/constants/serviceDefaults.js`（`BACKEND_PORT=3000`、`WEB_FRONTEND_PORT=8090`）。
- 流式对话走原生 `fetch()`（`api/authedFetch.js`），不经 axios，不受 30s 限制；WS 超时走 `VITE_AI_WS_*` env，必须空闲重置式。
- api 文件分工：`request.js`(实例) / `authedFetch.js`(流式) / `unwrap.js`(错误解包) / `notify.js`(toast) / `loadError.js`(区块错误) / `daemonProbe.js`(探活)。

---

## 页面与导航速查

- 用户高频路由无前缀（`/login` `/chat` `/home`）；管理页一律 `/admin/*`，不再产生新裸路径。
- **加页面 = 只改 `src/nav/index.js`**（`NAV` 数组派生侧栏/路由/页标题），并补 `nav.wiring.test.js` 类 wiring test。
- 布局壳只有 `AuthenticatedLayout` 一套；无独立 admin shell、无第二套登录。
- 命名：运维者侧 `auth/login/session`；上游 Key 侧统一 `channel-apis`，文案禁裸写「凭证」。

---

## 状态与文案速查

| 场景 | 做法 |
|------|------|
| 全局加载 | GlobalProgressBar（自动） |
| 区块加载 | 骨架屏（`--khy-skeleton-*`） |
| 空态 | `KhyEmpty`：没什么 + 如何有 + 入口按钮 |
| 区块错误 | `LoadErrorBanner`：`{问题}：{原因}，{修复建议}` |
| toast | 统一走 `api/notify.js`，禁止裸 `ElMessage.error('出错了')` |

文案红线：`加载中…`❌ → `加载渠道列表（第 2 次重试）…`✅；`请求失败`❌ → `限流 (429)：请求过多，稍后重试或运行 khy gateway config 切换通道`✅。

---

## 响应式 / 主题 / 性能

- 断点：`<640` / `640–1023` / `≥1024`；khyquant 布局间距用 `clamp()`（见 `theme.css`）。
- 暗色：`useTheme.js` 切 `html.dark`；PR 前双主题自查（表面分层、文本对比、投影量级）。
- 性能：路由懒加载默认；重组件（Vue Flow/xterm/K线）异步 chunk；预取走 `useRoutePrefetch`；体积门 `npm run check:frontend-size`（基线只降不升）。

---

## 常用命令

```bash
npm run test:frontend                  # ai-frontend vitest
npm run check:frontend-size            # 体积基线门禁
npm run frontend:fix-colors            # 预览硬编码颜色（:apply 修复）
npm run frontend:fix-var               # CSS 变量声明检查（:apply 修复）
npm run frontend:cleanup-console       # console 残留清理
node scripts/ci/check-agent-rules.js --changed   # 全仓红线
npm run lint                           # 各前端目录内（error 硬 0）
```

---

## 已知缺口（只降不升，细则见 FE-001 §12）

G1 `--khy-white` 引用 24 次 0 定义 ｜ G2 khyquant 悬空 `--khy-*` 引用 ｜ G3 khyquant 双轨命名 ｜ G4 fix-colors 映射未定义灰阶 ｜ G5 间距/字号无 token ｜ G6 虚构组件库文档已标注

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本（含虚构组件与令牌） |
| 2.0.0 | 2026-09-09 | 重写为实测对齐版：只收录代码中真实存在的令牌/组件/命令 |

---

*本参考卡由 khy-os 前端方向维护*
