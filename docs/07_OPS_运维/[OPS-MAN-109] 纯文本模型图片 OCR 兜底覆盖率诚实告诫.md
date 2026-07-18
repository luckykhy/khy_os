# [OPS-MAN-109] 纯文本模型图片 OCR 兜底覆盖率诚实告诫

> 状态:已实现(未提交,待用户点头)。承接 [OPS-MAN-104] 低置信诚实告诫,补**正交**的第二条诚实维度。
> 门控:`KHY_OCR_COVERAGE_NOTICE`(default-on,`0/false/off/no` 关 → 逐字节回退)。

## 一、背景与缺口(/goal 2026-07-12)

当运行模型为**纯文本 / 非多模态**、且识图模型不可用时,khy 落到本地 OCR 兜底,把提取到的文字
当作「请据此作答」的权威依据注入 prompt。gateway 三处注入点都以:

```js
extractImageOcrDetails(images, { maxImages: 3, maxChars: 1200 })
```

提取。其中 `aiGateway.js` 的实现对图片做 `images.slice(0, maxImages)` —— **第 4 张起被静默丢弃**,
无计数、无标记;此外部分图片(纯照片 / 场景图 / 缺字库)会**提取不到文字**,在这批明细里静默消失。

于是模型收到 `【图片1】【图片2】【图片3】` 三块并被告知「以下为图片 OCR 识别文本,请据此作答」,
却以为这就是全部。用户发了 5 张、其中 2 张读不出时,模型基于**残缺**输入自信作答而毫不知情——
这正是「silent truncation reads as covered everything」反模式:上限已在代码里生效,却从不向作答的
模型披露被截断 / 被丢弃了什么。

**与 OPS-104 的正交关系**:OPS-104(`ocrConfidenceCaveat`)管**准确性**——识别出的字可能是错的;
本条(`ocrCoverageNotice`)管**完整性**——注入的文本可能没覆盖全部图片。二者是同一 consumer
(OCR 注入点)上两条互相独立的诚实轴,可同时出现、互不替代。

## 二、修复(全 additive,逐字节可回退)

### 纯叶 `services/backend/src/services/gateway/ocrCoverageNotice.js`

- `computeCoverage({ totalImages, ocrTextCount, maxImages })` → 纯算术推出
  `{ total, cap, attempted, withText, omitted, unreadable }`;非法输入一律夹紧到 0,绝不抛。
  - `attempted = cap>0 ? min(total, cap) : total`
  - `omitted = cap>0 ? max(0, total - attempted) : 0`(超上限、从未尝试的图)
  - `unreadable = max(0, attempted - withText)`(已尝试但无文字的图)
- `buildCoverageNotice({ totalImages, ocrTextCount, maxImages, env })` → 覆盖缺口存在时渲染一句
  诚实告诫,否则返回 `null`。门关 / 无缺口(`omitted<1 && unreadable<1`)/ 异常 → `null`。
- 门 `KHY_OCR_COVERAGE_NOTICE`(default-on),登记于 `flagRegistry.js`(与 sibling
  `KHY_OCR_LOW_CONFIDENCE_CAVEAT` 并列)。

### 接线 `services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

新增助手 `_appendOcrCoverageNotice(prompt, { totalImages, ocrTextCount, maxImages })`(fail-soft),
在**三处** OCR 注入点、紧随 `_appendOcrLowConfidenceCaveat` 之后、`_appendVisionKeyOffer` 之前追加:

1. 失败总结分支(全部视觉候选失败后剥图 + OCR 兜底);
2. `ocr-fallback` 分支(当前 provider 无任何视觉候选);
3. adapter 级联分支(适配器不支持图像时的 OCR 辅助)。

`totalImages` 取注入时仍完整的输入图片数(`options.images.length` / `adapterOptions.images.length`,
均在清图之前读取),`ocrTextCount` 取已提取到文字的条数,`maxImages` 为该处字面量 `3`。
**不改** `extractImageOcrDetails` 本身。

## 三、诚实边界(B2/B3)

- 只在**真有覆盖缺口**时告诫;干净的单图 / 全覆盖 → 不告诫,逐字节回退,绝不对每一次完整提取误报。
- `unreadable` 只统计「已尝试但无文字」,不把超上限未尝试的图重复计入(那归 `omitted`)。
- 全部读不出(`withText===0`)时注入分支根本不跑本告诫,由 `visionOcrFallback.buildVisionUnreadableNote`
  兜底,故本条与其**不重叠**。
- 纯装饰:不改成败归属、不改剥图 / 清图不变量;任何异常 fail-safe 视为「不告诫」,绝不抛。

## 四、验收

```
npm run test:ocr-coverage-notice     # 叶 15/15 + 接线 4/4
node --check services/backend/src/services/gateway/ocrCoverageNotice.js
node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js
```

接线端到端(真实 `gateway.generate`,DI 解耦 totalImages 与 ocrTextCount):

- 发 5 张、仅 3 张有文本 → prompt 含「共 5 张 / 另有 2 张未做识别 / 并未覆盖全部图片」;
- 发 3 张、仅 2 张有文本 → prompt 含「1 张图片未能提取到文字」,无 omitted 段;
- 干净单图 → **无**覆盖告诫(无误报);
- 门关 → 逐字节回退,即便超上限也不注入。
