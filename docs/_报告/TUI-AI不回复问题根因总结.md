# TUI 模式 AI 不回复 — 根因总结

> 时间：2026-07-24  
> 范围：`services/backend/src/cli/tui/hooks/useQueryBridge.js` 及相关文件

---

## 已确认修复的问题

| # | 问题 | 根因 | 修复方式 |
|---|------|------|---------|
| 1 | **IIFE 未执行** | `});` 缺少调用括号，应为 `})();`。整个 toolUseLoop IIFE 体不执行，loopResult 是 function 而非 object | 改为 `})();` |
| 2 | **AI 回复重复** | runToolUseLoop 已通过 onChunk 流式输出内容，但返回空 finalResponse。fallback 不知已流式，再发一次请求 | 检查 liveRef.current.text 避免二次请求 |
| 3 | **流式输出堆叠（阶梯效应）** | onChunk 每遇换行调 flushCompletedStages → 同时触发 setMessages + setStreamingBoth。React LegacyRoot 在异步回调中不批处理，Ink 中间帧读到不一致状态（Static 已提交但 live 未缩减），log.clear() 基于旧 previousLineCount 计算光标位移 | 移除文本路径中换行触发的 flush，仅保留 tool_use/tool_result/finalize 边界 |
| 4 | **语法错误（Unexpected token 'catch'）** | `if (useNativeLoop)` 块缺少闭合 `}`，导致外层 try 的 catch 无法匹配，文件无法加载 | 补闭合括号 |
| 5 | **fallback 路径不可达** | loopResult=null 时仍赋 `result={reply:null,...}`（truthy 对象），`if(!result)` 永不触发降级到 ai().chat() | 改为 `if(loopResult){ result={...} }` 条件赋值 |
| 6 | **回车后长延迟** | checkpointService.saveCheckpoint() 在 microtask 内用 execFileSync 阻塞事件循环 200-5000ms；toolUseLoop 8800 行模块首次同步加载 100-500ms | checkpoint 改 setTimeout(3000) 推到宏任务；toolUseLoop 在 useEffect 中 setImmediate 预加载 |
| 7 | **console 干扰 Ink 渲染** | toolUseLoopCore.js 中 6 处 console.warn/info 直接输出到终端，干扰 Ink 的 log-update 光标定位计算 | 替换为 `_loopBreadcrumb` 文件日志（受 KHY_LOOP_DEBUG 门控） |

---

## 未完全确认的问题

| # | 问题 | 可能原因 |
|---|------|---------|
| 8 | 启动卡死 5min（bridgeAuth 后无输出） | sourceHealService 检测到 useQueryBridge.js 哈希变化后触发恢复阻塞；或 replSession.js setImmediate 改动引入时序依赖 |
| 9 | 发送后 30s 无响应 | AI 网关 model_not_found 30s 冷却期；或 sensenova 适配器配额耗尽静默等待 |

---

## 核心结论

**AI 不回复的首要原因是 #1（IIFE 未执行）和 #4（语法错误）**：

- **#1** 导致 `loopResult` 是一个 function 对象而非执行结果，后续所有基于 loopResult 的逻辑都在处理错误的数据类型
- **#4** 导致 useQueryBridge.js 整个文件无法被 Node.js 加载，TUI 模式根本无法初始化

其余问题（#2-#7）是修复过程中发现的关联缺陷，属于"同族问题"。

---

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `services/backend/src/cli/tui/hooks/useQueryBridge.js` | IIFE 修复、语法修复、fallback 逻辑、flush 禁用、checkpoint 延迟、预加载、诊断日志 |
| `services/backend/src/services/toolUseLoopCore.js` | 6 处 console.warn/info → _loopBreadcrumb |
| `services/backend/src/cli/replSession.js` | 4 个启动服务改为 setImmediate 包裹（用户自行修改） |

---

## 诊断日志

useQueryBridge.js 中保留了 13 个 `[TUI-DIAG]` 诊断点（`process.stderr.write`），覆盖从 submit 入口到 AI 首个 token 的完整路径。可通过观察相邻阶段的时间差精确定位未来的延迟问题。

环境变量快速诊断：
```bash
KHY_TUI_TURN_CHECKPOINT=0 khy    # 禁用 checkpoint 排除其阻塞
KHY_TUI_NATIVE_LOOP=0 khy        # 禁用 toolUseLoop 走纯 ai().chat()
KHY_LOOP_DEBUG=1 khy              # 开启 toolUseLoop 文件日志
```
