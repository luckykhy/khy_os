# [DESIGN-ARCH-121] khyos 对《Claude Code 实战·Harness 工程之道》的借鉴清单

> **文档性质**：**借鉴清单 + 落地提案**。本文档不是规则语义真源——规则语义仍以
> `CLAUDE.md`（红线 R1–R4）、`AGENTS.md`（RUNTIME-001~004）、
> [`../10_规范/registry/RULES-REGISTRY.json`](../../10_规范/registry/RULES-REGISTRY.json) 为准。
>
> **上游依赖**：[`[DESIGN-ARCH-112] khyos-Harness架构对照.md`]([DESIGN-ARCH-112] khyos-Harness架构对照.md)
> 已完成第一遍盘点（四层架构 → 文件路径映射、Harness 五要素刻度、baseline 六处更正）。
> 本文档是它的**第二遍**：从「现状对照」升级为「**逐条借鉴决策**」。
>
> **语料**：《Claude Code 实战：Harness 工程之道》黄佳 著（人民邮电出版社，2026-05，
> 312 页，ISBN 9787115696533）。分章语料 `.research-tmp/cc-book-harness/split/ch01..ch10.txt`
> （2026-09-17 由原书 PDF 重建，312 页 / 223 041 字符）。
>
> **实测日期**：2026-09-17。文中所有「现状」判定均附 `文件:行号` 或目录实测证据。
>
> **`.khy/` 版本控制注意**：`.khy/` 被 `.gitignore:54` 排除。本文档 §5 中所有落在 `.khy/`
> 下的改动（skills manifest、hooks.json、rules/、agents/、preferences.json）
> **不进入版本控制、不可从 git 恢复**，属本地运行时状态；只有落在 `services/`、
> `platform/`、`scripts/`、`docs/` 的改动受追踪。

---

## 一、编号与定位

### 1.1 编号

`DESIGN-ARCH-112` 被 [DESIGN-ARCH-112] 自身占用（2026-09-16）。
`113` 被 `AI修改三模态反馈契约-客户模式` 占用，`114` 被 `CLI 错误标准化规范` 占用，
`115` 被 `TUI 启动板块设计` 占用，`116` 被 `khyos-插件系统契约(@khy/plugin-sdk)` 占用，
`117` 被 `khy-多端入口矩阵` 占用，`118` 被 `HQ 能力吸收与多机协作规范` 占用。

**因此取 `121`**（`119`–`120` 留作缓冲，避免与并行写入冲突）。
`00_INDEX_设计-分类索引.md` 尾部注记「当前下一个空号为 116」已过期，需一并更正。

### 1.2 与既有章节映射的关系

`[DESIGN-ARCH-112]` §一 已把「书 10 章 → khyos 设计文档」排好号（113–120）。
本文档**不改动那套映射**，而是新增一层：在章节落地之前，先把**跨章节的借鉴决策**
固化下来，理由是 `[DESIGN-ARCH-112]` §七 的病灶表暴露了一个结构性问题——

> 12 条病灶里 **7 条落在「机制齐备但配置/数据为空」** 这一形态上
> （hooks 零挂载、allowed-tools 0/48、agents 目录空、when_to_use 0/48、
> rules 无目录、偏好仅 1 键、MCP 无分层）。

书的对应章节会把这 7 条当「去修」处理；但它们的**共性根因**是
**「运行时目录与仓库目录之间缺少一条版本受控的种子通道」**，
单独逐章修会重复劳动。本文档第 4 章把这条根因单独抽出来作为 K-01。

---

## 二、全书机制 → 借鉴决策总表

**分级口径**：

| 标记 | 含义 |
| --- | --- |
| ✅ **采纳** | 书有、khyos 缺或无对应语义，且 khyos 架构允许直接落地 |
| 🔄 **改造采纳** | 书的做法有价值但载体/路径与 khyos 协议冲突，需换载体后落地 |
| 🔁 **已具备** | khyos 现状等于或强于书的做法，**不重复建设**，只登记防止误改 |
| ❌ **不采纳** | 与 khyos 架构或文件格式协议冲突，或收益低于成本 |

| # | 书中机制 | 出处 | 决策 | khyos 现状（2026-09-17 实测） |
| --- | --- | --- | --- | --- |
| M-01 | 五层记忆体系（企业/用户/项目/**规则**/本地） | ch02 §2.2 | 🔄 | 三文件加载已强于书；**规则级、本地级未成体系** |
| M-02 | `.claude/rules/` + `paths:` Glob 条件化加载 | ch02 §2.4 / ch10 §10.4.1 | ✅ **P0** | `.khy/rules/` **不存在** |
| M-03 | CLAUDE.md 500 行 / 「三问框架」/ 脆弱性测试 | ch02 §2.3 / ch10 §10.5.1 | ✅ | `CLAUDE.md` 201 行✅；`AGENTS.md` **796 行**❌ 超阈 |
| M-04 | 渐进式披露三层模型 | ch03 §3.3 | 🔄 | `formatSkillListing` 有 budget，但无「正文 / 引用文件」分层 |
| M-05 | description = 语义指纹（含 `Use when`/`Not for`） | ch03 §3.4.2–3.4.3 | 🔁 → ✅ | `when_to_use` **16/43**；无 `Not for` 负向约束字段 |
| M-06 | 参考型 vs 任务型 Skill（`disable-model-invocation`） | ch03 §3.4.4 | ✅ **P0** | 字段不存在；副作用技能与知识技能混在同一预算池 |
| M-07 | allowed-tools 最小权限 + `Bash(prefix:*)` 前缀语法 | ch03 §3.6 | 🔄 | 闸门 `toolCalling.js:212` 就绪、**0/48 配置**；**且仅对 handler 技能生效** |
| M-08 | `$ARGUMENTS` 参数传递 + `` !`command` `` 动态注入 | ch03 §3.7 | ✅ | 无对应机制 |
| M-09 | Skill 测试三件套（触发/功能/性能，90%/5% 阈值） | ch03 §3.11 | ✅ **P0** | 无任何 skill 测试 |
| M-10 | 作用域四级 + 优先级（企业>个人>项目>Plugin） | ch03 §3.8 | 🔁 | 已有 `builtin/bridge` 双轨 + `skills/index.js:140` 发现顺序 |
| M-11 | SKILL.md 正文 = **路由器**（Quick Reference 表） | ch03 §3.5.1 | ✅ | `prompt.md` 多为线性散文 |
| M-12 | 契约式引用（触发时机 + 资源位置 + 预期产出） | ch03 §3.5.2 | ✅ | 无引用契约规范 |
| M-13 | 子智能体五模式（只读/执行/并行/流水线/团队） | ch04 §4.4 | ✅ | **26 个**内置 agent 存在，**模式未显式化** |
| M-14 | 上下文「报文传输」不可共享内存 → **交接契约** | ch04 §4.3/§4.4.4/§4.8 | ✅ **P0** | 无交接契约规范 |
| M-15 | 子智能体 Token 经济学（输入>>输出 判据） | ch04 §4.6 | ✅ | 无委派判据 |
| M-16 | 子智能体 Frontmatter 内联 hooks | ch05 §5.8.1 | 🔄 | 用户级 agents 目录空；hook 事件面已铺 |
| M-17 | Hooks 17 事件 / 3 处理器阶梯 / 退出码 2 / `stop_hook_active` | ch05 §5.2–5.5 | ✅ **P0** | 11 事件已实现 + `hr.blocked`；**`.khy/hooks.json` 不存在** |
| M-18 | 「先观测后管控」三步走（先用 `matcher:"*"` 审计） | ch05 §5.11 | ✅ **P0** | 无审计 hook |
| M-19 | 异步 hooks（`async:true`，仅 command 型，无拦截力） | ch05 §5.9 | ✅ | 无 |
| M-20 | 权限 5 模式 + `deny→ask→allow` 评估序 | ch10 §10.3 | 🔄 | `permissions.json: profile "yolo"`，`rules: {}` **空** |
| M-21 | `.md` 忽略 + `permissions.deny` 双保险 | ch10 §10.3.3 | ✅ | 无 read 级 deny |
| M-22 | 成本控制：模型分层 / `--max-budget-usd` / 缓存 / 思考预算 | ch10 §10.1 | 🔄 | 有 `IterationBudget` + token governor（`ceiling`），**`ceiling=0` 时禁用** |
| M-23 | 调试三支柱（`--debug` / `stream-json` / 审计 hook / 会话种子） | ch10 §10.2 | 🔄 | `--output-format stream-json` 已有；无 debug 类别过滤 |
| M-24 | 异常三分类诊断序（上下文缺失 → 指令冲突 → 权限不足） | ch10 §10.2.5 | ✅ **P0** | 无诊断协议 |
| M-25 | 大型代码库六项（层次化 CLAUDE.md / 引导式搜索 / Explore / 压缩） | ch10 §10.4 | ✅ | 有 `contextCompressor`、Explore 型内置 agent |
| M-26 | 团队落地四阶段 + `.claude/` 共享策略表 | ch10 §10.6 | ✅ **P0** | `.khy/` 全被 gitignore → **无共享策略** |
| M-27 | 受管设置（managed-settings，不可覆盖） | ch10 §10.6.3 | ❌→✅ | khyos 单机单用户，无组织级；但 `profile:"yolo"` 需等效硬顶 |
| M-28 | MCP 三层作用域 + 首次审批 + OAuth + 版本锁定 | ch06 §6.8 / ch10 §10.3.5 | 🔄 | `.khy/mcp.json` 1 服务器，无分层/无信任流程 |
| M-29 | MCP + Skills = 厨房 + 菜谱 | ch06 §6.9 | ✅ | 两者均已有，**缺显式协作约定** |
| M-30 | Headless 四维度参数 + JSON 成本元数据 | ch07 §7.2 | 🔁 → ✅ | 五参数全在 `printOutputFormat.js`；**未接 CI** |
| M-31 | CI 落地四阶段（观察者→顾问→门禁→主动修复） | ch07 §7.12 | ✅ | `.github/workflows/` 存在但未接 khy |
| M-32 | Agent SDK 四道安全防线 | ch08 | 🔁 | 无对外 SDK（`[DESIGN-ARCH-112]` §3.4 留第 8 章裁决） |
| M-33 | 自定义工具 = 进程内 MCP 服务器（`@tool`） | ch08 §8.6 | ✅ | 无 |
| M-34 | Plugin 打包 + 命名空间 + 可逆安装 | ch09 | 🔁 | **已有** `[DESIGN-ARCH-116]` `@khy/plugin-sdk` 契约（26 测试全绿） |
| M-35 | 六层加载优先级 + 子智能体 > 项目 > 用户 | ch02/ch04/ch10 | 🔁 | `prompts.js:1746` KHY>CLAUDE>AGENTS 已实现 |
| M-36 | SDD 四层生态 + 工作流组合 | ch10 §10.7 | 🔄 | `.khy/plans/` 已有 plan JSON；无跨平台规范层 |

**统计**：36 条中 ✅ 采纳 17 条、🔄 改造采纳 10 条、🔁 已具备 8 条、❌ 不采纳 1 条。

---

## 三、P0 借鉴项详析（12 条）

以下每条按 **【书中的做法】【为什么对 khyos 适用】【可落地方案】【验收】【整合方式】** 展开。
优先级口径：**P0 = 不改一行核心代码即可获得收益，或修复的是「机制齐备但配置为空」的零成本缺口**；
P1 = 需要新增小规模代码或规范；P2 = 需要设计决策或跨模块协作。

---

### K-01 `.khy/rules/` 条件化规则系统 —— 修复「规则散在三处」

**优先级 P0** ｜ 书中出处 ch02 §2.4、ch10 §10.4.1 ｜ 决策 ✅ 采纳

**【书中的做法】** 在 `.claude/rules/` 下放多个独立 `.md`，每个文件在 YAML frontmatter 里用
`paths:` 声明一组 Glob：

```yaml
---
paths:
  - "**/*.test.ts"
  - "tests/**"
---
# 测试规范
- 采用 vitest，禁用 jest
```

只有 Claude 操作的文件路径命中 Glob 时，该规则才注入上下文；不命中则静默躺在磁盘上，
**零 token 消耗**。未声明 `paths:` 的文件被视为全局无条件规则，效果等同写进 CLAUDE.md。

**【为什么对 khyos 适用】**

1. `[DESIGN-ARCH-112]` §3.1「真缺口 1」明记：khyos 的规则**散在 RULES-REGISTRY（67 条）、
   `CLAUDE.md` 红线、`AGENTS.md` 工程规则三处，缺统一的条件化加载键**。
2. khyos 的规则总量远大于书：`RULES-REGISTRY.json` 登记 **67 条**，
   `docs/10_规范/` 有 **165 份规范**。全量常驻必然稀释注意力——
   正是书 §2.3「指令数突破 150 条临界值后遵循质量显著衰减」所指的失效区。
3. khyos 已有 section 级覆盖基础设施（`prompts.js:1763` 的 `_hasKhyLanguageDirective` /
   `_stripCompatLanguageSections`）与鲜度键（`promptSectionTaxonomy.js:226` 折入
   `mtime:size`）。**新增一个「path → 规则文件」的条件化选取层，是接在这套现成机制上，
   不是从零建第二套记忆系统。**

**【可落地方案】**

| 步骤 | 动作 | 落点 |
| --- | --- | --- |
| 1 | 建目录 `.khy/rules/`（**仓库内**，见 K-13 的种子通道） | 仓库根 |
| 2 | 写 4 个试点规则文件，只覆盖 khyos 最痛的路径域 | 见下表 |
| 3 | 新增选取器 `selectRulesByPaths(cwd, changedPaths)` | `services/backend/src/services/domain/extensions/rules/`（**不新建顶层目录**，遵守 `[DESIGN-LAY-005]`） |
| 4 | 接入 `promptSectionTaxonomy.js` 的鲜度键：规则文件 `mtime:size` 折入，改文件当轮生效 | 同上 |
| 5 | 未命中路径 → 该段不进系统提示；`--debug` 时输出「本次命中 N/M 条规则」 | 调试可见性 |

**试点规则文件（4 个，控制在 30 行内/个）**：

| 文件 | `paths:` | 内容来源 |
| --- | --- | --- |
| `.khy/rules/backend-services.md` | `services/backend/src/**` | `AGENTS.md` RUNTIME-001~004 的运行时条款 |
| `.khy/rules/frontend.md` | `apps/ai-frontend/**`, `platform/packages/ui-shared/**` | G3 版本轨道对齐 + 组件规范 |
| `.khy/rules/docs.md` | `docs/**` | `FILE-FORMAT-PROTOCOL.md` 摘要（LF / 标题不跳级 / 行宽 ≤120） |
| `.khy/rules/scripts-ci.md` | `scripts/ci/**` | 三守卫的调用契约 |

**关键约束：载体必须是 JSON，不是 YAML frontmatter。**
`docs/10_规范/其它规范/FILE-FORMAT-PROTOCOL.md` §2.5 规定 YAML **仅允许用于 CI/CD 与 ML 配置**。
因此 khyos 的规则文件用 **`rule.json` + `body.md` 同目录**（同 `manifest.json` + `prompt.md` 的既有惯用法）：

```text
.khy/rules/testing/
├── rule.json          # { "version":1, "id":"testing", "paths":["**/*.test.js","tests/**"], "priority":50 }
└── body.md            # 规则正文（纯 Markdown，给模型读）
```

这是本文档最需要坚持的一条改造：**照抄 `paths:` 语义，但换掉 YAML 载体**，
否则会直接违反格式协议并被 `check-change-safety.js` 拦下。

**【验收】** ① `node scripts/ci/check-change-safety.js --changed` 绿；
② `khy doctor` 绿；③ `--debug` 下改一个 `services/backend/**` 文件，日志显示仅
`backend-services` 命中、另 3 条未命中；④ `.khy/rules/` 全量缺失时行为与现状
**byte-identical**（feature flag `KHY_RULES_PATHS` 默认 off，先 dry-run）。

**【整合方式】** 接入点 `prompts.js:1733` 段的三文件加载之后、`promptSectionTaxonomy`
之前，作为**第五个记忆层**（对应书 §2.2 的「规则级」）。
与 `[DESIGN-ARCH-113]`（记忆系统）**共用**同一鲜度键与 section 剥离逻辑，不新建并行通道。
新增 1 条规则登记到 `RULES-REGISTRY.json`，类别 `LAYOUT`，門绑定按 `[DESIGN-ARCH-111]`。

---

### K-02 Skill 参考型 / 任务型二分 + `disable-model-invocation`

**优先级 P0** ｜ 书中出处 ch03 §3.4.4 ｜ 决策 ✅ 采纳

**【书中的做法】** `disable-model-invocation: true` 的技能，`description` **不注入**模型上下文，
只能由用户 `/skill-name` 显式触发。判据是「**最坏情况测试**」：

> 如果 Claude 自动执行这个任务，最坏情况是什么？如果答案让你紧张
> （自动提交未测试代码、自动部署含 bug 版本、自动删生产数据），必须选任务型 Skill。

书的配套洞察：任务型 Skill 的 `description` **不占预算池**，因此
「隐藏内部工具」是**释放 description 预算**的正当手段（ch03 §3.3.2 技巧 1）。

**【为什么对 khyos 适用】**

khyos 当前的失效模式**恰好是书描述的极端情形**：

1. 48 个技能的 `description` 全部常驻、全部平等地抢同一个预算池，
   实测预算 5120 字符、**被截断 40 行**（`[DESIGN-ARCH-112]` §3.2.1）。
2. 而 `CLAUDE.md` 红线 **R1 明确「禁止 AI 自动 commit/push」**、
   **R2 密钥防泄露**、**R4 上帝文件门**——这些都是**副作用操作**，
   但在技能层**没有任何「禁止模型自动触发」的声明**。
   规则写在 `CLAUDE.md` 里是「建议」（书 §5.1 的原话：CLAUDE.md 是交通标志，
   不是路障），技能层却是开放的。
3. 收益是**双向**的：任务型技能从预算池消失 → 剩余 40 个技能的 `maxDescLen`
   回升 → 触发短语不再被 `slice(0, descLen-1)` 砍掉。

**【可落地方案】**

1. 在 `manifest.json` 增加两个**可选**字段（缺省 `false`，保持向后兼容）：

```json
{
  "version": 1,
  "id": "commit",
  "disableModelInvocation": true,
  "userInvocable": true,
  "whenToUse": "...",
  "notFor": "..."
}
```

2. `formatSkillListing`（`skills/index.js:243`）中，`disableModelInvocation === true` 的条目
   **跳过预算池计算**，只在 `/` 菜单渲染（用户可见，模型不可见）。
3. **首批标记清单**（依据 `CLAUDE.md` R1/R2/R4 与既有技能清单，需人工复核）：

| 技能 | 标记 | 依据 |
| --- | --- | --- |
| `git-workflow-and-versioning` | `disableModelInvocation: true` | R1 禁止 AI 自动 commit/push |
| `ci-cd-and-automation` | `disableModelInvocation: true` | 触发流水线 = 外部副作用 |
| `security-and-hardening` 的密钥轮换子流程 | `disableModelInvocation: true` | R2 |
| `documentation-and-adrs` / `context-engineering` | **保持参考型** | 最坏情况 = 多写一段文档，无关痛痒 |
| `code-review-and-quality` | **保持参考型** | 只读审查，无副作用 |

4. **`notFor` 字段**（书 ch03 §3.4.3 的负向约束）：与 `whenToUse` 对称渲染，
   用于治过触发。`formatLine` 现在只剩
   `cmd.whenToUse ? ' (use when: ' + ... : ''`（`skills/index.js:289` 附近），
   扩展为 `whenToUse` 与 `notFor` 双段，且**两段都计入 overhead**——
   这正是 `[DESIGN-ARCH-112]` §8.1 已修过的那个静默溢出 bug，不能再犯一次。

**【验收】** ① 标记后 `formatSkillListing` 输出字符数**上升**且被截断行数**下降**
（对比 2026-09-16 实测基线：5120 预算下 5071 字符 / 截断 40 行）；
② `/` 菜单中任务型技能仍可见；③ 模型侧目录中不再出现任务型技能；
④ `check-agent-rules.js --changed` 绿。

**【整合方式】** 字段加入 `manifest.json` schema；渲染改动局限在
`services/backend/src/skills/index.js` 的 `formatSkillListing` 与 `formatLine` 两处，
不触碰 `skillSearch.js` 的匹配逻辑。与 `[DESIGN-ARCH-114]`（Skills 规范）合并交付。

---

### K-03 Hooks 落地：先审计、后拦截的三步走

**优先级 P0** ｜ 书中出处 ch05 §5.11、§5.6 ｜ 决策 ✅ 采纳 ｜ **高风险章，须 dry-run**

**【书中的做法】** 明确的三步演进：

1. **第一步**：只配 `PostToolUse` + `matcher:"*"` 的审计日志 hook，跑数日，观察真实工具调用模式。
2. **第二步**：基于审计数据识别高风险模式，设计 `PreToolUse` 拦截规则。
3. **第三步**：逐步收紧，**始终保留日志**，误拦截时能快速定位。

配套的工程细节（全部值得抄）：

| 细节 | 书中的规定 |
| --- | --- |
| stdout / stderr 分工 | stdout **只能**输出 JSON 决策；调试信息必须 `>&2`，否则 JSON 解析失败 |
| 退出码语义 | `0` = 用 stdout 的 JSON；`2` = **有意阻止**（stderr 作为原因回给模型）；其他 = 脚本自身故障，**不阻断主流** |
| 死循环防护 | `stop_hook_active` 为 true 时必须放行——「如递归函数必须设终止条件」 |
| 处理器降级序 | 「能用 command 的不用 prompt，能用 prompt 的不用 agent」——确定性 > 理解力 |
| 优雅降级 | `command -v` 检查工具是否存在，缺了就静默跳过而非抛错 |
| 误拦截治理 | 「在提交 Hook 配置前必须与团队充分讨论」「每个拦截规则必须附带清晰原因」 |

**【为什么对 khyos 适用】**

1. khyos 的 hooks **运行时已经是完整实现**：`hookRegistry.js` 有 11 个事件、
   `hr.blocked` 阻断、`preventContinuation` 优雅停机、`_stopHookActive` 防无限续跑
   （`toolUseLoopCore.js:3216`）、`hookContribSeams.tighten` 强制单调收紧。
   **缺的只是 `.khy/hooks.json` 这一个文件**——`[DESIGN-ARCH-112]` §四 称之为
   「通电未挂线」。这是全书**性价比最高的单点动作**。
2. khyos 已有 `scripts/ci/check-*.js` 三个守卫，它们是**现成的 command 型 hook 脚本**，
   只是目前只在 CI 里跑、不在交互会话里跑。挂载它们等于把 CI 的确定性检查
   **平移到会话内**，无需新写脚本。
3. 书 ch05 开篇的 `.env` 泄露事故，在 khyos 有**直接对应的红线 R2**：
   「真 key/token 永不进 bundle / 源码 / 提交」。
   而 R2 目前**只有 CI 层的 `wheel` 扫描**，会话内的写文件动作**零拦截**——
   即「深夜误提交」的场景在 khyos 完全无防护。
4. 书 §5.11 的「Hooks 是团队级基础设施，不是个人实验玩具」在 khyos 更尖锐：
   `.khy/hooks.json` **不入版本控制**（`.gitignore:54`），所以每一步都必须有
   **一键关闭开关**，否则出错时无法从 git 回滚。

**【可落地方案】**

**阶段 0（dry-run，必须先做）**：新增 `KHY_HOOKS_DRYRUN=1` 环境变量。
置位时所有 hook **只写日志、不返回决策**，stdout 恒 `{}`。
在 `hookRegistry.js` 的派发点加一个短路分支，改动 ≤20 行。

**阶段 1（审计，只读，零风险）**：
写 `.khy/hooks.json`，只挂一个：
```json
{
  "version": 1,
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "node scripts/hooks/audit-log.js", "async": true, "timeout": 10 }
      ]}
    ]
  }
}
```
`scripts/hooks/audit-log.js` 按书 ch05 §5.6.3 的字段写 NDJSON：
`[ISO8601] tool_name | JSON.stringify(tool_input)`，落 `.khy/audit/hooks-YYYY-MM-DD.ndjson`。
**标记 `async: true`**（书 §5.9）——审计属「事后处理」，夺取不了拦截时机，
异步化避免拖慢每一轮工具调用。

**阶段 2（拦截，dry-run 数日后开真）**：基于阶段 1 的真实数据设计，首批只挂两条：

| 事件 | matcher | 脚本 | 规则 |
| --- | --- | --- | --- |
| `PreToolUse` | `Write\|Edit` | `scripts/hooks/protect-secrets.js` | 文件名命中 `.env*` / `*credentials*` / `*.pem` / `*.key` / `id_*` → `deny`，原因按书要求写具体 |
| `PostToolUse` | `Write\|Edit` | `scripts/hooks/ci-guard-fast.js` | 对刚写入的文件跑对应守卫的**单文件模式**，结果经 `additionalContext` 回注；发现即让模型自查 |

**第三道（Stop 质量门控）暂缓**：khyos 的 `toolUseLoopCore.js:3216` 已有
`_stopHookActive` 防续跑，但 Stop hook 会**强制延长会话**，
在 khyos 的 token 预算体系下会与 `IterationBudget` 交互，属 `[DESIGN-ARCH-116]` 的高风险项，
本文档不提前落地。

**【验收】** ① dry-run 模式跑满 1 个工作日的审计日志，人工确认无误拦截；
② 真实拦截开启后，构造 `.env` 写入用例 → 被 deny，且原因文案可读；
③ 三守卫 `--changed` 全绿；④ `khy doctor` 绿；
⑤ **一键关闭**：删/改 `.khy/hooks.json` 或置 `KHY_HOOKS_DISABLED=1` 后行为回到现状。

**【整合方式】** `hookRegistry.js:66` 的项目级路径已在本轮前置修复中从
`.khyquant` 更正为 `.khy`（`[DESIGN-ARCH-112]` §8.1），**路径已就绪**。
脚本落 `scripts/hooks/`（与 `scripts/ci/` 平级，**不新建顶层目录**）。
事件选择锁定在 khyos **已实现的 11 个**事件内，不引入书里 khyos 未实现的
`TeammateIdle` / `TaskCompleted` / `WorktreeCreate` / `WorktreeRemove` / `ConfigChange`。
与 `[DESIGN-ARCH-116]`（Hooks 设计）合并交付。

**加载机理（2026-09-17 实测，K-03 施工前必读）**：
`hookRegistry.load(projectDir)` 按 **global → project** 顺序加载**两份**配置
（`:59-70`），project 级覆盖 global：

| 来源 | 路径 | 真源 |
| --- | --- | --- |
| global | `<getAppHome()>/hooks.json` | `hookRegistry.js:38-45` |
| project | `<projectDir>/.khy/hooks.json` | `hookRegistry.js:67` |

三处施工要点：
1. **配置文件结构是 `{ hooks: [], disabled: [] }`**，或直接是数组
   （`:78-80` 用 `Array.isArray(raw) ? raw : raw.hooks || []` 兼容两种形态）。
   K-03 建议用对象形态，以便用 `disabled` 做**单条熔断**而不必删配置——
   这是「一键关闭」之外更细的回滚粒度。
2. `:43` 的 catch 分支回退到 `~/.khyquant/hooks.json`，**这不是漏改**：
   `utils/dataHome.js` 明确声明 `getAppHome()` 的第 5 条兜底「never fails」，
   该分支是极端防御。但施工时**不要**把 hooks 写到这个路径，
   否则会散在 legacy 目录里。
3. global 与 project **同名 hook 的行为取决于合并逻辑**，
   K-03 首次落地时**只用 project 级**（`.khy/hooks.json`），
   避免引入「用户全局配置 vs 仓库配置」的仲裁问题——那是书 §5.7「配置 6 层优先级」
   的议题，khyos 尚无对应需求，**不要提前引入**。

---

### K-04 子智能体「交接契约」（Handoff Contract）

**优先级 P0** ｜ 书中出处 ch04 §4.4.4、§4.8 ｜ 决策 ✅ 采纳

**【书中的做法】** 书中把这个机制讲得比任何一节都细：

> 子智能体之间**无法直接通信**：每个子智能体仅能获取主智能体显式传递的内容，
> 既无权访问主对话的历史记录，也无法感知其他子智能体的存在。
> 这种信息交互机制属于「**报文传输**」而非「共享内存」——
> 主智能体必须将 A 的结论提取出来，并嵌入 B 的任务描述中，B 方能获得信息。

由此推出流水线模式的关键技术细节：**每个阶段的输出格式必须与下一阶段的输入要求严格匹配**。
书给了完整示例——`bug-locator` 的输出固定为
`根本原因文件 / 问题描述 / 调用链 / 修复方向` 四段，而
`bug-fixer` 的输入恰好吃这四段。定义文件里明确标注
「**下游阶段依赖此格式，请严格遵守**」。

**【为什么对 khyos 适用】**

1. khyos 已有 **26 个**内置 agent（`services/backend/src/agents/built-in/*.js`，
   注册表 `builtInAgents.js` 262 行；含 `khyGuideAgent` / `fixAgent` / `mapAgent` /
   `verificationAgent` / `auditAgent` / `exploreAgent` / `planAgent` 等），
   `SubAgentStart` / `SubAgentEnd` 事件面已预留。
   `[DESIGN-ARCH-112]` §3.2.2 的落点修正说得很准：
   **不是从零建机制，而是「缺用户级定义格式与委派链路的权限收敛」**。
   > 📌 2026-09-18 复核订正：原稿此处写「5 个内置 agent」，**实测为 26 个**。
   > 且加载器 `services/backend/src/agents/loadAgents.js`（314 行）、schema、
   > 六层优先级（`builtIn→plugin→user→project→flag→managed`）、调用链
   > （`agents/index.js:30 → loadCustomAgents(cwd)`）**全部已具备**，
   > 唯一缺口是 `.khy/agents/` 与 `~/.khy/agents/` 目录为空。
   > 详见 [`[DESIGN-ARCH-123]`](%5BDES[DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md。
2. 而 khyos 的委派链路**最缺的正是交接契约**：`verificationAgent.js:46` 的提示词已含
   「Read the project's CLAUDE.md and/or README … to discover build/test commands」，
   即 agent 被赋予**自主探查**的自由——这在书的口径里是**反模式**，
   因为它把「上游该给什么」变成了「下游自己猜」，
   正是书 §10.2.5 诊断序第一类「上下文缺失」的典型症状。
3. `[DESIGN-PROCESS-001] 委派边界决策矩阵` 已定义**谁做 vs 怎么做**的准入闸门
   （G1 点名 / G2 能力缺失 / G3 需隔离），本文档的 K-05 补的是**「给了什么」**，
   两者正交，可并存。

**【可落地方案】**

产出一份**交接契约规范**（落 `docs/10_规范/`，作为规范族新成员 `AGENT-HANDOFF-PROTOCOL.md`），
正文只规定一件事：**每个流水线阶段必须声明「我吃哪几段、我吐哪几段」，且段名集合必须闭包。**

规范骨架：

```markdown
## 段落字典（唯一真源，段名不可自由发明）

| 段名 | 类型 | 产出方 | 消费方 |
| --- | --- | --- | --- |
| `root_cause_file` | `path:line` | locator | fixer, report |
| `root_cause_brief` | 一句话 | locator | fixer |
| `call_chain` | 路径列表 | locator | report |
| `changed_files` | 路径列表 | fixer | verify, report |
| `verify_result` | `pass|fail` | verify | report |
| `residual_risk` | 文本 | verify | report |
| `suggested_test_cmd` | shell 命令 | fixer | verify |
```

规则三条：

1. **段名只允许取自字典**。新增段名须先改字典（单一真源），不允许 agent 定义里就地发明。
2. **每个 agent 定义必须有两段**：`## 输入契约`（列出依赖的段名 + 缺失时的行为，
   书要求「若遇到无法解决的问题，请立即报告并停止操作，切勿反复尝试」）
   与 `## 输出契约`（列出产出的段名，逐段一行）。
3. **缺失即停机**，不允许「自行探查补齐」——这是与书 §10.5.2「明确边界」一致的收紧。

**【验收】** ① 用 1 个小任务跑通
`locator → fixer → verify` 三段链路，人工核对每段实际产出与契约声明的段名**完全一致**；
② 故意抽掉 `root_cause_file` 段，验证下游 `fixer` **拒绝执行并报告缺失**，而非瞎猜；
③ 该验收正是 `[DESIGN-ARCH-112]` §七 病灶 4 要求的「先用 1 个小任务验证委派链路」。

**【整合方式】** 与 `[DESIGN-PROCESS-001]` **正交并存**（一个管准入、一个管交接）；
agent 定义文件格式由 `[DESIGN-ARCH-115]`（子智能体设计）定稿，
本文档只锁「契约段名闭包」这一条不变量。
5 个内置 agent 的契约改造**逐个人工过**，不做批量脚本改写（红线 B3 外科手术式改动）。

---

### K-05 子智能体委派的 Token 经济学判据

**优先级 P0** ｜ 书中出处 ch04 §4.6 ｜ 决策 ✅ 采纳

**【书中的做法】** 书给了一个反直觉结论并**附了可核算的算式**：
合理使用子智能体不是增加成本，而是降低总 Token。

关键算式（书原样）：

```text
不使用子智能体：10 000 Token 测试输出进入主对话 ×
  后续 5 轮每轮重复携带 → 第5..9轮累计 125 000 Token
使用子智能体：子智能体内部累计 41 000 + 主对话（仅 100 Token 摘要）75 500
  = 116 500  → 节省 8 500（约 6.8%）
```

书同时**诚实地给了反例**：Prompt Caching 会把节省率从 6.8% 稀释回 **1%–2%**，
因此**成本不是核心价值**，另两个维度才是：
**上下文窗口保护**（避免提前触发压缩、关键信息被判低优先级丢失）与
**响应质量提升**（避免注意力稀释）。

最后给出**决策判据**：

| 场景 | 判据 | 结论 |
| --- | --- | --- |
| 高价值（输入 >> 输出） | 数百行日志 → 5 行结论 | 用子智能体 |
| 低价值（输入 ≈ 输出） | 改一个函数、写一段注释 | **不用**，直接在主对话做 |

四个启用维度：大规模文件读取（>5 个文件）、高频输出生成、上下文完整性保护、操作权限与安全边界。
以及一条硬约束：**嵌套层级 ≤ 2 层**，「若发现需要 3 层以上，说明任务分解粒度有缺陷」。

**【为什么对 khyos 适用】**

1. khyos **已经有内建的「大输出任务」场景且没有委派判据**：
   三守卫 `check-*.js` 在仓库级扫描时输出很长，
   `khyos` 的设计文档流水线（`docs:build` / `docs:verify`）也有大输出。
   目前这些输出**直接进主对话**，正是书说的「注意力稀释」。
2. **khyos 的成本结构让判据更值钱**：khyos 走多供应商 AI 网关
   （`services/backend/src/services/gateway/aiGateway.js`），
   不同供应商的 input/output 价差比书中的 Claude 单品更大。
   书 §10.1.1 的洞察「输出成本远高于输入，因此控制输出长度比控制输入更有效」
   在 khyos 的多供应商场景下**乘以供应商价差倍数**。
3. ⚠️ **khyos 有一处必须与书不同的地方**：khyos 已有 `prompt` 缓存与
   token-budget governor（`toolUseLoopCore.js` 的 `ceiling` 参数）。
   书的 6.8% 在 khyos 会被缓存进一步稀释。
   **因此本文档建议：把书的三条收益按 khyos 优先级重排为
   「上下文窗口保护 > 响应质量 > 成本」**，并以
   `contextWindowGuard.js` 的余量水位作为**首要触发信号**，
   而非成本。这是对书结论的**必要修正**，不是照抄。

**【可落地方案】**

产出一份判据卡（落 `docs/10_规范/AGENT-HANDOFF-PROTOCOL.md` 附录，与 K-04 同文件）：

```text
【委派判据卡 v1】
前置：已通过 [DESIGN-PROCESS-001] 三闸门（G1/G2/G3）之一，否则一律 khy 自做。

满足以下任一条 → 委派子智能体：
  A. 预计读取文件 > 5 个
  B. 预计单次工具输出 > 3000 token 且 最终结论 < 200 token（饱和比 > 15:1）
  C. contextWindowGuard 余量 < 30%
  D. 操作涉及写入/网络/外部命令（需权限收敛到沙箱）

禁止委派（对应书「输入 ≈ 输出」）：
  - 改一个函数 / 写一段注释 / 单文件格式检查

硬约束：
  - 嵌套 ≤ 2 层；需要 3 层时改为并行或扁平
  - 委派必须携带 K-04 的段名闭合契约
  - 中断恢复：中间产物落 .khy/agent-workspaces/<agent>/<task>.md（书 §4.8）
    已有目录 `.khy/agent-workspaces/` 实测存在，可直接复用
```

**【验收】** ① 判据卡落入规范并登记 `RULES-REGISTRY.json`；
② 用一个真实大输出任务（如对 `services/backend/` 跑一次全量守卫）对比
「直接在主对话跑」vs「委派 verificationAgent」的 `usage.input_tokens` 与
`cache_read_input_tokens`（`--output-format json` 已能给出这两个字段，
见 K-10）；③ 数字支持判据则保留，不支持则**据实修订判据**而非保留一张漂亮但错的卡。

**【整合方式】** 依赖 K-04 的契约段名体系；与 `[DESIGN-PROCESS-001]` 串联成
「准入 → 交接 → 判据」三段。中间产物复用实测已存在的 `.khy/agent-workspaces/`。

---

### K-06 大型代码库：引导式搜索 + 压缩保留清单

**优先级 P0** ｜ 书中出处 ch10 §10.4.2、§10.4.4 ｜ 决策 ✅ 采纳

**【书中的做法】**

**（a）引导式搜索，替代全量阅读。** 书在 CLAUDE.md 里直接写导航原则：

```markdown
## 代码库导航原则
在处理涉及多文件的任务前，请严格遵循以下步骤。
1. 使用 Grep 搜索关键函数名、类名或错误码，精准锁定相关文件范围。
2. 利用 Glob 列出目标目录的文件结构，快速把握整体组织逻辑。
3. 仅 Read 最相关的 2 至 3 个核心文件的具体内容。
4. 严禁在无明确目标的情况下进行大范围文件读取。
5. 对于可能产出大量输出的任务，应委托给子智能体处理。
```

**（b）压缩保留清单。** 书给出 CLAUDE.md 里的预设压缩规则：

```markdown
## 压缩策略
当进行上下文压缩时，必须始终保留以下内容。
- 所有已修改文件的完整路径列表。
- 失败的测试用例及其具体的错误堆栈信息。
- 当前任务尚未完成的剩余步骤。
```

以及 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 可把自动压缩从 95% 提前到 50%。

**【为什么对 khyos 适用】**

1. **khyos 的仓库规模让这条从「优化」变成「必需」**：
   `docs/` 有 **238 份设计文档 + 165 份规范**，
   `AGENTS.md` 单文件 **796 行**，`toolUseLoopCore.js` **8000+ 行**。
   书算过：20 万 token 窗口扣除 System Prompt / CLAUDE.md / 历史 / 工具定义 / 安全余量后，
   实际可用代码空间约 14.3 万 token ≈ 3.5–4 万行。
   **khyos 单是 `toolUseLoopCore.js` 就吃掉近四分之一。**
   书：「对于大型项目，无法将其一次性全量载入上下文，必须采取分块处理」——
   这条对 khyos 是**字面成立**的。
2. khyos 已有 `contextCompressor.js` + `contextWindowGuard.js`，
   **缺的正是「压缩时保什么」的显式清单**——压缩器有算法，没有业务优先级。
3. 导航原则落点现成：`CLAUDE.md` 仅 201 行，**远低于 500 行阈值**，
   有充裕空间加一段导航原则。这是**零代码改动**的收益。

**【可落地方案】**

1. **在 `CLAUDE.md` §二 B 段之后新增一小节「代码库导航原则」**，
   直接采纳书 §10.4.2 的五步，并把 khyos 的具体入口写进去：

```markdown
## 代码库导航原则（B4）
本项目有 238 份设计文档与 165 份规范，禁止全量读取。处理多文件任务时：
1. Grep 关键符号定位（设计文档先查 `00_INDEX_设计-分类索引.md`）
2. Glob 列出目标目录结构
3. 仅 Read 最相关的 2–3 个文件
4. 大输出任务（守卫全量扫描、日志分析）先按委派判据卡评估是否交子智能体
```

新增一条行为准则需按 `RULES-REGISTRY.json` 登记（类别 `PROCESS`）。

2. **压缩保留清单落 `CLAUDE.md`**（书原样三段 + khyos 专属第四段）：

```markdown
## 压缩策略
上下文压缩时必须保留：
- 所有已修改文件的完整路径列表
- 失败的测试用例及其错误堆栈
- 当前任务尚未完成的剩余步骤
- 【khyos 专属】本次已跑过的守卫及其结论（三守卫绿灯不得被压缩掉，避免重复跑）
```

第四段是 khyos 的原创补充：khyos 的完成定义绑定三守卫绿灯，
如果守卫结论被压缩掉，模型会**重复扫描**，成本与书 §10.1.3 的
「5000 行日志被重复付费」是同一类错误。

3. **`AGENTS.md` 拆分（P1，非 P0）**：796 行 > 书/th10.5.1 的 500 行建议。
   拆成 `AGENTS.md`（骨架 + 索引）+ `.khy/rules/*`（路径域细则，依赖 K-01）。
   **本轮不动**——K-01 未落地前拆分会导致规则无处安放。

**【验收】** ① `CLAUDE.md` 新增节后行数仍 < 300（远离 500 阈值）；
② 跑一次真实多文件任务，统计 `--debug` 下的工具调用序列，
   确认出现 Grep → Glob → Read 的收敛模式而非大范围 Read；
③ 守卫结论在压缩后仍可见（构造一次接近压缩阈值的长会话验证）。

**【整合方式】** 纯文档改动 + `RULES-REGISTRY.json` 登记，无代码依赖。
与 `[DESIGN-ARCH-113]`（记忆系统）、`[DESIGN-ARCH-121]`（工程化最佳实践）重叠部分
**以本文档为准**（本文档先出）。

---

### K-07 用户级子智能体定义格式与权限收敛

**优先级 P1** ｜ 书中出处 ch04 §4.3、§4.4.1–4.4.2 ｜ 决策 ✅ 采纳

**【书中的做法】** 子智能体定义文件 = YAML frontmatter（身份）+ Markdown 正文（职责）。
关键字段的**设计意图**书都点明了：

| 字段 | 书中说明 |
| --- | --- |
| `tools` | **最有安全价值的特性**——「任何未列出的工具对该子智能体均不可见且不可调用」，这是**物理层面**的边界，不依赖 prompt 里「请不要修改文件」这类易被忽视的建议 |
| `permissionMode: plan` | 「比工具白名单更严格的**全局性**安全机制」——整个会话被标记为只读 |
| `model` | 常被低估的成本杠杆：格式检查用 Haiku，架构审计用 Opus |
| `skills` | 预加载知识包（方向 A：子智能体是主角） |
| `memory: project` | 持久化记忆 |

书 §4.4.1 的只读型配置（`tools: Read, Grep, Glob` + `permissionMode: plan`）
是**双重保险**，这个「双重」是关键——单一手段可被绕过，两层叠加才是舱壁。

**【为什么对 khyos 适用】**

1. `.khy/agents/` 实测 **0 文件**（`[DESIGN-ARCH-112]` §3.2 已记），
   而 5 个内置 agent 的**权限是用代码硬编码的**（`src/agents/built-in/*.js`），
   用户无法声明式地加一个新审查员。这导致每加一个专业化 agent 都要改代码，
   与「可扩展 = 加能力不碰核心代码」的三性刻度直接冲突。
2. khyos 的**权限姿态当前是 `yolo`**（`.khy/permissions.json` 实测：
   `{"profile":"yolo","rules":{},"version":2}`）。在此姿态下，
   「只读型 agent」这个安全承诺**在 khyos 里无法表达**——因为 agent 层没有权限声明面。
   书 §4.4.1 的 `permissionMode: plan` 恰好补这个洞。
3. khyos 的 `types.js` 已有 `omitClaudeMd` 属性（子智能体可选择性不带项目指令），
   说明**「agent 级配置」这个概念在 khyos 已存在**，只是没有对外的声明格式。
   把它外化，是**沿着既有抽象补接口**，不是新造一层。

**【可落地方案】**

**载体：JSON，不是 YAML frontmatter**（同 K-01 的理由，`FILE-FORMAT-PROTOCOL.md` §2.5）。
沿用 khyos 的 `manifest.json` + `body.md` 惯用法：

```text
.khy/agents/payment-reviewer/
├── agent.json
└── body.md
```

```json
{
  "version": 1,
  "name": "payment-reviewer",
  "description": "审查支付模块的代码变更。当用户要求审查支付/金额/交易相关代码时使用。",
  "tools": ["Read", "Grep", "Glob"],
  "permissionMode": "plan",
  "model": null,
  "omitClaudeMd": false,
  "skills": [],
  "memory": "project",
  "inputContract": ["changed_files"],
  "outputContract": ["findings", "severity", "suggestions"]
}
```

**权限收敛（这一条是本节的核心）**：

1. `permissionMode: "plan"` 必须在**运行时**映射到 khyos 已有的
   `toolCalling.js:212` 白名单闸门 + `constraintLattice.js:275` 逃生地板
   （`ask_user` / `abort`）。
   ⚠️ **但要注意 `[DESIGN-ARCH-112]` §3.2.3 的发现**：该闸门目前**只对 handler 技能生效**，
   且激活点仅在 `skills/index.js:568` 的 handler 块内。
   **agent 侧的激活窗口与技能的激活窗口不同**（agent 有明确的 start/end 事件，
   技能没有），所以 agent 白名单**可以**可靠生效——
   因为 `SubAgentStart` / `SubAgentEnd` 给了明确边界。
   **这是 khyos 比书更容易做到的地方**：书要为技能定义激活窗口，
   khyos 的 agent 天然有窗口。
2. **双重保险必须都做**：`tools` 白名单（工具级）+ `permissionMode: plan`（会话级）。
   只做前者，agent 仍可通过已授权工具的**组合**产生副作用（书 §6.8.2 的
   「工具权限滥用」：读文件 + 发邮件 = 泄露）。

**落地顺序（对应 `[DESIGN-ARCH-112]` §七 病灶 4 的「高风险」定级）**：

| 序 | 动作 | 风险控制 |
| --- | --- | --- |
| 1 | **只读盘查**：从 26 个内置 agent 中选**一个只读型**（推荐 `exploreAgent`）外化为定义文件，**不接线**，纯做「现状外化」 | 零行为变化 |
| 2 | 验证：加载器能解析该文件，且与 `built-in/exploreAgent.js` 的硬编码配置**逐字段一致** | 一致性即验证 |
| 3 | 接线：依赖**已存在**的 `loadCustomAgents()`（`agents/index.js:30` 已在调用），确认 `.khy/agents/` 覆盖内置定义 | 加载器已就位，无需新建 |
| 4 | 首个用户级 agent：只加**只读型**（书 §4.4.1），不加执行型 | 最小权限起步 |
| 5 | 确认稳定后再考虑执行型（`Bash(prefix:*)` 精细白名单） | 书 §3.6.2 前缀语法 |

> 📌 **2026-09-18 复核订正（两条）**：
>
> **（1）原稿的「5 个内置 agent」与「5 步落地序」基于错误数量。** 实测 26 个，
> 且**加载器 / schema / 六层优先级 / 调用链全部已具备**——
> `loadAgents.js:82-90` 已支持 `name` / `description` / `tools` / `disallowedTools` /
> `model` / `color` / `background` / `maxTurns` / `permissionMode`；
> `agents/index.js:30` 已在调用 `loadCustomAgents(cwd)`；
> `builtInAgents.js:210-228` 已实现 `builtIn→plugin→user→project→flag→managed`
> 六级覆盖（后写覆盖前写）。**本条风险等级由「高」下调为「中」**，
> 工作量从「新建加载器」降为「放文件 + 格式裁决」。
>
> **（2）发现一个真实格式冲突，须先裁决。**
> `loadAgents.js:28-69` 的 `parseFrontmatter()` 读的是 **YAML frontmatter 的 `.md`**，
> 与 `FILE-FORMAT-PROTOCOL.md` §2.5（YAML 仅限 CI/CD 与 ML 配置）冲突。
> 三条路径：**A**（推荐）给加载器加 JSON 分支、`.khy/agents/<name>/agent.json`
> + `body.md` 优先、`.md` 保留兼容；**B** 在 §2.5 开豁免条款（不推荐，破例会扩散）；
> **C** 不处理（违约在门禁暴露）。
> 详见 [`[DESIGN-ARCH-123]`](%5BDESIGN-ARCH[DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md**施工约束（2026-09-17 实测新增）**：`agent.json` 的权限字段最终必须在
> `services/backend/src/services/toolCalling.js`（**实测 3598 行，已在 R2 巨石名单，
> R2b 规则「只许减不许增」**）里被读取。因此：
> - **优先让新逻辑落在 `services/backend/src/services/activeSkillContext.js`
>   的同类新文件**（如 `activeAgentContext.js`），`toolCalling.js` 只加**读取调用**；
> - 若必须在 `toolCalling.js` 内改动，**同步找出等量可删的死代码**以保持行数不增，
>   或将该文件纳入 god-file governance 拆分计划（同名 re-export + DI 保字节等价）；
> - 施工前跑 `node services/backend/scripts/archDebtScan.js --changed` 确认基线。
> 顺带记录：该文件另有一处 **R1 分层倒置**未清（`:1993 → ../cli/hooks/hookSystem`），
> 说明它同时踩 R1 与 R2b 两条——**不宜作为新增逻辑的载体**。

**【验收】** ① 外化的 `agent.json` / `.md` 与 `built-in/exploreAgent.js` 硬编码配置 `deepEqual`；
② 只读型 agent 的 `Edit` 调用被拒且原因可读（依赖既有 `disallowedTools` 机制）；
③ 逃生地板生效（白名单不会清空行动集）；
④ `check-agent-rules.js --changed` 绿；
⑤ **`archDebtScan.js` 的 R2b 对 `toolCalling.js` 无新增违规**（本次实测该项已有
存量告警：`增长 4 行 (3594 → 3598)`，施工时不得扩大）。

**【整合方式】** 与 `[DESIGN-ARCH-115]`（子智能体设计）合并交付。
`agent.json` 的 schema 复用 `manifest.json` 的 `version` 字段约定
（`.khy/` 下运行时 JSON 必须含 `version`，见执行手册 §3.2）。

---

### K-08 Skill 测试三件套（触发率 90% / 误触发 5%）

**优先级 P1** ｜ 书中出处 ch03 §3.11、§3.4.3 ｜ 决策 ✅ 采纳

**【书中的做法】** 书给了**可量化的验收阈值**，这对一个「软」机制非常罕见：

| 测试类型 | 方法 | 阈值 |
| --- | --- | --- |
| **触发测试** | 10 个应触发 + 10 个不应触发的问题 | 相关任务触发率 **> 90%**，无关任务误触发率 **< 5%** |
| **功能测试** | 检查输出格式、检查项完整性、边界处理 | — |
| **性能对比** | 同一任务「有 Skill」vs「无 Skill」各跑 5 次 | 对比 Token / 用户修正次数 / 输出质量 |

书还给了一条**极高信号量的自检信号**：

> 如果你发现自己反复手动修正 Claude 的输出（例如每次都要提醒它「记得标注认证要求」），
> 这是 SKILL.md 正文需要更新的**明确信号**。将修正逻辑直接写入 SKILL.md，下次就不会发生同类错误。

以及防止两种失效模式的具体手法：

- **欠触发**：Vercel 评测数据显示「若缺乏明确指引，Agent 有 **56%** 的概率完全不会去查看可用的 Skills」。
  修复 = 在 description 里**穷尽用户可能的各种表达**（含同义词、口语化说法、
  甚至**常见但不准确的表述**——书举例：很多用户混淆 Swagger 和 OpenAPI，**两者都要写**）。
- **过触发**：加 `Not for ...` 负向约束。

**【为什么对 khyos 适用】**

1. khyos 的 `[DESIGN-ARCH-112]` §3.2.1 花了整整一节量化了**预算饥荒**：
   48 行技能目录、被截断 40 行、触发短语全在被砍的那一半。
   **但 khyos 从未测过实际触发率。** 也就是说：
   我们知道描述被截断了，**不知道截断导致触发率掉到多少**。
   书提供的 10+10 测试集恰好是**把「已知的坏」变成「可度量的坏」**的最低成本手段。
2. 书那条 56% 无指引不查 Skills 的数据，对 khyos 尤其相关——
   khyos 的 `when_to_use` 覆盖率是 **16/43**，
   即 27 个技能**连触发提示都没有**。这是可量化的欠触发风险敞口。
3. 触发测试是**纯离线、零风险的**：它不写仓库、不改配置，只构造 query 观察模型选择。
   适合作为第一个可交付动作。

**【可落地方案】**

1. **测试集文件**：`.khy/skills/<skill-id>/trial.json`（JSON，不用 YAML）

```json
{
  "version": 1,
  "skillId": "code-review-and-quality",
  "shouldTrigger": [
    "帮我审查这段代码",
    "review this PR",
    "这段逻辑有没有安全问题",
    "do a code review on src/payment"
  ],
  "shouldNotTrigger": [
    "帮我修这个 bug",
    "为什么这个接口返回 500",
    "优化一下这个 API 的性能"
  ],
  "thresholds": { "recallMin": 0.9, "falsePositiveMax": 0.05 }
}
```

2. **runner 脚本**：`scripts/ci/check-skill-triggers.js`
   - 用 `--output-format json` 跑每次 query，从返回里读模型实际选择的技能
   - 输出 `recall` / `falsePositiveRate` 两个数字 + 未命中清单
   - **默认不进三守卫**（它是模型行为测试，有概率性，不适合卡 CI 硬门），
     作为 `khy doctor --skills` 的**报告项**
3. **覆盖顺序**：不铺 43 个，先做**触发最频繁的 6 个**
   （`code-review-and-quality`、`debug`、`planning-and-task-breakdown`、
   `test-driven-development`、`documentation-and-adrs`、`git-workflow-and-versioning`）。
4. **阈值达成的手段，按性价比排序**：
   - 补 `when_to_use`（107 → 剩余 27 个技能，但受 overhead 约束，见 K-02 的 `notFor`）
   - 在 description 里加**同义词与用户的错误说法**（书的核心手法）
   - 加 `notFor`（治过触发）
   - 把任务型技能移出预算池（K-02，直接腾出空间）

**【验收】** ① 6 个测试集全部产出 `recall` 与 `falsePositiveRate` 数字；
② 达到 `recall > 0.9` 且 `falsePositiveRate < 0.05`；
③ 未达标的技能产出**具体缺口清单**（哪条 query 没触发），据此改 description 再测；
④ 每次改 description 后测试集**必须重跑**，形成书说的「发现问题 → 定位原因 → 修复文档 → 验证效果」闭环。

**【整合方式】** 与 `[DESIGN-ARCH-114]`（Skills 规范）合并。
`trial.json` 与 `manifest.json` 同目录同级。
与 K-05 的判据卡共用「用数字而非感觉做决策」的方法论，
建议在 `[DESIGN-ARCH-121]` 收口时统一成一份《可量化验收清单》。

---

### K-09 description 作为「语义指纹」的写作规范

**优先级 P1** ｜ 书中出处 ch03 §3.4.2 ｜ 决策 ✅ 采纳

**【书中的做法】** 书把这个字段的地位抬得极高：「**description 是此机制的灵魂**」，
并给出可执行的写作结构：

```text
[功能定义]（做什么）+ [触发场景]（何时用）+ [核心能力]（能做什么）
```

三步写作法：

1. **第 1 步 What**：一句话精准概括「能做什么」
2. **第 2 步 When**：用 `Use when user...` 句式，**详细列举各种可能触发的用户指令、短语、关键词**
3. **第 3 步 Not For**（可选但推荐）：「如果该 Skill 容易被误触发，务必加上 `Not for...`」

以及一条**视角切换**的洞察，这是本节最有价值的一句：

> 你撰写的 description，其核心受众是 **Claude，而非人类读者**。
> 人类阅读文档时倾向于扫描标题、浏览结构；而 Claude 阅读 description 时
> 是在进行**深度的语义匹配**。

书给了正反例对照（反面：`Helps with projects.` / `Generates API documentation.`；
正面含 `Use when user asks to "write API docs", "document endpoints", "create OpenAPI specs"`）。

**【为什么对 khyos 适用】**

1. **khyos 的 description 是这样写的吗？大概率不是。**
   `[DESIGN-ARCH-112]` §3.2.1 记录：`code-review-and-quality` 的触发短语
   `"Use when reviewing code written by yourself…"` **在句尾**，
   107 字符预算下已被砍成 `"Conducts multi-axis…"`。
   **触发短语放句尾 = 按「人类读者」的思路写作**（先讲能力、最后补一句什么时候用）。
   这正是书点名批评的读法。
2. khyos 的截断机制是 **前向截断** `slice(0, descLen-1) + '…'`
   （`skills/index.js` 的 `formatLine`）。这意味着：
   **description 的写作顺序必须与截断方向对齐——最重要的触发信号必须放在最前面。**
   这是一条 khyos **特有的、书里没有的**约束（书用 16000 字符默认预算 + 静默排除，
   khyos 是比例截断），值得作为本地化条款写进规范。
3. 书提到的「用户会混淆 Swagger / OpenAPI，两者都要写」这条，
   在 khyos 有直接对应：**khyos 与 Claude Code 共享生态**
   （`ccSkillBridge.js` 默认 ON，可发现 `~/.claude/skills`）。
   用户对同一个技能可能用 khy 的说法、也可能用 CC 的说法，
   **两套词汇都要进 description**。

**【可落地方案】**

产出一份 **Skills description 写作规范**（落 `[DESIGN-ARCH-114]`，或独立
`docs/10_规范/SKILL-DESCRIPTION-STANDARD.md`），核心内容：

```text
【description 四段式（khyos 本地化版）】

0. 【触发短语前置】—— khyos 特有
   因为 formatLine 是前向截断，触发短语必须尽量靠前。
   目标：触发信号落在**前 60 字符内**（见下方「关于这个数字」）。
   违反此条 = 高概率被砍掉（2026-09-16 实测：40/48 行被截断）。

1. What：一句话核心能力（可选，可被截断）
2. When：Use when user asks to "<用户原话1>", "<用户原话2>", "<用户原话3>"
   - 必须包含用户的**非技术口语说法**，不只技术术语
   - 必须同时包含 khy 与 Claude Code 两种生态的惯用说法
   - 同义词穷尽（书：同义词库越丰富，触发准确率越高）
3. Not For：Not for <场景1> or <场景2>. Only for <边界>.
4. 上限：description ≤ 1024 字符（书的规定，khyos 沿用）
```

**关于这个数字（2026-09-17 实测修正）**：初稿写「前 55 字符」是**估算**，实测链条如下，
请以实测为准：

| 环节 | 真源 | 行为 |
| --- | --- | --- |
| 预算总额 | `constants/prompts.js:2119-2125` | `charBudget = clamp(1% × contextWindowTokens × 4, 500, 8000)`，128K 窗口 → 5120 字符；可用 `KHY_SKILL_CATALOG_CHARS` 覆盖 |
| MCP 切片 | `services/skillSearch.js:212` | `includeMcp:false` 时**不**预留 30%（2026-09-16 已修） |
| 首次渲染 | `skills/index.js:273` | `descLen = 250`——**未超预算时截断到 250，不是 55** |
| 兜底降档 | `skills/index.js:293` | `maxDescLen = Math.max(20, ⌊(charBudget - overhead) / N⌋)`，**仅在总长超预算时**才降到这个值 |

因此正确表述是：**`descLen` 是 250（常态）或 `maxDescLen`（超预算态）两者的较小值**。
按 5120 字符预算、43 个技能、hint 已填充估算，`maxDescLen` 落在 **60–90 字符**区间
（`overhead` 随 `when_to_use` 填充率上升而变大，故该值会继续下降）。
**结论：写作规范取「前 60 字符」为设计目标更稳妥**，且应随
`when_to_use` 填充率上升而**动态收紧**——这与 K-02「把任务型技能移出预算池」
是同一件事的两面。

**一条判据**：写完 description 后，问自己
「**如果只能保留前 60 个字符，触发信号还在不在？**」
不在就重写。这条判据比书的 1024 字符上限**更适合 khyos 的实际约束**。

**【验收】** ① 规范落盘并登记；② 与 K-08 联动：
按新规范改写 6 个试点技能的 description，**重跑触发测试**，
要求 `recall` 相对改写前**有提升**（数字说话，不靠感觉）；
③ 抽样 5 个技能检查「前 60 字符含触发信号」这条硬约束；
④ **`descLen` 实测值回归**：新增一个脚本，用真实 `charBudget` 与 `when_to_use` 填充率
算出 `maxDescLen`，写进 CI——**当它跌破 60 时报错**，逼使作者要么前置信号、要么减少常驻技能。

**【整合方式】** 并入 `[DESIGN-ARCH-114]`（Skills 设计规范）。
与 K-02（`disableModelInvocation` / `notFor` 字段）、K-08（触发测试）
构成 Skills 三角：**字段（能表达）+ 写作（表达得好）+ 测试（验证有效）**。

---

### K-10 成本护栏与可观测性

**优先级 P1** ｜ 书中出处 ch10 §10.1、§10.2 ｜ 决策 🔄 改造采纳

**【书中的做法】** 书把成本控制拆成可操作的几层：

| 手段 | 书中规定 |
| --- | --- |
| **模型分层** | 格式化/重命名 → Haiku；文档/简单测试 → Haiku；功能开发/bug 修复 → Sonnet；架构设计/安全审计 → Opus |
| **硬预算** | `--max-budget-usd` 是**不可逾越的成本红线**，「在 CI/CD 自动化场景中应作为标准配置强制使用。若缺失，一旦脚本陷入死循环，可能一夜之间消耗数百甚至上千美元」 |
| **输出控制** | 「输出成本远高于输入」（Opus 输出是输入的 5 倍）→ **控制输出长度比控制输入更有效** |
| **缓存** | 缓存读取仅为正常输入价的 **1/10**；三策略：保持 CLAUDE.md 稳定 / 会话内聚合任务 / 用 `--resume` 延续会话 |
| **思考预算** | Extended Thinking 默认 31999 token 且**按输出价计费**——「一次深度思考可能消耗数万输出 Token，成本甚至远超最终生成的代码本身」 |
| **成本监控** | JSON 输出含 `total_cost_usd` / `num_turns` / `usage.cache_read_input_tokens`，可自动化采集 |
| **真实成本公式** | **真实成本 = API 成本 + 人力时间成本**。「若 Opus 5 min 完成而 Haiku 30 min 反复调试，Opus 那 0.5 美元物超所值」 |

**【为什么对 khyos 适用】**

1. khyos **已有 token-budget governor 但没有强制门**：
   `[DESIGN-ARCH-112]` §五 记录，`toolUseLoopCore.js` 的 token-budget governor
   有 `ceiling` 参数，**但「0 时禁用并保持 byte-identical legacy 行为」**。
   也就是说：**默认状态下没有任何成本护栏**，
   与书说的「缺失限制可能一夜烧掉上千美元」是同一风险敞口。
2. khyos 的 `IterationBudget(effectiveMaxIterations)` 只限**轮次**，
   不限**金额**。轮次 × 单轮输出量没有上界 → 成本没有上界。
   书明确把 `--max-turns` 与 `--max-budget-usd` 定位为**两个不同维度**，都要有。
3. khyos 的 `--output-format json` **已经输出成本元数据**
   （`printOutputFormat.js`），所以书 §10.1.5 的成本监控采集
   **在 khyos 已具备数据源**，缺的只是**消费方**（报表/告警）。
4. khyos 已有 `token_usage.json`（`.khy/` 实测存在），可作为聚合落点。

**【可落地方案】**

**（a）成本护栏（改造，不是照抄）**

khyos 的供应商是可替换的（`aiGateway.js`），所以**不能用美元硬编码**。
改造方案：以 **token 预算**为主计量、美元为辅：

```text
新增参数（--output-format json 同级）：
  --max-output-tokens <N>      单次会话累计输出 token 上限（主计量）
  --max-cost-usd <F>           可选，供应商计价已知时启用（辅计量）

行为：
  - 超限 → 优雅停机（复用现有 preventContinuation / _hookStopRequested 通道）
  - 停机原因写进 result 的 subtype，下游可区分「正常完成」vs「预算耗尽」
  - 默认值：**非 0**（当前 ceiling=0 即禁用的默认姿态需要改）
```

**关键：默认值的选择必须经过用户裁决**，因为 `[DESIGN-ARCH-112]` §3.2.1 已记录
`onePercent` 预算是「刻意的策略，抬高需用户裁决」。本文档**建议默认开启**并给一个
宽松值（如单会话 2 M 输出 token），理由是书给的证据：
无限制的失败模式是**灾难性**（一夜千美元），有限制的失败模式是**可恢复的**（重跑）。

> ⚠️ **施工约束（2026-09-17 实测新增，直接影响本节可行性）**：
> `ceiling` 参数所在的 `services/backend/src/services/toolUseLoopCore.js`
> **实测 12,105 行**，是本仓库**第二大巨石文件**，且 `archDebtScan.js` 的 R2b 规则为
> **「存量巨石只许减不许增」**（本次扫描实测报出 `toolCalling.js` 同类违规：
> `增长 4 行 (3594 → 3598)`）。因此 K-10(a) 若直接在此文件加代码，
> **会触发 R2b 红灯**。三条可行路径：
> ① **抽出新叶子**（推荐）：把 governor 的用量累计与超限判定抽成
>    `services/tokenBudgetGovernor.js` 新文件，`toolUseLoopCore.js` 只保留一行调用与
>    一行结果判断——**净增 ≤ 2 行**，且抽出的逻辑可单测；
> ② 复用既有 `preventContinuation` / `_hookStopRequested` 通道，只改默认值不改结构
>    （若该值由配置读取，则**零代码改动**，最优先尝试）；
> ③ 走 god-file governance 的正式流程（同名 re-export + DI 保字节等价），
>    成本最高，仅在 ① 不可行时启用。
> **施工前必须先跑** `node services/backend/scripts/archDebtScan.js --changed`
> **确认 R2b 当前基线**，不要凭本文档结论开工。

**（b）模型分层（照抄，因为 khyos 已支持）**

khyos 的 `manifest.json` 已有 `model` 字段映射（`_convertLegacySkill`）。
落地动作是**填值**：给格式化/文档类技能填轻量模型，
给架构/安全类技能填最强模型。零代码改动。

**（c）可观测性（改造）**

| 书中手段 | khyos 现状 | 动作 |
| --- | --- | --- |
| `--debug` 全量日志 | 无 | 新增 `--debug[=category]`（书 §10.2.1 的类别过滤语法 `api,hooks` / `!statsig`） |
| `--output-format stream-json` | ✅ **已有** | 直接可用，无需开发 |
| PostToolUse 审计 hook | 见 K-03 | 由 K-03 覆盖 |
| 会话文件 `{sessionId}.jsonl` | ✅ 有 `.khy/sessions/`（24 条）+ `sessions.db` | 补一份**读取指引**，说明如何定位「Claude 当时收到了什么」 |
| `--resume <session-id>` 时光倒流 | 需核实 | 纳入 `[DESIGN-ARCH-118]`（Headless）范围 |
| `/cost` 交互式查成本 | 需核实 | 有 `token_usage.json` 可支撑 |

**【验收】** ① `--max-output-tokens` 生效：构造长任务，超限时优雅停机且
`subtype` 可区分；② 轻/重模型的技能分层填值完成后，
跑同一批任务对比 `usage.output_tokens` 与耗时；③ `--debug=hooks` 能单独看 hook 执行。

**【整合方式】** `--max-*` 参数落 `printOutputFormat.js`（与既有五参数同处）；
治理逻辑落 `toolUseLoopCore.js` 的 governor（**注意红线 R4：该文件已 8000+ 行，
禁止新增超 2500 行的改动**——本项改动应控制在数十行，
若超出则拆到 `services/backend/src/services/` 下的新文件并用 DI 接入，
遵守 `CLAUDE.md` R4 的 god-file governance：同名 re-export + DI 保字节等价）。
与 `[DESIGN-ARCH-118]`（Headless）合并交付。

---

### K-11 「先观测后管控」的工程纪律（推广为通用方法论）

**优先级 P1** ｜ 书中出处 ch05 §5.11、ch10 §10.2.5、ch10 §10.6.4 ｜ 决策 ✅ 采纳

**【书中的做法】** 书里这条原则**反复出现了三次**，每次都针对不同机制——
说明作者认为它是可迁移的方法论，而非 Hooks 专属技巧：

1. **Hooks 的演进**（§5.11）：先 `PostToolUse` + `matcher:"*"` 观测数日 →
   基于数据设计 `PreToolUse` 拦截 → 逐步收紧、始终保留日志。
2. **团队落地四阶段**（§10.6.4）：
   个人探索 → 项目级统一 → 自动化集成 → 组织级规模化。
   Headless 的 CI 落地（§7.12）也用同一形状：
   **观察者模式（只出报告不阻塞）→ 顾问模式（CI 黄灯）→ 门禁模式（红灯阻塞，配逃生通道）
   → 主动修复模式**。书中引用的原话：

   > 切忌一步到位。每个阶段至少运行 2 到 4 周，密切监控**误报率**、成本趋势及团队接受度。

3. **异常诊断序**（§10.2.5）：**上下文缺失 → 指令冲突 → 工具权限不足**，
   「建议按此顺序依次排查，通常能迅速定位问题核心」。
   书中还给了每类的**典型症状**，这是最实用的部分：

| 类 | 根因 | 典型症状 | 诊断手段 |
| --- | --- | --- | --- |
| 1 上下文缺失 | 拿不到关键信息 | **反复读取同一文件**、回答空洞 | `--debug` 看实际收到的上下文 |
| 2 指令冲突 | 两条规则矛盾 | **行为在两种模式间摇摆**、直接忽略部分规则 | 全面审查 CLAUDE.md 找逻辑互斥点 |
| 3 权限不足 | 缺工具或授权 | **反复尝试某操作后失败**、被迫用不合适的替代工具 | 查 `--allowedTools` + Hook 拦截日志 |

**【为什么对 khyos 适用】**

1. **khyos 恰好有两个「机制齐备但配置空」的高风险动作正在等着做**：
   `.khy/hooks.json`（K-03，高风险章）与 `.khy/permissions.json` 的
   `profile:"yolo"` → 收紧（K-12）。两者都是**不可逆的语义变更**。
   书的「观察者 → 顾问 → 门禁」形状是这两件事的**天然施工顺序**，
   而 `[DESIGN-ARCH-112]` §八 §8.3「刻意未做」表里，
   对 hooks.json 的理由正是「高风险章协议：先 dry-run，保留一键关闭开关」——
   **khyos 已经独立推导出了同一条纪律**，书提供了它的完整形态与验收口径。
2. 书的四阶段每阶段 **2–4 周**这个时间量，khyos 需要**本地化修正**：
   khyos 是单机单用户（`[DESIGN-ARCH-112]` §九 已记 khyos 无组织级场景），
   没有「团队接受度」这个维度。因此阶段长度应以**样本量**替代**时间**：
   如「审计日志累计 ≥ 200 条工具调用」而非「2 周」。
   这是必要的改造——照抄时间会引入无意义的等待。
3. 书的**异常诊断序**对 khyos 是**立即可用**的：khyos 有 `--debug` 雏形、
   有 hook 拦截日志（K-03 后）、有 `--allowedTools`（`printOutputFormat.js` 已有）。
   把它写成一份排查协议，**零代码改动**，直接解决 khyos 长期缺
   「模型行为异常怎么查」的问题。

**【可落地方案】**

**（a）新增一份变更协议**（落 `docs/10_规范/CHANGE-ROLLOUT-PROTOCOL.md`），
要求**所有影响模型行为的变更**（hooks / permissions / rules / agents / description）
必须声明所处阶段：

```text
【四阶段（khyos 本地化：以样本量替代时间）】

S1 观察（dry-run）   ── 只记录，不影响行为
   毕业条件：审计样本 ≥ 200 条工具调用
S2 顾问（报告）      ── 输出警告，不阻塞
   毕业条件：误报率可量化且 < 10%，连续 N 次无新增误报类型
S3 门禁（阻塞）      ── 阻塞 + 逃生通道
   毕业条件：无误拦截持续一个完整工作周期
S4 自动化（修复）    ── 允许自动改
   前置：开放写权限，且所有修复以新分支/新提交形式产出（对齐 R1）

每一阶段必须同时具备：
  a. 一键关闭开关（环境变量或删配置文件）
  b. 阶段毕业条件（样本量/误报率，不是日期）
  c. 回滚路径（因 .khy/ 不入 git，须在协议里显式写「如何手工恢复」）
```

**（b）新增模型行为异常诊断协议**（落 `docs/10_规范/` 或
`AGENTS.md` 附录），直接采纳书的三分类与**排查顺序**，
并把 khyos 的具体命令填进「诊断手段」列：

| 类 | 症状 | khyos 诊断命令 |
| --- | --- | --- |
| 1 上下文缺失 | 反复读同一文件 / 回答空洞 | `khy --debug=context` 看实际注入段落 |
| 2 指令冲突 | 行为在两模式间摇摆 | 审查 `CLAUDE.md` / `AGENTS.md` / `.khy/rules/` 的互斥点 |
| 3 权限不足 | 反复失败 / 被迫替代方案 | 查 `.khy/permissions.json` + hook 拦截日志 |

**【验收】** ① 协议落盘并登记 `RULES-REGISTRY.json`（类别 `PROCESS`）；
② K-03（hooks）与 K-12（permissions）**按本协议的 S1 起步**，
在计划 JSON 中显式标注当前阶段；
③ 诊断协议抽样验证：人为制造一类「指令冲突」，
确认按表的顺序能定位到原因。

**【整合方式】** 本文档是**方法论层**，被 K-03 / K-10 / K-12 引用。
与 `[DESIGN-ARCH-121]`（工程化最佳实践）**高度重叠**——
建议收口时把 K-11 提升为 `[DESIGN-ARCH-121]` 的骨架章节。

---

### K-12 权限姿态：从「零规则」收敛到「deny 优先」

> 标题原为「从 `yolo` 收敛」。2026-09-18 复核实测 profile 已变为 `acceptEdits`
> （详见下方「为什么对 khyos 适用」第 1 条），但 `rules`/`patternRules` 仍为空，
> 故本条的实质是**补规则**，而非改模式。

**优先级 P0**（仅补规则）/ **P1**（规则集扩充）｜ 书中出处 ch10 §10.3 ｜ 决策 🔄 改造采纳

**【书中的做法】**

1. **5 种权限模式**：`plan`（只读）/ `default`（首次请求授权）/ `acceptEdits`（自动接收编辑）/
   `dontAsk`（仅执行预先批准）/ `bypassPermissions`（跳过所有提示）。
   书明确：「在任何自动化场景中，**务必显式指定权限模式**」，
   且「严禁在开发者本地机器上启用 bypassPermissions」。
2. **三级规则与评估序**：

```json
{ "permissions": {
    "allow": ["Bash(npm run lint)", "Bash(git commit *)"],
    "deny":  ["Bash(curl *)", "Read(./.env)", "Read(./secret/**)"],
    "ask":   ["Bash(git push *)"]
} }
```

> 权限规则的评估顺序是 **deny → ask → allow**。其中 deny 规则拥有最高优先级。
> 这意味着，即使某项操作同时匹配了 allow 规则，只要它也命中了 deny 规则，
> 该操作将被直接拒绝。这体现了「**安全优先**」的核心设计哲学。

3. **`.claudeignore` 与 `permissions.deny` 双保险**：书**明确承认** `.claudeignore`
   「存在已知的局限性——在某些场景下可能被绕过」，因此
   「更可靠的安全策略是在 `permissions.deny` 中显式禁止」。

**【为什么对 khyos 适用】**

1. **khyos 的权限姿态已在 2026-09-17 被改善，但仍未设防。**
   本节初稿写于 `profile: "yolo"` + `rules: {}` 的实测状态；
   **2026-09-18 复核实测已变为 `profile: "acceptEdits"` + `rules: {}`**
   （文件 `updatedAt: 2026-09-17T08:25:29.980Z`，非本文档作者所改）。
   变化是正向的：从「常驻最宽档」退到「自动接收编辑」。
   **但核心风险仍在**：`rules` 与 `patternRules` 双双为空，
   `acceptEdits` 下 `Edit`/`Write` 仍为全自动放行，
   而书规定的**运行时阻断层（第 3 层）依然不存在**。
   换言之——**问题从「模式过宽」变成了「零规则」，后者的修法更简单**。
2. 但 khyos **不能照抄书的模式名**，因为 khyos 是本地优先产品，
   用户可接受的门槛与云 CI 不同。改造方案：
   - 保留 `yolo` 作为**显式可选项**（不删，尊重既有用户选择）
   - 但**新增 deny 规则层，且 deny 优先于 profile** ——
     这条优先级设计**直接照抄书**，因为它与 khyos 的
     `hookContribSeams.tighten`（hook 只能收紧不能放宽）是**同一条哲学**，
     两者可以统一表达为「**任何收敛机制只能单向收紧**」。
   - 📌 实测发现 khyos **已经实现**了 deny 优先：
     `permissionStore.js:326` 先判 deny、`:333` 再判 allow，**fail-closed**。
     所以本条的「deny 优先」**不需要新写逻辑**，只需**开启 pattern rules 并填规则**。
3. khyos 的 `RULES-REGISTRY.json` 已有 67 条登记，
   其中 R2（密钥防泄露）属于**必须有运行时防线**的红线。
   书 §10.3.6 的「4 层防护」正好对应 R2 的 4 个落点，
   其中**第 3 层「运行时阻断」在 khyos 完全缺失**：
   | 书的 4 层 | khyos 现状 |
   | --- | --- |
   | 存储隔离（.env） | ✅ |
   | 版本控制排除（.gitignore） | ✅ |
   | **运行时阻断（permissions.deny）** | ❌ **缺** |
   | 提交前拦截（PreToolUse Hook） | ❌ 缺（→ K-03） |

**【可落地方案】**

**（a）deny 规则集（第一批，对齐 R2）**

> ⚠️ **2026-09-18 复核订正（本条原方案的落点写错了，必须改）**
>
> **错误**：原方案把 `"deny"` / `"ask"` 数组填进 `.khy/permissions.json` 的 **`rules`** 字段。
> **实测**：`rules` 是**精确匹配**（`toolName` 全等），**不支持 `Bash(git push *)` 前缀语法**。
> 前缀语法属于独立的 **pattern rules** 体系（`_patternRules`）。
>
> 真源 `services/backend/src/services/permissionStore.js`：
>
> | 行 | 事实 |
> | --- | --- |
> | `60-64` | `_patternRules = [{ toolName, pattern, decision, scope, since }]` |
> | `201-212` | `DEFAULT_PATTERN_RULES` 已内置 10 条（含 `rm -rf *` / `sudo *` deny） |
> | `317-339` | `check()` 中 pattern 分支：**deny 先判**（`:326`）→ 再判 allow（`:333`），fail-closed |
> | `67-78` | 门控 `_patternRulesEnabled()` → flag `KHY_PERMISSION_PATTERN_RULES` |
> | `218-240` | `_initDefaultPatternRules()`：**仅当 `permissions.json` 不存在时**才写默认规则 |
>
> **第二个陷阱**：`flagRegistry.js:3456` 写的是
> `{ mode: 'opt-in', off: 'CANON', default: true }`，但 `isFlagEnabled` 对 `opt-in`
> 的判定是 `raw === 'true' || raw === '1'`（`:3724-3727`）——**忽略 `default` 字段**。
> → **pattern rules 当前是关闭的**，`_patternRules` 为空。
> → 且 `permissions.json` **已存在**（2026-09-17 08:25 写入），
>   即使现在开开关，`_initDefaultPatternRules()` 也会因「已有配置，不覆盖」而跳过默认规则写入。
>
> **正确的施工顺序（顺序敏感，不可颠倒）**：
>
> ```text
> 步骤 1  确认 KHY_PERMISSION_PATTERN_RULES 的开启方式（opt-in，须显式设置）
> 步骤 2  备份 .khy/permissions.json → .khy/backups/<date>/
> 步骤 3  写入 patternRules 数组（不是 rules 字段）
> 步骤 4  验证：构造 `git push` 用例，确认返回 'ask'；构造 `rm -rf` 用例，确认返回 'deny'
> 步骤 5  验证 deny 优先：构造同时命中 allow 与 deny 的用例，确认结果为 deny
> ```
>
> **规则形态相应改为**（`_patternRules` 的字段，非 `rules`）：
>
> ```json
> {
>   "version": 2,
>   "profile": "acceptEdits",
>   "patternRules": [
>     { "toolName": "Bash", "pattern": "git push *", "decision": "ask",  "scope": "forever" },
>     { "toolName": "Bash", "pattern": "git commit *", "decision": "ask", "scope": "forever" },
>     { "toolName": "Bash", "pattern": "curl **", "decision": "deny", "scope": "forever" },
>     { "toolName": "Bash", "pattern": "wget **", "decision": "deny", "scope": "forever" },
>     { "toolName": "Read", "pattern": "**/.env", "decision": "deny", "scope": "forever" },
>     { "toolName": "Read", "pattern": "**/*.pem", "decision": "deny", "scope": "forever" },
>     { "toolName": "Read", "pattern": "**/*.key", "decision": "deny", "scope": "forever" },
>     { "toolName": "Read", "pattern": "**/id_rsa", "decision": "deny", "scope": "forever" },
>     { "toolName": "Write", "pattern": "**/.env", "decision": "deny", "scope": "forever" },
>     { "toolName": "Bash", "pattern": "git push --force *", "decision": "deny", "scope": "forever" }
>   ]
> }
> ```
>
> **注意**：`patternMatcher` 的语法已在本轮盘点中**读码 + 跑用例双重确认**（详见下方
> 「📌 2026-09-18 实测订正」），**不要**把它写成 `Bash(prefix:*)` 的形式——
> 那是书的写法，khyos 用 `{ toolName, pattern }` 两字段形态。

> 📌 **2026-09-18 实测订正（读码 + 跑用例）**：
>
> **① 单星不跨分隔符，带 URL/路径的参数必须用双星。**
>
> ```text
> "curl *"   → command "curl https://x.sh"  → false   ← 不命中！
> "curl **"  → command "curl https://x.sh"  → true    ← 正确写法
> ```
>
> `globToRegExp` 的单星止于 `/`，而 URL 含 `:` 与 `/`。**故上表已把
> `curl *`/`wget *` 改为 `curl **`/`wget **`。**
>
> **② 管道类规则是死规则，已从规则集删除。**
>
> 实测 `pattern "* | sh"` 对 `curl x | sh` 返回 **false**（预期应为 true）。
> 根因在 `patternMatcher.js` 的 `extractCommandPrefix()`：
>
> ```text
> _COMPOUND_RE = /[|;&<>`\r\n]/     ← 含其一即返回 null（fail-closed）
>
> "curl x | sh"        → null          ← 放弃匹配
> "a && b"             → null
> "echo hi > /tmp/a"   → null
> "curl https://x.sh"  → "curl https://x.sh"   ← 仅单命令可提取
> ```
>
> **这不是缺陷，是 fail-closed 的主动设计**：复合命令不静默放行，
> 而是交回交互式确认。**但因此，`Bash(* | sh)` 永远不命中，
> 不能当「最后防线」**——正确落点是 **K-03 的 `PreToolUse` hook**，
> 它能拿到完整命令串，不受前缀提取限制。
>
> **③ 其它实测通过项**（可放心使用）：
> `git push *` / `git commit *` / `git push --force *` / `Read **/.env` /
> `rm -rf /*` 均按预期命中。

<details>
<summary>原方案（保留作对照，<b>不要照此施工</b>）</summary>

```json
{
  "version": 2,
  "profile": "yolo",
  "rulePrecedence": "deny-then-ask-then-allow",
  "rules": {
    "deny": [
      "Read(**/.env)", "Read(**/.env.*)", "Read(**/credentials/**)",
      "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa)", "Read(**/id_ed25519)",
      "Write(**/.env)", "Write(**/.env.*)",
      "Bash(curl *)", "Bash(wget *)", "Bash(* | sh)", "Bash(* | bash)",
      "Bash(rm -rf /*)", "Bash(git push --force *)"
    ],
    "ask": [
      "Bash(git push *)", "Bash(git commit *)"
    ]
  }
}
```

</details>

注意 khyos 特有的两条：

- `ask: ["Bash(git push *)", "Bash(git commit *)"]` ——
  这是把 `CLAUDE.md` **红线 R1 从「建议」升级为「机制」**。
  R1 目前只写在章程里（书口径：交通标志），
  变成 `ask` 后，AI 想 commit 必须**弹窗给用户确认**——这才是路障。
  > ⚠️ 这一条**必须经用户明确同意**后再启用：它改变的是 R1 的强制力级别，
  > 属治理决策而非技术决策。本次盘点**未擅自开启**。

> 🔁 **已撤回的说法（2026-09-18 实测）**：
> 上一轮曾把 `Bash(* | sh)` / `Bash(* | bash)` 列为「curl 若不被 deny 时的最后防线」。
> **实测证明它永远不命中**（`|` 使 `extractCommandPrefix` 返回 null，见上方订正②）。
> **该说法作废，两条规则已删除。**
>
> 正确的管道防线是 **K-03 的 `PreToolUse` hook**——书 §5.6.1 把
> 「下载即执行」列为危险模式，但书用的是 `permissions.deny` 语法，
> 而 khyos 的 pattern rule 只匹配**单命令前缀**。
> 跨工具的复合语义（管道、重定向、命令替换）**必须在 hook 层做**。

**（b）`rulePrecedence` 的实现位置**：

> 📌 **2026-09-18 复核订正：本节描述的逻辑「已经存在」，不需要新写。**
> 原方案说要在 `toolCallingPermissions.js` 里「加一条先于 profile 判定的 deny 短路」。
> **实测**：`services/backend/src/services/permissionStore.js:317-339` 的 `check()`
> 已实现完全相同的语义——pattern 分支先判 `deny` 直接返回（`:326`），
> 再判 `allow`（`:333`），且整个分支 fail-closed。
> → **K-12(b) 的工作量从「数十行代码」降为 0**，只剩「开启 flag + 填规则」。
> → 唯一需要新写的是 `deny` 对 `profile` 的**跨层**优先级（pattern 分支目前
>   在 exact rules 之后、session approvals 之前，但 `profile` 判定的先后需施工时确认），
>   若已满足则本条可标记为「✅ 已具备」。

**（c）profile 默认值**：
本文档**建议**从 `yolo` 改为 `default`（书的第一道防线），
但按 K-11 的 S1/S2/S3 纪律，**先以 S1（只记录不拦截）跑一个周期**，
统计「若按新默认值，哪些操作会被拦」，
拿到数据后由用户裁决。**不擅自改默认值**——
这条对齐 `[DESIGN-ARCH-112]` §七 病灶 12 的「评估默认姿态，与 hooks.json 落地一并决定」。

> 📌 **2026-09-18 复核订正**：实测 profile 已由第三方改为 **`acceptEdits`**
> （文件 `updatedAt: 2026-09-17T08:25:29.980Z`，非本文档作者所改），
> 已优于本节的建议值 `default` 的上一档。**本条 (c) 事实上已被部分执行**，
> 是否继续收紧为 `default` 仍待用户裁决。

**【验收】** ① deny 规则构造用例：写 `.env` 被拒、`curl https://x` 被拒（**注意用 `curl **`**）、
`git commit` 走 ask 弹窗；② deny 优先级验证：同时构造 allow 与 deny 命中的用例，
确认**拒**；③ S1 阶段统计报告产出，列出「新默认值下会被拦的操作清单」交给用户裁决；
④ `check-change-safety.js --changed` 绿；
⑤ **`patternMatcher` 语法已确认**（2026-09-18 读码 + 跑用例，见本节上方订正）：
形态为 `{ toolName, pattern }` 双字段，**不是** `Bash(prefix:*)`；
单星不跨 `/`，URL 类参数用 `**`；**复合命令（含 `|`/`&`/`;`/`>`/`$(`）一律不匹配**。
⑥ **管道类用例改由 K-03 hook 验证**，不在本条的 pattern rule 验收范围内
（`curl … | sh` 对 pattern rule 恒为 false，属 fail-closed 设计）。

**【整合方式】** 与 `[DESIGN-ARCH-116]`（Hooks）**同一批施工**——
书 §5.6 的安全防护体系是 `permissions.deny`（静态）+ `PreToolUse`（动态）双层，
分开做会重复一轮 dry-run。落点 `toolCallingPermissions.js`，
**不新建文件**（遵守 B3 外科手术式改动）。

---

## 四、改造采纳项与不采纳项的理由（防止误抄）

以下逐条说明为什么**不能照抄**，这是本文档与「读书笔记」的分界线。

### 4.1 载体改造（3 条，全部因 `FILE-FORMAT-PROTOCOL.md` §2.5）

| 书的载体 | khyos 载体 | 理由 |
| --- | --- | --- |
| `SKILL.md` + YAML frontmatter | **`manifest.json` + `prompt.md`** | §2.5 明文：YAML 在 khyos 协议中**仅允许用于 CI/CD 与 ML 配置**。且 `[DECISIONS]` 决定 B 已锁：manifest 为真源，SKILL.md 仅作兼容导入 |
| `.claude/rules/*.md` + `paths:` frontmatter | **`.khy/rules/<id>/rule.json` + `body.md`** | 同上。语义照抄，载体换掉 |
| `.claude/agents/*.md` + frontmatter | **`.khy/agents/<name>/agent.json` + `body.md`** | 同上 |

⚠️ **这三条是整个借鉴工作里最容易出错的地方**：
书里三种机制的示例**全都是 YAML frontmatter**。
若直接照抄会同时触犯格式协议（`check-change-safety.js` 拦截）与已拍板决策 B。
**必须先换载体再落地。**

### 4.2 路径改造（2 条）

| 书的路径 | khyos 路径 | 理由 |
| --- | --- | --- |
| `.claude/settings.json` | `.khy/settings.json` | `dataHome.js` 统一收敛 |
| `.mcp.json` | `.khy/mcp.json` | 同上；且 `[DESIGN-ARCH-112]` §8.1 已修 `hookRegistry.js:66` 的同类路径 bug |

**注意**：`.khy/hooks.json` 与 `.khyquant/hooks.json` 在 2026-09-16 实测**均不存在**，
所以 K-03 是**新建**而非迁移。

### 4.3 不采纳项（4 条）

| # | 书的机制 | 不采纳理由 | khyos 的替代 |
| --- | --- | --- | --- |
| N-01 | **受管设置**（`managed-settings.json`，组织级不可覆盖策略） | khyos 是**本地优先单机产品**，无组织/管理员角色，无「企业级 CLAUDE.md」（`/etc/claude-code/`）概念。书自己说这一层「对个人开发者和小型团队而言通常为空白」 | K-12 的 `deny` 优先层提供**等效的不可绕过硬顶**，但作用域是「本机」而非「组织」 |
| N-02 | **`TeammateIdle` / `TaskCompleted` / `Team Lead` / `Mailbox`（团队型子智能体）** | 需要多会话长期存续的基础设施。khyos 的 hook 运行时是 **11 事件**，未实现这两个；`[DESIGN-ARCH-112]` §四 记 khyos 无团队型场景。且书自己说「团队型运行开销更高，长期维持的上下文窗口意味着持续的 Token 消耗」 | khyos 已有 `[DESIGN-ARCH-118]` 多机协作规范覆盖跨机场景 |
| N-03 | **`ConfigChange` / `WorktreeCreate` / `WorktreeRemove` Hook** | khyos 运行时未实现这三个事件（实测 11 事件，书 17 事件）。新增事件是**运行时改造**，成本远高于配置 | 配置审计可用文件 `mtime` 监测替代（`promptFreshness.js` 已有该机制） |
| N-04 | **`agentskills.io` 开放标准 / Plugin 社区市场** | khyos 已有 `[DESIGN-ARCH-116]` `@khy/plugin-sdk` 自有契约（4 必填字段 + 6 路发现源 + 26 测试全绿），与 `ccSkillBridge`（借 CC 生态）**并行**。套用外部标准会造成双真源 | 保持 `@khy/plugin-sdk` 为自有真源；**但可参考**书的命名空间机制（`plugin-name:component-name`）与**可逆安装**要求 |

### 4.4 已具备项（8 条，登记防误改）

这 8 条 khyos 现状**等于或强于**书的做法，**不要因为「书里写了」就去改**：

| # | 机制 | khyos 强于书之处 |
| --- | --- | --- |
| M-05 | description 语义指纹 | 已修 overhead 静默溢出 bug（`skills/index.js:289`），书未提这个坑 |
| M-10 | Skill 作用域分层 | `skills/index.js:153` 的 `if (!skills.has(id))` 发现优先级已实现；且**双轨不对称已确认**（manifest 超集） |
| M-30 | Headless 参数体系 | 五参数全在，且 `-p` / `--max-turns`（cap 100）已实现，书无 cap |
| M-34 | Plugin 打包 | `@khy/plugin-sdk` 有**测试覆盖 26 条**，书只讲机制不讲测试 |
| M-35 | 加载优先级 | `prompts.js:1746` 已实现 **KHY > CLAUDE > AGENTS** + cwd > homedir，且做到 **section 级覆盖**（书只到文件级） |
| M-25 | 上下文压缩 | `contextCompressor.js` + `contextWindowGuard.js` + `memoryCompressor.js` 三件套齐备 |
| M-13 | 子智能体机制 | **26 个**内置 agent **已在跑**（书说的是从零建）；加载器/schema/六层优先级/调用链全具备 |
| M-20 | 权限机制 | `toolCallingPermissions.js` + `execApproval.js` + `approvalLedger.js` + `guardApproval.js` **四件套**，书只讲一个 settings.json |
| **K-12(b)** | **deny 优先评估序** | `permissionStore.js:317-339` **已实现** deny 先判（`:326`）→ allow 后判（`:333`），fail-closed。书的「deny 最高优先级」khyos 早已具备，**缺的只是开启 flag 与填规则** |

**反向确认**：`[DESIGN-ARCH-112]` §四 的刻度「3 有 / 2 部分 / 0 无」是准确的——
khyos 的 Harness **不是缺零件，是缺接线和配置**。
本文档 12 条 P0/P1 中，**7 条是「填配置」而非「写代码」**，与此判断一致。

> 📌 **2026-09-18 盘点进一步强化了这个结论**：复核发现「缺接线」比本文档初稿估计的更彻底——
> agent 体系（加载器/schema/六层优先级/调用链）、skill 的 `disableModelInvocation` 字段解析、
> 权限的 pattern rules（含 deny 优先 + fail-closed）**均已存在**。
> 详见 [`[DESIGN-ARCH-123]`](%5BDESIGN-ARCH-123%5D%[DESIGN-ARCH-123] K-01~K-12 施工盘点清单.md顺序

### 5.1 优先级矩阵

| 优先级 | 编号 | 动作性质 | 是否改代码 | 风险 |
| --- | --- | --- | --- | --- |
| **P0** | K-06 | 纯文档（CLAUDE.md 加两节） | 否 | 无 |
| **P0** | K-12(a) | 开 pattern rules 开关 + 填 `patternRules`（**不是 `rules`**） | 极小 | 低（deny 只收紧） |
| **P0** | K-09 | 纯规范 | 否 | 无 |
| **P0** | K-11 | 纯规范 | 否 | 无 |
| **P0** | K-04 | 纯规范 + agent 契约核对（**26 个内置，非 5 个**） | 否 | 低 |
| **P0** | K-05 | 纯规范（判据卡） | 否 | 无 |
| **P0** | K-03 S1 | 新建 `.khy/hooks.json`（仅审计 + async） | 需 dry-run 开关 | **中** |
| **P0** | K-12(b) | `rulePrecedence` 实现（deny 先行短路） | **实测已实现**，无需新写 | 低（原估「中」过高） |
| **P1** | K-01 | 新建 `.khy/rules/` + 选取器 | 是（新文件为主） | 中 |
| **P1** | K-02 | `disableModelInvocation` / `notFor` 字段 + 渲染 | 是（2 处） | 低 |
| **P1** | K-07 | `agent.json` 格式 + 权限收敛 | **加载器已具备**，放文件为主 | **中**（原判「高」偏保守） |
| **P1** | K-08 | 触发测试 runner + 6 个测试集 | 是（新脚本） | 低 |
| **P1** | K-10 | 成本护栏参数 + 模型分层填值 | 是 | 中 |
| **P2** | K-03 S2 | PreToolUse 真拦截 | 是 | **高** |
| **P2** | K-06(c) | `AGENTS.md` 拆分 | 否（但影响面大） | 中 |

### 5.2 施工顺序（三轮）

**第一轮 —— 零代码收益（建议立即做）**

K-06 → K-09 → K-11 → K-04 → K-05 → K-12(a)

全部是写文档 / 写规范 / 填 JSON。**不碰任何 `.js` 文件**，
`check-change-safety.js --changed` 只扫 `.md` / `.json`。
唯一注意：`CLAUDE.md` 新增行为准则需登记 `RULES-REGISTRY.json`，
且 `CLAUDE.md` 有 HTML 孪生件 `CLAUDE.html`（文件头 `<!-- MIRROR: CLAUDE.html -->`）——
需按 `npm run docs:build` 重建，**禁止手写**。

**第二轮 —— 配置化与低风险代码（K-03 S1 并行）**

K-03 S1（审计 hook，async，dry-run 开关）→ K-02（技能字段与渲染）
→ K-12(b)（deny 优先级）→ K-01（rules 条件化）
→ K-08（触发测试，此时可用 K-02 与 K-09 的成果验证）

**第三轮 —— 高风险章**

K-07（agent.json，含权限收敛，须先完成 5 份现状外化并逐字段核对）
→ K-03 S2（PreToolUse 真拦截，须 S1 样本量毕业）
→ K-10（成本护栏，须用户裁决默认值）
→ K-06(c)（AGENTS.md 拆分，须 K-01 已稳定）

### 5.3 一条贯穿全局的元规则

把这四句合成一条，建议登记为 `RULES-REGISTRY.json` 的新条目（类别 `PROCESS`）：

```text
【借鉴元规则】
1. 语义照抄，载体换掉（YAML → JSON，.claude/ → .khy/）
2. 任何收敛机制只能单向收紧（与 hookContribSeams.tighten 同源）
3. 每条借鉴必须可量化验收，否则不算落地（书的三阈值是模板）
4. 影响模型行为的变更走 S1→S2→S3 阶段，毕业条件用样本量而非日期
```

---

## 六、与现有架构的整合总图

```text
                      ┌──────────────────────────────────────┐
                      │  CLAUDE.md / AGENTS.md  （章程真源）  │
                      │  R1-R4 红线 / B1-B3 / RUNTIME-001~004 │
                      └────────────────┬─────────────────────┘
                                       │
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │                                   │                                   │
   ▼                                   ▼                                   ▼
【记忆层】                        【扩展层】                          【执行控制层】
prompts.js:1733 段              skills/index.js                    toolCallingPermissions.js
 ├ khy.md / CLAUDE.md              ├ formatSkillListing               ├ K-12(b) deny 先行短路
 ├ AGENTS.md                       │   ├ K-02 移出任务型            └ hookContribSeams.tighten
 ├ 8 生态兼容指令文件              │   └ K-09 前 55 字符约束            （单向收紧，同源）
 └ K-01 .khy/rules/  ← 新增         └ formatLine
     rule.json + body.md               └ K-02 notFor 渲染            toolUseLoopCore.js
     paths: → 条件化注入                                                ├ K-10 --max-output-tokens
                                                                       └ governor ceiling
   ▲                                   ▲                                   ▲
   │                                   │                                   │
   └─────────── promptSectionTaxonomy.js（鲜度键 mtime:size 统一折入）─────┘
                                       │
                      ┌────────────────┴─────────────────┐
                      ▼                                  ▼
              【子智能体】                        【Hooks】
       services/backend/src/agents/           hookRegistry.js（11 事件）
        ├ built-in/ ×5  ← K-04 契约外化        ├ K-03 .khy/hooks.json ← 新增
        └ K-07 .khy/agents/agent.json            ├ S1 审计（async）
            ├ tools 白名单（工具级）             └ S2 PreToolUse 拦截
            └ permissionMode: plan（会话级）
                      │                                  │
                      └──── K-05 判据卡 + K-11 阶段纪律 ──┘
                                （共同的施工方法论）
```

**三层接入的关键不变量**：

1. **鲜度键单一真源**：K-01 的规则文件必须复用 `promptSectionTaxonomy.js:226`
   的 `mtime:size` 折入机制，**不新建第二条鲜度通道**——
   否则会出现「改了文件但这一轮没生效」的静默失败，
   正是 `constants/promptFreshness.js:11` 记录过的原始 bug 形态。
2. **收敛单向性单一表达**：K-12(b) 的 deny 优先与 `hookContribSeams.tighten`、
   `constraintLattice.js:275` 的逃生地板，三者必须表达为同一条原则
   「**任何收敛机制只能收紧不能放宽，且永不把行动集清空**」。
   建议在 `[DESIGN-ARCH-111]` 的门绑定层登记为一条不变量。
3. **`.khy/` 的备份与回滚**：因 `.khy/` 不入 git，K-01/K-02/K-03/K-07/K-12
   的所有改动**必须有手工回滚路径**并写进 K-11 的阶段协议。
   建议至少在改动前 `cp -r .khy/{skills,rules,agents,hooks.json,permissions.json} .khy/backups/<date>/`
   （`.khy/backups/` 实测存在，可直接复用）。

---

## 七、本文档未覆盖的（明确移交）

> **移交按「议题」而非「编号」表述。** 本节初稿曾把 `113`–`120` 写成待占号，
> 但 2026-09-17 实测该号段**已全部被占用**（见下表「现状」列），沿用会造成
> 「编号已存在却说你没写」的误导。后续承接方请以 **议题** 为准检索，勿按号索文。

| 移交议题 | 号段现状（2026-09-17 实测） | 承接方 |
| --- | --- | --- |
| 五层记忆分级的完整实现与条件化加载的**算法细节** | `113` 已被《AI修改三模态反馈契约-客户模式》占用 | 需新开号（下一空号 122）；本文档 K-01 只锁「载体 + 接入点 + 验收」 |
| Skills 的 description 逐条改写（43 个）与匹配真源收敛 | `114` 已被《CLI 错误标准化规范》占用 | 需新开号；本文档 K-09 只给写作规范，不改具体文案 |
| 用户级子智能体定义格式的**完整 schema** | `115` 已被《TUI 启动板块设计》占用 | 需新开号；本文档 K-07 只锁「双重保险」与「5 步落地序」 |
| `hooks.json` 的**完整配置语义**与全部 11 事件的可用性核查 | `116` 已被《khyos-插件系统契约(@khy/plugin-sdk)》占用 | 需新开号；本文档 K-03 只锁「三步走施工序」与「dry-run 开关」 |
| MCP 三层作用域与信任评估的**实现** | `117` 已被《khy-多端入口矩阵》占用 | 需新开号；本文档仅在 §4.3 登记不适配项 |
| CI 编排与 `--max-budget-usd` 的完整参数设计 | `118` 已被《HQ 能力吸收与多机协作规范》占用 | 需新开号；本文档 K-10 只锁「主/辅计量」与「默认值须裁决」 |
| Agent SDK 双语言接口（路线 A 库化 vs 路线 B 另起） | `119` 已被《TUI原生文本选择与复制可用性修复》占用 | 需新开号 |
| plugin.json 清单格式（khyos 已有 `@khy/plugin-sdk`，需对齐） | `120` 空闲（留作缓冲） | 可考虑占用 `120`，但须先与并行的 HQ 收口件协调 |
| 全书收口的《khyos 工程对齐报告》 | 本文档已占用 `121` | 改由执行手册 §7 的收口件承接，建议用 `[DESIGN-REPORT-001]` 或顺延 `122` |

⚠️ **编号冲突提示（未裁决，待你处置）**：执行手册 §5.1 原计划把 `121` 分配给
「工程化最佳实践」收口件，本文档已占用 `121`。两条处置路径：
① 执行手册 §5.1 的收口件改用 `[DESIGN-REPORT-001]`（跨类新号不占 ARCH 段）；
② 收口件顺延 `122`，并把 `120` 释放给上表「plugin.json 清单格式」。
**我未擅自改动执行手册**——它属另一轮工作的真源文件，改它需同步 `.khy/plans/*.json`。

---

## 八、本文档维护

### 8.1 路径真源表（2026-09-17 逐条实测复核）

本文档正文多处使用简写路径（如 `skills/index.js:243`）。下表给出**已验证的完整路径**，
后续施工请以此为准——`find` 同名文件时会命中多个，误改会造成静默失效。

| 文档内简写 | 已验证完整路径 | 关键行 | 复核结论 |
| --- | --- | --- | --- |
| `skills/index.js` | `services/backend/src/skills/index.js` | `243` `formatSkillListing` 定义<br>`273` `descLen = 250` 首次渲染<br>`293` `maxDescLen` 兜底降档<br>`567-568` `setActiveSkill`（闸门激活点） | ✅ 一致。注意**不是** `services/skills/` 也**不是** `services/skills/extensions/` |
| `toolCalling.js` | `services/backend/src/services/toolCalling.js` | `184-193` capability policy 白名单<br>`212-236` `_checkActiveSkillPolicy` | ✅ 路径一致。⚠️ **3598 行，已在 R2 巨石名单，R2b「只许减不许增」**；另有未清 R1 分层倒置（`:1993`）；**不宜作新增逻辑载体** |
| — | `services/backend/src/services/activeSkillContext.js` | — | 闸门的实际状态载体，文档正文未点名，补录 |
| — | `services/backend/src/services/toolCallingPermissions.js` | 全文 **973 行** | ✅ K-12(b) 的落点，**不在巨石名单**，可安全新增 |
| `toolUseLoopCore.js` | `services/backend/src/services/toolUseLoopCore.js` | governor `ceiling` | ⚠️ **12,105 行**，本仓第二大巨石，R2b 同约束。K-10(a) 见该节施工约束 |
| `hookRegistry.js` | `services/backend/src/services/domain/extensions/hooks/hookRegistry.js` | `20-35` `HOOK_EVENTS`（11 个） | ✅ 一致。**11 事件 = 8 工具/会话事件 + `Stop` + 插件注册点 `ToolPermission`/`PromptSection`** |
| — | `services/backend/src/cli/hooks/hookRegistry.js` | 全文 14 行 | re-export shim（R1 分层倒置修复留下的兼容壳），**不要改它**，改上游 |
| `prompts.js` | `services/backend/src/constants/prompts.js` | `2110` `getSkillCatalogSection`<br>`2119-2125` 预算模型 | ✅ 一致 |
| `skillSearch.js` | `services/backend/src/services/skillSearch.js` | `212` MCP 切片 | ✅ 一致 |
| `promptSectionTaxonomy.js` | `services/backend/src/constants/promptSectionTaxonomy.js` | `226` 鲜度键、`260` `cacheKeySource`、`357` tier | ✅ 一致 |

**复核方法**（可重跑）：

```bash
cd /d/Portable/khy-os
grep -rn "formatSkillListing\|maxDescLen" --include=*.js services/backend/src/
grep -n "HOOK_EVENTS" -A 15 \
  services/backend/src/services/domain/extensions/hooks/hookRegistry.js
sed -n '2110,2126p' services/backend/src/constants/prompts.js
node services/backend/scripts/archDebtScan.js          # 巨石与 R1/R2b/R3 全量
node services/backend/scripts/archDebtScan.js --changed # 施工前必跑（只看本次改动）
```

### 8.1.1 巨石文件约束汇总（2026-09-17 实测）

本次复核意外发现三条施工路径被巨石门拦截，单列于此以免散落正文被漏读。
`archDebtScan.js` 实测报 **R2 巨石文件（>2500 行）26 个**，其中与本文档直接相关的三个：

| 文件 | 行数 | 本文档哪些条目要碰它 | 处置 |
| --- | --- | --- | --- |
| `services/toolUseLoopCore.js` | **12,105** | K-10(a) 成本护栏 | 抽新叶子 `tokenBudgetGovernor.js`，净增 ≤2 行 |
| `services/toolCalling.js` | **3,598** | K-07 权限双重保险、K-12(b) 部分 | 新增逻辑落 `toolCallingPermissions.js`（973 行，安全）或新建 `activeAgentContext.js` |
| `services/toolCallingPermissions.js` | 973 | K-12(b) `rulePrecedence` | ✅ **安全落点**，无巨石约束 |

**通用原则**：本文档 §5.2 的三轮施工序是按「风险」排的，**未按「落点文件的巨石状态」排**。
施工时若发现某条目的首选落点是巨石文件，**应先执行「抽叶子」再实现功能**，
把「为落点腾出空间」当作独立的前置步骤，而不是硬塞。

### 8.2 预算模型真相（对 §三 K-09 的补充）

`descLen` 有**两个**取值来源，文档初稿只写了兜底值，易被误读为常态：

| 状态 | 取值 | 触发条件 | 真源 |
| --- | --- | --- | --- |
| 常态 | **250** | 全部行拼接后 `full.length <= charBudget` | `skills/index.js:273` |
| 超预算 | `maxDescLen` | 超出后整体降档重渲染 | `skills/index.js:293` |

`charBudget` 计算链：`clamp(1% × contextWindowTokens × 4, 500, 8000)`，
128K 窗口 → **5120 字符**；可用 `KHY_SKILL_CATALOG_CHARS` 覆盖；
`KHY_PROMPT_SKILLS_MIN` 走极简档（0.3%、上限 1000）。

**这对 K-02 / K-09 的含义**：`when_to_use` 填充率上升会推高 `overhead`，
从而压低 `maxDescLen`——**两个 P0 项是耦合的**，
`when_to_use` 填得越多，越需要 K-02 把任务型技能移出预算池。
建议施工顺序上把 K-02 与 K-09 排在同一轮（文档 §5.2 已如此安排）。

### 8.3 其余维护约定

- **编号**：121（2026-09-17 落盘时实测最大占用号，119 已被 `TUI原生文本选择与复制可用性修复`
  占用、120 留作缓冲；下一个空号为 122）
- **索引登记**：`docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` §二清单；
  同时更正该文件尾部「当前下一个空号为 116」的过期注记
- **HTML 产物**：由 `npm run docs:build` 生成，**禁止手写**
- **格式协议**：`docs/10_规范/其它规范/FILE-FORMAT-PROTOCOL.md` —— LF 换行、标题不跳级、
  代码块标语言、相对路径链接、行宽 ≤120
- **关联计划**：`.khy/plans/learn-claude-code-book.json` `plan.steps[0]`
- **上游**：[`[DESIGN-ARCH-112] khyos-Harness架构对照.md`](%5BDESIGN-ARCH-112%5D%20khyos-[DESIGN-ARCH-112] khyos-Harness架构对照.mdook-harness/split/ch01..ch10.txt`

---

## 关联规则索引

- `CLAUDE.md` —— 红线 R1–R4、行为准则 B1–B3 的语义真源
- `AGENTS.md` —— 工程规则 RUNTIME-001~004 的语义真源
- [`../10_规范/registry/RULES-REGISTRY.json`](../../10_规范/registry/RULES-REGISTRY.json) —— 规则单一真源登记表
- [`../10_规范/其它规范/FILE-FORMAT-PROTOCOL.md`](../../10_规范/其它规范/FILE-FORMAT-PROTOCOL.md) —— 文件格式协议（§2.5 YAML 限制）
- [`[DESIGN-ARCH-111] 规则遵守保障机制.md`]([DESIGN-ARCH-111] 规则遵守保障机制.md)[DESIGN-ARCH-111] 规则遵守保障机制.md001] 委派边界决策矩阵-第六通道外部智能体.md`](%5BDES../../10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md派准入闸门
- [`[DESIGN-ARCH-116] khyos-插件系统契约(@khy-plugin-sdk).md`]
  (%5BDESIGN-ARCH-116%5D%20khyos-插件系统契约(%40khy-plugin-sdk).md) —— 自有插件契约
- `[DESIGN-LAY-005]` —— 新代码/新目录分层与依赖单一真源
