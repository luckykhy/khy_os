# [OPS-MAN-135] 工作流列表载入本页降级 · 不泄漏全局横幅

## 现象（用户复现）

在**代理管理**页顶部出现红色横幅：

> 网络连接异常：无法访问 /api/workflow。请确认 ai-backend 服务可用后重试。

困惑点：用户人在「代理管理」页，该页自身工作正常（订阅 / 代理组 / 出站状态都能读），横幅却提示一个与本页无关的 `/api/workflow`。

## 断桥根因

该横幅是 `apps/ai-frontend/src/api/request.js` 拦截器对**非 silent** 失败请求弹的**全局** `notifyError`（Element Plus `ElMessage`，挂在 `document.body`，与当前路由/页面无关）。

- `/api/workflow`（列表）与 `/api/proxy-egress` 由**同一** daemon（`aiManagementServer.js`）承载，同源同端口。
- 工作流列表载入链：`Workflows.vue onMounted` → `useWorkflow.listWorkflows()` → `request.get('/api/workflow')`。此调用此前**未标 `silent`**，且视图**无本页降级 UI**。
- `request.js` 对网络类失败（无响应：ECONNREFUSED / network error / timeout / ECONNABORTED）先**重试一次**（350ms）再落 `error.userMessage`，请求可在**导航离开工作流页之后**才最终 reject。
- reject 命中 `request.js:95-96` 非 silent 分支 → 全局 `notifyError` → 横幅**渲染在用户当前所在页面**（代理管理页），造成「无关页面弹出 /api/workflow 报错」。

即：横幅并非源自代理页，而是工作流页的一次**导航遗留 / 后端不可达**的列表请求，因未 silent 而把全局提示**跨页泄漏**过来。

## 修复（外科手术式，遵既有约定）

`request.js:88-94` 已明确约定：调用方自带可见降级 UI 时，请求应标 `config.silent === true`，不再叠全局 toast（既有先例：FeatureCatalog 错误态、AgentDashboard 轮询退避）。工作流列表载入本应属于同类，只是漏了。

1. **`useWorkflow.js`**
   - 新增 `loadError` ref（本页可见降级状态），并在 `listWorkflows` 每次开始时清零、失败时落 `err.userMessage / response.data.message / message / '加载工作流失败'`。
   - 列表 GET 改为 `request.get('/api/workflow', { silent: true })` —— 失败不再触发全局 `notifyError`。
   - 导出 `loadError`。
   - 其余写操作（create / put / delete / templates / coze / generate）URL 组装与行为**逐字不变**。

2. **`Workflows.vue`**
   - 解构 `loadError`；表格上方增设 `el-alert`（error，`v-if="loadError"`）+「重试」按钮 `retryLoad`。
   - `onMounted(listWorkflows)` → `onMounted(retryLoad)`，`retryLoad` 内 `listWorkflows().catch(() => {})` 吞掉 rejection，避免未处理拒绝，失败仅落 `loadError` 就地渲染。

失败信息因此**始终限定在工作流页**（inline 报错 + 重试），**永不跨页泄漏为全局横幅**。

## 「不安装二进制是否也能正确代理」——已验证的答复

与本修复**正交**，属代理出站桥子系统（proxy-egress），**已实现且有测试覆盖，无需改动**：

- `proxyConfigService.activateNode` 依 `proxyCoreConfigGen.classifyNodeEgress` 分三路：
  - **direct-connect（http / https）**：节点自身即 CONNECT 代理，**无需 mihomo 内核**，直接写 `HTTP_PROXY` env（被网关 `_proxyTunnel` 消费）即时生效。→ `proxyConfigService.egress.test.js`「direct-connect 可达 → 写 HTTP_PROXY env + egressMode」断言。
  - **core-required（vmess / vless / trojan / ss / ssr）**：需本机内核（门 `KHY_PROXY_CORE`）；门关 / 内核缺失 → **原样透传结构化 guidance，绝不谎报生效**，不写 env。→ 同套件「门关透传 guidance」「内核缺失 core-missing 指引」断言。

结论：**不安装二进制时，http / https（直连型）节点可以正确代理**；raw 协议节点则诚实提示需内核、不会假装已生效。整套 `test:maintainer:proxy-egress` 80/80 绿。

## 验收门（全绿）

- `node --check apps/ai-frontend/src/composables/useWorkflow.js`
- `npm run test:workflow-list-degraded`（`useWorkflow.wiring.test.js` 6/6）
- `npm run build --prefix apps/ai-frontend`（前端构建通过）
- `npm run test:maintainer:proxy-egress`（seam #2 回归 80/80）
- 三守卫 / arch:god / `maintainer:check` / metadata 2-pass

## Footprint

改：`useWorkflow.js`、`Workflows.vue`、`package.json`、`维护映射表.json`
新：`useWorkflow.wiring.test.js`、本 OPS 文档

不 commit（分支 `feat/0.1.104-multi-subsystem-batch`，遵红线 AI 不自动 commit/push）。
