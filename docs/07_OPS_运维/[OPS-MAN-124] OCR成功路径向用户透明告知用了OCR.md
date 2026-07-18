# [OPS-MAN-124] OCR 成功路径：向用户透明告知「用了 OCR」

## 背景（承 Rounds 8–10：从 OCR-失败诚实跨到 OCR-成功透明）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 应落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract）。前几轮（OPS-118/120/122）
守的都是**OCR-失败 / 读不出**一侧的不变量——「非视觉模型永不收到裸图」「绝不谎称没收到图」。
本轮（Round 11）把轴移到**OCR-成功**一侧：当 OCR **干净成功**、图片文字被准确读出时，最终回答
是否**无感但明显**地告诉用户「这次是用 OCR 读的图，不是原生看图」。

用户本轮新增诉求原文：**「Khy 无法正确读图降级到 OCR，要能无感明显告知用户用了 OCR 但能正确识别图片」。**

## 断桥

三处 OCR 成功注入点——Site 1（prep 期描述级联失败）、Site 2（prep 期 ocr-fallback）、
Site 3（post-failure 救援网）——注入 prompt 的结构都是：

```
[以下为图片 OCR 识别文本，请据此作答]   ← 面向【模型】的头
【图片1 OCR 文本】…                      ← OCR 读出的文字
+ 六条【条件型】告诫（_appendOcr*）        ← 只在结果有缺陷时才触发
```

六条 `_appendOcr*` 告诫（低置信 / 覆盖率 / 单图截断 / 语言包 / 方向 / 分辨率）**全是条件型**：

| 告诫 | 触发条件 |
| --- | --- |
| `_appendOcrLowConfidenceCaveat` | OCR 自评置信偏低 |
| `_appendOcrCoverageNotice` | 有图超上限被丢 / 读不出 |
| `_appendOcrTruncationNotice` | 单图 OCR 全文超上限被截断 |
| `_appendOcrLanguageNotice` | 请求语言被本机缺包窄化 |
| `_appendOcrOrientationNotice` | 图被 docHelper 自动旋正 |
| `_appendOcrResolutionNotice` | 低分辨率图被 docHelper 自动放大 |

**当 OCR 干净成功时，这六条一条都不触发**。于是注入 prompt 里只剩一个面向**模型**的
「请据此作答」头——它让模型据 OCR 文本作答，却从不要求模型**告诉用户**这段内容是经 OCR 读取
而非原生看图：

```
OCR 干净成功 → 六条条件型告诫全静默
→ 模型收到 OCR 文本 + 「请据此作答」头
→ 模型像自己「亲眼看图」一样作答
→ 用户全程不知道用了 OCR
```

这违反本轮「要能无感明显告知用户用了 OCR」的诉求：能力（准确识别）已经具备，缺的是
**成功路径上一条面向用户的「用了 OCR」透明披露**。

## 修复（全 additive · 独立门 `KHY_OCR_USAGE_DISCLOSURE` default-on · 门关逐字节回退）

把「OCR 成功 ⟹ 向用户透明告知用了 OCR」补成一条与六条条件型告诫**正交**的**无条件**披露：

1. **纯叶 `gateway/ocrUsageNotice.js`**：
   - `isEnabled(env)`：default-on，仅显式 `0/false/off/no` 关闭；env 经 opts 注入可测。
   - `buildUsageDisclosure({ count, env })`：门开且 `count>0`（OCR 成功提取到文本的图片数）时
     **无条件**返回一句面向模型的指令，要求它在正常作答的同时，用一句**自然、简短**的话向用户
     **明确**说明「本次图片内容是通过 OCR 文字识别读取的」——无感（不长篇、不影响正文）但明显
     （用户务必清楚用了 OCR）。门关 / `count` 缺失或非正 / 畸形 → `null`，逐字节回退。fail-soft：绝不抛。
2. **`aiGatewayGenerateMethod.js`**：新增 `_appendOcrUsageDisclosure(prompt, { count })` 辅助
   （镜像既有 `_appendOcr*` 形制），在**三处 OCR 成功注入点**的 `_appendOcrResolutionNotice`
   调用之后**无条件**接线：
   ```js
   prompt = _appendOcrResolutionNotice(prompt, ocrDetails);
   // OCR 成功路径「使用 OCR 透明告知」(无条件):上面六条告诫都是条件型,干净成功时全静默,模型
   // 据 OCR 文本作答却从不告诉用户用了 OCR。本条要求模型无感但明显地向用户披露。门关回退。
   prompt = _appendOcrUsageDisclosure(prompt, { count: ocrTexts.length });
   ```
   三处站点：Site 1（约 1569，`_ocrTexts.length`）、Site 2（约 1664，`ocrTexts.length`）、
   Site 3 post-failure 救援网（约 2832，`ocrTexts.length`）。
3. **`flagRegistry.js`**：登记
   `KHY_OCR_USAGE_DISCLOSURE: { mode: 'default-on', off: 'CANON', default: true }`。

**逐字节回退**：`KHY_OCR_USAGE_DISCLOSURE=off`（或叶子不可用）→ `_appendOcrUsageDisclosure`
原样返回 prompt → 等同历史「据 OCR 文本作答但不向用户披露」的行为（证明纯 additive）。

## 诚实边界（红线）

- **无条件 vs 条件型**：六条 `_appendOcr*` 披露的是 OCR 结果的**缺陷**（准确性 / 完整性 / 语言 /
  方向 / 分辨率）——只在有缺陷时才触发；本条披露的是**方法本身**（读图用的是 OCR 而非原生看图）
  ——在干净**成功**时也触发，恰好补上六条全静默的那个场景。
- **无感但明显**：措辞刻意要求模型「一句自然、简短的话」「不要长篇解释、不要影响正文回答」
  （无感），同时「务必让用户清楚知道这次用的是 OCR 而非原生看图」（明显）。
- **能力不回退**：披露只**追加**在 OCR 文本之后，绝不改动 OCR 读出的文字本身——准确识别的能力
  不受门控影响（门关时 OCR 文字照旧注入，只是不披露方法）。
- **只在成功时披露**：`count>0` 才触发；OCR 无文本（读不出）→ 不注入披露（那条路径由
  OPS-118/120/122 的「剥图必留痕」底线覆盖，语义不同：那是「收到图但读不出」，本条是
  「读出来了，且是用 OCR 读的」）。

## 验证

- 纯叶单测：`node --test services/backend/tests/gateway/ocrUsageNotice.test.js`（8/8）：FLAG 名、
  `isEnabled` 门控（默认开 / off-words 关）、`buildUsageDisclosure` 的**无条件**渲染（`count>0` 即注入、
  单复数措辞）与门关 / `count` 缺失或畸形 / 无参兜底的抑制。
- 端到端接线：`ocrUsageDisclosureWiring.test.js`（4/4，复用 OPS-122 双适配器 harness——视觉可用模型
  `gpt-4o` 逼 keep-routing → #1 运行时 404 拒图触发 post-failure 救援网 Site 3，#2 记录型文本适配器
  承接续跑，OCR 明细由 DI 桩控）：
  - A) 修复点：OCR **成功** + 披露门**开**（默认）→ prompt 同含 OCR 文本（`OCR 图像文本识别结果`
    / `发票 金额 100`）+ 披露指令（`通过 OCR 文字识别读取` / `向用户明确说明`），下游文本适配器据实作答；
  - B) 披露门**关**（`KHY_OCR_USAGE_DISCLOSURE=off`）→ **逐字节回退**（仍含 OCR 文本但无披露指令）；
  - C) 无回归：OCR **无文本**（读不出）→ 不注入披露（`count>0` 才触发）。
- **真实图片核验（`/goal` 要求）**：`ocrUsageDisclosureRealImage.test.js`（2/2，缺
  tesseract/eng/Pillow 或本机 tesseract 未从该图读出目标词时干净 skip）：PIL 渲染含清晰文字的真 PNG
  （`INVOICE 1234`，让**真 tesseract 读出**），模型 `gpt-4o`（视觉可用 → keep → 图保留到主级联），
  DI 一个**逐字节镜像生产实现**（base64 → `saveBase64ToTemp` → 真 tesseract）的 `extractImageOcrDetails`，
  双适配器级联（#1 运行时 404 拒图触发 `_visionFallback`，#2 记录型文本适配器承接续跑），断言：
  修复点 prompt 同含真 tesseract 读出的文字（`/INVOICE/`）+ 披露指令（`通过 OCR 文字识别读取`），
  下游据实作答；并附门关逐字节回退分支（仍含 OCR 文字但无披露）。
- 聚合：`npm run test:ocr-usage-disclosure`（14/14），并入 `test:maintainer:safety`（609/609）。

## 教训

Rounds 8–10 全在加固 **OCR-失败 / 读不出**一侧的诚实（「绝不谎称没收到图」，OPS-118/120/122 三站点
同一「剥图必留痕」不变量）。本轮把诚实轴移到 **OCR-成功**一侧：不是「读不出时别撒谎」，而是
「读出来了、且用的是 OCR 时，要**无感但明显**地让用户知道方法是 OCR」。判据 = 找「六条现有诚实告诫
全是**条件型**（只在结果有缺陷时触发），却没有一条在**干净成功**路径上**无条件**披露读图**方法**」的缺口；
修法 = 一条独立 default-on 门 + 无条件披露叶子，在三处 OCR 成功注入点的既有 `_appendOcr*` 链尾接线，
并保留逐字节回退。方法论：相同提示词每轮新收获 = 沿同一 consumer（OCR 兜底路径）找下一条**正交轴**——
这次从「失败诚实」跨到「成功透明」，覆盖六条条件型告诫全静默的那个场景。
