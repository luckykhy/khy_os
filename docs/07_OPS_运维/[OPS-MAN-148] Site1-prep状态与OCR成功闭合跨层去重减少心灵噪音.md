# [OPS-MAN-148] Site1 prep 状态与 OCR 成功闭合的跨层去重(减少心灵噪音)

> 承 [OPS-MAN-132] prep 期 OCR 兜底非 verbose 实时状态 + [OPS-MAN-144] describe-fail 到 OCR 成功的用户可见闭合。
> 本轮补**同一 OCR 降级被两层各发一遍永久行的去重侧**。/goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

用户复现的**确切路径**:非 verbose 会话 · describe 视觉级联全失败 → 本地 OCR **成功**读出。在这条路径上,
同一条「已降级到 OCR 并成功识别」的事实被**两层各发一遍、且都是永久行**:

```
[status]             检测到图片输入：<模型> 不支持图像识别，已降级用本地 OCR 成功提取 1 张图片文本并据此作答
                     ↑ OPS-132 prep-status（buildOcrRescuePrepStatus）。文本含「成功」→ emitRuntimeStatus
                       误分类为 _printTerminalStatus('done','模型已连接') → 永久行，且标签错成「模型已连接」
[assistant_message]  视觉模型均不可用，已改用本地 OCR 成功识别图片，正在据此作答。
                     ↑ OPS-144 闭合（buildOcrSuccessClosure），干净 bot 气泡
```

**断桥**:OPS-132 当初补 prep-status,是为了让**非 verbose 用户在 prep 期也能看到 OCR 降级**(那时还没有
OPS-144 闭合)。但 OPS-144 闭合落地后,恰在 **Site1(级联失败)** 这条路径上,闭合已经把「明显告知用了 OCR」
交付了 → prep-status 沦为**冗余且措辞更差**(还被误标「模型已连接」)的第二遍公告。判据 = 同一 OCR 降级事实
在 Site1 路径上产生两条永久行。

## 二、外科修复(B3 只动该动的,全 additive)

**核心思路**:在**闭合确将发射时**抑制 Site1 的冗余 prep-status,只留更清晰的闭合。

**★仅限 Site1**:Site2(ocr-fallback,无级联 → 无悬空「请稍候」承诺 → 无闭合)必须**始终保留** prep-status,
否则非 verbose 用户在那条路径又变回沉默。守卫谓词只在 Site1 调用点触发。

**单一真源门**:`KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP`(default-on)。门关 / 异常 → 不抑制 = 逐字节回退
(prep-status 与闭合并存,OPS-132 + OPS-144 历史行为)。

1. **纯叶子(扩展优于新建)** 扩 `ocrRescueStatusNotice.js`(零 IO、DI env、绝不抛):
   - `isPrepClosureDedupEnabled(env)` 经 flagRegistry 读门;
   - `shouldSuppressPrepForClosure({ intermediateEnabled, closureEnabled, env })`:
     - 仅当 去重门开 **且** `intermediateEnabled === true` **且** `closureEnabled === true` → 返 `true`(抑制);
     - 门关 / 闭合不会发 / 畸形 → 返 `false`(不抑制,逐字节回退);
     - **严格 `=== true` 布尔判定**:truthy-but-not-true 值绝不误抑制;
   - `PREP_CLOSURE_DEDUP_FLAG = 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP'`。
2. **接线** `aiGatewayGenerateMethod.js`(**Site1** OCR-成功分支,~1663):
   - 先算 `_closureWillFire = _intermediateEnabled && visionOcrSuccessClosure.isVisionOcrSuccessClosureEnabled(env)`;
   - `_suppressPrep = shouldSuppressPrepForClosure({ intermediateEnabled: _intermediateEnabled===true, closureEnabled: _closureWillFire===true, env })`;
   - `if (!_suppressPrep) { const _prep = buildOcrRescuePrepStatus(...); if (_prep) emitStatus(_prep); }`;
   - fail-soft try/catch → 叶不可用则按历史静默;
   - **Site2(~1796)完全不动**,始终保留 prep-status。
3. **门登记** `flagRegistry.js`:
   `KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP: { mode:'default-on', off:'CANON', default:true }`。

**正交**:OPS-132 **加**了 prep-status(补非 verbose 缺口);OPS-144 **加**了闭合(闭合悬空承诺);
OPS-148 **减**去两者在 Site1 上对同一事实的**重复**。独立门,门关逐字节回退到 OPS-132 + OPS-144 并存。

## 三、验收(B2 没跑过验证不许说修好了)

- 纯叶单测 `ocrRescueStatusNotice.test.js` 16/16(新增 `shouldSuppressPrepForClosure` 8 例:FLAG 名 · 门 default-on +
  off-words · 门开 + 闭合将发 → true · 门关 → false(byte-revert)· closureEnabled=false → false ·
  intermediateEnabled=false → false · 非严格布尔(truthy 但非 true)→ false · 畸形 / 无参 → false 绝不抛)。
- 接线单测 `ocrRescuePrepClosureDedupWiring.test.js` 3/3:A) 去重门开 → Site1 prep-status 被抑制、闭合照发
  = 净 1 条公告;B) 去重门关 → prep-status 与闭合并存(byte-revert)= 2 条公告;C) Site2(ocr-fallback,
  无闭合)prep-status 始终保留(守卫仅限 Site1)。
- **真图 E2E** `ocrRescuePrepClosureDedupRealImage.test.js` 2/2:真 PIL 渲含字 PNG(`INVOICE ACME 2026`)→
  内置 GLM pin 级联全 404 → 真 tesseract 读出 → 非 verbose 同时收 status 与 assistant_message;门开 → 只发闭合、
  无冗余 prep-status、finalPrompt 真含 INVOICE;门关 → 两条并存。
- 统一别名:`npm run test:ocr-rescue-prep-closure-dedup`(16+3+2 = 21/21)。
- 门:`node --check` × 源文件 · god-file `wc -l`(叶 < 2500;aiGatewayGenerateMethod additive grandfathered)·
  flag-registry / leaf-contract / agent-rules · change-safety(positional 闭 map 桥)· maintainer:check ·
  safety 聚合。

## 四、教训

1. **断桥补全靠沿同一 consumer 找下一条正交噪音**:OPS-132 加 prep-status、OPS-144 加闭合,两次都在「补告知」;
   本轮沿同一 Site1 OCR-成功分支发现两层对**同一事实**各发一遍永久行——补的太多也是噪音,缺口是**重复**。
2. **加了要减、减要限定作用域**:OPS-148 只在 Site1(闭合确将发)抑制 prep-status;Site2 无闭合,守卫绝不触及,
   否则非 verbose 用户又变回沉默。作用域是灵魂。
3. **严格布尔 `=== true`**:`shouldSuppressPrepForClosure` 用严格判定,truthy-but-not-true 绝不误抑制——抑制型
   谓词宁可少抑制(保留公告)也不误吞。
4. **共享前提 + 独立门**:去重共享 `_intermediateEnabled`(闭合都不发就无从重复),但用独立门
   `KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP` 单独可关(byte-revert 到 OPS-132 + OPS-144 并存)。
5. **OPS 号双查 + 精确逐文件 renumber**:原 147 被并行 session(次级读取工具防卡死前检)占 → 逐文件 sed
   147 → 148 仅我 6 文件,绝不全局 sed。
