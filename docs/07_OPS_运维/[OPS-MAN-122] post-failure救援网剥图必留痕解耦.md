# [OPS-MAN-122] post-failure 救援网：剥图必留痕与「OCR 无文本」分支解耦

## 背景（承 OPS-118 / OPS-120，第三处「剥图 ⟹ 必留痕」断桥）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 应落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract），并守住两条配对的安全不变量：
**① 非视觉模型永不收到裸图（剥图）；② 绝不谎称没收到图（留痕）**。前两条底线解耦轴都在
**prep 期的描述级联失败救援**（Site 1）：

| OPS | 站点 | 解耦对象 |
| --- | --- | --- |
| OPS-MAN-118 | prep 期 Site 1：描述级联全失败 → 可靠到达 OCR 底线 | 装饰门 `KHY_VISION_FAILURE_SUMMARY` |
| OPS-MAN-120 | prep 期 Site 1：空 OCR 时最小底线兜住剥图 | 功能门 `KHY_VISION_OCR_FALLBACK` |
| **OPS-MAN-122** | **post-failure 救援网：OCR 无文本时剥图 + 留痕** | **救援网空 OCR 分支（第三个站点）** |

本条 OPS-122 断桥在**另一个站点**：不是 prep 期的描述级联，而是**主级联失败后的 vision-fallback
救援网**（`aiGatewayGenerateMethod.js` 约 2755–2825）。当当前模型被判**支持视觉**
（`decideVisionRouting` = `keep`，图保留到主级联），某适配器在**运行时**以 `404 / model_not_found`
拒图 → `shouldOcrRescue` 把它提升为 `_visionFallback` → 救援网退回本地 OCR。

## 断桥

救援网里，OCR **提取到文本**时会剥图 + 注入 OCR 文本（既有行为）；但 OCR **无文本 / 抛错**
（常见：照片 / 场景类无字图，或 OCR 引擎抛错）时，历史上救援网只 `emitStatus(...)` 就 `break`：

```
OCR 无文本 → 只发一条状态提示 → break
= 图不剥、痕不留
→ 级联带着裸图继续 → 下游纯文本适配器静默丢图
→ 文本模型：「关键发现：当前对话中没有任何图片附件。我无法描述不存在的内容。」
```

（2026-07-12 用户实测 vision 级联 `glm-4.6v-flash → glm-4v-flash → 404 → socket hang up`，三次
幻觉「消息里没有附带图片 / 请把图片发给我 / 当前对话中没有任何图片附件」。）

根因：OCR-**成功**分支已**无条件**剥图并转纯文本继续级联，故 OCR-**无文本**分支也应**同款**剥图
并留痕——而非把裸图交给一个**神话中的下游视觉适配器**（`shouldOcrRescue` 已判定此适配器拒图，
prep 期视觉路由亦已穷尽更优选项）。这是与 prep 期 Site1/Site2 **同症、正交站点**的第三处断桥。

## 修复（全 additive · 独立门 `KHY_VISION_RESCUE_STRIP_FLOOR` default-on · 门关逐字节回退）

把 post-failure 救援网的「剥图必留痕」与「OCR 无文本」分支**解耦**：

1. **纯叶 `gateway/visionOcrFallback.js`** 新增 `isRescueStripFloorEnabled(env)`：default-on，
   仅显式 `0/false/off/no` 关闭；env 经 opts 注入可测。
2. **`aiGatewayGenerateMethod.js`（`_visionFallback` 块，`break` 之前）**：加一处**门控守卫**，
   仅当门开 且 `hasImageInput` 且 `!_ocrFallbackApplied` 且仍有图像时触发（故 OCR-成功分支
   已 `_ocrFallbackApplied=true` 时**跳过**，无回归）——与 OCR-成功分支**同款无条件剥图**并注入
   诚实底线：优先 `buildVisionUnreadableNote`（救援网前置条件是 `KHY_VISION_OCR_FALLBACK` **开**，
   故此说明可用），叶子/说明缺失时退回 `buildStrippedImageFloorNote` 兜底：
   ```js
   const _rescueFloorOn = require('./visionOcrFallback').isRescueStripFloorEnabled(process.env);
   if (_rescueFloorOn && hasImageInput && !adapterOptions._ocrFallbackApplied
       && Array.isArray(adapterOptions.images) && adapterOptions.images.length > 0) {
     let _note = null;
     try { _note = require('./visionOcrFallback').buildVisionUnreadableNote({ count: _imgCount }); } catch {}
     if (!_note) {
       try { _note = require('./visionOcrFallback')
         .buildStrippedImageFloorNote({ count: _imgCount, env: process.env }); } catch {}
     }
     if (_note) prompt = `${prompt || ''}\n\n${_note}`;
     adapterOptions.images = [];
     adapterOptions._ocrFallbackApplied = true;
     options = { ...options, images: undefined, _ocrFallbackApplied: true };
     hasImageInput = false;
   }
   ```
3. **`flagRegistry.js`**：登记
   `KHY_VISION_RESCUE_STRIP_FLOOR: { mode: 'default-on', off: 'CANON', default: true }`。

**逐字节回退**：`KHY_VISION_RESCUE_STRIP_FLOOR=off`（或叶子不可用）→ 守卫不触发 → 图留着、
仅上方状态提示，等同历史行为（把断桥交回，证明纯 additive 解耦）。

## 诚实边界（红线）

- **剥图 ⟹ 必留痕**：救援网 OCR 无文本时，只要非视觉适配器的裸图被剥离，就至少留下一句
  「收到图但读不出」，绝不让裸图静默漂到下游被丢弃。
- **前置条件**：救援网本身受 `KHY_VISION_OCR_FALLBACK` 约束（`shouldOcrRescue` 门关恒 false），
  故 `_visionFallback` 触发时 OCR 功能门必然是开的 → 注入的是标准 `buildVisionUnreadableNote`，
  `buildStrippedImageFloorNote` 仅作叶子不可用时的防御兜底。
- **三门正交、三站点覆盖同一不变量**：`KHY_VISION_OCR_FALLBACK`（OCR 救援是否启用 / OCR 说明是否渲染）
  · `KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR`（OPS-118，prep 期底线路径是否执行）
  · `KHY_VISION_STRIP_IMAGE_FLOOR`（OPS-120，prep 期 OCR 说明缺席时最小底线）
  · `KHY_VISION_RESCUE_STRIP_FLOOR`（OPS-122，post-failure 救援网 OCR 无文本时剥图 + 留痕）。
- **门关即回退**：证明本轮改动是纯 additive 的解耦。

## 验证

- 纯叶 + 接线：`node --test services/backend/tests/gateway/visionRescueStripFloorWiring.test.js`（4/4）：
  - A) 救援网触发 + OCR 无文本 + 底线门**开**（默认）→ 剥图 + 注入底线（`[图像无法读取]` +
    「绝不能说没有收到图片」）+ 下游文本适配器据实作答；
  - B) 底线门**关**（`KHY_VISION_RESCUE_STRIP_FLOOR=off`）→ **逐字节回退**（裸图存活到下游、无痕）；
  - C) OCR **有文本** → 走既有 OCR 文本注入，救援底线不登场（无回归）。
- **真实图片核验（`/goal` 要求）**：`visionRescueStripFloorRealImage.test.js`（2/2，缺
  tesseract/eng/Pillow 或空白图意外出字时干净 skip）：PIL 渲染真 PNG（无字渐变，让**真 tesseract**
  读空），模型 `gpt-4o`（视觉可用 → keep → 图保留到主级联），DI 一个**逐字节镜像生产实现**
  （base64 → `saveBase64ToTemp` → 真 tesseract）的 `extractImageOcrDetails`，双适配器级联
  （#1 运行时 404 拒图触发 `_visionFallback`，#2 记录型文本适配器承接续跑），断言：修复点剥图 + 留痕
  （`[图像无法读取]`），下游文本适配器据实作答；并附门关逐字节回退分支（裸图存活到下游）。
- 聚合：`npm run test:vision-rescue-strip-floor`，并入 `test:maintainer:safety`。

## 教训

OPS-118 判据「安全代码被藏进**装饰门**」→ OPS-120「安全代码被藏进**功能门**」→ 本轮 OPS-122
把同一「剥图 ⟹ 必留痕」不变量追到**第三个站点**：prep 期两条底线（118/120）都假设走
describe 级联失败路径，而**主级联失败后的 vision-fallback 救援网**是另一条正交控制流——其空 OCR
分支历史上只发状态提示就 break，裸图静默漂到下游被丢弃。判据 = 找「OCR-**成功**分支已无条件剥图 +
留痕」而「OCR-**无文本** / 抛错分支只 emitStatus 就 break」的**同一不变量在同一救援网内的不对称**；
修法 = 用独立 default-on 门把空 OCR 分支补成与成功分支同款「剥图 + 留痕」，并保留逐字节回退。
方法论：相同提示词每轮新收获 = 沿同一 consumer / 同一症状（「谎称没收到图」）找下一条**正交站点**
的断桥。
