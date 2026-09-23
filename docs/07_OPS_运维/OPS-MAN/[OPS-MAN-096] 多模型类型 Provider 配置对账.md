# [OPS-MAN-096] 多模型类型 Provider 配置对账

> 本文件由 `node scripts/model-type-providers.js --gen-doc` 生成，请勿手改。

## 解决的问题

Khy 对四类用户可见模型分别在**互不相通的 env 命名空间**里解析 provider：

| 类型 | 解析路径 | 中转/直连可见性 |
| --- | --- | --- |
| 文本 text | apiKeyPool + providerPresets + gateway pool | 无 |
| 视频 video | `KHY_VIDEO_GEN_*`（在 provider 注册表之外）+ pool bridge | 无 |
| 向量 vector | `EMBED_URL` / ollama / gateway `/v1/embeddings` | 无 |
| 角色 role | `subAgentModelSelect`（复用文本池，`KHY_SUBAGENT_MODEL_AUTOSELECT`） | 无 |

陌生机器上的用户想给不同类型配不同 API（中转站或直连）时，没有任何单一入口能回答：
“哪几类模型已就绪，各自是怎么接线的？”本工具就是这个入口。

## 用法

```bash
node scripts/model-type-providers.js            # 人类可读表格
node scripts/model-type-providers.js --json     # 机器 JSON（非全就绪 exit 2）
node scripts/model-type-providers.js --gen-doc  # 重新生成本文件
```

## 判定语义（纯叶 `scripts/lib/modelTypeProviderPlan.js`）

- `channel` 仅由 base URL 主机对比 `providerPresets` 官方 SSOT 主机名判定：
  loopback → `local`；主机 ∈ 官方名单 → `direct`（直连）；其它公网主机 → `relay`（中转站）。
- `configured` 需要可用凭据路径：有 key，或本地后端（本地无需 key）。
  有 base URL 但无 key → `keyless`（非就绪）。
- 输入畸形/破损 → 全部判为未配置，**绝不抛异常、绝不伪造就绪**。
- 本工具只读凭据**存在性**（布尔），绝不读取或打印 key/token 值（红线）。

## 相关

- SSOT：`services/backend/src/services/gateway/providerPresets.js`（官方/合作/中转 preset）
- 自定义 provider 注册：`services/backend/src/services/customProviderRegistrar.js`
- 能力分桶：`services/backend/src/services/gateway/modelCapability.js`

