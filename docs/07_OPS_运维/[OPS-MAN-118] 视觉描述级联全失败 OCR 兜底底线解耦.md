# [OPS-MAN-118] 视觉描述级联全失败 → OCR 兜底底线与「失败说明门」解耦

## 背景（前六条都在 OCR 路径**内部**，这条在到达 OCR 路径**之前**）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 应落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract），把图里文字提取出来注入
提示词让文本模型据此作答。围绕「准确识别图片」，前六条轴都在**加固 OCR 路径内部的诚实性**：

| OPS | 轴 | 层次 |
| --- | --- | --- |
| OPS-MAN-104 | 置信度（accuracy） | OCR 路径内 |
| OPS-MAN-109 | 覆盖度（coverage） | OCR 路径内 |
| OPS-MAN-111 | 单图截断（completeness） | OCR 路径内 |
| OPS-MAN-112 | 语言包可用性（language） | OCR 路径内 |
| OPS-MAN-115 | 方向自动校正（orientation·纠正型） | OCR 路径内 |
| OPS-MAN-116 | 低分辨率自动放大（resolution·纠正型） | OCR 路径内 |
| **OPS-MAN-118** | **描述级联全失败 → 可靠到达 OCR 底线（control-flow）** | **OCR 路径之前** |

本条是**上游控制流**轴：前六条都假定「已经落到 OCR 路径」，本条保证在视觉描述级联
（describe-and-return）**全部失败**时，khy **一定到达**剥图 + OCR + 诚实底线，而不会在到达之前
就把读不出的图甩给刚刚失败的视觉模型、让文本模型谎称「没收到图片」。

## 断桥（2026-07-12 用户实测「Khy 无法正确读图」）

用户在一台 Windows 机（`D:\Python312\python.exe`）发图 + 结构化提示：
「请先描述图片中的关键信息，再推断我想完成的目标，并给出下一步可执行操作」。khy 先后尝试
视觉模型 `glm/glm-4.6v-flash`、`glm-4v-flash`，全部 404（`model_not_found`）→ `socket hang up`
网络错误；随后文本模型**幻觉**回复：

> 我注意到你发了一条结构化提示，但消息里没有附带图片。
> 关键发现：当前对话中没有任何图片附件。我无法描述不存在的内容。

根因：`aiGatewayGenerateMethod.js` 里 describe-and-return 级联全失败后，那段
「**剥图 + OCR 兜底 + 『图片确实收到但读不出』诚实底线**」的**安全不变量**代码，被历史地嵌进
`if (_summaryOn)`（`_summaryOn = KHY_VISION_FAILURE_SUMMARY`，一个**纯装饰**的人可见失败说明门）。
当用户把失败说明门**关掉**时，底线被**一并跳过** → 控制流落到 switch 替换，把读不出的图**留着**
改投**刚刚 404 的视觉模型** → 最终文本模型在**毫无「图片存在」说明**下作答 → 于是如实却荒谬地
回「消息里没有附带图片」。**安全底线不该由一个装饰门控开关。**

## 修复（全 additive · 独立门 `KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR` default-on · 门关逐字节回退）

把「安全底线」与「失败说明」**解耦**，各自独立门控：

1. **纯叶 `gateway/visionOcrFallback.js`** 新增 `isDescribeFailFloorEnabled(env)`：
   default-on，仅显式 `0/false/off/no` 关闭；env 经 opts 注入可测，绝不抛。
2. **`aiGatewayGenerateMethod.js`（Site 1，describe 级联失败救援）**：把原来单一的
   `if (_summaryOn) { 发说明 + 底线体 }` 拆成两段——
   - `if (_summaryOn) { 只发人可见失败说明 }`（装饰，维持原样）；
   - `if (_summaryOn || _floorOn) { 底线体 }`（剥图 + OCR 兜底 + 诚实底线，**字节不变**，
     只有守卫条件变了）。
   底线体本身（`extractImageOcrDetails` 提取、OCR 有文本 → 注入 OCR 块 + 六条告诫 + key 邀约 +
     剥图，OCR 无文本 → `buildVisionUnreadableNote` 底线 + 剥图，`hasImageInput=false`、
     `_describeDone=true`）逐字节照旧。
3. **`flagRegistry.js`**：登记 `KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR: { mode: 'default-on', off: 'CANON', default: true }`。

**逐字节回退**：`_floorOn` 关 → `if (_summaryOn || false)` ≡ 原 `if (_summaryOn)`；两门同时关 →
完全等同历史行为（图留着、切到 switch-model 目标）。

## 诚实边界（红线）

- **两不变量强制**：描述级联全失败时，无论失败说明是否展示，都保证「**非视觉模型永不收到
  裸图**」（剥图）且「**绝不谎称没收到图**」（底线注入 `绝不能说没有收到图片`）。
- **底线是安全、说明是装饰**：安全不变量不再由装饰门 `KHY_VISION_FAILURE_SUMMARY` 决定去留；
  失败说明依旧可独立开关，互不牵连。
- **门关即回退**：`KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR=off` → 逐字节还原历史行为（把断桥交回，
  证明本轮改动是纯 additive 的解耦）。

## 验证

- 纯叶：`node --test services/backend/tests/visionOcrFallback.test.js`（25/25，含新门默认开 /
  仅显式关闭 / 畸形不抛 3 例）。
- 接线（断桥闭合）：`visionDescribeFailFloorWiring.test.js`（4/4，自带录制 adapter + DI，
  `KHY_VISION_FALLBACK_MODEL` 钉视觉模型逼出 switch-model、describe-pass 恒返 404）：
  - A) 失败说明**开** + OCR 有文本 → 剥图 + 注入 OCR 文本，原文本模型作答；
  - B) 失败说明**开** + OCR 无文本 → 剥图 + 注入 `[图像无法读取]…绝不能说没有收到图片` 底线；
  - C) **修复点**：失败说明**关** + OCR 无文本 → **仍**剥图 + 底线，由**原文本模型**（非已 404 的
    视觉模型）作答——精确复现并堵死用户的「消息里没有附带图片」幻觉；
  - D) 底线门**关** + 失败说明关 → **逐字节回退**（图留着、切到 `glm-4v-flash`、不注入底线）。
- **真实图片核验（`/goal` 要求）**：`visionDescribeFailFloorRealImage.test.js`（1/1，缺
  tesseract/eng/Pillow 干净 skip）：用 PIL 渲染真 PNG "INVOICE ACME 2026"（对话到达时携 base64），
  在 `KHY_VISION_FAILURE_SUMMARY=off`（**用户失败配置**）下，DI 一个**逐字节镜像生产实现**
  （base64 → 临时文件 → **真 tesseract**）的 `extractImageOcrDetails`，断言：最终**文本模型**
  prompt 命中 `/INVOICE/`（**准确识别**）+ 含「以下为图片 OCR 识别文本」+ 图被剥离 +
  `model === 'text-only-model'`。证明纯文本模型 + 视觉全 404 + 失败说明关下，khy 仍准确读出真图。
- 聚合：`npm run test:vision-describe-fail-floor`（三文件，30/30），并入 `test:maintainer:safety`。

## 教训

安全不变量绝不该由**装饰门**决定去留。前六条诚实轴都在「已经落到 OCR 路径」的前提下加固，
本轮的断桥在**更上游**：一段「剥图 + OCR + 底线」的安全代码被历史地藏进一个纯装饰的失败说明门
（`_summaryOn`），用户一关说明门，安全底线随之蒸发，控制流落到把读不出的图甩给刚 404 的视觉模型，
文本模型于是如实却荒谬地否认收到过图片。判据 = 找到「保证正确性的安全代码」与「纯展示的装饰开关」
被错误地耦合在同一个 `if` 里；修法 = 用独立 default-on 门把安全底线**解耦**出来，让它在描述级联
全失败时**无条件**执行，同时保留装饰门的独立开关与逐字节回退。
