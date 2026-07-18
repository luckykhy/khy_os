# [OPS-MAN-146] 主读工具 FileReadTool 防卡死守卫族 parity 接线

## 一句话

把整个防卡死读守卫族(special / pseudo / binary / format)从 `readFile.js` 补齐到**面向模型的主读工具 `Read`(FileReadTool)**。承 OPS-143(win-device 已接两条路径),本发关掉「主读路径裸奔」这个最大遗留缺口——模型按 Claude Code 惯例主要调 `Read`,而它此前只有 winDevice 一条守卫。

## 断桥判据(为什么这是真缺口)

`tools/index.js` 同时把两条读定义暴露给模型:

- `Read` → 形参 `file_path`,由 `FileReadTool/index.js` 承载,`alwaysLoad`,**模型主要调它**。
- `readFile` → 形参 `path`,由 `readFile.js` 承载。

靠 `getDefinitions()` + 各自 `inputSchema` 形参名实证两条并存的 backing。历史上 OPS-118/120/121/123 的整个防卡死守卫族**只接在 readFile.js**;FileReadTool 自有 `execute()` 独立 `existsSync`/`statSync`,`validateInput` 仅 `validateNotDevicePath`(POSIX /dev/* 精确集)+ `validateNotUNCPath`(`\\` 前缀)。→ 模型走 `Read` 时:

- FIFO / 套接字 / 字符或块设备 → 读第一个字节**永久阻塞**(卡死),无守卫。
- `/proc/kmsg` 等阻塞伪文件 → 读**永久阻塞**(卡死),无守卫。
- 二进制/压缩文件 → 解码成乱码注入模型上下文(拖垮请求),无守卫。

## 本次改动(全 additive · 各门 default-on · 门关字节回退历史行为)

| 文件 | 变更 |
|---|---|
| `services/backend/src/tools/FileReadTool/index.js` | `execute()` 内接三块守卫(与 readFile.js 同门、同叶函数):**special**(`KHY_READFILE_SPECIAL_GUARD`)在 `isDirectory` 后、图片检测前,用已算好的 `stat` 类型谓词拦 FIFO/设备;**pseudo**(`KHY_READFILE_PSEUDO_GUARD`)紧随其后,对 `/proc`·`/sys` 走可被 timeout 杀掉的子进程有界读;**binary + format**(`KHY_READFILE_BINARY_GUARD` / `KHY_READFILE_FORMAT_ROUTE`)包在 `if (!isImage)` 内、文本读取前,命中二进制先按格式路由到提取器、否则 OPS-121 拒绝。全部 fail-soft。 |
| `services/backend/tests/tools/fileReadToolGuardParity.test.js` | **新测**(9 例):源级接线断言(三块 require + 门控消费 + 顺序:special/pseudo 排在图片检测与文本读取前、binary 仅对非图片生效)+ execute 行为断言(纯文本无回归 / 二进制被拒不解码 / .png 不被二进制守卫拦仍走图片路 / FIFO 瞬时拦下不卡死)。 |

## 顺序不变量(为何这样排)

1. **special / pseudo 必须在图片检测与 `readTextFileSmart` 之前**:读非常规文件/阻塞伪文件的第一个字节即卡死,连 `detectFile` 探 magic 字节都会先挂;`fs.statSync` 对 FIFO/设备只读元数据、瞬时返回不阻塞,故用 stat 类型谓词安全判定。
2. **binary 守卫仅对非图片生效(`if (!isImage)`)**:图片(按扩展名)走 FileReadTool 既有 base64/OCR 专路;若 binary 守卫在图片前生效,PNG/JPG 是二进制会被 formatRouter 抢走 → 破坏图片行为。故包在 `!isImage` 内,只拦非图片二进制。

## 验收(本次全绿)

- `node --check` FileReadTool + 新测 OK。
- 新 parity 测 **9/9**;FileReadTool 自身行为 **23/0** 零回归;族叶(binary/special/pseudo/format/winDevice)**87/0**。
- **主读路径 LIVE 冒烟 5/5**(经 `FileReadTool.execute`):FIFO 1ms 拦下(不卡死)/ `/proc/cpuinfo` 23ms 有界读出(不卡死)/ ELF 二进制被拒(`binary:true` 不解码)/ 纯文本正常读出 / `.png` 仍走图片路(`type:image`,未被二进制拦)。
- change-safety(显式 positional 2 文件)exit0 · agent-rules / leaf-contract / flag-registry passed · node-syntax **4352 净** · maintainer0。
- god-file:FileReadTool 331 行 / 新测 105 行(均 < 2500;本仓 arch:god 靠 `wc -l` 直验)。

## 教训

- **主读工具靠 `getDefinitions()` + `inputSchema` 形参名实证**,别信 `tools/index.js` 注释「子目录工具优先」——实测 `Read`(FileReadTool)与 `readFile`(readFile.js)双暴露,守卫只接非主路径 = 真缺口。
- 防卡死守卫族接**任何**读路径时,顺序不变量比接线本身更关键:阻塞类(special/pseudo)排在一切读之前;格式类(binary)仅对非图片生效,别抢图片专路。
- 承 OPS-143 的诚实遗留,逐条补齐 + 每条配源级接线断言 + 真实 `execute` 行为断言(含 FIFO/`/proc` 真跑,证不卡死),不静默扩容。
