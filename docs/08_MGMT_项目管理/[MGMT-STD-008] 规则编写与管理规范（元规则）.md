---
name: 规则编写与管理规范（元规则）
id: MGMT-STD-008
domain: DOCS
nature: 约束为主，兼权力
scope: "docs/**（规则文档与规则卡）, AGENTS.md, CLAUDE.md, docs/_规范/RULES-REGISTRY.json（一切被登记或被引用的规则）"
priority: P2
trigger: 编写、评审、修订、废弃任何 Khy OS 规则时
constraint: 规则必须按 §1 规则卡格式编写，含 §1.1 全部 14 个字段；ID 全局唯一不复用；scope 为合法 glob 或枚举；授予的权力须在 constraint/scope/exception 中找到边界（§3.3 配对铁律）
grants: 授权任何维护者/贡献者按 §1 模板起草规则草案并提 PR，符合格式即自动过守卫、免人工格式评审（见 PROCESS-101）
benefit: 模板 `rules:scaffold` + 守卫自动过审，使遵循成本低于违反成本；提供明确的「起草→查重→评审→激活」路径
exception: 规则正文可保留在既有章程原文中（如 AGENTS.md 工程规则），但必须同时登记进 RULES-REGISTRY.json 并在正文明标 ID（§5 第 7 步）
version: "1.1.0 (2026-09-15) 补自身规则卡 frontmatter；status 统一为 active；字段名 formerly 对齐登记表"
status: active
ssot: docs/08_MGMT_项目管理/[MGMT-STD-008] 规则编写与管理规范（元规则）.md
formerly: 无
owner: governance-team
---

<!-- RULES-REGISTRY: MGMT-STD-008, PROCESS-101 -->


# [MGMT-STD-008] 规则编写与管理规范（元规则）

> **定位**：本文件是「规则的规则」——统管 Khy OS 现有及后续所有规则的**写法、分类、优先级、冲突裁决与生命周期**。它是一条**元规范（meta-rule）**，不替代任何业务规则的语义真源；业务规则语义永远以其登记的单一真源（SSOT）为准，本文件只规定「规则本身怎么写、怎么管」。
>
> **核心原则（三元性）**：规则不只是约束，更是**权力**与**福利**的统一体——约束划定行为边界，权力赋予行动资格，福利通过明确的做事方向降低决策成本。本规范自身必须体现并落实这一条：在**防止任意性**的同时，为用户提供**清晰可执行的行动路径**与**正向激励**。见 §0.1–§0.2。
>
> **与既有规范的关系**：`[DESIGN-ARCH-070]` 治理总纲的十个板块与本文 §3 十大域**一一对应**（MOD↔LAYOUT、MEM↔MEMORY、TOOL↔TOOLING、ACP↔COMMS、API↔API、BORROW↔SOURCING、RUNTIME↔RUNTIME、PROCESS↔PROCESS、SECURITY↔SECURITY、DOCS↔DOCS）；`[OPS-MAN-169]` 是规则索引层；`[MGMT-STD-001]`/`[MGMT-STD-007]` 是文档命名规范（属本文 DOCS 域）。冲突时：本文管「如何写规则」，具体规则语义以真源为准。
>
> **本文件自身合规**：本文即一张规则卡——`id`/`domain`/`priority`/`nature`/`status` 等字段见文件头部 YAML frontmatter（本文的 SSOT 就是自己）。`status: active`，已登记进 `docs/_规范/RULES-REGISTRY.json`，`.html` 孪生件与两处索引均已落地（见 §8 合规记录）。

---

## 0. 核心定义

| 术语 | 含义 |
|------|------|
| 规则（Rule） | 一条可判定、可追责的约束，含触发条件与具体约束 |
| 真源（SSOT） | 规则语义的权威载体（代码 / 章程原文 / 独立 RULE 文件）；规则卡只是指针 + 摘要 |
| 规则卡（Rule Card） | 按 §1 格式编写的单条规则载体（YAML frontmatter + Markdown 正文） |
| 元规则（Meta-rule） | 本文——关于规则本身的规范 |

### 0.1 规则三元性（核心原则）

规则不只是约束，更是**权力**与**福利**的统一体：

- **约束（Constraint）**：划定行为边界，声明「不得 / 必须」——防止任意性、保证一致性。
- **权力（Power）**：赋予明确的行动资格——**谁**，在满足**什么条件**时，**有权做什么**。权力必须配对约束（边界），否则即任意性。
- **福利（Benefit）**：提供明确的做事方向与默认路径，降低决策成本——让「做对的事」成为阻力最小的选择。

> 任何一条规则都应能回答三问：它**禁止/要求**什么（约束）？它**授权**谁做什么（权力）？它让谁**更容易**做对（福利）？只写约束、不写权力与福利的规则，视为不完整。

### 0.2 元原则：本规范如何落实三元性

- **防止任意性**：一切权力须有边界（约束）；冲突自动裁决 + 公开留痕（§2.3）；规则字段强制、ID 唯一可溯源（§1/§3）；修订追加不重写（§4.3）；废弃须兼容期，不突然剥夺既有权力/福利（§4.4）。
- **提供可执行路径**：每条规则卡给出 `trigger → constraint → grants → benefit` 明确链路（§1）；提供模板、默认 glob、预批准模式，使**遵循成本低于违反成本**。
- **正向激励**：符合格式即自动过守卫（省人工评审，§4.6）；低冲突/低重复域享快速评审；优质提案快通道；规则健康度可视化与认可（§4.6）。

---

## 1. 统一规则格式（规则卡）

每条规则必须是一张**规则卡**。机器可解析字段走 YAML frontmatter，人类可读正文走 Markdown 固定标题。

### 1.1 字段清单

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` 名称 | 必 | 中文短名，≤20 字，名词或动宾短语 |
| `id` 唯一标识 | 必 | 格式 `<DOMAIN>-<NNN>`，全局唯一、不复用 |
| `domain` 归属分类 | 必 | §3 十大域之一，每条恰好一个 |
| `nature` 性质 | 必 | `约束` / `权力` / `福利` / `复合`（注明主次，如「约束为主，兼权力」） |
| `scope` 适用范围 | 必 | 受约束 / 被授予 / 被惠及的路径·角色·场景，用 glob 或枚举，越具体越好 |
| `priority` 优先级 | 必 | `P0`/`P1`/`P2`/`P3`（见 §2.1） |
| `trigger` 触发条件 | 必 | 什么情况下本条生效；恒约束写「始终」 |
| `constraint` 具体约束 | 必 | 要做什么 / 禁止做什么；可量化、可校验 |
| `grants` 授予权力 | 必 | 本条赋予谁、在什么条件下的行动资格；纯约束型写「见约束边界」或「无新增权力」 |
| `benefit` 提供福利 | 必 | 本条如何降低决策成本 / 给出明确做事方向；纯约束型写「见正文」或「无」 |
| `exception` 例外说明 | 选（建议必） | 豁免情形 + 理由；无则写「无」 |
| `version` 版本记录 | 必 | 语义化版本 + 日期 + 变更摘要 |
| `status` 状态 | 必 | `draft`/`active`/`deprecated`/`archived` |
| `ssot` 真源 | 必 | 语义权威位置：`文件#锚点` 或 代码路径 |
| `owner` 责任人 | 必 | 维护者 / 团队 |
| `formerly` 曾用标识 | 选 | 迁移前的旧 ID，保留可溯源（如 `GOV-MOD-001`） |

### 1.2 YAML frontmatter 模板

```yaml
---
name: 零硬编码
id: RUNTIME-001
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "services/**, apps/**, platform/**, software/**, kernel/**, tools/**, scripts/**（非测试文件）"
priority: P1
trigger: 源码中出现网络端点 / 文件系统路径 / 第一方生产域名的字面量时
constraint: 禁止硬编码 IP / 端口 / 绝对路径 / 第一方生产域名；端点必须从 serviceDefaults 或 env 读取
grants: 授权从 constants/serviceDefaults.js 或 env 动态读取端点（合法配置来源资格）
benefit: 不必猜测端口/域名；统一来源降低联调与自托管部署成本
exception: 测试文件、serviceDefaults.js 本身、纯注释/品牌/示例、含 ${} 插值、new URL() 解析等（见正文）
version: "1.0.0 (2026-09-15) 迁移自 AGENTS.md 规则1"
status: active
ssot: AGENTS.md#工程规则-规则1
formerly: 规则1/零硬编码
owner: backend-team
---
```

### 1.3 正文模板（Markdown 固定标题）

```
## 约束
（要做什么 / 禁止什么，逐条可校验）

## 授予权力
（本条赋予谁、何种条件下的行动资格；纯约束写「见约束边界」）

## 提供福利
（本条如何降低决策成本 / 给出明确做事方向；纯约束写「见正文」）

## 反例
（违反的样子，配正确写法）

## 校验方式
（命令 / 脚本 / 人工评审，指明守卫）

## 例外
（豁免清单 + 理由；无则写「无」）

## 版本记录
- 1.0.0 (2026-09-15) 初版 / 迁移自 XXX
```

---

## 2. 优先级分层与冲突裁决

### 2.1 优先级四档

| 档 | 名称 | 含义 | 典型内容 | 修改门槛 |
|----|------|------|----------|----------|
| `P0` | 宪法级 | 不可被任何规则覆盖 | 密钥不落盘、critical gate、不可逆操作需显式 `YES` | 维护者 + 独立复核，且须公告 |
| `P1` | 红线级 | 违反即阻断（error） | 工程红线（零硬编码 / 状态透明 / 活动超时 / 无滚动区）、布局层级、分支纪律 | 维护者审批 + 守卫 |
| `P2` | 规范级 | 默认遵守（warning 或强约束） | 文档命名、API 信封、状态文本格式、memory 生命周期 | 评审 + 守卫 |
| `P3` | 建议级 | 非阻断建议 | 状态简洁性、修饰语省略 | 评审即可 |

### 2.2 冲突裁决算法（多条规则同时命中且指令矛盾时）

按顺序，**首个命中即停**：

1. **层级优先**：`P0 > P1 > P2 > P3`，高优先级整条胜出。
2. **范围更窄者胜**：同档内，`scope` 更具体的规则覆盖更宽泛的（如 `services/backend/src/services/gateway/**` 胜 `services/**`）。判定：`A.scope` 是 `B.scope` 的真子集 → A 胜。
3. **同域同向**：同档同范围、同 domain、约束不矛盾 → 并行生效（不冲突）。
4. **福利增益优先（等价裁决）**：当多个合法裁决在约束层面等价（同档同范围同域或不冲突）时，选择**保留最多权力、提供最多福利（决策成本最低）**的方案，并把该选择记入 §2.4 precedence 表，避免下次任意裁决。此步**绝不**用福利去覆盖一条已生效的 P0/P1 约束。
5. **无法自动裁决** → 进入 §2.3 升级。

> **重叠即违规**：若两条规则约束「同一 subject」且「同一 domain」却给出矛盾指令，属**职责重叠违规**（违反 §3 单一职责）。不靠优先级解决，必须合并 / 拆分（见 §5 迁移步骤）。

### 2.3 升级处理（无法自动裁决时）

以下情况判定为「待裁决冲突」，**不得静默放行**：

- 同档 + 同范围 + 不同 domain，对同一 subject 给出矛盾指令；
- 范围嵌套关系无法判定（互为交叉而非包含）；
- 优先级相同、分属不同维护者且未声明 precedence。

处理流程：

1. 守卫脚本（扩展 `check-gov-rules.js`）把冲突写入 `docs/_规范/RULES-CONFLICTS.json`，标注 `ruleA / ruleB / subject / 检测时间`。
2. 在 PR 中 `@maintainer`；维护者须于 **5 个工作日**内给出一则**裁决**：要么修订某条规则的 `scope`/`exception` 消除冲突，要么为这对 `(domain, subject)` 声明**永久 precedence**（写入 §2.4 表）。
3. 裁决结果回写冲突表 `resolved`，并同步更新相关规则卡字段。
4. 超时未裁决 → 该 PR 中「规则相关改动」暂缓合并，直至裁决。

### 2.4 已声明域间 / 等价裁决 precedence（仅在 §2.2.4 / §2.3 触发后由维护者填写）

| subject 类 | 优先生效 | 说明 |
|------------|----------|------|
| 密钥存储机制 vs 流程防泄露 | `SECURITY` > `PROCESS` | 密钥机制以 SECURITY 为准，PROCESS 只管「流程不得泄露」（X-003 拆分依据） |
| 规则登记表 vs 治理总纲板块表 | 语义以 `RULES-REGISTRY.json` 的 `ssot` 指向为准；ID/三元字段以登记表为准，逐条 GOV-* 编号以 `[DESIGN-ARCH-070]` 对应板块为准 | 两份文件刻意分工，不构成漂移（见 §5 落地状态注记） |
| 文档索引文件名格式 vs 业务文档编号前缀 | 索引文件名格式：执行 AI 依目录惯例动态决策（`MGMT-STD-001` §2.3 收窄后 scope）；业务文档编号前缀：`MGMT-STD-007` R3 写死格式 | 二者按 scope 分层、互不覆盖，非优先级裁决（X-001） |
| 默认端点来源 | `env` 覆盖 > 写死默认值 | 同等约束下优先保留「可自托管」的权力与福利 |
| 版本轨道真源 | 代码（`check-version-sync.js` 的 `specs`）> 任何文档表述 | 文档表述与守卫不一致时以守卫为准（X-002） |

> 本表只在 §2.2.4 / §2.3 触发后追加，**不得**用本表覆盖一条已生效的 P0/P1 约束（§2.2.4 红线）。

---

## 3. 分类与命名约定

### 3.1 十大分类域（DOMAIN，按主体事项划分）

每条规则**恰好归属一个域**；跨域内容拆成多条，不得一条多域。

| 域 | 名称 | 职责边界（只管这些） | 典型现有规则 |
|----|------|----------------------|--------------|
| `LAYOUT` | 结构层级 | 目录层级、依赖方向、根 / 任务入口命名、文件规模上限 | GOV-MOD-001~004、上帝文件门 (R4) |
| `RUNTIME` | 运行时行为 | 代码运行时的行为约束（硬编码、状态文本、超时、终端渲染） | AGENTS.md 规则 1–4 |
| `COMMS` | 内部通信 | ACP / 消息信封、trace、终态、错误码 | GOV-ACP-001~004 |
| `API` | 接口边界 | 内外 API 边界、统一信封、版本弃用 | GOV-API-001~004 |
| `TOOLING` | 工具扩展 | Skill / MCP / 扩展登记、最小权限、升级废弃 | GOV-TOOL-001~005、OPS-MAN-169 §3/§5 |
| `MEMORY` | 记忆元数据 | 读写入口、生命周期、persistent / session 区分 | GOV-MEM-001~004 |
| `SOURCING` | 外部借鉴 | 借鉴范围、实现唯一性、能力域归属 | GOV-BORROW-001~006 |
| `PROCESS` | 流程纪律 | 分支 / 提交 / 发布 / 评审、双渠道版本同步 | R1 分支纪律、R3 版本同步、验收门禁 |
| `DOCS` | 文档规范 | 命名、编号、孪生件、索引 | MGMT-STD-001 / 007 |
| `SECURITY` | 安全权限 | 密钥存储、权限档、critical gate、弱模型护栏 | R2 密钥防泄露、OPS-MAN-169 §4 |

### 3.2 命名约定

- **ID**：`<DOMAIN>-<3 位数字>`，数字在域内全局递增、不复用、删除不回收（呼应 MGMT-STD 编号规则）。
- **名称**：中文 ≤20 字，名词或动宾短语，不以「规则 / 规范」等泛词结尾。
- **单一职责**：禁止两条规则同 domain 同 subject；若发现，必须合并或拆父子（父 `DOMAIN-NNN` + 子 `DOMAIN-NNN.1`）。
- **跨域引用用 ID**，不抄正文；正文只做「指针 + 摘要」，语义真源另存（呼应 OPS-MAN-169「索引层」原则）。

### 3.3 三元性质标签（跨域正交维度）

`nature` 与 `domain` **正交**：域管「管什么」，性质管「这条规则以哪种姿态生效」。每条规则必须标注 nature：

- **约束为主**：绝大多数存量红线（RUNTIME/LAYOUT/SECURITY 多数）。仍须补 `grants`/`benefit`——约束的背面就是被授予的资格与省下的决策成本。
- **权力为主**：明确授予行动资格的规则。例：`PROCESS` 域「贡献者可在对应 DOMAIN 下提案新规则」——授予提案权，其约束边界是「须按 §1 模板 + 查重」。权力型规则**必须有显式约束配对**，否则视为任意性、不予通过。
- **福利为主**：提供默认路径 / 模板 / 预批准模式、降低遵循成本的规则。例：DOCS 域「新建文档可用 `npm run docs:scaffold` 生成带 frontmatter 的骨架」——福利是「不必手查命名规则」。
- **复合**：多数现实规则是复合的，注明主次即可（如「约束为主，兼权力与福利」）。

> **配对铁律**：任何 `grants`（权力）都必须能在同卡 `constraint`/`scope`/`exception` 中找到其边界；找不到边界的权力 = 任意性，评审一票否决。

---

## 4. 生命周期流程（新增 / 评审 / 修订 / 废弃）

### 4.1 状态机

```
draft → active → deprecated → archived
（紧急安全撤回可 draft 直跳 archived）
```

### 4.2 新增

1. 按 §1 模板起草，**必须填全三元字段**（`constraint`/`grants`/`benefit`），状态 `draft`，分配候选 ID（域内最大序号 +1）。
2. **查重**：在 `docs/_规范/RULES-REGISTRY.json` 与代码检索确认无同 domain 同 subject（呼应 SOURCING/BORROW-005 四步检索）。
3. **评审**：提 PR，至少 1 名维护者 + 自动守卫（`docs:verify`、`check-gov-rules`、`check-agent-rules --changed` 若涉 RUNTIME）。
4. **激活**：合并后置 `active`，登记进 `RULES-REGISTRY.json` 与对应索引。

### 4.3 修订

- 版本号 bump：破坏性 → 主版本；兼容补充 → 次版本。
- 追加版本记录行，**禁止原地改写历史表述**（呼应 SOURCING/BORROW-006 追加不重写）。
- 破坏性修订须含：兼容期 + 迁移说明 + `removedIn` 版本（呼应 TOOL-003 / API-002）。
- 任何对 `grants`（权力）的缩减，须同步说明替代路径与过渡期——**不得无声剥夺既有权力/福利**。

### 4.4 废弃

- 置 `deprecated` + `removedIn` + `supersededBy`（替代规则 ID，含其承接的 `grants`/`benefit`）。
- 保留正文至 `removedIn` 版本（兼容期），之后移入 `docs/_规范/archive/`。
- 编号作废不回收（避免指代歧义）。

### 4.5 复核节奏

- 每个大版本（`x.0.0`）或每季度，跑一次「规则健康检查」：字段完整率（含三元字段）、未裁决冲突数、重复率、福利覆盖率（有多少 active 规则填了非空 `benefit`）。

### 4.6 正向激励（落实「福利」与可执行路径）

本规范以「遵循成本低于违反成本」为设计目标，具体激励：

1. **模板即福利**：`npm run rules:scaffold <DOMAIN>` 生成带 §1 frontmatter 骨架的规则卡，不必手查字段与命名。
2. **符合格式即自动过守卫**：`check-gov-rules.js` 对字段齐全、ID 唯一、无未裁决冲突的规则卡直接放行，**省去人工格式评审**。
3. **低冲突 / 低重复域快速评审**：健康检查中冲突数与重复率为零的域，其新增规则走「维护者单签即过」，缩短等待。
4. **优质提案快通道**：被采纳为 `active` 且季度内零冲突的规则提案，提案者获「规则贡献者」认可，下次提案默认进入快通道。
5. **健康度可视化**：`RULES-REGISTRY.json` 导出看板，展示各域规则数、冲突数、福利覆盖率，让「做对的事」有正向反馈。
6. **预批准模式**：在 `RULES-REGISTRY.json` 登记的默认 glob / 模板 / 迁移说明，视为「已批准路径」——走这些路径无需另行论证，降低决策成本。

---

## 5. 存量规则迁移落地步骤

**现状**：规则散落于 `AGENTS.md`（工程规则 1–4 + 子规则）、`[DESIGN-ARCH-070]`（GOV-* 六板块）、`[OPS-MAN-169]`（R1–R4 + 索引）、`[MGMT-STD-001/007]`（文档规范）、`CLAUDE.md`（章程红线）。

**目标**：全部纳入 §1 规则卡 + §3 分类 + 三元性质 + 单一真源登记表。

**落地状态（2026-09-15 元规则审查后）**：步骤 1–9 已按下列状态推进。
`docs/_规范/RULES-REGISTRY.json` 是**规则族级**登记表（一条登记项 = 一族规则，`ssot` 指向该族正文），
而非逐条展开所有 GOV-* 编号——逐条编号仍保留在 `[DESIGN-ARCH-070]` 对应板块表格中，登记表
按 §5 第 7 步以「指针 + 摘要」方式引用，避免两套真源互相漂移。

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1 | 盘点 → `RULES-INVENTORY.md` | 🟡 已完成于本轮审查的核对过程；未落独立文件（盘点结论并入 RULES-REGISTRY.json 的 `ssot` 与 `[DESIGN-ARCH-070]` §0 审计矩阵） |
| 2 | 分类映射，分配 `<DOMAIN>-<NNN>` + `formerly` | ✅ 全族映射完毕，见 `RULES-REGISTRY.json` |
| 3 | 三元性质标注 + 补 `grants`/`benefit` | ✅ 登记表每条均含三元字段 |
| 4 | 去重 / 合并 | ✅ 已消除 3 处重叠（见下方「已裁决」）；状态透明父子结构改为 `RUNTIME-002` 一族 |
| 5 | 补字段 | ✅ 优先级 / 触发 / 例外 / 版本 / owner / 三元字段齐备 |
| 6 | 冲突预检 → `RULES-CONFLICTS.json` | 🟡 冲突已在人工评审中消解并记录于 §2.4；`RULES-CONFLICTS.json` 未建（当前零未裁决冲突，建空文件无信息量） |
| 7 | 建登记表 + 章程改「指针 + 摘要」 | ✅ 登记表已建；`AGENTS.md` 工程规则正文保留并标注 ID，`OPS-MAN-169` 定位为索引层 |
| 8 | 机械守卫 | ✅ `check-gov-rules.js` 校验字段齐全 / ID 唯一 / 枚举合法 / 三元标签 / 权力-约束配对 / 同域同名重叠（GOV-TOOL-006）；`check-rules-registry.js` 校验登记表与真源标记行双向可达（GOV-TOOL-007）、规则卡与登记表逐字节一致（GOV-TOOL-008） |
| 9 | 分批上线 | ✅ 单批完成（全十个域），`node scripts/ci/check-gov-rules.js` 全绿 |
| 10 | 逐条规则卡（§1 形态） | ✅ `docs/_规范/规则卡/` 每族规则一张卡 + `00_INDEX_规则卡总目录.md`，由 `npm run docs:rules-cards` 从登记表渲染，卡片为构建产物、禁手改（裁决 X-006） |

### 5.1 已裁决的重叠与冲突（追加记录，不改写历史表述）

| 编号 | 冲突 | 裁决 |
|------|------|------|
| X-001 | `[MGMT-STD-001]` CP-6「规范中写死具体编号格式 = 违规」 vs `[MGMT-STD-007]` R3/§2.4「业务文档必须带 `[<STAGE>-<TYPE>-NNN]` 前缀」 | 按 §2.2「重叠即违规」须合并、不靠优先级。裁决：**按 scope 分层**。CP-6 收窄为只管「索引文件命名格式」（`00_INDEX_*` 的具体形态），由执行 AI 依目录惯例决策；业务文档编号前缀属 `check:layout` 的 `docs-index-complete`/`docs-index-first` 机器可判定输入与跨阶段检索键，**必须写死**，不受 CP-6 管辖。已在 `[MGMT-STD-001]` §2.3 追加 scope 收窄条款（v2.0.0） |
| X-002 | 版本同步口径三重矛盾：`AGENTS.md` 称「两轨道 6 源」、`[OPS-MAN-169]` §六称「三真源」、`check-version-sync.js` 实为「三轨道 9 源」 | 裁决：**代码为准**，真源是 `scripts/ci/check-version-sync.js` 的 `specs` 数组。`AGENTS.md` 版本同步节改为三轨道 9 源；`[OPS-MAN-169]` §六与 `[DESIGN-ARCH-106]` §9.2 改为指针 + 摘要 |
| X-003 | `[OPS-MAN-169]` §一 声明「R1–R4 强制真源是 `CLAUDE.md`「一、红线」节」，但该节已不存在（CLAUDE.md 于 2026-09-09 改为 CC TUI 任务说明） | 裁决：**真源复活**而非改指针——`CLAUDE.md` 恢复「项目章程」第一章（R1–R4 红线、B1–B3 行为准则），CC TUI 内容降为限期任务上下文节。死指针另有 3 处一并修复：`.ai/GUARDS-AI.md`（不存在）、`npm run maintainer:check`（所有 package.json 均无此入口）、`node scripts/check-agent-rules.js`（正确路径为 `scripts/ci/`） |
| X-004 | `[DESIGN-ARCH-070]` §3 只登记 GOV-TOOL-001~005，但 `check-gov-rules.js` 已实现 GOV-TOOL-006；治理总纲亦未登记 RUNTIME / PROCESS / SECURITY / DOCS 四域，而 MGMT-STD-008 §3.1 已把这四域列为一级域 | 裁决：**治理总纲板块与 §3 十大域一一对应**，补 GOV-RUNTIME / GOV-PROCESS / GOV-SECURITY / GOV-DOCS 四板块与 GOV-TOOL-006 条目；`GOV-MOD-004` 由「六板块」改为「十板块」，`check-gov-rules.js` 的 `REQUIRED_BLOCKS` 同步扩展并接入 PR gate |
| X-005 | `[DESIGN-ARCH-070]` §9 UC-LAYOUT-001 以「违反 `[MGMT-STD-001]` 第 2.1/2.2 条」为据裁决「05_GUIDE 与 05_TEST 同级编号重复」，但 2.1/2.2 只规定索引必须存在且排序首位，不含阶段编号唯一性 | 裁决：**引用更正**为 `[MGMT-STD-007]` §2.1 编号轴（阶段目录与编号前缀一一对应），裁决结论不变 |
| X-006 | §1.1「每条规则必须是一张规则卡」 vs §5 第 7 步「登记表是规则族级、`ssot` 指向族正文，避免两套真源互相漂移」——若卡片字段由人工独立撰写，登记表与 44 张卡片就是同一组字段的两个手写副本 | 裁决：**卡片为构建产物，登记表是唯一字段真源**。`docs/_规范/规则卡/` 下的卡由 `scripts/docs/gen-rules-cards.js` 从 `RULES-REGISTRY.json` 渲染（YAML frontmatter 14 字段 + 六个固定小节），登记条目即卡片源；`ssot` 仍指向族正文（规则由谁撰写），新增可选字段 `enforcement` 指向执行/常量真源代码。§1 要求的**形态**（一卡一规则、字段齐、小节齐）由 `npm run docs:rules-cards` 产出并 `check:rules` 守卫，§5 要求的**不漂移**由 TOOLING-008 的逐字节脏 diff 判断保证；两者由此互补而非冲突。守卫不自行复刻渲染逻辑——否则守卫就成了第二份副本，恰是 X-006 要防的漂移 |

---

## 6. 示例（校准格式用）

### 示例 A：RUNTIME-001 零硬编码（迁移自 AGENTS.md 规则 1，约束为主）

```yaml
---
name: 零硬编码
id: RUNTIME-001
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "services/**, apps/**, platform/**, software/**, kernel/**, tools/**, scripts/**（非测试文件）"
priority: P1
trigger: 源码中出现网络端点 / 文件系统路径 / 第一方生产域名的字面量时
constraint: 禁止硬编码 IP、端口、绝对路径、第一方生产域名（khyquant.top/.com/.cn）；端点必须从 constants/serviceDefaults.js 导入或由 env 覆盖
grants: 授权从 serviceDefaults 或 env 动态读取端点（合法配置来源资格）
benefit: 不必猜测端口/域名；统一来源降低联调与自托管部署成本
exception: 测试文件、serviceDefaults.js 本身、纯注释/品牌/示例、含 ${} 插值、new URL() 解析、纯主机探测比较、纯邮件地址、localhost+变量拼接
version: "1.0.0 (2026-09-15) 迁移自 AGENTS.md 规则1"
status: active
ssot: AGENTS.md#工程规则-规则1 / scripts/ci/check-agent-rules.js
formerly: 规则1/零硬编码
owner: backend-team
---
```

**约束**：源码不得出现字面量 IP、端口、绝对路径、第一方生产域名（除非位于 `constants/serviceDefaults.js` 或 `.env` 模板）；生产端点必须从 `serviceDefaults` 导入或 `process.env.X || default`（注意 env 回退不豁免域名固化）。

**授予权力**：任何模块均有权使用 `serviceDefaults` / env 作为端点来源——这是被明确授权的合法配置通道。

**提供福利**：不必记忆各环境端口/域名；切换部署目标只改 env，不改代码，降低联调与自托管成本。

**反例**：❌ `fetch('http://localhost:3000/api')` → ✅ 从 `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` 读取。

**校验方式**：`node scripts/ci/check-agent-rules.js --changed`；`grep -rn 'localhost:[0-9]' --include='*.js' --include='*.vue' --include='*.ts'`。

**例外**：见 frontmatter；完整豁免清单与判定见 `AGENTS.md` 工程规则 1 原文。

**版本记录**：1.0.0 (2026-09-15) 迁移自 AGENTS.md 规则1，套用 MGMT-STD-008 规则卡 + 三元字段。

### 示例 B：PROCESS-101 贡献者规则提案权（新立，权力为主）

```yaml
---
name: 贡献者规则提案权
id: PROCESS-101
domain: PROCESS
nature: 权力为主，兼约束
scope: "任何仓库贡献者（含 AI 代理）"
priority: P2
trigger: 贡献者认为需要新增 / 修订一条规则时
constraint: 提案须按 §1 规则卡模板起草、填全三元字段、并完成 §5 查重（无同 domain 同 subject）
grants: 授权任何贡献者在对应 DOMAIN 下发起新规则草案（draft）并提 PR，无需事前审批
benefit: 不必先征询可否提案；模板 + 查重即路径，降低「要不要提、怎么提」的决策成本
exception: 涉及 P0 宪法级的修订仍须 §2.1 维护者+独立复核门槛（不可由本权力绕过）
version: "1.0.0 (2026-09-15) 由 MGMT-STD-008 引入"
status: active
ssot: MGMT-STD-008#4.2 新增
formerly: 无
owner: governance-team
---
```

**约束**：提案必须套 §1 模板、填全三元字段、查重通过；否则 PR 守卫直接驳回。

**授予权力**：任何贡献者（含 AI 代理）均有权发起规则草案并提 PR——事前无需审批。

**提供福利**：把「能不能提、怎么提」变成一条明确路径（模板 + 查重），消除提案前的犹豫与反复确认成本。

**反例**：❌ 在 issue 里口头讨论「要不要加条规则」却不落卡 → ✅ 直接 `npm run rules:scaffold PROCESS` 起草草案提 PR。

**校验方式**：`node scripts/ci/check-gov-rules.js`（字段齐全 + 查重）；PR 评审。

**例外**：见 frontmatter（P0 修订门槛不被本权力绕过）。

**版本记录**：1.0.0 (2026-09-15) 由 MGMT-STD-008 引入，落实「规则即权力与福利」。

---

## 7. 机械守卫与命令速查

| 命令 | 覆盖 | 作用 |
|------|------|------|
| `node scripts/ci/check-gov-rules.js` | 全部 | 校验治理入口十板块（GOV-MOD-004）、检查入口脚本存在（GOV-TOOL-004）、PR gate 接线（GOV-TOOL-005）、规则登记表字段完整性含三元 / ID 唯一 / 枚举合法 / 权力-约束配对 / 同域同名重叠（GOV-TOOL-006）、ACP transport 契约（GOV-ACP-003/004） |
| `node scripts/ci/check-agent-rules.js --changed` | RUNTIME | 硬编码（RUNTIME-001）/ 状态文本（RUNTIME-002）/ 超时（RUNTIME-003）/ 滚动区（RUNTIME-004）/ 无界循环 |
| `npm run check:layout` | LAYOUT | 层级 / 根目录白名单 / 任务入口 / docs 索引 |
| `npm run check:duplication` | SOURCING | 重复实现 / 能力域唯一性 |
| `npm run check:structure` | 全部结构类 | 根级聚合入口，已包含 `check:gov-rules`（GOV-TOOL-005 强制） |
| `npm run docs:verify` | DOCS | 孪生件 + 本地链接全可达 |
| `npm run rules:scaffold <DOMAIN>` | DOCS/PROCESS | 生成带 §1.1 全字段的规则卡骨架到 `docs/_规范/`（福利：免手查格式，§4.6 第 1 条） |
| `docs/_规范/RULES-REGISTRY.json` | 全部 | 规则单一真源登记表（已建，由 GOV-TOOL-006 校验） |

---

## 8. 本文件自身合规声明

- **ID**：`MGMT-STD-008`　**domain**：`DOCS`　**priority**：`P2`　**nature**：`约束为主、兼权力`　**status**：`active`（已发布激活）。字段全量见文件头 YAML frontmatter，本文的 SSOT 即自己。
- **授予权力**：任何维护者可按本规范起草并提案新规则（见 PROCESS-101）。
- **提供福利**：模板 `rules:scaffold` + 守卫自动过审，使遵循本规范的成本低于违反成本。
- **合规记录（发布后已兑现，2026-09-15）**：
  - ✅ 同名 `.html` 孪生件已生成（`npm run docs:build` 产物，不手改）。
  - ✅ 两处索引已登记：`docs/08_MGMT_项目管理/00_INDEX_项目管理-分类索引.md` 与 `docs/00_INDEX_文档索引.md`。
  - ✅ 已登记进 `docs/_规范/RULES-REGISTRY.json`，`status: active`，由 `check-gov-rules.js`（GOV-TOOL-006）校验字段完整性、ID 唯一性与权力-约束配对。
  - ✅ 元规则自查已落实：本文档头部即 §1.2 规则卡 frontmatter，14 个字段齐备；`status` 全文统一为 `active`（v1.0.0 曾出现正文 `draft` 与 §8 `active` 并存，v1.1.0 已消除）。
- **登记字段名对齐**：登记表与本文统一使用 `formerly`（曾用标识）；登记表曾使用 `formerId`，v1.1.0 已改齐。

### 8.1 元规则自身的边界（防止元规则任意性）

本文只管「规则怎么写、怎么管」，**不改写任何业务规则的语义**。以下三类事本文**无权**决定，须由对应真源裁决：

1. 规则的具体语义与豁免清单（真源为准，例如 RUNTIME-001 的豁免以 `AGENTS.md` 工程规则 1 为准）；
2. P0 宪法级规则的修订门槛（§2.1 维护者 + 独立复核 + 公告）；
3. 域间 precedence 的填写内容（§2.4 仅在 §2.2.4 / §2.3 触发后由维护者填写）。

### 8.2 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 初版：定义规则卡格式、十大域、优先级四档、冲突裁决算法、生命周期与存量迁移步骤 |
| 1.1.0 | 2026-09-15 | 元规则自查修复：补自身规则卡 frontmatter；`status` 统一为 `active`；登记字段名 `formerly` 对齐；治理总纲板块与 §3 十大域建立一一对应；补 §8.1 元规则边界 |
