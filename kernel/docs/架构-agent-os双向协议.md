# 架构设计：Agent ⇄ OS 双向协议（KHY Agent Bridge）

> 设计日期：2026-06-11。本文是「内核与 agent 深度协同」pivot 的动手前综合架构，
> 是后续所有实现阶段的权威依据。上游背景见
> `kernel/docs/进度交接-内核与agent协同pivot.md`，内核能力现状见记忆
> `project_kernel_real_os_phases.md`（已到阶段30，syscall 面 1–55 完整）。

## 0. 用户已澄清的四点硬需求（不再重复询问）

1. **两者都要能接**：内置 KHY Node agent + 外部 agent（如 Claude Code）都要能连。
2. **双向**：agent→OS 控制，且 OS 内部能反过来调 agent 求决策。
3. **OS 作 agent 宿主但松耦合**：KHY-OS 能托管 agent，但 agent 必须也能独立运行。
4. **系统内自然语言配置**：系统中能配置模型、用自然语言与 KHY 交互。

## 1. 现状约束（已核实源码，架构必须落在这些事实上）

- **COM1 串口已被人类 TTY 独占**。`serial.c::serial_print` 是全内核输出路径；
  `console.c::console_getchar_nonblock` 把 `serial_getchar_nonblock` 当键盘兜底
  输入。→ **agent 协议不能裸跑 COM1**，否则与 shell 抢字节。
- **无 virtio 驱动**。`net.c` 仅 loopback 玩具（`net_send` 直接回环进本地
  rx_queue，不出机器）；`SYSCALL_NET_SEND/RECV`(8/9) 是该玩具的入口，不可作
  跨机通道。
- **`ipc.c` 是内核内 task 间端口消息**（`IPC_MAX_PORTS` 端口 + 定深队列 +
  `ipc_call` 请求/应答阻塞）。它**不跨机器**，但其 `sched_block_current` /
  `sched_unblock` 的 lost-wakeup-safe 阻塞模式，正可复用为「内核 task 等 agent
  回决策」的等待原语。
- **调度**：单核，协作式 `yield` + 抢占式时钟。`serial_putchar` 已有 bounded
  poll（`SERIAL_TX_POLL_LIMIT`）——「外设永不 wedge 内核」是既定纪律，新通道
  必须沿用。
- **持久化已就绪**：`/disk` 经 persist hook 跨重启（阶段14 嵌套目录 + 阶段30
  时间戳），故 agent 配置可落 `/disk/etc/agent.conf`。
- **QEMU 启动**：`-cdrom ... -serial stdio`，单串口。

## 2. 关键决策：COM2 作为独立 agent 控制通道

QEMU 可挂第二串口：`-serial stdio`（COM1 = 人类）+ `-serial <chardev>`
（COM2 = agent，chardev 为 unix socket / pty / tcp）。

- COM1 留给人（shell / 自然语言 REPL），COM2 专供 agent 帧协议——**物理隔离，
  零争用**。
- host 侧 agent 连 COM2 的 chardev（socket），驱动协议。
- **松耦合天然成立**：COM2 未连时内核照常跑（满足需求3 agent 可缺席）；
  host agent 进程不依赖内核存在，可独立运行（满足需求3 反向）。

选 COM2 而非 virtio 的理由：零新驱动栈、零触碰核心路径、最小回归面，符合内核
一贯的「零回归紧增量」纪律。virtio-vsock 留作后续高带宽演进项。

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  HOST 侧 (Node)                                              │
│  ┌──────────────┐         ┌────────────────────────────┐   │
│  │ 内置 KHY     │         │ 外部 agent (Claude Code …) │   │
│  │ Node agent   │         │ 经 MCP / SDK                │   │
│  └──────┬───────┘         └─────────────┬──────────────┘   │
│         └────────────┬───────────────────┘                  │
│                      ▼                                       │
│           ┌─────────────────────────┐                       │
│           │ khy-bridge (host 单一真源)│                      │
│           │ · 帧编解码 (COBS+CRC16)  │                       │
│           │ · 二进制 ⇄ JSON 翻译     │                       │
│           │ · seq 关联请求/响应       │                       │
│           │ · OS→agent 回调泵         │                       │
│           └───────────┬─────────────┘                       │
│                       │ COM2 chardev (unix socket / pty)     │
└───────────────────────┼─────────────────────────────────────┘
                        │  结构化帧 (request / response / event)
┌───────────────────────┼─────────────────────────────────────┐
│  KERNEL 侧            ▼                                       │
│           ┌─────────────────────────┐                       │
│           │ agentbus.c  (新)         │                       │
│           │ · COM2 驱动 (泛化 serial)│                       │
│           │ · COBS 解帧/组帧 + CRC16 │                       │
│           │ · 帧路由到 handler        │                       │
│           │ · OS→agent 出站环形队列   │                       │
│           └────┬───────────────┬─────┘                       │
│                │               │                             │
│        ┌───────▼────┐   ┌──────▼──────────────┐              │
│        │ 控制面      │   │ 决策面 (反向)        │              │
│        │ A→OS 动作   │   │ OS→A 求决策          │              │
│        │ 复用既有    │   │ SYSCALL_AGENT_ASK    │              │
│        │ vfs_/proc_  │   │ + ipc 式 block/wake  │              │
│        │ 内核 API    │   │ + 超时兜底           │              │
│        └────────────┘   └─────────────────────┘              │
│                │  事件面: FAULT / exit / disk-full → EVENT 帧 │
└───────────────────────────────────────────────────────────────┘
```

**复杂度放强侧原则**：内核侧用定长二进制 op-code 帧（不在内核写 JSON 解析器，
风险大、代码多）；host（Node）负责二进制 ⇄ JSON 翻译，把语义复杂度留给能力强、
易测的一侧。

## 4. 帧格式（结构化 request-response）

COBS 帧分隔（`0x00` 作帧边界，COBS 编码消除载荷内的 0 字节，自同步），每帧：

```
[type:1][seq:4][code:2][len:2][payload:len][crc16:2]
```

- `type`：`REQUEST`(0x01) / `RESPONSE`(0x02) / `EVENT`(0x03) /
  `DECISION_REQ`(0x04) / `DECISION_RESP`(0x05)
- `seq`：关联请求与响应（入站、出站各自独立序列空间）
- `code`：verb / 结果码（控制面动作号，或决策面意图号）
- `payload`：紧凑结构——内核侧定长 struct + 有限变长字符串槽；host 侧映射为 JSON
- `crc16`：链路完整性（串口可能丢/串字节，CRC 兜底，坏帧丢弃重传）

## 5. 三个面

### 5.1 控制面（agent → OS）—— 复用既有内核能力，几乎零新逻辑
帧 `code` 映射到已实现的内核函数，把现成后端挂到帧 handler：
- **FS**：read / write / stat / list / mkdir / unlink / rename → 直调 `vfs_*`
  （`from_user=0` 走内核路径，或带 agent 身份过 DAC）
- **PROC**：spawn(ELF) / kill / wait / ps → `process_create_from_elf_argv` /
  `sched_kill_task` / 进程表枚举
- **SYS**：uptime / time / meminfo → 既有 syscall 后端
这些阶段基本是「把已有内核函数接到帧路由」，新增逻辑极少。

### 5.2 决策面（OS → agent，反向）—— 需求2 核心，最具新意
内核内某 task 想问 agent「该怎么办」时：
1. 新增 `SYSCALL_AGENT_ASK`（下一个号 **56**）：构造决策请求（自然语言串 +
   可选结构化上下文），经 agentbus 出站队列发 `DECISION_REQ` 帧。
2. 调用 task 复用 ipc 式 block/wakeup 语义阻塞等待（lost-wakeup-safe，参照
   `ipc_send`/`ipc_recv` 的 crit_enter + sched_block_current 模式）。
3. host agent 推理后回 `DECISION_RESP`（带同 seq），agentbus 唤醒 task 返回结果。
4. **超时 / agent 缺席**：返回 `EAGAIN` 或默认决策——agent 不在也绝不挂死内核
   （沿用 serial bounded-poll 哲学）。
应用：OOM 杀谁、未知文件类型如何处理、shell 自然语言命令解析成动作。

### 5.3 事件面（OS → agent，单向 fire-and-forget）—— EVENT 帧
进程退出、`[FAULT]`、磁盘满等异步通知 push 给 agent，无需回应。复用既有
`[FAULT]` 钩子点与进程退出路径。出站队列满则丢弃（松耦合，不阻塞内核）。

## 6. 四需求 → 架构映射

| 需求 | 落地 |
|------|------|
| 1 双 agent 接入 | host `khy-bridge` 单一真源：内置 KHY agent in-process 调用；外部 Claude Code 经 MCP server / SDK 工具暴露 bridge 能力，复用项目既有网关/适配器基础设施 |
| 2 双向 | 控制面（5.1）= agent→OS；决策面（5.2）= OS→agent |
| 3 松耦合 | 内核：COM2 未连/队列满 → 立即返「无 agent」码，功能完整独立。host：agent 进程不依赖内核，独立 CLI/SDK 运行。COM2 socket 解耦，任一侧可独立启停 |
| 4 自然语言配置 | shell 内置 `ai <自然语言>` → 决策面 → agent 回结构化动作 → 内核执行；模型/endpoint 配置落 `/disk/etc/agent.conf`（持久化已就绪），bridge 读它决定连哪个 agent/模型 |

## 7. 实施阶段（紧增量，每步 QEMU 可验证，零回归）

- **A1 物理通道**：泛化 `serial.c` 支持 COM1/COM2（端口参数化），Makefile 加
  第二 `-serial`。验证：host socket echo 往返一字节。
- **A2 帧层**：`agentbus.c` —— COBS 解/组帧 + CRC16 + seq。验证：一帧回环往返。
- **A3 控制面（只读）**：先接 stat / list / read（最安全）。host 发 REQUEST
  读 `/proc/version` 验证内容。
- **A4 控制面（写 + proc）**：write / spawn / kill / ps。
- **A5 决策面**：`SYSCALL_AGENT_ASK`(56) + block/wakeup + 超时兜底。userland
  程序问 agent，验证往返与超时不挂死。
- **A6 事件面**：FAULT / exit push EVENT 帧。
- **A7 host bridge + 双 agent**：Node `khy-bridge` + MCP/SDK 暴露，接通内置与
  外部 agent。
- **A8 自然语言配置**：shell `ai` 命令 + `/disk/etc/agent.conf` 读取。

## 8. 工程约束（AGENTS.md 硬约束，勿违反）

- 零硬编码；状态诚实（干净降级打诚实码，不打 `KERNEL PANIC`）；活跃度重置超时。
- 外设永不 wedge 内核：新通道所有 poll 必须 bounded（参照 `SERIAL_TX_POLL_LIMIT`）。
- 不主动 commit/push。
- 新增 userland 程序流程：写 `.asm` → `bash tools_gen_blob.sh <name>` →
  接 `ramfs.c`(#include + vfs_write_file) + `Makefile`(USERLAND_PROGS + ramfs.o
  依赖行) → make → QEMU 验证。
- 测试命令模式：
  `(sleep 8; printf 'run /bin/X.elf\n'; sleep 4) | timeout 20 qemu-system-x86_64 -cdrom build/khy-os-kernel.iso -serial stdio -display none -no-reboot`
