# [DESIGN-ARCH-117] khy 多端入口矩阵

> **定位**：回答一个问题——**「khy 有哪些端，每个端的入口在哪，怎么起，怎么构建，现在能不能用？」**
> 本文件是该问题的规范真源；机器可读的数据真源是仓库根的 `entries/entries.json`。
> 两者是「规范 ↔ 落地」关系，不是两份真源：改端先改数据表，改约定先改本文件。
>
> **数据与实现分居两处**（有意的分工，不是没搬完）：
> 表在根 `entries/`，读表的实现在 `services/backend/src/services/entrypoints/`。
> 理由见 §二.2。
>
> **本文不新增任何规则**，因此不携带 `<!-- RULES-REGISTRY -->` 标记。它登记的是
> **一处现状收口**：把此前散在五处、互相矛盾的「端」定义，收敛成一份带检活的登记表。
>
> **依据**：层级落点依据 `[DESIGN-LAY-005]` 第一节/第六节；产物坐标不复制依据
> `[DESIGN-LAY-005]` §1.2 与 `[DESIGN-LAY-004]`（LAYOUT-005）；端点禁止字面量依据
> 工程规则 1（`RUNTIME-001`）；端到端的操作选路依据 `[DESIGN-ARCH-071]`（CH-2 / CH-3）。

---

## 一、现状：同一个问题有五份答案（2026-09-17 实测）

在 `entries/` 与 `services/backend/src/services/entrypoints/` 出现之前，问「khy 有哪些端、怎么起」，
会得到五份互不相同的回答：

| # | 答案所在 | 它说有哪些端 | 它的问题 |
|---|---|---|---|
| 1 | `services/backend/src/services/crossPlatform/crossLauncher.js` 的 `PLATFORM_COMMANDS` | backend / cli / web / desktop / mobile | 只启 **dev 服务**（各包自己的 `dev` 脚本，非根入口），不是产物；`mobile` 项指向已损坏的 `apps/khy-mobile` |
| 2 | `platform/khy_platform/android_build.py` | 只有移动端 | 定位的仍是 `apps/khy-mobile`，找不到 `gradlew` |
| 3 | CLI 命令 `khy desktop`（`handlers/desktop.js`） | — | **同名不同义**：它是桌面控制开关，不启桌 |
| 4 | CLI 命令 `khy mobile`（`handlers/mobile.js`） | — | **同名不同义**：它生成配对二维码，不启手机端 |
| 5 | 各处 README / BUILD-OUTPUTS.json | 三套桌面线、两套网页线、三条移动线 | 产物线各自为政，没有一处说明哪条是主推 |

实测到的具体后果：

- **幽灵端**：`apps/khy-mobile` 无 `package.json` / `src/` / `gradlew` / `build.gradle`，
  其自身的 `MANIFEST_MISSING.md` 已声明不可构建；但 `crossLauncher.js` 与
  `platform/khy_platform/android_build.py` **两处在产代码路径仍指向它**，两处点下去必失败。
  （**2026-09-17 收口**：两处引用已改指 `apps/khy-os-client-app`，目录已隔离，`mobile-legacy`
  端登记已移除——见 `[DESIGN-ARCH-120]`。本条保留为历史现状记录。）
- **桌面三条线**：根 `electron/`（无 electron-builder 配置、无 `main` 字段，产不出 exe）、
  `apps/khyos-desktop/`（唯一配齐 electron-builder）、`apps/provider-hub/`（只有 electron-vite 构建，无安装包）。
- **移动三条线**：Flutter `apps/khy-os-client-app/`（唯一有完整构建链）、
  Capacitor `apps/khy-mobile/`（已损坏）、`software/khyquant/frontend` 的 Capacitor 配置（依赖不存在的 `android/`）。
- **网页两条线**：`apps/ai-frontend/`（平台自带）、`software/khyquant/frontend/`（内置应用界面）。

**结论**：问题不在「缺一个目录」，在**缺一份能同时被机器读、被人读、且会自我检活的端清单**。
新增目录只是这份清单的载体。

---

## 二、落点决策：数据在根 `entries/`，实现在 L2

### 2.1 决策过程

按 `[DESIGN-LAY-005]` §6 的决策流程逐条走：

**第 1 步「是文档吗」** → 不是。设计规范（本文件）进 `docs/03_DESIGN_设计/`，
但端清单本身是运行时数据。

**第 2 步「是工程任务脚本吗」** → 不是。端清单要在运行时被 `khy` 命令读，
不是只在开发/构建期被手动调用（L6 判据：见 `[DESIGN-LAY-005]` §1.1b）。

**第 3 步「是运行时代码吗」** → **数据归数据、代码归代码，这一问只对代码部分有答案**。
端清单是数据（JSON + 人读文档），不含运行时代码，因此不受 L0–L6 的「按语言/职责分层」约束；
而读它的 `registry.js` / `probe.js` / `launcher.js` 含 `child_process`，是 **Node 业务逻辑**，
按 §6 第 3 条**只能落 `services/`**，并已按 §四 板块轴登记进
`packaging/modules/modules.json` 的 `khy-tools` 板块。

**第 4 步「想新建顶层目录？」** → 是，且**按 §6 第 4 条完整走完了门槛**：
先改 `[DESIGN-LAY-005]` §1.2 横切层表补一行「为什么不能归入 L0–L6」，
再同步补 `check-repo-layout.js` 的 `CROSSCUTTING.entries`。两处同时改，缺一即违规
（§1.2 的门槛段与 §1.4 同规）。**这不是绕开 `layer-registry`（error 级），
而是按它规定的唯一合法路径登记。**

### 2.2 为什么数据在根、代码在 L2（而不是都放一处）

**驱动这个分工的是一个约束：读取方横跨三层。**

| 读取方 | 层 | 读的是什么 |
|---|---|---|
| Python 启动器（`khy.bat` / `khy.sh` → `python -m khy_platform`） | L1 | 端清单（规划中；用于 `khy entry` 的 Python 侧分派） |
| Node CLI（`khy entry`、`bin/khy.js`、`packaging/npm/bin/khy.js`、`khy-cli.bat`） | L2 | 端清单 + 三个动作（解析 / 检活 / 执行） |
| 脚本与文档（CI 守卫、`scripts/`、`README`） | 横切 | 端清单 |

端清单埋进 L1，L2 的四个入口就得反向读 L1 的实现目录；埋进 L2，Python 侧与文档就得
读 L2 的实现目录。**两种都会让部分读取方绕路，或触碰 `[DESIGN-LAY-005]` §2 的禁止边**。
放在根，全部读取方只需一条 `<appRoot>/entries/entries.json`——
`<appRoot>` 由 `utils/dataHome.getAppRoot()` 解析（可被 `KHY_OS_ROOT` 覆盖），
不引入任何新的层间依赖方向。

**这构成禁止边吗？不构成。** §2 盯的是**源码 import**（`cross-layer-require` 的判据是
跨 workspace 的深层相对 `require`）。此处是**按路径读一个数据文件**，与
`extensionRoots.js` 按路径读各拓展根的 `khy.extension.json` 属同一类操作；
且 `/entries` 已登记在「不参与 L0–L6 依赖判定」的横切层。

**那为什么不干脆把代码也搬到根？** 因为根目录不是层。把含 `child_process` 的实现放根，
会让它成为一块无层可归的运行时代码——`check-repo-layout.js` 无法为它判定依赖方向，
`[DESIGN-LAY-005]` §6 第 3 条也明确「Node 业务逻辑 → `services/`」。
更直接的问题：L2 要 `require` 它就必须走深层相对路径（`../../../entries/...`），
那正是 §2 列为**禁止边**、且守卫计入基线棘轮的写法。

### 2.3 被排除的另外三个落点

| 候选落点 | 排除理由 |
|---|---|
| **`apps/`（L3）** | L3 的定位是「平台自带的**前端**」（`[DESIGN-LAY-005]` §1、守卫 `check-repo-layout.js:91`）。端清单里没有 UI，放进去是贴错层标 |
| **`extensions/scripts/khy-entries/`（L5）** | L5 是「用户会整块启用或整块删掉的能力域」（`[DESIGN-TOOL-002]` §1.4）。端清单删掉后 `khy entry` 就没真源了，它不是可卸载能力，是平台自身的索引 |
| **L1 `platform/khy_platform/`（只放数据）** | Python 侧确实已有 `android_build.py` 与 `cli.py` 的端分派，但 `khy-cli.bat`、`packaging/npm/bin/khy.js` 与 `services/backend/bin/khy.js` 三个入口**绕过 Python 直达 Node**，会读不到 |

### 2.4 本次为落地改动的层级契约

| 文件 | 改动 |
|---|---|
| `[DESIGN-LAY-005]` §1.2 | 横切层表补 `entries/` 一行 + 补「本节新增目录的门槛」段（与 §1.4 同规） |
| `scripts/ci/check-repo-layout.js` | `CROSSCUTTING` 补 `entries` 键，否则 `layer-registry`（error 级）会判「未登记顶层目录」 |

两处必须同时改。**只改脚本不改本文、或只改本文不改脚本，都是违规**——
前者让守卫失去真源依据，后者让 CI 直接红。

---

## 三、目录结构

```
entries/                          ← 仓库根，横切层（§1.2）
├── entries.json                  单一真源（数据）：9 个端条目、平台档、定档状态
├── README.md                     人读的端地图：三条进入方式、端清单、四条硬约束
└── launch.js                     跨平台入口壳：只要 Node，不要 Python

services/backend/src/services/entrypoints/    ← L2，读表的实现
├── registry.js                   加载 + 校验 + 解析（纯函数，不执行任何东西）
├── probe.js                      检活（只读，探磁盘与本机工具链）
├── launcher.js                   执行（attach / wait / detach 三模式，零超时）
└── index.js                      门面（唯一 import 面）
```

### 3.1 `entries/launch.js` 为什么存在

它**不重复实现**任何东西——解析、检活、启动三件事都在 L2 的实现里，它只按
`[DESIGN-LAY-005]` §2 允许的「进程启动」边（`L1 → L2` 的唯一允许边就是 spawn，不是 import）
把 CLI 拉起来。它买到的是一件事：**不依赖 Python 的跨平台入口**。

| 进入方式 | 依赖 | 适用 |
|---|---|---|
| `khy entry ...` | Python 3.8+ 或 Node 20+ | 日常；CLI 的完整命令面 |
| `node entries/launch.js ...` | **只要 Node 20+** | 便携 / 裸目录；没有 Python；非 Windows（`khy-cli.bat` 在那边不可用） |

它**不是**「CLI 坏掉时的备份」——CLI 坏掉它一样坏（它就是去拉 CLI 的）。
把它当备份是误读，此处特意写明。

**刻意没有 `adapters/cli.js`、`adapters/desktop.js` 之类的 per-端 适配器目录。**
端的差异**全是数据**——命令、参数、cwd、工具链、平台档——没有一条端特有的分支逻辑。
加一层适配器目录只会在「读表」与「启动进程」之间插一层纯转发，收益是零。
等到某个端真的长出独有逻辑（例如必须先握手再拉起、必须按端口发现结果再连），
再把它单独拆成文件——那时才有东西可拆。

**没有 per-端 适配器的代价必须说清楚**：一个声明不出「怎么起」的端，在这里表现为
`launch: null` 加一条诚实报错，而不是一段会尝试猜测的代码。这是刻意的：
猜错的启动方式比拒绝启动更贵。

---

## 四、端条目 schema

字段按「回答哪个问题」分组：

| 字段 | 回答的问题 | 说明 |
|---|---|---|
| `id` | 我叫什么 | 唯一键，也是 `khy entry <子命令> <id>` 的参数 |
| `kind` | 我属于哪类端 | `cli` / `desktop` / `mobile` / `web`，枚举在 `kinds` |
| `title` | 人怎么称呼我 | 中文名，含括号内的技术栈 |
| `artifactKind` | 我以什么形态交付 | `shell` / `exe` / `apk` / `html`。**决定第 4 项检活**：非 `shell` 必须有 `build` |
| `delivery` | 产物长什么样 | 自由文本，如「nsis 安装包 + portable 便携版」 |
| `source` | 我的源码在哪 | 相对 `<appRoot>` 的路径，端矩阵里**不出现绝对路径** |
| `markers` | 我怎么算「工程完整」 | 构建关键文件清单。**这是 `broken` 与 `degraded` 的判据**，不是「随便挑一个存在的文件」 |
| `toolchain` | 我需要什么命令 | `node` / `python` / `flutter` / `powershell`；**本机维度**，不参与定档 |
| `status` | 我现在能不能用 | `ready` / `degraded` / `broken` / `planned`，**人工定档** |
| `statusNote` | 为什么是这个定档 | 必填于非 `ready` 的端，写清缺什么 |
| `launch` | 我怎么起 | 平台档 → `{ command, args, cwd, mode, shell }`，可为 `null` |
| `build` | 我怎么构建 | 同上，可为 `null` |
| `artifactOutput` | 我的**可分发力产物**登记在哪 | `docs/10_规范/registry/BUILD-OUTPUTS.json` 的 **id 指针**，可为 `null` |
| `entryFiles` | 我的**日常入口**是仓库里哪个文件 | 仅 `artifactKind: shell` 的端写（`khy.bat` / `khy.sh` / `bin/khy.js`）。与 `artifactOutput` 是两件事，见 §4.3 |
| `ports` | 我占哪个端口 | `[{ ref: "WEB_FRONTEND_PORT" }]`——**只写 serviceDefaults 的导出名** |
| `notes` | 还有什么要知道 | 字符串数组，含已知缺口与收口建议 |

### 4.1 平台档

`launch` / `build` 是 `{ default: step, win32: step, darwin: step, linux: step }` 形状，
解析时取 `plan[process.platform] || plan.default`，都没有就诚实返回「本端未声明该平台的启动档」。

这条路是为了让**缺失也说清楚**：`mobile` 的构建脚本是 PowerShell，只有 `win32` 档；
在 Linux 上问它怎么构建，答案是「未声明 `linux` 平台的构建档」，
而不是一句会失败的命令。

### 4.2 三条「不许写进本表」的东西

| 不许写 | 理由 | 替代 |
|---|---|---|
| 端口字面量 | 工程规则 1 / `RUNTIME-001` 红线 | `ports[].ref` 指向 `constants/serviceDefaults.js` 的导出名 |
| 绝对文件系统路径 | 同上（`no-hardcoded-abs-path`） | `<appRoot>` 占位符 + 仓库相对路径，由 `registry.resolvePath` 解析 |
| 产物路径 | 会与 `BUILD-OUTPUTS.json` 形成第二份真源（`[DESIGN-LAY-004]` 要消灭的正是这个） | `artifactOutput` 存 id 指针 |

`web-quant` 的 `artifactOutput` 为空是**如实留空**：它的 `dist/` 目前没进产物登记表，
本表不代替登记表补 path。

### 4.3 产物指针：读登记表，不抄路径（一处决策反转）

`artifactOutput` 只存 id，`registry.resolveArtifact()` 拿它去
`docs/10_规范/registry/BUILD-OUTPUTS.json` 换出「在哪、在不在、怎么得到」。

**这是一处刻意的决策反转（2026-09-17，来自实测反馈）。** 初版规定
「运行时代码不读那张表，指针只留给人和 CLI 输出」，理由是 L2 读 `docs/` 在本仓无先例。
那个理由站得住，但它买到的东西是零，代价是**端矩阵答不出用户真正要问的问题**：

> 「exe / apk / html 这些入口，我怎么没有看见？」

初版只能回答「登记 id 是 `electron-builder`」，不能回答「它在不在、怎么得到」。
实测证明后者才是需求，于是改为读登记表。

取舍写清楚：**读登记表 ≠ 把 path 抄进 `entries.json`**。抄一份 path 就是第二份真源，
而消灭第二份真源正是 LAYOUT-005 的目的；读登记表则天然跟着走——登记表改了坐标，
端矩阵立刻跟着改。解析结果里 `path`（目标）与 `legacyPath`（尚未迁完的当前位置）**都探**，
谁有内容报谁：报目标位置而磁盘上还没迁过去，等于骗人。空目录不算有内容——
构建失败留下的空壳报「已产出」，代价是让人白跑一趟构建。

### 4.4 `entryFiles` 与 `artifactOutput` 为什么是两件事

终端端把这两个概念撞在一起了：`khy.bat` **现在就在**，pip wheel **没构建**。
只报一个「在/不在」必然误导——报「未产出」让人以为终端不能用，报「已产出」
让人以为分发包好了。所以分开：

| 字段 | 回答 | 对终端端 |
|---|---|---|
| `entryFiles` | 日常怎么进 | `khy.bat` / `khy.sh` / `khy-cli.bat` —— ✅ 现在就有 |
| `artifactOutput` | 可分发力产物在哪 | `pip-dist`（pip wheel）—— 尚未构建 |

`khy entry status` 对 `shell` 类端先报 `entryFiles`（带 ✅/❌），再报打包形态。

---

## 五、检活语义：仓库级 vs 本机级

`khy entry probe` 跑四项检查，但**只有三项参与定档**：

| # | 检查 | 层级 | 参与定档 |
|---|---|---|---|
| 1 | `source`：源目录在不在 | 仓库级 | ✅ 缺失 → `broken` |
| 2 | `markers`：标记文件在不在 | 仓库级 | ✅ 缺失 → `broken`（一个都没命中）/ `degraded`（部分命中） |
| 3 | `toolchain`：本机命令在不在 | **本机级** | ❌ **不参与** |
| 4 | `deliverable`：声明 exe/apk/html 却有没有构建档 | 仓库级 | ✅ 缺失 → `degraded` |

**为什么工具链必须被踢出定档**：一台 CI 机器通常没有 Flutter。若把工具链算进定档，
每次 probe 都会给手机端判一次「降级」，手机端的真实不一致就再也看不见了——
假警报会淹掉真警报。工具链的结论放在独立的 `machine` 字段里，
输出为「本机缺少 flutter，本机无法构建或运行本端（**仓库级声明不受影响**）」。

**漂移（drift）与说明（note）的分工**：

- **`drift`** = 磁盘比表**悲观**。探测能确证的不一致（表说就绪、磁盘上 `package.json` 没了）。
  这是要修的。
- **`note`** = 磁盘比表**乐观**。探测四维都过，但人工定档更低——说明定档依据在探测之外
  （例如 `desktop-provider-hub` 的降级理由是「没有 electron-builder 配置」，
  那不是文件缺失，探测看不见）。这类报 `note` 并附上 `statusNote`，不算漂移。

**数据文件不被静默改写**：probe 从不回写 `entries/entries.json`。
表是数据不是代码，探测结果与表不一致时，报出来让人决定改哪一边。

---

## 六、三层怎么用

### 6.1 CLI（CH-3 正门）

```text
khy entry list                     列出全部端（形态 / 状态 / 源目录）
khy entry list --kind=web          只看某一类端
khy entry status                   exe / apk / html 在哪、产出来没有、怎么得到
khy entry info <id>                单个端的完整声明（含端口来源与产物坐标）
khy entry probe [id]               检活：探磁盘与本机工具链，报定档漂移
khy entry launch <id> [--dry-run]  启动一个端
khy entry build <id> [--dry-run]   构建一个端
khy 多端                           中文/拼音别名（多端 / duan / 有哪些端 / 端入口 → entry list）
```

**三个只读视图各回答一个问题，别混**：

| 命令 | 问题 | 读什么 |
|---|---|---|
| `list` | 端**声明**了什么 | `entries.json` |
| `status` | **产物在哪、产出来没有** | `entries.json` + `BUILD-OUTPUTS.json` + 磁盘 |
| `probe` | 端**能不能跑起来** | 磁盘 + 本机 PATH |

三者都不写回 `entries.json`——表是数据不是代码，探测结果与表不一致时报出来让人决定改哪边。

`--dry-run` 打印解析后的计划（命令、cwd、模式）而不执行——核对「它会跑什么」的最低成本方式。

**第二条等价入口（不要 Python）**：

```text
node entries/launch.js              等价于 khy entry list
node entries/launch.js desktop      等价于 khy entry launch desktop
node entries/launch.js desktop --build
node entries/launch.js probe [<id>]
node entries/launch.js info <id>
```

它是薄壳，不含任何解析逻辑（见 §3.1）——只是把 `khy entry <子命令>` 拉起来。

### 6.2 门面 API（CH-2）

```js
const entrypoints = require('./services/entrypoints');

entrypoints.overview();                 // 表级元信息 + 全部端条目
entrypoints.describe('desktop');        // 解析后的单端描述（路径/端口/平台档已展开）
entrypoints.probeAll();                 // 批量检活
await entrypoints.launch('web');        // 启动
await entrypoints.build('mobile');      // 构建
```

`describe` 与 `launch` / `build` 对未知 id **不抛异常**，返回 `ok:false` + 候选 id 列表——
一个拼错的端名不该让调用方的进程崩掉。

### 6.3 与既有机制的关系（不接管、不回填）

| 既有机制 | 关系 |
|---|---|
| `crossLauncher.js` 的 `PLATFORM_COMMANDS` | **保留为兼容入口**，不再新增端。它的 `mobile` 项指向幽灵端，收口建议见 §七 |
| `platform/khy_platform/android_build.py` | **保留**。它是构建执行器，端矩阵是它的声明层 |
| CLI `khy desktop` / `khy mobile` | **刻意不接管**。它们是同名不同义的另一件事，合并只会把两件事混成一个词 |
| `[DESIGN-ARCH-011]` 应用接入标准 | **不重复**。那管「生态应用如何被底座发现」（`~/.khyos/apps/*.json`）；本表管「平台自身的端有哪些」 |
| `docs/10_规范/registry/BUILD-OUTPUTS.json` | **不复制**。那是产物坐标真源，本表只存指针 |
| `[DESIGN-TOOL-002]` 拓展契约 | **不用 L5**。端不是可卸载能力域，理由见 §二 |

---

## 七、未完成的收口（本表只登记，不代为裁决）

本文件**刻意不修**下列问题——它们各有归属，且部分需要维护者定夺：

1. **幽灵端的两处引用** ~~仍指向 `apps/khy-mobile`~~ **已收口**（2026-09-17，`[DESIGN-ARCH-120]` 阶段二+三）：
   `crossLauncher.js` 的 `mobile` 项改指 `apps/khy-os-client-app` 跑 `flutter run`；
   `android_build.py` 删掉 `apps/khy-mobile` 默认候选、失败提示改指 `npm run android:release`；
   `apps/khy-mobile` 目录已按 `LAYOUT-004` 隔离至 `.khyos/housekeeping/2026-09-17/apps-khy-mobile/`；
   `entries.json` 的 `mobile-legacy` 条目已移除。原「收口二选一」取「改指」分支。
2. **`desktop-legacy` 与 `desktop-provider-hub` 的产物线**：两条都没有 electron-builder
   配置，因而产不出可分发 exe。要么补配置，要么把条目降为 `planned` 或移除。
3. **`software/khyquant/frontend/dist` 未登记进 BUILD-OUTPUTS.json**（表内只有它的
   coverage 条目）。按 LAYOUT-005，每个构建产物都要登记 `path + rebuild + inBuildAll`。
4. **端清单本身尚未登记为规则**：新增一个端**不会**被任何守卫拦住。
   要让「新增端必须登记进 `entries/entries.json`」真的被强制执行，需要按
   `[DESIGN-ARCH-111]` 的绑定层契约登记一条规则（补 `gate` + `exec` + `paths`，
   门会自动纳入），检查器形状建议为：扫描仓库内出现 `apps/<name>/package.json`
   等端特征的目录，凡有端特征却未出现在 `entries/entries.json` 的 `entries[].source` 中即报 finding。
   本轮未做——登记规则会改动 `RULES-REGISTRY.json` 与门档强度，属独立一轮工作。
5. **`--dry-run` 曾被静默忽略**（2026-09-17 实测，已修 + 已加回归）：`router.js` 的
   `parseCommandArgs` 会把 `--flags` 从 `args` 里剥走、放进 `parsed.options`，
   而 handler 原先只解析 `args`，于是 `khy entry launch desktop --dry-run`
   的 dry-run **静默失效并真的去拉起了 Electron**。同一轮还修掉两个同源缺陷：
   detach 分支在 `spawn` 尚未成功时就 resolve（输出「已转入后台运行（PID undefined）」
   的假成功），以及 Windows 上 `spawn('npm')` 必 ENOENT（npm 是 `.cmd` 壳，
   Node 18.20/20.12+ 必须走 shell）。三条都有回归用例锁住，见 §八。
6. **handler 返回值没有映射到进程退出码**（2026-09-17 实测）：
   `router.js` 的自注册分支写的是 `return __auto.result`，
   而 `bin/khy.js` 只按 `result.errorType` 分流，不读这个数字。
   后果是**任何**自注册命令的「返回非 0」都到不了 shell，`khy entry probe`
   因此无法被 CI 用 `$?` 直接消费。这是**全仓自注册命令的共性缺口**，不是本模块独有，
   修它要动共用的退出码语义（影响 health / ci / deploy 等全部自注册命令），
   超出本文范围。本轮的应对是：文档如实标注 + 提供 `--json` 作为脚本消费路径。

---

## 八、验证方式

```bash
# 层级契约本身（改过 §1.2 或 CROSSCUTTING 后必跑——这条是 error 级）
npm run check:layout

# 端矩阵能加载、字段自洽（缺字段 / 重复 id / 未知 kind / 未知 status 都会报出来）
node -e "console.log(require('./services/backend/src/services/entrypoints').overview().errors)"

# 人看的全景（两条进入方式等价，第二条不要 Python）
node services/backend/bin/khy.js entry list
node entries/launch.js

# 产物盘点：exe / apk / html 在哪、产出来没有、怎么得到
node services/backend/bin/khy.js entry status
node entries/launch.js status

# 检活（人看）
node services/backend/bin/khy.js entry probe

# 检活（脚本消费）——注意：必须用 --json，不要依赖退出码，原因见 §七.6
node services/backend/bin/khy.js entry probe --json

# 不执行、只核对计划（两条入口方式都试一次）
node services/backend/bin/khy.js entry launch desktop --dry-run
node entries/launch.js desktop --dry-run

# 端矩阵的契约测试（21 条：数据自洽 / 无端口字面量 / 解析不崩 / 产物坐标 / 4 条实测回归）
node services/backend/node_modules/jest/bin/jest.js \
  --config services/backend/jest.config.js --rootDir services/backend \
  tests/entrypoints.test.js

# 仓库级守卫
npm run check:build-root
npm run check:agent-rules
```

`khy entry probe` 在**函数层**返回 0/1（有 `broken` 端时为 1），但**当前进程退出码恒为 0**
——CLI 分派层尚未消费 handler 返回值，详见 §七.6。因此脚本消费请走 `--json` 自行判定，
不要依赖退出码；这一条是本节最重要的注意事项，写在这里而不是藏在脚注里。
`degraded` 不阻断——降级是已知且已登记的现状，不是回归。

---

## 关联

- 层级落点与「放东西的决策流程」：`[DESIGN-LAY-005] 仓库层级板块规范` §1.2（`entries/` 的登记处）/ §2（允许边与禁止边）/ §6（决策流程）
- 规则如何从声明接到执行（本文 §七.4 的登记路径）：`[DESIGN-ARCH-111] 规则遵守保障机制`
- 操作选路（CH-2 服务直调 / CH-3 CLI）：`[DESIGN-ARCH-071] 通道选择决策矩阵`
- 生态应用接入（与本文分工不同，勿混）：`[DESIGN-ARCH-011] 应用接入标准`
- 不可卸载 vs 可卸载的判定：`[DESIGN-TOOL-002] 拓展契约与核心边界规范`
- 产物坐标真源：`docs/10_规范/registry/BUILD-OUTPUTS.json`、`[DESIGN-LAY-004] 构建产物单一根规范`
- 桌面端产物线定位：`[DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案`、`[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范`
- 网页端信息架构（页面级导航，非端级）：`[DESIGN-ARCH-080] 网页端信息架构与四页重设计`
