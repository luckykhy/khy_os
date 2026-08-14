# [OPS-MAN-104] 纯文本模型图片 OCR 兜底与低置信诚实告诫

> area: `ocr-fallback-confidence` ·  /goal 2026-07-11
> when: 运行模型是纯文本/非多模态、且识图模型不可用时,khy 如何正确兜底提取图片信息;以及
> OCR 置信度偏低时如何诚实告诫、绝不把误识文字当铁定事实。

## 症状 / 触发场景

- 用户把图片发给 khy,但当前模型不识图(纯文本 / 非多模态),且没有任何可用的视觉模型。
- 期望:khy **不能**把裸图丢给读不懂它的模型,也**不能**静默丢掉用户的图,而应落到本地
  OCR 把图里的文字提取出来注入 prompt,让文本模型据此作答。
- 进阶诚实缺口:OCR 引擎自评置信度偏低(模糊、低对比、非常规字体)时,文本模型仍把注入的
  OCR 文字当成权威事实自信作答,用户拿到一个「基于误识文字」的错误回答却毫不知情。

## 兜底链路(数据流)

```
gateway generate(images, text-only model)
  → decideVisionRouting 判定 keep / switch-model / ocr-fallback (visionRouting.js)
  → ocr-fallback:extractImageOcrDetails(images)           [aiGateway.js]
      → ocrSnippetService.extractImageOcrSnippet(Async)
        → docHelper.py 'ocr' 命令 → tesseract (chi_sim+eng)
  → 剥掉裸图 + 注入「当前模型不支持视觉…OCR 识别结果…请据此作答」块
  → _appendOcrLowConfidenceCaveat:若有正向低置信信号 → 追加诚实告诫
      [aiGatewayGenerateMethod.js → ocrConfidenceCaveat.js]
```

三个注入点(全部经 `extractImageOcrDetails` + 低置信告诫):
1. `ocr-fallback` 分支(无视觉候选)。
2. 视觉级联失败分支(有候选但 404/无 key 不可达)。
3. rate-limit rescue / cascade augment 分支。

## 本轮闭合的死字段(dead-field)

tesseract 的每词置信度会算出平均分:pytesseract 路径据此设
`needsAiFallback = avg_conf < 60`。但这个「质量信号」此前在
`docHelper CLI 路径(硬编码 confidence:0) → ocrSnippetService → extractImageOcrTexts → 注入点`
一路被丢弃。姊妹的 `RecognizeImage` 工具路径(`imageOcr.js`)早已消费 `needsAiFallback`
(打 lowConfidence 标记);gateway 侧却把低置信 OCR 文本原样当权威依据注入 = **非对称**。

本轮补齐:
- **docHelper.py**:`_ocr_via_cli_with_confidence` 用单趟
  `tesseract img outbase -l lang txt tsv` 同时产出**字节等价文本**(outbase.txt)与逐词置信度
  (outbase.tsv);`_mean_tsv_confidence` 只平均严格正的 conf 值,无可用值时返 `None`
  (**绝不伪造分数**)。据此设真实 `confidence` / `needsAiFallback`;无 tsv 时降级为
  `confidence:0, needsAiFallback:false`(**逐字节回退**历史 CLI 契约)。
- **ocrSnippetService.js**:把 `needsAiFallback` 透传进返回对象与缓存 round-trip。
- **ocrConfidenceCaveat.js**(新纯叶子):`isLowConfidence` / `countLowConfidence` /
  `buildLowConfidenceCaveat`。
- **gateway 接线**:`extractImageOcrTexts` 演进为 `extractImageOcrDetails`(带
  `{text, confidence, needsAiFallback}`);`extractImageOcrTexts` 保留为薄委托(字节等价)。

## 诚实边界(B2/B3 纪律 — 关键陷阱)

**只在有正向低置信信号时告诫。** CLI 路径在无 tsv 时 `confidence` 退化为 0(未知)且
`needsAiFallback=false` —— 那是「没测量」而非「测量到低」。判据:

```
isLowConfidence = needsAiFallback===true  OR  (有限 confidence ∈ (0, 60))
```

`0 / 缺失 / 非有限` 且 `needsAiFallback≠true` → **不告诫**(否则每一次干净的 CLI 提取都会
误报低置信)。告诫只是**装饰**:可被门关掉、绝不改变 success/failure 归属、畸形输入绝不抛。

## 门控

`KHY_OCR_LOW_CONFIDENCE_CAVEAT`(default-on,仅 `0/false/off/no` 关)。关 →
`buildLowConfidenceCaveat` 返 `null`,不注入,逐字节回退到「只注入 OCR 文本不带告诫」。

## verify

```
npm run test:ocr-confidence-caveat                                   # 叶子 12/12 + 接线 4/4
node --test services/backend/tests/gateway/imageOcrFallbackRealImage.test.js  # 真图端到端,高置信不误报
python3 -m unittest tests.unit.test_dochelper_ocr_confidence          # _mean_tsv_confidence 数学 6/6
```

## 相关文件

- `services/backend/src/services/gateway/ocrConfidenceCaveat.js`(纯叶子)
- `services/backend/src/services/gateway/aiGatewayGenerateMethod.js`(接线 + `_appendOcrLowConfidenceCaveat`)
- `services/backend/src/services/gateway/aiGateway.js`(`extractImageOcrDetails` + 委托)
- `services/backend/src/services/ocrSnippetService.js`(透传 `needsAiFallback`)
- `services/backend/src/services/docHelper.py`(CLI 路径诚实置信度)
