<!-- 文档分类: OPS-MAN-011 | 阶段: 运维 | 原路径: docs/指南/khy-os-学习指南.md -->
# KHY OS 学习文档（中文）

本文档面向想快速理解 KHY OS 代码结构、技术栈和可扩展点的人。

## 1. 学习目标

你可以从这份文档了解：

- KHY OS 的整体分层
- 可以使用哪些技术开发、扩展和测试
- 各类功能对应的关键目录和入口
- 推荐的学习顺序

## 2. 技术栈总览

| 层级 | 技术 | 用途 | 关键目录 |
|---|---|---|---|
| 启动层 | Python、pip、setuptools | 启动 CLI、处理首次初始化、打包分发 | `platform/khy_platform/`、`setup.py`、`pyproject.toml` |
| 核心运行时 | Node.js、Express | CLI 分发、HTTP 服务、后台逻辑 | `services/backend/` |
| 数据层 | Sequelize、SQLite、PostgreSQL | ORM、数据库访问、迁移与 seed | `services/backend/src/config/`、`services/backend/src/models/` |
| AI 网关 | axios、ws、jsonwebtoken、bcryptjs、ioredis、node-cron | 统一模型适配、认证、会话、调度 | `services/backend/src/services/gateway/` |
| 主前端 | Vue 3、Vite、Pinia、Vue Router、Element Plus、Axios | 交易 UI、管理界面、交互层 | `software/khyquant/frontend/` |
| AI 管理前端 | Vue 3、Vite、Pinia、Element Plus、Axios | AI 管理页、网关控制台 | `apps/ai-frontend/` |
| 部署 | Docker、docker compose、Bash、PowerShell | 本地/容器部署、验收与发布 | `docker-compose.yml`、`services/backend/Dockerfile`、`software/khyquant/frontend/Dockerfile`、`services/ai-backend/Dockerfile`、`apps/ai-frontend/Dockerfile` |
| 测试 | Jest、curl、Shell 脚本 | 单元测试、冒烟测试、质量检查 | `unit_tests/`、`API_tests/`、`scripts/ci/` |

## 3. 推荐学习顺序

### 3.1 先看整体

1. `README.md`
2. `docs/07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md`
3. `docs/03_DESIGN_设计/[DESIGN-ARCH-010] 核心架构.md`

### 3.2 再看启动链路

1. `platform/khy_platform/_bootstrap.py`
2. `platform/khy_platform/cli.py`
3. `services/backend/bin/khy.js`
4. `services/backend/src/cli/router.js`
5. `services/backend/src/cli/aliases.js`

### 3.3 再看业务核心

1. `services/backend/src/services/gateway/aiGateway.js`
2. `services/backend/src/services/gateway/adapters/`
3. `services/backend/src/services/aiManagementServer.js`
4. `services/backend/src/routes/`

### 3.4 再看前端与部署

1. `software/khyquant/frontend/src/`
2. `apps/ai-frontend/src/`
3. `docker-compose.yml`
4. `setup.py`
5. `docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md`

## 4. 你可以直接用到的技术

如果你要扩展这个项目，常见可用技术如下：

- Python：启动器、打包、脚本、自动化
- JavaScript：CLI、后端服务、前端逻辑
- Vue 3：页面组件与视图
- Vite：前端开发和构建
- Express：HTTP API
- Sequelize：ORM 和数据库迁移
- SQLite / PostgreSQL：数据存储
- Docker / docker compose：容器化部署和测试
- Jest：单元测试
- Shell / Bash / PowerShell：自动化与运维
- WebSocket：实时通信
- Redis / node-cron：缓存、队列、调度
- axios：请求层
- Element Plus：UI 组件库

## 5. 适合练手的扩展点

### 5.1 CLI 扩展

适合学习：命令路由、别名、参数解析、格式化输出。

对应目录：

- `services/backend/src/cli/commandSchema.js`
- `services/backend/src/cli/aliases.js`
- `services/backend/src/cli/handlers/`
- `services/backend/src/cli/router.js`

### 5.2 AI 适配器扩展

适合学习：适配器模式、统一接口、失败回退。

对应目录：

- `services/backend/src/services/gateway/adapters/`
- `services/backend/src/services/gateway/aiGateway.js`

### 5.3 前端页面扩展

适合学习：组件化、状态管理、页面路由、接口请求。

对应目录：

- `software/khyquant/frontend/src/`
- `apps/ai-frontend/src/`

### 5.4 测试与质量门禁

适合学习：单元测试、API 冒烟、CI 门禁、发布前自检。

对应目录：

- `unit_tests/`
- `API_tests/`
- `scripts/ci/`

## 6. 学习时最重要的概念

- `khy` 是平台入口，不是单一应用
- `khyquant` 是兼容入口
- 首次启动会自动做 bootstrap
- 管理页可能从主站回退到独立会话
- pip 包只保留运行所需边界，不包含大模型文件
- 目录存在不等于文件必须存在，某些目录只保留占位

## 7. 入门练习建议

1. 给一个现有命令加一个别名
2. 增加一个新的 gateway adapter
3. 给一个服务补一条 Jest 测试
4. 给 `ai-frontend` 加一个页面
5. 修改 `setup.py` 后重新打包验证

## 8. 相关文档

- `docs/07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md`
- `docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md`
- `docs/05_TEST_测试/[TEST-RPT-002] khy-os-测试指南.md`
- `docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md`
