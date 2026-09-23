# [DEPLOY-0102] CPA + New API 分层架构快速指南

> **核心思路**: CPA 做接入层 → New API 做治理出口

---

## 架构图

```
用户 → KhyOS Gateway → New API (治理) → CPA (接入) → 上游 AI
         ↓               ↓                ↓
    Card 配置        计费/权限/限流     多账号轮询
```

---

## 快速开始

### 1. 部署 CPA (接入层)

```bash
git clone https://github.com/router-for-me/CLIProxyAPI.git
cd CLIProxyAPI
cp config.example.yaml config.yaml
# 编辑 config.yaml 添加账号
docker compose up -d
# 验证: curl http://localhost:8317/v1/models
```

### 2. 部署 New API (治理层)

```bash
git clone https://github.com/Calcium-Ion/new-api.git
cd new-api
cp .env.example .env
# 编辑 .env 配置
docker compose up -d
# 访问: http://localhost:3000 (root/123456)
```

### 3. 配置 New API 渠道

1. 登录 New API 面板
2. 渠道管理 → 添加渠道
3. 配置:
   - 名称: CPA-Codex
   - 类型: OpenAI
   - URL: `http://localhost:8317`
   - 密钥: CPA api-key
   - 模型: gpt-4, gpt-4o

### 4. KhyOS 集成 (等 provider-hub 完成后)

```bash
# 添加 Card
khy cc-switch add --name="New API" --endpoint="http://localhost:3000" --protocol=openai --apps=newapi

# 激活
khy cc-switch apply <card-id> newapi

# 使用
khy ai "Hello" --adapter=newapi
```

---

## 配置映射

| 组件 | 端口 | 配置文件 |
|------|------|----------|
| CPA | 8317 | config.yaml |
| New API | 3000 | .env + Web 面板 |
| KhyOS | 动态 | cc_switch.json |

---

## 数据流

```
khy ai "Hello"
    ↓
KhyOS Gateway (读取 Card)
    ↓
New API (http://localhost:3000)
    ↓ 验证令牌/检查权限/扣费
CPA (http://localhost:8317)
    ↓ 选择账号
上游 (Codex/Claude/Gemini)
    ↓
响应返回
```

---

## 文件清单

### 新建文件 (等 provider-hub 完成后)

| 文件 | 位置 |
|------|------|
| `newApiWriter.js` | `services/backend/src/services/domain/config/ccSwitch/` |
| `newApiAdapter.js` | `services/backend/src/services/gateway/adapters/` |

### 修改文件

| 文件 | 修改 |
|------|------|
| `constants.js` | 添加 `APPS.NEWAPI` |
| `appWriters.js` | 注册 `newApiWriter` |
| `aiGateway.js` | 注册 `newApiAdapter` |

---

## 常见问题

### Q: 为什么分两层？

| 层 | 解决的问题 |
|----|------------|
| CPA | 把 CLI 订阅变成 API |
| New API | 管理谁在用、用多少、怎么计费 |

### Q: 可以只用 CPA 吗？

可以。个人自用不需要计费功能时，直接用 CPA。

### Q: 可以只用 New API 吗？

可以。如果有标准 API Key，不需要 CPA 做协议转换。

### Q: 故障排查顺序？

```
1. curl http://localhost:8317/v1/models (CPA)
2. curl http://localhost:3000/api/status (New API)
3. khy cc-switch list (KhyOS Card)
4. khy ai "test" --adapter=newapi (端到端)
```

---

## 启动顺序

```
1. CPA Server (port 8317)
   ↓
2. New API (port 3000)
   ↓
3. KhyOS Gateway
```

---

*最后更新：2026-09-11*
