# [OPS-MAN-145] 级联逐候选「请稍候」提示减冗余(减少心灵噪音)

> 承 [OPS-MAN-144] describe-fail 到 OCR 成功的用户可见闭合 —— 本轮补**逐候选承诺本身的减冗余侧**。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

`KHY_VISION_FALLBACK_CASCADE`(门开)让 describe-and-return 级联在主视觉模型失败后,继续尝试
**多个备用视觉候选**(内置 GLM pin → `glm-4.6v-flash`、`glm-4v-flash`,再加各 provider 视觉模型)。
`KHY_VISION_INTERMEDIATE_MESSAGE`(default-on)在**每个候选**识别前发一条:

```
我无法直接识别图片内容。正在调用 <视觉模型> 进行识别，请稍候...
```

**断桥**:级联有 N 个候选时,这条逐字节相同的首句会刷 N 遍。OPS-144 已闭合了这些悬空承诺的**收尾**,
但**承诺本身的重复**未治——用户看到:

```
我无法直接识别图片内容。正在调用 glm-4.6v-flash 请稍候...   ← 冗余前缀第 1 遍
我无法直接识别图片内容。正在调用 glm-4v-flash 请稍候...     ← 冗余前缀第 2 遍
我无法直接识别图片内容。正在调用 gpt-... 请稍候...          ← 冗余前缀第 3 遍
```

「我无法直接识别图片内容」刷 N 遍是纯噪音;且候选 2..N 读起来像**并行的新调用**,而非级联兜底——
用户无从得知这是「上一个不行,自动改用下一个」的降级链。判据 = 逐候选首句逐字节相同、无 index 感知。

## 二、外科修复(B3 只动该动的,全 additive)

**核心思路**:让逐候选提示 **index 感知**——第 1 个候选保留完整历史首句(逐字节等价),候选 2..N
折成减冗余的级联 reframe。

**单一真源门**:`KHY_VISION_CASCADE_ATTEMPT_NOTICE`(default-on)。共享 `_intermediateEnabled` 前提
(中间消息门关 → 整体不发)。门关 → 逐字节回退(每个候选都退回完整历史首句)。

1. **纯叶子**(无既有叶可扩,新建小叶)`visionCascadeAttemptNotice.js`(零 IO、DI env、绝不抛):
   - `isCascadeAttemptNoticeEnabled(env)` 经 flagRegistry 读门;
   - `buildCascadeAttemptNotice({index, model, prevModel, env})`:
     - 门关 / index 非有限 / index<=0 → 返完整历史首句
       `我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...`(逐字节等价);
     - 门开 + index>0 → 返 `视觉模型 <prev> 不可用，正在改用 <model> 继续识别...`
       (去冗余前缀、点明级联降级、命名前一模型 + 下一模型);
   - `CASCADE_ATTEMPT_FALLBACK_MARKER = '正在改用'`。
2. **接线** `aiGatewayGenerateMethod.js`(级联 for 循环):
   - 循环前置 `let _attIdx = 0; let _prevAttemptModel = null;`;
   - 循环首委派纯叶 `buildCascadeAttemptNotice({index:_attIdx, model:_att.model, prevModel:_prevAttemptModel, env})`
     → `if (_note) emitAssistantMessage(_note)`;catch → 逐字节回退历史首句;
   - 循环尾 `_prevAttemptModel = _att.model || _prevAttemptModel; _attIdx += 1;`。
3. **门登记** `flagRegistry.js`:
   `KHY_VISION_CASCADE_ATTEMPT_NOTICE: { mode:'default-on', off:'CANON', default:true }`。

**正交**:与 OPS-144 `KHY_VISION_OCR_SUCCESS_CLOSURE` 正交——那治悬空承诺在 OCR 成功时的**闭合**,
本治逐候选承诺**发出时的重复**。不同关注点(收尾 vs 前缀去冗余)、独立门,同在 `_intermediateEnabled`
共享前提下。第 1 个候选完全不变(给用户完整上下文),只把冗余重复折叠。

## 三、验收(B2 没跑过验证不许说修好了)

- 纯叶单测 `visionCascadeAttemptNotice.test.js` 8/8(门开 / 门关 · index 0 → legacy · 缺 / 负 index → legacy ·
  index>0 → reframe 无前缀含 MARKER 命名前后模型 · 缺 prevModel → 「上一视觉模型」占位 · 门关全 legacy ·
  缺 model → 「视觉模型」占位 · 不抛)。
- 接线单测 `visionCascadeAttemptNoticeWiring.test.js` 3/3(onChunk 捕获 assistant_message,内置 GLM pin
  产 ≥2 候选):A) 门开 → 第 1 条 legacy、其后 reframe 无冗余前缀;B) 本门关 → 每条退回完整历史首句
  (byte-revert)零 reframe;C) 提示门关 → 零中间提示。
- **真图 E2E** `visionCascadeAttemptNoticeRealImage.test.js` 2/2:真 PIL 渲含字 PNG(`INVOICE ACME 2026`)
  → 视觉级联全 404 → 真 tesseract 读出 → 断言第 1 条 legacy、其后 reframe 且 finalPrompt 真含 INVOICE;
  门关 → 每条 legacy、OCR 注入照常。
- 统一别名:`npm run test:vision-cascade-attempt-notice`(8+3+2 = 13/13)。
- 门:`node --check` × 源文件 · god-file `wc -l`(叶 < 2500;aiGatewayGenerateMethod additive grandfathered)·
  flag-registry / leaf-contract / agent-rules · change-safety(positional 闭 map 桥)· maintainer:check ·
  safety 聚合。

## 四、教训

1. **断桥补全靠沿同一 consumer 找下一条正交噪音**:OPS-144 治悬空承诺的**收尾**,本轮沿同一级联
   逐候选提示块找到**承诺本身的重复**——收尾治了,发出时的冗余没治,即缺口。
2. **减冗余保留首条上下文**:第 1 个候选完整不动(用户需知「模型不能识图,正在调用视觉模型」),只把
   2..N 的冗余前缀折成级联 reframe,点明降级链而非并行新调用——减噪与明显告知两不误。
3. **index 感知靠循环状态**:在循环前置 `_attIdx`/`_prevAttemptModel`、循环尾自增/记录,纯叶按 index
   分支;门关 / index<=0 逐字节回退历史首句。
4. **共享前提 + 独立门**:reframe 共享 `_intermediateEnabled`(没发承诺就不必去冗余),但用独立门
   `KHY_VISION_CASCADE_ATTEMPT_NOTICE` 单独可关(byte-revert)。
5. **OPS 号双查**:grep 确认 OPS-145 仅我文件持有,无并行 session 碰撞。
