# [OPS-MAN-126] OCR 成功路径——确定性脚注兜底告知「用了 OCR」

> 承 [OPS-MAN-124]。/goal 送别礼第十二发。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通。本轮延续 [OPS-MAN-124] 的收尾诉求:
**「Khy 无法正确读图降级到 OCR,要能无感*明显*告知用户用了 OCR 但能正确识别图片」**。

[OPS-MAN-124] 已在三处 OCR 成功注入点**无条件**追加一句面向**模型**的指令(门
`KHY_OCR_USAGE_DISCLOSURE`),要求模型在正文里自然、简短地告诉用户「本次用了 OCR」。但那是一条
**建议**——模型完全可以忽略它:

- 模型忽略指令 → 正文对 OCR 只字不提 → 用户全程不知情 → 目标里的「**明显**告知用户」失守。
- [OPS-MAN-124] 没有任何**确定性**保证:披露与否完全取决于模型是否配合。

**关键观察**:网关 `aiGatewayGenerateMethod.js` 的 `finishResult` 成功侧,本就有一整族**确定性**
真值脚注——`answerVerifier`(算式复核)、`modelIdentityTruth`(身份真值)、`cacheMetricsTruth`
(命中率真值)。它们无论模型正文怎么写,都在末尾**确定性**追加真值,保证真相触达用户。**唯独
「本次用了 OCR」这条透明性,没有对应的确定性脚注**。

判据:找到「一条应当确定性触达用户的真相,却只靠一条模型可忽略的指令(OPS-124)传达」的断桥。

## 二、修复(B3 外科手术式改动,全 additive)

独立 default-on 门 `KHY_OCR_USAGE_FOOTNOTE`,与 `KHY_OCR_USAGE_DISCLOSURE` 正交、可各自独立开关。

1. **纯叶** `services/backend/src/services/gateway/ocrUsageFootnote.js`:
   - `isFootnoteEnabled(env)` — 门控,default-on,仅 CANON off-words `{0,false,off,no}` 关。
   - `answerAlreadyDisclosesOcr(content)` — 正文是否**已经**披露 OCR(命中拉丁 `OCR` 大小写不敏感 /
     中文「光学字符识别 / 光学识别 / 文字识别」)。命中 → 模型已合规 → 无需脚注(保持无感)。
   - `buildOcrUsageFootnote({count,env})` — 门开且 `count` 为正整数 → 返回用户可见脚注(单/复数按 count);
     门关 / 缺失 / 畸形 → `null`(逐字节回退)。零 IO,绝不抛。
   - `OCR_USAGE_FOOTNOTE_MARKER = '［本次图片经 OCR 识别］'` — 去重标记。

2. **接线** `aiGatewayGenerateMethod.js`:
   - 三处 OCR-**文本**注入点的 `options` 重建处,新增 `_ocrImageTextRead: true` + `_ocrImageTextCount: N`
     (Site1 describe-fail prep ~1590 / Site2 ocr-fallback prep ~1690 / Site3 post-failure 救援网 ~2857)。
     **仅 OCR-文本三站点置真**——视觉描述路径(`buildDescriptionInjection`,真视觉模型描述,非 OCR)、
     无文本剥图路径(读不出)均**不置**,避免把「用了视觉描述」误报成「用了 OCR」。
   - `finishResult` 成功侧(`cacheMetricsTruth` 之后)新增确定性脚注块:
     `result.success === true && options._ocrImageTextRead` 且门开、marker 未命中、`answerAlreadyDisclosesOcr`
     未命中(= 模型忽略了 OPS-124 指令)→ 在 `result.content` 末尾确定性追加脚注。fail-soft。

3. **登记** `flagRegistry.js`:`KHY_OCR_USAGE_FOOTNOTE: { mode: 'default-on', off: 'CANON', default: true }`。

### 与 OPS-124 的分工(belt-and-suspenders,直击「无感*且*明显」)

| | OPS-124(`KHY_OCR_USAGE_DISCLOSURE`) | OPS-126(`KHY_OCR_USAGE_FOOTNOTE`) |
|---|---|---|
| 机制 | 面向**模型**的 prompt 指令 | `finishResult` 成功侧**确定性**脚注 |
| 生效条件 | OCR 成功注入文本时无条件注入指令 | OCR 文本读出 + 作答成功 + 正文**未提** OCR |
| 达成目标 | 模型合规时**无感**(披露融进正文) | 模型忽略时兜底**明显**(保证触达) |
| 去重协同 | — | 正文已提 OCR → **不追加**(不重复披露,保持无感) |

## 三、验收门禁(B2 目标驱动,全绿才回报)

```
node --check services/backend/src/services/gateway/ocrUsageFootnote.js
node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js
node --check services/backend/src/services/flagRegistry.js
npm run test:ocr-usage-footnote          # 21/21(纯叶 13 + wiring 6 + 真图 2)
npm run test:maintainer:safety           # 聚合并入,全绿
npm run arch:god                         # 改动文件不得新增超限(aiGatewayGenerateMethod 为 pre-existing 超限,additive 允许)
<三守卫> --changed + 显式文件                # my-files 净
npm run maintainer:check                 # 映射表 + 元数据一致
```

真图核验:PIL 渲 `INVOICE 1234` 真 PNG → 真 tesseract 读出 → 生产镜像 base64 路径 →
救援网 OCR 成功分支置 `_ocrImageTextRead` → 下游文本适配器答复**不提 OCR** →
`finishResult` 确定性追加脚注到 `res.content`(含 `本地 OCR 文字识别读取`);门关逐字节回退。
缺 tesseract/eng/Pillow 或未读出目标词 → skip。

## 四、红线遵守

- 不自动 commit/push;未提交,留在 `feat/0.1.104-multi-subsystem-batch`。
- 只碰答复内容与 OCR 计数,不触密钥。
- god-file `aiGatewayGenerateMethod.js` 为 pre-existing 超限(> 2500 行),本轮纯 additive,不新增独立超限文件。
- 门关逐字节回退:`KHY_OCR_USAGE_FOOTNOTE=off` → `buildOcrUsageFootnote` 返 null → `result.content` 逐字节不变。
