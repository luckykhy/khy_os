<!-- 文档分类: OPS-MAN-001 | 阶段: 运维 | 原路径: docs/指南/ai-快速通道.md -->
# KHY AI 快速通道（AI Fast Lane）

## 目标

给任何 AI 一个统一入口，用最少上下文先理解 KHY 项目，避免每次任务都全仓扫描。

## 60 秒认知

1. 启动入口是 `khy`，Python 启动器在 `platform/khy_platform/cli.py`。
2. 业务核心在 Node.js：`services/backend/`。
3. 命令分发在 `services/backend/src/cli/router.js`，具体逻辑在 `services/backend/src/cli/handlers/*`。
4. AI 网关与管理页主链路在：
   - `services/backend/src/cli/handlers/gateway.js`
   - `services/backend/src/services/aiManagementServer.js`
   - `services/backend/scripts/ai-manage-daemon.js`
   - `services/backend/src/services/changeRegressionGate.js`（低级模型改动回归门禁入口，兼容旧 `bugfixRegressionGate.js`）
5. 管理前端在 `apps/ai-frontend/`（Vue + Vite），入口桥接在：
   - `apps/ai-frontend/src/main.js`
   - `apps/ai-frontend/src/router/index.js`

## AI 最小必读路径（按顺序）

1. `AGENTS.md`
2. `README.md`
3. `platform/khy_platform/cli.py`
4. `services/backend/bin/khy.js`
5. `services/backend/src/cli/router.js`
6. `services/backend/src/cli/handlers/gateway.js`
7. `services/backend/src/services/aiManagementServer.js`
8. `services/backend/scripts/ai-manage-daemon.js`
9. `apps/ai-frontend/src/main.js`
10. `apps/ai-frontend/src/router/index.js`

## 常见任务快速定位

- 命令不生效 / 走错分支：`services/backend/src/cli/router.js`
- 网关模型选择 / 管理页启动失败：`services/backend/src/cli/handlers/gateway.js`
- 管理 API / WebSocket / 登录态：`services/backend/src/services/aiManagementServer.js`
- 守护进程超时 / 空闲回收 / 前端进程：`services/backend/scripts/ai-manage-daemon.js`
- 管理页闪烁 / 路由异常 / 保活桥接：`apps/ai-frontend/src/main.js`, `apps/ai-frontend/src/router/index.js`
- 低级模型修复/新增后质量变差：`services/backend/src/services/changeRegressionGate.js`, `services/backend/src/services/agenticHarnessService.js`

## 标准交接模板（复制给 AI）

```text
你现在维护 KHY-OS。
先阅读以下文件（按顺序）再开始改动：
1) AGENTS.md
2) docs/07_OPS_运维/[OPS-MAN-001] ai-快速通道.md
3) services/backend/src/cli/router.js
4) services/backend/src/cli/handlers/gateway.js
5) services/backend/src/services/aiManagementServer.js
6) services/backend/scripts/ai-manage-daemon.js
7) apps/ai-frontend/src/main.js
8) apps/ai-frontend/src/router/index.js

要求：
- 遵守 AGENTS.md 工程规则
- 仅做最小必要改动
- 给出验证命令与结果
```

## 命令入口

- `khy docs ai-fastlane`：打开本快速通道并生成上下文包（`~/.khy/ai_fastlane_context.md`）。
- `khy docs ai-fastlane copy`：一键复制上下文包到系统剪贴板（同时落盘到本地文件）。
- 菜单入口：`menu -> 教程文档 -> AI 快速通道`。
