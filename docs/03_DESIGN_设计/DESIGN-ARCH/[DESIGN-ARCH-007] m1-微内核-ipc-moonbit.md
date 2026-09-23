<!-- 文档分类: DESIGN-ARCH-007 | 阶段: 设计 | 原路径: docs/架构/m1-微内核-ipc-moonbit.md -->
# M1 微内核 + IPC + MoonBit 接口草案

本文档为该架构定义了一个具体的 M1 基线：

- 微内核（microkernel）仅保留调度、物理内存与中断转发。
- 操作系统组件（`netd`、`fsd`、`wmd`）作为相互隔离的用户态进程运行。
- 应用程序运行于 MoonBit/WASM 沙箱中，仅能通过 IPC 访问系统能力（capability）。

## 1) M1 范围

M1 的目标是打通一条完整路径：

`MoonBit weather app -> IPC -> netd -> external HTTP API -> response -> app render`

M1 不包含以下内容：

- 完整的 POSIX 兼容
- async/await IPC 多路复用
- DMA 零拷贝网络
- GPU 加速

## 2) 进程与能力模型

每个进程从启动器（launcher）获得一个能力位集（capability bitset）。默认采用拒绝优先（deny-by-default）策略。

建议的 M1 能力位：

```text
CAP_IPC        = 1 << 0
CAP_NET        = 1 << 1
CAP_FS_READ    = 1 << 2
CAP_FS_WRITE   = 1 << 3
CAP_WINDOW     = 1 << 4
CAP_SHM        = 1 << 5
CAP_IRQ_BIND   = 1 << 6
```

规则：

- MoonBit 应用不直接访问硬件或内核对象。
- MoonBit 应用只能调用宿主导入（host-imported）的 API。
- 宿主 API 在转发 IPC 请求前会校验能力位。

## 3) Syscall ABI（内核边界）

### 3.1 通用 syscall 入口

```text
syscall(id, a0, a1, a2, a3, a4, a5) -> isize
```

- `>= 0`：成功返回值
- `< 0`：`-errno`

### 3.2 M1 syscall ID

| ID | 名称 | 参数 |
|---|---|---|
| `0x01` | `proc_spawn` | `a0=*ProcSpawnReq`, `a1=*ProcSpawnResp` |
| `0x02` | `proc_exit` | `a0=exit_code` |
| `0x03` | `cap_grant` | `a0=pid`, `a1=cap_bits_low`, `a2=cap_bits_high` |
| `0x04` | `cap_revoke` | `a0=pid`, `a1=cap_bits_low`, `a2=cap_bits_high` |
| `0x10` | `ipc_call` | `a0=*IpcCallReq` |
| `0x11` | `ipc_reply` | `a0=*IpcReplyReq` |
| `0x12` | `ipc_send` | `a0=*IpcSendReq` |
| `0x13` | `ipc_recv` | `a0=*IpcRecvReq` |
| `0x20` | `shm_create` | `a0=*ShmCreateReq`, `a1=*ShmCreateResp` |
| `0x21` | `shm_map` | `a0=*ShmMapReq` |
| `0x30` | `irq_bind` | `a0=*IrqBindReq` |
| `0x31` | `irq_ack` | `a0=irq_no` |

### 3.3 Rust 布局定义（`repr(C)`）

```rust
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KErrno {
  EPERM = 1,
  ENOENT = 2,
  EIO = 5,
  ENOMEM = 12,
  EACCES = 13,
  EINVAL = 22,
  ENOSYS = 38,
  ETIMEDOUT = 60,
  EPROTO = 71,
  EMSGSIZE = 90,
}

#[repr(C)]
pub struct ProcSpawnReq {
  pub image_ptr: u64,
  pub image_len: u32,
  pub flags: u32,
  pub name_ptr: u64,
  pub name_len: u32,
  pub reserved0: u32,
  pub cap_bits: u64,
}

#[repr(C)]
pub struct ProcSpawnResp {
  pub pid: u32,
  pub reserved0: u32,
}

#[repr(C)]
pub struct IpcCallReq {
  pub target_pid: u32,
  pub service_id: u16,
  pub method_id: u16,
  pub timeout_ms: u32,
  pub in_ptr: u64,
  pub in_len: u32,
  pub reserved0: u32,
  pub out_ptr: u64,
  pub out_cap: u32,
  pub flags: u32,
}

#[repr(C)]
pub struct IpcReplyReq {
  pub request_id: u64,
  pub status: i32,
  pub reserved0: u32,
  pub out_ptr: u64,
  pub out_len: u32,
  pub flags: u32,
}

#[repr(C)]
pub struct IpcSendReq {
  pub channel_id: u32,
  pub reserved0: u32,
  pub in_ptr: u64,
  pub in_len: u32,
  pub flags: u32,
}

#[repr(C)]
pub struct IpcRecvReq {
  pub channel_id: u32,
  pub timeout_ms: u32,
  pub out_ptr: u64,
  pub out_cap: u32,
  pub reserved0: u32,
  pub out_len_ptr: u64,   // writes actual bytes
  pub from_pid_ptr: u64,  // writes sender pid
}

#[repr(C)]
pub struct ShmCreateReq {
  pub size: u64,
  pub perms: u32,
  pub flags: u32,
}

#[repr(C)]
pub struct ShmCreateResp {
  pub handle: u32,
  pub reserved0: u32,
}

#[repr(C)]
pub struct ShmMapReq {
  pub handle: u32,
  pub target_pid: u32,
  pub offset: u64,
  pub length: u64,
  pub map_flags: u32,
  pub reserved0: u32,
  pub out_addr_ptr: u64,
}

#[repr(C)]
pub struct IrqBindReq {
  pub irq_no: u32,
  pub target_pid: u32,
  pub queue_depth: u16,
  pub flags: u16,
}
```

## 4) IPC 消息契约

对于组件间消息传递，采用固定头部 + 载荷（payload）的形式。

```rust
#[repr(C)]
pub struct IpcHeader {
  pub magic: u32,       // 0x4B48_5950 ('KHYP')
  pub version: u16,     // M1 = 1
  pub msg_type: u16,    // 1=req, 2=resp, 3=event, 4=error
  pub request_id: u64,
  pub service_id: u16,
  pub method_id: u16,
  pub flags: u32,
  pub status: i32,      // response/error only
  pub payload_len: u32,
}
```

M1 限制：

- 单个 IPC 帧的最大载荷：`64 KiB`
- 更大的数据使用 `shm_create + shm_map`，并通过 IPC 发送句柄元数据
- 默认调用超时：`3000 ms`

## 5) 服务 ID 与方法 ID（M1）

```text
SERVICE_FS  = 1
SERVICE_NET = 2
SERVICE_WM  = 3
```

建议的方法：

```text
FS_READ_FILE      = 1
FS_STAT           = 2

NET_HTTP_GET      = 1
NET_DNS_RESOLVE   = 2

WM_PRESENT_TEXT   = 1
WM_BLIT_RGBA      = 2
```

M1 中的载荷编码：UTF-8 JSON 字节。

## 6) MoonBit 接口定义（宿主 FFI + SDK）

MoonBit 应用侧使用宿主导入的函数。原始导入（raw import）保持窄接口且为数值型；可在其之上构建更友好的封装。

### 6.1 原始宿主导入（`khy_sys` 模块）

```moonbit
// Capability probe: returns 1 if granted, otherwise 0.
fn cap_check(cap_bit : Int) -> Int = "khy_sys" "cap_check"

// Synchronous IPC call.
// Returns >= 0 on success, or negative errno.
fn ipc_call(
  service_id : Int,
  method_id : Int,
  req_ptr : Int,
  req_len : Int,
  resp_ptr : Int,
  resp_cap : Int,
  timeout_ms : Int
) -> Int = "khy_sys" "ipc_call"

// Query response metadata from last ipc_call.
fn ipc_last_len() -> Int = "khy_sys" "ipc_last_len"
fn ipc_last_status() -> Int = "khy_sys" "ipc_last_status"

// Async send/recv channel APIs.
fn ipc_send(channel_id : Int, msg_ptr : Int, msg_len : Int, flags : Int) -> Int = "khy_sys" "ipc_send"
fn ipc_recv(channel_id : Int, out_ptr : Int, out_cap : Int, timeout_ms : Int) -> Int = "khy_sys" "ipc_recv"

// Shared memory APIs.
fn shm_create(size : Int, perms : Int) -> Int = "khy_sys" "shm_create"
fn shm_map(handle : Int, offset : Int, length : Int) -> Int = "khy_sys" "shm_map"
```

### 6.2 建议的 MoonBit SDK 接口（面向应用）

```moonbit
pub let CAP_NET = 1 << 1
pub let CAP_FS_READ = 1 << 2
pub let CAP_WINDOW = 1 << 4

pub let SERVICE_NET = 2
pub let NET_HTTP_GET = 1

pub fn has_capability(cap : Int) -> Bool {
  cap_check(cap) == 1
}

// High-level wrapper contract:
// - input/output are UTF-8 JSON bytes
// - ipc_call return value is status (0 success, <0 -errno)
// - actual response length comes from ipc_last_len()
pub fn call_json(
  service_id : Int,
  method_id : Int,
  request_json : Bytes,
  timeout_ms : Int
) -> (Int, Bytes)
```

### 6.3 天气应用调用示例（MoonBit）

```moonbit
pub fn fetch_weather() -> (Int, Bytes) {
  if !has_capability(CAP_NET) {
    return (-13, b"{\"error\":\"CAP_NET required\"}")
  }

  // Example payload in UTF-8 JSON bytes.
  let req = b"{\"city\":\"shanghai\"}"
  call_json(SERVICE_NET, NET_HTTP_GET, req, 3000)
}
```

## 7) 端到端流程（M1）

1. 启动器以 `CAP_IPC | CAP_NET | CAP_WINDOW` 启动天气应用。
2. MoonBit 应用调用 `call_json(SERVICE_NET, NET_HTTP_GET, ...)`。
3. 宿主运行时校验能力，构建 `IpcHeader`，执行 `ipc_call`。
4. `netd` 执行 DNS + HTTP GET，并以 JSON 载荷回复。
5. 运行时将字节返回给 MoonBit 应用。
6. 应用通过 `SERVICE_WM / WM_PRESENT_TEXT` 渲染文本，或打印到 CLI。

## 8) 兼容性说明

- 所有 ID（`service_id`、`method_id`、syscall 编号）一旦发布即保持稳定。
- 通过扩展方式新增方法，绝不复用旧 ID。
- 若载荷格式变更，递增 `IpcHeader.version`，并在一个大版本内保留向后兼容的解析器。
- 当前宿主适配器（`backend/src/services/wasm-sandbox/khySysHost.js`）期望 `ipc_call(req_ptr, req_len, resp_ptr, resp_cap, ...)` 采用基于线性内存的 `u32 ptr/len` ABI。
- MoonBit `wasm-gc` 构建可能为 `Bytes` FFI 参数传入非指针的 `externref` 字节对象。在当前仓库中，这种不匹配会被拒绝为 `-EPROTO` 并附带明确的 ABI 不匹配错误。
- 当模块导入 `khy_sys.ipc_call` 但未导出预期的内存符号时，`app register --abi numeric-v1` 现在会快速失败（以避免运行时后期才暴露的故障）。
- `app register` 现在会在前期校验导入兼容性。不受支持的导入会被尽早拒绝；当前宿主支持 `khy_sys.*`（`cap_check`、`ipc_call`、`ipc_last_len`、`ipc_last_status`、`shm_create`、`shm_map`）以及 `spectest.print_char`。
- `app register --abi string-v2|json-v2` 现在会校验所需的 ABI 导出（`memory`、`alloc`、可选的 `free`），且当前仅接受 `return-mode=i64-ptr-len`。
- `wasmAppService.runFunction(..., abi=numeric-v1)` 现在会执行一次预检：若模块导入 `khy_sys.ipc_call` 但未导出预期的线性内存，则在执行目标导出之前拒绝该调用。
- 为在当前宿主中可靠地执行进程内 `khy_sys.ipc_call`，请使用暴露指针兼容内存 ABI 的模块。

## 9) 本地模拟（当前仓库）

仓库现已提供宿主侧的回环（loopback）传输，用于 M1 IPC 模拟。

注册一个带显式能力的 WASM 应用：

```bash
khy app register weather \
  --runtime wasm \
  --wasm /abs/path/weather.wasm \
  --abi json-v2 \
  --export run \
  --caps ipc,net
```

直接调用回环 NET 服务（无需真实内核/网络驱动）：

```bash
khy app ipc weather net http_get --json '{"city":"shanghai"}'
```

也可以使用数值 ID：

```bash
khy app ipc weather 2 1 --json '{"city":"beijing"}'
```
