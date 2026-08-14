# [OPS-MAN-036] khyos 跨平台构建（Windows 支持）方案

> 状态：已实现并接入。配套改动：
> `kernel/Makefile`（工具链可移植化）、`kernel/Dockerfile.kernel-build`（Docker 后端镜像）、
> `services/backend/src/cli/handlers/khyos.js`（`khy os build` Windows 委派层）、
> `setup.py`（修复内核打包丢失 `grub.cfg`）、
> 测试 `services/backend/tests/khyosBuild.test.js`（node:test）。
>
> **v2 更新（2026-06-24，提交 `a189e81`/`8c823a4`/`e1955d6`）：新增「原生 LLVM + Limine」后端，
> 在裸 Windows 上 `pip install` 后即可构建内核 ISO——无需 WSL、无需 Docker、无需 QEMU 构建器
> 虚拟机。所需工具链（clang/ld.lld/nasm/Limine/xorriso/BusyBox）按 sha256 钉死按需下载到本地
> 缓存。详见 §8；该后端在 auto 级联中位于「预构 ISO」之后、WSL 之前。这把本文档原先标注为
> 「无原生 Windows 等价物（核心阻塞点）」的 `grub-mkrescue` 阻塞正式解除（Limine 取而代之）。**

## 0. 目标与一句话结论

让 **Windows 用户 `pip install` 后用一条命令 `khy os build` 即可完整构建自研内核 ISO**，
无需手动切换到 Linux。

一句话结论（必须先讲清的工程事实）：**自研内核是 freestanding x86_64 ELF /
multiboot2 / GRUB 镜像，本质上需要 GNU/ELF 工具链 + `grub-mkrescue`，而 MSVC 体系
（`cl.exe` / link.exe，仅产 PE/COFF）在架构上无法生成此类内核。** 因此「跨平台兼容」
的正确落地不是「让 MSVC 编 ELF 内核」（那会要求重写 `boot/*.asm` 的 NASM ELF64、
`linker.ld` 的 GNU ld 脚本与 multiboot2 引导路径，等于换内核），而是
**让 `khy os build` 在 Windows 上自动委派到一个能工作的 Linux 工具链后端（WSL2 / Docker），
对用户呈现为「在 Windows 上一条命令就构建出 ISO」**。这是产品层面的真·跨平台，且诚实地
尊重了内核工具链的技术现实——不伪造、不破坏现有内核代码。

## 1. 自调查：当前构建链路与依赖

### 1.1 两个「ISO」必须区分（避免张冠李戴）

| 名称 | 产物 | 构建方式 | 本方案对象 |
| --- | --- | --- | --- |
| **自研内核 ISO** `khy-os-kernel.iso` | C+NASM+MoonBit freestanding 内核 | `make -C kernel iso` → `khy os build` | ✅ 是 |
| Alpine 发行版 ISO | Linux 发行镜像 | `scripts/alpine/*`（Docker/PowerShell） | ❌ 否（独立组件） |

内核源码里的 `pe.c` / `wincompat.c` 是**运行时**在内核内加载 Windows PE 可执行体的功能，
与「在 Windows 上构建」无关。

### 1.2 内核构建工具链（`kernel/Makefile`）

| 工具 | 用途 | Windows 原生可得性 |
| --- | --- | --- |
| `nasm -f elf64` | 汇编 `boot/*.asm` | 有原生 Windows 版（产 ELF64 可行） |
| `gcc`（freestanding） | 编译 `src/*.c`（`-mcmodel=kernel -mno-red-zone -fno-pic` + ELF 输出） | MSVC 不行；MSYS2/MinGW gcc 或 LLVM clang `--target=x86_64-elf` 可行 |
| `ld -T linker.ld` | 链接 GNU ld 脚本 | MSVC link 不行；GNU ld / `ld.lld` 可行 |
| `grub-mkrescue`(+`xorriso`) | 打 multiboot2 GRUB 启动 ISO | 无原生 Windows 版——~~核心阻塞点~~ **已由 Limine + xorriso 取代**（§8，二者均有原生 Windows 二进制） |
| `moon`（MoonBit） | 生成并编译一个内核对象 | 跨平台，但默认 `make iso` 依赖它；`MOONBIT_PREBUILT=1` 改用 vendored 产物，`moon` 永不 spawn（§8） |

构建产物落点（**契约，必须保持**）：`kernel/build/khy-os-kernel.iso`，由
`isoProvisioner.ensureKhyosIso()` 自动发现（优先级 2）。

### 1.3 pip 分发现状

- wheel 携带**内核源码**（`Makefile`/`linker.ld`/`src`/`boot`/`moonbit`/`userland`），
  按设计**不带 ISO**（`setup.py` 排除 `*.iso`），安装后用 `khy os build` 就地重建。
- `khy os build` 不被 Python 层拦截，直落 Node CLI → `khyos.js kernelBuild`。

## 2. Windows 构建障碍分析

| # | 障碍 | 性质 | 处理 |
| --- | --- | --- | --- |
| B1 | MSVC 无法产 freestanding ELF64 内核 | **架构性**，不可调和 | 不走 MSVC；委派 Linux 工具链后端 |
| B2 | `grub-mkrescue` 无原生 Windows 版 | ~~核心阻塞~~ **已解除** | **原生路径（§8）：Limine + xorriso 替代 grub-mkrescue**（均有原生 Windows 二进制）；或 WSL2 / Docker 内执行；或 MSYS2 装 grub |
| B2′ | `moon`（MoonBit）默认强制，裸 Windows 难装 | 次阻塞 | Makefile 新 `MOONBIT_PREBUILT=1` 开关改用 `kernel/vendor/moonbit/` 内 vendored 产物，`moon` 永不 spawn（§8） |
| B3 | Makefile 硬编码 Debian GCC include 路径 `/usr/lib/gcc/x86_64-linux-gnu/$(GCC_VER)/include` | 可移植性缺陷（也影响 Arch/Fedora/macOS/MSYS2） | 改 `gcc -print-file-name=include` 自解析 |
| B4 | 工具链二进制名硬编码（`gcc`/`ld`/`grub-mkrescue`） | 跨发行版/MSYS2 命名差异 | 改为可经命令行/`KHY_*` 覆盖的 make 变量 |
| B5 | **wheel 丢失 `kernel/iso/boot/grub/grub.cfg`** | 打包 bug（`setup.py` 把 `iso/` 整目录排除，连构建输入一起删） | 移除该目录排除，仅排除产物 `*.iso/*.img` |

B5 是隐性致命点：即便工具链齐全，pip 安装后 `make iso` 也会在
`cp iso/boot/grub/grub.cfg …` 处失败——**所有平台**都受影响，是 Windows 目标成立的前提。

## 3. 跨平台构建方案设计

### 3.1 三层后端（`khy os build` 自动选择）

后端经 `KHY_KERNEL_BUILD_BACKEND ∈ {auto(默认), native-llvm, wsl, docker, qemu, native}` 选择
（auto 级联完整顺序见下；`native-llvm` 是 §8 新增的「无 WSL/Docker/VM」原生后端）：

```
              ┌─ Linux / macOS ──────────────▶ 直接用宿主工具链 make iso（行为不变）
 khy os build │
              └─ Windows(win32) ─ auto ─┬─ 预构 ISO 已在缓存 ─▶ 直接复用，免构建
                                        ├─ ⓪ 原生 LLVM+Limine ▶ §8：按需下载钉死工具链，
                                        │     可用(provisioner≠null)   就地 make iso-limine（无 WSL/Docker/VM）
                                        ├─ ① WSL2 可用 ───────▶ WSL2 委派（跑未改动的 Makefile）
                                        ├─ ② 否，Docker 可用 ─▶ Docker 委派（容器内 Linux 工具链）
                                        ├─ ③ 否，QEMU+appliance ▶ §7：QEMU 构建器虚拟机
                                        └─ 都不可用 ──────────▶ 打印清晰安装指南，返回 false
                 (KHY_FORCE_KERNEL_BUILD=1 或 backend=native) ▶ MSYS2/LLVM 宿主原生 make iso（自带工具链）
```

> ⓪ 与「native」的区别：`native-llvm`（§8）**自带工具链**——按 sha256 钉死从公开上游按需下载
> clang/ld.lld/nasm/Limine/xorriso/BusyBox 到缓存，零手动安装；`native`（`KHY_FORCE_KERNEL_BUILD=1`）
> 则要求**宿主已装好** MSYS2/LLVM 工具链。auto 级联里 provisioner 返回 `null`（离线/未钉/校验失败）
> 时静默跳过 ⓪，继续往下探 WSL/Docker/QEMU，绝不中断。

| 层 | 机制 | 依赖适配 | 工具链适配 |
| --- | --- | --- | --- |
| **① WSL2（推荐）** | `wslpath -u` 转译内核路径 → `wsl make -C <unix路径> iso` | `sudo apt install build-essential nasm grub-pc-bin grub-common xorriso` + MoonBit 安装脚本 | **Makefile 零改动**直接复用，最贴合「保留原逻辑」 |
| **② Docker** | 从 `kernel/Dockerfile.kernel-build` 构镜像（幂等缓存）→ `docker run -v <kernel>:/kernel make -C /kernel iso` | 镜像内 `apt` 预装全工具链 + MoonBit | 容器内 Linux 工具链，宿主零依赖 |
| **③ MSYS2/LLVM（进阶）** | 宿主直接探测工具链 + `make iso` | MSYS2 `pacman -S nasm gcc binutils`，grub 经 MSYS2 或 LLVM | Makefile 的 `gcc -print-file-name=include` 使 MSYS2 gcc 自适配 |

ISO 始终落在 `kernel/build/khy-os-kernel.iso`（与 isoProvisioner 契约一致）：WSL2/Docker
均通过把内核目录映射到同一磁盘/挂载点，写回 Windows 侧可见的同一 `build/`。

### 3.2 构建脚本改动（保留原逻辑，仅加 Windows 兼容）

#### (a) `kernel/Makefile` — 工具链可移植化（additive）

```makefile
# 默认仍强制已知良好的 GNU/Linux 工具链（不可用 ?=：make 内建 CC=cc 会让 ?= 失效
# 并在 macOS/BSD 误用 clang）。覆盖统一走命令行 make VAR=val（优先级最高）。
ASM           = nasm
CC            = gcc
LD            = ld
GRUB_MKRESCUE = grub-mkrescue

# 用编译器自身解析其 freestanding include 目录，替代硬编码 Debian 路径。
# Debian/Ubuntu 上解析到同一 /usr/lib/gcc/x86_64-linux-gnu/<ver>/include（行为等价），
# 其它发行版/MSYS2/交叉工具链各自正确。
GCC_INCLUDE ?= $(shell $(CC) -print-file-name=include)
CFLAGS = ... -isystem $(GCC_INCLUDE)
...
$(ISO): $(KERNEL)
	...
	$(GRUB_MKRESCUE) -o $(ISO) $(BUILD)/isofiles 2>/dev/null
```

> 实测：本机 `gcc -print-file-name=include` == 原硬编码路径；改后 `make iso` 产物
> 字节数不变（零回归）。命令行 `make CC=… GCC_INCLUDE=… GRUB_MKRESCUE=…` 覆盖均生效。

#### (b) `khyos.js kernelBuild` — Windows 委派层（替换硬拒绝）

原逻辑（Linux 探测 + `make iso`）抽取为 `_unixToolchainBuild`，Linux/macOS 与
「Windows 强制原生」共用，**行为不变**。新增 `_windowsKernelBuild` 分发 +
`_buildViaWsl` / `_buildViaDocker`。`KHY_*` 工具链覆盖经 `_toolchainMakeVars()`
转发为 `make VAR=val`（无覆盖时参数与原来完全一致）：

```js
function _toolchainMakeVars() {
  const vars = [];
  if (process.env.KHY_CC) vars.push(`CC=${process.env.KHY_CC}`);
  if (process.env.KHY_NASM) vars.push(`ASM=${process.env.KHY_NASM}`);
  if (process.env.KHY_LD) vars.push(`LD=${process.env.KHY_LD}`);
  if (process.env.KHY_GRUB_MKRESCUE) vars.push(`GRUB_MKRESCUE=${process.env.KHY_GRUB_MKRESCUE}`);
  if (process.env.KHY_GCC_INCLUDE) vars.push(`GCC_INCLUDE=${process.env.KHY_GCC_INCLUDE}`);
  return vars;
}

// WSL2：转译路径后跑未改动的 Makefile
function _buildViaWsl(ctx) {
  const wp = spawnSync('wsl', ['wslpath', '-u', kernelDir], { encoding: 'utf-8', env: childEnv });
  const unixDir = String(wp.stdout).trim();
  const r = spawnSync('wsl', ['make', '-C', unixDir, ..._toolchainMakeVars(), 'iso'],
                      { stdio: 'inherit', env: childEnv });
  return _verifyIso(ctx); // 检查 kernel/build/khy-os-kernel.iso
}
```

#### (c) `setup.py` — 修复 `grub.cfg` 打包缺口

```python
# 不再排除 "iso" 目录：kernel/iso/boot/grub/grub.cfg 是构建输入；构建产物仍由
# *.iso/*.img 排除，且只会出现在 kernel/build/（已排除），不会落到 kernel/iso/。
ignore=shutil.ignore_patterns(
    *EXCLUDE_PATTERNS, "build", "_build", "target",
    "*.o", "*.bin", "*.elf", "*.efi", "*.iso", "*.img", "*.lock",
)
```

#### (d) `kernel/Dockerfile.kernel-build` — Docker 后端镜像

`debian:bookworm-slim` + `build-essential nasm binutils grub-pc-bin grub-common
xorriso mtools` + MoonBit；内核源码运行时 bind-mount 到 `/kernel`，镜像 source-agnostic
利于缓存。不装 QEMU（运行是宿主的事）。

## 4. 依赖安装指南（Windows 用户）

`khy os build` 在无可用后端时会打印以下指南；三条路径任选其一，均可全自动：

### 4.1 路线 A：WSL2（推荐）

```powershell
wsl --install -d Ubuntu          # 安装 WSL2 + Ubuntu（首次需重启）
# 在 Ubuntu 内一次性装内核工具链：
wsl sudo apt update
wsl sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso
wsl bash -c "curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash"
# 回到 Windows，直接：
khy os build                     # 自动检测 WSL2 并经其构建，ISO 落在 kernel\build\
```

### 4.2 路线 B：Docker Desktop

```powershell
# 安装并启动 Docker Desktop（对内核源码所在盘启用文件共享）
set KHY_KERNEL_BUILD_BACKEND=docker
khy os build                     # 首次构镜像较慢，之后走缓存
# 可选：用预构镜像跳过本地构镜像
set KHY_KERNEL_BUILD_IMAGE=<your-registry>/khyos-kernel-build:latest
```

### 4.3 路线 C：MSYS2 / LLVM 原生（进阶）

```bash
# MSYS2 UCRT64 shell：
pacman -S --needed mingw-w64-ucrt-x86_64-gcc nasm make binutils
# 安装 grub + xorriso（或用 LLVM clang --target=x86_64-elf + ld.lld）
# 然后在 Windows：
set KHY_FORCE_KERNEL_BUILD=1
khy os build
```

### 4.4 环境开关一览

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_KERNEL_BUILD_BACKEND` | `auto` | `native-llvm`/`wsl`/`docker`/`qemu`/`native` 强制后端 |
| `KHY_FORCE_KERNEL_BUILD` | 未设 | `=1` 在 Windows 走宿主原生（等价 `backend=native`，要求宿主已装工具链） |
| `KHY_KERNEL_BUILD_IMAGE` | 未设 | Docker 预构镜像名，跳过本地构镜像 |
| `KHY_CC`/`KHY_NASM`/`KHY_LD`/`KHY_GRUB_MKRESCUE`/`KHY_GCC_INCLUDE` | 未设 | 转发为 `make VAR=val` 覆盖工具链 |
| `KHY_XORRISO`/`KHY_LIMINE`/`KHY_LIMINE_DIR`/`KHY_MAKE`/`KHY_MAKE_SHELL` | 未设 | 原生 Limine 路径工具链覆盖（§8）；转发为 `make VAR=val` |
| `KHY_KHYOS_CACHE_DIR` | `~/.khyos/cache` | 缓存根（ISO/builder/qemu/toolchain 共用）；旧 `~/.khyquant/khyos` 非空则续用（§8.5） |
| `KHY_KERNEL_SRC_DIR` | bundle/repo | 覆盖内核源码目录 |

## 5. 验证与测试

### 5.1 单元/编排测试（已落地，平台无关）

`services/backend/tests/khyosBuild.test.js`（node:test，**13/13 绿**）经注入 `spawnSync`
测试缝在 Linux 上即可确定性验证 Windows 委派编排：

- Linux 路径 5 例（缺 Makefile / 缺工具链 / 正常构建 / make 成功无 ISO / make 非零）——**零回归**；
- Windows 委派 8 例：auto 无后端→指南、auto 优先 WSL、`backend=wsl` 成功/失败、
  `backend=docker` 构镜像+容器内 make、预构镜像跳过构镜像、`KHY_FORCE=1` 原生探测、
  `backend=native` 缺工具链 fail-soft。

### 5.2 Windows 真机/CI 验证流程

GitHub Actions Windows runner（自带 WSL2）跑端到端内核构建——见
`.github/workflows/kernel-build-windows.yml`（本方案新增）：

1. `windows-latest` runner；
2. 启用 WSL2 + 安装 Ubuntu 与内核工具链（apt + MoonBit）；
3. `khy os build`（或直接 `wsl make -C <path> iso`）；
4. 断言 `kernel/build/khy-os-kernel.iso` 存在且非空。

本地 Windows 自测清单：

```powershell
khy os doctor          # 体检 QEMU/ISO（Windows QEMU: https://qemu.weilnetz.de/w64/）
khy os build           # 构建（自动选后端）
dir kernel\build\khy-os-kernel.iso   # 确认产物
khy os                 # 启动内核终端（需 QEMU）
```

## 6. 防呆规则落地对照

| 防呆要求 | 落地 |
| --- | --- |
| **构建脚本修改需保留原逻辑，仅添加 Windows 兼容配置** | Makefile 默认工具链与产物字节不变（实测）；Linux/macOS 构建路径抽取后行为不变；Windows 由「硬拒绝」改为「委派」纯属新增分支；`_toolchainMakeVars()` 无覆盖时 make 参数与原来完全一致。 |
| **依赖处理需提供清晰的安装指南（vcpkg 集成或预编译库下载）** | §4 给出 WSL2 / Docker / MSYS2 三条可复制指南；`khy os build` 无后端时**运行时**打印同款指南；Docker 路径用自带 `Dockerfile.kernel-build` 预装全部依赖（等价「预编译环境」）。 |
| **只修改构建相关文件，不破坏现有内核代码或业务逻辑** | 改动仅限：`kernel/Makefile`、`kernel/Dockerfile.kernel-build`（新增）、`khyos.js kernelBuild`（构建编排）、`setup.py`（打包）、`khyosBuild.test.js`（测试）、CI 工作流。**未触碰任何内核 `.c/.asm/.ld` 源码与业务逻辑**。 |

> 说明：本方案诚实地不承诺「MSVC 原生编译 ELF 内核」——那需要重写引导/链接/启动路径，
> 等于更换内核，违反「不破坏现有内核代码」。「Windows 一条命令构建」由透明委派达成，
> 这是尊重技术现实的真·跨平台。

## 7. QEMU builder-VM 后端（无 WSL、无 Docker 也能构建）

### 7.1 动机

需求：**Windows 上没有 WSL 时，只要本机有 khy-os（即已装 QEMU），就应能构建出
Linux 上才能产出的内核 ISO**——「虽然没构建（appliance）时这能力不存在」。

khy-os 运行内核本就**强制依赖 QEMU**（`khy os doctor` 体检的就是它）。既然 QEMU 在场，
就用它启动一台极小的 Linux「构建器虚拟机」（builder appliance），把宿主的内核源码目录
经 **virtio-9p** 共享进去，在 VM 内跑**原封不动**的 `make iso`，产物因共享目录即宿主目录而
**直接落到宿主** `kernel/build/`，无需拷回。这样 WSL2、Docker 都不可用时仍有第三条路。

### 7.2 自动级联顺序

`backend=auto`（默认）在 Windows 上的探测顺序：

1. **WSL2**（最快、最原生）；
2. **Docker**（`Dockerfile.kernel-build` 工具链镜像）；
3. **QEMU builder-VM**（本节）——当且仅当 `qemu-system-x86_64` 在 PATH **且** appliance 镜像存在；
4. 都不可用→打印三条路线指南（含本节）。

亦可 `set KHY_KERNEL_BUILD_BACKEND=qemu` 强制本后端。

### 7.3 Appliance 契约（khyos.js `_buildViaQemu` 与之约定）

appliance 是一台**可启动的** qcow2 Linux 镜像，**不随 pip/npm 发包**（保持包体小，亦符合
「没构建时没有」）。其与宿主的契约：

| 约定 | 值 |
| --- | --- |
| 9p 共享 tag | `khykernel`（宿主侧 `-device virtio-9p-pci,...,mount_tag=khykernel`） |
| VM 内挂载点 | `/kernel` |
| 启动方式 | `-drive file=<img>,format=qcow2,if=virtio -nographic -no-reboot` |
| 内核 cmdline | `-append console=ttyS0 [KHY_MAKE_VARS="..."]` |
| **每次开机**行为 | 挂 9p→`make -C /kernel $KHY_MAKE_VARS iso`→`poweroff`（故须 systemd 服务每启动跑，非 firstboot 一次性） |
| 产物落点 | 宿主内核目录的 `build/`（因 `/kernel` 即宿主目录） |

镜像解析路径（`_qemuBuilderImage`）：
1. 环境变量 `KHY_KERNEL_BUILD_VM=<qcow2 路径>`（优先）；
2. `<khyosCacheDir>/builder/khyos-builder.qcow2`（默认，如 `~/.khyquant/khyos/builder/`）；
3. 都没有→**该能力不存在**，打印 provision 指引（符合需求语义）。

### 7.4 制作 appliance（一次性，在有 libguestfs 的 Linux 机器上）

`kernel/tools/provision-builder-vm.sh` 用 `virt-builder` 产出**真·可启动**镜像（自带内核+引导，
区别于裸 rootfs tar——后者无法 `-drive` 启动），内含与 `Dockerfile.kernel-build` 等同的工具链
（build-essential/nasm/binutils/grub-pc-bin/xorriso/mtools + MoonBit），并装入每启动运行的
`khy-builder.service`：

```bash
# 在 Linux 机器（需 libguestfs-tools）：
kernel/tools/provision-builder-vm.sh                      # 输出到默认 builder/ 路径
kernel/tools/provision-builder-vm.sh /path/out.qcow2 debian-12

# 把产物拷到目标 Windows 机器：
#   <khyosCacheDir>\builder\khyos-builder.qcow2
# 或在目标机：set KHY_KERNEL_BUILD_VM=D:\path\khyos-builder.qcow2
# 然后：
khy os build                                              # 自动走 QEMU 后端
```

### 7.5 环境开关（补充 §4.4）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_KERNEL_BUILD_VM` | 未设 | appliance qcow2 路径（覆盖默认缓存路径） |
| `KHY_QEMU` | `qemu-system-x86_64` | QEMU 可执行名 |
| `KHY_KERNEL_BUILD_VM_CPUS` | `2` | VM `-smp` |
| `KHY_KERNEL_BUILD_VM_MEM` | `2048` | VM `-m`（MB） |
| `KHY_KERNEL_BUILD_VM_TIMEOUT_MS` | `600000` | 构建超时（兜底，VM 卡死不挂死宿主） |

### 7.6 防呆与诚实边界

- **appliance 缺失不报错崩溃**，而是 fail-soft 打印 provision 指引——符合「没构建时没有」。
- **不静默拷贝产物**：靠 9p 共享让 `/kernel` 物理等于宿主目录，`make iso` 自然落地宿主。
- **超时兜底**：VM 异常不会无限阻塞宿主 `khy os build`。
- **不改任何内核源码/Makefile 默认行为**：VM 内跑的是原封不动的 `make iso`；`KHY_MAKE_VARS`
  仅在用户显式覆盖工具链时经 cmdline 透传，无覆盖时参数与原构建完全一致。
- 测试：`khyosBuild.test.js` 经注入 `spawnSync` 缝新增 8 例覆盖本后端
  （`backend=qemu` 成功/缺 appliance/缺 QEMU/无 ISO、auto 级联命中 QEMU、auto 级联无 appliance 落指南、
  `_qemuBuilderImage` env 覆盖 + 缓存回退），**32/32 绿**，Linux 上即可确定性验证。

## 8. 原生 LLVM + Limine 后端（无 WSL / Docker / VM）

> 提交 `a189e81`（构建链）/ `8c823a4`（manifest 全量 pin）/ `e1955d6`（缓存根迁移）。
> 这是「在裸 Windows 上 `pip install` 后即可构建内核 ISO」最直接的一条路——**不依赖 WSL、
> Docker、QEMU 构建器虚拟机**，只靠按需下载的钉死工具链。

### 8.1 动机与前提解除

需求：**Windows 上不装 WSL、不装 Docker，也要能 `khy os build` 出内核 ISO。** 原先两大阻塞：

1. **`grub-mkrescue` 无原生 Windows 版**——用 **Limine** 引导器取代：Limine 有原生 Windows
   二进制，配合同样原生的 **xorriso** 制 ISO，引导同一份**未改动**的 Multiboot2 内核
   `/boot/khy-os.bin`（见 `kernel/iso/boot/limine/limine.conf`，语法锁 Limine v8/v9）。
2. **`moon`（MoonBit）默认强制**——Makefile 新增 `MOONBIT_PREBUILT=1` 开关：改用
   `kernel/vendor/moonbit/`（`moonbit_gen.c` + `runtime.c` + `include/`，ABI 版本在
   `PROVENANCE.md` 钉死）内的 vendored 产物，`moon` **永不 spawn**。默认空开关 = 原路径逐字节不变。

### 8.2 工具链按需置备（`toolchainProvisioner.js`）

`platform/packages/shared/src/runtime/khyos/toolchainProvisioner.js` 导出
`ensureWindowsBuildToolchain(opts)`，返回 `{ cc, ld, asm, xorriso, limineDir, limineBin, make, shell } | null`。
它按 sha256 钉死从公开上游**按需下载** 6 个工具到 `<缓存根>/toolchain/<tool>/<sha12>`：

| key | 上游 | 取出物 |
| --- | --- | --- |
| `llvm` | llvm-mingw（mstorsjo） | `clang.exe`（`--target=x86_64-elf`）+ `ld.lld.exe` |
| `nasm` | nasm.us 官方 | `nasm.exe`（`-f elf64`） |
| `limine` | limine-bootloader binary-release | `limine.exe` + `limine-bios.sys`/`limine-bios-cd.bin`/`limine-uefi-cd.bin` |
| `xorriso` | PeyTy/xorriso-exe-for-windows | `xorriso.exe`（+随包 cygwin DLL） |
| `make` | ezwinports | `make.exe`（独立无 DLL） |
| `busybox` | busybox-w64-FRP | 复制成 `sh.exe` 喂 make 的 POSIX recipe |

**防呆（all-or-nothing）**：离线 / manifest 缺失 / 任一工具 url|sha256 为空 / 校验失败 / 解出的
二进制不存在 → 返回 `null`，**绝不半置备、绝不 throw**。auto 级联拿到 `null` 即在探 PATH 前
跳过本后端，继续往下（保住空 manifest 下的级联测试与离线行为）。

### 8.3 Makefile 新目标 `iso-limine`

```makefile
LIMINE_DIR ?= vendor/limine     # 置备出的 Limine 引导块所在目录
LIMINE     ?= limine            # limine 宿主工具
XORRISO    ?= xorriso           # ISO 制作器
iso-limine: $(KERNEL)
	# 拷内核 + limine.conf + 三个引导块到 isofiles/，xorriso 制 ISO，最后 limine bios-install
```

`khy os build` 把置备出的路径经 `make VAR=val` 转发：`CC`/`LD`/`ASM`/`XORRISO`/`LIMINE`/
`LIMINE_DIR`/`SHELL`(=BusyBox `sh.exe`)/`MOONBIT_PREBUILT=1`。无覆盖时与原构建参数完全一致。

### 8.4 manifest 已全量 pin（`khyos-manifest.json` → `toolchain.win32-x64`）

6 个工具的 `url` + `sha256` + 归档内 `binRelPath`/`dirRelPath` 均已填入并端到端验证下载-解包-定位
全链路（`limine` 取 **binary-release** 资产，非源码 tar）。升级上游版本时**只改 manifest**，
不改代码。

### 8.5 缓存根：`~/.khyos/cache`（底座家，含 legacy 回退）

内核与其构建工具链属 khyos **底座层**产物，缓存归 `~/.khyos/cache`（经 `khyosCacheDir()` 单源解析）：

1. `KHY_KHYOS_CACHE_DIR` 显式覆盖（最高优先）；
2. canonical `~/.khyos/cache` 不存在、但遗留 `~/.khyquant/khyos` 非空 → established-wins 续用
   （零重下载，平滑迁移）；
3. 默认 canonical `~/.khyos/cache`。

工具链落 `<缓存根>/toolchain/`，ISO/builder/qemu 缓存同根。

### 8.6 使用（Windows 用户）

```powershell
pip install khy-os
khy os build          # auto 级联：缓存无 ISO → 走原生 LLVM+Limine 后端，
                      #   首次自动下载钉死工具链到 %USERPROFILE%\.khyos\cache\toolchain\，
                      #   就地 make iso-limine，产物落 kernel\build\khy-os-kernel.iso
khy os doctor         # 体检 QEMU（运行内核仍需 QEMU）
khy os                # 启动内核终端
# 强制本后端：set KHY_KERNEL_BUILD_BACKEND=native-llvm
```

### 8.7 防呆与诚实边界

- **provisioner 返 `null` 不崩**：离线/未钉/校验失败 → 跳过本后端，级联继续探 WSL/Docker/QEMU。
- **默认路径零回归**：`MOONBIT_PREBUILT` 空 = Makefile 逐字节不变；Linux/grub 路径完全不受影响。
- **不改任何内核源码**：仅靠既有 `CC`/`LD`/`ASM` make 变量覆盖 + 新 `iso-limine` 目标；
  Limine 引导的是同一份未改动的 Multiboot2 内核。
- **沙箱钉死**：6 个上游全部 sha256 钉死，下载内容不匹配即判失败，不接受漂移的二进制。
- 测试：`toolchainProvisioner.test.js`（离线/空 manifest/sha 不匹配→`null`；注入 downloader+
  spawnSync 的 happy-path 返回 `<缓存根>/toolchain/` 下绝对路径）+ `khyosBuild.test.js` 原生档新例
  （manifest 充实时级联选中本后端、make 参数携 `MOONBIT_PREBUILT=1` + 目标 `iso-limine`），Linux 上确定性验证。

> 遗留：本机首次置备需联网下载约数十 MB 工具链；之后命中缓存离线可复用。Windows 真机端到端
> QEMU 引导冒烟仍建议在 Windows runner 上补一道（Limine→Multiboot2 交接）。
