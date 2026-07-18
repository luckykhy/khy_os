# [OPS-MAN-140] OCR **成功读出**但模型仍谎称「没收到图」的确定性纠正脚注

> 承 [OPS-MAN-138] 空 OCR 剥图路径的确定性纠正 —— 补其**镜像格**。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

OPS-138 已封住「空 OCR(读不出文字)+ 模型否认收到图」这一格。本轮沿同一 consumer(finishResult 成功侧
脚注族)找**正交镜像格**:

- **OCR 成功读出文本**(`_ocrImageTextRead === true`,文本已注入 prompt)、
- 模型**却仍在正文否认**收到图(`当前对话中没有任何图片附件` 等)。

这一格恰好落在两条既有脚注的**判据盲区**之间:

| 判据 | 脚注 | 覆盖 |
| --- | --- | --- |
| `_ocrImageTextRead === true` | ocrUsageFootnote(OPS-126) | 只在**模型没否认**时说「用了 OCR」 |
| `_ocrFallbackApplied && !_ocrImageTextRead` | 空 OCR 变体(OPS-138) | 只覆盖**读不出**路径 |
| **`_ocrImageTextRead === true && 模型否认`** | **无** | **本轮补** |

更糟的是:该格 `ocrUsageFootnote`(aiGatewayGenerateMethod.js:858)**照旧触发**,追加一句
「以上关于**这张图片**的内容是通过本地 OCR 读取的」——可模型正文明明否认了图片存在,「以上关于这张图片的
内容」**不成立**,那句脚注既**自相矛盾**又**不纠正否认**。用户看到:「当前对话中没有任何图片附件」+ 一句
自相矛盾的脚注,零确定性纠正。含字截图(如 khy 自身 UI 截图,OCR 必读出)正是这一格。

## 二、外科修复(B3 只动该动的,全 additive)

**单一真源门**:`KHY_VISION_DENIAL_CORRECTION_OCR_READ`(default-on,与父门
`KHY_VISION_DENIAL_CORRECTION` 正交独立)。门关 → 逐字节回退到普通 ocrUsageFootnote。

1. **纯叶子扩展** `visionDenialCorrection.js`(承 138 同叶,扩展优于新建):
   - 新增 `OCR_READ_FLAG` / `isOcrReadDenialEnabled(env)` / 独立 `DENIAL_CORRECTION_OCR_READ_MARKER`。
   - `buildDenialCorrectionNote({count,env,ocrTextRead})`:`ocrTextRead === true` → OCR-成功变体
     (「你确实发了图、OCR **已成功读出文字**、是模型没采用、请**据 OCR 文本重新作答**」);缺省 → 空 OCR
     变体(既有措辞逐字节不变)。
2. **接线** `aiGatewayGenerateMethod.js` branch-1(`_ocrImageTextRead` 成功侧块):
   - `detectImageDenial(content)` 命中且子门开 → 追加 OCR-成功变体,置 `_appended = true`。
   - `if (!_appended)` → 落回普通 `ocrUsageFootnote`(**取代而非叠加**,`_appended` 门闩保证同格只追加
     一条脚注 → **减少心灵噪音**)。
   - 门关 / 模型未否认 → `_appended` 恒 false → 普通脚注,逐字节回退历史行为。
3. **门登记** `flagRegistry.js`:`KHY_VISION_DENIAL_CORRECTION_OCR_READ: { mode:'default-on', off:'CANON', default:true }`。

正交四层(全 default-on):prompt 侧底线三门(剥图必留痕)· ocrUsageFootnote(OCR 成功·模型没否认)·
空 OCR 变体(OCR 读空·模型否认)· **OCR-成功变体(OCR 成功·模型仍否认)**。

## 三、验收(B2 没跑过验证不许说修好了)

- 纯叶单测 `visionDenialCorrection.test.js` 24/24(含子门正交、独立 marker、门关 null、变体隔离)。
- 接线单测 `visionDenialCorrectionWiring.test.js` 11/11(子门判据、独立 marker、`ocrTextRead:true`、
  `_appended` 短路、否认优先于普通脚注)。
- **真图 E2E** `visionDenialCorrectionRealImage.test.js` 4/4 0-skip:真 PIL 渲含字 PNG
  (`RECEIPT NO 7788 / PAID USD 4321.00`)→ 真 tesseract 读出 → 注入 prompt → 模型故意否认 →
  断言追加 OCR-成功变体 marker、**取代**普通脚注、原正文保留;子门关 → 落回普通脚注(逐字节回退)。
- 门:`node --check` × 3 源文件 · god-file `wc -l` · flag-registry / leaf-contract / agent-rules ·
  change-safety(positional 闭 map 桥)· maintainer:check · safety 聚合。

## 四、教训

1. **断桥补全靠正交镜像格**:OPS-138 判据 `!_ocrImageTextRead` 恰好把「OCR 成功但模型仍否认」挡在门外;
   补全靠沿同一脚注族找那条被两个判据夹在中间的盲区。
2. **取代而非叠加**:该格普通脚注仍触发且自相矛盾 → 用 `_appended` 门闩**取代**它,同格只留一条脚注,
   直服「减少心灵噪音」。
3. **含字图 OCR-成功场景**:真图渲含字 ASCII → 真 tesseract 读出 → `_ocrImageTextRead=true`;模型 content
   故意否认且不提 OCR(避免命中 ACK 正则)。
