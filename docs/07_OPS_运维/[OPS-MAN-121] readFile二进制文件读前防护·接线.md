# [OPS-MAN-121] readFile 二进制/压缩文件读前防护 · 接线（止住把 tar.gz 当文本注入模型导致卡死）

> 本文件为手写维护文档（此层是工具接线，无 `--gen-doc` 生成器）。
> 判定逻辑改在 `services/backend/src/tools/readBinaryGuard.js`（纯叶），
> 接线改在 `services/backend/src/tools/readFile.js` 的 `execute`。

## 这一层闭合什么：把已存在的 `detectFile.isBinary` 能力接进读工具

`services/formatInspect/fileFormatDetector.js` 早已提供 magic-bytes + NUL/非可打印启发的
`detectFile(absPath).isBinary` 判定，**写工具** `replaceAtLocation.js` 与文档工具
`inspectDocument.js` 都在消费它拒绝二进制——**唯独读工具 `tools/readFile.js` 从不消费**。
= **能力存在、没接线的代码**（非对称消费：写路径有防护、读路径漏了）。

## 真实故障：分析含 `.tar.gz` 的目录 → 卡死 1h+

现场：agent「分析 `D:\moonbit-linux` 项目」，目录含 MoonBit 工具链下载包。读取序列里
文本 `.sha256` 秒读；卡住的是 `moonbit-linux-x86_64.tar.gz`（二进制 gzip 压缩包），
「等待响应」1h2m34s。

根因（已复现）：`readFile.js` 只有「大小上限」防护（默认 2MB），**完全没有二进制探测**。
默认门控 `KHY_FILE_READ_LIMIT` 开 → 超限走「有界窗口」把前 2MB **当文本解码**；未超限则
全量解码（`readTextFileSmart`）。于是 tar.gz 的二进制字节被解码成含 NUL 的 mojibake，以
**`success: true`** 注入模型上下文。这坨含 NUL 字节的二进制垃圾 payload 发给（尤其中转/
relay 的）模型端点后让请求卡死/超时。文本 `.sha256` 同目录秒读，正好印证是二进制文件毒化
了请求。

## 修法：读前保守二进制探测 → 快速信息性拒绝

在 `readFile.execute` 里 `stat` + 目录检查之后、大小/解码之前插入防护：

```js
try {
  const { binaryReadGuardEnabled, isBinaryForRead, buildBinaryReadRefusal } = require('./readBinaryGuard');
  if (binaryReadGuardEnabled(process.env)) {
    const { detectFile } = require('../services/formatInspect/fileFormatDetector');
    const fmt = detectFile(filePath);            // 只读 head/tail 16KB,~1-6ms,有界
    if (isBinaryForRead(fmt)) {
      return { success: false, error: buildBinaryReadRefusal({...}), binary: true, format, size };
    }
  }
} catch { /* 探测失败 → 回退历史文本读取行为 */ }
```

- 拒绝消息点明**类型 + 大小**，并把 agent 重定向到正确工具：`analyzeBinary`（ELF/PE）/
  `UpstreamStudy`（只读列出压缩包目录、零解压）/ 先校验解压后再读文本；并给逃生门
  `KHY_READFILE_BINARY_GUARD=0`。
- `detectFile` 只读 head/tail（16KB/4KB），耗时 ~1-6ms，不会像旧路径那样解码 2MB 二进制。

## 保守边界（绝不误伤文本）

- `isBinaryForRead(fmt)` 仅当 `fmt.isBinary === true` 才拦；`fmt` 缺失 / 非对象 / isBinary
  非严格 true → 一律放行，让正常文本读取继续。源码 / html / json / 纯文本 → `isBinary:false`。
- **fail-soft**：探测抛错 → try/catch 跳过防护，回退历史文本读取（绝不因防护让正常读取失败）。
- **门控 `KHY_READFILE_BINARY_GUARD`**（default-on；env ∈ {0,false,off,no} 归一后关）：
  关 → 完全旁路，逐字节回退旧的「解码注入」行为。

## 恒久红线

- 纯叶 `readBinaryGuard.js` 零 IO、绝不抛；真正的探测 IO 在 `detectFile`（既有薄层）里。
- 只碰文件类型/大小元数据，不触任何密钥/内容值；`Number(null)===0` 陷阱已显式排除
  （size 缺失 → 「未知大小」，不当 0 B）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:readfile-binary-guard      # 纯叶单测（9 用例）
# LIVE：假 tar.gz → success:false 6ms（无垃圾注入）；.txt → success:true 行为不变；
#       KHY_READFILE_BINARY_GUARD=0 + tar.gz → 回退旧解码注入（字节等价）。
```
