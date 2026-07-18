# [OPS-MAN-169] 项目规则总纲：命名 · Skill · 权限 · MCP

> **参考手册 · 一站式规则索引** · 把散落在 `CLAUDE.md` / `AGENTS.md` / `.ai/GUARDS.md` / `[OPS-MAN-005]` / `[OPS-MAN-058]` 与各处代码里的「项目规则」收拢到**一张地图**：① 红线；② 文档命名规则；③ Skill 规则；④ 权限规则；⑤ MCP 规则。
>
> **一句话定位**：本文是规则的**索引层与导读**，不是真源。每一条规则都标了它的**强制真源**（代码读取点或章程原文），按名 `grep` / 打开即可核对。规则语义**永远以真源为准**；本文变旧时，先信真源。
>
> **谁该读**：单人维护者、接手者、以及任何要改本仓库的人（含 AI）。改动前先扫本文对齐红线，再翻对应章节的真源。

---

## 一、红线（破了就停，不许绕）

四条红线的强制真源是 `CLAUDE.md`「一、红线」节，此处为速查摘要。**任一破线 = 立即停手，须用户明确点头方可继续。**

| # | 红线 | 一句话 | 真源 / 守卫 |
| --- | --- | --- | --- |
| R1 | **分支纪律** | 禁止直接在主干开发；**禁止 AI 自动 `commit`/`push`**，必须用户明确点头 | `CLAUDE.md` §1；分支保护基线见 `[OPS-MAN-009]` |
| R2 | **密钥防泄露** | 真 key/token **永不进 bundle / 源码 / 提交**，只经 env 变量瞬时注入、绝不落盘；发包前 `wheel` 对已知泄露 key **0 命中**；占位 key 必须一眼假 | `CLAUDE.md` §2；密钥家族见本文 §4.6 与 `[OPS-MAN-058]`「密钥/凭证」 |
| R3 | **双渠道版本同步** | pip `khy-os` 与 npm `@khy-os/khy-os` 版本号必须一致 | `CLAUDE.md` §3；守卫 `scripts/ci/check-version-sync.js`；三真源见本文 §6 |
| R4 | **上帝文件门** | 任何文件不得**新增**超过 `arch:god` **2500 行**上限；拆解走 god-file governance（同名 re-export + DI 保字节等价） | `CLAUDE.md` §4；阈值 `services/backend/src/services/projectHygiene/thresholds.js` |

### 行为准则 B1–B3（方法论真身，真源 `CLAUDE.md` §二）

- **B1 先想再写**：动手前讲清改什么、为什么、影响面。
- **B2 目标驱动执行**：给定**可验证的成功标准** → **自循环到验证通过** → 才回报；多步任务**先列 plan、每步带 verify**；**没跑过验证不许说「修好了」**。
- **B3 外科手术式改动**：只动该动的；不顺手重构；god-file 抽取保函数体字节不变。

### 验收门禁（会亮红灯的命令 = 「做完的定义」，任一红即未完成）

```
node --check <改动文件>                # 语法
<相关 jest / node:test 全绿>           # node:test 文件须 node --test，勿用 jest 前缀
npm run arch:god                       # 改动文件不得新增超限（本仓由 change-safety + 阈值承载）
node scripts/check-change-safety.js --changed
node scripts/check-agent-rules.js --changed
npm run maintainer:check               # 维护映射表 + 元数据一致
```

> 三守卫须在**仓库根**跑；untracked 新叶子须**显式**传路径扫描。

---

## 二、文档命名规则

强制规则真源是 `[MGMT-STD-001]`（文档体系标准）；速查摘要另见 `[OPS-MAN-058]` 第三节。本节收拢关键规则。

### 2.1 文件名格式

```
[阶段-类型-序号] 中文名.md
```

- **示例**：`[OPS-MAN-169] 项目规则总纲.md`、`[DESIGN-ARCH-012] 网关架构.md`、`[CONCEPT-05] 什么是Skill-技能.md`。
- 方括号 `[]` 与编号是**强制**的；方括号后**一个空格**再接中文名。
- 中文名简洁达意，必要时用半角连字符 `-` 连接关键词。

### 2.2 阶段码（与编号目录一一对应）

| 阶段码 | 目录 | 含义 |
| --- | --- | --- |
| `INIT` | `01_INIT_立项/` | 项目启动 / 立项 |
| `CONCEPT` | `02_CONCEPTS_概念入门/` | 面向小白的概念入门（用两段式 `[CONCEPT-NN]`） |
| `DESIGN` | `03_DESIGN_设计/` | 架构与设计 |
| `IMPL` | `04_IMPL_实现/` | 实现 |
| `TEST` | `05_TEST_测试/` | 测试 |
| `DEPLOY` | `06_DEPLOY_部署/` | 部署 / 发布手册 |
| `OPS` | `07_OPS_运维/` | 运维与使用手册（本文所在） |
| `MGMT` | `08_MGMT_项目管理/` | 项目管理 / 标准 |
| `STORY` | `09_STORY_修仙学AI/` | 面向小白的修仙叙事（须含 `## 📒 凡人笔记`） |

### 2.3 类型码

| 类型码 | 含义 |
| --- | --- |
| `PRD` | 需求 / 产品 |
| `ARCH` | 架构设计 |
| `MAN` | 手册 / 指南 / 清单（运维类最常用） |
| `RPT` | 报告 |
| `PLAN` | 计划 |
| `STD` | 标准 / 规范 |
| `OTHER` | 其它 |

### 2.4 序号

- 三位零填充、**全局按类型递增、不复用**（删除文档后编号**作废不回收**，避免指代歧义）。
- 新建文档前，先看目标目录该类型现有**最高编号 +1**（编号有历史断档是正常的，跳号不回填）。

### 2.5 强制配套（新建/删除文档时）

1. **`.md` 必有同名 `.html`**：由 `npm run docs:build` 生成，`scripts/docs/verify_docs_site.js` 硬门校验（缺 HTML 报错、非零退出）。**不手写 HTML**。
2. **同步两处索引**：① 所在目录的 `00_INDEX_<中文>-分类索引.md`「文件清单」表；② 主入口 `docs/00_INDEX_文档索引.md` 对应分区列表 + 顶部计数。
3. **概念 / 故事目录额外守规**：`docs/02_CONCEPTS_概念入门/` 与 `docs/09_STORY_修仙学AI/` 受 `scripts/docs/check_beginner_docs.js`（`npm run docs:check-beginner`）约束——禁孤儿页、禁死链、禁无导航死胡同页；`CONCEPT` 前缀须**连号不跳**；故事文档须含 `## 📒 凡人笔记`。

### 2.6 特殊（非编号）目录

- `传承/`——无 AI 也能维护的生存文档（`KHY-OS-传承书.md`、`紧急恢复卡片.md`）。
- `报告/`、`模板/`、`维护者/`、`设计模式/`——按各自约定命名。
- `.ai/`（仓库根，非 `docs/`）——机器生成的种子文档（`MAP.md`、`CONTEXT.yaml`、`GUARDS.md`、`SKELETON.auto.md`），由 `khy metadata refresh` + pre-commit 钩子确定性维护，**不手改**。

### 2.7 校验/构建命令速查

```
npm run docs:build           # 生成/刷新每个 .md 的 .html
npm run docs:verify          # 硬门：每 md 有 html + 本地链接全可达 + 离线资产齐
npm run docs:lint            # 互动件（callout/quiz/flip/popover/timeline/scene）语法
npm run docs:check-beginner  # 概念/故事目录的小白友好度不变量
```

---

## 三、Skill 规则

> **注意：本仓库有两套并存的「skill」体系，别混为一谈。**一套是 Claude Code 侧的斜杠命令（`.claude/commands/`），一套是 khy 原生的 `SKILL.md` 技能引擎（`services/backend/src/skills/`）。二者经 CC 桥接互通。

### 3.1 Claude Code 斜杠命令（`.claude/commands/`）

- 位置：`<repo>/.claude/commands/<name>.md`（项目级）；用户级在 `~/.claude/commands/`。
- 格式：CC 风格 Markdown，YAML frontmatter（`description`、`argument-hint`）+ 正文用 `$ARGUMENTS`。
- 代表：`.claude/commands/goal.md` = `/goal`「目标驱动执行」，正文即 §一的 B2 自循环协议（**轮数上限 6**、每步带 verify、未验证不许声称完成）。
- 用户键入 `/<name>` 即调用；本仓约定：只调用**列在可用清单里**的 skill，不臆造名字。

### 3.2 khy 原生 SKILL.md 技能引擎

- 真源：`services/backend/src/skills/skillLoader.js`（`SKILL_FILENAME = 'SKILL.md'`）。
- **frontmatter 规范字段**：`name, version, description, layer (system|application|domain), lifecycle (development|testing|deployment|operations|maintenance), tags, platforms, dependencies`。
- **发现链（先到先得，first match wins）**：
  1. 项目 `./.khy/skills/` → 旧版 `./.khyquant/skills/`
  2. 用户 `~/.khy/skills/` → `~/.khyquant/skills/`
  3. 内置 `services/backend/src/skills/<category>/<name>/SKILL.md`
  4. CC 桥接（门控 `KHY_CC_SKILL_BRIDGE` **默认开**）**追加在最后**
- 另有**目录式**技能格式（`services/backend/src/skills/index.js`）：`skill-name/manifest.json` + `prompt.md` + 可选 `handler.js`，字段 `name, description, trigger, user_invocable, tags`；公共 API `discoverAllSkills / getSkillCommands / executeSkill / getSkillPrompt`。
- 内置技能示例：`devops/git-workflow/`、`quant/quant-analysis/`、`security/cve-query/`、`system-admin/linux-admin/`、`monitor-perf/system-monitor/`。

### 3.3 CC ↔ khy 桥接与安全

- 桥接真源：`services/backend/src/skills/ccSkillBridge.js`（纯叶子，单一真源）——复用 CC 技能目录 `~/.claude/skills/`、`<project>/.claude/skills/`、`~/.claude/plugins/cache/`、`~/.claude/local-plugins/`。门控 `KHY_CC_SKILL_BRIDGE` 默认开；关闭即逐字节回退「khy-only 发现」。
- 安全：技能装载前经 `services/backend/src/services/skills/skillThreatScanner.js` 威胁扫描；相关服务 `skillRegistry.js / skillInstallService.js / skillSearch.js / skillCuratorService.js / activeSkillContext.js`。
- 概念入门：`[CONCEPT-05] 什么是Skill-技能`。

### 3.4 扩展约定（HOW-TO-EXTEND）

- 新增内置技能：在 `services/backend/src/skills/<category>/<name>/` 放一份 `SKILL.md`（含上述 frontmatter），发现链自动纳入。
- 注册表类叶子上方须留**抄写式 HOW-TO-EXTEND 注释**（`CLAUDE.md` §四）。
- 新子系统必须登记进 `docs/维护者/维护映射表.json`（`whenToUse` / `paths` / `docs` / `verify`），`npm run maintainer:check` 守着。

---

## 四、权限规则

> 分层、**失败即拒（fail-closed）**。核心真源是 `services/backend/src/services/permissionStore.js` 与 `services/backend/src/services/riskGate.js`——**不是** `permissions/` 目录（旧 `mode` 层已退役，见 `permissions/index.js`）。

### 4.1 权限档（profiles / tiers）

真源 `permissionStore.js`（`VALID_PROFILES`），共 **6 档**：

| 档位 | 行为 |
| --- | --- |
| `strict` | 所有工具都问，含安全工具 |
| `normal` | 安全工具自动放行，其余问（**默认**） |
| `acceptEdits` | normal + 非破坏性文件编辑自动放行（shell/破坏性仍问） |
| `auto` | 常规调用自动放行；**high/critical 风险仍问**（`_AUTO_ASK_RISKS = {high, critical}`） |
| `dontAsk` | 未显式 allow 的一律拒 |
| `yolo` | 全部自动放行（`--dangerous`） |

- 审批持久化在 `~/.khyquant/permissions.json`；作用域 `VALID_SCOPES = ['once','session','forever']`。
- 档位由 TUI Shift+Tab 循环切换（`cli/tui/ink-components/App.js` / `cli/repl.js`）。
- 相关 env：`KHY_PERMISSION_MODE`、`KHY_PERMISSION_STORE`、`KHY_PERMISSION_POLICY`、`KHY_AUTO_APPROVE_READONLY`（家族全表见 `[OPS-MAN-058]`「KHY_PERMISSION_*」）。

### 4.2 关键闸门 / 红线（不可绕过 critical gate）

- 真源 `riskGate.js`：`isUnbypassableGate(assessment)` = `stepType === HUMAN_GATE` 且（`riskLevel === 'critical'` 或 `isDestructive === true`）。
- 语义：任何**不可逆**操作（`rm`、`kill`、`drop table`、`git reset --hard`）或显式 `critical`，**即便 `KHY_SYSCALL_GATEWAY=off`、即便 bypass/yolo，也不可绕过**。
- 落地 `services/backend/src/services/toolCallingPermissions.js`：`criticalGate` 经 `riskGate.isUnbypassableGate` 计算；持久化 `allow` 规则或 `policyAutoAllow` **都覆盖不了它**；`acceptEdits`/`bypass` 仅在 `!criticalGate` 时跳过。
- L1/L2 网关（`toolCalling.js`）：L2 红线（删除/全局安装/系统路径/破坏性）**永远要求键入 `YES`**。
- 用户视角说明见 `[OPS-MAN-060] 高危操作为何被拒与如何放行`。

### 4.3 弱模型改动护栏（weakModelChangeGuard）

- 真源 `services/backend/src/services/weakModelChangeGuard.js`；门控 `KHY_WEAK_MODEL_EDIT_GUARD` **默认开**（关闭/异常/入参不全 → 返回 null 逐字节回退）。
- `classifyChangeRisk(filePath)` → `red-line`（`.env`/发布·CI/`flagRegistry` SSOT/版本三源/权限核心/`.git`）｜`sensitive`（god 级：gateway/harness/tool-loop）｜`normal`。
- `assessWeakModelChange`：强档（T0/T1）不限；**弱档 + red-line → 拒，要求强模型复核**；弱档 + sensitive → 放行但须确认。
- 扩展经数据表 `RED_LINE_PATTERNS` / `SENSITIVE_PATTERNS`。用户手册见 `[OPS-MAN-055]`、`[OPS-MAN-168]`。

### 4.4 能力分档（modelTier）

- 真源 `services/backend/src/services/modelTier.js`：`resolveTier` 把模型分 T0 前沿 / T1 强 / T2 默认 / T3 弱，返回 `harnessProfile`。
- **未知模型返 T2**（非 null）——被当「弱以上」保守处理。
- env 覆盖：`KHY_CAPABILITY_TIER`、`KHY_MODEL_TIER_MAP`、`KHY_HARNESS_CAPABILITY_GATE (hard|warn|off)` 等。

### 4.5 规则库与审批网关

- **模式化 allow/deny 规则库**：`services/backend/src/permissions/rules.js`，持久化 `~/.khy/permission-rules.json`；规则 `{toolName, pattern, decision, scope}`；**deny 优先于 allow（fail-closed）**；`checkPermission` 返回 `allow|deny|ask`。
- **系统级审批网关**：`services/backend/src/services/syscallGateway/`（`approvalRouter.js` / `approvalLedger.js` / `guardApproval.js`）；门控 `KHY_SYSCALL_GATEWAY`；设计规范 `[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范`。
- **会话级放行清单**：`.claude/settings.local.json` 的 `permissions.allow`（CC 风格 `Bash(...)`/`Read(...)`，项目/会话作用域）。

### 4.6 密钥红线（承 R2）

- 真源 `services/backend/src/services/customProviderRegistrar.js`；机密**无默认，须显式 env 注入**，不设即对应能力不可用。
- **绝不写入日志/诊断/备份明文**：诊断与备份刻意排除密钥（备份含 `config.json` 会显式警告勿外发）。
- 成员：`KHY_BUILTIN_SENSENOVA_KEY`、`KHY_OWNER_SECRET`、`KHY_SOURCE_PUBLISH_SECRET`、`KHY_STUDY_SECRET`、各 `*_API_KEY`。

---

## 五、MCP 规则

- **项目 MCP 配置真源**：仓库根 `.mcp.json`。当前只注册一个 server（`mcpServers` 键）：
  - `khy-os` → `command: "node"`，`args: ["kernel/bridge/khy-mcp.js", "--socket", "/tmp/khy-agent.sock"]`，`env.KHY_MCP_CONNECT_TIMEOUT_MS: "60000"`。
- **桥接实现**：`kernel/bridge/khy-mcp.js`（打包副本另在 `packaging/npm/bundled/kernel/bridge/`——那是镜像，真源看仓库根的 `kernel/bridge/`）。
- **MCP 工具走同一权限漏斗**：MCP 工具经 `services/backend/src/services/toolCalling.js` 的 `executeTool` 执行，受 §四全部权限档 + critical gate 约束——**MCP 不是权限旁路**。
- 说明：宿主侧的文件系统 MCP（如 `khy-fs`）是**运行环境**提供、**非本仓 `.mcp.json` 声明**；本仓唯一自声明的 MCP server 是 `khy-os`。
- 概念入门：函数调用 vs MCP 辨析见 `[CONCEPT-30] 什么是函数调用与MCP`。

---

## 六、双渠道版本同步（承 R3，发布必读）

- **三个版本真源**（发布前必须一致）：
  1. `pyproject.toml`（`version = "..."`）— pip 包
  2. `packaging/npm/package.json`（`"version": "..."`）— npm 包
  3. `services/backend/src/package.json` 所在的 `services/backend/package.json`（`"version": "..."`）
- `platform/khy_platform/__init__.py` 的 `__version__` **运行时动态解析**，**不得硬编码**。
- 守卫：`scripts/ci/check-version-sync.js`（三真源不一致即报错）；pre-commit 钩子亦校验。
- 发布链路：`scripts/release/publish-dual.sh`（bump 三处 → twine 发 pip → `npm publish --access public`；`--tag` 打 `vX.Y.Z`、`--push` 推送、`--dry-run` 演练不上传），发布门禁 `scripts/release/release-gate.js`。详见 `[OPS-MAN-042] 发布手册-pip与npm-无AI照做` 与 `[OPS-MAN-061] 发布门禁`。

---

## 关联文档（真源与延伸）

- `CLAUDE.md`——项目章程「唯一真源」（红线 R1–R4、B1–B3、验收门禁）。
- `AGENTS.md`——AI + 人的维护指南（工程规则 1–4：零硬编码 / 状态透明 / 活动式超时 / 无滚动区 UI；本地检查 `node scripts/check-agent-rules.js --changed`）。
- `.ai/GUARDS.md` / `.ai/GUARDS-AI.md`——内核与 AI 治理层红线、无 AI 维护法。
- `[MGMT-STD-001]`——文档体系标准（命名规范强制真源）。
- `[OPS-MAN-005]`——Claude Code 规则到 khy 的映射表。
- `[OPS-MAN-058]`——环境开关与文档命名规范（`KHY_*` 全量目录 + 命名速查）。
- `[OPS-MAN-060]`——高危操作为何被拒与如何放行（权限的用户视角）。
- `[OPS-MAN-042]` / `[OPS-MAN-061]`——发布手册与发布门禁。
- `docs/维护者/维护映射表.json`——子系统登记（`maintainer:check` 守）。
