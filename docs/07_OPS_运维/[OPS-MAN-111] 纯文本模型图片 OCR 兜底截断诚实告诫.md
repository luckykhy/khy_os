# [OPS-MAN-111] 纯文本模型图片 OCR 兜底截断诚实告诫

> 状态:已实现(未提交,待用户点头)。承接 [OPS-MAN-104] 低置信、[OPS-MAN-109] 覆盖率两条诚实告诫,补**正交**的第三条诚实维度。
> 门控:`KHY_OCR_TRUNCATION_NOTICE`(default-on,`0/false/off/no` 关 → 逐字节回退)。

## 一、背景与缺口(/goal 2026-07-12)

当运行模型为**纯文本 / 非多模态**、且识图模型不可用时,khy 落到本地 OCR 兜底,把提取到的文字
当作「请据此作答」的权威依据注入 prompt。gateway 三处注入点都以:

```js
extractImageOcrDetails(images, { maxImages: 3, maxChars: 1200 })
```

提取。`ocrSnippetService.js` 内部对每张图的 OCR 全文做 `_truncate(text, maxChars)`——**超过
1200 字符的稠密图片(整页文档、长截图、密集表格)尾部被静默裁掉**,只在文本里追加一个内嵌
英文标记 `...[truncated]`。这个标记从不作为结构化信号 `truncated` 离开 service:输出对象里没有
它,`extractImageOcrDetails` 的明细里也没有它。

于是模型收到一段看似完整、实则被砍掉尾部的 OCR 文本,并被告知「请据此作答」。用户发了一张稠密
发票 / 合同 / 长截图时,模型基于**残缺**文本自信作答、把「文本里没提到」当成「事实上不存在」而
毫不知情——又一处「silent truncation reads as covered everything」反模式:截断已在代码里发生,却从不
向作答的模型披露。

**与 OPS-104 / OPS-109 的三条正交关系**(同一 consumer = OCR 注入点上三条互相独立的诚实轴):

| 维度 | 叶子 | 管什么 |
|---|---|---|
| 准确性 | `ocrConfidenceCaveat`(104) | 识别出的字可能是**错**的 |
| 跨图完整性 | `ocrCoverageNotice`(109) | 注入文本可能没覆盖**全部图片** |
| **单图内完整性** | `ocrTruncationNotice`(本条 111) | 单张图的文本可能被**截断了尾部** |

三者可同时出现、互不替代。

## 二、修复(全 additive,逐字节可回退)

### 暴露死字段 `services/backend/src/services/ocrSnippetService.js`

新增 `_truncateInfo(text, maxChars)`:与既有 `_truncate` 产出**逐字节等价**的 text,但额外返回
`{ text, truncated }` 的 `truncated` 布尔。`extractImageOcrSnippet`(同步)与 `extractImageOcrSnippetAsync`
(异步)两个输出点改用它,在结果对象里补 `truncated` 字段。PDF OCR 路径
(`extractScannedPdfOcrSnippet*`)**刻意不动**——不在 gateway 图片热路径上,遵守外科手术式改动。

### 转发 `services/backend/src/services/gateway/aiGateway.js`

`extractImageOcrDetails` 推入明细时补 `truncated: ocrResult.truncated === true`;向后兼容包装
`extractImageOcrTexts` 仍 `.map((d) => d.text)` 不受影响。

### 纯叶 `services/backend/src/services/gateway/ocrTruncationNotice.js`

- `countTruncated(details)` → 统计 `d.truncated === true` 的条数(严格布尔;非数组 / 含 null / 标量 → 0,绝不抛)。
- `buildTruncationNotice({ count, total, env })` → `count >= 1` 时渲染一句诚实告诫,否则 `null`。
  门关 / `count` 非有限 / `count < 1` / 异常 → `null`。`total` 已知时报 `其中 N/M 张`,未知时报 `其中 N 张`。
- 门 `KHY_OCR_TRUNCATION_NOTICE`(default-on),登记于 `flagRegistry.js`(与 sibling
  `KHY_OCR_LOW_CONFIDENCE_CAVEAT` / `KHY_OCR_COVERAGE_NOTICE` 并列)。

### 接线 `services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

新增助手 `_appendOcrTruncationNotice(prompt, ocrDetails)`(fail-soft),在**三处** OCR 注入点、
紧随 `_appendOcrCoverageNotice` 之后、`_appendVisionKeyOffer` 之前追加:

1. 失败总结分支(全部视觉候选失败后剥图 + OCR 兜底);
2. `ocr-fallback` 分支(当前 provider 无任何视觉候选);
3. adapter 级联分支(适配器不支持图像时的 OCR 辅助)。

## 三、诚实边界

- 只在**真有截断**(`countTruncated >= 1`)时告诫;无截断 / 门关 / 畸形 → `null`,逐字节回退,绝不误报。
- 告诫是**装饰**:不改成败归属、不改剥图 / 清图不变量;任何异常 fail-safe 视为「不告诫」,绝不外抛。
- `_truncateInfo` 的 text 与旧 `_truncate` **逐字节等价**——只是把此前只在文本内留痕的截断事实,
  额外提升为一个可被 gateway 消费的结构化布尔。

## 四、验收(全绿)

- 纯叶单测 `ocrTruncationNotice.test.js` 12/12(门控、`countTruncated` 严格布尔、`buildTruncationNotice`
  分母有无、`count<1`/非有限/门关/畸形回 null)。
- 接线端到端 `imageOcrTruncationWiring.test.js` 3/3(真实 `generate()` 走 ocr-fallback,DI 注入
  `truncated:true` → 最终 prompt 含 `其中 1/2 张` + `因长度上限被截断`;无截断不误报;门关逐字节回退)。
- `npm run test:ocr-truncation-notice` 聚合两文件;并入 `test:maintainer:safety`。
- `node --check` 全过;`arch:god` 无新增超限;三守卫 `--changed` 净;`flag-registry` 不误报;
  `maintainer:check` + `metadata` 二次幂等;secret clean。
