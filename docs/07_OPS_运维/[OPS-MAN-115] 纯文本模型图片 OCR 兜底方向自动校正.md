# [OPS-MAN-115] 纯文本模型图片 OCR 兜底 —— 方向自动校正（第一条**纠正型**轴）

## 背景（前四条只「告知」，这条真「修好」）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract），把图里文字提取出来注入
提示词让文本模型据此作答。围绕「准确识别图片」，已建立多条**正交**诚实轴：

| OPS | 轴 | 性质 | 回答的问题 |
| --- | --- | --- | --- |
| OPS-MAN-104 | 置信度（accuracy） | 告知 | 提取出的**每个词**可不可信？ |
| OPS-MAN-109 | 覆盖度（coverage） | 告知 | 是不是**所有图片**都被 OCR 了？ |
| OPS-MAN-111 | 单图截断（completeness） | 告知 | **一张图**的文本被 maxChars 切短了吗？ |
| OPS-MAN-112 | 语言包可用性（language） | 告知 | **请求的语言**本机跑没跑起来？ |
| **OPS-MAN-115** | **方向自动校正（orientation）** | **纠正** | 图是不是**转向了**？——并**真的把它转正读对** |

前四条都只是把问题**披露**给模型（「这段文字可能不可信 / 不完整 / 语言没装」）；本条是第一条
**纠正型**轴：它不止告知「图转向了」，而是真的把图旋正、重新 OCR、用**读对的文本**替换乱码，
最直接地服务于「**准确**识别图片」。

## 断桥（转向图 = 高置信度的乱码）

一张旋转 90° 的照片，tesseract 在原方向会 OCR 出**看着置信度不低的乱码**：实测单行乱码
conf ≈ 51、两行乱码 conf ≈ 62——**≥60 的那部分恰好逃过 OPS-104 的 `<60 → needsAiFallback`
低置信度旗标**；而同一张图旋正后 conf ≈ 95。也就是说：只靠置信度轴，转向图会被当成「置信度
还行」的文本原样注入，模型被喂了乱码却以为权威。tesseract 自带的方向检测 `--psm 0`（OSD）
在**稀疏文本**上不可靠（"Too few characters. Skipping this page"），不能依赖。

## 修复（全 additive · 门 `KHY_OCR_AUTO_ORIENT` default-on · 门关逐字节回退）

在 `docHelper.py` 用**暴力择优**（不依赖 OSD）真正把图转正：

1. **`docHelper.py._maybe_reorient(bin_path, image_path, eff_lang, base)`**：
   - 门关（`KHY_OCR_AUTO_ORIENT=off/0/false/no`）→ 原样返回 `base`。
   - **只在可能有问题时才尝试**：已经读得好的页面（`needsAiFallback` 不为 True 且
     `base conf >= 80`，`_ORIENT_SKIP_CONF = 80.0`）**绝不扰动**。
   - 需要 PIL/Pillow；缺失或任何异常 → 逐字节回退 `base`。
   - 暴力试 90/180/270（`Image.rotate(-deg, expand=True)`），每个方向用
     `_ocr_via_cli_with_confidence` 重新 OCR，保留置信度最高的成功结果。
   - **接受门槛（防「高置信乱码」误纠正）**：仅当 `best conf >= 60` **且**
     `best conf >= base conf + 20` 才接受，否则回退 `base`。
   - 接受时打 `orientationCorrected=<applied deg>`；未纠正则 `orientationCorrected=0`。
   - 接线进 3 个 OCR 成功出口：`_ocr_via_cli` 诚实路径、纯文本降级路径（=0）、
     `ocr_image` 的 pytesseract 路径。
2. **`ocrSnippetService.js`**：`_ocrImageWithDocHelper(Async)` 与
   `extractImageOcrSnippet(Async)` 输出对象透传 `orientationCorrected`。
3. **`aiGateway.js`**：`extractImageOcrDetails` 每条 detail 携带 `orientationCorrected`。
4. **纯叶 `gateway/ocrOrientationNotice.js`**：
   - `computeCorrectedOrientations(details)` —— 收集所有 `orientationCorrected > 0` 的角度，
     去重升序；缺字段（旧缓存明细）/ 畸形 / 非数组 → `[]`，绝不抛。
   - `buildOrientationNotice({ corrected, env })` —— 渲染中文告诫，点名旋正角度、说明
     文本取自旋正后的图像、原方向乱码已丢弃；空 / 门关 / 非数组 → `null`。
5. **`aiGatewayGenerateMethod.js`**：新增 `_appendOcrOrientationNotice(prompt, ocrDetails)`，
   在 3 个 OCR 注入点紧接 `_appendOcrLanguageNotice` 之后调用（fail-soft try/catch）。

## 诚实边界（红线）

- **纠正是真的、告诫是装饰**：文本确被旋正复原（真收获）；那段中文告诫只是说明来源，
  可被门关抑制，绝不改变成功/失败归属，绝不动「非多模态模型永不收裸图」的剥图不变量。
- **保守不误纠**：好页面（conf≥80 且未触发 fallback）绝不扰动；旋转结果须比原方向高
  ≥20 分且绝对 ≥60 才接受——专门挡住「高置信乱码」把好图旋歪。
- **门关即回退**：`KHY_OCR_AUTO_ORIENT=off` → 单趟 OCR 原始结果，逐字节还原，`orientationCorrected=0`。

## 验证

- 纯叶：`node --test services/backend/tests/gateway/ocrOrientationNotice.test.js`（13/13）。
- 接线（断桥闭合）：`imageOcrOrientationWiring.test.js`（3/3，自带录制 adapter + DI）。
- **真实图片核验（`/goal` 要求）**：`ocrOrientationRecovery.test.js`（3/3，0 skip），
  用 PIL 渲染 "INVOICE ACME 2026" / "TOTAL USD 1234" 再旋转，在**无多模态模型**的纯 OCR 路径上：
  - 门关 + 旋转图：原方向读出乱码（不含 `/INVOICE/`），`orientationCorrected===0`；此乱码
    conf ≈ 62（`needsAiFallback===false`）——正是逃过置信度轴、只有纠正型轴能读对的那一类。
  - 门开 + 旋转图：文本被旋正复原，命中 `/INVOICE/` 与 `/1234/`（**准确识别**），
    `orientationCorrected>0`，`computeCorrectedOrientations` 非空、告诫触发命中 `/旋转校正/`。
  - 门开 + 正向图（对照）：好图**绝不被误旋转**，`orientationCorrected===0`，无告诫，照常识别。
- 聚合：`npm run test:ocr-orientation-notice`（三文件），并入 `test:maintainer:safety`。

## 教训

兜底诚实性的下一层不止「披露问题」，还能「纠正问题」——这是第一条真正**恢复正确文本**的轴。
转向图产出的「高置信度乱码」（conf 51–62）**部分逃过**了低置信度旗标（<60），所以单靠置信度轴
不够；必须用暴力择优（OSD 在稀疏文本上不可靠）把图转正，并用「best ≥ base+20 且 ≥60」的
接受门槛挡住误纠正。判据 = 上游能算出更优方向（旋正后 conf 远高于原方向）却从不尝试、把乱码
当权威注入。纠正只在**确有更优方向且提升够大**时发生，绝不把好图旋歪。
