# [OPS-MAN-120] 剥图必留痕：最小诚实底线与「OCR 功能门」解耦

## 背景（承 OPS-118「安全不变量绝不该由装饰门决定去留」，再下一层）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 应落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract）。围绕「准确识别图片」，
前几条诚实轴都在**加固 OCR 路径内部**（置信 104 / 覆盖 109 / 截断 111 / 语言 112 / 方向 115 /
分辨率 116），OPS-118 把「剥图 + OCR + 底线」这段安全代码从**装饰门**（`KHY_VISION_FAILURE_SUMMARY`）
里解耦出来，保证描述级联全失败时**一定到达**兜底。

本条 OPS-120 是**同一类耦合缺陷的更深一层**：即便控制流已可靠到达兜底、且**剥图动作本身是
无条件的**，那句「我收到了图但读不出」的**诚实底线说明**仍被耦合进一个**功能门**——
`KHY_VISION_OCR_FALLBACK`（OCR **功能**开关，而非装饰）。用户一旦把 OCR 功能门关掉，
**图照样被剥离，但连一句留痕都不剩** → 文本模型在毫无「图片存在」上下文下作答 → 再次谎称
「消息里没有附带图片」。

| OPS | 轴 | 层次 |
| --- | --- | --- |
| OPS-MAN-118 | 描述级联全失败 → 可靠到达 OCR 底线（control-flow） | 装饰门解耦 |
| **OPS-MAN-120** | **剥图 ⟹ 必留痕（strip-implies-note）** | **功能门解耦** |

## 断桥

`aiGatewayGenerateMethod.js`（Site 1，describe 级联失败救援）里，OCR 提取为空时进入 else 分支：
先调用 `buildVisionUnreadableNote` 生成「图收到但读不出」底线，再**无条件剥图**。问题在于
`buildVisionUnreadableNote` 受 `KHY_VISION_OCR_FALLBACK`（OCR **功能门**）约束——功能门关闭时
它返回 `null`，于是：

```
剥图（无条件） + 底线说明（null，被功能门吞掉）
= 图被剥走 + 零留痕
→ 文本模型：「我注意到你发了一条结构化提示，但消息里没有附带图片。」
```

根因：**剥图**是安全动作（非视觉模型永不收裸图），**留痕**是与之配对的安全不变量
（绝不谎称没收到图）；两者本应同生同灭，却被拆开——剥图无条件、留痕却挂在 OCR 功能门下。
关闭 OCR 功能 ≠ 允许 khy 对用户撒谎说没收到图片。

## 修复（全 additive · 独立门 `KHY_VISION_STRIP_IMAGE_FLOOR` default-on · 门关逐字节回退）

把「剥图必留痕」的最小底线与 OCR 功能门**解耦**：

1. **纯叶 `gateway/visionOcrFallback.js`** 新增：
   - `isStripImageFloorEnabled(env)`：default-on，仅显式 `0/false/off/no` 关闭；env 经 opts 注入可测。
   - `buildStrippedImageFloorNote({count, env})`：返回**不提 OCR** 的最小诚实底线（复用
     `UNREADABLE_NOTE_MARKER` = `[图像无法读取]`），要求文本模型：① 明确告知「收到图但读不出」、
     **绝不能说没收到图**；② 给出换视觉模型 / 粘贴图中文字的可行方案；③ 绝不臆测图片内容。
     门关或畸形输入 → 返回 `null`，绝不抛。
2. **`aiGatewayGenerateMethod.js`（Site 1，空 OCR else 分支）**：在无条件剥图**之前**，当
   `buildVisionUnreadableNote` 返回 `null`（OCR 功能门关）时，退回 `buildStrippedImageFloorNote`
   的最小底线：
   ```js
   if (!_unreadableNote) {
     try {
       _unreadableNote = require('./visionOcrFallback')
         .buildStrippedImageFloorNote({ count: _imgCount, env: process.env });
     } catch { /* 叶子不可用 → 门关等价,逐字节回退(剥图无痕) */ }
   }
   ```
3. **`flagRegistry.js`**：登记
   `KHY_VISION_STRIP_IMAGE_FLOOR: { mode: 'default-on', off: 'CANON', default: true }`。

**逐字节回退**：`KHY_VISION_STRIP_IMAGE_FLOOR=off` → `buildStrippedImageFloorNote` 返回 `null` →
`_unreadableNote` 仍为空 → 剥图无痕，等同历史行为（把断桥交回，证明纯 additive 解耦）。

## 诚实边界（红线）

- **剥图 ⟹ 必留痕**：只要非视觉模型的裸图被剥离，就至少留下一句「收到图但读不出」，
  无论 OCR 功能门是否开启。
- **底线是安全、OCR 是功能**：安全不变量（绝不谎称没收到图）不再由 OCR 功能门
  `KHY_VISION_OCR_FALLBACK` 决定去留；OCR 功能依旧可独立开关。
- **底线不冒充 OCR**：`buildStrippedImageFloorNote` **刻意不提** OCR——因为此时 OCR 功能门是关的，
  提 OCR 会误导；它只陈述「收到图 + 读不出 + 换视觉模型或粘文字」这一诚实事实。
- **门关即回退**：`KHY_VISION_STRIP_IMAGE_FLOOR=off` → 逐字节还原历史行为（剥图无痕），
  证明本轮改动是纯 additive 的解耦。

## 验证

- 纯叶 + 接线：`node --test services/backend/tests/gateway/visionStripImageFloorWiring.test.js`（8/8）：
  - A) OCR 功能门**关** + 空 OCR + 底线门**开** → **仍**剥图 + 注入最小底线 + 原**文本模型**作答
    ——精确复现并堵死「消息里没有附带图片」幻觉；
  - B) 底线门**关** → **逐字节回退**（剥图无痕，不注入底线）；
  - C) OCR 功能门**开** → 走原 `buildVisionUnreadableNote`（无回归）；
  - D) OCR 有文本 → 注入 OCR 块（无回归）。
- **真实图片核验（`/goal` 要求）**：`visionStripImageFloorRealImage.test.js`（2/2，缺
  tesseract/eng/Pillow 或空白图意外出字时干净 skip）：用 PIL 渲染真 PNG（无字渐变，让**真 tesseract**
  读出空），在 `KHY_VISION_OCR_FALLBACK=off`（**用户功能配置**）下，DI 一个**逐字节镜像生产实现**
  （base64 → `saveBase64ToTemp` → 真 tesseract）的 `extractImageOcrDetails`，断言：修复点注入最小底线
  （`hasFloorNote=true`），图被剥离，`model === 'text-only-model'`；并附门关逐字节回退分支。
- 聚合：`npm run test:vision-strip-image-floor`，并入 `test:maintainer:safety`。

## 教训

OPS-118 的判据是「安全代码被藏进**装饰门**」；本轮再下一层——安全代码（留痕）被藏进**功能门**
（OCR）。两者形式不同、危害相同：关掉一个看似无关的开关，就让 khy 对用户撒谎说没收到图片。
判据 = 找到「**剥图**（安全动作，无条件执行）」与「**留痕**（配对的安全不变量）」被拆成不同生命周期
——一个无条件、一个挂在功能门下；修法 = 用独立 default-on 门把「剥图必留痕」的最小底线解耦出来，
让它在功能门关闭时兜住，同时**刻意不提 OCR**（因为此时 OCR 功能是关的），并保留逐字节回退。
