# 进度交接：内核「真实 OS」长弧 + agent 协同 pivot

> 记录日期：2026-06-10。本文用于跨会话防进度丢失，权威细节以记忆
> `project_kernel_real_os_phases.md` 为准，本文是高层索引。

## 1. 本轮已闭合（已实测 GREEN，零回归）

- **阶段30 时间戳跨重启持久化**：文件 mtime/atime/ctime 跨重启稳定，
  不再 replay 重戳为 "now"。
  - `diskfs` slot 64B→128B，携带三个 32 位 epoch 时间戳；`DISKFS_VERSION 1→2`
    （旧盘 mount 失败→reformat）；`SLOTS_PER_SECTOR 8→4`、`DIR_SECTS 8→16`、
    `DATA_LBA 9→17`。
  - `persist.c`：每次 save 后 `persist_times()` 把节点三戳落盘；replay 重建
    节点后 `vfs_set_times()` 恢复原始戳（不 fire hook，避免回写）。
  - `vfs_set_times()`：直接设节点三戳、**不触发任何 change hook**（replay 专用）。
  - 测试：`userland/ptimetest.asm` 两阶段（经 `/disk/pmark` 标记区分首启/次启），
    QEMU `-hda` 双启：boot1→SETUP 退0；boot2→`mtime survived reboot
    byte-for-byte -> OK` 退0。回归 filetest 持久化 + 11 个 stat-ABI/核心测试全绿。
  - **关键 gotcha（务必牢记）**：`int 0x80` 返回经 `iret` 恢复调用方 RFLAGS，
    **不依据 rax 设标志位**。故 syscall 后直接 `js/jns/jz` 读到的是上一条
    `test/cmp` 的陈旧标志，不是 syscall 结果。**每个 syscall 后的条件跳转前
    必须自己 `test rax, rax`**。

## 2. 目标已 pivot（新主目标，A1 已动工）

原 `/goal`「内核从玩具→真实 OS」仍是长弧背景，但用户已重定义主目标为：
**做一个能与 agent 结合/协同的 OS**（否则单独造系统意义不大）。

用户澄清的四点硬需求：
1. **两者都要能接**：内置 KHY Node agent + 外部 agent（如 Claude Code）都要能连。
2. **双向**：不只是 agent→OS 控制，OS 内部也能反过来调 agent 求决策。
3. **OS 作 agent 宿主但松耦合**：KHY-OS 能托管 agent 本身，但 agent 不能完全
   依赖它（必须也能独立运行）。
4. **系统内自然语言配置**：系统中要能配置模型、用自然语言与 KHY 交互。

### 综合架构已定（2026-06-11）
完整架构见 `kernel/docs/架构-agent-os双向协议.md`。要点：物理通道选 **COM2 独立
串口**（COM1 已被人类 TTY 独占，COM2 物理隔离零争用、零新驱动栈）；内核侧只做
定长二进制 op-code 帧（COBS+CRC16），host(Node) 负责二进制⇄JSON 翻译（复杂度放
强侧）；三个面=控制面(agent→OS,复用 vfs_/process_)、决策面(OS→agent,新
SYSCALL_AGENT_ASK=56 复用 ipc block/wakeup,超时兜底)、事件面(OS→agent 单向)；
8 阶段 A1–A8。

### 进度：阶段 A1 已闭合（2026-06-11，QEMU 实测 GREEN）
**A1 物理通道 = COM2 双向字节传输打通。**
- `serial.h/.c`：I/O 核心按 base port 参数化（`serial_init_port`/`port_putchar`/
  `port_has_data`，COM1 API 字节不变），新增 COM2 raw 原语 `serial_com2_init/
  putchar/has_data/getchar_nonblock`（二进制无 CRLF 翻译，bounded poll 同
  `SERIAL_TX_POLL_LIMIT`，绝不 wedge 内核）。`SERIAL_COM2 0x2F8`。
- `agentbus.h/.c`（新）：`agentbus_init()` 初始化 COM2；`agentbus_task()` 轮询
  COM2 RX 字节回写 TX（**A1 raw echo 桩，A2 替换为帧机**，init/task 脚手架永久）。
  松耦合：无 host 连接时通道空闲，内核照常跑。
- `main.c`：`net_init` 后调 `agentbus_init`；建 `agent-bridge` 服务任务
  （同 vfs/net-service 模式）。
- `Makefile`：`run-agent` 目标——COM1=`-serial stdio`、COM2=`-serial unix:
  $(AGENT_SOCK),server,nowait`（**QEMU 按声明顺序分配串口，顺序不可乱**）。
- `kernel/tools/agentbus_echo_test.py`（新）：A1 host 验证。boot QEMU(COM1→log,
  COM2→unix socket)→连 socket→发 `PING-khy-agentbus-A1\n`→校验逐字节 echo 回来。
- **实测**：echo 往返字节完全相等 `[PASS]`；COM1 log 同时含 KHY OS banner +
  AGENTBUS 初始化行（通道隔离）；回归 COM1 shell 经串口跑 `stattest.elf ->
  OK` + 干净 reap，build 绿。

### 阶段 A7b 双 agent 实接已闭合（2026-06-11，QEMU 实测 GREEN）—— 8 阶段 A1–A8 全部完成
**需求1 落地：内置 KHY Node agent（in-process）与外部 agent（Claude Code，经 MCP）
共用同一 `KhyBridge` 实现连同一个 OS，零协议逻辑重复。** 纯 host 侧（Node stdlib，
零依赖、零内核改动）。
- `bridge/khy-tools.js`（新）：`makeTools(bridge)` —— OS 能力面**单一真源**，返回工具
  描述符 `{name, description, inputSchema(JSON Schema), handler}` 列表：khy_list/
  khy_stat/khy_read/khy_write/khy_mkdir/khy_remove/khy_ps/khy_get_config。每个 handler
  只调一个 `KhyBridge` 方法 → 控制面仍是通往内核的唯一路径。inputSchema 用 JSON Schema，
  既有网关/适配器可直接挂载零翻译。
- `bridge/khy-agent.js`（新）：内置 in-process agent `KhyAgent`。`start()` 连桥→
  `readConfig()` 读 `/disk/etc/agent.conf`（接 A8 需求4）→ `onDecision` 绑 brain 服务
  决策面。**brain 可注入**（默认 `defaultBrain` 纯规则、零网络、永远应答，内核永不阻塞；
  生产可换成调项目 AI 网关、按系统内配置的模型应答 → 需求3 松耦合）。`call(name,args)`
  走与外部 agent 相同的工具面 in-process 驱动 OS。
- `bridge/khy-mcp.js`（新）：外部 agent 入口。手写纯 Node MCP（newline-delimited
  JSON-RPC 2.0 over stdio，无 MCP SDK → 保零依赖松耦合）。`KhyMcpServer` 实现
  initialize/ping/tools/list/tools/call；tool 失败按 MCP 走 in-band `isError`（非
  JSON-RPC error）；非 JSON 行丢弃绝不 desync；诊断只走 stderr，stdout 仅协议字节。
  `main()` 从 `KHY_COM2_SOCK`/`--socket` 取 COM2，SIGTERM/SIGINT/stdin-close 优雅退出。
- `bridge/index.js`：导出 `{ KhyBridge, KhyStatusError, makeTools, KhyAgent,
  defaultBrain, KhyMcpServer, frame, protocol }` —— 一处 require 即得三面+双 agent 前端。
- `kernel/tools/agentbus_dualagent_test.js`（新）：A7b host e2e，QEMU `-hda` 盘。
  **Phase 1（内置 agent in-process）**：`KhyAgent` 连 COM2 服务决策面，COM1 驱动
  `ai use model claude-opus`→shell `[ai] set model`、`agentask delete everything`→DENY、
  `agentask may I proceed?`→ALLOW，并 in-process `call('khy_list')`/`call('khy_get_config')`
  直驱控制面。**Phase 2（外部 agent 经 MCP）**：内置 agent 脱开后 spawn `khy-mcp.js` 子进程
  指向同一 COM2，走真 MCP JSON-RPC（initialize→serverInfo.name=khy-os；tools/list 含全 8 工具；
  tools/call khy_write+khy_read 往返；khy_get_config 读到 **Phase 1 内置 agent 写的同一份配置**
  → 同一 OS 同一桥；khy_ps 见 agent-bridge）。**12/12 PASS。**
- **回归零**：A7b 不改内核（host-only Node），内核二进制不变；仍全跑 —— A3/A4 ctl、
  A5 ask、A6 event(+事件落地)、A7 bridge 11/11、A8 nl 10/10，全绿零回归。

**8 阶段路线图 A1–A8 至此全部闭合。** 四点硬需求全部落地：①双 agent 实接（A7b）
②双向（控制面 A3/A4 + 决策面 A5 + 事件面 A6）③宿主但松耦合（zero-dep host、可注入
brain、agent 可独立跑）④系统内自然语言配置（A8 `ai <NL>` + `/disk/etc/agent.conf`）。

### 后续增强已完成（2026-06-11，QEMU 实测 GREEN）—— 真模型决策 + Claude Code MCP 联调就位
两项「后续可选」均已落地，纯 host 侧、零内核改动（本轮无 .c/.h 改动，内核二进制不变）。

**① 内置 brain 接项目 AI 网关（真模型决策）**
- `bridge/khy-brain-gateway.js`（新）：`makeGatewayBrain(opts)` 返回 `async (question,
  code, config)` brain。走纯 Node stdlib（http/https/fs/os，**仍零依赖**）POST 项目网关
  OpenAI 兼容端点 `/v1/chat/completions`。按面整形输出：GENERIC→严格 `ALLOW|DENY`、
  NL→单行 `SET|GET|SAY` 动作（首词大写以匹配内核 `ai_apply_action` 的 `strncmp("SET ",4)`）。
  **配置解析**：URL=`KHY_GATEWAY_URL` 或 `http://${PROXY_HOST||127.0.0.1}:${PROXY_PORT||9100}`；
  token=`PROXY_AUTH_TOKEN` 或读 `~/.khy/proxy_server_auth.json` 的 `authToken`；模型=
  **config.model（in-system 配置，需求4）优先** > `KHY_BRAIN_MODEL` > 默认；超时=
  `KHY_BRAIN_TIMEOUT_MS`(默认 2500ms < 内核 3s ask 死线)。**松耦合硬保证**：任何失败
  (网络/401/超时/解析) 都 `try/catch` 降级回 `defaultBrain` 规则脑，绝不抛错、绝不返回
  null → 内核永远拿到合法答案永不挂死。
- `bridge/khy-agent-run.js`（新）：可执行 launcher。把内置 `KhyAgent` 用 `makeGatewayBrain()`
  挂上活内核 COM2 服决策面；`--socket`/`KHY_COM2_SOCK`/`AGENT_SOCK` 取 socket(默认
  `/tmp/khy-agent.sock`)；SIGHUP 触发 `refreshConfig()` 让用户改完模型免重启即生效；诊断只走 stderr。
- `bridge/index.js`：导出加 `makeGatewayBrain`。
- `tools/agentbus_gateway_brain_test.js`（新）：**8/8 全 PASS**。hermetic 假网关(stand-in 真模型,
  校 bearer token + 记录每请求 model + 按面回 ALLOW/DENY 或 SET/GET/SAY)，其余全真(真内核 QEMU+
  真 KhyBridge COM2+真 makeGatewayBrain HTTP 客户端)。证：`ai switch to model gpt-4o-mini`→模型
  SET→内核落盘;`refreshConfig` 后**配置模型路由 brain**(网关实收 model=gpt-4o-mini);`ai which
  model`→模型 GET→shell 回显值;destructive agentask→模型 DENY、benign→ALLOW;网关真 HTTP 往返+
  鉴权(requests≥4,401=0);**杀网关后 agentask 仍答(规则脑兜底)→内核永不阻塞**(优雅降级实证)。

**② khy-mcp.js 注册进 Claude Code MCP client（真外部联调）**
- `khy-mcp.js`：`main()` 加 `connectWithWait()`——有界等待 COM2 socket 出现并重试 connect
  (上限 `KHY_MCP_CONNECT_TIMEOUT_MS` 默认 30s,0=单次)，故先开 Claude Code 再 `make run-agent`
  也能自动挂上；attach 后日志走 stderr。
- 仓库根 `.mcp.json`（新,project-scoped）：声明 `khy-os` MCP server =
  `node kernel/bridge/khy-mcp.js --socket /tmp/khy-agent.sock`，env `KHY_MCP_CONNECT_TIMEOUT_MS=60000`。
  Claude Code 在仓库根即发现该 server（首次 `/mcp` 批准 project server），或
  `claude mcp add khy-os -- node kernel/bridge/khy-mcp.js --socket /tmp/khy-agent.sock`。
- `kernel/bridge/README-联调.md`（新）：两路线实战指南(路线A 内置 agent+网关真模型决策;
  路线B Claude Code 经 MCP 驱动 OS)+先决条件+环境变量表+单连接约束(COM2 一次一个客户端,A/B 二选一)。
- **回归零**：A7b dualagent 12/12(走新 khy-mcp wait-for-socket 路径)、A8 nl 10/10、A7 bridge 11/11、
  A3/A4 ctl、A5 ask、A6 event 全绿；本轮无内核源改动内核二进制不变。

### 后续可选（非路线图，按需）
- 路线 A 默认指向真网关 `127.0.0.1:9100`；起真网关 + 配真账号(Kiro/Claude/…)即得真大模型决策。
- 把 `khy-mcp.js` 真接进一次 Claude Code 会话跑 khy_list/khy_read/khy_write 实操 KHY-OS 文件。

**不**重复询问已澄清的四点。

### 进度：阶段 A2 已闭合（2026-06-11，QEMU 实测 GREEN）
**A2 帧层 = COBS+CRC16 结构化帧往返打通。**
- `agentframe.h/.c`（新）：纯编解码无 I/O。`agentframe_crc16`(CRC-16/CCITT-FALSE
  poly 0x1021 init 0xFFFF)+`cobs_encode/decode`+`agentframe_encode`(逻辑帧→CRC→
  COBS→尾 0x00)/`agentframe_decode`(COBS 解→校验 len 一致性+CRC→解析)。帧
  `[type:1][seq:4LE][code:2LE][len:2LE][payload][crc16:2LE]`，type=REQUEST(0x01)/
  RESPONSE(0x02)/EVENT(0x03)/DECISION_REQ(0x04)/DECISION_RESP(0x05)。PAYLOAD_MAX
  1024，WIRE/RAW 缓冲由它派生（COBS 开销 ceil(n/254)+1）。
- `agentbus.c`：A1 raw echo 换成**帧机**——RX 累积器按 0x00 切帧（溢出 latch
  `rx_overflow`，下个 0x00 重同步，绝不发截断帧）→`agentframe_decode`→
  `dispatch_frame`：REQUEST 回 RESPONSE 同 seq/code/payload（**A2 帧级 echo，A3
  换真 handler**）。坏帧静默丢弃。in/out_frame+tx_buf 用 static（结构 ~1KB 避栈）。
- `kernel/tools/agentbus_frame_test.py`（新）：host 帧编解码（CRC/COBS/帧 parity）
  +三检查：①好 REQUEST 回 RESPONSE echo 同 seq/code/payload ②坏 CRC 帧被丢弃无回
  ③垃圾字节+0x00 后好帧仍往返（RX 重同步）。
- **实测**三检查全 `[PASS]`；回归 COM1 shell 经串口跑 `pipesrc|pipedst ->
  pipeline OK` + agentbus A2 帧机初始化行在，build 绿。

### 进度：阶段 A3 已闭合（2026-06-11，QEMU 实测 GREEN）
**A3 控制面（只读）= agent 第一次真正「看见」OS 文件系统。**
- `agentctl.h/.c`（新）：控制面 = agent→OS 方向。三只读 verb：STAT/LIST/READ
  （`code` 0x0001/0x0002/0x0003），直调内核 `vfs_stat`/`vfs_list_dir_at`/
  `vfs_read_file_at`（`from_user=0`，无 per-process 权限检查）。每个 RESPONSE
  payload **首字节为 status**（OK 0x00 / ENOENT 0x01 / EINVAL 0x02），错误时只回
  该字节。线格：STAT 回 `[type:1][mode:2][uid:4][gid:4][size:8][mtime:8][atime:8]
  [ctime:8]`；LIST 请求带 `[start:4]`、回 `[count:2]`+每条 `[type:1][size:8]
  [namelen:1][name]`，host 按 count 翻页直至 0（每页上限 16，整页 931B 必入帧）；
  READ 请求带 `[offset:8][len:4]`、回 `[nread:4][bytes]`，len 钳到 1019、host 按
  offset 翻页。坏请求只回 EINVAL，绝不越界/wedge。
- `agentbus.c`：`dispatch_frame` 帧级 echo→`agentctl_handle(req,&out_frame)`+发回。
  传输/RX-TX/帧机不变（A2 的帧级 echo 已被取代）。init/task 日志改 stage A3。
- `kernel/tools/agentbus_ctl_test.py`（新）：host 控制面验证（codec parity+payload
  解析+翻页/翻偏移助手）。六检查：①STAT /etc/motd=FILE size77 ②READ /etc/motd 全
  量 77B banner 对 ③LIST / 含 bin/etc/proc/tmp/var/net 全 DIR ④LIST /bin 翻页 37
  条含 init.elf ⑤STAT 不存在→ENOENT ⑥READ 目录→EINVAL。
- **实测**六检查全 `[PASS]`；回归 COM1 shell 经串口跑 `stattest.elf -> OK` + 干净
  reap，agentbus A3 控制面初始化行在，无 FAULT/PANIC，双通道共存，build 绿。
- Makefile 无需改（`C_SRC = wildcard src/*.c` 自动纳入新 `.c`）。

### 进度：阶段 A4 已闭合（2026-06-11，QEMU 实测 GREEN）
**A4 控制面（写+proc）= agent 能安全地改 OS、看进程。**
- `agentctl.h/.c`：在 A3 三只读 verb 上新增四 verb——**WRITE**(0x0004,
  `[mode:1][pathlen:2][path][data]`，mode 0 覆写/1 追加，回 `[written:4]`，
  直调 `vfs_write_file`)、**MKDIR**(0x0005，已存在回 EEXIST)、**REMOVE**(0x0006，
  文件 `vfs_remove`/空目录 `vfs_rmdir`)、**PS**(0x0007，请求 `[start:4]` 翻页，回
  `[count:2]`+每条 `[pid:4][task_id:4][state:1][is_user:1][namelen:1][name]`，
  快照 `process_list` 进 static 数组避栈)。新 status：EEXIST 0x03、EPERM 0x04。
- **越权边界**：`guard_mutation()` 先 `vfs_realpath(.,follow_final=0)` 规范化，再禁
  `/bin` 及其子路径的写/建/删（保护内嵌 Ring 3 程序区），并操作规范化后的 `canon`
  防 TOCTOU/`..` 逃逸。规范化失败→EINVAL，受保护→EPERM。坏请求只回错误状态不 wedge。
- `agentbus.c`：dispatch 仍通用调 `agentctl_handle`（A4 只是 verb 集变大）；init/task
  日志改 stage A4 + 列全 verb。
- `kernel/tools/agentbus_ctl_test.py`（扩展）：A3 六检查 + A4 六检查共 12 全 `[PASS]`：
  WRITE→READ 回环 24B、append 后 48B、MKDIR 建目录+再建 EEXIST、REMOVE 文件转 ENOENT
  +空目录 OK、`/bin` 写/建/删 + `/bin/../bin/` 逃逸全 EPERM 且 init.elf 仍在、PS 列
  8 个任务含 agent-bridge。回归 COM1 `filetest.elf -> OK` + 干净 reap，无 FAULT/PANIC。

### 进度：阶段 A5 已闭合（2026-06-11，QEMU 实测 GREEN）
**A5 决策面（OS→agent 求决策）= 内核第一次反过来「问」agent，且永不被它挂死。**
- `agentask.h/.c`（新）：决策面 = OS→agent 方向。等待表（8 槽）耦合 **阻塞的调用方**
  与 **异步 DECISION_RESP**。`agent_ask(code,payload,len,out,out_cap,*out_len,
  timeout_ms)` 内核原语：占槽→分配内核 seq（高位段 `0x80000000` 避与 agent REQUEST
  seq 撞）→盖死线→经 `agentbus_send_frame` 发 `DECISION_REQ` 帧→`sched_block_current`
  阻塞。**完全复刻 ipc.c 的 mask-interrupts crit + block-while-masked**：占槽/发帧/
  自阻塞是相对响应者/超时者的**单一临界区**，关掉与 ipc 同款 lost-wakeup 窗口。
  `agentask_on_response(resp)` 按 seq 命中槽→拷 payload→`WAIT_ANSWERED`→唤醒；未知
  seq（超时后迟到/重复回复）忽略。`agentask_tick()` 每个 bridge loop 跑一次，过死线
  的槽标 `WAIT_TIMEDOUT` 并唤醒——**agent 不在/不答绝不挂死内核**（松耦合硬约束）。
- `agentbus.c`：`agentbus_send`→公开 `agentbus_send_frame`（决策面发 DECISION_REQ
  复用）。`dispatch_frame` 改 switch 按 type 路由：REQUEST→`agentctl_handle`，
  **DECISION_RESP→`agentask_on_response`**，OS-origin 类型（RESPONSE/EVENT/
  DECISION_REQ）入站一律忽略。`agentbus_task` 每轮先 `agentask_tick()` 再读 RX
  （即便无数据也能超时）。init 调 `agentask_init`，日志改 stage A5。
- `syscall.h/.c`：新 `SYSCALL_AGENT_ASK=56`。`sys_agent_ask(from_user,q_ptr,out_ptr,
  out_cap,code,timeout_ms)`：`read_user_str` 拷问题（`SYSCALL_AGENT_QMAX=256`），
  `uok` 验出缓冲可写，直接把 **用户 out 指针** 交给 `agent_ask`（拷回在调用方上下文
  跑、CR3 不变，落对页）。OK 回写入字节数，否则回负 `AGENT_ASK_*`（TIMEOUT 时调用方
  上默认）。Ring 3 与内核走同一原语。
- `shell.c`：新 `agentask <question>` 命令（内核 shell 任务直调 `agent_ask`，与 Ring 3
  经 syscall 同路径），argv 重拼成一句（shell 无引号），打印 decision / timeout 默认 /
  槽满 / 非法。help 加一行。
- `tools/agentbus_ask_test.py`（新）：COM1=unix sock（驱动 shell 输命令+读输出）、
  COM2=unix sock（host 扮 agent，后台线程读帧、可答可哑）。四检查全 `[PASS]`：①agent
  答→收到 DECISION_REQ 载荷=问题原文、shell 打 `decision: ALLOW` ②agent 哑→死线 **恰
  3.0s** 触发、shell 打 timeout 默认、`1.0<elapsed<5.0`（真等过、非秒错） ③超时后 shell
  仍活、新 ask 答 `DENY`（槽已释放、内核续跑）。回归：A3/A4 控制面 12 检查仍全绿（双面
  共存于同一 bridge 任务）；COM1 人类 shell 跑 `stattest.elf -> OK` 干净 reap 退 0，无
  FAULT/PANIC；build 绿（Makefile wildcard 自动纳入新 `.c`）。

### 进度：阶段 A6 已闭合（2026-06-11，QEMU 实测 GREEN）
**A6 事件面（OS→agent 单向 push）= 内核第一次主动「告诉」agent 进程生命周期，且永不为它停留。**
- `agentevent.h/.c`（新）：事件面 = OS→agent 单向、fire-and-forget（不进等待表、不等回复，
  agent 不在/不读也无所谓）。难点在**事件源头的上下文**：进程退出/故障在 cli 临界区内、
  reaper 在 `schedule()` 内持锁——这些地方做串口 I/O 不安全。故拆 **生产者/消费者**：
  - 生产者 `agentevent_post(code,pid,aux,info,name)`：O(1)、零分配、关中断短临界区（nest-safe，
    存/复原 RFLAGS，可在已 cli 的退出/故障/创建路径里调），**只入环、不做 I/O**。压紧定长
    记录（按值拷 name，绝不事后回指已释放的 process 槽）。环满则丢弃并计数（fire-and-forget
    丢一条可接受，为保证投递而挂死内核不可接受）。
  - 消费者 `agentevent_drain()`：**只在 agent-bridge 任务**跑，逐条出环（出环在同款短临界区内）
    →每条编码成一个 `EVENT(0x03)` 帧经 COM2 发出（**发送在临界区外**），所有串口 TX 都留在 bridge
    一个任务上。每次调用至多排空一环容量（64），flooding 生产者也困不住 bridge。
  - 事件码 SPAWN/EXIT/FAULT（0x0001/2/3），统一载荷 `[pid:4][aux:4][info:4][namelen:1][name]`，
    三字段按码解释：SPAWN(pid=子,aux=父,info=tid)/EXIT(pid,aux=tid,info=退出码)/
    FAULT(pid,aux=0,info=trap 向量)。事件 seq 高位段 `0x40000000` 避撞 REQUEST/decision seq。
- 挂点（全是「只入环」零 I/O，安全）：`process.c` `process_mark_exited`（EXIT，cli 内）+
  `process_create_from_elf_argv` 与 `process_fork`（SPAWN，task→pid 绑定后 cli 内）；`idt.c`
  故障路径（FAULT，中断已关，在 `process_mark_exited` 前 post，带 trap 向量）。**故障进程同时发
  FAULT(带向量) + EXIT(退出码=128+向量)**——agent 按 pid 关联两条，既知原因又知生命周期终结。
- `agentbus.c`：`agentbus_task` 每轮在 `agentask_tick()` 后调 `agentevent_drain()` 排空事件；
  `agentbus_init` 调 `agentevent_init`；日志改 stage A6。**顺带硬化 `agentbus_send_frame`**：
  它现在有三类跨任务调用方（bridge 的控制响应 + 事件排空、阻塞在 `agent_ask` 的任意任务发
  DECISION_REQ），共享 static `tx_buf`；用短关中断临界区把 encode+写串口序列化（COM2 TX 是
  bounded poll，临界区有限、绝不 wedge；nest-safe，agent_ask 已在自己 cli 段里调它），关掉
  A5 起就潜伏的 tx_buf 撞写窗口。
- `tools/agentbus_event_test.py`（新）：COM1=sock（驱 shell + 后台 `Com1Reader` 持续排空，
  **防 COM1 serial_print 背压**——否则阻塞读 COM2 时正在跑的程序 COM1 输出会卡 bounded poll，
  事件假性迟到）、COM2=sock（`EventCollector` 后台线程收 EVENT 帧）。三检查全 `[PASS]`：
  ①`run /bin/stattest.elf`→收到 SPAWN(name=/bin/stattest.elf)+同 pid EXIT(code=0) ②`run
  /bin/fault.elf`→收到 FAULT(vector=14)+同 pid EXIT(code=142) ③事件推送后 shell 仍答 `echo`
  （fire-and-forget 永不挂死内核）。**实测事件落地 +0.0~0.1s**（bridge 排空即时，先前数秒迟到
  纯属测试未排空 COM1 的背压假象）。回归：A3/A4 控制面 12 检查 + A5 决策面 4 检查全绿（三面
  共存于同一 bridge），COM1 人类 shell 跑 stattest/fault 干净 reap、无 KERNEL PANIC，build 绿
  （Makefile wildcard 自动纳入新 `.c`）。

### 进度：阶段 A7 已闭合（2026-06-11，QEMU 实测 GREEN）
**A7 host 桥 = 第一次有 agent 用 JSON（而非手搓字节）开全三面，host 单一真源就位。**
- `kernel/bridge/`（新，纯 Node stdlib 零依赖——满足松耦合：agent 进程独立于内核运行）：
  - `khy-frame.js`：`agentframe.c` 的纯 JS 移植。导出 `TYPE/HEADER/PAYLOAD_MAX`、
    `crc16`(CRC-16/CCITT-FALSE，KAT "123456789"→0x29b1 已校)、`cobsEncode/cobsDecode`、
    `encodeFrame/decodeFrame`、`class FrameSplitter`(按 0x00 切帧、坏帧丢弃 + 重同步，
    与内核 rx_overflow 同纪律)。
  - `khy-protocol.js`：三面 payload⇄JSON 的**单一真源**，逐字节镜像内核线格
    （control=agentctl.c、event=agentevent.c、码值=agentctl.h/agentevent.h）。请求
    构造器 `statReq/listReq/readReq/writeReq/pathReq/psReq` + 解析器 `splitStatus/
    parseStat/parseListPage/parseReadPage/parseWritten/parsePsPage/parseEvent`。
    翻译集中在此一处，便于对内核审计。
  - `khy-bridge.js`：`class KhyBridge extends EventEmitter`。控制面 async API
    `stat/list/read/write/mkdir/remove/ps`（REQUEST↔RESPONSE 按 seq 关联 + 每请求
    超时，链路卡死也不挂住调用方；list/read/ps 自动翻页）；决策面 `onDecision(fn)`
    （fn 同步/异步均可，回 DECISION_RESP 同 seq；无 handler 或 fn 抛错都发
    defaultDecision，**内核调用方必解阻塞**）；事件面 `on('event', fn)`
    （fire-and-forget，spawn/exit/fault 解析为 JSON）。`rawVerb` 不抛错跑负向用例。
    bridge REQUEST seq 从 1 起，与内核 decision(0x80000000)/event(0x40000000) seq 段
    天然不撞。
  - `index.js`：单入口 `{ KhyBridge, KhyStatusError, frame, protocol }`，供 (a) 内置
    KHY Node agent in-process 调用、(b) 外部 agent(Claude Code) 的 MCP/SDK 薄包装——
    两者共用同一 bridge 实现（需求1），不重复协议逻辑。
- `tools/agentbus_bridge_test.js`（新）：Node e2e，COM1=sock(驱 shell + 后台持续排空
  防背压)、COM2=sock(KhyBridge)。**11/11 全 `[PASS]`**：控制面 list/stat/read/write/
  append/ps + ENOENT 负向（全走 COM2 JSON）；决策面 `agentask may I proceed?`→bridge 见
  问题原文、shell 打 `decision: ALLOW`；事件面 SPAWN(pid=8 name=/bin/stattest.elf)+
  EXIT(code=0)、FAULT(pid=9 vector=14)+配对 EXIT(code=142)；流量后控制面仍响应（liveness）。
- **零内核改动**：A7 全是 host 侧 `kernel/bridge/*.js` + `tools/agentbus_bridge_test.js`，
  内核二进制与 A6 验证版逐字节相同→**构造上零内核回归**；仍重跑 A3/A4(12)+A5(4)+A6(3)
  全绿确认三面共存无回归。

### 进度：阶段 A8 已闭合（2026-06-11，QEMU 实测 GREEN）= 系统内自然语言交互 + 持久化模型配置（需求4）
**A8 闭环：人在系统内用自然语言下令/配模型 → agent 回结构化动作 → 内核执行/持久化 → host 桥读回配置。**
- `agentconf.h/.c`（新）：OS 自有、跨重启的 agent 配置，存于持久 `/disk` 子树的
  `/disk/etc/agent.conf`（`key=value` 行式小文件，整文件改写）。`agentconf_set(key,value)`
  规范键/值（键禁 `=`/空白/换行，值禁换行，长度上限）→确保 `/disk/etc` 存在→读旧文件→
  丢同键旧行+追加新行→`vfs_write_file` 覆写；`agentconf_get(key,out,cap)` 扫行回值。**松耦合**：
  `/disk` 未挂载→返 `AGENTCONF_ENODISK` 诚实降级，绝不 wedge。持久化全走 `/disk` 普通 VFS 调用，
  由 persist.c 钩子镜像到 KhyFS，自动跨重启（无需特判）。
- `agentask.h`：新增决策面 intent 码 `AGENT_INTENT_GENERIC=0x0000`（agentask 是/否裁决）+
  `AGENT_INTENT_NL=0x0001`（`ai` 自然语言命令，agent 回一行结构化动作）。`code` 字段告诉 agent
  如何读问题、回什么形状的答案。
- `shell.c`：新 `ai <自然语言>` 命令——经决策面 `agent_ask(AGENT_INTENT_NL,...)` 把人话发给 agent，
  收回一行结构化动作交 `ai_apply_action` 执行。动作文法刻意极小（智能全在 host agent 侧）：
  `SAY <文本>`（打印 agent 答复，也是无法识别时的兜底，纯散文答复照样工作）/`SET <键> <值…>`
  （`agentconf_set` 落 `/disk/etc/agent.conf`，即配模型）/`GET <键>`（`agentconf_get` 打印配置值）。
  无 agent 在 COM2→超时即诚实报「no agent connected」，shell 绝不挂死。`agentask` 改用具名
  `AGENT_INTENT_GENERIC`（行为不变）。
- `bridge/khy-bridge.js`：新 `readConfig(path='/disk/etc/agent.conf')`——经**控制面**读该文件、解析
  `key=value` 成对象，供 bridge「按配置决定连哪个 agent/模型」（需求4 的「bridge 读它」）。文件缺失
  （未配置/无盘）回 `{}` 不抛错，未配置系统照样连。闭环：人话配置由内核落盘→bridge 经控制面读回。
- `tools/agentbus_nl_test.js`（新）：Node e2e，QEMU 带 `-hda` 全新零盘（KhyFS 首挂自格式化）+COM1 sock
  （驱 shell）+COM2 sock（KhyBridge，规则版 agent：NL→动作，generic→ALLOW）。**10/10 全 `[PASS]`**：
  /disk 持久挂载；`ai use model claude-opus`→shell 打 `[ai] set model = claude-opus` 且
  `bridge.readConfig()` 经控制面读回 `model=claude-opus`；`ai which model`→`GET model`→打回值；
  `ai set endpoint ...`→整文件改写保留首键、两键并存；`ai hello`→SAY 散文答复；`/disk/etc/agent.conf`
  实为 54B 文件含两 `key=value` 行；**回归** generic agentask 仍 `decision: ALLOW`；流量后控制面仍响应。
- **跨重启实证**：另跑两次启动复用同一盘——boot1 用自然语言写 model，boot2 不重写 `readConfig()` 仍
  得 `{model:'claude-opus'}` → 配置真落盘跨重启（非仅内存）。
- **回归**：内核此轮有改动（shell.c+新 agentconf.c+agentask.h），仍重跑 A3/A4(12)+A5(4)+A6(3)+A7(11)
  全绿，三面+NL 共存零回归，build 绿（Makefile wildcard 自动纳入 agentconf.c）。

## 3. 剩余真实 OS 缺口候选（背景，非当前优先）

ELF 动态加载/共享库、真实文件系统互操作（ext2 读）、硬链接（多 name 共享
inode 引用计数，需拆 vfs_node→dentry+inode）、目录 rename（子树重持久化，需
persist 多 key 重写）、共享 open file description（dup/dup2 当前各自 offset
拷贝非共享，真 POSIX 需独立 OFD 层带引用计数）。
（时间戳跨重启持久化已由阶段30 闭合。）

## 4. 工程约束（AGENTS.md 硬约束，勿违反）
- 零硬编码；状态诚实（干净杀进程打 `[FAULT]` 不得打 `KERNEL PANIC`）；活跃度重置超时。
- 不主动 commit/push。
- 新增 userland 程序：写 `.asm` → `bash tools_gen_blob.sh <name>` → 接 `ramfs.c`
  （#include + vfs_write_file）+ `Makefile`（USERLAND_PROGS + ramfs.o 依赖行）→
  make → QEMU 验证。
- 测试命令模式：
  `(sleep 8; printf 'run /bin/X.elf\n'; sleep 4) | timeout 20 qemu-system-x86_64 -cdrom build/khy-os-kernel.iso -serial stdio -display none -no-reboot`
