# [DEPLOY-0103] CPA 集成快速指南（与 provider-hub 集成版）

> 为 KhyOS 个人用户设计的 CPA 反代集成方案  
> **核心原则：复用现有系统，避免重复实现**

---

## 一句话总结

**CPA** 作为一个 Provider Card 集成到 ccSwitch 系统，复用现有的 Card、Key Pool、App Writer 机制。

---

## 架构图

```
KhyOS CLI (khy cc-switch) → Provider Card (cc_switch.json)
                                    ↓
                           CPA App Writer (cpaWriter.js)
                                    ↓
                           CPA Adapter (cpaAdapter.js)
                                    ↓
                           CPA Server (http://localhost:8317)
```

---

## 快速开始

### 1. 启动 CPA 服务器

```bash
# 方式一：Docker（推荐）
git clone https://github.com/router-for-me/CLIProxyAPI.git
cd CLIProxyAPI
cp config.example.yaml config.yaml
# 编辑 config.yaml 添加你的账号
docker compose up -d

# 方式二：直接运行
./cli-proxy-api
```

### 2. 添加 CPA Provider Card

```bash
# 通过 CLI 添加卡片
khy cc-switch add \
  --name="My CPA Server" \
  --endpoint="http://localhost:8317" \
  --protocol=openai \
  --apps=cpa

# 或通过 provider-hub UI 添加
```

### 3. 配置 API Key（可选）

```bash
# 添加密钥到池
khy cc-switch key add \
  --provider=cpa \
  --key=your-api-key \
  --label="CPA Access Key"

# 绑定密钥到卡片
khy cc-switch update <card-id> --keyId=<key-id>
```

### 4. 应用卡片到 CPA

```bash
# 激活卡片
khy cc-switch apply <card-id> cpa

# 查看状态
khy cc-switch status cpa
```

### 5. 使用 CPA

```bash
# 通过网关使用
khy ai "Hello, world!" --adapter=cpa

# 或在 REPL 中
khy
> /adapter cpa
> Hello, world!
```

---

## CLI 命令速查（复用 cc-switch）

| 命令 | 说明 |
|------|------|
| `khy cc-switch list` | 查看所有卡片 |
| `khy cc-switch add` | 添加 CPA 卡片 |
| `khy cc-switch apply <id> cpa` | 应用到 CPA |
| `khy cc-switch status cpa` | 查看 CPA 状态 |
| `khy cc-switch key add` | 添加密钥 |
| `khy cc-switch key list` | 查看密钥（脱敏） |

---

## 配置文件（复用现有）

### Card 配置 (cc_switch.json)

```json
{
  "cards": [
    {
      "id": "c_xxx",
      "name": "My CPA Server",
      "baseUrl": "http://localhost:8317",
      "protocol": "openai",
      "apps": ["cpa"],
      "defaultModel": "gpt-4"
    }
  ],
  "active": {
    "cpa": "c_xxx"
  }
}
```

### 密钥配置 (api_keys.json)

```json
{
  "cpa": [
    {
      "key": "your-api-key",
      "label": "CPA Access Key"
    }
  ]
}
```

---

## 常见问题

### Q: 为什么复用 ccSwitch 而不新建配置？

**A**: 避免重复实现：
- 存储：复用 `cc_switch.json`
- 密钥：复用 `api_keys.json`
- CLI：复用 `khy cc-switch`
- UI：复用 provider-hub

### Q: CPA 和 New API 有什么区别？

| 维度 | CPA | New API |
|------|-----|---------|
| 定位 | CLI/OAuth → API 桥接器 | 通用 LLM 网关 |
| 上游 | CLI 账号 (Codex/Claude) | 标准 API |
| 计费 | 无 | 有 |
| 适合 | 个人自用 | 团队使用 |

### Q: 如何选择？

- **个人自用 + CLI 开发** → CPA
- **团队统一网关** → New API
- **共享订阅拼车** → Sub2API

### Q: CPA 支持哪些模型？

- Codex (GPT-4, GPT-4o)
- Claude (Claude 3 Opus, Sonnet)
- Gemini (Gemini Pro)
- Qwen (通义千问)
- 等更多...

### Q: 多账号如何轮询？

在 CPA 的 `config.yaml` 中配置多个账号，CPA 会自动轮询。

---

## 文件清单

### 新建文件

| 文件 | 位置 |
|------|------|
| `cpaWriter.js` | `services/backend/src/services/domain/config/ccSwitch/` |
| `cpaAdapter.js` | `services/backend/src/services/gateway/adapters/` |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `constants.js` | 添加 `APPS.CPA` |
| `appWriters.js` | 注册 `cpaWriter` |
| `aiGateway.js` | 注册 `cpaAdapter` |

### 复用文件（无需修改）

| 文件 | 复用内容 |
|------|----------|
| `providers.ts` | Card CRUD、Key Pool |
| `modelCatalog.ts` | 模型目录拉取 |
| `store.js` | ccSwitch 数据存储 |

---

## 下一步

1. 阅读完整设计文档：`docs/03_DESIGN_设计/[DESIGN-CPA-001] CPA 反代集成方案.md`
2. 查看 `cpaWriter.js` 实现
3. 查看 `cpaAdapter.js` 实现
4. 运行测试：`npm run test -- --grep="cpa"`

---

*最后更新：2026-09-11*
