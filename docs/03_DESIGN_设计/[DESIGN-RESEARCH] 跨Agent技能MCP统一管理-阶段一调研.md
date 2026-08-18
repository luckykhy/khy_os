# [DESIGN-RESEARCH] 跨 Agent 技能/MCP 统一管理 — 阶段一调研报告

> 任务：`/goal` 规格「khy-os 跨 Agent 技能/MCP 统一管理（双向：unify 出口 + 存量纳管入口）」之阶段一（只读调研）。
> 日期：2026-08-16　作者：Khy-OS Developer / Claude Opus 5
> 本阶段铁律：只读，禁止任何代码变更。本报告仅陈述现状、证据与实现候选，不含任何改动。

---

## 0. 结论先行（TL;DR）

- 现有一个**单点投资**：`services/backend/src/services/mcp/` 下的 **read 方向桥接**（CC / OpenClaw 的 MCP 配置与技能发现），以及**写 khy 自己**配置的 `mcpConfigStore.js`。
- **双向缺口**：① 没有任何「写他人 Agent 配置」的入口（存量纳管的**写**腿缺失）；② 没有 agent 注册表 / 通用桥接循环（每加一个 agent 就手抄一块 `try{require→isEnabled→iterate→extract→merge}`，见 `mcp/index.js` 921-947 / 956-984 两块一模一样）；③ 技能范式不统一，来源必须靠 `skill.priority` 捕获。
- `khy unify` 是一个**新命令**，需走 CLI 三步走注册（handler + aliases + router case），复用 `handlers/skill.js` 已具备的 import/export 原语。
- 本机实测：桥接代码路径全部存在且默认开启，但**真实环境桥接资产数为 0**（`.claude.json` 无 mcpServers、无 `.openclaw/`、无其他 agent config）——降级路径是真实常态。
- 仓库根目录与简报不符（简报 `d:\Portable\khy-os`，实际 `C:\khy-os`；D: 不可见）。全程在 `C:\khy-os` 工作。

---

## 1. 现状地图（含文件 + 行号证据）

### 1.1 MCP 配置方向

**只读发现（双向的“入”腿，已存在）：**

- `services/backend/src/services/mcp/ccMcpBridge.js`（纯叶子，152 行）：
  - `isCcMcpBridgeEnabled(env)`（第 36-42 行）：`KHY_CC_MCP_BRIDGE` 门控，默认 ON，`_FALSY = new Set(['0','false','off','no'])` 兜底。
  - `ccMcpConfigSources()`（第 60-87 行）：枚举 CC 的三个配置位——`~/.claude.json` user scope、`~/.claude.json` projects[dir] scope、`<projectDir>/.mcp.json`。**三个位置 `mcpServers` 的 schema 与 khy 逐字节相同**（第 11-12 行注释）。
  - `extractMcpServers(raw, kind, projectDir)`（第 118-145 行）：纯函数抽 map，含 `_projectEntry` 路径归一（第 90-107 行）。
- `services/backend/src/services/mcp/ocMcpBridge.js`：OpenClaw 对应件，mcp servers 在 `<~/.openclaw>/openclaw.json` 的 `mcp.servers`（JSON5）。
- `services/backend/src/services/mcp/index.js` `loadConfig()`（第 912-1044 行）：
  - CC 桥接块（第 921-947 行）、OpenClaw 桥接块（第 956-984 行）——**两块结构手抄复制**，逐 server 打 `_ccBridged` / `_ocBridged` 注释（第 937、974 行），并以最低优先级并入（`_scope: USER`）。
  - 之后加载 khy 自己的 user / legacy / project 配置（第 986-1041 行）。

**写自己配置（只写 khy，不写他人）：**

- `services/backend/src/services/mcp/mcpConfigStore.js`（159 行）：`addServer`（第 93 行）、`removeServer`（第 109 行）、`setServerEnabled`（第 132 行）。
  - `scopePath()`（第 29-46 行）：只解析 khy 自己的 `mcp.json`（user `<dataHome>/mcp.json` 或 project `.khy/mcp.json`）。
  - **明确只写 khy 一方**：文件头注释（第 6-11 行）说明它做「按 scope 定点读改写」，避免 `saveConfig` 把整块内存 config（含 CC-bridge、project 来源）回写 user 文件。
  - 原子写用 `utils/atomicWriteJson`（第 21 行），`readConfigFile` 损坏时**抛错而非覆盖**（第 66-69 行）——符合 F2 的「不静默吞掉用户已有配置」。

### 1.2 技能方向

**只读发现（双向的“入”腿，已存在）：**

- `services/backend/src/skills/skillLoader.js` `discoverSkillsDeep(projectDir, opts)`（第 248-322 行）：
  - 搜索路径优先级（第 253-276 行）：project（`.khy/skills` → `.khyquant/skills`）→ user（canonical + `~/.khy/skills` + `~/.khyquant/skills`）→ builtin（`__dirname`）。
  - CC 桥接追加（第 284-293 行，`ccSkillBridge.ccSkillSearchPaths`）、OpenClaw 桥接追加（第 303-312 行，`ocSkillBridge.ocSkillSearchPaths`）——**都追加在 khy roots 之后**，故 khy 原生 SKILL.md 优先（first match wins）。
  - `_scanDirectory(dir, skills, source)`（第 327 行起）：第 347 行 `skill.priority = source` ——**来源在这里捕获**，是双向出口方向的来源依据。
  - 去重 key = `entry.name`（目录 basename），第 340 行 first-match-wins。
- `services/backend/src/skills/index.js`（合并编排器）：
  - `discoverSkillsDeep`（第 100-168 行）merge：manifest-based 的 skill **Wins**，legacy SKILL.md 通过 `_convertLegacySkill` 填补空缺。
  - `_convertLegacySkill(id, legacySkill)`（第 701-732 行）：`source: legacySkill.priority || 'builtin'`（第 704 行），`promptPath: legacySkill.source`，`dir: path.dirname(legacySkill.source)`，`_legacyBody`。**来源在 Skill 构造时保留**。
  - `_buildSkill(manifest, skillDir, source)`（第 646-695 行）：`source` 字段直接来自 manifest。
  - `findSkill(identifier)`（第 488-514 行）、`executeSkill(name, args, context)`（第 525-616 行，A1 allowed-tools、A2 enabled gate）。

**两种技能范式不共享单一构造点：** legacy `.js` skills + `<id>.meta.json`（skillRegistry.js `BUILTIN_SKILLS` 第 51-92 行、meta 写入第 264-282 行）与 manifest.json 技能库（skills/index.js + skillLoader.js + skillPackageService.js）。来源必须靠 `_scanDirectory` 设的 `skill.priority`。

### 1.3 CLI 命令注册（新命令三步走表面）

`khy unify`（若实现为新命令）需三步：

1. **handler**：`services/backend/src/cli/handlers/<cmd>.js` 导出 `handleXCommand`。「skill」的先例：`handlers/skill.js` `handleSkillCommand(subCommand, args, options)`（第 685 行导出），已内建 list/install/add/uninstall/search/run/learn/learned/journey/forget/suggest/stats/curator/pin/unpin/archive/restore/enable/disable/**import**/**export**（import/export 走 `skillPackageService`，第 652/669 行）。
2. **aliases**：`services/backend/src/cli/aliases.js` `ALIAS_MAP`（第 461-507 行技能相关、第 669-685 行 CC-parity）。`resolveAlias(input)`（第 727 行）由 `naturalLanguageAliasGuard.isReservedNaturalLanguagePhrase` 守护（`KHY_NL_ALIAS_GUARD`）。第 181-187 行注释：`maintain` 是 canonical 命令，不能设别名（会劫持 canonical 分发）。
3. **router case**：`services/backend/src/cli/router.js` `case 'skill'`（第 2487-2491 行）、`case 'doctor'`（第 1675-1679 行）先例。

### 1.4 stdio 导出方向的运行时路径

- `khy mcp serve [--transport stdio|http]`：handler 在 `services/backend/src/cli/handlers/mcp.js` `_handleServe`（第 124 行），门控 `KHY_MCP_SERVE`（`mcpServerProtocol.isServeEnabled(env)` 第 39-44 行）。**stdio 分支进入常驻循环后绝不能走 formatters/正常收尾打印**（污染专供 JSON-RPC 的 stdout）——头注释第 114-117 行明确。
- Windows 端到端：`khy.bat`（根目录）→ `python -m khy_platform mcp serve` → `platform/khy_platform/cli.py` `os.execvpe(node, args, env)`（第 2720 行，`args = [node, cli_script, ...raw_args]` 第 2580 行）→ Node 后端。Node 通过 node_provisioner 惰性分发（khy.bat 第 94 行注释）。**可行**，但注意是 Python→Node 双进程握手，外部 agent 首次 spawn 需经 node 引导。

---

## 2. 本机运行时探测结果（独立证据）

| # | 探测项 | 结果 |
|---|--------|------|
| P1 | 仓库根目录 | 实际 `C:\khy-os`；简报 `d:\Portable\khy-os`（D: 不可见）。**差异 1** |
| P2 | 六个目标 agent 运行时 | 只存在 `~/.claude` 与 `~/.claude.json`；`~/.claude/skills`、`plugins/cache`、`local-plugins` 不存在；**无 codex/opencode/openclaw/zcode/qoder** 的 config 或 skills。**差异 4** |
| P3 | `~/.claude/plugins/` 实况 | `marketplaces/claude-plugins-official/` 下有 **31 个 SKILL.md**；桥接指向的 `plugins/cache` 路径与真实位置不一致——**路径漂移**。**差异 3** |
| P4 | `~/.claude.json` | 无 `user` scope 也无 `projects[<dir>].mcpServers`（无 mcpServers）。 |
| P5 | `loadConfig` 合并实测 | 仅 1 台 server `deepseek-eyes`（scope=local，`C:\khy-os\.khy\mcp.json`）；**桥接并入 0 台**。 |
| P6 | 桥接源码探测 | `ccMcpBridge`/`ocMcpBridge`/`ccSkillBridge`/`ocSkillBridge` 全部存在、全部默认 enable；source 枚举正确。 |
| P7 | `discoverSkillsDeep('.../src/skills')` | 返回 `Map<skillName, Skill>`，仅 builtin 目录命中（5 项），无 CC/OpenClaw 技能来源命中（目录不存在被跳过）。 |
| P8 | CLI 三步走表面 | skill/doctor/mcp 三个 case 均按 handler+alias+router 三件套注册（1.1/1.3 证据）。 |
| P9 | doctor 检查机制 | `runDoctorChecks()` 是 `handlers/init.js`（第 1218 行）**内联的单体同步函数**，非可扩展注册表；异步连接检查经 `doctorConnectivity.js`（handleDoctor 第 1025-1042 行）合并。若要在 doctor 里加「MCP 配置完整性」检查，可仿该 merge 点。 |

---

## 3. 与简报/声明的差异清单（全部 7 项）

1. **仓库路径**：简报 `d:\Portable\khy-os`，实际 `C:\khy-os`（D: 不可见）。不阻塞，全程在 C:\khy-os 工作。
2. **技能去重 key**：代码用 **目录 basename**（`_scanDirectory` 第 339-347 行，`skill.id = entry.name`），非简报所称 frontmatter `name`。
3. **CC 插件市场路径漂移**：桥接指向 `~/.claude/plugins/cache`（本地不存在），真实资产在 `marketplaces/...`（P3）。需在立法清单里决定是否修正根。
4. **缺其他 agent → 降级路径为常态**：真实环境无 codex/opencode/… 配置与技能，unify 出口的多数目标在本机会命空。
5. **skillPackageService 不持久化 source/origin**：`importSkill`/`exportSkill`（第 216/…行）不写 origin 字段——导出的来源证据需要新的持久化点。
6. **`KHY_*_SKILL_BRIDGE` 不在 flagRegistry**：`KHY_MCP_ADD`、`KHY_MCP_SERVE` 已注册；`KHY_CC_SKILL_BRIDGE`/`KHY_OPENCLAW_SKILL_BRIDGE`/MCP 对应件直接读 env（各桥 `isXEnabled`）。规范门控模式（走 flagRegistry）不统一。
7. **技能双范式不共享单一构造点**：legacy `.js`+meta.json 与 manifest.json 两条链，来源靠 `_scanDirectory` 的 `skill.priority` 捕获后才能统一。

---

## 4. 实现候选（供阶段二立法，此处不冻结任何决策）

### 候选 A — `khy unify` 上层命令（skill + mcp 双目标）
- 复用 CLI 三步走注册；在 skill 侧复用 `handleSkillCommand` 的 `import`/`export`（skillPackageService），在 mcp 侧对接 `handleMcpCommand`。
- 新增统一 asset 抽象（`{kind: 'skill'|'mcp', source, target, scope, origin, from:` 的来源标注`}`），统一 import 原语把其他 agent 的 assets 纳入（存量纳管入口）。

### 候选 B — 通用桥接工厂（createBridge refactor）
- 现状 `mcp/index.js` 两块复制（921-984），技能 `skillLoader.js` 两块复制（284-312）。抽出 `{ isEnabled, configSources, extract }` 登记进 agent 注册表，`loadConfig`/`discoverSkillsDeep` 改为遍历注册表。**风险**：this 只读阶段不评估实现，仅记录范围——需同时改 `mcp/index.js`、`skillLoader.js` 与四个私有桥，测试面主要在 `mcp` 与 `skills` 两目录。

### 候选 C — 存量纳管入口（写他人配置，缺失腿）
- 需新增「写给其他 agent」的写路径（现 `mcpConfigStore.js` 只写给 khy 自己）。目标格式：CC `.claude.json` mcpServers（同构）、`.mcp.json`、OpenClaw `openclaw.json`、codex `config.toml` `[mcp_servers.*]`（**本机无样例**，须以官方文档结构为准，作立法附件外部引用）。

### 候选 D — 导出方向的持久化与来源证据
- 导出（khy → 其他 agent / 全量清单）需在导出站点记录 `source`（`skill.priority` / `_ccBridged` / `_ocBridged` / `_configPath`），作为不可变来源证据。stdio-first 导出经 `khy mcp serve`（F 铁律 stdio-first）。

---

## 5. 下一阶段输入

- 本报告为阶段一交付。**阶段二**：据此拟定立法规则清单（含 F1-F8：权限范围/原子写+回滚/flagRegistry 门控+_FALSY 兜底/路径安全/stdio-first），供用户回复「冻结」。
- 冻结门控后进入阶段三实现（应用 F1-F8），阶段四证据化验证（含 doctor/`--json` 结构性断言，P9 merge 点）。
