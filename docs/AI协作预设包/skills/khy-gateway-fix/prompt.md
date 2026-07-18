# Khy-OS 网关/模型路由排错

网关与模型路由的坑有固定几类。**先对号，再修。** 主战场：
`services/backend/src/services/gateway/aiGateway.js` 与 `modelRouter.js`。

## G1 · 404 / model_not_found —— 模型名泄漏给不认识它的通道

**症状**：`[某通道] 404 ... model=<某模型> | model_not_found`，往往在 auto 模式或通道降级后出现。
**真因**：一个通道把只属于另一个 provider 的模型 id，带给了不认识它的通道（如把 `agnes-2.0-flash` 带给直连 trae.ai 的 relay）。
**修法**：在 `normalizeModelForAdapter` 对该通道做**对称防护**——非本家族模型 → 返 `null` 用默认，别硬塞。用与该 adapter `isLikelyModelId` 对齐的家族正则判断。**别对 api 代理通道乱丢**（它要 honor 路由表）。
**门控**：新增 `KHY_*_MODEL_GUARD`（默认开），关掉逐字节回退。

## G2 · 默认模型硬编码散落

**症状**：改了默认模型只在一处生效，别处还是旧的；或目录里查不到新模型。
**真因**：同一个默认值在 `constants/models.js` / `providerPresets` / `builtinProviderConfig` 多处各写一份。
**修法**：新增门控叶子（如 `KHY_*_LATEST_MODEL` 默认开）在**各消费点**统一收敛；静态 constants 作为门关回退基准别动。

## G3 · 鉴权形态过时

**症状**：`Invalid API key format` 或 401，尤其新版单段 key。
**真因**：还在用旧鉴权方式（如智谱旧版拆 `id.secret` 签 JWT），新版单段 key 直接抛错。
**修法**：门控叶子解析鉴权模式——旧形态 → 旧路径（逐字节回退），新形态 → 原始 Bearer。`KHY_*_RAW_BEARER` 默认开。密钥只进进程内请求头。

## G4 · 请求侧新字段被丢弃

**症状**：模型招牌能力（如 `reasoning_effort`、`thinking`）没生效。
**真因**：`_applyOpenAISamplingParams` / 协议管线只透传老字段，丢了新字段（响应侧读了、请求侧没发）。
**修法**：门控透传新字段（`KHY_OPENAI_THINKING_PASSTHROUGH` 之类），只影响对应协议路径，别波及其它。

## G5 · 视觉模型误判纯文本 → 退回 OCR

**症状**：明明是多模态模型，带图请求却退回本地 OCR。
**真因**：`VISION_NAME_HINTS` 名字提示保守，漏了当代原生多模态族（llama-4/gpt-4.1/glm-4.6v/grok-4…）→ `isVisionCapableModel` 返 false。
**修法**：门控扩展名字提示片段（`KHY_MODERN_VISION_HINTS` / `KHY_GLM_VISION_MODEL` 默认开），精确片段别裸匹配避误伤；`KHY_TEXT_ONLY_MODELS` 恒最高优先。

---

## 通用套路

1. 先定位是哪一类（看报错里的 `通道名 / model / 状态码`）。
2. 找到对应消费点，确认旧路径**哪里漏做/做错**。
3. 写门控纯叶子补正（默认开、严格超集、关掉逐字节回退）。
4. 接线在网关真实路径；跑网关相关单测 + 守卫。
5. 激活 `/khy-honest-closure` 收尾。

**验回退**：`KHY_XXX=off` 跑同请求，行为应与改动前逐字节相同。
