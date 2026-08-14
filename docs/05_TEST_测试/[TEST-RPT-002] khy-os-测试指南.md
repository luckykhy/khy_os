<!-- 文档分类: TEST-RPT-002 | 阶段: 测试 | 原路径: docs/指南/khy-os-测试指南.md -->
# KHY OS 测试文档（中文）

本文档说明 KHY OS 的测试分层、执行方式、依赖环境和排查思路。

## 1. 测试分类

### 1.1 单元测试

目标：验证核心业务逻辑、任务编排、路由与服务层。

当前主要由以下套件组成：

- `services/backend/tests/services/largeTaskRuntimeStore.test.js`
- `services/backend/tests/services/largeTaskOrchestrator.test.js`
- `services/backend/tests/services/largeTaskWorkerService.test.js`
- `services/backend/tests/routes/largeTasks.route.test.js`

### 1.2 API 冒烟测试

目标：确认后端健康检查和错误路由行为正常。

当前脚本：

- `API_tests/test_health.sh`

### 1.3 静态质量检查

目标：在提交或发布前发现版本、语法和规则问题。

当前检查：

- 版本同步
- Node 语法
- Python 语法
- Agent 规则
- 质量门禁总检

### 1.4 手工验收

目标：验证真实使用路径是否正常，尤其是 Windows 管理页和首次启动流程。

常见验收项：

- `khy doctor`
- `khy gateway status`
- `khy guanli`
- `khy db status`

## 2. 常用测试命令

### 2.1 全量测试

```bash
./run_tests.sh
```

### 2.2 单元测试

```bash
bash unit_tests/run_unit_tests.sh
```

### 2.3 API 冒烟测试

```bash
bash API_tests/run_api_tests.sh
```

### 2.4 静态检查

```bash
npm run check:version-sync
npm run check:node-syntax
npm run check:python-syntax
npm run check:agent-rules
npm run check:quality-gates
```

## 3. 单元测试说明

`unit_tests/run_unit_tests.sh` 会通过 `docker compose run` 在隔离容器中执行测试，默认会重新安装后端依赖并运行 Jest 套件。

因此需要：

- 本机已安装 Docker / Docker Compose
- 后端镜像可构建
- 终端具备 `docker compose` 命令

如果失败，优先检查：

- Docker 是否已启动
- `services/backend/Dockerfile` 是否可正常构建
- 本地是否存在阻塞端口或损坏缓存

## 4. API 冒烟测试说明

`API_tests/test_health.sh` 会检查两件事：

1. `GET /health` 返回 `200` 或 `503`
2. 不存在的路由返回 `404`

默认地址：

- `http://127.0.0.1:${BACKEND_PORT:-13000}`

需要的工具：

- `curl`
- 已运行的后端服务

如果测试失败，优先确认：

- `khy gateway status`
- `docker compose ps`
- `BACKEND_PORT` 是否与实际端口一致

## 5. 推荐测试顺序

### 5.1 提交前

1. `npm run check:version-sync`
2. `npm run check:node-syntax`
3. `npm run check:python-syntax`
4. `npm run check:agent-rules`
5. `bash API_tests/run_api_tests.sh`

### 5.2 发布前

1. `npm run check:quality-gates`
2. `./run_tests.sh`
3. Windows 上手工验证一次 `khy guanli`

## 6. 常见失败定位

### 6.1 单元测试失败

- 查看失败套件日志
- 检查容器内依赖是否安装完整
- 检查测试是否依赖未启动服务

### 6.2 API 测试失败

- 检查后端是否已启动
- 检查端口是否被别的服务占用
- 检查 `/health` 返回体是否仍符合约定

### 6.3 静态检查失败

- 版本不一致时先修复：`platform/khy_platform/__init__.py`、`pyproject.toml`、`services/backend/package.json`
- 语法检查失败时先修复对应文件语法
- 规则检查失败时先修复硬编码、模糊状态文本、超时逻辑等问题

## 7. 相关技术

测试中常用到的技术/工具包括：

- Bash
- Docker Compose
- curl
- Jest
- Node.js
- Python
- GitHub Actions / CI 脚本

## 8. 相关文档

- `docs/07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md`
- `docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md`
- `docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md`
- `docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md`
