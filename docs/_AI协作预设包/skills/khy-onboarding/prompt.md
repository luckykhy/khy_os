# Khy-OS 接手速成（开工前必读）

你现在要为 **Khy-OS** 做开发或修改。本 skill 让你一次读懂全局。读完不要立刻改文件，等具体任务。

## 一、这是什么项目

Khy-OS = 自研 x86_64 C 内核 + Node.js AI 后端 + host 桥(agent⇄OS) + Python(pip) 启动器。

- **内核**：`kernel/`（C + 少量 MoonBit + 汇编），QEMU 可启动。
- **AI 后端**：`services/backend/`（业务主体在此，Node.js），命令名 `khy`，是 CLI/TUI 跨模型助手。
- **分发**：pip 包名 `khy-os`，pip 启动器是薄壳，真正跑的是 Node 后端。

**两条现实约束（决定一切取舍）：**
1. **pip 是唯一分发渠道**。改动最终要能打成 wheel 发布；pip 包是打包时的源码快照，改了仓库源码必须重新打包才对已安装用户生效。
2. **项目要能被"一个人、甚至非工程师、没有强 AI"继续维护**。所以：**稳定 > 可回退 > 守卫可拦 > 炫技**。

## 二、我要改 X 去哪

- CLI 命令/路由：`services/backend/src/cli/router.js`（大 switch）→ `handlers/`
- AI 网关/模型路由：`services/backend/src/services/gateway/aiGateway.js` → `modelRouter.js`
- 本地离线能力（算/文本/找文件/上下文）：`services/backend/src/services/localBrain*.js`
- 工具调用主循环：`services/backend/src/services/toolUseLoop.js`
- **唯一工具执行漏斗**：`services/backend/src/services/toolCalling.js` 的 `executeTool()`
- 前端：`apps/ai-frontend/`
- pip 启动：`platform/khy_platform/cli.py`
- **先读的地图与红线**：`.ai/MAP.md`、`.ai/GUARDS.md`、`.ai/GUARDS-AI.md`、`.ai/CONTEXT.yaml`

## 三、绝不能做的红线（先记住）

- ❌ 不绕过 `executeTool` 另开工具执行旁路（会绕过权限门控与审批）。
- ❌ 不为同一概念建第二份"真源"（约束格/能力向量/错误分类/破坏性动作模式库各有唯一权威实现，见 `.ai/GUARDS-AI.md §2`）。
- ❌ 单文件不超 **2500 行**。
- ❌ 没接到三真实入口（`executeTool` / `toolUseLoop.js` / `aiManagementServer.js`）之一，就不许声称"已落地/已接入"——隔离单测全绿 ≠ 在产。
- ❌ 不用 `--no-verify` 跳过守卫。

## 四、改代码只有一种正确姿势

**加法式改动 + 纯叶子模块 + 默认开的 `KHY_*` 门控 + 关闭即逐字节回退。**
细节激活 `/khy-safe-change`。

## 五、语言与协作

- 交流与文档用**中文**；代码标识符/字符串字面量用**英文**。
- 每步动手前先说：要改哪个文件、加哪个 `KHY_` 门控、关掉后怎么逐字节回退——用户确认后再动手。
- 每轮最多问一个澄清问题，且先给出你能给的答案再问。

## 下一步

- 要改代码 → 激活 `/khy-safe-change`
- 出错了 → 激活 `/khy-troubleshoot`
- 不知道做什么 → 激活 `/khy-pick-task`
- 做完了 → 激活 `/khy-honest-closure`

现在确认你已读懂全局，等待用户的具体任务。
