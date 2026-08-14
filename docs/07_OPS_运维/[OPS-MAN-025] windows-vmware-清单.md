<!-- 文档分类: OPS-MAN-025 | 阶段: 运维 | 原路径: docs/指南/windows-vmware-清单.md -->
# KHY OS Windows 构建 + VMware 交付指南

本指南介绍两条受支持的 VMware 交付路径：

1. Windows + `pip install khy-os` -> 构建 `khy-os.iso` -> 在 VMware 中挂载 ISO
2. Linux 源码树 -> 构建 `.raw` / `.vmdk` -> 在 VMware 中使用现有磁盘

如果你只需要让 KHY OS 在 Windows 上的 VMware 中启动，推荐使用 ISO 路径。

## 1. 选择正确的路径

### 路径 A. Windows + pip 安装 + ISO

在以下情况使用此路径：

1. 你使用的是 Windows
2. 你通过 `pip install khy-os` 安装了 KHY
3. 你需要一个可在 VMware 中启动的 ISO

说明：

1. 此路径由 `khy iso build` 直接支持
2. 仅为构建 ISO 时，你无需克隆源码仓库
3. 需要 Docker Desktop，因为 ISO 是在容器内构建的

### 路径 B. Linux 源码树 + raw/VMDK

在以下情况使用此路径：

1. 你需要 `.raw` 或 `.vmdk` 磁盘镜像，而非 ISO
2. 你想在 VMware 中挂载一块现有虚拟磁盘
3. 你能够运行特权 Linux 命令，例如 `losetup`、`mount`、`chroot` 和 `grub-install`

说明：

1. 这不是标准的 Windows `pip` 流程
2. raw/VMDK 脚本位于源码树中，而非仅面向 Windows 的 ISO 交付路径
3. 如果 WSL 缺少环回设备或引导加载器支持，请改用原生 Linux 虚拟机或物理机

## 2. 路径 A：Windows + pip install + ISO

### 2.1 前置条件

1. 带 `pip` 的 Python
2. Docker Desktop
3. PowerShell 5+ 或 PowerShell 7
4. VMware Workstation Pro/Player
5. 推荐：以 WSL2 作为 Docker 后端

### 2.2 安装并验证 KHY

```powershell
py -m pip install -U khy-os
khy --version
```

预期结果：

1. `khy` 在 `PATH` 中可用
2. 版本命令正常输出

### 2.3 构建 ISO

默认构建：

```powershell
khy iso build --output C:\khy\dist\khy-os.iso
```

说明：

1. `khy iso build` 是 `pip` 安装方式推荐使用的命令
2. 该命令在内部调用捆绑的 Windows 辅助脚本与 Docker 构建器
3. 可选择任意可写的输出路径；`C:\khy\dist\khy-os.iso` 仅为示例

如果你是在克隆的源码树中操作，以下等效命令同样有效：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\alpine\windows-iso-preflight.ps1 -Output dist\khy-os.iso
powershell -ExecutionPolicy Bypass -File scripts\alpine\build-iso-windows.ps1 -Output dist\khy-os.iso
```

仅在需要使 Docker 缓存失效时才强制执行完整重建：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\alpine\build-iso-windows.ps1 -Output dist\khy-os.iso -NoCache
```

### 2.4 验证产物

```powershell
Get-Item C:\khy\dist\khy-os.iso | Select-Object FullName,Length,LastWriteTime
Get-FileHash C:\khy\dist\khy-os.iso -Algorithm SHA256
```

检查：

1. 文件存在
2. 大小非零
3. 哈希命令成功完成

### 2.5 创建 VMware 虚拟机

使用以下基线设置：

1. 客户机操作系统：Linux 64 位，例如 `Other Linux 5.x or newer`
2. 固件：优先 BIOS；同样支持 UEFI
3. CPU：2 vCPU 或更高
4. 内存：4 GB 或更高
5. 磁盘：32 GB 或更高
6. 网络：首次启动使用 NAT
7. CD/DVD：挂载 `khy-os.iso` 并启用 `Connect at power on`
8. 如果 UEFI 启动失败，请禁用 Secure Boot 后重试

在 GRUB 菜单中，按以下顺序尝试各项：

1. `KHY OS (VMware / Hyper-V)`
2. `KHY OS (safe graphics)`

### 2.6 在虚拟机内进行冒烟测试

启动后：

```bash
khy --version
khy doctor
khy gateway status
khy app list
khy ai status
```

预期结果：

1. 无内核 panic 或重启循环
2. CLI 在多条命令间保持响应
3. `khy doctor` 不报告会阻断基本运行时的硬性失败

## 3. 路径 B：Linux 源码树 + raw/VMDK

仅在你确实需要 VMware 磁盘镜像时才使用此路径。

### 3.1 前置条件

1. 一个克隆的 KHY 源码树
2. 通过 `sudo` 获得的 root 权限
3. `parted`、`losetup`、`rsync`、`grub-install`、`mkfs.vfat`、`mkfs.ext4`
4. 可选：如需 `.vmdk`，则需 `qemu-img`

快速环境参考：

```bash
bash scripts/khytogo/make-khytogo.sh --mode vmware-plan
```

### 3.2 查看镜像方案

```bash
bash scripts/khytogo/make-khytogo.sh \
  --mode vmware-plan \
  --image-path dist/khy-os-vmware.raw \
  --image-size-gib 32 \
  --image-root-size-gib 24 \
  --convert-vmdk
```

这会在任何破坏性或特权构建步骤运行前，打印计划中的布局。

### 3.3 构建 raw 镜像及可选的 VMDK

```bash
sudo bash scripts/khytogo/make-khytogo.sh \
  --mode vmware-create \
  --image-path dist/khy-os-vmware.raw \
  --image-size-gib 32 \
  --image-root-size-gib 24 \
  --execute \
  --confirm-image dist/khy-os-vmware.raw \
  --convert-vmdk
```

替代封装脚本：

```bash
sudo bash scripts/install/install-khy.sh \
  --as system \
  --system-mode vmware-create \
  --image-path dist/khy-os-vmware.raw \
  --image-size-gib 32 \
  --image-root-size-gib 24 \
  --execute \
  --confirm-image dist/khy-os-vmware.raw \
  --convert-vmdk
```

预期结果：

1. 生成 `dist/khy-os-vmware.raw`
2. 启用 `--convert-vmdk` 时生成 `dist/khy-os-vmware.vmdk`
3. VMware 能够以现有镜像方式启动该磁盘，并启用 EFI

### 3.4 在 VMware 中挂载磁盘

1. 新建一个虚拟机
2. 选择 `Use an existing virtual disk`
3. 选择生成的 `.vmdk`
4. 如果你的 VMware 模板要求，请启用 EFI 固件
5. 启动虚拟机，并运行与路径 A 相同的冒烟测试

## 4. 故障排查

### Windows ISO 路径

1. `Docker daemon is not running`
   启动 Docker Desktop 后重试
2. `ISO build script not found in this installation`
   重新安装 `khy-os`，以确保捆绑的 `scripts/alpine` 载荷存在
3. VMware 启动后黑屏
   改用 `KHY OS (safe graphics)` 重试，或切换虚拟机固件模式

### Linux raw/VMDK 路径

1. `vmware-create mode must run as root`
   使用 `sudo` 重新运行该命令
2. `Missing command: qemu-img`
   安装 `qemu-utils` 或你所用发行版的等效包
3. 在 WSL 下环回设备、挂载或 grub 安装失败
   将 raw/VMDK 构建迁移到原生 Linux 虚拟机或主机上

## 5. 裸机准备须知

在写入 USB 介质前：

1. 校验 SHA256
2. 保持 BIOS 模式与你的机器一致
3. 如果未签名内核策略阻止启动，请禁用 Secure Boot
4. 保留一个备用 USB，内含此前已知可用的 ISO
