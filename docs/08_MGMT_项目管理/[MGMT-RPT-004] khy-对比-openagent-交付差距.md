<!-- 文档分类: MGMT-RPT-004 | 阶段: 项目管理 | 原路径: docs/khy-对比-openagent-交付差距.md -->
# KHY OS vs oh-my-openagent 任务交付差距分析

> 分析日期：2026-05-16
> KHY OS 版本：当前 main 分支
> oh-my-openagent 版本：v4.1.2
> 触发事件：KHY 无法独立完成一个多文件 SSM（Spring + MyBatis）项目

---

## 概述

KHY 已具备必需的编码工具（writeFile、editFile、scaffoldFiles、shellCommand、buildProject、runTests），但**循环引擎太弱**，无法驱动这些工具走完完整的项目「构建—修复—测试」生命周期。AI 在到达可用状态之前就被中途截断。

---

## 1. 量化限制

| 指标 | KHY 当前 | 真实项目所需 | oh-my-openagent |
|--------|-------------|-------------------|-----------------|
| 循环迭代次数 | 10（通过环境变量最大 100） | 20-30 | 无硬性上限（Ralph Loop） |
| 墙钟超时 | 120s（通过环境变量最大 600s） | 300-600s | 基于活跃度的空闲超时 |
| Shell 输出上限 | 50 KB | 200 KB+（Maven/Gradle 日志） | 流式，无截断 |
| 编辑可靠性 | 字符串匹配（old → new） | 逐行哈希校验 | Hashline xxh32 内容哈希 |
| 失败恢复 | 重试 + 指数退避 | 检查点 + 续跑 | Boulder State 持久化 |
| 并行 agent | 串行（cliAgentRunner） | 2-4 并发 | Team Mode + 邮箱协议 |
| 模式切换 | 无 | 意图触发 | IntentGate 关键词检测 |
| Hook 组合 | 内联硬编码 | 5 层故障隔离 | Session → ToolGuard → Transform → Continuation → Skill |

---

## 2. 五大关键差距

### 差距 1：缺少持久化执行循环 — P0

**问题**：`toolUseLoop.js` 默认 10 次迭代 / 120s 硬超时。一个典型的 SSM 项目工作流需要：

```
create structure → write pom.xml → write Java classes → mvn install →
read errors → fix code → rebuild → write tests → run tests → fix → rerun
```

这很容易超过 20 轮和 300 秒。

**oh-my-openagent 方案**：Ralph Loop + Boulder State
- 无迭代硬上限——只要还有有效工作，循环就持续
- Boulder State 将任务进度保存到磁盘——可在崩溃和会话边界后存活
- 跨会话续跑——精确从停止处恢复

**对 KHY 的影响**：AI 在项目编译通过之前就被强制停止。用户看到的是残缺、损坏的输出。

**修复**：实现基于活跃度的空闲超时（仅当 N 秒内无有效工作时才停止），并将迭代上限提升到 50+。为长时间运行的任务增加检查点/续跑能力。

---

### 差距 2：缺少 IntentGate 模式切换 — P0

**问题**：当用户说「创建一个 SSM 项目」时，KHY 没有任何机制去：
- 注入编码模式系统提示词（强制结构化任务执行）
- 设置 `tool_choice: required`（强制 AI 调用工具，而非仅仅聊天）
- 在执行过程中抑制对话式废话

**oh-my-openagent 方案**：IntentGate 关键词检测器
- 魔法词（`ultrawork`、`search`、`analyze`、`team`、`hyperplan`）触发模式注入
- 每种模式注入专门的系统提示词 + 工具约束
- `ultrawork` 模式：长系统提示词，强调自主完成、强制工具使用、不完成不停止

**对 KHY 的影响**：AI 用建议来回应（「你可以创建一个 pom.xml，里面……」）而不是真正去创建文件。在较弱的模型上尤其严重。

**修复**：在 agenticHarnessService 中增加 IntentGate 层。检测项目创建/编码关键词 → 注入编码模式提示词 + 强制工具使用。

---

### 差距 3：编辑不可靠（无 Hashline）— P1

**问题**：`editFile` 使用纯字符串匹配（`old_string` → `new_string`）。当文件存在重复或相似的内容块时，编辑可能命中错误位置。在一个 200 文件的 Java 项目中，编辑错误会累积并引发级联失败。

**oh-my-openagent 方案**：Hashline LINE#ID 系统
- 每一行获得一个由 xxh32 内容哈希派生的 2 字符 ID（字母表：`ZPMQVRWSNKTXJBYH`）
- 编辑工具在应用前校验目标行内容与哈希匹配
- 过期编辑（AI 读取后文件已变更）会被拒绝并返回清晰的错误

**对 KHY 的影响**：静默损坏——AI 以为编辑成功，实则改了错误的块。调试成本成倍增加。

**修复**：为 editFile 增加内容指纹校验。应用前，先验证 `old_string` 出现在预期位置。不匹配时，返回带当前文件状态的错误。

---

### 差距 4：缺少 Hook 组合系统 — P1

**问题**：工具行为在 toolCalling.js、toolUseLoop.js 以及各个工具文件中以内联硬编码方式散落。不存在用于横切关注点的拦截层。

**oh-my-openagent 方案**：5 层 hook 组合
| 层级 | 用途 | 示例 |
|------|---------|---------|
| Session | 生命周期事件（启动、结束、错误） | 自动保存会话轨迹 |
| ToolGuard | 工具前/后校验（16 类） | 拦截危险的 shell 命令 |
| Transform | 输入/输出转换 | 压缩大型工具结果 |
| Continuation | 循环控制 | Ralph Loop 续跑逻辑 |
| Skill | 技能特定行为 | 注入领域上下文 |

KHY 缺失的关键 hook：
- **Comment Checker**：外部二进制程序，扫描 Write/Edit 输出中的 AI 生成的水货注释（`// This function does X`、`// TODO: implement`）并拦截
- **Edit Error Recovery**：在 editFile 失败时，自动注入「先 READ 文件再重试」的引导
- **ToolGuard validators**：16 项执行前检查（路径安全、输出大小、限流）

所有 hook 都受配置开关控制（`isHookEnabled()`）且故障隔离（`safeCreateHook`——hook 崩溃不会拖垮循环）。

**对 KHY 的影响**：错误不会被自动恢复。质量无法在工具边界处强制保障。每次修复都要改动核心循环代码。

**修复**：设计 3 层 hook 注册表（ToolGuard + Transform + Continuation）。首批实现 Edit Error Recovery 和 Comment Checker 两个 hook。

---

### 差距 5：缺少并行 Team Mode — P2

**问题**：`cliAgentRunner` 串行派发 agent。对于大型项目，单个 agent 顺序完成所有事情。

**oh-my-openagent 方案**：Team Mode
- 带角色分配的并行多 agent（coder、tester、reviewer）
- 用于 agent 间通信的邮箱协议
- 背压：若某个 agent 被阻塞，其他 agent 继续
- 确认机制：agent 确认收到共享产物

**对 KHY 的影响**：大型项目耗时翻 N 倍。无专业分工——单个 agent 必须在写代码、跑构建、修错误、写测试之间反复切换上下文。

**修复**：为 cliAgentRunner 扩展邮箱协议和并发派发。优先级较低——P0/P1 修复的 ROI 更高。

---

## 3. SSM 项目失败全过程

当用户要求 KHY 创建一个 SSM 项目时会发生什么：

```
Round 1:  scaffoldFiles → create directory structure          ✅ (~2s)
Round 2:  writeFile × 5 → pom.xml files                      ✅ (~3s)
Round 3:  writeFile × 20 → Java entity/mapper/service classes ✅ (~5s)
Round 4:  shellCommand → mvn clean install                    ⚠️ (~45s, may timeout)
Round 5:  AI reads truncated Maven error (50KB cap)           ⚠️ (incomplete context)
Round 6:  editFile → fix first compilation error              ⚠️ (may hit wrong location)
Round 7:  shellCommand → mvn clean install again              ⚠️ (~45s)
Round 8:  More errors, more fixes needed                      ⚠️
Round 9:  Still fixing...                                     ⚠️
Round 10: HARD LIMIT REACHED — loop terminates                ❌
```

**结果**：用户得到一个半成品、无法编译的项目。剩余工作：
- 10+ 个编译错误未修复
- 未编写测试
- 未配置 application.yml
- 无 MyBatis mapper XML 文件
- 构建从未成功

---

## 4. 修复路线图

### P0 — 阻塞项（决定能否交付任何项目）

| # | 修复 | 文件 | 工作量 |
|---|-----|-------|--------|
| 1 | **基于活跃度的空闲超时**——用空闲检测替代硬性 120s（在工具完成、AI 回复、流式 chunk 时重置） | `toolUseLoop.js`、`agenticHarnessService.js` | 中 |
| 2 | **提升迭代上限**——默认 30，最大 100，可通过环境变量配置 | `toolUseLoop.js` | 小 |
| 3 | **IntentGate 模式注入**——检测编码/项目关键词 → 注入系统提示词 + 强制 tool_choice | `intentGate.js`（新增）、`agenticHarnessService.js` | 中 |
| 4 | **Shell 输出扩容**——50KB → 200KB，从大型日志中自动提取 ERROR/FAILURE 行 | `toolSandbox.js`、`shellCommand` 工具 | 小 |

### P1 — 质量项（减少修复循环的迭代次数）

| # | 修复 | 文件 | 工作量 |
|---|-----|-------|--------|
| 5 | **Edit Error Recovery hook**——在 editFile 失败时，自动重新读取文件 + 用新内容重试 | `toolCalling.js` 或新增 hook 层 | 小 |
| 6 | **内容指纹校验**——应用编辑前先验证 old_string 的位置 | `editFile` 工具 | 中 |
| 7 | **构建错误摘要器**——解析 Maven/Gradle/npm 输出，提取可操作的错误清单 | `toolUseLoop.js` 中的新工具函数 | 中 |

### P2 — 竞争力对齐（长期）

| # | 修复 | 文件 | 工作量 |
|---|-----|-------|--------|
| 8 | **3 层 hook 组合**——ToolGuard + Transform + Continuation，带配置开关 | 新增 `hookRegistry.js` | 大 |
| 9 | **Comment Checker**——拦截 Write/Edit 输出中的 AI 水货注释 | 新增 hook | 中 |
| 10 | **Team Mode**——带邮箱协议的并行 agent | `cliAgentRunner.js` 重构 | 大 |
| 11 | **Boulder State**——跨会话长任务的检查点/续跑 | 新增持久化层 | 大 |

### P0 完成后的预期成效

| 指标 | 之前 | P0 之后 |
|--------|--------|----------|
| SSM 项目完成度 | ❌ 在第 10 轮失败 | ✅ 20-30 轮内完成 |
| 墙钟预算 | 120s 硬性 | 600s+ 基于活跃度 |
| AI 在「创建项目」时的行为 | 话痨，只建议不执行 | 强制工具使用，自主执行 |
| Maven 错误可见性 | 在 50KB 处截断 | 完整错误被提取 |

---

## 5. 对比矩阵

| 能力 | KHY OS | oh-my-openagent | Claude Code | Qwen Code |
|-----------|--------|-----------------|-------------|-----------|
| 最大循环迭代 | 10 | 无限 | ~200 | ~100 |
| 超时模型 | 硬性墙钟 | 基于活跃度的空闲 | 基于活跃度 | 硬性 + 空闲混合 |
| 编辑校验 | 字符串匹配 | Hashline xxh32 | 唯一字符串匹配 | AST 感知 |
| 错误恢复 | 手动重试 | 自动 hook | 自动重试 | 自动重试 |
| 模式切换 | 无 | IntentGate 关键词 | Plan 模式切换 | Task/chat 模式 |
| 并行 agent | 串行 | Team Mode 邮箱 | 后台 agent | 串行 |
| Hook 系统 | 无 | 5 层组合 | 前/后 hook | 插件 hook |
| 跨会话状态 | 无 | Boulder State | 任务持久化 | 会话恢复 |

---

## 参考

- oh-my-openagent 源码：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/`
- 对齐日志：`docs/07_OPS_运维/[OPS-MAN-020] openagent-对齐日志.md`
- 对齐维度：`AGENTS.md` 第 257-344 行
- KHY 工具循环：`backend/src/services/toolUseLoop.js`
- KHY agentic harness：`backend/src/services/agenticHarnessService.js`
- KHY 工具沙箱：`backend/src/services/toolSandbox.js`
