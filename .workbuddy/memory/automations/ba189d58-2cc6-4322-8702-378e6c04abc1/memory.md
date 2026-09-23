# Automation memory — 每日代码审查（khy-os）

## 2026-09-15 02:00（首次自动运行，有产出）
- 上一份报告 `.khy/reports/code-review/2026-09-14.md` 存在（第 0 号基线，未跑 test:all）→ 本次建立**首份完整基线**。
- 范围：24h 无提交 + 工作区 1984 条改动 → 走规则 ②（源码类 1714 个）+ ③（mtime 前 40）；未覆盖 1674 个。
- 基线三项全红：check:structure（check:layout + check:pattern-coverage）、check:changed（check:change-safety 2 error + check:agent-rules 16 error）、test:all（test:scripts 4 / test:docs 1 / test:backend 6 套件 21 用例）。
- 修复 4 项（A 类 3 + 边界 1），未提交（工作区不干净，main 原地改，遵守第六节）。
- 结果：test:scripts 4→3 失败；unresolved-require 24→22；weak-model-banner 1→0；cross-layer-require 保持 37（无新债）。
- 未落地：primitives.js 的 7 级 `../` 修复（换债不划算，已回滚 + 记录待人工裁决）。
- 环境教训（下次直接用）：`npm test -- <file>` 传位参会被 `testPathIgnorePatterns` 吞掉 → 必须用 `--testPathPattern=`；`tests/cli/tui/*` 三个文件在忽略清单内。
- 未能验证：指挥部 khy-os-hq 拉取（网络 reset）；`test:backend` 的 `test:node` 轨（被 `&&` 短路，连续两日未建基线）。
- 报告：`.khy/reports/code-review/2026-09-15.md`。

## 2026-09-16 02:00（第 2 次自动运行，有产出）
- 范围：24h 无提交（HEAD 仍 d917a35a/2026-09-11，停留第 5 天）+ 工作区 2406 条改动 → 走规则 ②（源码类 1665）+ ③（mtime 前 40）；未覆盖 1625 个。40 个审查单元集中在一个**新 TUI 工作流**（tuiConfig/foldModel/chromeBudget/ccTheme/sidebarRail/ink-components）+ **一批新 CI 守卫**（check-tui-gates/weak-model-guard/unbypassable-gate/feature-ownership/permission-invariants/license-tiers/gov-status）。
- 基线三项仍全红：check:structure（check:layout 5 类 + check:wiring 1 + pattern-coverage 3275/47 + json-schemas 1）、check:changed（仅 code-standards 3 突破）、test:all（test:scripts 3 failed / test:backend 12 套件 22 用例；test:docs 这次 50/50 绿）。
- **修复 6 项 A 类**（7 处改动 / 6 文件）：① check-gov-status.js 零接线 → 加 npm 脚本；② 其版本真源手抄两份 → 复用 check-version-sync.js 导出的 VERSION_SPECS/VERSION_GROUPS/INIT_FILE（后者重构为模块级导出，输出逐字节不变）；③④⑤ 四处错级死 require（replSession.js 的 /new+/reset、workflowExecutor.js 与 aiBridge.js 的 AgentTool）；⑥ leaf-contract.test.js:47 读已搬迁的 searchNecessity.js 路径致 ENOENT。
- 结果：test:scripts 3→2 失败；unresolved-require 21→17；check:wiring 1 error→0（**转绿**）；cross-layer-require 保持 37（无新债）。未提交（工作区脏，main 原地改，遵守第六节）。
- **新根因定位（本次最有价值）**：services/backend/.git 是**真实目录的嵌套空仓库**（未被根仓库跟踪），git 到该目录便停住并报 dubious ownership → exit 128 → 采集器 fail-soft 出 isGitRepo:false → workspaceContext.test.js:70 长期红。判定 B 类环境残留，按 §5 只列建议不删。
- **新机制认知**：services/backend 的 jest 用 findNodeTestFiles 动态忽略所有 node:test 文件 → 「jest 全绿」不代表 tests/cli/tui/*.test.js 被覆盖（它们只在 test:node 轨）。本次把该批单独跑通 71/71，另 6 个新守卫全 exit 0、新守卫单测 15/15 与 29/29 绿 → 新 TUI 工作流无 A 类缺陷。
- 另一定性：tests/tui/inkRenderSmoke.test.js 的 112 例失败**全源自同一 beforeAll 钩子超时**（冷 ESM import('ink') 超 15s 预算），非代码缺陷；check:pattern-coverage 的 47 幽灵全是旧扁平布局 src/services/* → 现嵌套 domain/* 的重构遗留（基线 2026-08-19 早于该重构），B 类。
- 未能验证：指挥部 khy-os-hq 拉取（本次定位确切原因：HTTPS 远端 + 非交互会话无凭据 → `could not read Username`，非网络问题）；test:backend 的 test:node 轨（第 3 日；单跑 >6 分钟不收敛，建议按目录分批或人工独立跑）。
- 环境教训（下次直接用）：test:all 的 && 短路 → 失败子轨必须单独补跑；`npm test -- <file>` 位参被吞 → 用 `--testPathPattern=`；`.khy/tmp/` 写日志会使 porcelain 计数增加。
- 报告：`.khy/reports/code-review/2026-09-16.md`。

## 2026-09-17 02:00（第 3 次自动运行，有产出）
- **范围首次走规则 ①**：24h 内有 1 个提交 `e12bfa3f`（ruleguard 规则遵守保障机制入版本控制，165 文件 = 22 脚本 + 1 登记表 JSON + 8 文档 + 134 生成规则卡）。HEAD 从 d917a35a 前进到 e12bfa3f（停留 5 天后首次提交）。porcelain 3291（` M`2035 / ` D`360 / `RM`135 / `??`761，RM 全是 `docs/_规范/`→`docs/10_规范/` 重命名）。
- **修 2 项 A 类 / 3 文件（未提交）**：① **`scripts/ruleguard/lib/run.js:282` fail-open** —— `code!==0 && !parsed.some(sev==='error')` 漏掉「有 error finding 但无规则认领」（`mapToRules` 归 `unmapped`，只计数不阻断）。实测 `check-change-safety.js` exit=1（`changed-count-error`）→ 门 `action=pass`、`rules:gate --mode commit` **EXIT 0 假绿**。改为「每个 error finding 都被认领才算已解释」，保留 `ownerStrengths` 豁免；修复后 `action=fail` + `[BLOCK]` + EXIT 1。② 同文件补 `makeFixture({unclaimedError})` + 1 条回归用例（29→30 全绿）。③ `scripts/tests/externalRules.test.js:143,151` 探针 `SEC-001` 被 `e12bfa3f` 正式登记 → 断言过期，换 `ARCH-068`（10/10 绿）。
- 结果：`test:scripts` 937/934/**3 fail** → 938/**936**/**2 fail**；`check:layout` 逐项持平（`unresolved-require` **0**（昨日 17，已清零）、`cross-layer-require` 39、`dangling-task` 88）；`check:wiring` 73 检查器全接线。
- **新根因（提交完整性，交人工）**：`e12bfa3f` 把登记表放在 `docs/_规范/`，而它的 20+ 消费者一律读 `docs/10_规范/`（**HEAD 上登记表不可达**）；且 `package.json` 的 75 行 `rules:*`/`check:*` 接线**不在该提交里** → 从 HEAD 单独构建会失去整个 ruleguard 家族。工作区已用 135 条重命名补上。
- B 类新增定性：`check:tui-gates` 216>212（守卫只扫 `services/backend/src/cli/tui/`，提交未触碰 → 工作区 TUI 改造 + 人工收紧上限）；`check:code-standards` 突破 3→4 处（新增 COM-001 4625>4584）；`test:backend` 12 套件/22 用例 → **15/36（恶化）**，全在 `services/backend/**`，与 `scripts/**` 的提交无归因关系。`check:json-schemas` **转绿**（`.khy/` 现被 gitignore 感知 → 跳过）。
- 环境教训（下次直接用）：**`check:structure` 与 `check:changed` 都在第一格就短路**（`check:layout` / `check:change-safety`），必须逐项补跑 18 / 8 个子检查；`check-node-syntax.js` 并发时顶 15 分钟上限（124），**单独跑 13m14s 成功**，别放进并发批次。
- 未能验证：指挥部拉取（exit 124，HTTPS 无凭据，第 4 日）；`test:backend` 的 `test:node` 轨（第 4 日，jest 失败即不执行）。
- 报告：`.khy/reports/code-review/2026-09-17.md`。

## 2026-09-18 02:00（第 4 次自动运行，有产出）
- **范围走规则 ②③**：24h 无提交（HEAD 仍 e12bfa3f，停留第 2 天）→ 源码类 2098 剔除 378 个 md/html 孪生 = **1720**，取 mtime 前 40 实审，未覆盖 1680（services/backend 1346）。porcelain 3538（` M`2129 / `A `45 / ` D`365 / `RM`135 / `??`864）。
- **首次改用「串行驱动脚本」跑基线**：`.khy/tmp/baseline-driver.js` 一次串行跑 32 条命令（19+10+3），11~12 分钟跑完，`RUN_TAG=after` 可复跑对照 —— 取代手工逐项补跑，**下次直接用**。
- **修 4 项 A 类 / 5 文件（未提交）**：① `services/backend/scripts/_tmp_dbg15.js:11` 正则跨行 → **check:node-syntax 对全仓 5935 文件整体红**（288s），合成一行后 exit 0；② `docs/11_报告/[RESEARCH-005]…md:149` 漏加同族豁免标记（`check-repo-layout.js` 注释里的 `a2a.discovery.register` 被复述）→ 按 RESEARCH-003/004 写法补 `naming-guard: exempt`（前 40 行内），`.html` 孪生同步；③ `scripts/tests/externalRules.test.js` 探针 **第二次复发**（`ARCH-068` 被 check-repo-layout.js 注释换成 `ARCH-117`）→ 改**探族不探号** + 加两条不漂移不变量；④ `tests/services/toolGuards.test.js:145` 钉死 11 而源码新增第 12 个守卫 → 改 12 并补 source 断言。
- 结果：守卫红灯 **10 → 8**；`test:scripts` 967/964/**3 → 965/2**；`test:backend` 的 `toolGuards` 套件 PASS；`cross-layer-require` 39、`unresolved-require` **0**、`dangling-task` 87（≤ 基线 88）逐项持平/改善（**无新债**）。
- **本轮最重要结论（判 A/B 的护栏）**：`test:backend` **不能作回归判定**。前后两次跑的失败套件集合几乎不同（10 套件/22 例 → 14/35），根因实测：`D:\WorkBuddyData\.khyquant\proxy_server_runtime.json` 在**两次跑之间被写入**（mtime 18:26:11Z 落在第二次跑中途），而 `resolveLocalProxyBaseUrl()` 优先读该运行时文件 ⇒ `tests/utils/proxyBaseUrl.test.js` PASS→FAIL（**环境依赖型，mtime 09-13，非本次引入**）；其余多报失败带 `jest worker crashed exitCode=0` / `5s timeout`，`--runInBand` 复跑 7 个套件 **6 个转绿**。→ 判定改以**守卫** + `test:scripts` + 单文件 jest 为准。
- **A/B 操作化判据（固化）**：「上一份报告绿、今天红」= A；「同值同症状」= B。4 项 A 的新文件 mtime 均晚于上一份报告 02:00。
- 新定性：`check:file-ratchet` 的 **618 error 是标定问题非缺陷**（base=merge-base 旧提交，after=含 3538 条未提交改动的**工作树** → 度量「整棵脏树 vs 旧提交」）；`NIGHTSHIFT.md`（夜班程序覆盖式简报，每夜重写）顶红 `root-whitelist`，按 §5 **未删未移**、列清单交人工（否则每夜必红）；`services/backend/scripts/` 有 **16 个 `_tmp_dbg*.js`** 残留（只列清单）。
- **环境事实更新**：指挥部 `D:\Portable\Projects\khy-os-hq` **目录已不存在**（HQ 09-17 归档、能力吸收进本仓 `.ai/hq/`）→ §一.1 步骤**已无对象，建议从清单移除**（不再是「HTTPS 无凭据」问题）。
- 另核（未发现问题）：40 个单元 462 条相对引入 **0 死链**；`weakModelEditGuard` 的 `tier/modelId` 注入**实测为真**（toolCalling.js:1999）；两侧 `HOOK_EVENTS` 逐项一致；`check:flag-registry` / `check-build-root` 均 exit 0（两者**都不在** structure/changed 链里，需单独补跑）；`test:all` 不覆盖的 7 个新测试文件手动跑通（TUI 36/36、khyquant vitest 57/57）。
- 未能验证：`test:backend` 的 `test:node` 轨（第 5 日，jest 失败即不执行）。
- 报告：`.khy/reports/code-review/2026-09-18.md`。

## 2026-09-19 02:00（第 5 次自动运行，有产出）

- **范围再次走规则 ①**：24h 内 **14** 个提交（`e12bfa3f..HEAD` = `6376988f`），1713 文件 `+215970/−50935`。三族：TUI 应用内选区层（DESIGN-ARCH-119，7 提交）、Shizuku/Android 构建配置、**文档按标签归夹（B9/DR7，5 提交；`965b8371` 一次搬动 980 个文档路径 —— 本轮几乎所有红灯的来源）**。porcelain 3996。
- **基线 32 条（RUN_TAG=0919a）全红面**：structure 4 红（check:layout / pattern-coverage / protocol-naming 22 error / proposal-index 1 error）、changed 5 红（change-safety / **agent-rules exit 124 @900s** / leaf-contract 4 / code-standards 3 突破 / file-ratchet 624）、tests 红 `test:scripts 983/966/**17**`、`test:backend 32 套件/63 用例`、`test:docs 54/54 绿`。
- **修 11 项 A 类 / 14 文件（未提交）**，四条守卫红收敛：`check:protocol-naming` **22→0**、`check:proposal-index` **1→0**、`unresolved-require` **2→0**、`test:scripts` **17→5**。守卫红灯 **9→7**。
- **本轮最有价值的杠杆点**：① `scripts/lib/docsPaths.js` 加 `OPS_MAN_DIR='OPS-MAN'` + `opsManDir()` → **一处常量修 11 条测试**（46 调用点 / 22 手册名，逐项核验 0 死链）——归夹把 `[OPS-MAN-*]` 从 `docs/07_OPS_运维/` 平铺迁入子目录，路径单一真源没跟；② **`.githooks/pre-commit` 的大文件检查一直是死的** —— `for file in $(git diff --cached --name-only)` 按空白词分割，文件名含空格/中括号（`[DESIGN-LAY-004] build-root-demo.js`）即被拆散 → `[ -f ]` 恒假 → 静默放行（本机另缺 `bc`）；改 `while IFS= read -r -d ''` + `-z` 后夹具实测旧漏新中；③ **`commandCodeAdapter.js` 缺 fixture = `provider contract gate`（19 ≠ 18）悬案的确切根因**（`discoverAdapters()`=19 / `FIXTURES`=18）；修法两步：补 fixture + 测试期望 18→19。
- 其余 A 类：`[DESIGN-A2A-001]` 重复件按 `[MGMT-PLAN-009]` §1.5「各保留，补边界声明」补边界声明 + `naming-guard: exempt`（**未删未移**）；三处登记表陈旧路径（PROPOSAL-ARTIFACT-INDEX / RULES-REGISTRY×2 / FEATURE-OWNERSHIP）+ 规则卡重生成 172 件；两处错级死 require（`terminalClient.js:27`、`syncServer.js:56` 的 `../../utils/dataHome`→`../../../`）；`[OPS-MAN-067]` 速查表**重跑生成器**（生成器输出指向实存路径、落盘件停在旧扁平路径）；`ruleguard.test.js:503` 探针 `x.js`→`x.zzz`（RUNTIME-009 的 `**/*.js` 合法覆盖全仓代码文件，原「未命中任何 paths」前提失效）。
- **本轮必须引入第三类 C（在途未提交）**：脏条目数 5 天单调上升（1984→2406→3291→3538→**3996**），很多红来自**索引态**（`A `/`M `）而非提交。**归因前必须先 `git status --porcelain -- <file>` 区分「提交引入」与「在途引入」**。C 类不修、只交人工：**C1**（最值得人工看）`scripts/tests/check-repo-layout.test.js` 已断言嵌套 `docs/13_传承/`，但 `check-repo-layout.js` 的 `checkDocsIndexFirst()` **仍只扫 docs/ 一级子目录** → 嵌套永不报（两文件都在索引里 = 半成品；需策略裁定「是否要求每个嵌套阶段子目录各自带 00_INDEX_*」，若是则扩递归并先评估全仓亮红面）；C2/C3 = `repoCodeStandards.test.js` / `repoTaskEntryIntegrity.test.js`（新增 `A `，**测试是对的**，红在既有债务）。
- **B 类（只记录）**：code-standards 3 突破（09-18 为 4 → **在改善**）· pattern-coverage 3419>3238 · leaf-contract 4 error **全是 `scripts/tests/leaf-contract.test.js` 的故意夹具** · file-ratchet 624/783（**标定问题**：度量整棵脏树 vs 旧提交）· change-safety · agent-rules 超时（无参单跑秒回 EXIT 0 → 环境性）· test:backend 32/63（按 09-18 结论**本机不可作回归判据**）· `test:node` 轨**连续第 6 日未能验证**。
- **交人工**：U1 `[DESIGN-A2A-001]` 同号跨阶段家族两份 948 vs 1033 行分叉是否择一隔离；U2 `scripts/docs/md-to-pdf.js:515` 仍硬编码 `docs/07_OPS_运维`（其 onboarding 源只在子目录），**但 `docs:pdf:onboarding` 本身就在 dangling 清单里（npm 脚本不存在）→ preset 不可达，未修只记录**；U3 `scripts/lib/docsPaths.js` **不在 HEAD** 却被 22 文件 require（复核 HEAD 的 restore-plan 尚未 require 它 → 属 B4b 在途）、`RULES-REGISTRY.json` 在 HEAD 仍在 `docs/_规范/`（**回归 09-17 已报项**）；U4 `dangling-task 103` 的 +5 未逐项归因（全量清单已存 `.khy/tmp/f0919-dangling-list.txt`，主体是 `does-not-exist`/`X`/`x`/`rebuild-me`/`bench`/`test:*` 等**测试夹具假目标** → 指标含大量测量噪声，需裁定统计口径）。
- **环境教训（下次直接用）**：① 拿全量清单用守卫的 **`--list=<id>`**（主输出只给前 12 条 + 「共 N」）；② **`node -e` 内联脚本遇中文路径 / 反斜杠正则 / `[...]` 必炸 → 一律写 `.khy/tmp/*.js` 再跑，且必须从仓库根跑**（从 `.khy/tmp` 跑会拼成 `.khy/tmp/.khy/tmp/…`）；③ `test:scripts` 失败清单要连缩进抓（`/^\s*not ok /`），只抓 `^not ok ` 会漏掉全部子测试；④ `git ls-tree --name-only <dir>` 对目录回显目录名本身，不能用来列文件；⑤ 跑测试会附带改写 `docs/11_报告/metrics/{维度健康,质量看板}.json` 的 `generatedAt`（**内容不变**）——报 `git diff` 时必须主动说明。
- 报告：`.khy/reports/code-review/2026-09-19.md`。

## 2026-09-23 02:00（第 6 次自动运行，有产出）

- **范围走规则 ②+③**：24h **零提交**（HEAD `e86bbf6d` 停在 09-21 09:36，第 3 天）→ 源码类 **414**，实审 mtime 前 40，未覆盖 **374**（services/backend 275）。porcelain **505**（`M `1 / ` M`296 / ` D`2 / `??`206）。实审单元集中在 **TUI 交互层重构**（`cli/tui/ink-components` + `hooks` + `utils`，配 12 个新增/修改单测）——09-19 TUI 选区层的同源延续。
- **基线 37 条**：`RUN_TAG=0923a`（18m20s，27 绿/10 红）→ 修复后 `RUN_TAG=0923b`（11m08s）。**顶层退出码零漂移（新增红 0 / 新转绿 0）**。
- **A 类 = 0（本轮核心结论）**：无提交即无「本次引入」。所有红经 `git status --porcelain -- <file>` 逐项归因后全部落入 B / C。仅「修」了我自己诊断工具的缺陷。
- **仍修 3 项 / 4 文件（未提交，main 原地改）**：① 模式注册表 6 键改名 `views/X.vue`→`views/admin/X.vue`（`pattern-ghost` **6→0**）；② `[OPS-MAN-067]` 速查表重跑生成器（triage **15/15**）；③ provider contract 补第 19 个 fixture + 期望 18→19（**3/3 pass**，两天悬案 `19 !== 18` 结案，且正是 09-19 定位的根因）。效果 **`test:scripts` fail 7→4**。
- **`check:tui-gates`（226 > 220）修复尝试已回滚**：两版 tokenizer（剔注释+字面量 / 只剔注释）**都少算 46 个真门**（动态拼接 `process.env[\`KHY_SIDEBAR_${k}\`]`、`KHY_SIDEBAR_FOCUS`）。根因是**度量口径**：守卫扫 `cli/tui/`，但许多门定义在上一层 `cli/`、只在 tui 注释里被提及。HEAD 单独实测 **221 > 220** → 即便清空工作区也红。→ 交人工裁定口径。
- **剩余 4 条 `test:scripts` 失败逐条有归属**：`docs-index-first` + `check-repo-layout: 规则命中`（**C1** 在途半成品）· `coverage gate` ×2（**B10** 纯既有债务，涉事文件全 clean，`c8.config.json` 无 4 个阈值键）· `tui gate budget`（**B9**）· `check-code-standards`（**B1**）。**无新增未归因债务。**
- **本轮最有价值：`git` 对象库物理性损坏已定位（新，交人工，最高优先级）** —— `fsck --connectivity-only` **18 broken links**（11 tree + 7 commit）；**11 条 ref 不可遍历**（含 `main` ebc9ebc2、`HEAD` 所在分支 e86bbf6d、`origin/main`、2 个 tag）；缺根 `135460c8` 与 tree `119e3833`；`rev-list`/`log --since`/`merge-base` **全失败** → 这就是「24h 提交」规则近几轮失灵的确切原因。`2313e753`(09-18 origin/main) 是 **graft 式根**（可 show 不可 walk）。`.git` 事故痕迹（`index.bak-20260918-1156`、`index.corrupt-20260918-1330`、`index.lock.stale-*`）**全部日期 2026-09-18**；唯一回退 `.git-backup-20260913/`（720 MB）**已不存在**；`.git/logs` 无 HEAD/main reflog。**安全核查**：全仓脚本扫 `--prune=now`/`reflog expire`/`reset --hard` → **无仓库脚本执行**，khy 代码**主动防御**（`repoDisciplineRisk.js:71`「NEVER run destructive git commands」）→ 风险来自 `2026-09-16_khy-os体积构成分析与瘦身方案.md` **文档驱动的人工操作**。**在远端可覆盖前不要跑任何 `gc --prune`。**
- **新 C 类（只列清单未动，§5 明令不删根目录散落临时文件）**：**C4** `0)`（25B，mtime 09-20，内容 `userId passthrough added`）与 `x[1].toUpperCase()+'`（0B）—— 都是**文件**、都 `??`、命中 `ROOT_JUNK_FILE_RES` 的元字符签名（**守卫无误报**）；**C5** `backups/`（仅 1 个 js）与 `gui-test-screenshots/`（12 png）—— 两个顶层目录**都不在 HEAD**（`git ls-files` 空）→ `layer-registry` 2 error。
- **C1 更新（跨两轮未决）**：守卫 `check-repo-layout.js:278` **只扫 docs/ 一级子目录**（单层 `readdirSync`，`markdown.length===0` 即 continue）；本轮报的 `docs/tui-interaction-optimize/` **已入 HEAD**（`LOG.md`），其 `LOG.md:3` 自述是**另一个自动化任务**（TUI 夜间优化班）的工作日志 → 归 C 不归 A。`docs/design/` 有 `00_INDEX_*` 故合规（对照组）。**需裁定**：① docs/ 下「任务工作日志目录」该不该放这里（宜移 `.khy/` 或 `docs/15_维护记录/`）；② **嵌套阶段子目录是否各自要 `00_INDEX_*`**（09-19 已提、至今未裁）。
- **转绿项（相较 09-19）**：`check:protocol-naming`（22 error→0，延续）· `check:proposal-index`（1→0）· `check:change-safety`（本轮绿）· `check:leaf-contract`（4 error→**绿**）· `check:file-ratchet`（624 error→**绿**「无脏度回归」）· `check:agent-rules`（exit 124 @900s → **1s 秒回 exit 0** → **确证 09-19 的 B6 是环境性超时**）· `docs-index-complete: 0`。
- **B 类**：B1 code-standards 3 突破（func 2194>2184 / nest 8789>8754 / COM-001 4776>4731；扫描面 `services/backend/src` 有 **201 条在途改动** = 142 ` M` + 59 `??` → 增长可能在途，但无提交可归因，**保守归 B**；回写基线属「从门内部改门」，§5 禁止）· B2 pattern-coverage 3384>3238 · B7 test:backend **环境失败**（`Cannot find module '…/services/backend/node_modules/jest/bin/jest.js'`，该 node_modules 仅 **7** 条目）· B8 `test:node` 轨**连续第 7 日未能验证** · B9 tui-gates · B10 coverage gate。
- **环境教训（下次直接用）**：① **NTFS ADS 陷阱** —— 输出/日志文件名**不能含 `:`**，会被写成备用数据流（`check:structure.log` → 文件 `check` 的 `structure.log` 流），**正常读取路径永远读不到**；清洗正则须写 `/[^a-zA-Z0-9_.-]/`（本轮 0923a 有 3 条日志因此读不到，0923b 修好后 37/37 可读）。② `git status --porcelain -z` 里 **rename 占两段**（源+目标），解析须 `i += 1` 跳过，否则把目标当独立记录。③ 基线 jsonl 字段是 **`status`**（不是 `exit`），同层有 `signal`/`timedOut`/`bytes`。④ `git archive HEAD <单文件>` **可用**；`git archive HEAD`（整树）在本仓**必失败**（`error: invalid object 100644 0996f9fd… for 'apps/ai-frontend/src/nav/index.js'`）。⑤ `check:layout` 的 `counts:` 行在两轮里都有，是拿子指标的**唯一稳定入口**。
- 报告：`.khy/reports/code-review/2026-09-23.md`。
