# [OPS-MAN-134] 视觉级联网络不可达终局诊断（network_unreachable reason class）

> 承 OPS-118 / 120 / 122（model-rejection strip-floor 三站点「剥图必留痕」）。
> 本轮补齐**终局根因诊断**里缺失的第三条正交根因类：**网络不可达（socket hang up）**。
> 直击 /goal 失败转录：视觉端点 `socket hang up` 网络失败后，模型谎称「消息里没有附带图片」/
> 「当前对话中没有任何图片附件」。要求：确保正确落到 OCR 路径，用真实图片核验跑通，
> **无感明显告知用了 OCR，且绝不谎称没收到图**。

## 一、断桥（与 OPS-122 正交：同一 vision→OCR 兜底路径的第三条终局根因类）

`diagnoseVisionExhaustion`（纯叶 `visionExhaustionDiagnostic.js`，早已接线于
`aiGatewayGenerateMethod.js:3315`）把「视觉级联耗尽」翻译成指名道姓的可执行指引，前置到笼统的
「所有 AI 通道均不可用」墙之前。但它此前**只识别两类根因**：

| 根因类 | 触发信号 | reason |
| --- | --- | --- |
| 账号未领取视觉模型 | `404 / model_not_found` | `model_not_provisioned` |
| 账号被限流 | `429 / code 1302` | `rate_limited` |
| 二者叠加 | 404 且 429 | `both` |

而**瞬态网络失败**（`socket hang up` / `ECONNRESET` / `tunneling socket` / `连接被重置` / `连接超时` /
`getaddrinfo` …）**没有对应根因类**。当视觉级联在网络失败上终局耗尽、且终局 OCR **读不出文本**
（照片 / 无字彩块图）时：

- `tryRateLimitOcrRescue`（:3292）虽把 `network` 纳入瞬态类，但 OCR 无文本 → 返回 `null`；
- 落到 `diagnoseVisionExhaustion` → 旧逻辑无 network 根因 → 返回 `null`；
- 于是请求直接甩笼统「所有 AI 通道均不可用」墙，**丢掉了那句诚实交代**：
  「我确实收到了你的图片，但当前网络无法把它送达视觉模型识别 —— 这不是『没收到图』」。

**判据（方法论签名）**：既有诊断把 404 / 429 做成指名道姓根因，唯独**网络不可达**这条恰恰是用户
实测复现路径（`socket hang up`）却缺一条根因类 → 终局墙沉默 → 模型顺势谎称没收到图。

## 二、修复（全 additive · 独立 default-on 子门 KHY_VISION_NETWORK_EXHAUSTION_DIAG · 门关逐字节回退）

修复**完全落在早已接线的纯叶内部**（零 aiGateway 改动）：

- `_NETWORK_TEXT_RE` — 网络签名正则（`socket hang up` / `econnreset` / `econnrefused` / `enetunreach` /
  `ehostunreach` / `etimedout` / `eai_again` / `getaddrinfo` / `socket disconnected` / `network error|failure` /
  `连接(被)重置` / `连接超时` / `无法连接到` / `tunneling socket` / `proxy error|tunnel`）。**故意不匹配裸
  `timeout`**（只认 `etimedout` token），以保住既有「auth + timeout → null」契约。
- `_isNetworkFailure(att)` — `att.errorType === 'network'` 或 error 文本命中上述正则 → true；绝不抛。
- `_networkEnabled(env)` — 读独立子门 `KHY_VISION_NETWORK_EXHAUSTION_DIAG`（default-on，仅
  `0/false/off/no` 关）。子门是父门 `KHY_VISION_EXHAUSTION_DIAG` 的**独立子门**：父门关 → 整个诊断
  返回 null（含 network）；仅子门关 → network 检测逐字节回退为 null，而 404/429 分支照旧。
- `diagnoseVisionExhaustion` 检测循环新增 `networkFailed`，reason 取值扩展为：
  - 单 network → `network_unreachable`（`⚠ 识图失败:视觉通道网络不可达 … 我确实收到了你的图片 …
    这不是「没收到图」` + 检查网络/代理 · 稍后重试 · 或把图中文字粘贴过来我据此如实作答的修复指引）；
  - network + （404 和/或 429）→ `multiple`（逐条列各自根因 + 各自修复）；
  - 无 network 时 `both` / `model_not_provisioned` / `rate_limited` 三分支**逐字节不变**。

## 三、正交性（与 rate-limit OCR 兜底同路不撞）

同一网络终局下，两条路径正交、互补：

- **真文字图** → `tryRateLimitOcrRescue`（`network ∈ _RATE_LIMIT_OCR_ERROR_TYPES`）→ 本地真 tesseract
  读出文字 + 明确告知 `[视觉通道限流·本地 OCR 兜底]` + 发一条实时状态 → 证「无识图模型也准确识别图片」。
- **无字图（OCR 读不出）** → 上者返回 null → 本层 `network_unreachable` 诊断诚实交代收到图但网络不可达
  → 证「绝不谎称没收到图」。

## 四、真实图片端到端核验（/goal 硬性要求）

`services/backend/tests/gateway/visionNetworkExhaustionRealImage.test.js`（PIL 渲真 PNG + 真 tesseract，
缺依赖 skip）：

- **Case A**：真文字图 `INVOICE 1234` + 唯一适配器 `socket hang up`（errorType:network）终局 →
  `res.success === true`，`res.content` 含 `INVOICE`（真识别）+ `[视觉通道限流·本地 OCR 兜底]` 标记，
  实时状态含「本地 OCR」，且**不含**「没有图片」类否认句。
- **Case B**：真无字彩块图 + 同网络终局 + 门开 → `res.success === false`，`res.content` 含「网络不可达」
  + 「确实收到了你的图片」，不含否认句。
- **Case C**：同无字图 + 子门 `KHY_VISION_NETWORK_EXHAUSTION_DIAG=off`（父门开）→ network 前置消失，
  逐字节回退到笼统墙。

## 五、门控

| 门 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_VISION_EXHAUSTION_DIAG`（父门） | on | 关 → 整个终局诊断（含 network）返回 null |
| `KHY_VISION_NETWORK_EXHAUSTION_DIAG`（子门） | on | 关 → 仅 network 检测回退为 null，404/429 分支照旧 |

## 六、验收

```
node --check services/backend/src/services/gateway/visionExhaustionDiagnostic.js
npm run test:vision-network-exhaustion      # 24/24（21 纯叶 + 3 真图）
npm run check:flag-registry
```

## 七、footprint

- 改：`visionExhaustionDiagnostic.js`（network reason class）、`flagRegistry.js`（登记子门）、
  `visionExhaustionDiagnostic.test.js`（+9 network + 1 谓词，21/21）、`package.json`（别名 + safety 聚合）、
  维护映射表.json（area `vision-network-exhaustion`）。
- 新：`visionNetworkExhaustionRealImage.test.js`、本文档。
- **不 commit**（分支 `feat/0.1.104-multi-subsystem-batch`）。
