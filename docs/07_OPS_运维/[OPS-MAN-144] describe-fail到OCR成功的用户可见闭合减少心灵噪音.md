# [OPS-MAN-144] describe-fail 到 OCR 成功的用户可见闭合(减少心灵噪音)

> 承 [OPS-MAN-142] 失败墙推迟 —— 本轮补**悬空「请稍候」承诺的闭合侧**。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

`KHY_VISION_INTERMEDIATE_MESSAGE`(default-on)在 describe-and-return 级联里,于**每个候选视觉模型**
识别前发一条承诺:

```
我无法直接识别图片内容。正在调用 <视觉模型> 进行识别，请稍候...
```

并在 describe **成功**时于 `aiGatewayGenerateMethod.js` line ~1554 发一条闭合:
`视觉识别完成，正在根据识别结果为您作答。`

**断桥**:当**所有**视觉模型都失败、随后本地 OCR **成功**读出文字、走剥图 + OCR 注入兜底分支时——
那 N 条「请稍候」承诺**无人闭合**。用户看到 N 个悬空的「正在调用...请稍候」却永远等不到「识别完成」:

```
正在调用 glm-4v-flash 请稍候...   ← 承诺 1(悬空)
正在调用 gpt-... 请稍候...        ← 承诺 2(悬空)
正在调用 claude-... 请稍候...     ← 承诺 3(悬空)
（视觉全失败 → 本地 OCR 成功读出 → 直接据 OCR 作答，无任何闭合）
```

既是心灵噪音(悬空承诺),又漏掉了「已改用 OCR」这一「无感明显告知用了 OCR」的关键披露。
本轮用 `/tmp/repro142.js` 复现坐实:`success:true` + `finalPrompt has OCR INVOICE:true`,
但 3 条用户可见 chunk 全是「正在调用...请稍候」,**零闭合**。判据 = describe-**成功**有 line 1554 闭合,
describe-fail → OCR-**成功**分支(line 1622-1653)只有 emitStatus,**无 emitAssistantMessage 闭合**的不对称。

## 二、外科修复(B3 只动该动的,全 additive)

**核心思路**:在 OCR-成功兜底分支追加**一条**闭合,既闭合悬空的「请稍候」承诺,又在中间消息层
无感明显告知已降级到 OCR。

**单一真源门**:`KHY_VISION_OCR_SUCCESS_CLOSURE`(default-on)。共享 `_intermediateEnabled` 前提
(中间消息门关 → 整体不发)。门关 → 逐字节回退(OCR-成功分支不发闭合,悬空承诺照旧)。

1. **纯叶子**(无既有叶可扩,新建小叶)`visionOcrSuccessClosure.js`(零 IO、DI env、绝不抛):
   - `isVisionOcrSuccessClosureEnabled(env)` 经 flagRegistry 读门;
   - `buildOcrSuccessClosure({count, env})` → 门开 + count>0 → 返
     `视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答。`;门关 / count<=0 / 畸形 → null。
2. **接线** `aiGatewayGenerateMethod.js`(OCR-成功分支 `_ocrTexts.length > 0`,line ~1654 后):
   - `if (_intermediateEnabled)` → `require('./visionOcrSuccessClosure').buildOcrSuccessClosure(...)`
     → `if (_closure) emitAssistantMessage(_closure)`;fail-soft;门关 → 叶返 null → 不发(byte-revert)。
3. **门登记** `flagRegistry.js`:
   `KHY_VISION_OCR_SUCCESS_CLOSURE: { mode:'default-on', off:'CANON', default:true }`。

**正交**:与 OPS-142 `KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS` 正交——那治**失败墙**在 OCR 成功时是否发,
本治悬空的**「请稍候」承诺**在 OCR 成功时是否闭合。不同消息族、独立门。闭合**至多发一次**,且仅在
OCR 成功 + 中间消息门开时。

## 三、验收(B2 没跑过验证不许说修好了)

- 纯叶单测 `visionOcrSuccessClosure.test.js` 6/6(default-on / off-word byte-revert / 单多张名词 /
  count<=0 / 畸形 → null / 不抛)。
- 接线单测 `visionOcrSuccessClosureWiring.test.js` 4/4(onChunk 捕获闭合 assistant_message):
  A) 中间消息门开 + 闭合门开 → 发闭合;B) 闭合门关 → 无闭合(byte-revert),OCR 注入照常;
  C) 中间消息门关 → 共享前提不成立 → 无闭合;D) OCR 读空 → 非本分支 → 无闭合。
- **真图 E2E** `visionOcrSuccessClosureRealImage.test.js` 2/2:真 PIL 渲含字 PNG(`INVOICE ACME 2026`)
  → 视觉级联全 404 → 真 tesseract 读出 → 断言发闭合(含「视觉模型均不可用」+「本地 OCR 成功识别」)
  且 finalPrompt 真含 INVOICE;门关 → 无闭合、OCR 注入照常。
- 统一别名:`npm run test:vision-ocr-success-closure`(6+4+2 = 12/12)。
- 门:`node --check` × 源文件 · god-file `wc -l`(叶 < 2500;aiGatewayGenerateMethod additive grandfathered)·
  flag-registry / leaf-contract / agent-rules · change-safety(positional 闭 map 桥)· maintainer:check ·
  safety 聚合。

## 四、教训

1. **断桥补全靠沿同一 consumer 找下一条正交噪音**:OPS-142 治失败墙,本轮沿同一 describe-fail 兜底块
   找到**悬空承诺**——describe-成功有闭合(1554),describe-fail→OCR-成功没有,不对称即缺口。
2. **承诺必闭合**:发了 N 条「请稍候」就得有对应的「完成」,否则悬空承诺本身即噪音;闭合同时兼作
   「无感明显告知用了 OCR」的披露,一石二鸟。
3. **共享前提 + 独立门**:闭合共享 `_intermediateEnabled`(没发承诺就不必闭合),但用独立门
   `KHY_VISION_OCR_SUCCESS_CLOSURE` 单独可关(byte-revert)。
4. **OPS 号碰撞**:原 OPS-143 被并行 session(Windows 保留设备名读前防护)占用 → 精确逐文件 renumber
   到 OPS-144,绝不全局 sed 跨他人文件。
