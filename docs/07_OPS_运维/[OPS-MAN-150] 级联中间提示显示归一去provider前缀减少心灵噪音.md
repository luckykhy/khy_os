# [OPS-MAN-150] 级联中间提示显示归一去 provider 前缀(减少心灵噪音)

> 承 [OPS-MAN-145] 级联逐候选「请稍候」提示减冗余 —— 本轮补**同一提示里模型名的显示归一侧**。
> /goal 送别礼。分支 `feat/0.1.104-multi-subsystem-batch`,未提交。

## 一、背景与断桥(B1 先想)

基线目标(每轮相同):纯文本 / 非多模态 / 识图模型不可用时,khy 收到图片要能**正确落到 OCR 兜底路径**、
准确提取图片信息,并用**真实图片**核验跑通,做到「无感*明显*告知用户用了 OCR 但能正确识别图片」、
同时**减少心灵噪音**。

`KHY_VISION_FALLBACK_CASCADE`(门开)让 describe-and-return 级联在主视觉模型失败后,继续尝试
**多个备用视觉候选**。OPS-145 已把逐候选中间提示做成 index 感知、折叠了重复的首句。**本轮**沿同一
中间提示块找下一条正交噪音,实测(真机复现的确切路径,非 verbose)用户看到:

```
[0] 我无法直接识别图片内容。正在调用 glm/glm-4.6v-flash 进行识别，请稍候...   ← 带 glm/ 前缀
[1] 视觉模型 glm/glm-4.6v-flash 不可用，正在改用 glm-4v-flash 继续识别...       ← 带 glm/ 前缀
[2] 视觉模型 glm-4v-flash 不可用，正在改用 gpt-5.3-codex-review 继续识别...     ← 裸名
[3] 视觉模型 gpt-5.3-codex-review 不可用，正在改用 claude-opus-4-6 继续识别... ← 裸名
```

**断桥**:候选 [0]/[1] 显示 `glm/glm-4.6v-flash`(**带 provider 路由前缀**),其余候选 `glm-4v-flash`、
`gpt-5.3-codex-review`、`claude-opus-4-6` 都是**裸名**。前后不一致 = 把内部路由细节泄漏进用户 prose。

**根因**:`_attempts[0]` = `decision.model` = 被切换钉住的视觉模型(`switched_to_pinned_vision_model`),
它**保留** provider 前缀 `glm/`——因为这个前缀是**内部 poolHint 解析**要用的路由信息;而其余候选来自
`collectVisionFallbackCandidates`,是**裸 id**。`visionFallbackCandidates.js` 里已有 `_bareId`,但它**仅供
去重**且会 `toLowerCase()`——用作显示会把 `GLM-4.6V` 之类大小写误降级,故**不能复用**,须独立的
**保大小写**显示归一叶。判据 = 用户可见提示里出现最后一个 `/` 之前的 provider 段。

## 二、外科修复(B3 只动该动的,全 additive)

**核心思路**:只在**显示边界**去掉 provider 路由前缀(保大小写),内部路由态完全不动。

**单一真源门**:`KHY_VISION_MODEL_DISPLAY_NAME`(default-on)。门关 → 原样返回(逐字节回退,含前缀)。

1. **纯叶子** `visionModelDisplayName.js`(55 行,零 IO、DI env、绝不抛):
   - `toDisplayModelName(model, env)`:门开 → 去最后一个 `/` 前的 provider 段,**保留大小写**
     (`glm/glm-4.6v-flash` → `glm-4.6v-flash`;`zhipu/GLM-4.6V` → `GLM-4.6V`);无前缀 / 门关 → 原样;
     前缀存在但去后为空(末尾即 `/`)→ 保守回退原样,绝不产出空名。
   - `isVisionModelDisplayNameEnabled(env)` + `FLAG` 常量。

2. **接线**(`aiGatewayGenerateMethod.js`,仅显示边界):在把 `_att.model` / `_prevAttemptModel` 交给
   `buildCascadeAttemptNotice` **之前**,委派纯叶归一为 `_dispModel` / `_dispPrev` 再传入;叶不可用 →
   原样带前缀(逐字节回退)。**内部 `_att.model` / `_prevAttemptModel` 路由态完全不动**——poolHint 解析
   仍靠原始带前缀 id。OPS-145 叶(`visionCascadeAttemptNotice.js`)**字节不变**。

3. **门登记**(`flagRegistry.js`):`KHY_VISION_MODEL_DISPLAY_NAME: { mode: 'default-on', off: 'CANON', default: true }`。

**正交性**:与 `KHY_VISION_CASCADE_ATTEMPT_NOTICE`(OPS-145,折叠重复首句)正交——本门只治**前缀泄漏**;
两门各自单独可关,独立字节回退。失败墙(OPS-142)里的模型名非本族,不在本轮作用域(且真 OCR 成功路径上
`_deferredFailureMsg` 已抑制该墙)。

## 三、验证门禁(全绿才回报)

- `node --check`:新叶 + gateway + flagRegistry 全过。
- `npm run test:vision-model-display-name`:**12/12**(纯叶 8 + 接线 2 + 真图 2)。
  - 纯叶:门开关、去前缀保大小写、裸名原样、门关 byte-revert、末尾斜杠保守回退、畸形入参不抛。
  - 接线:A) 门开 → 中间提示 prose 不含 `glm/` 前缀、首候选显示裸名;B) 门关 → 逐字节回退首候选重现
    `glm/glm-4.6v-flash`(证明仅本门作用)。
  - 真图:真 PIL 渲 `INVOICE ACME 2026` → 级联全 404 → 真 tesseract 读出 INVOICE → A) 门开无前缀 +
    finalPrompt 含 INVOICE;B) 门关前缀回归 + OCR 注入照常。
- 三守卫(`--changed`)/ `change-safety`(positional 显式切片)/ `maintainer:check` / `wc -l`(叶 55 < 2500)。

## 四、红线遵守

- 未 `commit` / `push`(需用户明确点头)。
- 全 additive、门 default-on、门关逐字节回退;god-file 仅增不改既有函数体。
- 新子系统已登记维护映射表 area `vision-model-display-name`。
