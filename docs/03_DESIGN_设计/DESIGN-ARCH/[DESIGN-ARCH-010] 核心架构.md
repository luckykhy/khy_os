<!-- 文档分类: DESIGN-ARCH-010 | 阶段: 设计 | 原路径: docs/架构/核心架构.md -->
# 核心架构

## 运行时路径

```text
User -> khy CLI (Python) -> Node CLI router -> services/routes -> data/storage
```

## 受 Alpine 启发的启动分层（参考模型）

本项目可以借鉴 Alpine 的分层启动思路：

```text
Bootloader -> minimal init/bootstrap -> core runtime -> upper apps/plugins
```

映射到 Khy OS：

- 启动/入口：
  - `khy_platform/cli.py`（Python 启动器，环境检查，bootstrap 移交）
- 核心运行时：
  - `backend/bin/khy.js` + `backend/src/bootstrap/*` + CLI router/services
- 上层应用/插件：
  - `khyquant` 作为默认应用兼容入口
  - `backend/src/cli/handlers/app.js` + 插件/技能生态

实践规则：

- 将 `khy` 保持为操作系统级的主命令。
- 将应用逻辑（如量化交易）保持为可替换的上层模块。

## 来自 `alpine-standard-3.23.0-x86_64.iso` 的具体参考点

- 极简启动配置：
  - `/BOOT/GRUB/GRUB.CFG;1`
  - `/BOOT/SYSLINUX/SYSLINUX.CFG;1`
  - 让启动路径保持精简且确定。
- 分层运行时产物：
  - kernel：`/BOOT/VMLINUZ_LTS.;1`
  - early userspace：`/BOOT/INITRAMFS_LTS.;1`
  - 模块化运行时镜像：`/BOOT/MODLOOP_LTS.;1`
- 由软件包驱动的系统组装：
  - `/APKS/X86_64/APKINDEX_TAR.GZ;1` + APK 软件包。
  - 在 Khy OS 中的对应物：让应用/插件的安装/更新由包/索引驱动。
- 显式的 init 到 runtime 移交：
  - initramfs 的 `init` 脚本以 `switch_root` 结束。
  - 在 Khy OS 中的对应物：让 launcher/bootstrap/runtime 之间的边界保持显式且可测试。
- 已签名的模块信任链：
  - modloop 的签名密钥在软件包安装之前预先就位。
  - 在 Khy OS 中的对应物：插件/运行时产物应在激活之前可验证。

## 层级映射（当前 Khy OS）

### 1) 应用层

- 浏览器应用（Vue UI）、CLI 应用，以及外部插件应用。
- WASM 应用通过以下方式注册和执行：
  - `backend/src/cli/handlers/app.js`
  - `backend/src/services/wasmAppService.js`

### 2) WASM 沙箱层

- 纯逻辑模块运行在 WebAssembly 中（MoonBit/Rust/C/C++ 编译为 WASM）。
- 宿主保留 I/O、网络、文件、进程和设备访问能力。
- 浏览器端桥接：
  - `frontend/src/services/wasm/wasmBridge.js`

### 3) OS 组件层

- 后端服务按职责拆分（gateway、routing、data、auth、plugins）。
- 组件之间通过显式的 API/命令通信，而非直接的 UI 耦合。

### 4) IPC 层

- CLI 命令分发（`stdin/stdout`）
- HTTP/JSON API（`backend/src/routes`）
- 可选的 WebSocket/事件通道

### 5) 微内核层（仓库范围之外）

- CPU 调度、物理内存管理和中断路由仍保留在宿主内核/hypervisor 中。
- Khy OS 与既有的 Linux/hypervisor 栈集成，以支持 VMware/裸机交付流程。

## 核心模块

- `khy_platform/cli.py`：Python 入口点与后端 bootstrap 移交。
- `backend/bin/khy.js`：Node CLI 入口。
- `backend/src/cli/router.js`：命令解析 + 分发。
- `backend/src/services/`：领域服务与 WASM 执行宿主。
- `backend/src/routes/`：HTTP API 路由。
- `frontend/src/services/wasm/wasmBridge.js`：浏览器 JS <-> WASM 桥接。

## 设计规则

- 将内核职责保持在业务运行时之外。
- 将 I/O 保持在宿主层（CLI/routes/services），而非 WASM 模块内部。
- 让 WASM 模块保持纯粹、确定且可替换。
- 让命令与服务的边界保持显式且可测试。
