# khy-os 工作树清洁方案

> **编号**：[OPS-MAN-206]
> **日期**：2026-09-18
> **作用域**：本仓库工作树（Windows / git bash）
> **关联规则**：[LAYOUT-004] 仓库整理与巡检、[LAYOUT-005] 构建产物单一根
> **结论**：工作树变脏不是「纪律问题」，而是**四条可定位、可机械化修复的机制缺陷**叠加。方案以「四层分离」为核心，不采用 `git stash` / `git checkout .` 这类会丢失在途工作的粗放手段。

---

## 一、现状取证（基线）

分析时 `git status --porcelain` 共 **3466** 条待处理项：

| 状态 | 数量 | 含义 |
|---|---|---|
| ` M` 已跟踪改动 | 2115 | 含真实工作 + 生成物漂移 |
| `??` 未跟踪 | 852 | 含噪声目录 + 新文件 |
| ` D` 已跟踪删除 | 499 | **全部可从 HEAD 恢复**（已验证） |

按目录与行数拆分，可清晰看到**真实工作**与**噪声**并存：

| 分组 | 文件数 | 行数变化 | 性质 |
|---|---|---|---|
| `services/backend` | 1410 | +67,456 / −75,725 | **真实在途工作，必须保留** |
| `*.html`（孪生） | 697 | +3,767 / −16,783 | **生成物漂移，噪声** |
| 其余 | 642 | +70,582 / −315,978 | 真实工作为主 |

> 关键安全事实：499 个 `D` 条目经 `git status --porcelain -z` 与 `git ls-tree -r HEAD` 交叉验证，**100% 可从 HEAD 恢复**，无一例是「本地新建后误删」的不可逆损失。

---

## 二、四条根因

### 根因 1：HTML 孪生「生成器已升级、已提交产物未重生」

这是**最大且最容易被误判为噪声**的一条。

- `scripts/docs/build_docs_site.js` 把仓库里的 `.md` 渲染成同名 `.html`（当前实测 **1045** 页），且该 html **有意纳入版本控制**（`docs/10_规范/[DESIGN-LAY-002]` §243 明确裁定：「`.html` 孪生是否入版本控制 —— 裁定：入」；[DESIGN-LAY-002] 第 139/232 行定「孪生必成对」）。
- 现状：已提交 **705** 个 html；但生成器模板已演进（新增 `<!-- MIRROR: xxx.md -->` 注释、资产路径由 `docs/_assets/` 改为 `docs/19_资产/`、pager 增补下一篇链接），而已提交的 html 仍是旧模板产物。
- 结果：**只要跑一次 `npm run docs:build`，立刻产生 1170 项 html 变更**（实测拆分为 557 陈旧更新 / 473 新生成 / 140 孤儿回收，详见 M3），其中陈旧更新部分**全是模板差异，无内容语义**。
- 实测证据（样本 `docs/00_INDEX_文档索引.html`）：旧产物引用 `../docs/_assets/docs-site.css`，新生成器输出 `../docs/19_资产/site/docs-site.css`，并插入 `<!-- MIRROR -->` 注释。
- **放大器**：[DESIGN-DOCS-004]（README 内容规范）明令「`.html` 孪生件由 `npm run docs:build` 生成，**禁止手改**」，但 `.githooks/pre-commit` 中**没有任何 docs 孪生新鲜度校验**（已 grep 确认）。于是「不让手改」+「不校验新鲜度」= 产物可以长期滞后于生成器而不被拦住。

### 根因 2：忽略规则缺口 —— 8 类运行时/工具目录未被忽略

用 `git check-ignore` 逐项实测：

| 路径 | 现状 | 体积 | 性质 |
|---|---|---|---|
| `.ai/hq/` | **未忽略** | 512 K | AI 协调运行时（`BUGS.json` / `PROGRESS.json` / `logs/` / `prompts/`） |
| `.workbuddy/` | **未忽略** | 392 K | 工具状态 |
| `.workbuddy-ai/` | **未忽略** | 468 K | 工具状态 |
| `.zcode/` | **未忽略** | — | 含 `plans/`（按 session UUID 命名的会话计划）、`tmp/`、不稳定性报告 |
| `.opencode/` | **未忽略** | — | 工具配置 |
| `NIGHTSHIFT.md` / `.html` | **未忽略** | — | 夜班台账（「每夜被下一次夜班覆盖式更新」） |
| `.clinerules` / `.windsurfrules` | **未忽略** | — | 各 AI 工具规则副本 |

对照组：`.khy/`、`.khyos/`、`.research-tmp/` 均已正确忽略（`.gitignore` 第 54/65 行等）。说明**规则维护是逐次打补丁式的**，工具一多就漏。

`.zcode/plans/*` 与 `.ai/hq/` 这类**按会话 UUID 命名、每次运行都会新增**的文件是典型「工作时间越久、工作树越脏」的持续污染源。

### 根因 3：根目录游离 0 字节怪文件

根目录有 4 个文件名极不寻常的**空文件**：

```
**定位**：登记当前已知失败的测试套件，防止非阻塞变成永久忽略。
**规则**：
历史夜班的恢复记录请查
本文件每夜被下一次夜班**覆盖式**更新；仅保留最近一夜的记录。
```

成因明确：某脚本的 Markdown 正文中出现了以 `**定位**：` 开头的行，被 shell 当作**重定向目标**（`>` 语义）执行，于是把该行内容当成了文件名创建出空文件。`.gitignore` 已有 `NUL` / `nul` 规则（防 PowerShell `> NUL`），但**未覆盖这类中文 Markdown 行被误当重定向的形态**。

### 根因 4：pre-commit 只查「暂存区」，不管「工作树残留」

`.githooks/pre-commit` 现有能力较扎实（tmp 文件、>10MB 大文件、密钥、ruleguard commit 快档、commit message 格式），但全部基于 `git diff --cached`——**只看本次要提交的内容**。

这带来两个盲区：

1. **看不到未跟踪残留**：`git clean` 类的新增渣（`.zcode/plans/` 新增、生成器落盘的游离 html）不经过暂存区，钩子完全不感知。
2. **看不到「提交后工作树仍未收敛」**：提交成功后工作树可能依然脏，但钩子已退出。

讽刺的是，提交历史上已有 `chore(ruleguard): commit gate now counts only staged changes, not worktree`——这个改动**为提升 commit 速度是正确的**，但使「工作树是否收敛」彻底无人值守。

---

## 三、方案思路：四层分离

核心原则：**按「这堆改动该不该进版本库」把 3466 条项分成四层，各用各的手段，绝不一把梭。**

```
工作树脏 (3466)
├── L1 真实在途工作 (services/backend 等)  → 保留，走正常提交
├── L2 生成物漂移 (html 孪生)              → 重生成后提交（或调设计）
├── L3 应忽略的运行时目录 (8 类)           → 补 .gitignore
└── L4 根目录渣 + 已跟踪误删               → 清理 / 恢复
```

**为什么不能一把梭**：`git checkout .` 会**连同 L1 一起丢掉**（`services/backend` 有 +67k 行未提交工作）；`git clean -fd` 会删掉未跟踪的**新测试文件**（如 `apps/ai-frontend/src/composables/useGateway.test.js`）。这正是本仓库历史上反复「清完又脏、脏了再清」的根因。

---

## 四、具体措施

### M1 · 补全 `.gitignore`（解决 L3，一次性）

在 `.gitignore` 的「machine-local tooling state」区块追加：

```gitignore
# ── AI/工具运行时目录（机器本地，非仓库资产）──────────────
# .ai/hq/ 是 AI 协调运行时（BUGS/PROGRESS/ROADMAP + logs + prompts），
# 按会话持续写入；跟踪它会让工作树永不收敛。
.ai/hq/
.zcode/
.opencode/
.workbuddy/
.workbuddy-ai/
# 各 AI 工具规则副本（真源在 docs/，此处仅本地注入）
.clinerules
.windsurfrules
```

> **注意**：`/NIGHTSHIFT.md` 与 `/NIGHTSHIFT.html` **不要**按上面那样直接忽略。布局守则判定它属「根目录白名单外的说明性文件」，须**收容进 `docs/15_维护记录/`**而非忽略；且实测根级与 `docs/15_维护记录/` 各有一份、内容不同（169 vs 174 行）、两份均未跟踪，「真源在哪」尚无定论。**须先人工裁定，裁定前不得移动或删除任一副本**（详见附录 B 冲突提示）。

> **另注意（忽略的边界）**：`.gitignore` 只对 **git 视野**生效。`check-repo-layout.js` 的 `layer-registry` / `root-junk` 走 `fs.readdirSync`，**不看忽略规则** —— 所以像根级 `tmp-cmp/` 这类残留，加忽略**无效**，必须真正删除目录。两类手段不可互相替代。

**M1 也必须早于 M3（实测发现的耦合，见 M3「M1 × M3 交互」）**：不先忽略运行时目录，生成器会把 `.ai/hq/prompts/**`、`.workbuddy-ai/memory/**` 等机器本地 `.md` 也编译成 html，使孪生数量持续增长、收敛不稳定。

**注意**：`.ai/` 下**其余内容已被跟踪**（如 `.ai/MAP.md`），因此**必须只忽略 `.ai/hq/` 子目录**，不能写 `.ai/`。

### M2 · 根目录怪文件清理 + 防复发（解决 L4）

清理（4 个 0 字节文件，`rm` 即可，无内容损失）：

```bash
cd /d/Portable/khy-os
rm -f '**定位**：登记当前已知失败的测试套件，防止非阻塞变成永久忽略。' \
      '**规则**：' \
      '历史夜班的恢复记录请查' \
      '本文件每夜被下一次夜班**覆盖式**更新；仅保留最近一夜的记录。'
```

防复发——在 `.gitignore` 追加（覆盖含 `**` 与中文的误重定向产物）：

```gitignore
# Shell 误把 Markdown 行当重定向目标产生的 0 字节怪文件
/**：*
/**规则**：*
/*记录。*
```

> 更根本的修法见 M5：定位并修掉那个输出了「裸 Markdown 行」的脚本。

### M3 · 孪生漂移一次性收敛（解决 L2）

```bash
cd /d/Portable/khy-os
npm run docs:build          # 重生成全部 html 孪生 + nav-data.js
npm run docs:verify         # 校验孪生完整性与链接
git add -A -- '*.html' docs/19_资产/site/nav-data.js
git commit -m "chore(docs): 重新生成 html 孪生以对齐 docs-site 生成器模板"
```

这一步会一次性吃掉 html 孪生的三类漂移，**之后 docs:build 变为幂等**。

**2026-09-18 实测数据**（本方案撰写时已实跑 `docs:build` 验证，非估算）：

| 类别 | 数量 | 含义 |
|---|---|---|
| ` M` 陈旧孪生更新 | 557 | 模板已升级但产物未重生（新增 `<!-- MIRROR -->` 注释、资产路径 `docs/_assets/` → `docs/19_资产/`） |
| `??` 新生成孪生 | 473 | 此前从未生成过 html 的 `.md`（如 `.ai/GUARDS.html`、`.ai/MAP.html`） |
| ` D` 孤儿孪生清理 | 140 | `.md` 源文已不存在，生成器正确回收其遗留 html |
| **合计** | **1170** | |

> **规模订正（重要）**：初稿估的 **176 项**、以及中途版本的 **1167 项**均为**估算/时点快照**，非稳态值。实测当前稳态为 **1170 = 557 + 473 + 140**。其中 `??` 一项由 470 增至 473，**差额 3 项来源已定位**：`.workbuddy-ai/memory/` 下当日新增的日记 `.md`（`2026-09-18.md`）及其孪生被本目录扫描式纳入生成 —— 即**该数字会随机器本地日记自然增长**，不是漂移失控。这恰好从反面印证了根因 2：**运行时目录未忽略，会让生成器把它们也当文档编译**（详见下方「M1 × M3 交互」）。

**判据修正（重要）**：初稿写的「连跑两次 `docs:build` 后 `git status -- '*.html'` 必须为**空**」是**错的判据**。正确判据是——

> **落定后连跑两次 `docs:build`，两次 `git status --porcelain -- '*.html'` 的输出集合 `diff` 必须无差异（即「幂等」），不得新增任何条目。**

即：判据是「**幂等**」（不再产生新漂移），不是「干净」——上述 1170 项本身是**待提交的合法收敛结果**，不是漂移。要求「必须为空」等于要求工作树把已提交产物与生成器差异永远抹平，既不现实，也会掩盖真实漂移。

**实测已确认幂等成立**（2026-09-18 复核，本次为**直接**验证）：

```bash
git status --porcelain -- '*.html' > h1.txt   # 1170 行
node scripts/docs/build_docs_site.js          # 重跑一次
git status --porcelain -- '*.html' > h2.txt   # 1170 行
diff h1.txt h2.txt                            # ✅ 无差异 → 幂等成立
```

> 命令用 `node scripts/docs/build_docs_site.js` 而非 `npm run docs:build`：后者前缀了
> `ensure-mermaid.mjs`，会**先联网**拉取渲染依赖。验证**生成器本身**的确定性时不需要它，
> 直跑可离线、可复现（此即「判据必须回到被验证对象本身」的落实）。

**其余实测确认**：

- `npm run docs:verify` 通过：`源 Markdown 1045 · 生成 HTML 1046 · 校验本地链接 12462 · 全部通过`（时点快照，随文档增删同步增长）。
- 140 个被删 html 经 `git ls-tree -r HEAD` 交叉验证 **100% 可从 HEAD 恢复**（140/140 命中），无不可逆损失；且逐一核对**对应 `.md` 源文 0/140 仍存在** ⇒ 属**正确回收**而非误删。
  > ⚠️ 验证方法本身有个坑：`git status --porcelain` 对含**中文/方括号**的路径会加双引号，
  > 直接按列切分会假报「84 个不可恢复」。必须先 `sed 's/^"//; s/"$//'` 去引号再做**整串精确匹配**
  > （正是 M6 所警告的路径截断陷阱 —— 这次是它咬了自己的验证）。
- 生成器确定性成立，**无需修改 `build_docs_site.js`** —— 初稿担心的「生成器非确定性」经实测不存在。

**M1 × M3 交互（新发现，两措施不可各自独立评估）**：新生成的 473 个孪生里，**46 个落在运行时目录**（`.ai/hq/prompts/**` 29 个、`.workbuddy-ai/memory/**` 7 个、其余分散）——它们正是 **M1 要忽略的路径**。若不先落 M1，生成器会持续把这些机器本地文件编译成 html 并计入 `??`，使 M3 的「收敛」永不稳定。故**实施顺序 M1 必须早于 M3**（与第六节顺序图一致，此处补明机理）。

### M4 · 补 pre-commit 的「工作树收敛」检查（解决根因 4）

在 `.githooks/pre-commit` 现有第 5 步后追加第 6 步——**仅告警不阻断**（避免误伤在途工作，这是本方案最关键的分寸）：

```bash
# 6. 工作树收敛提示（advisory，不阻断）
#    背景：本钩子前 5 步只看 git diff --cached，看不到未跟踪残留；
#    历史上因此出现「提交成功但工作树仍脏」的静默累积。
echo "🧹 工作树残留检查（提示性）..."
RESIDUE=$(git status --porcelain --untracked-files=normal \
  | grep -vE '^ M |^ D |^A  |^MM ' || true)
if [ -n "$RESIDUE" ]; then
  COUNT=$(echo "$RESIDUE" | wc -l)
  echo "  ⚠️  工作树仍有 $COUNT 项未跟踪/未提交残留（前 10 项）："
  echo "$RESIDUE" | head -10
  echo "  查看详情：npm run git:status:report   # 见 M6"
else
  echo "  ✅ 工作树干净"
fi
```

**为什么是 advisory 而非硬门**：`services/backend` 有 1400+ 文件在途，硬门会立刻挡住所有提交，反而逼人用 `--no-verify`，让整套守卫失效。

### M5 · 定位并修掉「裸 Markdown 输出」脚本（防根因 3 复发）

```bash
cd /d/Portable/khy-os
grep -rln '定位\*\*：登记当前已知失败的测试套件' --include='*.js' --include='*.sh' --include='*.mjs' .
```

定位到生产者后，修掉其输出方式（应 `console.log` 或写入 `**` 引号包裹的目标），否则 M2 的忽略规则会越积越多。

### M6 · 新增 `npm run git:status:report` —— 分类巡检入口（新增能力）

新增 `scripts/maintenance/worktree-report.js`，把 `git status` 按**本方案的四层**归类输出，让人一眼看清「哪些该保留、哪些是噪声」：

```bash
npm run git:status:report
```

输出示意：

```
工作树体检报告
────────────────────────────────────
L1 真实在途工作   services/backend 等      1410 项   ← 请正常提交
L2 生成物漂移     *.html 孪生               697 项   ← 跑 npm run docs:build
L3 应忽略残留     .ai/hq, .zcode, ...        xxx 项   ← 见 M1 补 .gitignore
L4 根目录渣       0 字节怪文件                4 项   ← 见 M2
────────────────────────────────────
判定：工作树不干净。建议动作：先 M1 → M3 → M2，再提交 L1。
```

**实现要点**（务必用 `-z`，本仓库 `core.quotepath=false`）：

```js
// 非 ASCII 路径（docs/03_DESIGN_设计/[DESIGN-ARCH-068] ...）含空格与方括号，
// 用 awk '{print $2}' 会截断并产生假阳性（实测会假报「215 个不可恢复」）。
execSync('git status --porcelain=v1 -z', { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map(e => ({ status: e.slice(0, 2), path: e.slice(3) }));
```

### M7 · 落地为受管规则（对齐既有治理体系）

本仓库已有成熟治理设施，方案**不应另起炉灶**，而应登记为规则：

- 在 `docs/10_规范/registry/RULES-REGISTRY.json` 新增 `LAYOUT-006 · 工作树收敛`，`gate=advisory`（与 `LAYOUT-005` 同档，因其同为「防复发 + 存量不追溯」性质），`ssot` 指向本文件（`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-206] 工作树清洁方案.md`）。
- 复用既有 `scripts/maintenance/` 目录放 M6 脚本（与 `clean.js`、`clean-temp.js` 同域），`npm run` 入口名遵循 `LAYOUT-003` 的 `<域>:<动作>` 规范（`git:status:report`）。
- `LAYOUT-005`（构建产物单一根）当前 `status=draft`，其登记的 `_build/` 单一根尚未完全落地。**建议先把 LAYOUT-005 推上 active**，否则 L2 类漂移会从 html 转移到 `_build/` 继续复发。

---

## 五、需覆盖的场景清单

| 场景 | 现状 | 本方案覆盖 |
|---|---|---|
| 生成物（html 孪生） | 1170 项（557 M / 473 ?? / 140 D） | M3 收敛 + 幂等验收 |
| 构建产物（dist/build/coverage） | 已忽略 | 既有 `BUILD-OUTPUTS.json` + LAYOUT-005 |
| 运行时目录（.khy/.khyos） | 已忽略 | 无需动作 |
| 工具状态（.zcode/.workbuddy/.opencode/.ai/hq） | **缺失** | **M1** |
| 日志 | 已忽略（`*.log`/`logs/`） | 无需动作 |
| 依赖目录（node_modules 等） | 已忽略 | 无需动作 |
| 临时文件（tmp-*/*.tmp） | 钩子 + clean-temp.js | 无需动作 |
| 本地配置（.env 等） | 已忽略（含 `.env.bak-*`） | 无需动作 |
| 夜班台账（NIGHTSHIFT） | 根级残留未收容（两份副本内容不同） | 收容 `docs/15_维护记录/`，非忽略（见附录 B） |
| 根目录怪文件 | **存在 4 个** | **M2 + M5** |
| 已跟踪误删 | 499 项 | M6 分类提示（全可恢复，非紧急） |

---

## 六、实施方式与约束

### 实施顺序（依赖关系不可颠倒）

```
① M1 补 .gitignore   ──┐
                      ├──► ④ 提交 L1 真实工作
② M2 清根目录渣      ──┤
                      │
③ M3 重生 html 孪生  ──┘
   ▲
   └── 必须早于 ④：否则 docs:build 的 2 万行噪声会混进 L1 的提交里
```

M4 / M5 / M6 / M7 为防复发设施，可在 ①–④ 之后落地，不阻塞收敛。

### 约束条件

1. **绝不使用 `git stash` / `git checkout .` / `git clean -fd`** 做总清理——会丢 L1（+67k 行在途工作）与未跟踪新测试文件。
2. **只隔离、不删除**：对齐既有 `LAYOUT-004` 的「只隔离不删除，淘汰进 `.khyos/housekeeping/<日期>/` 并保留 manifest 可原路撤回」原则。M2 的 4 个 0 字节文件可直接删除（无内容），其余一律走隔离。
3. **`.html` 孪生是合法产出，不得当孤儿清理**（`LAYOUT-004` 明文红线，已写入 `RULES-REGISTRY.json` 第 145 行）。`scripts/docs/cleanup-orphan-html.js` 需谨慎使用。
4. **`.ai/hq/` 只能忽略子目录**，不能忽略 `.ai/`（其余内容已被跟踪）。
5. **路径解析必须用 `git -z`**（`core.quotepath=false` + 中文/方括号/空格路径）。
6. **兼容现有工作流**：`.githooks/pre-commit` 的 5 个既有检查、`ruleguard` commit 快档（`--mode commit`，秒级）不变；M4 只做 advisory，不增加阻断点。
7. **不追溯存量**：对齐 `LAYOUT-001` / `LAYOUT-002` 的「存量按基线只降不升，不追溯整改」哲学——本方案不要求立刻提交 499 个删除项，只需它们不再增长。
8. **双机同步影响**：`.gitignore` 中已有注释指出「工作树永远带未跟踪文件，导致双机自动同步的 `--clean-only` 门禁永远跳过」。M1 落地后该门禁应能恢复触发——**这是本方案的额外收益，也是需回归验证的点**。

---

## 七、日常操作规范

### 提交前（每次）

```bash
npm run git:status:report      # 看四层分类
npm run docs:build             # 改了任何 .md 后必须跑（LAY-5 要求）
npm run docs:verify            # 校验孪生完整
```

**铁律**：改了 `.md` 必须同提交更新的 `.html` 孪生，否则 `LAY-5` 红灯。

### 禁止事项

- ❌ `git add -A` / `git add .` 盲加（历史上曾把 38 MB 的 `publish/` 整包提交）
- ❌ `git checkout .` / `git clean -fd` 图省事清树
- ❌ 手改 `.html` 孪生（`DESIGN-DOCS-004` 明令禁止，改了会被 `docs:build` 覆盖）
- ❌ 用 `--no-verify` 跳过 pre-commit

### 提交后（每次）

确认 `git status` 收敛。若仍有 L1 残留属正常（在途工作未完成）；若出现**新增的 L2/L3/L4**，说明防复发设施失效，按 `RULES-REGISTRY.json` 的 `LAYOUT-006` 排查。

### 每日巡检

对齐 `LAYOUT-004`「每日巡检」触发条件，跑：

```bash
npm run git:status:report      # 分类体检
npm run clean                  # 干跑：列出可清构建/测试产物
npm run check:build-root:clean-audit   # 构建产物是否违规出台
```

### 工具引入时（新增 AI 工具 / 新脚本）

新增任何会写本地状态的工具，**先在同一提交里补 `.gitignore`**。规则：

> 凡是「按会话/按运行新增、内容只对当前机器有意义」的路径，一律进 `.gitignore`；凡是「删了就无法重建」的，一律登记进 `BUILD-OUTPUTS.json`（该表的不变量 I1：「写不出怎么变回来的东西，删掉就是永久损失」）。

### 新脚本作者须知

向 stdout 输出 Markdown 正文时，**禁止出现会被 shell 解释为语法的整行**（以 `>`、`**`、`#` 开头的行若走重定向会创建文件）。用 `console.log` 而非 shell 重定向；写文件时目标路径必须显式引号包裹。

---

## 八、验收标准

| 编号 | 判据 | 命令 |
|---|---|---|
| A1 | 忽略规则生效 | `git check-ignore .ai/hq .zcode .workbuddy` 全部命中 |
| A2 | 根目录渣归零 | `git status --porcelain \| grep -c '^??'` 中无根级怪文件 |
| A3 | 孪生收敛（幂等） | 落定 1170 项后连跑两次 `node scripts/docs/build_docs_site.js`，两次 `git status --porcelain -- '*.html'` 输出 `diff` 无差异 |
| A4 | 工作树可收敛 | 提交 L1 后 `git status --porcelain` 仅剩在途工作 |
| A5 | 巡检可用 | `npm run git:status:report` 输出四层分类 |
| A6 | 双机同步恢复 | `--clean-only` 门禁在干净工作树上正常触发 |

---

## 附录：本次分析用到的取证命令

```bash
# 分类计数（注意：含中文路径时必须加 -z，否则截断）
git status --porcelain=v1 -z | ...

# 判断删除项是否可恢复（100% 可恢复的结论来源）
git ls-tree -r --name-only HEAD > /tmp/head.txt
git status --porcelain=v1 -z | ...   # 取 D 条目
# 交叉比对后：499 项全部命中 HEAD

# 分组规模
git diff --numstat -- services/backend   # +67,456 / -75,725
git diff --numstat -- '*.html'           # +3,767 / -16,783

# 忽略缺口逐项实测
git check-ignore -v .khy/ .khyos/ NIGHTSHIFT.md .zcode/ .ai/hq/
```

---

## 附录 B：本方案文档自身的落位与执行记录

本方案在撰写过程中**已按仓库既有规范完成自身落位**，可作为「新文档该怎么放」的完整**活样例**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 落点选择 | 选中 `docs/07_OPS_运维/`（该目录收容运维与使用手册，含 [OPS-MAN-040] Git 入门·main-HEAD-分支-工作树，主题最贴近）。**未另建 `docs/_方案/` 等 `_` 前缀新目录**——`_` 前缀在代码树内表示 PRV 私有，且新建顶层目录须走 [DESIGN-LAY-005] 登记，否则 `check-repo-layout.js` 判 `layer-registry` error |
| 2 | 编号命名 | 取该目录最大编号 +1（现有最大 `[OPS-MAN-205]`）→ `[OPS-MAN-206] 工作树清洁方案.md`，符合 `NN_` 分类 + `[编号] 标题` 形态 |
| 3 | 就近索引登记 | 在该目录 `00_INDEX_运维-分类索引.md` 文件清单表补一行（第 208 行）+ 一条 `📌 2026-09-18 新增` 说明 |
| 4 | 主索引登记 | 在 `docs/00_INDEX_文档索引.md` 补链接（**这一步最容易漏**，`docs-index-complete` 检查会报 error） |
| 5 | 生成孪生 | `npm run docs:build` → `npm run docs:verify` 全通过；`.md` 与 `.html` **两个孪生文件均已生成**且成对 |

**落位守卫验证（实测，非自述）**：

```bash
node scripts/ci/check-repo-layout.js --promote=docs-index-first,layer-registry
```

结果：**本文件（`[OPS-MAN-206] 工作树清洁方案.md`）未被报任何 `layer-registry` 或 `docs-index-complete` 错误**。逐项核对：

| 检查项 | 实测 | 本文件是否被点名 |
|---|---|---|
| `docs-index-complete` | 1（基线 0）——剩 `08_MGMT_项目管理/[MGMT-RPT-031] GitHub调研-终端渲染TUI-2026-09-17.md` | **否**（`--list` 命中数 = 0，属既有无关文档） |
| `layer-registry` | 1 error ——`tmp-cmp` | **否** |
| `root-whitelist` | 1 error ——`NIGHTSHIFT.md` | 否 |

即需求中「补后该项由 2 降至 1，剩余 1 项为既有无关文档」**已实测确认成立**：本文件登记前后差 1，残留的 1 项确为 08 阶段的既有文档，与本方案无关。

**顺带发现（供 [LAYOUT-004] 巡检参考）**：同一次运行中，守卫另报了 3 类**既有**根目录违规（非本方案引入）：

- `NIGHTSHIFT.md` — 根目录白名单外的说明性文件（`root-whitelist`），须收容进 `docs/15_维护记录/`（**不是**忽略，见下方冲突提示）。
- `tmp-cmp` — 根目录临时/事故残留（`root-junk`），须删除或收容进 `.khy/tmp`。
- `tmp-cmp` — 同时触发 `layer-registry`（顶层目录未登记）。

> ⚠️ **`tmp-cmp` 的机理（实测澄清，易误判）**：该目录**当前是空目录**，且 `.gitignore:215` 已有 `tmp-cmp/` 规则（`git check-ignore` 命中）。它之所以**仍**被判两级 error，是因为 `check-repo-layout.js` 的 `checkLayerRegistry` / `checkRootJunk` 走的是 `fs.readdirSync` **而不是 git**——**忽略规则对它们完全无效**，空目录也照样命中。
>
> 推论（对整改方式有决定性影响）：**光加 `.gitignore` 治不了 `tmp-cmp`，必须真正删掉该目录**（空目录可直接 `rmdir`，无内容损失）。这与 `_方案/` 那类「有内容、需迁移」的处置不同。

> ⚠️ **冲突提示（须先人工裁定，裁定前不得动任一副本）**：本方案 M1 初稿提议把根级 `NIGHTSHIFT.md`/`NIGHTSHIFT.html` 加入 `.gitignore`，但布局守则判定它属「根目录白名单外的说明性文件」，须收容进 `docs/` 对应子目录。
>
> 实测（2026-09-18 复核）：
>
> | 事实 | 实测值 |
> |---|---|
> | 根级 `NIGHTSHIFT.md` | 存在，**169** 行 |
> | `docs/15_维护记录/其它维护记录/NIGHTSHIFT.md` | 存在，**174** 行 |
> | 两份内容 | **不同**（`diff` 确认） |
> | 两份 git 跟踪状态 | **均未跟踪**（`git ls-files` 对四个路径均为空） |
>
> ⇒ **「真源在哪」本身无定论**。因此该文件**不应按 M1 简单忽略**，也**不得在裁定前移动或删除任一副本**（删除可能摧毁唯一副本 —— 这正是本方案第三节「绝不一把梭」原则要防的事）。
>
> **建议裁定路径**：由维护者比对两份内容，取信息更全者（行数上 `docs/15_维护记录/` 版多 5 行，但**行数多不等于更权威**，须实读）为真源；`docs/15_维护记录/` 版符合目录归属，天然候选。裁定后：保留真源、移除另一副本，并在 `.gitignore` **不**为它添规则（说明性文件按收容处理，非忽略）。
>
> **`tmp-cmp` 一并记入**：根目录残留、须收容至 `.khy/tmp` 或直接删除；因忽略规则对它无效（见上），处置动作是**删除目录本身**。
