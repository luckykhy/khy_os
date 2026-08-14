# [OPS-MAN-142] 失败墙推迟到 OCR 结果已知后(减少心灵噪音)

> 承 [OPS-MAN-138] / [OPS-MAN-140] 答复侧确定性纠正 —— 本轮补**实时告知侧**的噪音源。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

前几轮治的是「是否告知」「重复几遍」「模型谎称没收到图」。本轮沿同一 consumer(视觉级联全失败的
describe-fail 兜底块)找**最响的一条噪音**:

`aiGatewayGenerateMethod.js` 在 describe-and-return 级联全失败后,于 **OCR 兜底之前**(~line 1590)
**无条件** `emitAssistantMessage` 那块吓人的失败墙(`buildVisionFailureMessage`,含
「图像识别失败…粘贴 GLM API Key」)。控制流是:

```
视觉级联全失败 → 立刻甩「图像识别失败 + 配置 key」大块墙 → 之后才跑本地 OCR
```

当图是**含字图**、随后本地 OCR **成功读出文字**时,那块吓人失败墙**已经先甩给用户**——与紧接着的
「已用 OCR 成功识别图片」**自相矛盾**,是用户实测日志(paste-cache `92c0154d`)里**最响的心灵噪音**:
先说识别彻底失败、叫用户去粘贴 key,转头又正确读出了图。

## 二、外科修复(B3 只动该动的,全 additive)

**核心思路**:把失败墙的**发射时机**从「OCR 之前无条件」改为「OCR 结果已知之后再决定」。
OCR 成功救回 → 墙纯属误导 → **抑制**;OCR 读空 / 失败 → 真需用户介入 → **照发**。

**单一真源门**:`KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS`(default-on,与父门
`KHY_VISION_FAILURE_SUMMARY` 正交独立)。门关 → 逐字节回退到「墙在 OCR 之前无条件发射」的历史行为。

1. **纯叶子扩展** `visionFailureSummary.js`(承既有叶,扩展优于新建):
   - 新增谓词 `isFailureSummaryOcrSuppressEnabled(env)`,镜像 `isVisionFailureSummaryEnabled`,
     经 flagRegistry 读门、本地 CANON 回退、绝不抛。
2. **接线** `aiGatewayGenerateMethod.js`(describe-fail 兜底块 ~1590):
   - 读 `_ocrSuppressOn`;`_summaryOn` 时构造墙:子门开 → 存入 `_deferredFailureMsg`(**不立刻发**);
     子门关 → 照旧 `emitAssistantMessage`(逐字节回退)。
   - OCR **成功**分支(`_ocrTexts.length > 0`)→ `_deferredFailureMsg` 保持不发(**抑制**)。
   - OCR **读空**分支(`else`)→ 补发 `_deferredFailureMsg`(真失败,用户仍需介入)。
3. **门登记** `flagRegistry.js`:
   `KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: { mode:'default-on', off:'CANON', default:true }`。

**噪音守恒**:墙**至多发射一次**——要么急发(门关),要么推迟发(门开 + OCR 读空)。门开 + OCR 成功时
发射**零次**。与父门正交:父门决定「墙的文案是否为诚实总结」,本子门决定「墙在 OCR 成功时是否还发」;
父门关 → `buildVisionFailureMessage` 返 null → 无墙,子门推迟不复活它。

## 三、验收(B2 没跑过验证不许说修好了)

- 纯叶单测 `visionFailureSummary.test.js` 17/17(含新谓词 default-on / off-word / 与父门正交 / 不抛)。
- 接线单测 `visionFailureSummaryOcrSuppressWiring.test.js` 4/4(onChunk 捕获失败墙):
  A) 子门开 + OCR 有文本 → 墙被抑制;B) 子门开 + OCR 读空 → 墙照发;
  C) 子门关 + OCR 有文本 → 墙于 OCR 前照旧发射(逐字节回退);D) 父门关 → 从不构造墙。
- **真图 E2E** `visionFailureSummaryOcrSuppressRealImage.test.js` 2/2:真 PIL 渲含字 PNG
  (`INVOICE ACME 2026`)→ 真 tesseract 读出 → 断言墙被抑制、OCR 文本注入;无字彩块图 → 真 tesseract
  读空 → 断言墙照发。
- 统一别名:`npm run test:vision-failure-summary-ocr-suppress`(17+4+2 = 23/23)。
- 门:`node --check` × 源文件 · god-file `wc -l` · flag-registry / leaf-contract / agent-rules ·
  change-safety(positional 闭 map 桥)· maintainer:check · safety 聚合。

## 四、教训

1. **断桥补全靠沿同一 consumer 找下一条正交噪音**:前几轮治答复侧,本轮沿 describe-fail 兜底块找到
   **实时告知侧**最响的一条——失败墙在 OCR 结果已知前无条件发射。
2. **时机 = 噪音的作用域**:同一块墙,发早了(OCR 前)就与 OCR 成功自相矛盾;把发射推迟到结果已知后,
   同一文案零改动即从噪音变为按需告知。
3. **噪音守恒 + 父子正交**:墙至多发一次(急发 xor 推迟发),OCR 成功时零发;子门只管「何时发」,
   不复活父门关掉的墙。
4. **OPS 号碰撞**:原 OPS-141 被并行 session(代理内核 CLI 表面接线)占用 → 精确逐文件 renumber 到
   OPS-142,绝不全局 sed 跨他人文件。
