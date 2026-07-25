<!-- 文档分类: OPS-MAN-003 | 阶段: 运维 | 原路径: docs/指南/ai-管理-访问与登录.md -->
# KHY AI 管理页访问与登录说明

本文档用于统一 `khyguanli` 入口行为、登录方式和故障排查流程。

## 1. 入口命令（推荐）

在 `khy` 交互终端内，以下命令等价：

- `khyguanli`
- `guanli`
- `aiguanli`
- `/login`（先登录 CLI，会用于管理页免登录桥接）

在系统 Shell 中，推荐：

```bash
khy guanli
# 或
khy gateway manage open
```

## 2. 打开逻辑（已统一）

`gateway manage open`（含 `khyguanli`）按以下顺序执行：

1. 先探测主站管理页：`/admin/ai-gateway`
2. 主站未就绪时，自动回退到独立 AI 管理会话（daemon）
3. daemon 启动成功后输出前端/API 地址与登录提示

可用 `--daemon` 强制走独立会话：

```bash
khy gateway manage open --daemon
```

如果你不想依赖 `ai-frontend` 开发服务（或在 Windows/macOS 上本地 `npm run dev` 不稳定），可直接指定静态构建目录：

```bash
khy gateway manage open --daemon --frontend-dist-dir /absolute/path/to/dist
```

慢机器或首次预热时，可增加启动后健康等待窗口（默认约 18 秒）：

```bash
khy gateway manage open --daemon --wait-ms 30000
```

CLI 登录桥接规则：

- 若 CLI 已登录且存在服务端会话 token：`khyguanli` 打开后将自动写入管理页会话并直达页面
- 若 CLI 未登录（或仅本地离线登录）：将进入管理页登录页
- CLI 可用 `/login` 执行登录
- 若 CLI 显示“本地离线登录态”，可再次执行 `/login` 补充服务端登录态（用于 `khyguanli` 自动免登录）

## 3. 登录方式

### 3.1 用户名/密码模式（JWT）

- 默认管理员账号：`admin`
- 默认密码：`admin123`
- 历史安装可能是 `admin123.`，系统兼容迁移后会统一为 `admin123`

若忘记密码，执行：

```bash
# 在源码目录直接重置（推荐）
node services/ai-backend/scripts/reset-admin-password.js --password admin123

# 或 npm 脚本
npm --prefix services/ai-backend run reset-admin
```

如果你是 Docker 部署，执行：

```bash
docker compose exec ai-backend node scripts/reset-admin-password.js --password admin123

# 若使用自定义 compose project 名称（例如 khy-os）
docker compose -p khy-os exec ai-backend node scripts/reset-admin-password.js --password admin123
```

### 3.2 Token 模式（AI_MGMT_AUTH_TOKEN）

如果设置了 `AI_MGMT_AUTH_TOKEN`，登录口只接受 token：

- `username=任意, password=<token>`，或
- `username=<token>, password=任意`

此模式下不会走数据库用户名/密码校验。

## 3.3 登录后的界面与身份切换（新增）

- 登录成功后统一先进入**用户视图**（`/home`）
- 普通用户：
  - 可使用用户首页与 AI 对话
  - 访问管理员页面会自动回到用户首页
- 管理员用户：
  - 顶部提供“用户/管理”切换开关
  - 切到“管理”后进入管理视图菜单（总览、网关、桥接渠道、账号池、资产与客户、监控）
  - 可随时切回用户视图

## 4. 状态检查（先查这个）

```bash
khy gateway manage status
```

重点看三项：

- API 健康：`/api/health` 是否可达
- 前端地址是否可达
- 是否提示“服务未完全就绪”

若未就绪，建议：

```bash
khy gateway manage stop
khy gateway manage start --daemon
```

如需手动指定前端来源：

```bash
# 开发目录（会尝试 npm run dev）
khy gateway manage open --daemon --frontend-dir /absolute/path/to/ai-frontend

# 静态目录（直接由 API 服务托管页面）
khy gateway manage open --daemon --frontend-dist-dir /absolute/path/to/dist
```

并检查日志：

- `~/.khy/logs/ai_manage_daemon.log`
- `~/.khy/logs/ai_frontend_dev.log`

## 5. 常见登录失败与定位

### 5.1 用户名或密码错误（401）

- 确认是否在 JWT 模式（未设置 `AI_MGMT_AUTH_TOKEN`）
- 优先尝试 `admin / admin123`
- 不行就执行 `node services/ai-backend/scripts/reset-admin-password.js --password admin123` 重置

### 5.1.1 页面是旧版独立栈（8090/9090）时

- `GET /api/health` 返回 `service: khy-ai-backend` 说明当前是旧版独立栈
- 该栈现在也兼容历史 `admin123.` 登录并会自动迁移到 `admin123`
- 若历史密码是随机值，必须跑重置脚本后再登录

### 5.2 页面能打开但点击登录无响应/提示网络错误

- 多数是前端可达但 API 不可达
- 先跑 `khy gateway manage status` 看 API 健康
- 前端已加入网络抖动重试（GET 请求自动重试 1 次）
- 仍持续报错时，优先检查：
  - `docker compose ps ai-backend ai-frontend`
  - 访问地址是否为 `http://127.0.0.1:18090`

### 5.2.1 CLI 可对话、网页不可对话（新增）

若 CLI 正常但网页 `AI 对话` 报 `Network Error`，通常是两套服务不在同一链路：

- CLI 可能在使用主进程 AI 通道
- 网页（尤其 `8091` 开发口）依赖 `gateway manage` 管理守护后端

处理步骤：

```bash
khy gateway manage stop
khy gateway manage start --daemon
khy gateway manage status
```

确认 `status` 中 API 与前端均可达后，再刷新页面重试。

### 5.3 提示 JWT_SECRET 缺失

- 检查 `.env` / `services/backend/.env` 是否配置 `JWT_SECRET`
- 修改后重启管理会话

### 5.4 前端旧 token 干扰

- 在登录页重新登录前，先退出并刷新页面
- 必要时清理浏览器 localStorage 后重试

## 6. 前端体验补充

登录页已提供以下中文友好能力：

- 一键填充默认管理员账号按钮
- 常见错误中文映射（401、账号未激活、JWT_SECRET 缺失、后端不可达）
- 登录请求 401 不再被全局拦截强制跳转，确保错误提示可见

## 7. 给其他应用按渠道签发 API Key（新增）

适用场景：管理员希望把已接入模型开放给 Claude Code / Codex / Kiro / OpenCode 等外部应用调用。

操作路径：

1. 登录后切到管理视图
2. 打开 `资产与客户`
3. 选择目标客户（建议 `自动共享 API` 或你新建的客户）
4. 点击 `按渠道签发`
5. 在弹窗中设置：
   - 选择渠道（支持桥接渠道 + 直连模型供应商渠道）
   - `每渠道数量`（默认 `1`，可增大）
   - `已存在处理`：跳过 / 追加
6. 执行后会按渠道批量签发；默认可实现“每渠道 1 个 key”
7. 如需主备，可把 `每渠道数量` 设为 `2`

接口说明（兼容单发）：

- `POST /api/ai-gateway/customers/:id/tokens`
- 支持请求体 `count` 字段（默认 `1`）
- `count > 1` 时返回 `tokens[]`；`count = 1` 时保持历史单对象返回格式

## 8. 网关来源「四类配置模式」总览（按来源选配置路径）

KHY 网关内部注册了 **16 个适配器**（`services/backend/src/services/aiGateway.js` `_adapters` 数组，`:1359-1380`）。新手不必逐家记忆——按**来源类型**归成四类，每类只有一条配置路径：

| 模式 | 适配器 | 怎么配 | 入口命令 |
| --- | --- | --- | --- |
| **① 登录态导入** | kiro / cursor / trae（含别名 antigravity / nirvana）/ windsurf / warp | 复用这些 IDE/CLI 本地已有的登录态，导入账号池 | `khy pool import <provider>` |
| **② 订阅登录态** | claude / codex / vscode | 走各自的本地订阅登录；Claude 可一键拉起 | 本地登录 / `khy claude` |
| **③ API-Key 直连** | api / relay_api（及自定义 OpenAI 兼容 provider） | 填 API Key，可用内置预设 prefill | `khy gateway config` / `khy gateway add` |
| **④ 本地 / 中继** | ollama / localLLM / cli / relay / clipboard | 本地模型自动探测；中继/剪贴板按需启用 | `khy gateway detect`（本地） |

各模式的深入配置路径：

- **模式 ①（登录态导入）**——把 Kiro/Cursor/Trae/Windsurf/Warp 的本地登录态汇成账号池，支持多账号自动调度与多租户分享，详见 [OPS-MAN-045] 账号池与多租户-深度指南。最常用：

  ```bash
  khy pool import kiro      # 从本地 Kiro 登录态导入
  khy pool status           # 看池子整体状态
  ```

- **模式 ②（订阅登录态）**——claude / codex / vscode 用各自的本地订阅登录态。Claude Code 可用 `khy claude` 一键零残留拉起（混合模式见 [OPS-MAN-004] claude-code-代理配置）：

  ```bash
  khy claude --list         # 列出当前可用模型后退出
  khy claude                # 用 KHY 网关拉起 Claude Code
  ```

- **模式 ③（API-Key 直连）**——任意 OpenAI 兼容服务（DeepSeek / Qwen / GLM / Agnes 等）填 API Key 接入。内置预设可自动 prefill base URL/模型，自定义 preset 机制详见 [OPS-MAN-032] 网关-自定义provider配置-agnes：

  ```bash
  khy gateway add           # 选预设或手动填，交互式接入
  khy gateway config        # 改已有池的 key / endpoint
  ```

- **模式 ④（本地 / 中继）**——本地 Ollama / localLLM 由 `gateway detect` 自动探测；relay（手动中转）/ clipboard（剪贴板桥接）按需启用：

  ```bash
  khy gateway detect        # 探测本地可用模型（Ollama 等）
  ```

> 统一查看与测试（与上面四类无关，任何时候都可用）：
>
> ```bash
> khy gateway status                 # 适配器总览（支持 --json / --provider <name>）
> khy gateway test <adapter>         # 对某个适配器做一次连通性探活
> khy gateway model                  # 切换当前模型
> ```

实现出处：`services/backend/src/cli/handlers/gateway.js`（`config` `:2457` / `detect` `:4063` / `status` `:1654` / `test` `:4164`）；适配器分类来源 `pool.js:23`、`builtinProviderConfig.js:33-43`、`providerPresets.js:49-62`。
