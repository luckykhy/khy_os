<!-- 文档分类: DESIGN-ARCH-008 | 阶段: 设计 | 原路径: docs/架构/moonbit-系统边界.md -->
# MoonBit OS 边界

## 定位

- 内核与硬件控制保留在宿主机 Linux（或 hypervisor 栈）中。
- MoonBit 用于编译为 WASM 的纯计算模块。
- I/O、网络、文件与进程管理保留在宿主机服务中。

## 为何如此划分

- 保持 OS 交付路径对 VMware 与裸机工作流的稳定性。
- 避免计算密集型模块出现跨平台原生二进制的泛滥。
- 保留严格的回滚路径：仅通过环境变量/配置即可切换计算引擎。

## 当前 Khy OS 映射

- 宿主机层：
  - `khy_platform/cli.py`
  - `backend/bin/khy.js`
  - `backend/src/services/*`（I/O、网络、编排）
- MoonBit/WASM 层：
  - `backend/wasm-indicators/`（纯指标算法）
  - `backend/src/services/wasmAppService.js`（WASM 应用导出执行）
  - `scripts/moonbit/run-wasm-indicators-tests-offline.sh`（离线验证）

## 构建与交付

- 统一组件构建入口：
  - `scripts/build-khy-os.sh`
- VMware 镜像规划/构建：
  - `scripts/khytogo/make-khytogo.sh --mode vmware-plan|vmware-create`
- 便携包：
  - `scripts/portable/build-usb-portable.sh`

## WASM ABI

- `numeric-v1`：向导出函数传入位置式数值参数。
- `string-v2`：宿主机编码 UTF-8 载荷并传入 `(ptr,len)`，模块以 `i64` 返回打包后的 `(ptr,len)`。
- `json-v2`：宿主机通过 `string-v2` 传输发送 JSON 字符串，并强制执行 JSON 输出解析。

## 设计准则

`Kernel untouched, sandbox accelerated.`
