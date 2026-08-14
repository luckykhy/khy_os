# [DESIGN-ARCH-060] khy 功能接线与编排总图

> 目的:khy 已累积大量功能(全仓 **1371** 个唯一 `KHY_*` 标识、**195** 个 router 命令名
> [`getRouterCommandNames()`]、**165** 个标注「纯叶子」的源文件)。本文回答两个问题:
> **怎么准确"接线"**(每个功能挂到对的切点、登记齐、可回退)、
> **怎么"编排"**(零散功能如何串成一条连贯的运行时主线)。
>
> 本文所有数字与行号均由 node 直读源码核出(非 grep——本仓 grep 经 rtk 代理会污染输出,审计一律用
> `node -e fs.readFileSync` 或 `find`)。

---

## 一、接线契约(五件套铁律)

任何新功能落地都必须同时满足以下五条,缺一即"半接线":

1. **纯叶子(leaf)** — 零 IO、零业务 require 的确定性核心,过 `scripts/check-leaf-contract.js`。
2. **薄壳(thin shell)** — handler/service 注入协作者调用叶子,不在壳里重写算法。
3. **三处登记(命令类功能)** — `constants/commandSchema.js`(ROUTER 行 + `getRouterCommandNames`)
   + `cli/router.js` 的 `ROUTER_COMMANDS` 允许集 + `switch case`。三者缺一,命令要么不可达、要么死 case。
4. **门控字节回退** — `KHY_<FEATURE>`,默认开;`=0/false/off/no` 时**逐字节**回退到 legacy 行为。
5. **bundled 三副本重建** — `platform/khy_os/bundled`、`packaging/npm/bundled`、`build/lib/khy_os/bundled`
   三处副本须随 wheel/npm 重建(裸 require 新叶子否则抛)。三副本 git-ignored,**绝不手改**。

> 这五条是"接线准不准"的判据,不是风格偏好。审计脚本与 `.ai/GUARDS.md` 红线据此设防。

---

## 二、编排主线:一个对话回合的生命周期

零散功能不是平行的 N 个开关,而是沿"一个 chat 回合"挂在不同切点上的。看时间轴就不乱了
(`services/backend/src/cli/ai.js`,行号 node 核实):

```
┌─ 回合开始:系统提示装配(按此顺序拼接 sp)──────────────────────────┐
│ ai.js:5186  proactive 记忆段       buildProactiveSystemSection       │
│ ai.js:5191  短期会话记忆段         buildSessionMemorySection         │
│ ai.js:5200  会话拓扑「你在这里」    buildHereLineForCurrent  (KHY_SESSION_TOPOLOGY)
│ ai.js:5202  一次性 insight 收件箱  consumeInsightForCurrent (KHY_SESSION_SLOTS)
│ ai.js:5226  学习应答风格信号        recordResponseFeedback   (KHY_USAGE_HABITS)
│ ai.js:5228  使用习惯段             getHabitContext                   │
├─ 回合中:工具循环 + 渲染 ─────────────────────────────────────────┤
│ toolUseLoop  结果守卫收尾兜底       resultGuard              (KHY_RESULT_GUARD)
│ toolUseLoop  死开关意图裁决         intentArbiter            (KHY_INTENT_ARBITER)
│ repl/router  /diff 采集+着色        gitDiffCollect           (KHY_DIFF_INCLUDE_UNTRACKED)
│ repl         出口去重               renderDedup              (KHY_RENDER_DEDUP)
│ App.js       ↑/↓ 编辑中浏览历史     historyBrowseDecision    (KHY_HISTORY_BROWSE_EDITING)
├─ 回合结束 ────────────────────────────────────────────────────────┤
│ ai.js:6157  consolidate 蒸馏进 memory 槽(fire-and-forget,不 await,绝不翻红当轮)
│             consolidateCurrent       (KHY_SESSION_SLOTS · 节拍 KHY_CONSOLIDATE_EVERY)
└───────────────────────────────────────────────────────────────────┘
```

### 编排铁律:三槽不对称(memory 绝不自注入)

会话节点除 history 外挂三个生命周期各异的槽(`cli/sessionSlots.js`):

| 槽 | 生命周期 | 注入 |
|---|---|---|
| `systemPrompt` | 持久,fork 时 4 层合并继承 | 每轮注入 |
| `insight` | 一次性收件箱,注入一次即清 | 每轮注入(消费后清空) |
| `memory` | **外向**摘要,由 orchestrator/跨支综合读 | **绝不**注入本节点自身上下文 |

`INJECTABLE_SLOTS = ['systemPrompt','insight']`,**刻意不含 memory**。consolidate 只把 memory **写出去**;
任何"顺手把 memory 也注进 sp"就是把外向摘要喂回自身,引入潜伏 bug。fork 经 `_applyForkSlots` 门控:
保父 `systemPrompt`,恒清子 `insight`/`memory`(子自产)。

---

## 三、旁路命令面(不在热路径,用户/CLI 显式触发)

命令通过 `cli/router.js` 的 `switch(parsed.command)` 分发。两类入口:

- **Session 内 slash 命令**(195 个,经 `getRouterCommandNames` 允许集守门):如
  `/topology`、`/orchestrate schedule`、`/fork`、`/autonomy`、`/proactive`、`/onboarding`、`/btw`、`/lang`…
- **CLI 专用命令**(不在 slash 允许集,经 `khy <cmd>` 从命令行进):`khy os`(kernel)、`khy verdict emit`
  (改动反馈)、`khy restore-source`(解包源码)。这些有 handler + case 但**刻意不暴露为 slash**。

> 连字符命令用堆叠 fall-through case 兼容无连字符别名(`case 'autofix-pr': case 'autofixpr':`)。

---

## 四、接线审计基线(2026-06-30 核出)

用 node(非 grep)对全功能面做一致性审计,结论:

| 审计项 | 方法 | 结论 |
|---|---|---|
| 命令名→switch case | 195 名(含别名)vs 203 case 双向差集 | ✅ 每个命令名都有 case,无半登记 |
| 未匹配 case | 6 个 | ✅ 全有解(3 别名堆叠 + 3 CLI 专用) |
| 孤儿叶子 | fs 扫 165 叶子的全仓 require 引用(29226 文件穷尽) | ✅ **0 个事故性孤儿**(`cli/pty.js` 已对账为保留能力) |
| 死门控 | GUARDS 声明门控 vs 代码读取 | ✅ 0 个(候选均假阳性:setup.py/computed read) |

### 已对账缺口:`cli/pty.js`(刻意保留,不接线)

完整实现了 `/bash` 全 PTY 交互 shell(支持 sudo/vim/top,node-pty 不可用时降级 child_process),导出
`launchPtyShell`/`isPtyAvailable`——经 29226 文件穷尽核查**零引用**,schema/router/case 三处皆无 `bash`
命令,连 `[DESIGN-ARCH-053]` 里的 `pty` 也只是输出折叠 scope 的**工具名字符串**而非本模块。

**处置(已落 GUARDS 红线三)**:**保留且刻意不接线**。
- **不删**:非本会话作者所建,删除会销毁他人产物(违反"未创建即不擅动"约束)。
- **不接线**:常驻 sudo 交互 shell 的安全面与 khy「人闸门 + 权限层」哲学相悖;一次性命令需求已由经典
  REPL `!` shell-escape 覆盖。
- **审计契约**:后续孤儿扫描视 pty.js 为已登记例外,不再当事故性缺口翻红。若未来确需 `/bash`,须走完整
  接线五件套 + 交互前安全确认 + 独立设计评审。

> 注:经典 REPL 的 `!` shell-escape 走 records 式 `formatShellEscapeContext`,与 pty.js **无关**,
> 不能互相替代。

---

## 五、新功能落地自查清单

```
□ 叶子过 leaf-contract:  node scripts/check-leaf-contract.js <leaf>.js
□ 命令三处登记齐:        commandSchema(ROUTER 行+名)+ router ROUTER_COMMANDS + switch case
□ 门控字节回退已验:      KHY_<F>=0 时逐字节 == legacy
□ 三守卫过:              leaf-contract / agent-rules / model-hardcoding
□ bundled 三副本已重建:  随 wheel/npm 构建,绝不手改
□ 接进编排主线:          想清楚挂在「回合开始注入 / 回合中 / 回合结束 / 旁路命令」哪个切点
```

---

承 `.ai/GUARDS.md` 全部红线;与 `[DESIGN-ARCH-014] 模式图谱` 互补(那篇讲模式,本篇讲接线与编排切点)。
