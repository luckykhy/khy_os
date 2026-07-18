# [OPS-MAN-138] 空 OCR 剥图路径——模型仍谎称「没收到图」的确定性纠正脚注

> 承 [OPS-MAN-118/120/122]「剥图 ⟹ 必留痕」三处不变量 + [OPS-MAN-126] 确定性脚注哲学。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」。

本轮针对用户 2026-07-12 实测失败现象(`paste-cache 92c0154d`,截图 khy OS v0.1.193、模型
`api:agnes:agnes-2.0-flash`)复现的**最后一条断桥**:

```
❯ 请先描述图片中的关键信息…  📎×1
… 正在调用 glm/glm-4.6v-flash 进行识别…（404 model_not_found）
… 正在调用 glm-4v-flash 进行识别…（socket hang up）
我注意到你发了一条结构化提示，但消息里没有附带图片。
关键发现：当前对话中没有任何图片附件。… 我无法描述不存在的内容。
```

**链路真相**:纯文本模型 + 带图 → 视觉描述级联全 404 → 落 OCR 兜底,但图是**非文字类**(照片 / 截图 /
图表)或缺对应语言字库 → 本地 OCR **读不出任何文字** → aiGateway 三处「空 OCR」站点
(prep Site1 `~1626` / prep Site2 `~1736` / post-failure 救援网 `~2927`)都**无条件剥图**
(`images: undefined`、`_ocrFallbackApplied: true`)并注入一条面向**模型**的「收到图但读不出、绝不能说
没收到图」诚实底线。

**断桥**:那条底线**只是一条 prompt 指令,模型可以不听**。实测里模型正是无视它,正文谎称「消息里没有
附带图片」。而 `finishResult` 成功侧本有一整族**确定性**真值脚注(`answerVerifier` / `modelIdentityTruth` /
`cacheMetricsTruth` / `ocrUsageFootnote`),无论模型怎么写都在末尾确定性追加真相——**唯独
`ocrUsageFootnote`(:858)只在 `_ocrImageTextRead === true`(OCR 成功读出文本)时触发**;空 OCR 剥图
只置 `_ocrFallbackApplied`、**不置** `_ocrImageTextRead` → 恰好落在那条脚注判据之外 → 模型谎称没收到图时,
**零确定性纠正**。

判据:找到「一条应当确定性触达用户的真相(你确实上传了图),却只靠一条模型可忽略的 prompt 底线传达」的
断桥——它正落在既有确定性脚注族的判据盲区(`_ocrFallbackApplied && !_ocrImageTextRead`)。

## 二、修复(B3 外科手术式改动,全 additive)

独立 default-on 门 `KHY_VISION_DENIAL_CORRECTION`。

1. **纯叶** `services/backend/src/services/gateway/visionDenialCorrection.js`:
   - `isEnabled(env)` — 门控(经 `flagRegistry`),default-on,仅 CANON off-words `{0,false,off,no}` 关。
   - `detectImageDenial(content)` — 正文是否在**否认收到图**:命中保守否认正则(`没有…图片` /
     `当前对话中没有…图片` / `无法描述不存在的内容` / `图片并未成功上传` 等,取自实测语料)**且未**同时命中
     承认正则(`收到图但读不出` / `当前模型不支持视觉` / `OCR` 等)。承认正则用 lookbehind `(?<!没有|没|未|不)`
     排除「没有**收到图片**」里的假承认。非字符串 / 空 → false(保守回退)。
   - `buildDenialCorrectionNote({count,env})` — 门开 → 用户可见纠正脚注(含 marker、明确「图片**已经收到**」、
     直接反驳「并非『没有图片』」、给出换视觉模型 / 装字库 / 粘贴文字三方案);门关 → null(逐字节回退)。
   - `DENIAL_CORRECTION_MARKER` — 去重标记。全程零 IO、绝不抛。

2. **flagRegistry 登记** `KHY_VISION_DENIAL_CORRECTION`:`{ mode: 'default-on', off: 'CANON', default: true }`,
   附断桥说明 + 与 `KHY_OCR_USAGE_FOOTNOTE` / 三条 prompt 侧底线门的正交关系。

3. **接线** `aiGatewayGenerateMethod.js` `finishResult` 成功侧(紧接 `ocrUsageFootnote` 块之后):
   ```
   if (result && result.success === true && options._ocrFallbackApplied && !options._ocrImageTextRead) {
     try {
       const _vdc = require('./visionDenialCorrection');
       if (_vdc.isEnabled(process.env)
           && !String(result.content || '').includes(_vdc.DENIAL_CORRECTION_MARKER)
           && _vdc.detectImageDenial(result.content)) {
         const _imgN = Array.isArray(options.images) ? options.images.length : options._ocrImageTextCount;
         const _footer = _vdc.buildDenialCorrectionNote({ count: _imgN, env: process.env });
         if (_footer) result.content = `${String(result.content || '')}${_footer}`;
       }
     } catch { /* fail-soft */ }
   }
   ```
   marker 去重 + `detectImageDenial` 守卫 + fail-soft;门关 → `buildDenialCorrectionNote` 返 null →
   `result.content` 逐字节不变。

## 三、正交关系

| 层 | 门 | 判据 | 作用 |
|---|---|---|---|
| prompt 侧底线(三处) | `KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR` / `KHY_VISION_STRIP_IMAGE_FLOOR` / `KHY_VISION_RESCUE_STRIP_FLOOR` | 剥图站点 | 保证「剥图 ⟹ prompt 留痕」 |
| 答复侧脚注(OCR 成功) | `KHY_OCR_USAGE_FOOTNOTE` | `_ocrImageTextRead=true` | 模型没提 OCR → 追加「用了 OCR」 |
| **答复侧纠正(OCR 读空)** | **`KHY_VISION_DENIAL_CORRECTION`** | **`_ocrFallbackApplied && !_ocrImageTextRead`** | **模型否认收到图 → 确定性纠正(本发)** |

本发是**最后一道用户可见防线**:当模型无视 prompt 侧留痕、仍谎称没收到图时,答复侧确定性纠正兜底。

## 四、验证(全绿)

- `node --check` × 3(叶 / gateway / flagRegistry)。
- `npm run test:vision-denial-correction` **22/22**(纯叶 14 + wiring 6 + 真图 2)。
  - **真图端到端**:真 PIL 渲**无字彩块** PNG → 真 tesseract 读空 → 剥图 + 原文本模型**故意否认收到图**
    (复刻实测语料)→ 断言末尾出现 `DENIAL_CORRECTION_MARKER` 纠正脚注、原正文保留;门关 → 无脚注(字节回退)。
- `arch:god`(wc -l:叶 < 2500;`aiGatewayGenerateMethod.js` grandfathered 超限,本发 additive 无新 god-file)。
- 三守卫 `--changed` / positional、`maintainer:check`、safety 聚合(pre-existing 真图 flaky 决定性对照甄别)。

## 五、教训

1. 断桥补全靠沿同一 consumer 找**判据盲区**:既有确定性脚注族只覆盖 `_ocrImageTextRead=true`,
   空 OCR 剥图路径(`_ocrFallbackApplied && !_ocrImageTextRead`)恰是盲区。
2. prompt 侧底线(模型可忽略)必须有答复侧确定性脚注兜底——「无感*明显*告知」的「明显」不能只押注模型配合。
3. 否认正则的假承认陷阱:`收到图片` 会在「没有**收到图片**」里假命中承认 → 承认正则须 lookbehind 排除前置否定。
4. 真图核验制造空 OCR 场景 = 渲**无字彩块**(`texts: []`),本机若从彩块读出文字则 `test.skip`(可移植性)。
