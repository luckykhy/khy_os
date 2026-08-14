# [OPS-MAN-159] 失败墙视觉模型名显示归一去 provider 前缀（减少心灵噪音）

> 承 OPS-150。同一诉求「减少显示的心灵噪音」在**同一条 vision→OCR 兜底路径**上的下一枚正交噪音。

## 断桥（现场复现）

真机路径（非 verbose，文本模型 + 图 → 视觉级联全失败 → 本地 OCR **读不出文字**）上，
失败/纠偏墙 assistant_message 里出现：

```
图像识别失败:图像识别这一步没能完成。
本次尝试的视觉模型:glm/glm-4.6v-flash。      ← ★ 泄漏内部路由前缀 glm/
真实失败原因: …
```

- OPS-150 已把**级联逐候选中间提示**（`buildCascadeAttemptNotice`）里的模型名归一为裸 `glm-4.6v-flash`；
- 但**失败墙**（`visionFailureSummary.buildVisionFailureMessage`）有**自己**的一行
  `本次尝试的视觉模型:<model>`，调用方（`aiGatewayGenerateMethod`）传入
  `model: _primaryModel`，而 `_primaryModel = decision.model` = 被切换钉住的视觉模型，**保留 `glm/`
  路由前缀**（前缀供内部 `poolHint` 解析）。
- 结果：失败墙仍泄漏 `glm/glm-4.6v-flash`，与已归一的级联提示前后不一致 = 残留心灵噪音。

**可见性**：该墙在**视觉级联全失败 + 本地 OCR 读空**（照片/截图/无对应语言字库）时对用户可见；
OCR 成功时被 OPS-142(`_deferredFailureMsg`) 抑制，故本泄漏只在 OCR-失败子分支显现（外加
`recognizeImage.js` 直调工具路径）。

## 修（全 additive · 复用 OPS-150 门与叶 · 显示边界归一 · 内部路由不动）

在 `buildVisionFailureMessage` 拼装 `本次尝试的视觉模型` 行的**显示边界**处，复用 OPS-150 纯叶
`visionModelDisplayName.toDisplayModelName(modelId, env)` 归一：

```js
if (modelId) {
  let _dispModel = modelId;
  try { _dispModel = require('./visionModelDisplayName').toDisplayModelName(modelId, e); }
  catch { /* 叶不可用 → 原样,逐字节回退 */ }
  lines.push(`本次尝试的视觉模型:${_dispModel || modelId}。`);
}
```

- **在叶内归一**（而非调用方）→ 单一显示边界，**所有调用方**（级联路径 + `recognizeImage.js` 工具）
  同时受益。
- 复用 OPS-150 **同门** `KHY_VISION_MODEL_DISPLAY_NAME`（default-on）——语义一致（都是「显示裸视觉
  模型名」），无需新门。门关 / 叶不可用 → 返原样带前缀 → **逐字节回退**
  `本次尝试的视觉模型:glm/glm-4.6v-flash。`。
- 内部路由态（`_primaryModel` / `decision.model` / `poolHint`）**完全不动**。
- 与 OPS-150 正交：**不同 emit 站**（失败墙 vs 级联中间提示）。

## 验收（全绿）

- `npm run test:vision-failure-summary-display-name` → 7/7
  - 叶级 A–E：门开去前缀 / 门关 byte-revert / null·空·空白无模型行且不抛 / 裸名幂等 / 源级接线断言。
  - 端到端 F–G（harness：级联全失败 + OCR 读空 → 墙可见）：门开墙模型行无 `glm/` 含裸名 + 答复成功；
    门关墙模型行逐字节回退带前缀 + 答复成功。
- `node --check services/backend/src/services/gateway/visionFailureSummary.js` → OK
- 既有 `visionFailureSummaryOcrSuppress*`（2+4）零回归；CLI `visionNoticeDedup*`（7+3）零回归
  （它们喂合成串测 REPL 去重，不调 `buildVisionFailureMessage`）。

## 遗留（诚实上报，非本轮）

同一失败墙的 `真实失败原因:` 标签在原始报错已自带该标签（`aiGateway.js:301`
`真实失败原因:\n…`）时会**重复**成 `真实失败原因:真实失败原因:` = 另一枚 stutter 噪音。属**独立**
去重关切（应各自独立门 byte-revert），留作后续一轮。

## 红线

- 未 commit（分支 `feat/0.1.104-*`，须用户明确点头）。
- 无新密钥、无落盘、god-file 未新增超限（`visionFailureSummary.js` 约 224 行 << 2500）。
