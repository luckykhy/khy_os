# [DESIGN-FE-001] 网页端设计规范（实测对齐版）

> **本文是 khy-os 网页端设计规范的单一入口**。与一份「放之四海皆准」的前端模板不同，本文每条规则都锚定在仓库真实文件上：能给出路径的给路径，能给出实测数字的给数字。凡本文与代码现状冲突，以代码为准并登记进 §12「已知缺口表」——缺口只降不升。
>
> **2.0 重写说明**：1.0 版（2026-09-04）是一套泛用模板，描述的 `--khy-space-*` 间距令牌、`KhyButton/KhyInput/KhyCard` 组件、Playwright/Chromatic 工具链在代码中均不存在。本版改为完全从实测出发。

---

## 1. 适用范围与文档分工

### 1.1 两个网页前端 + 一个共享包

| 应用 | 路径 | 层级 | 技术栈（实测自 package.json） | 用途 |
|------|------|------|------|------|
| **ai-frontend** | `apps/ai-frontend/` | L3（平台自带） | Vue 3.4 + Vite 5 + Element Plus 2.5 + Pinia 2 + vue-router 4 + axios；@vue-flow（工作流）、xterm（终端） | AI 平台管理界面 |
| **khyquant-frontend** | `software/khyquant/frontend/` | L4（内置应用） | 同上基座 + Capacitor 8（Android）+ vite-plugin-pwa/workbox + sass + lightweight-charts + marked/dompurify | 量化交易终端（含移动端） |
| **@khy/ui-shared** | `platform/packages/ui-shared/` | L1 共享包 | 纯 JS，无 UI 组件 | 跨前端的浏览器安全原语 |

两个前端**不得互相 import**（ARCH-068 禁止边 `L3 ↔ L4`），共用代码只能下沉到 `@khy/ui-shared`。

### 1.2 本文与相关规范的分工

| 主题 | 真源 |
|------|------|
| 信息架构、路由结构、导航数据化、四个页面重设计 | `[DESIGN-ARCH-080] 网页端信息架构与四页重设计` |
| 可访问性（WCAG） | `[DESIGN-A11Y-001] 可访问性规范` |
| 零硬编码 / 状态文案 / 超时红线（全仓强制） | 根 `AGENTS.md` 工程规则 1–4 |
| 通道选择（前端何时走 Web API / CLI） | `[DESIGN-ARCH-071] 通道选择决策矩阵` |
| 组件 API 目标态（组件库落地后生效） | `[DESIGN-FE-002] 前端组件库规范` |
| 速查 | `[DESIGN-FE-003] 前端快速参考卡` |

本文管的是「两个前端共享的、与代码现状对齐的工程与设计纪律」：令牌、组件分层、API 层、状态文案、主题、质量门。

---

## 2. 共享层：@khy/ui-shared

这是两个前端目前**唯一**的共用代码通道（`"private": true`，按 workspace 引用，不发 npm）。

```
platform/packages/ui-shared/src/
├── http/authHeaders.js      # 鉴权头拼装
├── http/fetchWithTimeout.js # 带超时的 fetch 封装
├── http/response.js         # 响应解包
├── http/errors.js           # isNetworkLikeError 等错误判定
└── auth/  token.js / state.js / guard.js   # 令牌存取与路由守卫
```

**规则**：

1. 浏览器侧可复用的 **逻辑**（无 DOM 依赖的 http/auth 原语）一律放这里，两个前端按子路径导入（`@khy/ui-shared/http/errors`）。
2. 该包**不收 UI 组件**。共享 UI 的归口见 §5——当前共享 UI 的事实标准是「各自实现、视觉对齐」，组件库是目标态而非现状。
3. 改该包必须跑 `node --test tests/**/*.test.js`（包内自带测试）。

---

## 3. 设计令牌系统

### 3.1 唯一真源：`newapi-theme.css`

ai-frontend 的令牌真源是 `apps/ai-frontend/src/styles/newapi-theme.css`（实测 111 个 `--khy-*` 定义，44 个源文件消费）。它的结构即标准结构：

```
:root        → 浅色主题：Surfaces / Text / Lines / Brand / Geometry / Accent / Skeleton
html.dark    → 深色主题：同一组 token 整体重指
同文件尾部   → Element Plus 变量映射（--el-* 全部指向 --khy-*）
```

**双主题机制**（实测）：`html.dark` 类切换由 `src/composables/useTheme.js` 驱动；Element Plus 的 `element-plus/theme-chalk/dark/css-vars.css` 在 `main.js` 中先于本文件导入，因此本文件里的 `--el-*` 覆盖靠源码顺序生效。**新增 token 必须同时在 `:root` 与 `html.dark` 给出两个值**，否则暗色下会静默穿透成浅色。

### 3.2 现行 token 分层（实测值）

| 层 | token（浅色值） | 用途 |
|----|------|------|
| 表面 | `--khy-bg-main: #f4f7fc`、`--khy-bg-elevated`、`--khy-bg-card`、`--khy-bg-soft: #eff4ff`、`--khy-bg-hover` | 页面/卡片/悬浮底 |
| 文本 | `--khy-text-main: #1f2937`、`--khy-text-strong: #101828`、`--khy-text-secondary: #475467`、`--khy-text-muted: #667085` | 四级文字 |
| 线条 | `--khy-border: #d6e0ef`、`--khy-border-light: #e5ebf5` | 边框 |
| 品牌 | `--khy-primary: #2f7ef7`、`--khy-primary-strong: #1f68df`、`--khy-primary-soft: #eaf2ff` | 主色三态 |
| 状态 | `--khy-success: #079455`、`--khy-warning: #dc6803`、`--khy-danger: #d92d20` | 语义色（暗色下整体提亮，见真源文件） |
| 几何 | `--khy-radius: 12px`、`--khy-radius-sm: 8px`、`--khy-radius-lg: 16px`、`--khy-shadow`、`--khy-shadow-lift` | 圆角与投影 |
| 字体 | `--khy-font`（Public Sans 栈）、`--khy-font-mono`（JetBrains Mono 栈，用于 Key/ID/模型名） | 字体族 |
| 品牌点缀 | `--khy-accent: #6d5efc` → `--khy-accent-end: #d946ef` 紫色渐变族 | 仅浮动球等品牌场景，**不做常规 UI 主色** |
| 骨架屏 | `--khy-skeleton-base`、`--khy-skeleton-highlight` | shimmer 动画两色 |

**纪律**：

1. 新代码颜色/圆角/阴影一律 `var(--khy-*)`，禁止写字面量 hex。存量硬编码用 `npm run frontend:fix-colors`（预览）→ `frontend:fix-colors:apply`（执行）收敛。
2. 不新增与 Element Plus 重复的 token：EP 组件的颜色走 §3.1 的 `--el-*` 映射自动跟随主题，不要给 `el-button` 再包一层颜色类。
3. 间距与字号**目前没有 token**（实测 `--khy-space-*`、`--khy-text-*` 不存在，1.0 版文档写的是虚构值）。现状约定：间距用 4px 倍数（8/12/16/24 为主），正文字号沿用 EP 默认（14px），页面标题 20px。何时引入 token 见 §12 缺口表 G5——未引入前禁止在新文档里引用不存在的变量名。

### 3.3 khyquant 端的令牌现状与收敛方向

khyquant 的真源是 `software/khyquant/frontend/src/styles/theme.css`，它是一套**平行命名体系**（`--primary-color`、`--text-primary`、`--spacing-md`），其中若干值写成 `var(--khy-primary)` 等引用——**但 khyquant 全端没有任何 `--khy-*` 定义**（实测 0 处，含 `index.html` 与 `public/`），这些引用当前是无回退的悬空变量。`SimpleTradingInterface.css`、`Trading.css` 里也有同类悬空引用（缺口 G2）。

收敛方向（**只许向这个方向改**）：

- khyquant 新代码直接使用 `--khy-*` 命名；
- 在 `theme.css` 头部补定义所引用的 `--khy-*` 基础值（与 ai-frontend 真源对齐），让存量 `var(--khy-*)` 引用落地；
- 两套命名的映射保留在 `theme.css` 一个文件里，不再扩散到组件内。

### 3.4 暗色主题验收

任何含自定义样式的 PR，提交前必须双主题自查：

```
1. useTheme 切换到 dark，肉眼检查：表面层级是否仍分明（bg-main < bg-card < bg-elevated）
2. 文本四级对比度是否仍可读（muted 不得消失在 bg-main 上）
3. 自定义投影是否过黑（暗色下用真源文件里的 rgba(0,0,0,0.35~0.45) 量级）
```

---

## 4. 页面与信息架构

**IA 真源是 [DESIGN-ARCH-080]**，本文只固化其中已交付的纪律：

1. **路由前缀**：用户高频路由不带前缀（`/login`、`/chat`、`/home`），管理类统一 `/admin/*`。23 个裸路径 → `/admin/*` 的迁移映射见 ARCH-080 附录 A。**新增管理页直接落在 `/admin/*`，不再产生新裸路径。**
2. **导航数据化**：`apps/ai-frontend/src/nav/index.js` 是唯一真源——侧栏渲染、路由表、页面标题查找都从 `NAV` 数组派生。**加页面 = 改这一个文件**，禁止回到「加一页改四处」（路由表、`USER_MENU`、`ADMIN_MENU`、`CACHED_VIEWS`）的旧耦合。
3. **命名纪律**：运维者认证侧统一 `auth`/`login`/`session`；上游凭证侧统一叫 `channel-apis`（沿用 `ChannelApis.vue` / `channelApiCrypto.js`）。UI 文案里说上游 Key 必须带限定词，禁止裸写「凭证/凭据」。
4. **页面骨架**：页面 = `KhyPageHeader`（标题+操作区）+ 内容区。布局壳只有一套 `AuthenticatedLayout`——khyos 不做独立 admin shell、不做第二套登录（7/7 同类项目的共同约束，ARCH-080 §2.1）。

---

## 5. 组件规范

### 5.1 分层：Element Plus 是基座，Khy* 是共享壳

```
┌─ Element Plus（基座，不重新封装）────────────────────────┐
│  el-button / el-input / el-table / el-dialog ...         │
│  颜色由 §3.1 的 --el-* 映射跟随主题，样式零定制优先        │
└──────────────────────────────────────────────────────────┘
┌─ Khy* 共享组件（跨页面复用才造，现状 6 个）───────────────┐
│  KhyPageHeader / KhyEmpty / KhyIcon / KhyFloatBall /     │
│  LoadErrorBanner / GlobalProgressBar                     │
└──────────────────────────────────────────────────────────┘
┌─ 业务组件（views/ 或 components/<domain>/ 内，不加前缀）──┐
│  AgentDashboard、ChannelApis、EnhancedKLineChart ...      │
└──────────────────────────────────────────────────────────┘
```

**铁律：不要用 `KhyButton`/`KhyInput`/`KhyCard` 重新封装 `el-button`/`el-input`/`el-card`。** 1.0 版文档把这三个当成既有组件描述，实测它们在代码中不存在——那是目标态组件库的设想，不是现状。每包一层 EP 基础组件，就多一层属性透传与主题断链风险。FE-002 的组件 API 表只有在组件库真正落地后才生效（其文头有状态标注）。

### 5.2 现有共享组件的职责边界（实测）

| 组件 | 位置（`apps/ai-frontend/src/components/`） | 什么时候用 |
|------|------|------|
| `KhyPageHeader` | `KhyPageHeader.vue` | 每个管理页顶部的标题 + 描述 + 右侧操作区 |
| `KhyEmpty` | `KhyEmpty.vue` | 列表/表格无数据；带标题、描述、操作插槽 |
| `KhyIcon` | `KhyIcon.vue`（附 `KhyIcon.test.js`） | 统一图标出口，不直接在页面里散落 SVG |
| `LoadErrorBanner` | `LoadErrorBanner.vue` | 页面/区块加载失败的内联错误条（配 `src/api/loadError.js`） |
| `GlobalProgressBar` | `GlobalProgressBar.vue` | 全局 HTTP 进度条，由 `useGlobalLoading` 的 `httpStart/httpDone` 计数驱动 |
| `KhyFloatBall` | `KhyFloatBall.vue` | 品牌浮动球（唯一允许使用 accent 紫色族的常规组件） |

khyquant 侧的移动端组件族（`MobileLayout`/`MobileNav`/`MobileToast`/`MobileStrategySelector` 等）遵循同一逻辑：**移动端有独立交互时造 `Mobile*` 变体，而不是在桌面组件里塞媒体查询分支**。

### 5.3 新组件准入与写法

**准入**：跨 ≥2 个页面复用 → 可进 `components/`；只服务单页 → 留在该页目录。`Khy` 前缀只给「跨页面通用壳」，业务组件不戴前缀。

**写法**（与现存组件一致）：

- `<script setup>` + Composition API；props 带 `validator`；emits 显式声明；
- 样式 `scoped`，全部走 `var(--khy-*)`；禁止内联 hex；
- 组件有可复用逻辑就抽 composable 放 `src/composables/`（现状 26 个 `use*.js`，如 `useGateway.js`、`useProjects.js`——这是本仓库前端的既定分层：组件管渲染，composable 管状态与取数）；
- 对外行为（props/emits/插槽）变更时补一个 `*.test.js`（参照 `KhyIcon.test.js`）。

---

## 6. API 层与服务发现（强制）

### 6.1 零硬编码（AGENTS.md 规则 1 的网页端落地）

**端点来源只允许三种**：env 注入 / 运行时 JSON / 服务注册表。源码里出现字面量 host:port 一律违规。

ai-frontend 的实测机制，即标准做法：

| 场景 | 机制 | 真源文件 |
|------|------|----------|
| 生产部署 | **同源**：后端 `server.js` 直接托管 `dist/`，`baseURL` 留空 | `src/api/request.js` |
| dev 调试 | `VITE_AI_API_BASE_URL`（**必须带 `/api` 前缀**），或 Vite dev proxy | `apps/ai-frontend/.env.example` |
| dev proxy 目标 | `backendDiscovery.mjs`：后端端口自愈漂移后，从运行时 JSON 读真实端口 | `apps/ai-frontend/backendDiscovery.mjs` |
| 端口默认值 | `BACKEND_PORT=3000`、`WEB_FRONTEND_PORT=8090` | `services/backend/src/constants/serviceDefaults.js`（唯一真源） |

`backendDiscovery.mjs` 的四级优先级（新增前端需要发现后端时**复刻这个模式**，不要发明第二种）：

```
1. 显式 env（VITE_AI_PROXY_TARGET / VITE_AI_API_BASE_URL）
2. 运行时文件 ai_manage_runtime.json 的 apiPort
   （数据目录优先级：KHY_DATA_HOME → ~/.khy/.location.json 指针 → ~/.khy → ~/.khyquant）
3. 端口提示 env（KHY_DAEMON_PORT / AI_MGMT_PORT）
4. 兜底 127.0.0.1:9090（镜像 serviceDefaults.AI_BACKEND_DEFAULT_URL，改动须同步）
```

**端口韧性**：后端端口被占时必须自动探测下一个可用端口并写入运行时 JSON（而非 `EADDRINUSE` 崩溃），前端 dev proxy 经上面的机制自动跟随——这条链路是「后端自愈、前端跟随」的闭环，不允许在前端写死端口把环断开。

### 6.2 axios 实例纪律（`src/api/request.js` 为模板）

现状即规范，新前端/新实例照此对齐：

- **超时**：单次 REST 默认 30s（`VITE_AI_HTTP_TIMEOUT_MS` 可调）——这属于 AGENTS.md 规则 3 豁免的「短生命周期 fetch 超时」；**流式对话走原生 `fetch()` 不经 axios**，不受此限，长生成不会被误杀。
- **重试**：仅网络类错误（`isNetworkLikeError`，来自 `@khy/ui-shared/http/errors`）且幂等方法（GET/HEAD/OPTIONS）自动重试一次，间隔 350ms。POST 一律不自动重试。
- **计数**：请求/响应拦截器成对调用 `httpStart/httpDone` 驱动 GlobalProgressBar；重试路径有专门的计数平衡保护（改拦截器时不得破坏，见 request.js 内注释）。
- **401**：非登录请求 401 → `userStore.logout()` + 跳 `/login`，不弹 toast（页面随即卸载）。
- **403**：识别管理员文案，改写为「当前账号没有管理员权限，请改用管理员账号登录」。
- **集中报错**：失败请求默认弹一条去重 toast（`notifyError(deriveErrorMessage(error))`）；调用方自带降级 UI 时传 `config.silent = true` 抑制（参照 `FeatureCatalog`、`AgentDashboard` 轮询）。

### 6.3 API 层文件分工（ai-frontend `src/api/`，新模块对号入座）

| 文件 | 职责 |
|------|------|
| `request.js` | axios 实例与拦截器（§6.2） |
| `authedFetch.js` | 流式/非 axios 场景的带鉴权 fetch |
| `unwrap.js` | 后端统一错误格式（code/reason/suggestions）解包 |
| `notify.js` | toast 文案推导与去重 |
| `loadError.js` + `LoadErrorBanner.vue` | 区块级加载失败的内联展示 |
| `daemonProbe.js` | 后端守护进程探活 |

---

## 7. 状态与错误文案（强制）

AGENTS.md 规则 2 全部适用于网页端。网页端特有的落地形式：

### 7.1 加载态三档

| 场景 | 做法 |
|------|------|
| 全局导航/请求进行中 | `GlobalProgressBar`（自动，由 axios 拦截器计数，无需手动调用） |
| 区块加载 | 骨架屏，两色用 `--khy-skeleton-base/highlight`， shimmer 动画 ≤1.5s 周期 |
| 首次启动等待后端 | khyquant 的 `FirstLaunchLoader.vue` 模式：明确显示「正在启动后端服务（第 n 次探测）」而非裸 spinner |

任何加载态文案必须满足**动作 + 目标 + 进度**：`加载渠道列表（第 2 次重试）…` ✅，`加载中…` ❌。

### 7.2 空态与错误态

- 空态统一 `KhyEmpty`：标题说「没有什么」，描述说「如何有」，操作插槽给入口按钮。
- 区块错误统一 `LoadErrorBanner`：遵循错误模板 **`{问题}：{原因}，{修复建议}`**——`加载渠道失败：后端未响应（连接超时），请确认 ai-backend 已启动后重试` ✅，`加载失败` ❌。
- toast 走 `notify.js` 集中出口，禁止在组件里直接 `ElMessage.error('出错了')`。

### 7.3 长任务

AI 对话等流式场景的超时必须是**空闲/滑动超时**（收到分块即重置），配置走 `VITE_AI_WS_IDLE_TIMEOUT_MS` 等 env（见 `.env.example` 的 WS 段）；禁止固定时长硬杀活跃连接。

---

## 8. 响应式与移动端

- **断点**（与现状样式一致）：`<640px` 手机、`640–1023px` 平板、`≥1024px` 桌面。khyquant 的布局间距用 `clamp()` 流式值（`--content-padding: clamp(12px, 2vw, 32px)`，见 `theme.css`），新页面优先沿用这个模式而非堆媒体查询。
- **khyquant 移动端三件套**：`src/styles/mobile.css`（组件级移动适配）、`responsive.css`（布局断点）、`mobile-scroll.css`（滚动行为）。改移动端样式先定位进对应文件，不要在组件里新开第四处。
- **移动端交互变体**：造 `Mobile*` 组件（§5.2），触控目标 ≥44px，输入框字号 ≥16px 防 iOS 自动缩放。
- **Capacitor 打包**：`mobile:sync` / `mobile:apk:debug` 等入口在 `software/khyquant/frontend/package.json`；PWA 更新提示统一用 `PwaUpdatePrompt.vue`，离线提示用 `OfflineIndicator.vue`。

---

## 9. 性能

- **代码分割**：路由级懒加载是默认（`component: () => import(...)`）；重组件（Vue Flow 编辑器、xterm 终端、K 线图）必须 `defineAsyncComponent` 或独立 chunk。
- **体积门禁**：`npm run check:frontend-size`（`scripts/ci/check-frontend-size.js` + `frontend-size-baseline.json`）——与仓库其他基线同一套路，**只降不升**。
- **预取**：路由级预取走 `useRoutePrefetch.js` composable，不在组件里手写 `import()` 预取。
- **图片**：懒加载 `loading="lazy"` + `decoding="async"`；图标优先 SVG/图标库，不引位图图标包。

---

## 10. 可访问性

真源是 `[DESIGN-A11Y-001]`。网页端最低执行线（并入 §13 验收清单）：

1. 交互元素键盘可达，focus 态可见（EP 默认可靠，自定义组件必须补 `:focus-visible` 样式）；
2. 状态变化区（toast、进度）有 `aria-live`；加载区有 `aria-busy`；
3. 文本对比度满足 WCAG AA（正文 ≥4.5:1），双主题各自达标——暗色下 `--khy-text-muted` 对 `--khy-bg-main` 是已知临界项，自查时重点看；
4. 尊重 `prefers-reduced-motion`：骨架屏 shimmer、浮动球动画在该偏好下停用。

---

## 11. 质量门与工具链（全部真实存在）

| 命令 | 作用 | 何时跑 |
|------|------|--------|
| `npm run check:frontend-size` | 前端体积基线门禁（只降不升） | 构建相关 PR |
| `npm run frontend:fix-colors` / `:apply` | 硬编码 hex → CSS 变量 扫描/修复 | 含样式改动时 |
| `npm run frontend:fix-var` / `:apply` | CSS 变量声明问题修复 | 含样式改动时 |
| `npm run frontend:cleanup-console` | 前端 console 调试残留清理 | 提交前 |
| `npm run test:frontend` | ai-frontend 的 vitest | 提交前 |
| `node scripts/ci/check-agent-rules.js --changed` | 全仓红线（硬编码端点/含糊状态/硬超时等） | 提交前 |
| `npm run lint`（各前端目录内） | eslint（ai-frontend 走 `scripts/lint.mjs`，门禁覆盖 `.vue`，error 硬 0、warning 预算只减不增） | 提交前 |

**测试约定**：本仓库前端测试的特色是 **wiring test**（`*.wiring.test.js`，如 `nav.wiring.test.js`、`useProjects.wiring.test.js`）——验证「声明的数据/路由/调用」与「真实接线」一致，而非测渲染像素。新增导航项、新增 API 模块时，同步补对应 wiring test。

---

## 12. 已知缺口登记表（只降不升）

> 这是规范与现状之间的差异清单，性质同仓库其他 baseline：新增缺口视同违规，收敛一条划掉一条。

| # | 缺口 | 实测证据 | 收敛方向 |
|---|------|----------|----------|
| G1 | `--khy-white` 被引用 24 次但 0 处定义（`newapi-theme.css` 自己第 17/18 行也在引用），无回退时背景静默失效 | 全仓搜 `--khy-white\s*:` 零命中 | 在 `newapi-theme.css :root` 补 `--khy-white: #ffffff`（暗色下不变） |
| G2 | khyquant 全端 0 个 `--khy-*` 定义，却有多处 `var(--khy-primary/success/gray-*)` 悬空引用 | `theme.css`、`SimpleTradingInterface.css`、`Trading.css` | 按 §3.3 在 `theme.css` 头部补基础定义 |
| G3 | khyquant 平行令牌命名（`--primary-color` 等）与 `--khy-*` 双轨并存 | `theme.css` 全文 | 新代码只用 `--khy-*`，旧名留在 `theme.css` 单文件映射 |
| G4 | `frontend:fix-colors` 的 COLOR_MAP 目标含 `--khy-gray-*`，该灰阶在任何端都未定义 | `scripts/frontend/fix-hardcoded-colors.js` | 定义灰阶或修映射表，二选一 |
| G5 | 间距/字号无 token，文档曾虚构 `--khy-space-*` | 实测 0 定义 | 如需引入，先改本节后补真源，顺序不可反 |
| G6 | FE-002/FE-003（1.0）描述的 `KhyButton/KhyInput/KhyCard` 不存在于代码 | `components/` 实测清单 | 已加状态标注；组件库落地前以 §5 为准 |

---

## 13. PR 验收清单（网页端改动逐项过）

- [ ] 无端点硬编码：新代码没有字面量 host:port，端点走 env / 运行时 JSON / `serviceDefaults.js`
- [ ] 无颜色硬编码：样式全部 `var(--khy-*)`，`frontend:fix-colors` 预览零新增
- [ ] 新增 token 双主题成对定义（`:root` + `html.dark`）
- [ ] 加载/空/错误三态齐备：骨架屏或进度条、`KhyEmpty`、`LoadErrorBanner`（或 `silent` 降级）
- [ ] 面向用户文案满足「动作+目标+进度」与「问题：原因，修复建议」
- [ ] 新页面已登记 `src/nav/index.js`，管理页落在 `/admin/*`，并补 wiring test
- [ ] 基础交互用 Element Plus 原组件，未新造 `Khy*` 封装基础控件
- [ ] 双主题自查通过；移动端（如涉及）触控目标与输入字号达标
- [ ] `lint` / `test:frontend` / `check:frontend-size` / `check-agent-rules --changed` 全绿

---

## 14. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本（泛用模板，与代码实测脱节） |
| 2.0.0 | 2026-09-09 | 全面重写为实测对齐版：令牌真源锁定 `newapi-theme.css`、组件分层改为「EP 基座 + 6 个真实 Khy*」、补服务发现/API 层/状态文案强制节、建立已知缺口登记表 G1–G6 |

---

*本规范由 khy-os 前端方向维护；与代码冲突时以代码为准并登记 §12 缺口。*
