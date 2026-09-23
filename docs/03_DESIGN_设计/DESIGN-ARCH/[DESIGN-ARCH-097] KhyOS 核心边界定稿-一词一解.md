# [DESIGN-ARCH-097] KhyOS 核心边界定稿 —— 一词一解

> **定位**：把散落各处的核心定义收成一张可查表。回答「KhyOS 的核心到底是哪几块、每块一句话」。
> **上位法**：三件套（壳/漏斗/网关）契约见 [DESIGN-TOOL-002] §1.1，六类拓展见 §1.2，任务闭环契约见 [DESIGN-ARCH-077]；本文只做「一词一解」的收口，不重述契约。
> **判据**：运行核用 [DESIGN-TOOL-002] §1.1 的删除判据——「删掉它，还能启动并跑通一次工具调用吗？」不能 → 核。主张核的判据——删掉它系统仍能跑（fail-soft），但「稳定交付的 AI 平台操作系统」这一产品主张塌掉一角。

---

## 核心一词一解（七核，两层）

### 运行核（删掉即无法启动或无法完成一次工具调用）

**壳**：承载启动、REPL/TUI 与命令路由的运行时底座。
**漏斗**：所有工具调用的唯一出口，权限与沙箱的裁决边界。
**网关**：统一多供应商模型路由、密钥池与协议转换。
**智能体**：驱动模型自主调用工具的循环引擎与 27 个内置智能体。

### 主张核（删掉系统仍能跑，但产品主张塌掉一角）

**工作流**：登记→执行→裁决→交付→台账的任务收尾循环，20 道质量门把关。
**记忆**：会话续接、向量召回与 RAG 注入的跨回合连续性设施。
**拓展契约**：`khy.extension.json` 一套机制承载 tool/plugin/scripts/mcp/software/协议六类拓展。

## 证据锚点

| 核 | 关键落点 | 验证方式 |
| --- | --- | --- |
| 壳 | `platform/khy_platform/` + `src/cli/`（router/aliases/repl + tui/） | `khy doctor` 实测命令链通 |
| 漏斗 | `src/services/tool*`（toolSpec/toolCalling/permissionBroker/toolSandbox/shellSafetyValidator 等 30+ 文件） | doctor 实测 203 工具注册 |
| 网关 | `src/services/gateway/`（adapters/ 50+ 文件）+ `services/ai-backend/` | doctor 实测 api:agnes 通道 |
| 智能体 | `toolUseLoopCore.js`（11,557 行）+ `agenticHarnessService.js` + `src/agents/built-in/`（27 个） | 循环契约 [DESIGN-ARCH-077] + doctor 清点 |
| 工作流 | `taskClosure.js` + `backgroundTaskManager.js`（咽喉）+ `deliveryLedger.js`（台账）+ `taskboard.db` | 台账实文件验证；20 门 env 默认全开 |
| 记忆 | `domain/memory/memoryEngine/`（vectorRecall/vectorStore/distiller）+ `memoryBridge.js` + `ragRetrievalService.js` | vectorRecall 实文件验证（走网关 embedding、侧车落盘、词法降级） |
| 拓展契约 | `domain/extensions/` + `extensionRoots.js` + 磁盘 10 个 `khy.extension.json` | 069 §1.7 登记比对（10/15–25 已落） |

## 与「五核」提法的对应

智能体 → 智能体；操作系统 → 壳 + 漏斗（产品定位词由这两个核共同兑现）；网关 → 网关；工作流 → 工作流；拓展契约 → 拓展契约。调研新增：**记忆**（memoryEngine 向量召回 + RAG 是真实深度子系统，非装饰件）；**漏斗**从「操作系统」中复立（069 §1.1：它是安全边界，拓展穿过漏斗、不得绕过——与壳不可合并）。

## 定位裁决（非核心）

- **技能 / MCP**：不单列核心——[DESIGN-TOOL-002] §1.2 明确 tool/plugin/scripts/mcp/software/协议是同一套拓展机制下的六类实现，归入拓展契约。
- **内核**（`kernel/`）：不占核心席位——「操作系统」定位的实验分支：零 build 产物、零 ISO、零启动日志，CI `continue-on-error`，README 自评「教学/实验/爱好级」。
- **khyquant**（`software/khyquant/`）：不属核心——内置默认示例应用：无独立 `package.json`/`bin`，靠构建期拷贝 `services/backend` 才能运行。
- **前端 / 桌面端**（`apps/ai-frontend`、khyquant frontend、desktop）：应用层，经 Web API/bridge 消费核心，不属核心。

## 完成度总览

运行核四项 + 主张核的工作流、记忆共 **6 项已完成**（doctor 实测或实文件验证）；**拓展契约进行中**（10/15–25 能力域 manifest 已落，khy-quant Phase 1、khy-eyes、khy-web-admin、khy-ai-frontend、khy-protocol-* 仍待迁）。

## 变更记录

- 2026-09-14：初版。「壳+漏斗+网关+闭环」已完成核心与「内核/khyquant/拓展契约」未完成核心各一词一解。
- 2026-09-14：修订。核心重定为五核（智能体/操作系统/网关/工作流/拓展契约）：壳与漏斗并入操作系统，闭环更名工作流。
- 2026-09-14：调研定稿。实证核查后定为**七核两层**：运行核（壳/漏斗/网关/智能体）+ 主张核（工作流/记忆/拓展契约）——漏斗从操作系统复立（069 安全边界），记忆入核（memoryEngine 实证），技能与 MCP 裁决为拓展契约下的六类拓展实现而非独立核心。
