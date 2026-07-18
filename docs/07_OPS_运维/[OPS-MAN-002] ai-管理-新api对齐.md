<!-- 文档分类: OPS-MAN-002 | 阶段: 运维 | 原路径: docs/指南/ai-管理-新api对齐.md -->
# AI 管理页 NewAPI 对齐说明（对比度 + 配置能力）

## 目标

针对 `new-api-main` 的可读性与配置交互体验，对 KHY 的 AI 管理页面进行两类补强：

1. 页面可读性：提升字体与背景对比度，减少“灰字看不清”问题。
2. 配置能力：补齐 OpenAI-compatible 模型与 API Key 的多格式输入能力，并覆盖密钥池导入。

> 📌 **找「每家 provider 怎么配」？** 本文聚焦管理页的 NewAPI 风格对齐与后端配置能力。若你想按**来源类型**快速选对配置路径（登录态导入 / 订阅登录 / API-Key 直连 / 本地中继四类模式），见 [OPS-MAN-003] §8「网关来源四类配置模式总览」；API-Key 自定义 provider 的预设机制见 [OPS-MAN-032]。

---

## 样式改造范围

### 全局主题

- 新增高对比主题文件：`apps/ai-frontend/src/styles/newapi-theme.css`
- 已在 `apps/ai-frontend/src/main.js` 全局引入。
- 主要改动：
  - 改为 NewAPI 风格浅色基底 + 高对比文本，避免“黑底深灰字”
  - Element Plus 全局颜色变量重写（表格、表单、弹窗、描述列表、统计组件）
  - 提升 placeholder、secondary text、header text 对比度
  - 菜单 hover/active 可见性增强

### 关键页面

- `apps/ai-frontend/src/views/Layout.vue`
  - 顶部导航栏视觉重构（高对比、阴影、边界线）
- `apps/ai-frontend/src/views/Login.vue`
  - 登录卡片、标题、提示文本可读性提升
  - 增加“默认管理员账号填充”按钮（`admin / admin123`）
- `apps/ai-frontend/src/views/AIGateway.vue`
  - 标题、卡片、提示、配置动作区等统一为高对比风格
- `apps/ai-frontend/src/views/AIMonitor.vue`
  - 新增筛选栏（适配器/状态/时间/关键词）
  - 新增自动刷新与详情弹窗（可查看 prompt/response/error/cascade）
- `apps/ai-frontend/src/views/AIChat.vue`
  - 聊天窗、气泡、输入区整体重做为高对比样式
- `apps/ai-frontend/src/views/AIDashboard.vue`
  - 新增总览页（适配器、密钥池、账号池、客户、请求统计、快捷入口、最近请求）

---

## 功能补齐范围

### 1) 模型与 API Key 配置（Hermes/OpenClaw/OpenCode 风格）

前端页面：`AIGateway -> 模型与 API Key 配置`

后端接口：

- `GET /api/ai-gateway/model-config`
- `PUT /api/ai-gateway/model-config`

支持能力：

- Base URL 自动规范化：若缺失 `/v1` 自动补全
- 兼容协议：`openai | anthropic | unknown`
- 动态模型 ID（非固定某个模型名）
- 可选清空 Key（同时清理 `RELAY_API_KEY` / `RELAY_API_KEYS`）

### 2) API Key 多格式解析

后端统一支持以下输入：

- 单 Key：`sk-xxx`
- Bearer：`Bearer sk-xxx`
- KV：`key=sk-xxx` / `token: sk-xxx`
- 多 Key：换行 / 逗号 / 分号分隔
- JSON：数组/对象（含 `key`/`apiKey`/`token`/`keys`/`tokens`）

落地点：

- `PUT /api/ai-gateway/model-config`（模型配置）
- `POST /api/ai-gateway/pool/:provider/keys`（密钥池导入）

密钥池新增行为：

- 一次可导入多个 Key
- 自动跳过重复 Key
- 返回导入统计（成功数/跳过数）

### 3) 新增总览页面（对齐 NewAPI Dashboard 思路）

新增路由：

- `/dashboard`（默认首页）

新增能力：

- 一屏查看关键运营指标（适配器可用数、密钥总量、账号活跃、客户与令牌、请求量、时延）
- 自动刷新开关
- 快捷跳转到网关/账号池/资产客户/监控/对话
- 最近请求列表（快速排查）

涉及文件：

- `apps/ai-frontend/src/views/AIDashboard.vue`
- `apps/ai-frontend/src/router/index.js`
- `apps/ai-frontend/src/views/Layout.vue`

### 4) 监控中心能力增强（对齐 NewAPI 使用日志思路）

- 筛选参数：`provider` / `success` / `since` / `keyword`
- 自动刷新（15s）
- 行点击详情弹窗（请求、响应、错误、级联尝试）

涉及文件：

- `apps/ai-frontend/src/views/AIMonitor.vue`
- `apps/ai-frontend/src/composables/useAIMonitor.js`

### 5) 桥接渠道管理页（Claude/Codex/Kiro/其它中转通道）

新增页面与路由：

- 页面：`apps/ai-frontend/src/views/BridgeChannels.vue`
- 路由：`/bridge-channels`

补齐能力：

- 按渠道管理 Token/API Key（支持多格式、多 Key 导入）
- 渠道级 API Endpoint、标签、优先级编辑
- 渠道默认模型、服务协议（OpenAI/Anthropic/Auto）配置
- 渠道适配器状态展示（是否可用 + 状态说明）
- 覆盖渠道从 `claude/codex` 扩展为：
  - `kiro`
  - `cursor`
  - `trae`
  - `windsurf`
  - `api`（通用 OpenAI-compatible 中转）
  - `relay`（手动中转）
  - `ollama`

后端能力补充：

- `PUT /api/ai-gateway/pool/:provider/keys/:keyId`（编辑 endpoint/label/priority）
- `GET /api/ai-gateway/pool` 返回项新增 `endpoint`

### 6) OAuth Provider 凭据管理（新增）

新增后端接口：

- `GET /api/ai-gateway/oauth/providers`
  - 返回 OAuth provider 能力（是否支持 refresh、是否有 token/revoke endpoint）
  - 返回每个 provider 的注册状态（hasClientId/hasRefreshToken/expiresIn/error）
- `GET /api/ai-gateway/oauth/credentials/:provider`
  - 查询单个 provider 的凭据状态（不返回明文 token）
- `PUT /api/ai-gateway/oauth/credentials/:provider`
  - 保存或增量更新 OAuth 凭据（clientId/clientSecret/refreshToken/accessToken/expiresAt）
- `DELETE /api/ai-gateway/oauth/credentials/:provider`
  - 清除 provider 的 OAuth 凭据
- `POST /api/ai-gateway/oauth/:provider/refresh`
  - 手动触发 token refresh，并返回最新状态

前端桥接页新增 OAuth 面板：

- 列表查看 provider 的 OAuth 状态与能力标签
- 对 `codex/kiro` 等支持 refresh 的 provider 可直接触发刷新
- 支持配置/清除凭据，满足“Claude/Codex/Kiro/其它中转”统一入口管理诉求

---

## 与工程规则一致性

已移除本次变更文件中的 `localhost:port` 硬编码示例，改为环境驱动或通用提示文案，避免违反“零硬编码端点”规则。

---

## 验证记录

已执行：

```bash
node --check services/ai-backend/src/routes/aiGatewayAdmin.js
npm --prefix apps/ai-frontend run build
node scripts/check-agent-rules.js services/ai-backend/src/routes/aiGatewayAdmin.js apps/ai-frontend/src/views/AIGateway.vue apps/ai-frontend/src/views/AIChat.vue apps/ai-frontend/src/views/AIMonitor.vue apps/ai-frontend/src/styles/newapi-theme.css
```

结果：

- 语法检查通过
- 前端构建通过
- 规则检查无 error（存在部分 warning，主要为通用 `loading` 检测提示）
