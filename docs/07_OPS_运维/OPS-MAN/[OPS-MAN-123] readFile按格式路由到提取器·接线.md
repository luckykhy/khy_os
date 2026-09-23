# [OPS-MAN-123] readFile 按格式路由到已存在提取器 · 接线（让 khy 真正「读」各种格式，而非拒绝/卡死）

> 本文件为手写维护文档（此层是工具接线，无 `--gen-doc` 生成器）。承接 OPS-MAN-121。
> 编排逻辑改在 `services/backend/src/tools/readFileFormatRouter.js`（纯叶·async·DI 可测），
> 接线改在 `services/backend/src/tools/readFile.js` 的 `execute`。

## 这一层闭合什么：把已存在的提取器能力接进读工具

上一轮 OPS-MAN-121 给 `readFile.js` 接了「读前二进制探测 → 快速拒绝」，止住了把 `tar.gz`
当文本注入模型导致的 1h+ 卡死。但用户明确反馈：**「各种格式 khy 都要能阅读」——拒绝不是
终态**。

仓库里 PDF / 图片 / 压缩包 / docx 的**提取器早已存在且有界**（各自带超时 + 体积上限，故路由
天然不会卡死），但读工具 `readFile.js` 一个都没接线：

| 格式 | 提取器入口 | 位置 |
|---|---|---|
| PDF→文本 | `extractDocumentSnippetAsync` | `services/documentSnippetService.js`（pdftotext→pypdf→strings，超时 4.5s，≤24MB，扫描件回退 OCR） |
| 图片→OCR | `extractImageOcrSnippetAsync` | `services/ocrSnippetService.js`（docHelper.py tesseract，超时 4s，≤20MB） |
| 压缩包→清单+peek | `inspectArchive` + `buildArchiveManifest` | `services/archiveInspectService.js` / `services/archiveManifestPolicy.js`（node-tar/node-stream-zip **只列目录零解压** + 文本 peek） |
| docx→文本 | `docHelper.py docx_to_text` | `services/docHelper.py`（python-docx，写 .txt） |

这些提取器现只被 multimodal / upload / UpstreamStudy 消费，读工具从不 dispatch = 典型
**能力存在、没接线**。本层把这条线接上。

## 修法：命中二进制后，先路由到提取器读出内容，无提取器才落 OPS-121 拒绝

`readFile.execute` 在检测到二进制（`isBinaryForRead(fmt) === true`）后：

```js
if (isBinaryForRead(fmt)) {
  try {
    const { routeFormatRead } = require('./readFileFormatRouter');
    const routed = await routeFormatRead({ filePath, fmt, size: stat.size, env: process.env });
    if (routed && routed.handled) return routed.result;   // 真正读到内容 → 直接返回
  } catch { /* 路由失败 → 落 OPS-121 拒绝兜底 */ }
  return { success:false, error: buildBinaryReadRefusal({...}), binary:true, ... }; // OPS-121 不变
}
```

`routeFormatRead({ filePath, fmt, size, env, deps })`（`readFileFormatRouter.js`）按 detectFile
结果路由：
- `category === 'image'` → `extractImageOcr` → `【图片 OCR · <engine>】\n<text>`
- `format/magicFormat === 'pdf'` → `extractPdf` → `【PDF 文本 · <engine> · 取x/共y页】\n<text>`
- `format/magicFormat === 'docx'` → `extractDocx`（spawn `python3 docHelper.py docx_to_text
  <in> <tmp.txt>`，读回 tmp，**用后即删**）→ `【DOCX 文本 · python-docx】\n<text>`
- 压缩包（`category === 'archive'` 或路径像 `.zip/.tar/.tar.gz/.tgz`——裸 tar.gz magic 检测不到，
  靠扩展名）→ `inspectArchive` → `buildArchiveManifest` → 清单 + 抽读文本条目
- 其它（ELF/PE/xlsx/pptx/未知，或任一提取器返回 success:false / 抛错）→ `{ handled:false }`
  → 调用方落 OPS-121 拒绝。

## 三层可逐级回退（诚实降级）

1. **格式路由**（门 `KHY_READFILE_FORMAT_ROUTE`，default-on）：真正读出可读内容。
2. 门关 / 无提取器 / 提取失败 → **OPS-121 信息性拒绝**（门 `KHY_READFILE_BINARY_GUARD`，
   default-on）：点明类型+大小 + 重定向 analyzeBinary/UpstreamStudy/校验解压。
3. 两门都关 → **更旧的解码注入**（历史行为，逐字节回退）。

## 保守边界 / fail-soft

- `routeFormatRead` 整体 try/catch，**绝不抛**；任一提取器缺依赖（无 tesseract/pdftotext/python）
  / 超时 / 失败 → `{ handled:false }`，落 OPS-121 拒绝，绝不让正常读取失败、绝不卡死
  （提取器全有界）。
- 真正的提取器调用经 `deps`（DI）注入，默认 lazy-require 真实 service，故纯叶单测无需真跑
  python/pdftotext/tar。
- 只碰文件内容提取，不触任何密钥；docx 临时文件用后即删（不落盘残留）。

## 恒久红线

- 纯叶 `readFileFormatRouter.js` 除 docx 的 python spawn（有界·超时·清理）外无重 IO；真正的
  提取 IO 在既有 service 里。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:readfile-format-route      # 纯叶 DI 单测（20 用例）
npm run test:readfile-binary-guard      # OPS-121 无回归（9 用例）
# LIVE：真图 sample.png → success:true 含 OCR 文本；真 tar.gz → success:true 含目录清单+peek；
#       真 PDF → success:true 含 PDF 文本；KHY_READFILE_FORMAT_ROUTE=0 → 回退 OPS-121 拒绝；
#       真 ELF → 无提取器 → OPS-121 拒绝 + 重定向。
```
