# DESIGN-ARCH-061 更新包学习：取其精华弃其糟粕（upstream archive study）

> **核心判断**：Khy 开发过程中参考了大量开源项目。这些项目更新时，把新版压缩包交给 Khyos，
> 应当能**只读、有界**地甄别其中的**精华**（源码 / CHANGELOG / 测试 / 理据文档）与**糟粕**
> （vendored 依赖 / 构建产物 / 压缩混淆 / 二进制 / lockfile / 密钥），产出一份**策展阅读清单**，
> 而**绝不自动整包合并**。自动合并在此场景是真危险的：许可证冲突、语义冲突、把糟粕一并引入。
> 因此本能力刻意止步于**忠告**——列清单、给下一步，由模型/人据此选择性移植。
>
> 本设计遵循 [DESIGN-ARCH-059]（能力即代码）与 [DESIGN-ARCH-013]（弱模型兼容）：把一个
> 「弱模型缺此能力时只会手动解压、cat 一堆随机文件 flail、极易走死循环」的缺口，收敛为**一个有界工具**。
>
> **扩充（goal 2026-07-06）**：除「取其精华弃其糟粕」外，还要点明——**哪些能改代码、哪些不能改**
> （移植安全性：许可证/法律文件与糟粕**绝不移植**），以及**哪些先改、哪些后改**（移植顺序：先读理解 →
> 先改接口/契约/配置 → 再改实现 → 最后改测试）。这两维仍是**纯逻辑忠告**，不改变「绝不自动合并」红线。

---

## 一、动机与非目标

### 动机
- **provenance 复用**：Khy 引用过的开源项目（DeepSeek-TUI、Hermes、OpenCode、Claude Code……）散记在
  `docs/07_OPS_运维/[OPS-MAN-016]`、`docs/08_MGMT_项目管理/[MGMT-RPT-009]`、`CC_ALIGNMENT_AUDIT.md`
  等**散文档**里，此前无任何机器可读的「更新包 → 该读什么」路径。
- **有界替代手动解压**：弱模型缺能力时即兴 `unzip` + 遍历 `cat`，无上限、无甄别、易失败。本工具零解压
  （无 zip-slip）、条目有上限、精华清单有 Top-N。
- **诚实止于忠告**：不自动改 Khy 源码。取舍留给掌握许可证/语义上下文的模型或人。

### 非目标
- **不自动合并**：绝不把上游代码 patch 进仓库。这是刻意红线，不是 v1 缺口。
- **不做语义 diff**：基线对比按「相对路径 + 大小」启发式判新增/改动/删除；同大小不同内容会漏判——诚实标注、
  不夸大为「内容级 diff」。
- **不解压**：只借 `archiveInspectService` 列 manifest；落盘解压另有 `unpackTool`，不在本能力内。

---

## 二、架构：四纯叶子 + 一服务 facade + 一工具壳

复用既有基础设施，不新建并行注册表：

| # | 组成 | 位置 | 纯叶子? | 门控 |
|---|---|---|---|---|
| 1 | 分类/打分/识别引擎 | `services/backend/src/services/upstreamStudyCatalog.js` | 是（零 IO） | `KHY_UPSTREAM_STUDY_CATALOG` |
| 2 | ASCII 报告渲染 | `services/backend/src/services/upstreamStudyReport.js` | 是（零 IO） | `KHY_UPSTREAM_STUDY_REPORT` |
| 3 | 移植计划决策（能改/不能改 + 先改/后改） | `services/backend/src/services/upstreamStudyPlan.js` | 是（零 IO） | `KHY_UPSTREAM_STUDY_PLAN` |
| 4 | 编排 facade（列举→分类→基线 diff→Top-N→移植计划→报告） | `services/backend/src/services/upstreamStudy/index.js` | 否（做 fs / 调 inspect） | —（受父门控） |
| 5 | 工具壳（自动发现 + 门关哑导出） | `services/backend/src/tools/UpstreamStudyTool/index.js` | 否 | `KHY_UPSTREAM_STUDY_TOOL` |

数值调优（`flagRegistry.resolveNumeric`）：`KHY_UPSTREAM_STUDY_TOP`（默认 25）、
`KHY_UPSTREAM_STUDY_MAX_FILE_KB`（默认 256，超此判「过大不宜直读」）、
`KHY_UPSTREAM_STUDY_BLOB_MB`（默认 5，超此的源码扩展名归 oversized 糟粕）。

> 只读复用：manifest 列举走 `archiveInspectService.inspectArchive`（零解压、zip-slip-free、条目上限
> `KHY_ARCHIVE_MAX_LIST_ENTRIES` 默认 2000）；基线遍历走有界栈式 walk（复用 `_walkBudget` 的 wall-clock
> 预算 + `MAX_BASELINE_ENTRIES` 上限，`lstat` 不跟 symlink），与 DiskAnalyze 同构。

---

## 三、取其精华弃其糟粕：分类决策

`classifyEntry(entry, env)` → `{verdict:'essence'|'dross'|'neutral', bucket, reason, tooLarge?}`。
**先判糟粕，再判精华**（node_modules 里的 `.js` 仍是 vendored，不因扩展名翻案）：

- **糟粕桶**：`os-junk`（.DS_Store/Thumbs.db）→ `secret`（.env/.pem/.key/id_rsa）→ `vendored`
  （node_modules/vendor/dist/build/target/__pycache__/.next/coverage）→ `lockfile`
  （package-lock.json/yarn.lock/Cargo.lock/go.sum）→ `minified`（.min.js/.bundle.js/.map）→
  `binary`（图像/音视频/字体/归档/.wasm/.node）→ `oversized`（源码扩展名但超 BLOB 阈值）。
- **精华桶**（`BUCKET_BASE` 打分权重）：`changelog`(100) > `source`(60) > `test`(50) > `doc`(40) > `config`(30)。

`scoreEssence(entry, diff, env)`：基础桶权重叠加 diff 信号——`+40` 改动、`+25` 新增、`−30` 过大、
`±5` 目录深度微调。清单按分降序、同分按路径排，切 Top-N。**门关任一 → 恒 neutral / 0 分**（逐字节回退）。

`recognizeProject(entries, archiveName, env)`：把 `KNOWN_REFERENCES`（deepseek-tui / hermes / opencode /
claude-code，各带 marker 与指向档）与包名+前 400 条路径比对，命中即点名并指向对应 provenance 文档。

---

## 三·补 移植计划：能改/不能改 + 先改/后改

纯叶子 `upstreamStudyPlan.js`（门控 `KHY_UPSTREAM_STUDY_PLAN`，parent=`KHY_UPSTREAM_STUDY_TOOL`）在精华/糟粕
之上再叠**两维决策**，只看已列到的 `{path, bucket}` 元数据，零 IO、绝不抛：

**① `portabilityOf(item, env)` → 能改/不能改**（移植安全性）：
- `forbidden`（**绝不移植**）：许可证/法律文件（`LICENSE`/`COPYING`/`NOTICE`/`AUTHORS`/`PATENTS`…——照搬会把
  上游许可与著作权引入 Khy），以及一切非精华桶（糟粕：vendored / 生成物 / 二进制 / 密钥 / lockfile）。
- `caution`（**谨慎，不能整段覆盖**）：`config`（构建/依赖清单，只手动核对差异）、`changelog`（读它理解改动，
  本身不是要搬进 Khy 的代码）。
- `safe`（**可择优移植**）：`source` / `test` / 一般 `doc`（仍须逐处核对，非整段搬运）。

**② `portWaveOf(item, env)` → 先改/后改**（移植顺序波次，单一真源 `WAVES` 冻结四波）：
- **0 先读·理解改动（不移植代码）**：`changelog` 桶，或名含 `migration`/`upgrade`/`breaking`/`readme` 的文档。
- **1 先改·接口/契约/配置（实现依赖它们）**：`config`、`.d.ts`、`.proto`/`.graphql`/`.thrift`/`.avsc`、
  或 basename 含 `types`/`schema`/`interface`/`api`/`dto`/`model`/`constants` 的源码。
- **2 再改·具体实现**：普通源码 / 其余一般文档。
- **3 最后·测试（移植完用它验证）**：`test` 桶。

`buildStudyPlan(items, env)` 把 Top-N 精华排成计划：能改的按波次分组（空波过滤）、不能改的进 `forbidden` 桶，
附 `note:「先后仅为建议顺序；能改/不能改仅为移植安全性提示——最终由你逐处核对，绝不整包合并。」`
**门关任一 → `portabilityOf` 返空档、`portWaveOf`/`buildStudyPlan` 返 null**（逐字节回退：facade 不产 `plan`
字段、精华项不带 `portability`/`wave`、报告不渲染「移植计划」段）。

> 诚实：这仍是**忠告层**——`forbidden` 是安全网（例如 `LICENSE.md` 被归成 doc 精华时仍拦下），但挡不住有人
> 无视它照抄；真正的移植取舍由掌握许可证/语义上下文的人或模型逐处核对。裸 `LICENSE`（无扩展名）在 catalog
> 早判 `neutral`、根本不入精华清单，故不会作为「可移植项」出现，无需再进 `forbidden`。

---

## 四、编排与诚实边界

`study(opts, deps)`（DI：`inspect` / `fsImpl` / `now` 全可注入，便于无依赖单测）：
1. 校验 archive → `inspect` 只读列举（失败即 `success:false` 诚实上报，绝不 throw）。
2. `_commonTopDir` 剥公共顶层目录（`Proj-main/`），使基线相对路径可比对。
3. 可选 `_walkBaseline` 把旧版目录读成 `Map(rel→size)`，逐条算 `isNew`/`isChanged`；上游没有的旧文件计入
   `removed`（≤200 条）。
4. 每条分类 → 糟粕桶计数 + 精华打分排序 Top-N → 渲染报告。

**全链 fail-soft**：任何异常都收敛为 `{success:false, error}`，不炸整次抓取。诚实取舍已在上文非目标列明：
不自动合并、不做内容级 diff、同大小不同内容会漏判。工具返回体固定附 `hint:「不要整包合并」`。

---

## 五、门控与回退

五门全 `default-on / off:'CANON'`，catalog/report/plan 均以 `KHY_UPSTREAM_STUDY_TOOL` 为 parent（父关 → 子恒关）。
`KHY_UPSTREAM_STUDY_TOOL=0` 时工具壳导出 benign 非工具对象，`tools/index.js` 自动发现整体跳过——
**工具不注册，等价于今日无此工具**（活验：gate-on 148 工具含 UpstreamStudy；gate-off 147 且消失）。

## 六、测试与守卫

- `upstreamStudyCatalog.test.js`（11）：精华/糟粕桶、糟粕优先、tooLarge、打分序、recognizeProject、阈值、常量冻结、门关透传、坏输入不抛。
- `upstreamStudyReport.test.js`（6）：盒式报告关键片段、确定性、门关 legacy 单行、空 diff/空精华、坏输入不抛、`_humanBytes` 边界。
- `upstreamStudyPlan.test.js`（15）：portability 三判（forbidden/caution/safe）、portWave 四波、buildStudyPlan 分组+forbidden+空波过滤、门关逐字节回退、坏输入不抛、`WAVES` 冻结。
- `upstreamStudy.test.js`（13）：DI 假 inspect + mock fs 基线，分类计数、识别、Top-N、diff 新增/改动/删除、门关全 neutral、plan 波次分组+精华项带 portability+报告含移植计划段、门关 PLAN 逐字节回退、inspect 失败/抛出、`_commonTopDir`/`_relOf`、工具只读、门关哑导出。
- `flagRegistry.test.js` 扩：7 新 flag 的 default-on / parent（含 `KHY_UPSTREAM_STUDY_PLAN`）/ numeric。
- 三守卫（node --check、leaf-contract、change-safety）+ flag-registry 净（三叶子无 leaf-io 告警）。
