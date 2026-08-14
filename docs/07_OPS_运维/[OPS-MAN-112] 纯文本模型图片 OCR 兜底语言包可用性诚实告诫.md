# [OPS-MAN-112] 纯文本模型图片 OCR 兜底 —— 语言包可用性诚实告诫

## 背景（这是第四条正交诚实轴）

当模型不支持看图（纯文本 / 非多模态 / 识图模型不可用）时，khy 会落到 OCR 兜底路径
（gateway → `ocrSnippetService.js` → `docHelper.py` → tesseract），把图片里的文字提取出来
注入提示词，让文本模型据此作答。围绕「准确识别图片」这一目标，已建立多条**正交**的诚实轴：

| OPS | 轴 | 回答的问题 |
| --- | --- | --- |
| OPS-MAN-104 | 置信度（accuracy） | 提取出的**每个词**可不可信？ |
| OPS-MAN-109 | 覆盖度（coverage across images） | 是不是**所有图片**都被 OCR 了？（超 maxImages / 不可读被略过） |
| OPS-MAN-111 | 单图截断（completeness within one image） | **一张图**的 OCR 文本是不是被 maxChars 切短了？ |
| **OPS-MAN-112** | **语言包可用性（language availability）** | **请求的 OCR 语言**本机到底跑没跑起来？ |

第四条最直接服务于「准确识别图片」：即便文字清晰、图片完整、文本没截断，只要**本机没装对应
语言的 traineddata**，tesseract 也识不出那种语言的文字。

## 死字段（断桥）

`docHelper.py._resolve_lang(requested, available)` 会把请求的语言规格（如 `chi_sim+eng`）
**静默收窄**成本机已安装 traineddata 的子集；若一个都没装，退回 `eng`，再退回任意非 `osd` 语言。
它**只返回收窄后的 `lang`，从不返回原始请求**。

后果：用户发一张中文发票给纯文本模型，本机只装了 `eng`。tesseract 用 `eng` 去识中文，
要么识不出、要么把汉字误转写成乱码英文；而 khy 仍把这段不可靠文本原样注入、告诉模型
「请据此作答」。用户看不到「你要的中文语言包根本没装」——这就是死字段：上游算出了收窄
（`_resolve_lang` 内部知道丢了哪些语言），但这个信号跨层被丢弃，从不到达用户。

## 修复（全 additive · 门 `KHY_OCR_LANGUAGE_NOTICE` default-on · 门关逐字节回退）

信号链补齐（让被丢弃的原始请求一路带出来）：

1. **`docHelper.py`**：在 3 个 OCR 成功出口（`_ocr_via_cli` 的诚实结果与纯文本回退、
   `ocr_image` 的 pytesseract 成功）除已有的 `lang`（= 生效语言）外，新增
   `requestedLang`（= 原始请求 `lang`）。
2. **`ocrSnippetService.js`**：`_ocrImageWithDocHelper(Async)` 与
   `extractImageOcrSnippet(Async)` 的输出对象透传 `requestedLang`。
3. **`aiGateway.js`**：`extractImageOcrDetails` 每条 detail 携带 `lang` 与 `requestedLang`。
4. **纯叶 `gateway/ocrLanguageNotice.js`**：
   - `computeDroppedLangs(details)` —— 对每张图做「请求语言集 − 生效语言集」的集合差，
     去重排序返回被丢的语言；`osd` 不计（方向/脚本检测，非文本语言）；缺 `requestedLang`
     或畸形 → `[]`，绝不谎报。
   - `buildLanguageNotice({ dropped, env })` —— 渲染中文告诫，点名被丢语言 + 给出安装提示
     （如 `apt install tesseract-ocr-<lang>`）；空 / 门关 → `null`。
5. **`aiGatewayGenerateMethod.js`**：新增 `_appendOcrLanguageNotice(prompt, ocrDetails)`，
   在 3 个 OCR 注入点紧接 `_appendOcrTruncationNotice` 之后调用（fail-soft try/catch，
   叶子不可用则原样返回 prompt）。

## 诚实边界（红线）

- **只在真发生收窄时告警**：`requestedLang` 有、生效 `lang` 没有的语言才算被丢。请求 == 生效
  （语言包齐全）或 Python 无法内省（原样返回请求）→ 无丢弃、无告警、逐字节回退。
- **纯装饰**：只追加一段告诫，绝不改变成功/失败归属，绝不动「非多模态模型永不收裸图」的
  剥图不变量，畸形绝不抛。
- **门关即回退**：`KHY_OCR_LANGUAGE_NOTICE=off/0/false/no` → prompt 逐字节还原。

## 验证

- 纯叶：`node --test services/backend/tests/gateway/ocrLanguageNotice.test.js`（13/13）。
- 接线（断桥闭合）：`imageOcrLanguageWiring.test.js`（3/3，自带录制 adapter + DI）。
- **真实图片核验（`/goal` 要求）**：`ocrLanguageNarrowing.test.js`（2/2，0 skip）
  用 PIL 渲染 "INVOICE ACME 2026" / "TOTAL USD 1234"，在**无多模态模型**的纯 OCR 路径上：
  - A：`lang=eng`（已装）→ 文本命中 `/INVOICE/`、`/1234/`（准确识别），`requestedLang===lang===eng`，
    `computeDroppedLangs===[]`，`buildLanguageNotice===null`（不误报）。
  - B：`lang=eng+zzz`（`zzz` 永不存在）→ 文本仍命中 `/INVOICE/`，`requestedLang==='eng+zzz'`、
    `lang==='eng'`，`computeDroppedLangs===['zzz']`，告警触发命中 `/未安装以下 OCR 语言包/` 与 `/zzz/`。
- 聚合：`npm run test:ocr-language-notice`（三文件），并入 `test:maintainer:safety`。

## 教训

兜底诚实性不止「提取到文字」「文字可信」「文字完整」，还要「请求的语言到底跑没跑起来」。
上游 `_resolve_lang` 内部知道自己收窄了哪些语言，却只把生效语言带出、把原始请求丢弃——
这个「上游算出 + 跨层被默默丢弃」的 quality signal 就是死字段。判据 = grep 收窄后的
字段（`lang`）有消费者、而原始请求（`requestedLang`）在整条链路零消费者。装饰型告警只在
**确有丢弃**时触发，绝不把「未知 / 未收窄」谎报成「语言缺失」。
