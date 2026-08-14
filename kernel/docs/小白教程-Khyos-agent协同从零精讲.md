# KHY-OS 小白精讲：从零看懂「一个会跟 AI 协同的操作系统」

> 适用对象：没写过操作系统、甚至没用过 QEMU 的初学者。
> 目标：读完你能**讲清楚** KHY-OS 这次「agent⇄OS 协同」是怎么一步步搭起来的，
> 知道每个文件在干嘛，并能**亲手把它跑起来**。
> 记录日期：2026-06-11。配套权威文档见同目录
> `架构-agent-os双向协议.md`（架构）与 `进度交接-内核与agent协同pivot.md`（进度台账）。

---

## 0. 先讲人话：这次到底做了一件什么事？

一句话：**让一个我们自己用 C 写的操作系统（KHY-OS），能和 AI（agent）双向对话。**

- AI 能反过来操作这个系统：列目录、读写文件、看进程（**agent → OS**）。
- 系统内部遇到要不要放行某个动作时，能**主动问 AI**：「我能删这个吗？」AI 回答
  ALLOW / DENY（**OS → agent**）。
- 你在系统里能用**自然语言**下命令、配模型：在系统的命令行敲
  `ai 帮我把模型换成 claude`，AI 把它翻译成系统能执行的动作。

而且这个 AI 既可以是**我们内置的一个 Node 小程序**，也可以是**外面的 Claude Code**
——两者接的是同一套通道，不重复造轮子。

如果这几句你现在还不完全懂，没关系，下面从最基础的名词开始补。

---

## 1. 预备知识速成（用生活类比，5 分钟）

| 名词 | 一句话解释 | 生活类比 |
|---|---|---|
| **操作系统 / 内核（kernel）** | 管理硬件、跑程序、分配内存的最底层软件 | 一栋楼的「物业总控室」 |
| **用户态 / 内核态** | 普通程序跑在「用户态」权限低；内核跑在「内核态」权限高 | 租客（用户态）vs 物业（内核态） |
| **系统调用（syscall）** | 用户程序请内核帮忙做高权限事的「窗口」 | 租客去物业前台填单子办事 |
| **串口（serial port，COM1/COM2）** | 一根最古老最简单的「数据线」，一次走一个字节 | 两个铁皮罐子之间的一根线电话 |
| **QEMU** | 在你电脑上「假装」一台真电脑，用来跑 KHY-OS | 飞行模拟器 |
| **帧（frame）/ 协议（protocol）** | 把一段数据打包成「有头有尾、能校验」的格式，双方约定怎么读 | 寄快递时的标准包裹（面单+封口+内容） |
| **CRC 校验** | 一串数字，用来检查数据传输有没有出错 | 包裹上的防伪码，对不上就说明被动过 |
| **COBS 编码** | 一种「让 0x00 字节专门当分隔符」的打包技巧 | 用特定符号当「句号」切分句子 |
| **agent** | 能自己思考、调用工具完成任务的 AI 程序 | 一个会用工具的智能助理 |
| **MCP** | 一套「让外部 AI 安全调用你工具」的标准协议 | 给助理发的一本「你能用哪些工具」的说明书 |
| **AI 网关（gateway）** | 项目里一个统一转发大模型请求的服务 | 公司前台总机，帮你转接各部门 |

> 只要记住：**串口 = 一根能传字节的线；帧 = 字节的标准打包格式；syscall = 程序求内核办事的窗口**，
> 后面就都能跟上了。

---

## 2. 总目标与「四点硬需求」（为什么这么设计）

用户最初提了一个大方向：**「做一个能和 agent 深度协同的 OS」**（不然单独造个系统意义不大）。
落到具体，澄清出四条**硬需求**（贯穿始终，是所有设计的「考试大纲」）：

1. **两者都要能接**：内置的 KHY Node agent + 外部 agent（如 Claude Code）都要能连上。
2. **双向**：不只是 agent 操作 OS，OS 内部也要能反过来问 agent 求决策。
3. **宿主但松耦合**：OS 能托管 agent，但 agent 不能「死死依赖」OS——它**也得能独立跑**。
4. **系统内自然语言配置**：在系统里能用自然语言配模型、跟系统交互。

记住这四条，下面每个阶段你都可以自问「它在满足哪一条」。

---

## 3. 整体架构：一张图看懂

```
   ┌──────────────────── KHY-OS（跑在 QEMU 里）─────────────────────┐
   │                                                                │
   │   COM1 串口  ── 人类用：你敲命令的那个黑框终端                  │
   │   COM2 串口  ── agent 专用：物理隔离，专门给 AI 走             │
   │        │                                                       │
   │   内核里三个「面」（plane）：                                   │
   │     ① 控制面  agent→OS：列目录/读写文件/看进程                  │
   │     ② 决策面  OS→agent：内核问「我能做X吗？」等 AI 回答         │
   │     ③ 事件面  OS→agent：内核单向广播「有进程启动/退出/崩了」    │
   └───────────────────────────┬────────────────────────────────────┘
                               │ COM2 = 一根 unix socket（/tmp/khy-agent.sock）
                               │ 走的是「定长二进制帧」（COBS+CRC16）
        ┌──────────────────────┴───────────────────────┐
        │           host 桥 kernel/bridge/（Node）        │
        │  把二进制帧 ⇄ JSON 翻译，复杂度全放在这一侧     │
        └──────────────────────┬───────────────────────┘
            ┌──────────────────┴──────────────────┐
   内置 agent（side a）                     外部 agent（side b）
   khy-agent.js / khy-agent-run.js          khy-mcp.js（MCP server）
   in-process 直接调工具                     Claude Code 经 MCP 调工具
```

**三个关键设计抉择，初学者要理解「为什么」：**

1. **为什么选 COM2 串口当通道？**
   COM1 已经被人类终端占用了。COM2 是另一根独立的线，**物理隔离、零争用、不用写新驱动**。
   对初学者：串口是最简单的传输方式，先用最笨最稳的，别一上来上网卡。

2. **为什么内核只发「二进制帧」，JSON 翻译放到 host（Node）？**
   内核里写 JSON 解析又难又危险（容易越界崩溃）。所以**内核侧只做极简的定长二进制**，
   把「翻译成人类友好的 JSON」这种复杂活交给电脑这侧的 Node 程序。**复杂度放强侧**。

3. **为什么分「三个面」？**
   因为三种通信方向/语义完全不同：agent 主动操作 OS（控制面）、OS 主动问 agent（决策面）、
   OS 单向广播事件（事件面）。分开后每个面逻辑清晰、互不打架。

---

## 4. 帧格式：双方约定的「包裹规格」

所有走 COM2 的数据都打包成这个格式（这是 agent 和 OS 之间的「普通话」）：

```
[type:1][seq:4][code:2][len:2][payload:len 字节][crc16:2]
   │      │      │      │         │                 └ 校验码，防传错
   │      │      │      │         └ 真正的内容（最多 1024 字节）
   │      │      │      └ 内容长度
   │      │      └ 操作码（比如「列目录」「读文件」）
   │      └ 序号（请求和回复靠它配对，像快递单号）
   └ 类型：① REQUEST 请求 ② RESPONSE 回复 ③ EVENT 事件
          ④ DECISION_REQ 求决策 ⑤ DECISION_RESP 决策回复
```

打包后再用 **COBS 编码**，并在末尾加一个 `0x00` 当「句号」——这样接收方靠 `0x00`
就能把一帧帧切开。**CRC16** 校验码用来确认这一帧没传错（业界标准 CCITT-FALSE，
用 "123456789" 测出来应等于 `0x29b1`，对上才算实现正确）。

> 初学者收获：**任何两个程序要可靠通信，都要先定一个「帧格式」**：怎么知道一帧从哪开始、
> 到哪结束、有没有传错、是请求还是回复。KHY-OS 这套是教科书式的最小实现。

---

## 5. 八个阶段，一步步搭（A1 → A8）

整个工程用「**小步快跑、每步都验证**」的纪律推进。每个阶段的套路都是：
**设计 → 写代码 → 编译通过 → 在 QEMU 里真跑测试 → 回归之前所有阶段 → 更新台账**。
这套纪律本身就值得初学者学习：**永远保持「随时可工作」的状态，绝不一次写一大坨**。

下面每个阶段我都按「**要解决什么 / 怎么做 / 关键文件 / 怎么验证 / 学到什么**」讲。

### A1 — 先把「线」通了（物理通道）
- **要解决**：让内核能从 COM2 收发字节，且**没人连的时候内核照常跑**（松耦合，需求3）。
- **怎么做**：把串口 I/O 按端口参数化，新增 COM2 的原语（init/读/写）。内核起一个
  `agent-bridge` 后台任务，先做最笨的「**收到啥原样发回（echo）**」。
- **关键文件**：`serial.c/.h`、`agentbus.c/.h`、`main.c`、`Makefile`(新增 `run-agent` 目标)。
- **验证**：`tools/agentbus_echo_test.py` 连上 COM2 发一句话，校验原样回来。
- **学到**：先打通最底层最笨的一条路，再往上加聪明逻辑。**poll（轮询）必须有上限**，
  否则一个外设卡住会拖垮整个内核（贯穿全程的硬纪律）。

### A2 — 给字节流套上「帧」（结构化）
- **要解决**：光会发裸字节不够，要能识别「一帧从哪到哪、有没有传错」。
- **怎么做**：实现纯编解码模块——CRC16 + COBS + 帧的打包/解包。`agentbus` 的 echo
  从「字节级」升级成「**帧级**」：收到一整帧、校验通过、再原样回一帧。
- **关键文件**：`agentframe.c/.h`（纯编解码，不碰 I/O，方便单独测试）。
- **验证**：`tools/agentbus_frame_test.py`——好帧能回、坏 CRC 被丢弃、垃圾字节后能重新同步。
- **学到**：**把「纯逻辑」和「I/O」分开**，纯逻辑能脱离硬件单测，是工程上的好习惯。

### A3 — 让 agent 第一次「看见」OS 的文件（控制面·只读）
- **要解决**：agent 能 STAT（看属性）/ LIST（列目录）/ READ（读文件）。
- **怎么做**：新增控制面模块，把三个只读操作码直接接到内核已有的 `vfs_*` 文件系统函数。
  大目录/大文件**自动翻页**，避免一帧塞不下。
- **关键文件**：`agentctl.c/.h`。
- **验证**：`tools/agentbus_ctl_test.py`——读 `/etc/motd` 内容对、列根目录、列 `/bin` 翻页、
  读不存在的文件回 ENOENT。
- **学到**：**复用已有能力**（VFS），别重写。错误要**如实**返回错误码，不能假装成功。

### A4 — 让 agent 能安全地「改」OS（控制面·写 + 看进程）
- **要解决**：WRITE / MKDIR / REMOVE / PS（进程列表），但**不能让 agent 乱来**。
- **怎么做**：加四个写操作码；关键是加**越权守卫**：禁止动 `/bin`（内核内嵌程序区），
  路径先规范化再判断，防止用 `..` 逃逸。越权一律回 EPERM。
- **关键文件**：`agentctl.c/.h`（在 A3 基础上扩展）。
- **验证**：`tools/agentbus_ctl_test.py` 扩到 12 项——写读往返、追加、建目录、删文件、
  `/bin` 写/建/删/逃逸全部 EPERM。
- **学到**：**给权力加边界**。任何「能改东西」的接口，第一件事是想「怎么防滥用」。

### A5 — 反过来：OS 主动问 agent（决策面，需求2 的核心）
- **要解决**：内核内部想问 agent「我能做这个吗」，**而且 agent 不在/不答时内核绝不能卡死**。
- **怎么做**：新增系统调用 `SYSCALL_AGENT_ASK=56` 和一张「等待表」。内核发出
  DECISION_REQ 帧后**阻塞等回复**，但带**超时兜底**（约 3 秒）——超时就用默认答案继续，
  绝不永久挂起。这里精确复刻了内核 IPC 的「防丢唤醒」临界区写法。
- **关键文件**：`agentask.c/.h`、`syscall.c/.h`、`shell.c`(新增 `agentask` 命令)。
- **验证**：`tools/agentbus_ask_test.py`——agent 答就拿到答案；agent 装哑，**恰好 3 秒**超时
  并恢复，内核照常跑；超时后还能再问。
- **学到**：**「等外部系统」永远要设超时**。松耦合的底线 = 对方挂了，你也不能跟着挂。

### A6 — OS 单向广播「发生了什么」（事件面）
- **要解决**：进程启动 / 退出 / 崩溃时，主动 push 给 agent，且**绝不为发事件而卡住内核**。
- **怎么做**：拆「生产者/消费者」——事件源（在关中断的临界区里）只把事件**塞进环形队列**
  （O(1)、零 I/O、按值拷贝名字）；真正发串口由 `agent-bridge` 任务在临界区外排空。
  队列满了就**丢弃 + 计数**（丢一条可接受，挂死内核不可接受）。
- **关键文件**：`agentevent.c/.h`；挂点在 `process.c`（启动/退出）、`idt.c`（故障）。
- **验证**：`tools/agentbus_event_test.py`——跑个程序看到 SPAWN+EXIT；故意触发缺页看到
  FAULT(向量14)+配对 EXIT；推送后 shell 仍然能答（fire-and-forget 不阻塞）。
- **学到**：**在中断/锁里绝不做慢操作（如 I/O）**，只入队，慢活留给普通任务。这是内核编程铁律。

### A7 — host 桥：把二进制翻译成 JSON（agent 终于「好用」了）
- **要解决**：让 agent 用人类友好的 JSON 操作三个面，而不是手搓二进制。
- **怎么做**：在 `kernel/bridge/`（**纯 Node 标准库、零第三方依赖**，因为要松耦合、能独立跑）
  写桥：`khy-frame.js`（帧编解码，移植自 C）+ `khy-protocol.js`（三面 payload ⇄ JSON 的
  **单一真源**）+ `khy-bridge.js`（`KhyBridge` 类，三面 API）+ `index.js`（统一入口）。
- **关键文件**：`kernel/bridge/khy-frame.js / khy-protocol.js / khy-bridge.js / index.js`。
- **验证**：`tools/agentbus_bridge_test.js` 11 项全绿，全程用 JSON 开三面。
- **学到**：**单一真源**（协议只在一处定义）避免内核和 host 两边对不上。**零依赖** = 真正能独立部署。

### A8 — 在系统里用自然语言配置（需求4）
- **要解决**：在 OS 里敲 `ai 把模型换成 claude`，系统执行并**把配置持久化**（重启不丢）。
- **怎么做**：内核新增配置文件 API，把 `key=value` 存到 `/disk/etc/agent.conf`（走磁盘，
  跨重启）；shell 新增 `ai <自然语言>` 命令，经决策面发给 agent，agent 回一行**结构化动作**：
  - `SET <键> <值>`：写配置（如换模型）
  - `GET <键>`：读配置
  - `SAY <文本>`：单纯回话
  内核解析这一行并执行。**「智能」全在 host agent 里，内核的解析器极简**。
- **关键文件**：`agentconf.c/.h`、`shell.c`、`bridge/khy-bridge.js`(新增 `readConfig`)。
- **验证**：`tools/agentbus_nl_test.js` 10 项全绿，外加**跨重启实证**（开机1写模型，开机2读还在）。
- **学到**：**把复杂判断交给 AI，内核只认几个固定指令**——既安全又灵活。配置走磁盘才能持久。

### A7b — 双 agent 实接（需求1，整条路线的收尾）
- **要解决**：内置 agent（in-process）和外部 agent（Claude Code 经 MCP）都能连，且**共用同一套桥**。
- **怎么做**：
  - `khy-tools.js`：OS 能力面的**单一真源**——8 个工具描述符（list/stat/read/write/mkdir/
    remove/ps/get_config），每个 handler 只调一个 `KhyBridge` 方法。
  - `khy-agent.js`：内置 agent，`brain`（大脑）**可注入**，默认是纯规则脑。
  - `khy-mcp.js`：把这 8 个工具用 **MCP 协议**（手写纯 Node，无 SDK）暴露给外部 agent。
- **关键文件**：`kernel/bridge/khy-tools.js / khy-agent.js / khy-mcp.js`。
- **验证**：`tools/agentbus_dualagent_test.js` 12 项全绿——Phase1 内置 agent 直接调工具；
  Phase2 spawn 出 MCP 子进程走真 JSON-RPC，**读到 Phase1 内置 agent 写的同一份配置**
  （证明两个 agent 操作的是同一个 OS、同一个桥）。
- **学到**：**一份能力定义，两种接入方式**。这就是「不重复造轮子」的工程范式。

> 到这里，**八阶段 A1–A8 全部闭合**，四点硬需求全部满足。

---

## 6. 两个增强：让它「真的能用」

路线图跑通后，又补了两件让它从「演示」变「实用」的事：

### 增强① 内置大脑接「真模型」
之前内置 agent 的「大脑」是写死的规则（碰到 delete 就 DENY）。增强后可以接**项目的 AI 网关**，
让真大模型来判断。
- `khy-brain-gateway.js`：`makeGatewayBrain()` 返回一个「大脑」函数，用纯 Node 标准库
  POST 网关的 OpenAI 兼容接口 `/v1/chat/completions`，把模型回答**整形**成内核要的格式
  （决策面 → `ALLOW/DENY`；自然语言 → `SET/GET/SAY`）。
- **松耦合硬保证**：网关挂了/超时/没 token，**自动降级回规则脑**，内核永远拿得到答案、永不卡死。
- `khy-agent-run.js`：一个可直接运行的启动器，把内置 agent + 真模型大脑挂到活内核上。
- 验证：`tools/agentbus_gateway_brain_test.js` **8/8 全绿**（用一个假网关替身做隔离测试，
  其余全真），还验证了「**杀掉网关后系统仍能回答**」的优雅降级。

### 增强② 把 KHY-OS 接进 Claude Code（真外部联调）
- `khy-mcp.js` 增加「**有界等待 socket**」：你先开 Claude Code 再启动 KHY-OS 也能自动挂上。
- 仓库根新增 `.mcp.json`：Claude Code 在仓库根就能发现名为 `khy-os` 的 MCP server。
- `kernel/bridge/README-联调.md`：两条路线的实战手册。
- 效果：在 Claude Code 里可以直接让它 `khy_list` / `khy_read` / `khy_write` **真实操作 KHY-OS 的文件**。

---

## 7. 亲手跑一遍（Hands-on）

> 前提：装好 `qemu-system-x86_64`、`node`、`python3`、`grub-mkrescue` 等构建工具（Linux 环境）。

### 7.1 编译并跑单元测试
```bash
cd kernel
make                                 # 编译出 build/khy-os-kernel.iso

# 跑各阶段验证（看到一堆 [PASS] 就对了）
python3 tools/agentbus_echo_test.py      # A1 通道
python3 tools/agentbus_frame_test.py     # A2 帧
python3 tools/agentbus_ctl_test.py       # A3/A4 控制面
python3 tools/agentbus_ask_test.py       # A5 决策面
python3 tools/agentbus_event_test.py     # A6 事件面
node    tools/agentbus_bridge_test.js    # A7 host 桥
node    tools/agentbus_nl_test.js        # A8 自然语言配置
node    tools/agentbus_dualagent_test.js # A7b 双 agent
node    tools/agentbus_gateway_brain_test.js # 增强① 真模型大脑
```

### 7.2 手动开机，自己敲命令玩
```bash
make -C kernel run-agent             # COM1 给你（stdio），COM2 = /tmp/khy-agent.sock
```
在出现的 `khy>` 提示符里试：
```
ls /                                 # 列根目录
agentask 我可以继续吗                 # 问 agent 决策（需另一侧有 agent 连 COM2）
ai 把模型换成 claude-opus            # 自然语言配模型（需挂 -hda 磁盘才能持久化）
```

### 7.3 路线 A：让内置 agent + 真模型来回答
```bash
# 终端1：先把项目 AI 网关跑起来（默认 127.0.0.1:9100）
# 终端2：
make -C kernel run-agent
# 终端3：把内置 agent 挂上去（大脑 = 真网关）
node kernel/bridge/khy-agent-run.js
# 然后在终端2的 khy> 里敲 ai / agentask，回答就来自真模型了
```

### 7.4 路线 B：让 Claude Code 操作 KHY-OS
```bash
make -C kernel run-agent             # 先开 OS（COM2 = /tmp/khy-agent.sock）
# 在仓库根打开 Claude Code，/mcp 里批准 khy-os 这个 server
# 然后让 Claude：「列出 KHY-OS 根目录并读 /etc/motd」
```

---

## 8. 贯穿全程的「工程纪律」（最值得抄走的部分）

这套项目最有价值的不是某个具体功能，而是**自始至终遵守的纪律**。初学者请重点记：

1. **外设/轮询绝不无限等**：所有 poll 都有上限，绝不让一个卡住的设备拖垮整个内核。
2. **松耦合 = 对方挂了你不挂**：决策面有超时兜底；host 桥零依赖；大脑接不上就降级。
3. **状态诚实**：错误如实返回错误码；进程被干净杀掉显示 `[FAULT]` 而不是假装 `KERNEL PANIC`。
4. **零硬编码**：端口、超时、路径都能用环境变量配，不写死。
5. **复杂度放强侧**：内核只做最简单的二进制；JSON、智能判断都放 host/agent 侧。
6. **单一真源**：协议、工具定义只在一处声明，避免两边对不上。
7. **小步快跑 + 每步验证 + 回归**：永远保持「随时可工作」，新功能不破坏旧功能。
8. **在中断/锁里只做快操作**：慢活（I/O）丢队列，留给普通任务排空。

---

## 9. 目录地图：想看代码去哪找

```
kernel/
├── src/
│   ├── serial.c/.h        # 串口底层（COM1 人类 / COM2 agent）
│   ├── agentbus.c/.h      # COM2 总线：收发帧、分发到三个面
│   ├── agentframe.c/.h    # 帧编解码：CRC16 + COBS（纯逻辑，无 I/O）
│   ├── agentctl.c/.h      # 控制面：STAT/LIST/READ/WRITE/MKDIR/REMOVE/PS + 越权守卫
│   ├── agentask.c/.h      # 决策面：OS→agent 求决策 + 等待表 + 超时兜底
│   ├── agentevent.c/.h    # 事件面：SPAWN/EXIT/FAULT 单向 push（生产者/消费者）
│   ├── agentconf.c/.h     # 配置文件 /disk/etc/agent.conf 读写（跨重启）
│   ├── shell.c            # 内核 shell：agentask / ai 命令在这
│   ├── syscall.c/.h       # 系统调用表（SYSCALL_AGENT_ASK=56 在这）
│   └── main.c             # 内核入口：初始化各模块、起 agent-bridge 任务
├── bridge/                # host 桥（纯 Node 标准库，零依赖）
│   ├── khy-frame.js       # 帧编解码（C 的 JS 版）
│   ├── khy-protocol.js    # 三面 payload ⇄ JSON（单一真源）
│   ├── khy-bridge.js      # KhyBridge 类：三面 API + readConfig
│   ├── khy-tools.js       # OS 能力面：8 个工具描述符（单一真源）
│   ├── khy-agent.js       # 内置 agent（大脑可注入）
│   ├── khy-brain-gateway.js # 真模型大脑（接 AI 网关，失败降级）
│   ├── khy-agent-run.js   # 内置 agent 启动器
│   ├── khy-mcp.js         # MCP server：把工具暴露给外部 agent（Claude Code）
│   └── index.js           # 统一入口
├── tools/                 # 各阶段端到端测试（*.py / *.js）
└── docs/
    ├── 架构-agent-os双向协议.md         # 架构权威文档
    ├── 进度交接-内核与agent协同pivot.md  # 进度台账（每阶段更新）
    └── 小白教程-Khyos-agent协同从零精讲.md  # 本文
.mcp.json                  # 仓库根：Claude Code 的 MCP server 声明
```

阅读建议路径（由浅入深）：
`serial.c` → `agentframe.c` → `agentctl.c` → `agentask.c` → `agentevent.c`
→ `bridge/khy-bridge.js` → `bridge/khy-agent.js` → `bridge/khy-mcp.js`。

---

## 10. 名词速查表（Glossary）

- **plane（面）**：一类通信语义。控制面 = agent 操作 OS；决策面 = OS 问 agent；事件面 = OS 广播。
- **seq（序号）**：请求和回复配对用。内核决策面从 `0x80000000` 起、事件面从 `0x40000000` 起，
  与 host 请求（从 1 起）天然不撞。
- **payload**：帧里真正的数据内容。
- **VFS**：内核的虚拟文件系统层，`vfs_*` 一族函数。
- **EPERM / ENOENT / EEXIST**：错误码——没权限 / 不存在 / 已存在。
- **brain（大脑）**：agent 把「问题」变成「答案」的那个函数，可注入（规则脑或真模型脑）。
- **in-process**：在同一个程序进程内直接调用（内置 agent 用），相对「跨进程/网络」更快更简单。
- **MCP（Model Context Protocol）**：让外部 AI 安全调用工具的标准协议，走 JSON-RPC over stdio。
- **fire-and-forget**：发出去就不管了，不等回复（事件面就是这样）。

---

## 11. 给初学者的练习与进阶方向

**练习（动手验证你懂了）：**
1. 在 `khy-tools.js` 里加一个新工具 `khy_echo`（输入一段文字，原样返回），跑通 MCP。
2. 把 A5 的决策超时从 3 秒改成 5 秒，观察 `agentask` 测试里超时那项的耗时变化。
3. 给 `agentconf` 增加一个新配置项（如 `temperature`），用 `ai set temperature 0.7` 写进去。

**进阶方向（这个项目接下来能往哪走）：**
- 给 `khy-brain-gateway` 接真账号，得到真正的大模型决策。
- 把 `khy-mcp` 真接进一次 Claude Code 会话，让它真实地改 KHY-OS 文件。
- 内核侧：真实块设备持久化、真实 stdin 键盘等（见 `进度交接` 文档的「剩余缺口候选」）。

---

### 结语
KHY-OS 这次「agent⇄OS 协同」从一根串口的 echo（A1）一路搭到「内置/外部双 agent + 真模型 +
自然语言配置」（A8 / A7b / 增强），全程**小步、可验证、松耦合、状态诚实**。
你不需要一开始就懂全部——照着第 7 节跑一遍，再对着第 9 节的地图读代码，
这套「会跟 AI 协同的操作系统」就会在你脑子里活起来。
