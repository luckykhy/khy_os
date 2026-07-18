<!-- 文档分类: MGMT-OTHER-004 | 阶段: 项目管理 | 原路径: (新建) -->
# 事后分析：Windows 上 `khy os build` 为何之前失败、现在成功 (2026-06-26)

> 关联：构建方案见 `docs/07_OPS_运维/[OPS-MAN-036] khyos跨平台构建-Windows支持方案.md`。
> 本文是该方案「原生 LLVM 后端」在**真实 Windows 用户机**上落地时,三轮构建失败 +
> 一轮运行失败的根因复盘。代码细节散在 `kernel/vendor/moonbit/runtime.c`、
> `kernel/Makefile`、`services/backend/src/cli/handlers/khyos.js`、
> `platform/packages/shared/src/runtime/khyos/`。

## 0. 一句话结论（先给非工程师）

之前不是「Windows 不支持」,而是**内核源码里几处「只在 Windows 编译器下才会走到」的代码分支,
在我们的 Linux 开发机 / CI 上从不触发,因此一路潜伏到真实 Windows 用户构建时才一层层暴露**。
每修好一层,就露出更深的下一层,共三轮才挖到真根因(目标文件格式)。第三轮一招治本后,
**真实 Windows 机器上 `pip install --upgrade khy-os && khy os build` 已端到端构建出可启动 ISO**
（0.1.135,已发布并经用户实机验证）。

构建通了之后,**运行**内核又遇到一个独立的小问题（`qemu-img not found`),这一轮也已修复
（代码就位,待维护者固定便携 QEMU 资产后随 0.1.136 发布）。

## 1. 必须先分清：两个完全不同的失败

| 阶段 | 命令 | 之前的报错 | 性质 |
| --- | --- | --- | --- |
| **构建期** | `khy os build` | 编译 / 链接内核时报错 | 内核工具链 × Windows 编译器的兼容问题（三轮） |
| **运行期** | 打开「KHY OS 内核终端」 | `qemu-img not found` | 运行内核所需 QEMU 未自动置备（一轮） |

二者根因不同、修复不同、发布版本不同,下面分开讲。

---

## 2. 构建期：三轮闭环（0.1.133 → 0.1.134 → 0.1.135）

### 2.0 背景：Windows 上 `khy os build` 走哪条路

自研内核是 **freestanding x86_64 ELF / multiboot 镜像**,本质需要 GNU/ELF 工具链。
`khy os build` 在 Windows 上的首选后端是「**原生 LLVM + Limine**」：clang / ld.lld / nasm /
Limine / xorriso 等按 sha256 钉死、按需下载到 `~/.khyos/cache/`，无需 WSL/Docker（见 OPS-MAN-036 §8）。
这条路**几乎全程成功**——问题都出在最后一两步,所以极具迷惑性。

> 关键认知：日志里同时出现的 WSL `make: not found` / Docker `registry-1.docker.io 连不上` /
> QEMU 未装,都是**兜底后端各因环境另外失败**,与真 bug 无关。原生 LLVM 才是首选路径,
> 修好它即通。排障时务必盯住原生路径的报错,别被兜底噪声带偏。

### 2.1 轮一（→ 0.1.133）：未守卫的 `#include <windows.h>`

**报错**
```
vendor/moonbit/runtime.c:298: fatal error: 'windows.h' file not found
make: *** [Makefile:116: build/moonbit_runtime.o] Error 1
```

**根因**：内核用 `-ffreestanding -nostdlib -nostdinc` 编（裸机,无系统头），
**根本不该 include 宿主 `windows.h`**。但 `runtime.c` 里 MoonBit 运行时的 host 栈回溯设施有一段：

```c
#ifdef _WIN32
#include <windows.h>      // + DbgHelp / CaptureStackBackTrace / SymInitialize
#endif
```

这段**没有**被本文件其它地方都在用的 `MOONBIT_NATIVE_NO_SYS_HEADER`（“无 libc / 无系统头”闸）守卫。

**为何只在 Windows 炸**：Linux 原生 gcc **从不定义** `_WIN32`，整段被预处理跳过,所以这个洞
在 Linux 上**永远不可见**。而 llvm-mingw 的 clang 是 Windows-targeting 工具链,**即便在编内核也定义
`_WIN32`** → 走进 windows.h 分支 → `-nostdinc` 下找不到 → fatal。

**修复**：两处加守卫——
```c
#if defined(_WIN32) && !defined(MOONBIT_NATIVE_NO_SYS_HEADER)
```
（`#ifdef _WIN32` 的 include 块 + `moonbit_panic` 内 `#ifdef _MSC_VER` 块）。
freestanding 下该 `#if` 为假,整块编译掉,与 Linux 行为一致。

### 2.2 轮二（→ 0.1.134）：同类第二处——控制台 UTF-8 设码块

0.1.133 发布后用户复跑,clang 编过更多文件,**又**在 `runtime.c` 后段炸。
原因：`moonbit_println` 里另有**一对仅 `#ifdef _WIN32`** 的 Win32 控制台设码块
（`GetConsoleOutputCP` / `SetConsoleOutputCP(CP_UTF8)`，皆 windows.h 符号）,
**同样裸露未守卫**。第一处修好后它才暴露出来。

**教训（写进了复盘）**：我先前「其余 `_WIN32` 分支应该都嵌在 NO_SYS_HEADER 内」的判断**是错的**。
正确做法不是凭「应该都守住了」断言,而是 **grep 全树 + 预处理实证逐块确认**。
最终全量复核确认整个 kernel 树只剩这几处需要守卫,其余裸 `_WIN32` 都已在 NO_SYS_HEADER 块内。

**修复**：两处同样改 `#if defined(_WIN32) && !defined(MOONBIT_NATIVE_NO_SYS_HEADER)`。

### 2.3 轮三（→ 0.1.135）：真·根因换层——COFF vs ELF 目标格式

windows.h 全部守住后,clang **编过了全部 `.c`**,却在**链接**阶段炸：
```
ld.lld: error: build/agentask.o: unknown file type   （所有 C object 同症）
```

**真根因不在源码,在目标文件格式**：
- llvm-mingw 的 clang **默认 Windows 目标** → 既产 **COFF/PE** object，又定义 `_WIN32`（这正是前两轮 windows.h 被触发的**同一总因**）。
- 但本内核是 **ELF**：`boot/*.asm` 用 `nasm -f elf64`，`linker.ld` 是 GNU/ELF 脚本。
- `ld.lld` 因此跑 ELF 模式：接受了 nasm 的 ELF object，却**拒绝** clang 产的 COFF C object → `unknown file type`。

**一招治本**：强制 clang 输出裸机 ELF —— `--target=x86_64-elf`：
1. object 变 ELF → 可被 `ld.lld -T linker.ld` 链接；
2. `_WIN32` **不再定义** → 前两轮的 windows.h / console 分支**自然编译掉**；
3. 使 Windows clang 构建与**已知良好的 Linux gcc 构建行为一致**——所以这条路比原来的
   “Windows-target clang” **更低风险**,而非更高。

**落地（三处,纯加法,作用域精确）**：
| 文件 | 改动 |
| --- | --- |
| `kernel/Makefile` | 新 `EXTRA_CFLAGS =`（空默认,命令行可覆盖）追加进 `CFLAGS`（自动流入 `MOONBIT_CFLAGS`） |
| `khyos.js` `_toolchainMakeVars` | `if (env.KHY_EXTRA_CFLAGS) vars.push('EXTRA_CFLAGS=' + …)` |
| `khyos.js` `_buildViaNativeToolchain` | **仅** native-llvm 的 childEnv 注入 `KHY_EXTRA_CFLAGS=--target=x86_64-elf` |

> 精确作用域很关键：`--target` **只**给 native-llvm clang。WSL / Docker / QEMU appliance / 强制 native-gcc
> 都用 `process.env`（无此键）→ 各自的 gcc 不受影响（gcc 不认 `--target=x86_64-elf`，若误传会 exit 1）。

### 2.4 为什么发布前能确信修对了（无 clang 的本机）

开发机没有 llvm-mingw clang,无法直接复跑 Windows 构建,所以用两手代理实证：
- `make --eval` 验证 `EXTRA_CFLAGS` 确实流进 `CFLAGS` / `MOONBIT_CFLAGS`；
- 本机 gcc + `MOONBIT_PREBUILT=1` 跑**完整全量内核构建** `make build/khy-os.bin` exit 0。
  这与 clang `--target=x86_64-elf` **同构**（同 ELF object / 同 `_WIN32` 未定义 / 同 freestanding，
  只差编译器二进制）：`ld -T linker.ld` 把**全部** object（含此前 Windows 首炸的 `agentask.o`）链成
  有效 `ELF 64-bit LSB executable x86-64`。

**✅ 真实 Windows 机端到端验证（0.1.135）**：用户日志实证
`clang.exe … --target=x86_64-elf … -c vendor/moonbit/runtime.c` →
`ld.lld.exe -T linker.ld -o build/khy-os.bin <全部 object>`（`unknown file type` 消失）→
xorriso 产 ISO → Limine 安装 → `✓ 内核 ISO 构建完成 khy-os-kernel.iso`。

| 版本 | 修了什么 | 结果 |
| --- | --- | --- |
| 0.1.133 | 轮一：第一处 windows.h 守卫 | 暴露轮二 |
| 0.1.134 | 轮二：console-CP 设码块守卫 | 暴露轮三 |
| **0.1.135** | 轮三：**COFF→ELF（`--target=x86_64-elf`）一招治本** | **构建通过（实机验证）** |

---

## 3. 运行期：`qemu-img not found`（待 0.1.136）

### 3.1 现象与根因

构建成功、ISO 已产后,打开「KHY OS 内核终端」遇：
```
[内核] qemu-img not found — install QEMU to create the KHY OS disk image
```
根因：**构建**工具链会按需 sha256 固定下载到 `~/.khyos/cache/`，但**运行**内核所需的 QEMU 不会——
仍要求用户手动装 QEMU 并加 PATH。体验不一致。

### 3.2 修复（纯加法 + fail-soft 降级）

| 改动 | 文件 | 作用 |
| --- | --- | --- |
| 去掉 qemu-img 依赖 | `khyos/diskImage.js` | KhyFS 盘是 `format=raw` 的定长全零文件,改用 Node `fs.ftruncateSync` 原生创建,**彻底移除 qemu-img**（用户所见错误从根上消失） |
| 运行路径自动置备 | `khyos/KhyOsRunner.js` | `start()` 顶部 `_ensureRuntimeQemu()`：显式覆盖 → PATH 探测 → 自动下载便携 QEMU（复用 `ensurePortableQemu`）→ 失败优雅降级到「装 QEMU」提示 |
| 进度呈现 | Web / TUI | 下载便携 QEMU 时显示「正在下载… N%」 |
| `doctor` 诚实反映 | `handlers/khyos.js` | 删 qemu-img 检查,改提示「首次运行自动下载」 |

设计与构建工具链一致：**首次运行内核时,若无 QEMU 则按 sha256 固定下载便携版**,从此运行也零手动装。

### 3.3 发布状态（诚实标注）

代码全部就位、测试齐全（19 例新测 + 105 例回归零回归）。但**便携 QEMU zip 资产需维护者在联网机上
构建/上传 + 固定 sha256 + 重建 wheel**（沙箱无网络,固定是必经的维护者一次性步骤）。
因此 **0.1.136 尚未发布**；在资产固定前,运行期**优雅降级**到「装 QEMU」提示
（已不再是误导性的 `qemu-img not found`）。

---

## 4. 通用教训

1. **「只在某平台/某编译器才走到」的条件编译是潜伏 bug 的温床**——CI 不覆盖那条分支就等于没测。
   `_WIN32` 这类宏在 Linux 上永远为假,洞可以潜伏很久。
2. **别凭「应该都对」断言,要 grep 全树 + 预处理/链接实证**（轮二就是吃了这个亏）。
3. **一层报错可能掩盖更深的真根因**——windows.h（编译）修完才看见 COFF/ELF（链接）。修到「行为与已知良好路径一致」才算到底。
4. **诚实区分首选路径与兜底噪声**：日志里一堆失败,只有原生路径那条才是真问题。
5. **构建通 ≠ 能用**：构建期与运行期是两套依赖,要分别置备。

---

## 5. 用户怎么验证

```powershell
pip install --upgrade khy-os
khy os build          # 应产出 khy-os-kernel.iso（0.1.135 已实机验证通过）
khy os doctor         # 体检：QEMU 缺失会给出真实的安装指引（见下方 2026-06-28 更新）
khy os                # 运行内核；无 QEMU 时给出装 QEMU+PATH / 设 KHY_QEMU 的真实步骤
```

> 内核源码改动经 `setup.py` 打包进 wheel 的 `bundled/` 副本,**用户须升级 wheel 重装才生效**。
> 临时绕过本地构建：设 `KHY_KERNEL_ISO=<现成iso>` 或 `KHY_KERNEL_ISO_URL` + `KHY_KERNEL_ISO_SHA256`。

---

## 6. 更新（2026-06-28）：便携 QEMU 仍未固定，提示绝不虚假承诺"自动下载"

本事后分析在 2026-06-26 记录了"首次运行自动下载便携 QEMU"的**设计意图**（见 §3.2 表格的"运行路径自动置备""doctor 诚实反映"两行，以及 §5 验证步骤）。§3.3 当时已诚实标注：
**便携 QEMU 资产需维护者在联网机上固定 sha256 + 重建 wheel，0.1.136 尚未发布。**

截至本次更新，**该便携 QEMU 资产至今仍未固定**——`khyos-manifest.json` 的 `qemu.win32-x64` pin 的 `url`/`sha256` 仍为空。
因此 `ensurePortableQemu()` 在 `!url || !sha256` 即返回 null，**永远不会真的下载**。

为避免"误导性承诺"（与本项目"出错原因必须具体真实"的红线冲突），运行期与 `khy os doctor` 的缺-QEMU 提示已改为**诚实门控**：

- 仅当便携 QEMU **真被固定**（`isPortableQemuPinned()` 为真）时，才会出现"首次运行自动下载"措辞；
- 否则给出**真实可执行的下一步**：装 `qemu-system-x86_64` 并加入 PATH（Windows 可用 https://qemu.weilnetz.de/w64/），或设 `KHY_QEMU` 指向已装的可执行文件。

维护者一旦真正固定便携 QEMU 资产，上述措辞会**自动变诚实**（机制已就绪，无需再改代码）。
详见红线：`.ai/GUARDS.md`「缺 QEMU 的指引绝不承诺会自动下载，除非便携 QEMU 真被 pin」。

> 一句话：§3.2/§5 里"自动下载"是当时的**目标**而非**已发生的事实**；在资产固定前，请以本节为准——**提示只给真实安装步骤，不承诺下载**。
