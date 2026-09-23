---
name: 仓库层级可发现性
id: LAYOUT-006
domain: LAYOUT
nature: 约束为主，兼权力与福利
scope: "L0–L6 各层内部（`kernel/**`、`platform/**`、`services/**`、`apps/**`、`software/**`、`extensions/**`、`tools/**`）、横切层（`scripts/**`、`docs/**`、`packaging/**`）、以及它们的任何子目录（一切「东西放在哪个目录里」的判定；不含仓库顶层目录的层归属——那是 `[DESIGN-LAY-005]` / `LAYOUT-001` 的辖区）"
priority: P1
trigger: 在一个目录里新增第 N 个直接条目时；把一个平铺目录拆成子目录时；给超预算目录写 `00_INDEX_*` 时；审计「新人为什么找不到东西」时
constraint: 任何目录的直接条目数不得超过其「可发现性预算」（顶层 50 / 分类 50 / 实现 40 / 文档 30，见 §2）；超预算的目录必须按「前缀家族」拆分为子目录，或（仅文档目录）提供一个**真编组**的 `00_INDEX_*`（单个分组块内条目数 ≤ 80，见 §3）；拆分必须整族一次移动，不得逐文件迁移；`.zcode` / `node_modules` / `vendor` / 产物目录 / 一切点目录不计入
grants: 授权任何人在不询问维护者的前提下，对超预算目录执行「整族拆分子目录 + 留 re-export 壳」的标准动作（§4 给出精确步骤与代价模型）；授权对平铺目录的大规模 `git mv`（判定依据是可发现性预算，不是主观审美）；授权维护者按 §7 分层分批推进而不必一次做完
benefit: 新人第一次进仓就能凭目录名预判内容，不必先 `ls | grep`；把「这个函数在哪」的检索成本从「全仓 grep + 人眼筛」压到「按层走一次路径」；同时**顺带修掉**一类长期潜伏 bug——实测本仓有 24 处深层 require 因历史搬迁时 `../` 级数算错而指向不存在的路径（`[DESIGN-LAY-005]` §2.1 已登记），本规范的「整族一次移动 + 出边计数」正是该缺陷的根因疗法
exception: 见 §5 例外节——`migrations/`、`assets/`、`规则卡/`（生成物，禁手改）、工具约定目录（`.github/` 等点目录）、以及 `services/backend/src/services` 的存量基线（进 §8 基线台账，只降不升）
version: "1.1.0 (2026-09-18) 步骤2.1 tool* 示范批实迁后订正代价模型（§1.3.1：`./` 边按目标解析判定、留壳使父目录 +1）；初版 1.0.0 本文配套原型 scripts/ci/discoverability-demo.js 14 场景实测；实测存量 40 error + 3 warning 全部逐条核验为真"
status: draft
ssot: docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] 仓库层级可发现性规范.md
enforcement: scripts/ci/check-discoverability.js
formerly: 无
owner: architecture-team
---

<!-- RULES-REGISTRY: LAYOUT-006 -->

# [DESIGN-LAY-006] 仓库层级可发现性规范

> **定位**：管「**东西放在哪个目录里、找不找得到**」。`[DESIGN-LAY-005]` 已经把「顶层七个板块是哪几层、能不能跨层」讲清楚了（纵向轴），`[DESIGN-LAY-002]` 已经把「层内文件该叫什麼名、别的包能不能依赖它」讲清楚了（横向可见性）。但**「层内一个目录里塞了 808 个东西」这件事，三篇 LAY-* 都管不到**——布局守卫只看顶层目录登没登记（`layer-registry`），不看层内有多深多宽。本文补的就是这一段。
>
> **结论**：① 「找不到东西」不是主观抱怨，而是一条**可测量的不等式**——一个目录的直接条目数超过它所属档位的预算，读者就无法凭目录名预判内容；② 拆目录的最大风险不是拆错，而是**改动爆炸**：实测单是 `services/backend/src` 就有 **2979 处相对 require**，任何 naive 搬迁都会连带制造一批新的 `unresolved-require`（本仓已有 24 处这种历史伤疤）；③ 因此本规范强制「**整族一次移动 + 留 re-export 壳**」，并用 §4 的代价模型把「要改几行」在动手前算清楚。
>
> **守卫**：`scripts/ci/check-discoverability.js`（`npm run check:discoverability`）。判定逻辑在纯叶子 `scripts/lib/discoverabilityGuard.js`（零 IO、确定性、绝不抛、可单测）。本文的预算值、豁免名单在该叶子内以常量落地；改本文须同步改叶子。
>
> **与 `[DESIGN-LAY-005]` 的关系**：**不新增重复红线**。§5 把 005 的 `layer-registry`（顶层登没登记）与本文的 `flat-overflow`（层内挤不挤）划成互不相交的两维；两者共用同一个「改文档必须同步改守卫」的纪律。

---

## 0. 一句话

**把「一个目录塞 808 个东西、读者只能靠 `ls | grep`」的现状，收敛成「每个目录的条目数在预算内、文件名前缀即目录名」的层次结构。**

---

## 1. 现状证据（2026-09-18 实测，全部可复现）

### 1.1 平铺热点：28 个目录超预算，最深的一层塞了 808 个条目

`node scripts/ci/check-discoverability.js --top=20` 实测输出（Top 12）：

| 直接条目 | 档位预算 | 目录 | 性质 |
| --- | --- | --- | --- |
| **808** | 40 | `services/backend/src/services/` | 661 文件 + 148 目录平铺；同一件事既有 `a2a/` 目录又有 `a2aFacade.js`/`a2aRegistry.js` 旁置 |
| **745** | 40 | `services/backend/tests/` | 测试与源码同构性完全丢失 |
| **638** | 40 | `services/backend/tests/services/` | 上一条的下钻层，同样平铺 |
| **370** | 30 | `docs/07_OPS_运维/` | 366 份 `OPS-MAN-*.md` 平铺 |
| **267** | 40 | `services/backend/tests/cli/` | |
| **256** | 30 | `docs/03_DESIGN_设计/` | 222 份 `DESIGN-ARCH-*.md` 平铺 |
| **224** | 40 | `services/backend/src/tools/` | 122 文件 + 102 目录 |
| **191** | 40 | `services/backend/src/cli/` | |
| **188** | 30 | `docs/10_规范/` | 含 158 个 `规则卡/` 子条目 |
| **158** | 30 | `docs/10_规范/规则卡/` | 生成物，见 §5 例外 |
| **153** | 40 | `services/backend/src/cli/handlers/` | |
| **133** | 40 | `services/backend/src/services/gateway/` | |

**判据不是「文件多」**，而是**「读者能否凭目录名预判内容」**。`toolCalling.js` 与 `toolUseLoopCore.js` 并排躺在 808 个兄弟里，读者无法预判「tool 相关的东西都在一起」——因为它们**确实不在一起**，是散在 661 个文件里的 33 个。

### 1.2 「前缀家族」证明拆分是**低 churn** 的

同一份实测数据里，`services/backend/src/services/` 的 661 个文件可归出 **18 个前缀家族**：

```text
  33  tool*      e.g. toolAccessGateway.js, toolCallCorrection.js, toolGuards.js
  19  local*     e.g. localBrainCalc.js, localBrainExternalApi.js
  14  ai*        e.g. aiChatPort.js, aiManageDaemonLifecycle.js
  13  prompt*    e.g. promptAssemblyService.js, promptCacheOptimizer.js
  13  session*   [已有同名目录 session/]
  12  memory*    e.g. memoryBridge.js, memoryCompressor.js
  11  model*     e.g. modelCapabilityPort.js, modelDiscoveryEngine.js
  10  task*      e.g. taskCleanupPolicy.js, taskCleanupService.js
```

**两个关键观察**：

1. **文件与目录同名并存**：`a2a/` 目录 + `a2aFacade.js` + `a2aRegistry.js` + `a2aMessageRouter.js`；`session/` 目录 + `sessionFileRepair.js` + `sessionChecklistResetService.js`。**家族已经存在，只是没有收拢**——这不是「发明新结构」，是「把已有结构做实」。
2. **拆分的判据是现成的**：文件名前缀就是目录名。**零命名决策**，因此也零主观争议。

### 1.3 代价模型：为什么必须「整族一次移动」

实测 `tool*` 家族 33 个文件的真实代价（`node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] move-cost.js --dir=services/backend/src/services --prefix=tool`）：

| 边类型 | 处数 | 留下 re-export 壳后 | 说明 |
| --- | --- | --- | --- |
| **入边**（别人 `require` 它） | **374** | **0 改动** | 壳兜住；实测 `module.exports = require('…')` 被布局守卫判为「纯 re-export 壳」而豁免（`check-repo-layout.js:847`） |
| **出边**（它自己 `require` 别人） | **98** | **98 改动** | **壳救不了**：文件深度变了，`../` 级数必须逐条改 |
| **同前缀 `./` 边** | **386** | **见 §1.3.1** | ⚠️ **不等于「兄弟边」** —— 实测只有 76 条指向真兄弟 |

> **实测教训（必须记住）**：本文写作过程中做过一次「移一个文件 + 留壳」的实验，预期「零改动」，结果**当场 `MODULE_NOT_FOUND`**：
> `toolCallCorrection.js` 被移入子目录后，它自己的 `require('../utils/toStr')` 解析到了不存在的路径。**壳只护入边，不护出边。** 这解释了 `[DESIGN-LAY-005]` §2.1 那 24 处「指向不存在路径的深层 require」是怎么来的——正是历史上搬迁时漏改出边。
>
> 结论：**逐文件迁移是负收益**；**整族一次迁移显著压低 `./` 边成本**，但仍须逐条核对（见 §1.3.1）。

### 1.3.1 ⚠ 两处代价模型缺陷（2026-09-18 实测订正）

> **本节由步骤 2.1 示范批（`tool*` 33 文件实迁）的实测数据订正**。初版模型在此批上
> 有**两处硬缺陷**，均会误导后续批次。**动手前必读。**

**缺陷 ①：`./` 前缀 ≠ 兄弟边。**

初版把「`./x` 前缀」直接当作「家族内部互引」，并断言「同批移动则路径关系不变 = 0 改动」。
实测 386 条 `./` 边的**真实目标归属**：

| 目标落在哪 | 条数 | 处置 |
| --- | --- | --- |
| `tool/` 内（**真兄弟**，同批移动 ⇒ 0 改动） | **76** | 保持 |
| 父目录 `services/`（**须升一级为 `../`**） | **289** | **必改** |
| 目录 index（`./capabilityMatrix` → `capabilityMatrix/index.js`） | **21** | **必改** |

**根因**：`services/` 是 808 条的**平铺巨目录**，家族成员的 `./xxx` 绝大多数指向
**父目录里的其他文件**，而非同族兄弟。前缀字符串无法区分二者。

> **正确判据（可机器判）**：**解析目标落在哪，而不是前缀长什么样**。
> 对每条相对 require：`path.resolve` 后试 `+''/'.js'/'.json'/'.node'` 及
> `index.js` —— 能在**新位置**解析则保留；否则若能在**父目录**解析则升一级；两者皆否即真断。
>
> **实测**：本批实际须改 **98（出边）+ 309（`./` 边）= 407 条**，而非初版预估的 98 条。

**缺陷 ②：留壳使父目录条目数 `+1`，不是 `−N`。**

初版 §7 步骤 2.1 的「收益」栏写 `808 → 775`，隐含假设**壳不计入可发现性预算**。
实测不成立：`discoverabilityGuard.classifyEntry` **只看名字、不看内容**
（`EXEMPT_NAMES` 无 shell / re-export 概念），壳与真实模块同名 ⇒ **壳被计入 `counted`**。

对 N 个文件的家族执行 §4 标准动作：

```text
移动前：父目录 = … + N 个文件
移动后：父目录 = … + N 个壳  +  1 个新目录 F/
⇒ 父目录条目净变化 = (N + 1) − N = +1
```

**实测**：`services/backend/src/services` `808 → 809`（**+1**），与上式一致。

> **推论（对步骤 3 有决定性影响）**：**在 §4.2 的壳清理完成之前，
> 「整族迁移」并不降低父目录的可发现性读数**，反而 +1。
> 只有删掉 N 个壳（入边已全部改走新路径）后才能得到真正的 `−N + 1`。
> 因此 **§4.2 的壳清理不是「可选收尾」，而是本规范收益兑现的前置条件**
> —— 步骤 3 收口必须先于 / 同步于「升 error」，否则会把「照 §4 做完的标准动作」判红。

### 1.4 「有索引」≠「找得到」：3 份索引有形无实

`00_INDEX_*` 存在，不等于它在编组。实测：

| 索引 | `##` 小节数 | 最大单块条目数 | 判定 |
| --- | --- | --- | --- |
| `docs/07_OPS_运维/00_INDEX_运维-分类索引.md` | 4 | **184**（「二、文件清单」块） | 有形无实 |
| `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` | — | **97** | 有形无实 |
| `docs/10_规范/00_INDEX_规范-总目录.md` | — | **101** | 有形无实 |

一份 184 条的平铺清单，读者仍要 Ctrl+F。**索引的编组作用取决于「最大单块大小」，不取决于「有没有 `##`」**——这是本文的一条实测判据（初版曾把 `##` 数量当信号，导致 0 发现，属误判）。

### 1.5 全仓基线

```text
counts: {"flat-overflow": 40, "no-grouping": 3}
errors: 40    warnings: 3    超预算目录: 40
```

**40 条 finding 已逐条人工核验为真**。核验过程中修掉 1 类误报（见 §6.1）。

---

## 2. 可发现性预算（核心公理）

**公理 A1（可测量公理）**：「找得到」必须能被机器判定，否则就是主观抱怨。

**公理 A2（预算公理）**：目录容量有上限，且上限由**读者面对它时的检索方式**决定，不由文件数本身决定。

**公理 A3（家族公理）**：拆分的边界应当**已被文件名表达**（前缀家族），避免引入主观命名争议。

**公理 A4（低 churn 公理）**：任何迁移方案必须先给出「要改几行」「要留几个壳」的实测数字；**改不动的结构不是结构，是债务**。

### 2.1 四档预算

| 档位 | 预算 | 适用 | 读者行为 |
| --- | --- | --- | --- |
| `top` | **50** | 仓库顶层、各层顶层 | 靠名字导航，容忍度最高 |
| `category` | **50** | `docs/NN_*/` 之下的非文档目录 | 靠名字导航 |
| `implementation` | **40** | `src/**`、`tests/**`、`scripts/**` | 靠 grep / IDE 跳转，容忍度中 |
| `docs` | **30** | `docs/NN_*/` 本身 | **靠人眼扫索引**，容忍度最低 |

**为什么文档档最严**：代码目录有 Ctrl+P / go-to-definition 兜底；文档目录**没有**——读者只能一个个点。所以 `docs/07_OPS_运维` 的 370 比 `services/backend/src/services` 的 808 更阻碍检索，尽管数字更小。

### 2.2 预算是「预算」不是「禁令」

超过预算的正确反应是**拆组或建索引**，不是「删文件」。例外地，`规则卡/` 这类生成物无法手拆，走 §5 例外。

---

## 3. 分组判据

### 3.1 代码目录：整族拆入子目录

**判据（可机器判）**：同目录里存在 ≥ 6 个共享同一文件名前缀（首个驼峰边界或 `-`/`_` 之前）的文件 → 该家族应移入同名子目录。

```text
services/backend/src/services/toolAccessGateway.js   →  services/backend/src/services/tool/accessGateway.js
services/backend/src/services/toolGuards.js          →  services/backend/src/services/tool/guards.js
services/backend/src/services/toolSpec.js            →  services/backend/src/services/tool/spec.js
```

> **两种落点，各有代价**（必须二选一并写进迁移批次表）：
> - **(a) 保留全名**：`tool/toolAccessGateway.js` —— 出边改动最少，但目录内仍有 `tool` 冗余前缀。
> - **(b) 去掉冗余前缀**：`tool/accessGateway.js` —— 更干净，但**每个文件都被改名**，入边壳的文件名也随之变化。
>
> **默认选 (a)**：符合 A4 低 churn 公理（改名会同时放大入边与出边的核销成本）。选 (b) 须在批次表里写明理由。

### 3.2 文档目录：真编组索引

**判据（可机器判）**：索引文档中**任一标题块内的条目行数 ≤ 80**。

「条目行」= 表格数据行（`|` 开头且非分隔行）或列表项（`-`/`*`/`+`/`N.` 开头）。超过 80 即判 `no-grouping`（warning）。

> **为什么不直接拆 `docs/07_OPS_运维/` 的 366 份文件**：文档文件的路径被**其他文档正文引用**（实测 `[DESIGN-LAY-005]` 明文记载 `services/backend` 被 429 处 `docs/` 内引用），移动文档的入边成本远高于代码（没有 `require` 可被壳兜住，只有人写的相对路径）。因此**文档档优先「建索引」而非「移文件」**——这是一条刻意的非对称。
>
> **但索引不是免拆金牌**：`docs/07_OPS_运维` 同时命中 `flat-overflow`（370 > 30）与 `no-grouping`（184 > 80）。建好索引后 `no-grouping` 消除；若要把 `flat-overflow` 也消掉，需按 §3.3 给文档也分族。

### 3.3 文档的族划分（可选，优先级低于索引）

文档的「家族」由**文件名的话题词**给出，而非机械前缀。实测 `docs/07_OPS_运维` 可按编号段自然分块：

```text
docs/07_OPS_运维/
  00_INDEX_运维-分类索引.md
  入门/     OPS-MAN-023/027/028/037/043 …      # 「第一次装完想跑起来」
  接入/     OPS-MAN-001/004/006/007/012/032 …  # CLI / provider / 代理接入
  运行/     OPS-MAN-026/029/030/033 …          # 会话恢复 / 磁盘守卫 / 回滚
  排障/     …
  runbooks/            [已存在]
  incident-runbooks/   [已存在]
```

> ⚠ `runbooks/` 与 `incident-runbooks/` 目前**只有各自一个 `00_INDEX`**，是空壳——说明「分族」这件事此前被启动过但没落地。本文把它的落地判据补上。

---

## 4. 迁移操作规范（整族一次移动）

**这是本规范唯一允许的标准动作。** 逐文件迁移被明文禁止（§1.3 实测：逐文件要改 386 条兄弟边，整族只要 0 条）。

```text
对一个前缀家族 F（默认 ≥ 6 个文件）执行：

1. 预备
   node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] move-cost.js --dir=<父目录> --prefix=<F>     # 打印入边/出边/同前缀边
   - 记下「出边须改」数 **+ 同前缀 `./` 边中目标落在父目录/目录 index 的条数**
     = 本批的实际工作量（写进批次表）
   - ⚠️ 不要用「`./` 边总数」当工作量 —— 见 §1.3.1 缺陷 ①，其中真兄弟只占约 1/5
   - 若（出边 + 父目录 `./` 边）> 文件数 × 5，先按 §4.1 降级为「只建索引」

2. 一次移动（整族，一个 commit）
   git mv <父目录>/<F>*.js <父目录>/<F>/            # 整族一起，不做子集

3. 修边（壳救不了的那部分）—— **按目标解析，不按前缀**
   - 对本批**新位置**的每个文件，逐条取相对 require，`path.resolve` 试解析：
     · 能在**新目录内**解析        → 保留（真兄弟，同批移动路径关系不变）
     · 否则能在**父目录内**解析    → 升一级（`./x` → `../x`；`../y` → `../../y`）
     · 两者皆否                    → **真断，必须人工核**（多半是历史遗留的指空边）
   - ⚠️ 判据是**解析目标落在哪**，不是前缀长什么样（§1.3.1）

4. 留壳（护入边 —— 374 → 0 的关键）
   - 在**原路径**重建同名文件，内容恰好一行：
     module.exports = require('./<F>/<原名>');
   - 壳必须是**纯 re-export**（去注释空行后只剩这一句），否则布局守卫的
     cross-layer-require 豁免失效，计入违规

5. 验证
   node -e "require('<原入口路径>')"      # 壳链路可用
   npm run check:layout                    # 确认 unresolved-require 未上升
   npm run check:discoverability            # 确认该目录条目数降档
```

### 4.1 降级路径（须改边过密时）

若 `move-cost.js` 报（出边 + 父目录 `./` 边）> 文件数 × 5（家族与父目录耦合过深），
**不要把须改的边当成可一次改完的量**：

1. 先只做 §3.2 的索引编组（文档）/ 或在父目录落一份 `00_INDEX_<域>.md` 清单（代码），把「找得到」这个近期目标达成；
2. 把该家族写进 §8 基线台账，标注「待拆 + 须改边数」；
3. 边的收敛是独立的、可增量做的工作，不与本规范的引入绑死。

### 4.2 壳的清理条件

壳是**有寿命的**，不是永久垫层。⚠️ 因为壳**计入可发现性预算**（§1.3.1 缺陷 ②），
**壳清理是「迁移收益兑现」的前置条件**，不是可选收尾：

| 条件 | 动作 |
| --- | --- |
| 该壳的入边已全部改为新路径 | **删除壳**（此时父目录才真正 `−1`） |
| 壳存在超过**一个大版本**且入边数下降为 0 | 强制删除（由 §8 台账跟踪） |
| 壳里被写进任何逻辑 | 立即回退 —— 已违反纯 re-export 契约，布局守卫会判违规 |

> **批次的「收益」栏必须写两个数**：`迁移后读数`（含壳，= 父目录 +1）与
> `壳清理后读数`（= 父目录 −N+1）。只写后者是**虚假收益**。

---

## 5. 例外

| 例外 | 理由 | 处置 |
| --- | --- | --- |
| `docs/10_规范/规则卡/` | **生成物**，由 `npm run docs:rules-cards` 产出，手拆会被覆盖 | 只报不计（`EXEMPT`），并在 `[DESIGN-LAY-006]` 台账登记 |
| `migrations/`、`assets/` | 外部工具按顺序/按名读取，拆目录会破坏工具契约 | 叶子层 `EXEMPT_NAMES` |
| `vendor/`、`node_modules/` | 第三方代码落点，不是本仓的层级设计 | 叶子层 `EXEMPT_NAMES` |
| `dist/build/out/release/coverage/_build/dist-electron` | 已由 `[DESIGN-LAY-004]` 管（产物单一根） | 叶子层 `EXEMPT_NAMES`，与 004 共用名单 |
| **一切点目录**（`.github/`、`.claude/`、`.zcode/`…） | 按**工具约定**命名，改它们等于改工具契约 | `isDotDir` |
| `services/backend/src/services` 等 40 处存量 | 存量债务，见 §8 | 进基线，**只降不升** |

> **例外不是豁免权，是登记义务**。每条例外必须在 §5 表格里说明「为什么不能归入正常判据」，且必须在叶子常量里同步落地。**只改本文不改叶子，或只改叶子不改本文，同样视为违规。**

---

## 6. 强度梯度（与 `[DESIGN-LAY-004]` 同一套路）

| 阶段 | 强度 | 行为 |
| --- | --- | --- |
| **事前**（新增文件时） | advisory | 不阻断。读者自行核对预算；AI 被要求在新增前查一次 |
| **事中**（已超预算） | warning + 基线 | 进 `discoverability-baseline.json`，超基线自动升 error |
| **事末**（拆分完成） | error | §7 步骤 3 收口后，`flat-overflow` 转 error 阻断 |

**为什么事前不用 error**：过早阻断会逼 AI 把新文件塞进已有的大目录以「避开」检查，反而加速平铺。**强度必须与「有可行解」同步**——存量 40 处未拆时，对新增第 41 个文件报 error 是不公平的。

### 6.1 误报教训（本文写作中实测）

初版 `inspectDir` 把 `.zcode/tmp/`（175 条目）判为 `flat-overflow`。**这是误报**：

- `.zcode/tmp/` 在 `.gitignore` 第 225 行被整体忽略（`/.zcode/tmp/`），是会话 scratch 目录；
- 判据「读者能不能凭目录名预判内容」对它**不成立**——没有人靠目录名去那里找东西。

**修法**：`EXEMPT_NAMES` 增加 `.zcode` / `.zcode-tmp` / `.research-tmp` / `.khy_orphan_sweep` / `tmp-cmp`，并引入 `isDotDir`（一切点目录豁免）。

**初版还有一处判据缺陷**：`inspectIndex` 用 `##` 小节数量当编组信号，导致 3 份「有形无实」的索引**全部漏报**（它们都有 `##`）。**修法**：改为「最大单块条目数 ≤ 80」。

> **纪律**：低精度守卫比没有守卫更糟——误报会被整体绕过。本文的 43 条 finding **已逐条人工核验为真**，核验过程见 §1。

---

## 7. B-L2 三步接线清单（SOURCING-006：一次提交只做一步）

### 步骤 1 —— 标记（本次）

- [x] 落真源 `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] 仓库层级可发现性规范.md`
- [x] 叶子 `scripts/lib/discoverabilityGuard.js`（纯叶子：零 IO / 确定性 / 绝不抛）
- [x] CLI `scripts/ci/check-discoverability.js`（默认 **advisory 恒 exit 0**）
- [x] 反例矩阵 `scripts/ci/discoverability-demo.js`（14 场景，含 9 条「应放行」）
- [x] 登记 `RULES-REGISTRY.json` 的 `LAYOUT-006`
- [x] 真源标记行 `<!-- RULES-REGISTRY: LAYOUT-006 -->`
- [x] `package.json` 别名 `check:discoverability`（否则 `check-wiring` 判 error）
- [x] 基线 `scripts/ci/discoverability-baseline.json`：`{flat-overflow: 40, no-grouping: 3}`

### 步骤 2 —— 迁移（分批，每批一个 commit）

按 §4 整族迁移。**建议顺序（按收益/代价比）**：

| 批 | 目标 | 文件数 | 须改边（实测/预估） | 收益（迁移后 → 壳清理后） |
| --- | --- | --- | --- | --- |
| **2.1 ✅ 已完成** | `services/backend/src/services` 的 `tool*` → `tool/` | 33 | **407 = 98 出边 + 309 `./` 边**（初版误估 98） | 808 → **809**（含壳） → **776**（清壳后） |
| 2.2 | `docs/07_OPS_运维` 建真编组索引 | 0（只改索引） | 0 | 消除 1 条 `no-grouping` |
| 2.3 | `docs/03_DESIGN_设计`、`docs/10_规范` 建真编组索引 | 0 | 0 | 消除 2 条 `no-grouping` |
| 2.4 | `services/backend/tests/**` 镜像源码的族划分 | ~200 | 待测 | 745 / 638 两处 |
| 2.5 | 其余 `services/backend/**` 热点 | — | 待测 | — |

> ⚠️ **收益栏必须写两个数**（见 §4.2）：含壳的「迁移后读数」与「壳清理后读数」。
> 2.1 批的实测证明：**只写后者是虚假收益** —— 迁移本身让父目录 **+1**。

**每批完成后必须**：
1. 跑 `npm run check:layout`，确认 `unresolved-require` **未上升**（这是整族迁移没漏改出边的唯一客观证据）；
2. 跑 `npm run check:discoverability`，确认该目录降档；
3. `npm run check:discoverability -- --update-baseline` 下调基线（**只降不升**）。

### 步骤 3 —— 收口

> ⚠️ **前置条件（2026-09-18 实测增设）**：**在存量 `flat-overflow` 清零 / 大多数家族完成
> 「迁移 + 清壳」之前，不得把 `flat-overflow` 升 error。** 理由见 §1.3.1 缺陷 ②：
> 迁移本身让父目录 **+1**，此时升 error 会把「照 §4 做完标准动作」的目录判红，
> 与 §6「强度必须与『有可行解』同步」的公理直接冲突。

- [x] **修正代价模型**（§1.3.1 / §4 / §4.2 / §8）：`./` 边按目标解析判定、壳计入预算、
      收益栏双数（本步为 2026-09-18 实测订正，属「修判据」而非「改仓库去满足错误判据」）
- [ ] `flat-overflow` 升 error（`gate: pr`）—— **待存量家族完成「迁移 + 清壳」后**
- [x] `no-grouping` 升 error（`gate: pr`）—— 文档索引编组无「+1 副作用」，可先行收紧
- [ ] 基线台账清零或固定在一个**只降**的小数字
- [ ] 新增 CI 作业 `discoverability-roundtrip`
- [ ] 回写 `[DESIGN-LAY-005]` §1.2 横切层表（把本节作为层内判据的关联文档）
- [ ] 清理 §4.2 到期的 re-export 壳（**这是收益兑现的前置条件，不是可选收尾**）

---

## 8. 基线台账（只降不升）

`scripts/ci/discoverability-baseline.json`：

```json
{
  "_note": "只降不升。上调基线让 CI 变绿是违规 —— 见 [DESIGN-LAY-005] §7 同一纪律。",
  "counts": { "flat-overflow": 40, "no-grouping": 4 },
  "updated": "2026-09-18"
}
```

> **⚠ 2.1 批实测的基线语义澄清**：`flat-overflow` 的计数**不因「整族迁移 + 留壳」而下降**
> （§1.3.1 缺陷 ②：壳计入预算，父目录 `808 → 809`）。**降低该计数的唯一路径是
> 「迁移 + 清壳」，两者缺一不可** —— 只迁移不清理 = 计数不降反升。
> 因此 2.1 批**不构成**一次基线下调；基线保持 `40` 不变是**正确**的，不是漏更新。
>
> `no-grouping` 由 3 → 4 系并入一条并行工作流新增的超预算索引（非本批引入）。

当前 40 处 `flat-overflow` 的完整清单用 `npm run check:discoverability -- --list=flat-overflow` 打印。

**降低基线的唯一合法方式**：真的拆掉一个目录（§4）**并清理其壳**（§4.2），然后 `--update-baseline`。

---

## 9. 验证与反例矩阵

```bash
npm run check:discoverability                       # 全仓扫描，advisory
npm run check:discoverability -- --strict           # 有 error 即 exit 1
npm run check:discoverability -- --json             # 机器可读
npm run check:discoverability -- --list=flat-overflow
npm run check:discoverability -- --top=20           # 只报最挤的 20 个
node scripts/ci/discoverability-demo.js --all            # 反例矩阵
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] move-cost.js --dir=<父目录> --prefix=<族> # 迁移前算代价
```

### 9.1 反例矩阵（14 场景，实测）

| 场景 | 输入 | 期望 | 实测 |
| --- | --- | --- | --- |
| `clean` | 组织良好的 docs 目录 | 0 发现 | ✅ 0/0 |
| `clean-code-dir` | 35 文件的代码目录 | 0 发现 | ✅ 0/0 |
| `flat-overflow-boundary-ok` | 恰好 40 条目 | 0 发现（**边界应放行**） | ✅ 0/0 |
| `flat-overflow-boundary-over` | 41 条目 | 1 error | ✅ 1/0 |
| `exempt-vendor` | vendor/node_modules/dist | 0 发现 | ✅ 0/0 |
| `exempt-dotdir` | `.zcode`/`.cache`/`.github` | 0 发现 | ✅ 0/0 |
| `index-grouped-ok` | 6 组 × 20 条的真编组索引 | 0 发现 | ✅ 0/0 |
| `robust-nonarray` | `null` 输入 | 不抛 | ✅ 0/0 |
| `flat-overflow` | 809 条目 | 1 error | ✅ 1/0 |
| `docs-budget-stricter` | docs 里 35 条目 | 1 error（文档档更严） | ✅ 1/0 |
| `no-grouping` | 184 条单块索引 | 1 warning | ✅ 0/1 |
| `empty-index` | 空索引 | 1 error | ✅ 1/0 |
| `robust-badentry` | `[null, 42, '', …]` | 不抛且正确计数 | ✅ 1/0 |

**9 条「应放行」场景全部 0 发现** —— 证明守卫不是无脑拦。

---

## 10. 复现方式

```bash
# 现状：40 error + 3 warning
node scripts/ci/check-discoverability.js

# 平铺热点 Top 12
node scripts/ci/check-discoverability.js --top=12

# 前缀家族（拆分目标从哪来）
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] family-probe.js

# 迁移代价（动手前必算）
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] move-cost.js --dir=services/backend/src/services --prefix=tool

# 反例矩阵
node scripts/ci/discoverability-demo.js --all

# 层级总览
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] layout-probe.js
```

---

## 11. 与既有机制边界

| 既有件 | 管什么 | 本规范做什么 | 边界 |
| --- | --- | --- | --- |
| `[DESIGN-LAY-005]` / `LAYOUT-001`（`layer-registry`） | 顶层目录**登没登记** | 层**内**条目**挤不挤** | 纵向 vs 层内；**不重叠** |
| `[DESIGN-LAY-002]`（可见性轴） | 层内**该不该被别的包看见**（PUB/INT/PRV） | 层内**放得下吗 / 找得到吗** | 可见性语义 vs 容量与检索 |
| `[DESIGN-LAY-003]`（仓库整理与巡检） | 存量杂物**回收**（只隔离不删除） | 存量结构**拆分**（移 + 留壳） | 删除 vs 重组 |
| `[DESIGN-LAY-004]` / `LAYOUT-005`（产物单一根） | **产物**放哪 | **源码/文档**怎么分 | 可再生输出 vs 手写内容 |
| `check-repo-layout` 的 `unresolved-require` | 深层 require **指空** | 从**根因**减少这类迁移事故 | 本规范的整族迁移是它的前置疗法 |

---

## 关联

- 顶层层级与依赖方向（纵向轴）：`[DESIGN-LAY-005] 仓库层级板块规范`
- 层内可见性与命名（横向轴）：`[DESIGN-LAY-002] 目录层级与文件归类规范`
- 存量杂物巡检：`[DESIGN-LAY-003] 仓库整理与巡检规范`
- 产物单一根：`[DESIGN-LAY-004] 构建产物单一根规范`
- 后端分层：`[DESIGN-LAY-001] 后端分层架构规范`
- 文档结构与索引铁律：`[MGMT-STD-001] 项目文档结构与索引铁律规范`
- 规则元标准（本卡格式真源）：`[MGMT-STD-008]`
- 新增机制四阶段：`[DESIGN-PROCESS-002] 新机制落地四阶段流程`
