# [OPS-MAN-072] 目标连续多日运行不中断的底气自检

## 这份清单是干什么的

khy 的持久目标(`khy goal set …`)已能像 Claude Code 的 `/goal` 那样**自主自驱**(stop-gate
续接)并**跨会话持久化**。但**默认配置其实是敌视多日运行的**:闲置退役窗口默认 **12 小时**,到点
会把目标自动退役(`exhausted`)。想像 CC 那样「连续几天不完成任务、token 足够不中断」地跑,先跑一句
自检确认配置扛得住:

```bash
khy goal endurance          # 别名:khy goal stamina / endure
```

它对**两个维度**判定「连续跑约 N 小时(默认 72h ≈『连续几天』)不中断」的底气:

1. **交互式会话(无需目标)** —— 「不一定是目标,可能是一个超长的人机互动任务」。
2. **目标(`/goal`)专属治理器** —— 仅在设定了持久目标后才适用。

判定/文案的单一真源在纯叶子 `services/backend/src/services/goalEndurance.js`(零 IO、确定性、绝不抛);
读目标 + 打印在 `services/backend/src/cli/handlers/goal.js`。

## 交互式会话(无需目标)的底气 —— 默认即成立

经源码审计(非臆测):**一个不设 `/goal` 的普通交互式会话,默认没有任何机制会把它中断或退出**——
没有闲置 `process.exit`、没有累计轮数上限、没有会话级墙钟杀手。目标专属治理器(闲置退役 / 轮次预算)
**只在存在活动目标时才触发**,对纯交互会话不适用。

真正会「触发」的只有**单轮回复长度边界**,到点仅**结束当前这一条回复并自动续接**,会话继续:

| 键 | 默认 | 作用 | endurance 值 |
|----|------|------|--------------|
| `KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS` | 20 min(无 clamp) | 单轮绝对上限(对标 CC「无硬上限」) | `86400000`(24h) |
| `KHY_TOOL_LOOP_MAX_MS` | 10 min(clamp `[5s,30min]`) | 单轮空闲守卫(活跃推进时不触发) | `1800000`(30min,clamp 上限) |
| `KHY_TOKEN_BUDGET` | 关 | 唯一会因 token 截断本轮的开关 | `0`(关) |

所以交互会话底气**默认即成立**;自检把上面三键作为「让超长单条回复更少被墙钟切」的可选调优项列出,
纳入一键落盘,但它们**不影响会话能否连续跑几天**。

## 「token 足够不中断」的真相

khy 在上下文吃紧时**自动压缩/归档历史**(capacityFlow / seamManager),**从不因「上下文满」而停**;
硬 token 上限 `KHY_TOKEN_BUDGET` **默认关**。所以 token 侧本就稳健——这正是「token 足够不中断」的底气。
唯一会因 token 截断本轮的开关,是你**显式设置**的 `KHY_TOKEN_BUDGET`(达上限会用已完成工作合成一条回复
并结束本轮;目标不退役,但本轮被打断)。自检会把它标成提示项。

## AI 中途提问 —— 无人值守时自动用「最推荐方案」作答

连续几天不中断的**隐性阻塞点**:AI 中途通过 `AskUserQuestion` 提问时,即便前台有交互通道,循环也会
**阻塞等人回答**——一个待答问题会停住整个 run。开启门控后由纯叶子 `unattendedAutoAnswer` 用
`questionQuality` 已排好序的**推荐选项(index 0)**确定性作答、无感续跑,优先于「有通道阻塞」与「无通道
保守自决」两分支。

| 键 | 默认 | 作用 |
|----|------|------|
| `KHY_UNATTENDED_AUTOANSWER` | 关 | 无人值守时自动采用推荐选项作答;需要人拍板时设回 `0` 即恢复阻塞等人。 |

自动作答是**行为变更**,故默认关(须显式 opt-in);`khy goal endurance --apply` 落盘时会把它打开。
无可选推荐项(如空 options)时不假造答案,退回「选最合理默认并显式声明假设」的保守指令。

## 不偏离用户本意 —— 自动作答按原始意图校准

盲选 index 0 的风险:它往往只是「模型恰好第一个列出的选项」,一次这样的自动拍板可能把整个多日 run **悄悄带偏**离用户的原始本意。纯叶子 `autoAnswerIntentGuard`(门控 `KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD`,**默认开**,嵌套在默认关的父键下——只在自动作答开启时才生效)在真正选定前用**确定性词法信号**把选择校准回本意:

- 锚点材料 = **持久目标文本 ∪ 原始诉求关键锚点 ∪ 原始消息**(调用点已在作用域内,无新增取数)。
- 若某选项标签与本意词法重叠**唯一地严格更高**,就改选它(校准);
- **显式标注 `(Recommended)`/`(推荐)`** 的选项一律尊重(用户要「使用最推荐方案」);
- 无锚点 / 无信号 / 门关 → **逐字节回退**到基线 index 0,绝不擅自改选。
- 被校准过的卡在可见轨迹里显式标注「已按你的目标校准」,动作可审计。

| 键 | 默认 | 作用 |
|----|------|------|
| `KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD` | 开 | 自动作答按原始目标/诉求校准选项;设 `0/false/off/no` 关闭 → 回退盲选 index 0。 |

**诚实边界**:这是**词法安全网**而非语义理解——只能校准到「文字上明显更贴合本意」的选项,不做模型调用;它补上的是「代替用户拍板却零本意核对」这唯一确定性缺口。

## 模型不可用 —— 自动无感续接(已默认启用)

「当前模型挂了会不会自动无感续接其他模型」:**会**,且**无需本自检新增**。网关已实现多层级联——
跨适配器级联 + 跨 key 池轮换 + 实时状态提示。可重试/可回退错误(超时/限流/过载/服务端错误等)自动换下一个;
**严格锁定模型 + 永久错误**(`model_not_found` / `auth` / `billing`)是**刻意的诚实边界**:明确报错而**不盲目瞎切**。
自检把这条作为「模型挂了也不掉线」的底气如实亮出(`model-failover` note)。

## 错误处理 —— 一次意外抛出也不该杀掉整个 run

连续几天不中断,错误处理是**最后一道防线**。分三层:

1. **归一成返回值(已有)**:瞬时/工具/模型错误都被网关归一——工具错误回喂模型后继续、连续失败熔断、
   网关重试耗尽返回 `success:false` **而非抛出**。主循环据此优雅收尾本轮、给出「继续」提示,不掉线。
2. **意外异常的防御纵深(本自检硬化)**:网关契约是「返回而非抛」,但真正*意外*的异常(适配器编程 bug、
   解析崩溃、非预期 `TypeError`)会从主循环 `await chat(...)` 穿透到调用方、杀掉整个 run。已加防御纵深
   `try/catch`(门 `KHY_TOOL_LOOP_CHAT_GUARD`,**默认开**):意外异常被归一成「诚实的本轮结束」结果——
   如实说明发生了意外错误、本轮已安全结束、会话未中断、可回复「继续」推进。门关(显式 falsy)→ 逐字节回退
   到旧行为(重新抛出)。
3. **永久错误诚实报错(刻意边界)**:`model_not_found` / `auth` / `billing` 等永久错误明确报错停下,
   **不盲目瞎切**——这是特性不是缺口。

自检把这条作为「错误也不掉线」的底气如实亮出(`error-handling` note)。

## 自检会检查这些项

| 项 | 级别 | 症状 | 修法 |
|----|------|------|------|
| `idle-timeout` | 阻断 | 闲置退役窗口小于目标时长:自主自驱在单个用户轮内推进时 `lastAdvancedAt` 不刷新,超窗后下次读取(或重启)会把目标退役。这是多日运行的**头号确定性杀手**。 | `export KHY_GOAL_IDLE_MS=0`(关闭闲置退役,或设成 ≥ 目标时长的毫秒数) |
| `turn-budget` | 提示 | 轮次预算(默认 25 个用户轮)余额偏低。轮次每个用户轮 +1,自主自驱在单轮内完成时几乎不动;但频繁人工交互可能提前退役。 | `export KHY_GOAL_MAX_TURNS=1000`(clamp 上限 1000) |
| `token-budget` | 提示 | 设置了硬 token 上限 `KHY_TOKEN_BUDGET`,达上限会截断本轮。 | `export KHY_TOKEN_BUDGET=0`(取消硬上限;上下文吃紧自动压缩) |
| `stop-gate` | 提示 | 单个用户轮内 stop-gate 自续接上限仅 1 次,交还控制权偏早。 | `export KHY_GOAL_STOP_GATE_MAX=10`(clamp 上限 10,单轮多推几步) |

未构成阻断的项会以「已就绪 ✓」列出(例如闲置退役已关闭、无硬 token 上限)。

## 一键 endurance 配置

自检末尾给出可照抄的配置块;写进当前 shell 即可连续跑几天不自我中断:

```bash
# 目标(/goal)治理器
export KHY_GOAL_IDLE_MS=0        # 关闭 12h 闲置退役(头号确定性杀手)
export KHY_GOAL_MAX_TURNS=1000   # 把用户轮预算提到上限
export KHY_GOAL_STOP_GATE_MAX=10 # 单轮多自续接几步再交还控制权
# 交互会话 + 无人值守
export KHY_TOKEN_BUDGET=0                       # 取消硬 token 上限(上下文自动压缩)
export KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS=86400000  # 单轮绝对上限 → 24h(超长回复更少被墙钟切)
export KHY_TOOL_LOOP_MAX_MS=1800000             # 单轮空闲守卫 → 30min(活跃推进时不触发)
export KHY_UNATTENDED_AUTOANSWER=1              # AI 中途提问自动采用推荐选项作答(不阻塞等人)
```

### 一键落盘(持久化,跨会话/重启生效)

```bash
khy goal endurance --apply             # 两维度都落盘(目标治理键 + 会话回复边界)
khy goal endurance --apply --session   # 仅交互会话(单轮回复边界 + token 上限)
khy goal endurance --apply --goal      # 仅目标治理器(闲置退役 / 轮预算 / stop-gate)
```

`--apply` 把推荐键幂等写入 khy 的 `.env` 配置(SSOT 写入器 `config._writeEnvPatch`,与 `khy goal on`
同一处;canonical = `KHY_ENV_FILE` 或 `<backend>/.env`),只写与目标值不同的键、从不删除其它配置、**绝不写入任何
key/token**。默认 `scope=all` 落两维度并集(共有的 `KHY_TOKEN_BUDGET=0` 无冲突),`--session` / `--goal` 只落对应一维。
写后用合并 env 复评并打印落盘路径与两维度「落盘后判定」。撤销:编辑该文件或用 `khy config` 改回相应键。

## 做完任务及时验证测试 —— verify-ran 行为证据门

诉求(goal「khy 做完任务不会及时验证测试」):Stop-gate 的**证据门**
(`goalStopGate.claimsVerificationWithoutEvidence`)只检查回复里**有没有「证据形状的文字」**
(```` ``` ```` 代码块 / `PASS` / 字面 `npm test`)。模型只要贴一段**看起来像输出的文字**——哪怕
整轮从未真正调用过 shell——就能骗过证据门,让「声称测试通过却根本没跑」蒙混收尾。

**verify-ran 门**(`KHY_GOAL_VERIFY_RAN_GATE`,默认开,嵌套父门控 `KHY_GOAL_STOP_GATE`)补上
**「行为证据」**这一层:

- 纯叶子谓词 `verificationCommandRan(toolCallLog)` 扫描整轮工具执行记录,**只认 shell 类工具**
  (`bash` / `exec` / `shell_command`…)携带、且命中**测试/检查/构建/lint 命令签名**
  (`npm test`、`node --test`、`node --check`、`npm run arch:god`、`npm run maintainer:check`、
  `pytest`、`jest`、`cargo test`…)的**真实执行**;一段单纯贴在回复里的假证据文字不会被算作「跑过」。
- `evaluateGoalStop` 在判「达成」之后、契约门之前插入分支:回复**声称验证通过**
  (`_VERIFICATION_CLAIM_RE`)但整轮 `toolCallLog` **找不到任何真跑过的验证命令** → 把 `clear`
  **降级为 `redrive`**(`reason=verify-not-run`,走同一 redrive 预算,耗尽则 `pass` 不自动清除一个
  未经验证的目标),注入指令要求**真正运行**验证后再收尾。

**与证据门互补**:证据门拦「声称验证却拿不出任何证据文字」;verify-ran 门拦「贴了证据文字、但从未
真正执行」。`toolCallLog` 由 `toolUseLoopCore` 的 stop-gate 接线点在作用域内**直接传入**
(无新增取数);旧调用方不传 → 该门跳过 → 逐字节回退;门关同样逐字节回退。

**诚实边界**:命令签名是**词法白名单**(保守宁缺勿滥),核对的是「本轮是否真的跑过验证命令」,
不判断测试是否真的全绿(那由回复文本 + 后续轮次继续核对)。

## 寿命边界的单一真源

所有默认值/阈值定义在纯叶子 `goalCore.js`,`goalEndurance.js` 只**读取并分类**,不重复定义:

- 闲置退役窗口:`goalCore.resolveIdleMs`(默认 `GOAL_DEFAULT_IDLE_MS` = 12h;`KHY_GOAL_IDLE_MS=0` → `Infinity` 关闭)
- 轮次预算:`goalCore.resolveMaxTurns`(默认 `GOAL_DEFAULT_MAX_TURNS` = 25;clamp `[1,1000]`)
- 自愈对账开关:`goalCore.isReconcileEnabled`(`KHY_GOAL_RECONCILE`,父门 `KHY_GOAL`)
- 有界终止态开关:`goalCore.isBounded`(`KHY_GOAL_BOUNDED`)
- 单轮自续接:`KHY_GOAL_STOP_GATE_MAX`(flagRegistry,默认 1,clamp `[0,10]`)

## 验证

```bash
npm run test:maintainer:goal-endurance
```
