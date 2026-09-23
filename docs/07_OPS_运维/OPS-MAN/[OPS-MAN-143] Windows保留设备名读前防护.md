# [OPS-MAN-143] Windows 保留设备名读前防护(第五条卡死向量·跨系统)

## 一句话
读取工具的读前防护家族此前覆盖三类 **POSIX** 卡死向量(特殊文件 / 伪文件 / `/dev/*` 名单),
但对 **Windows 保留 DOS 设备名**(`CON` / `COM1`–`COM9` / `NUL` / `LPT1`–`LPT9` / `\\.\` 设备命名空间)
**零覆盖**。离机继任机是 Windows,读到这些名字会**永久等待设备输入而卡死** ——
正是「阅读工具不对不支持,长时间卡死」在跨系统场景的复现。本发补上第五条纯路径守卫。

## 断桥判据(为什么这是真缺口)
- `specialFileReadGuard`:按 `fs.stat` 类型拦 FIFO/套接字/字符·块设备 —— **POSIX 语义**。
- `pseudoFileReadGuard`:拦 Linux `/proc`·`/sys` —— 显式 `platform !== 'linux' → null`。
- `inputValidators.validateNotDevicePath` → `shellClassifier.isBlockedDevicePath`:
  一张 **POSIX `/dev/*` 精确名单**(exact-match Set:`/dev/zero`、`/dev/tty`、`/dev/stdin`…)。
- 三者对 Windows 保留设备名**毫无覆盖**。`fs.statSync('COM1')` 之后的读取会阻塞等待串口输入。

## 本次改动(全 additive · 门 `KHY_READFILE_WIN_DEVICE_GUARD` default-on · 门关字节回退历史行为)
| 文件 | 改动 |
| --- | --- |
| `services/backend/src/tools/winDeviceReadGuard.js` | **新叶**(纯路径 · 零 IO · 绝不抛)。`classifyWindowsDevice(path, platform)` → `'reserved-name'` / `'device-namespace'` / `null`;`winDeviceGuardEnabled(env)`;`buildWinDeviceRefusal(info)`。 |
| `services/backend/src/tools/readFile.js` | 在 `path.resolve` 之后、**`fs.statSync` 之前**接线(必须在触碰设备前拦下);fail-soft。 |
| `services/backend/src/tools/FileReadTool/index.js` | **主读工具 `Read`**(面向模型 · `file_path` 形参 · `alwaysLoad`)。与 readFile.js 是**并行两条读路径**,模型多按 `Read` 惯例调用。其自有 `execute()` 走独立 `fs.existsSync`/`fs.statSync`,`validateInput` 只有 `validateNotDevicePath`(POSIX /dev/* 精确集)+ `validateNotUNCPath`(`\\` 前缀,拦得住 `\\.\COM1` 但**拦不住裸保留名**)→ win-device 卡死缺口在主路径**仍活着**。在 `path.resolve` 之后、`existsSync`/`statSync` 之前接同一守卫(同门 · fail-soft · 门关字节回退)。 |
| `services/backend/tests/tools/winDeviceReadGuard.test.js` | 16 例:门控 / win32 正例(裸名 · 带扩展名 · 带目录 · 命名空间前缀)/ win32 反例(`CONFIG`/`COM10`/`foo.con`)/ 非 win32 平台门 / null-safe / 拒绝消息 / 源级接线(readFile.js **与** FileReadTool 均 require 守卫且排在 `statSync` 前)。 |

> 注:本守卫家族的门控**不登记进 flagRegistry**(与 `KHY_READFILE_SPECIAL_GUARD` 等四个兄弟一致);
> 门语义与 HOW-TO-EXTEND 全写在叶子头注释里。

## Windows 保留名判定规则(与 Win32 语义一致)
- 保留名无关**目录**、无关**扩展名**:`C:\tmp\COM1.log` 仍解析到 COM1 → 取 basename 去掉首个 `.` 后的词干判定。
- 词干尾部**空格与点被忽略**(`CON ` / `CON.` 仍是 CON)。
- `CONFIG` / `COM10` / `foo.con` **不是**设备(词干为 CONFIG / COM10 / FOO)→ 放行。
- `\\.\...` 与 `\\?\GLOBALROOT\...` 是显式设备路径 → 拦;`\\?\C:\长路径` 只是扩展长度前缀的普通路径 → 放行。
- **平台门**:仅 `platform === 'win32'` 生效;POSIX 上 `con`/`nul`/`com1` 是合法文件名,一律 `null`。

## 验收(本次全绿)
- 新测 14/14 pass。
- LIVE(Linux 宿主):文件字面名 `CON` 正常读出(**无 POSIX 误伤**),普通文件正常读;
  谓词 `classifyWindowsDevice('…COM1.log','win32')='reserved-name'`、`(…,'linux')=null`。
- 回归:兄弟读守卫 `special`/`pseudo`/`binary` 套件 51/51 pass。
- 守卫:change-safety / agent-rules / leaf-contract / flag-registry positional 全 exit0。
- god-file:新叶 125 行;`readFile.js` 235 行;`FileReadTool/index.js` 274 行(均 < 2500)。
- 主读工具 LIVE 冒烟(经 `FileReadTool.execute`):(a)真文件读出内容不误拦;(b)Linux 上名为 `CON` 的文件正常读出(平台门 → null);(c)win32 模拟 `C:\temp\COM1.log` → `reserved-name` → 中文拒绝。

## 双读路径发现(本发关键)

`tools/index.js` 同时暴露两条读定义给模型:`Read`(FileReadTool,`file_path`)与 `readFile`(readFile.js,`path`)。此前整个防卡死守卫族(win-device / special / pseudo / binary / format)**只接在 readFile.js**,而模型多按 Claude Code 惯例调用 `Read`(FileReadTool)→ 主路径其实**裸奔**。本发已将 win-device 守卫补到**两条**路径。

> **诚实遗留(建议后续 parity 章)**:另外四条族守卫(`readBinaryGuard` / `readFileFormatRouter` / `specialFileReadGuard` / `pseudoFileReadGuard`)目前仍只在 readFile.js,尚未接入主读工具 FileReadTool。本发按 B3 只做 win-device 一条(纯路径 · 前置 stat · 零副作用,单会话可验证零回归);把 special/pseudo/binary/format 镜像进 FileReadTool 涉及其自有 image/OCR/编码/超限分支的顺序,回归面更大,应另开一章逐条接线 + 真实读路径回归后再上。

## 教训
- 「阅读工具卡死」的下一条正交缺口 = **跨系统**维度:既有守卫全是 POSIX 语义,Windows 保留名是盲区。
- 纯路径守卫必须排在 `statSync`/open **之前**(设备触碰前拦),且带平台门 + 显式 platform 形参(可在任何宿主全测)。
- 平台门是灵魂:POSIX 上 `con`/`nul` 是合法文件,误伤即回归。
