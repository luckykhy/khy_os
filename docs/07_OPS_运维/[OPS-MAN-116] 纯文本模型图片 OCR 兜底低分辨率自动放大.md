# [OPS-MAN-116] 纯文本模型图片 OCR 兜底 —— 低分辨率自动放大（第二条**纠正型**轴）

## 背景（六条正交诚实轴，两条纠正）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract），把图里文字提取出来注入
提示词让文本模型据此作答。围绕「准确识别图片」，已建立多条**正交**诚实轴：

| OPS | 轴 | 性质 | 回答的问题 |
| --- | --- | --- | --- |
| OPS-MAN-104 | 置信度（accuracy） | 告知 | 提取出的**每个词**可不可信？ |
| OPS-MAN-109 | 覆盖度（coverage） | 告知 | 是不是**所有图片**都被 OCR 了？ |
| OPS-MAN-111 | 单图截断（completeness） | 告知 | **一张图**的文本被 maxChars 切短了吗？ |
| OPS-MAN-112 | 语言包可用性（language） | 告知 | **请求的语言**本机跑没跑起来？ |
| OPS-MAN-115 | 方向自动校正（orientation） | **纠正** | 图是不是**转向了**？——并**真的把它转正读对** |
| **OPS-MAN-116** | **低分辨率自动放大（resolution）** | **纠正** | 图是不是**太小/太糊**？——并**真的把它放大读对** |

前四条只把问题**披露**给模型；OPS-115 与本条是两条**纠正型**轴，真正**恢复正确文本**：
方向轴管「转正」，本条管「放大」——两条正交（一张图可能既转向又低分辨率，各自独立处理）。
本条最直接地服务于「**准确**识别图片」中**分辨率过低的小图**这一类。

## 断桥（低分辨率图 = 原尺寸读出「空」）

tesseract 想要约 300 DPI。一张分辨率过低的小图（例如把 460×120 的发票硬缩到 92×24），在
**原始尺寸**下 tesseract **读不出任何东西**——不是 OPS-115 那种「看着置信度不低的乱码」，而是
直接 `success:false / 空文本`。也就是说：低分辨率图在原尺寸下让纯文本模型**一个字都拿不到**，
而同一张图放大 2× 后 conf ≈ 95、准确读出全文。上游明明能通过放大算出可用文本，却从不尝试。

## 修复（全 additive · 门 `KHY_OCR_UPSCALE` default-on · 门关逐字节回退）

在 `docHelper.py` 用**暴力择优放大**真正把小图读对：

1. **`docHelper.py._maybe_upscale(bin_path, image_path, eff_lang, base)`**：
   - 门关（`KHY_OCR_UPSCALE=off/0/false/no`）→ 原样返回 `base`。
   - **只在可能有问题时才尝试**：已经读得好的页面（`needsAiFallback` 不为 True 且
     `base conf >= 80`，`_UPSCALE_SKIP_CONF = 80.0`）**绝不放大**。
   - 需要 PIL/Pillow；缺失或任何异常 → 逐字节回退 `base`。
   - **源图已够大则跳过**：`max(w,h) >= 1000`（`_UPSCALE_MAX_SRC`）不放大。
   - 暴力试 2/3/4×（`Image.resize(..., Image.LANCZOS)`），放大后若超过 4000px
     （`_UPSCALE_MAX_DST`）跳过该倍数；每个倍数用 `_ocr_via_cli_with_confidence` 重新 OCR，
     保留置信度最高的成功结果。
   - **接受门槛（防无谓放大）**：仅当 `best conf >= 60`，**且**（当 `base` 本已有文本时）
     `best conf >= base conf + 20` 才接受，否则回退 `base`。
   - 接受时打 `upscaledFactor=<applied factor>`；未放大则 `upscaledFactor=0`。
   - 接线进 3 个 OCR 成功出口：`_ocr_via_cli` 诚实路径、纯文本降级路径（=0）、
     `ocr_image` 的 pytesseract 路径。
2. **`ocrSnippetService.js`**：`_ocrImageWithDocHelper(Async)` 与
   `extractImageOcrSnippet(Async)` 输出对象透传 `upscaledFactor`。
3. **`aiGateway.js`**：`extractImageOcrDetails` 每条 detail 携带 `upscaledFactor`。
4. **纯叶 `gateway/ocrResolutionNotice.js`**：
   - `computeUpscaledFactors(details)` —— 收集所有 `upscaledFactor > 1` 的倍数，去重升序；
     缺字段（旧缓存明细）/ 畸形 / 非数组 → `[]`，绝不抛。
   - `buildResolutionNotice({ upscaled, env })` —— 渲染中文告诫，点名放大倍数、说明文本取自
     放大后的低分辨率图像、结果可能仍不完整、建议改用高清原图或多模态模型复核；
     空 / 门关 / 非数组 → `null`。
5. **`aiGatewayGenerateMethod.js`**：新增 `_appendOcrResolutionNotice(prompt, ocrDetails)`，
   在 3 个 OCR 注入点紧接 `_appendOcrOrientationNotice` 之后调用（fail-soft try/catch）。

## 诚实边界（红线）

- **纠正是真的、告诫是装饰**：文本确从原尺寸读空的小图放大复原（真收获）；那段中文告诫只是
  说明来源，可被门关抑制，绝不改变成功/失败归属，绝不动「非多模态模型永不收裸图」的剥图不变量。
- **保守不误放大**：好页面（conf≥80 且未触发 fallback）绝不放大；源图已 ≥1000px 跳过；放大结果
  须比原方向高 ≥20 分（当原本有文本时）且绝对 ≥60 才接受——专门挡住无谓放大。
- **门关即回退**：`KHY_OCR_UPSCALE=off` → 单趟 OCR 原始结果，逐字节还原，`upscaledFactor=0`。

## 验证

- 纯叶：`node --test services/backend/tests/gateway/ocrResolutionNotice.test.js`（13/13）。
- 接线（断桥闭合）：`imageOcrResolutionWiring.test.js`（3/3，自带录制 adapter + DI）。
- **真实图片核验（`/goal` 要求）**：`ocrResolutionRecovery.test.js`（3/3，0 skip），
  用 PIL 渲染 "INVOICE ACME 2026" 再硬缩到约 92×24，在**无多模态模型**的纯 OCR 路径上：
  - 门关 + 低分辨率图：原尺寸读不出（`success:false`，不含 `/INVOICE/`），`upscaledFactor===0`；
    这与方向轴不同——低分辨率图读出的是**空**而非乱码。
  - 门开 + 低分辨率图：文本被放大复原，命中 `/INVOICE/`（**准确识别**），`upscaledFactor>1`
    （实测 2×），`computeUpscaledFactors` 非空、告诫触发命中 `/自动放大/` 与倍数。
  - 门开 + 高清图（对照）：清晰图**绝不被无谓放大**，`upscaledFactor===0`，无告诫，照常识别。
- 聚合：`npm run test:ocr-resolution-notice`（三文件），并入 `test:maintainer:safety`。

## 教训

兜底诚实性的第二条**纠正型**轴。与方向轴（转向图产出「高置信乱码」、部分逃过低置信旗标）不同，
低分辨率图在原尺寸下产出的是**空**——上游明明能通过放大算出可用文本却从不尝试，是另一种断桥。
判据 = 上游能算出更优结果（放大后从「读空」变「conf 95 读对」）却从不尝试。纠正只在**放大确有
更优结果且提升够大**时发生：好图/大图绝不放大，须 `best≥60` 且（原有文本时）`best≥base+20`。
「测不猜」纪律关键：初始假设「小字号 OCR 失败」是错的——清晰合成文字即便 10px 也能读；真正的
低分辨率断桥要用「渲大 → 硬缩」制造，实测恢复窗口在缩放 0.20（92×24，原尺寸读空、2× 放大读对）。
