# KHY OS Kernel

> 一个从零实现的裸机 x86_64 混合内核 · **v0.1.0 "Genesis"**

KHY OS 是一个自包含、可独立引导的操作系统内核：从 GRUB 引导、进入 64 位长模式、
建立分页与中断，运行 Ring 3 用户态程序，提供持久化文件系统与一个交互式 shell。
**它不依赖任何上层平台即可启动运行**——`khy os`（TUI / 网页 / pip）只是通过串口
连接到它的几个「控制面」，内核本身在任意 x86_64 环境下都能独立跑。

构建产物是一张可引导 ISO：`build/khy-os-kernel.iso`（约 12 MB）。

---

## 能力一览

| 子系统 | 实现 | 源文件 |
|--------|------|--------|
| 引导 | Multiboot2 → 长模式切换 | `boot/boot.asm`, `boot/long_mode.asm` |
| 内存 | 物理页分配器 / 虚拟内存分页 / 内核堆 | `pmm.c`, `vmm.c`, `kheap.c` |
| 中断 | GDT / IDT / PIC / ISR / 定时器 / 键盘 | `gdt.c`, `idt.c`, `pic.c`, `timer.c`, `keyboard.c` |
| 进程 | fork / exec / wait、抢占式调度、Ring 3 用户态 | `process.c`, `sched.c`, `boot/usermode.asm` |
| 可执行格式 | ELF64 加载器 · **PE32+/PE64 加载器 + Windows API 兼容层** | `elf.c`, `pe.c`, `wincompat.c` |
| 文件系统 | VFS 抽象 · KhyFS 持久化（基于 ATA）· ramfs | `vfs.c`, `diskfs.c`, `ramfs.c`, `ata.c` |
| 图形 / 终端 | VGA 文本 · framebuffer · 窗口管理器 | `vga.c`, `framebuffer.c`, `wm.c` |
| 通信 | 串口（16550 UART）· 网络栈雏形 · IPC / 端口 | `serial.c`, `net.c`, `ipc.c` |
| 安全 | 基于能力（capability）的访问控制 | `capability.c` |
| 扩展 | MoonBit 语言桥接（内核内运行 MoonBit 代码） | `moonbit_bridge.c`, `moonbit_os_api.c` |

> **亮点**：`pe.c` 能把 Windows PE 可执行文件加载进用户地址空间，`wincompat.c`
> 在 PE 导入 `kernel32.dll` 函数时，将其重定向到内核服务并修补 IAT——即一个
> 「内核级的迷你兼容层」。注意它只覆盖 kernel32 的极小子集，属研究/实验性质。

---

## 独立启动（无需 khy-os）

### 方式一：QEMU（最快）

```bash
make run          # 串口输出到当前终端，无图形窗口（推荐，直接看 shell）
make run-vga      # 同时打开 VGA 图形窗口
make run-disk     # 挂载一块持久化的 16MB ATA 磁盘（首次自动创建 build/khy-disk.img）
```

启动后会看到横幅与提示符 `khy> `。

### 方式二：任意虚拟机（VirtualBox / VMware）

把 `build/khy-os-kernel.iso` 作为光驱挂载，CPU 选 x86_64 即可引导。

### 方式三：真机（U 盘）

```bash
# ⚠️ 会清空目标设备，请务必确认 /dev/sdX 是你的 U 盘
sudo dd if=build/khy-os-kernel.iso of=/dev/sdX bs=4M status=progress && sync
```

从该 U 盘引导（BIOS/Legacy 模式）。串口控制台可用 `-serial` 对应的物理串口或
USB-TTL 转接线观察。

---

## 从源码构建

### 工具链

| 工具 | 用途 |
|------|------|
| `nasm` | 汇编引导/中断代码 |
| `gcc` + `ld` | 编译/链接 freestanding 内核 |
| `grub-mkrescue` | 生成可引导 ISO |
| `qemu-system-x86_64` / `qemu-img` | 运行与磁盘镜像 |
| `moon`（MoonBit） | **默认构建需要**：生成并编译 MoonBit 模块 |
| `xxd` | 仅在 `make userland` 重新生成用户态程序时需要 |

### 构建

```bash
make            # 完整构建 → build/khy-os-kernel.iso（含 MoonBit 步骤）
make iso        # 同上，只产出 ISO
make clean      # 清理 build/ 与 MoonBit 产物
```

> 默认 `make` 会先跑 MoonBit（`moon build --target native`）。若你的环境没有
> MoonBit 工具链，需先安装，或裁剪 Makefile 中的 `MOONBIT_OBJ` 依赖。

### 重新生成 Ring 3 用户态程序

用户态测试程序以 ELF blob 形式内嵌进内核（`src/user_*_blob.h`，已签入仓库）。
仅在修改了 `userland/*.asm` 后才需要：

```bash
make userland   # 重新汇编 init/filetest/argv/badptr/forktest/exectest/forkwait
```

---

## Shell 内建命令

| 命令 | 说明 |
|------|------|
| `help` | 列出命令 |
| `ps` | 查看进程 |
| `mem` | 内存使用 |
| `ls` / `cat <f>` | 列目录 / 看文件 |
| `write <f> <文本>` / `append <f> <文本>` / `rm <f>` | 写 / 追加 / 删 |
| `run <prog>` | 运行 `/bin` 下的 Ring 3 程序（fork+exec） |
| `sleep <ms>` | 睡眠 |
| `netstat` / `netsend` / `netrecv` | 网络栈雏形 |
| `diskinfo` / `diskread <blk>` / `diskwrite <blk> <文本>` | 直接读写 ATA 磁盘块 |
| `syscalltest` | 系统调用自检 |

KhyFS 持久化验证：`diskwrite 100 hello` → 重启（`make run-disk` 再次启动）→
`diskread 100`，数据跨重启存活。

---

## 系统调用

经 `int 0x80` 进入（约定见 `src/syscall.c`），目前实现 20 个：

```
write  exit  getpid  uptime  open  read  close  write_file
net_send  net_recv  ipc_send  ipc_recv  ipc_call
port_register  port_unregister  create_process  exec  wait  yield  mmap
```

---

## 源码地图

```
kernel/
├── boot/          引导与底层汇编（长模式切换、ISR、上下文切换、进入用户态）
├── src/           内核 C 源码（内存/进程/调度/文件系统/驱动/syscall…）
├── userland/      Ring 3 测试程序（汇编源 + 预构建 ELF）
├── moonbit/       内核内 MoonBit 模块
├── iso/           GRUB 配置（grub.cfg）
├── linker.ld      内核链接脚本
└── Makefile       构建 / 运行目标
```

---

## 定位与边界（实话实说）

KHY OS 是**教学 / 实验 / 爱好级**内核，不是生产系统：

- 单架构 x86_64、BIOS/GRUB 引导；无 SMP 多核。
- 驱动仅 ATA（无 USB / NVMe / 现代显卡）；网络与 IPC 为雏形。
- Windows PE 兼容只覆盖 kernel32 的极小子集，跑不了复杂真实 `.exe`。
- 用户态是手写汇编测试程序，无 POSIX 完整性、无软件生态。

它真正的价值在于：**完整地走通了 引导 → 分页 → 调度 → 系统调用 → fork/exec →
文件系统 → 用户态 这条链路**，适合学习 OS 内核、做研究原型（尤其 PE 加载方向），
或作为系统编程能力的展示。

---

## 与 khy-os 平台的关系

内核通过 16550 串口（QEMU 暴露为 TCP）对外提供唯一的双向字节流。上层 `@khy/shared`
里的 `KhyOsRunner` 把这条串口包装成统一运行时，再衍生出三个控制面：

- **TUI**：`khy os` → 内核终端浮层
- **网页**：前端 `/khyos` + xterm.js，经 ai-backend `/ws` 桥接
- **pip**：`khy os` / `khy os run "<命令>"`，跨 Windows 与 Linux

这些都是「遥控器」——**内核本身零改动、可独立启动**，平台只是让它不再是孤岛。
