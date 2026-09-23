---
name: 构建产物单一根
id: LAYOUT-005
domain: LAYOUT
nature: 约束为主，兼权力与福利
scope: "kernel/**, platform/**, services/**, apps/**, software/**, extensions/**, tools/**, docs/**, packaging/**, scripts/**（一切构建 / 测试 / 打包 / 代码生成产物的落盘路径；不含源码同名目录 packaging/build 与 scripts/release）"
priority: P1
trigger: 任何工具向磁盘写入可再生输出时；新增或移动产物目录时；修改 .gitignore / .dockerignore / clean.js 的产物清单时
constraint: 可再生构建产物的落盘路径必须位于仓库根 `entries/` 之下，形如 `entries/<producer>[/<variant>]`（深度 ≤ 2）；每条产物必须在 `docs/10_规范/registry/BUILD-OUTPUTS.json` 登记 `path` + `rebuild`（一条能把它变回来的命令）+ `inBuildAll: true`；`entries/` 之外不得存在未登记为 `migrating` / `parasitic` 的产物目录；无法重定向的寄生产物必须登记 `hook`（重建钩子）与 `sunset`（到期日），且寄生条目总数不得超过登记表 `meta.parasiticBudget`（只降不升）；`.gitignore` 与 `.dockerignore` 中的产物规则必须由登记表派生，不得手写第二份清单
grants: 授权任何人在不阅读任何构建配置的前提下，执行 `npm run clean:apply`，再执行 `build:all` 得到完整产物（登记表是唯一真源）；授权对 `entries/` 整树执行**无事前审批**的删除（其内容天然可再生）；授权维护者按 §8 三步流程调整 `parasiticBudget` 与 `sunset`
benefit: 找产物进一个目录、删产物删一个目录、CI 缓存一个 key；「产物在哪 / 删了怎么回来」不再需要跨 .gitignore + .dockerignore + clean.js + 各包构建配置四处拼装答案，把「定位 + 重建」的决策成本压到一次 `build:all`
exception: 见 §3 例外节——源码同名目录（`packaging/build`、`scripts/release`）、机器本地 vendored 检出（`tools/deepseek-eyes/**`）、工具强制且不可重定向的路径（`kernel/moonbit/_build`）三类；三类均须登记，不得裸豁免
version: "1.0.0 (2026-09-16) 初版；配套原型 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js 12 场景实测；1.0.1 (2026-09-18) 单一产物根由 _build/ 迁移至 entries/（§1.x 的历史实测快照仍记旧根名，属迁移前证据）"
status: draft
ssot: docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md
enforcement: scripts/ci/check-build-root.js
formerly: 无
owner: architecture-team
---

<!-- RULES-REGISTRY: LAYOUT-005 -->

# [DESIGN-LAY-004] 构建产物单一根规范

> **2026-09-18 更新**：单一产物根由 `_build/` 迁移至 `entries/`（与「多端入口矩阵」同址，见 `[DESIGN-ARCH-117]`）。§1.x 的实测快照为迁移前证据，仍记旧根名 `_build/`；正文规范（§3–§9）已统一到 `entries/`。

> **定位**：管「**产物放哪、删了怎么回来**」。`[DESIGN-LAY-002]` 的 LAY-4 已经说了「构建产物不得进入源码层」，但那句话只回答「别进 git」，没回答「该放哪」「删了能不能重建」「清单谁维护」。本文补这三个空白。
>
> **结论**：① 仓库只有一个产物根 `entries/`，`entries/` 之外的一切产物路径都必须在登记表里被显式解释（迁移中 / 寄生 / 源码同名）；② 产物的登记表是 `docs/10_规范/registry/BUILD-OUTPUTS.json` **一份真源**，`.gitignore`、`.dockerignore`、`scripts/maintenance/clean.js` 三处清单全部由它派生——现在这三份手写清单已经互相打架（§1.2 实测）；③ 「随时能删」不是一句承诺，而是一条可自动判定的不变量：`clean:apply` 后 `build:all` 必须能把登记表里每一条变回来。
>
> **守卫**：`scripts/ci/check-build-root.js`（`npm run check:build-root`）。本文的产物根名、登记表路径、深度上限在该脚本内以常量落地；改本文须同步改守卫。
>
> **与 LAY-4 的关系**：不新增重复红线。LAY-4 的守卫 `check-build-artifacts` 在 §1.3 被实测证明有 scope 盲区（绿着放行 10 个已跟踪产物），本规范把该维度的判据从「路径白名单」换成「登记表驱动」，并把 scope 从 `apps/khy-mobile/android/` 扩到全仓。

---

## 0. 一句话

**把「散落在六个层级、三份手写清单互相打架、守卫绿着放行」的产物现状，收敛成「一个根目录 + 一份登记表 + 一条重建命令」。**

---

## 1. 现状证据（2026-09-16 实测，命令见 §11）

### 1.1 产物散落在 6 个层级、24 个目录

扫描口径：目录名 ∈ {`dist` `build` `out` `release` `coverage` `.cache` `.nyc_output` `dist-electron` `tmp-cov` `.dart_tool` `publish` `*.egg-info`} ∪ 登记在册的寄生产物路径，跳过 `node_modules` / `.git` / `.research-tmp` / 机器本地状态目录。

```
$ node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --scan
── 真实仓库扫描（发现 24 个产物候选目录）
```

| 所在层 | 产物目录（节选） |
|---|---|
| 仓库根 | `dist/` `build/` `dist-electron/` `coverage/` `.cache/` `.nyc_output/` `tmp-cov/` `khy_os.egg-info/` `publish/` |
| `apps/` | `ai-frontend/{dist,coverage}` · `khy-mobile/{dist,release,android/build}` · `khy-os-client-app/{build,release,android/build}` · `khyos-desktop/{dist,dist-electron,out}` · `provider-hub/dist` |
| `services/` | `backend/dist` |
| `software/` | `khyquant/frontend/coverage` |
| `kernel/` | `moonbit/_build` |
| `tools/` | `deepseek-eyes/deepseek_eyes.egg-info` |
| `docs/` `extensions/` | `19_资产/site/mermaid.min.js` · `tools/khy-markdown/vendor` · `tools/khy-dsh-compat/vendor` · `ai-frontend/public/vendor` |

**同一件事有 11 个不同的目录名**（`dist` / `build` / `out` / `release` / `coverage` / `.cache` / `.nyc_output` / `dist-electron` / `tmp-cov` / `.dart_tool` / `*.egg-info`）。要找「上次构建的 APK 在哪」，得先知道是 Flutter 还是 Gradle 还是 Capacitor 写的——这正是「不方便查找」的机械成因。

### 1.2 三份手写清单互不同步（三条硬证据，均可复现）

**证据 A —— `clean.js` 登记表与磁盘脱节 17 条**

```
$ node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --audit-clean
  声明条目：17 条
  磁盘产物候选：24 个
  其中被登记覆盖：7 个
  登记管不到的：17 个
  Summary: 17 gap(s).（「随时能删」的判据：gap 必须为 0）
```

`npm run clean:apply` 会删掉 `apps/khy-mobile/android/app/build`，却**不知道** `apps/khy-mobile/android/build` 也是产物；它没有 `apps/khy-mobile/release`（465 MB）、`apps/khy-os-client-app/release`（58 MB）、`services/backend/dist`（38 MB）、`apps/khyos-desktop/{dist,out}`、`apps/provider-hub/dist`、`software/khyquant/frontend/coverage`、`khy_os.egg-info`。

> 这不是笔误——`clean.js` 的注释自己写了「清理脚本最容易出的事故不是『少删了』而是『多删了』」，于是选了手写白名单。方向对，但**白名单没有任何机制保证与磁盘同步**，于是必然漂移。本规范不推翻白名单，而是给它一份**可自动校验的真源**。

**证据 B —— `.gitignore` 与 `clean.js` 指向不同路径**

| 清单 | 路径 | 磁盘实况 |
|---|---|---|
| `.gitignore:154` | `docs/_assets/mermaid.min.js` | **不存在**（目录已改名 `docs/19_资产/`） |
| `clean.js:141` | `docs/19_资产/site/mermaid.min.js` | **存在，3.2 MB** |

后果是活的：`docs/19_资产/site/mermaid.min.js` 既未被忽略、也未被跟踪——

```
$ git check-ignore -v docs/19_资产/site/mermaid.min.js   → exit 1（未被忽略）
$ git -c core.quotepath=false status --porcelain --untracked-files=all -- 'docs/19_资产/'
?? docs/19_资产/site/dead-links.json
?? docs/19_资产/site/docs-site.css
?? docs/19_资产/site/docs-site.js
?? docs/19_资产/site/hljs-github-dark.min.css
?? docs/19_资产/site/mermaid.min.js
?? docs/19_资产/site/nav-data.js
```

一次 `git add -A` 就能把 3.2 MB 的 esbuild 产物钉进 git 历史——而 `.gitignore` 第 151–154 行那段解释文字还在描述一个**已经不存在的路径**。

**证据 D —— 同一次改名把 232 个已提交 `.html` 的资源引用一起打歪**

`docs/_assets/` → `docs/19_资产/` 这次改名，除了 `.gitignore`，还让**仓库里 232 个已提交的文档页**指向了不存在的目录：

```
$ git diff -- 'docs/02_CONCEPTS_概念入门/CONCEPT/[CONCEPT-01] 什么是Agent-智能体.html'
-<link rel="stylesheet" href="../../docs/_assets/hljs-github-dark.min.css">
-<link rel="stylesheet" href="../../docs/_assets/docs-site.css">
+<link rel="stylesheet" href="../../19_资产/site/hljs-github-dark.min.css">
+<link rel="stylesheet" href="../../19_资产/site/docs-site.css">
-<script src="../../docs/_assets/nav-data.js"></script>
-<script src="../../docs/_assets/mermaid.min.js"></script>
+<script src="../../19_资产/site/nav-data.js"></script>
+<script src="../../19_资产/site/mermaid.min.js"></script>
```

跑一次 `node scripts/docs/build_docs_site.js` 就修好了全部 232 个（`docs:verify` 由「引用不可达」转为「✅ 全部通过」）。**同一次改名，三处引用（`.gitignore` / `clean.js` / 232 个 html）漂移了三种不同的方式**——这不是三个人同时手滑，这是「路径清单靠人手写」这个机制本身的失效。本规范把产物路径收敛成一份登记表，正是为了消掉这个机制。

**证据 C —— `.gitignore` 漏覆盖 5 个产物目录**

```
$ node -e "…git check-ignore -q 每个产物目录…"
产物候选: 19  被 .gitignore 覆盖: 14  未覆盖: 5
  [NOT-IGNORED] apps/khy-mobile/release
  [NOT-IGNORED] apps/khy-os-client-app/release
  [NOT-IGNORED] apps/khyos-desktop/out
  [NOT-IGNORED] apps/khyos-desktop/zcode-analysis/unpacked/out
  [NOT-IGNORED] kernel/moonbit/_build
```

`.gitignore` 里有 37 行与产物相关，仍漏了 5 个目录；`.dockerignore` 另有**第三份**独立手写的 `dist` / `build` / `*.egg-info` 规则。三份清单，三个真源，零同步机制。

### 1.3 守卫的盲区：绿着放行 10 个已跟踪产物

```
$ node scripts/ci/check-build-artifacts.js
✓ check-build-artifacts 通过(已跟踪 8752 条，无可再生产物)
exit=0

$ git ls-files 'apps/khyos-desktop/out' 'kernel/moonbit/_build' | wc -l
10
```

`apps/khyos-desktop/out/` 下的 9 个文件（`main/index.js`、`preload/index.mjs`、`renderer/assets/*.css|*.js`、两张 `icon.ico`…）与 `kernel/moonbit/_build/.moon-lock` **已被 git 跟踪**，工作树里正处于 `M` / `D` 状态。守卫报绿，因为 `scripts/lib/buildArtifactGuard.js` 的 `RULES[0].scopes` 只有一条：

```js
scopes: ['apps/khy-mobile/android/'],
```

这正是该文件头部注释警告过的那类事故——「二进制一旦进了 git 历史，`git rm` 也删不掉体积」——只是它守着的那扇门旁边还有十扇。

### 1.4 结论：「随时能删」现在是假的

三条判据，当前全部不成立：

| 判据 | 要求 | 实测 |
|---|---|---|
| **可删** | `clean:apply` 覆盖全部产物 | ❌ 漏 17 条 |
| **可回** | 每条产物有登记的重建命令 | ❌ 17 条漏项中 12 条无登记重建命令 |
| **不越界** | 产物只在 `entries/` 下 | ❌ 产物根不存在，24 个目录散落 6 层 |

---

## 2. 设计公理（4 条，不可让渡）

1. **一份真源优于三份同步**。`.gitignore` / `.dockerignore` / `clean.js` 的产物清单**必须派生自同一份登记表**。手写三份然后靠人记得同步，是已被证据 A/B/C 证伪的做法。
2. **可删除性 = 可重建性**。没有 `rebuild` 命令的产物**不允许登记**——写不出「怎么把它变回来」的东西，删掉就是永久损失，那就不是产物。
3. **默认单一根，例外必须登记且只减不增**。工具强制路径（Flutter/Gradle/MoonBit 的 `build`、必须被 Vite 服务的 `public/vendor`）无法重定向，承认它；但承认的代价是登记 `hook` + `sunset` + 全局预算，且预算只降不升。
4. **证据优于承诺**。判定只看磁盘与登记表的客观差异，不读任何「我已迁移」的声明（与 `[DESIGN-ARCH-113]` 公理 1 同源）。

---

## 3. 规则正文

### 约束

1. **唯一产物根**。一切可再生构建 / 测试 / 打包 / 代码生成产物的落盘路径必须位于仓库根 `entries/` 之下，形如 `entries/<producer>[/<variant>]`，**深度 ≤ 2**。
2. **登记即准入**。每条产物必须在 `docs/10_规范/registry/BUILD-OUTPUTS.json` 登记 `id` + `path` + `rebuild` + `inBuildAll: true`。缺 `rebuild` 即不允许登记（公理 2）。
3. **零越界**。`entries/` 之外不得存在产物目录，除非该路径在登记表中被标为 `status: migrating`（附 `sunset`）或 `parasitic: true`（附 `hook` + `sunset`）。
4. **寄生棘轮**。`parasitic: true` 的条目总数不得超过 `meta.parasiticBudget`，**该预算只降不升**；每条寄生必须有 `hook`（哪个钩子重建它）与 `sunset`（到期日），过期未续期即 error。
5. **一键重建**。存在唯一入口 `build:all`，其语义为「逐条执行登记表的 `rebuild`，任一失败即非零退出」。登记表中 `inBuildAll: true` 的每一条都必须被它覆盖。
6. **清单派生**。`.gitignore` 与 `.dockerignore` 中的产物规则必须由登记表派生（`build:root:sync` 生成），不得手写第二份。

### 授予权力

- **授权无审批删除**：任何人对 `entries/` 整树执行删除**无需事前审批**——其内容按定义可再生（约束 2 保证）。
- **授权无配置重建**：任何人在不阅读任何包构建配置的前提下，执行 `npm run clean:apply`，再执行 `build:all` 得到完整产物；登记表是唯一真源。
- **授权维护者调整预算**：维护者有权按 §8 三步流程修订 `parasiticBudget` 与 `sunset`。

> 权力的边界（§3.3 配对铁律）：`entries/` 之外的任何删除**不在**本授权范围内，仍受 `[DESIGN-ARCH-113]` DELETE 模态与 `check-change-safety.js` 管辖；`clean:apply` 仍保留 `clean.js` 的 `PROTECTED_SUBTREE` / `PROTECTED_EXACT` 两道校验。

### 提供福利

- **一个目录找产物**：`entries/<producer>/`，不必先知道产它的是 Vite 还是 Gradle。
- **一个 cache key**：CI 只需缓存 `entries/`。
- **一条命令回滚**：`build:all`。
- **一处改动同步三份清单**：改 `BUILD-OUTPUTS.json` 后跑 `build:root:sync`，`.gitignore` / `.dockerignore` / `clean.js` 一起更新。

### 反例

| # | 违反的样子 | 正确写法 |
|---|---|---|
| 1 | `vite.config.js` 保持默认 `dist/`，产物落 `apps/ai-frontend/dist` | `build.outDir: '../../entries/ai-frontend'` |
| 2 | 新工具吐到 `apps/newapp/out/`，谁也没登记 | 先登记 `entries/newapp`，再改工具输出路径 |
| 3 | 登记项写 `rebuild: 'TBD'` | 写不出重建命令 → 不许登记，先想清楚它是不是产物 |
| 4 | 用 `parasitic: true` 逃避迁移，且不写 `sunset` | 寄生必须有钩子 + 到期日，且全局预算只降不升 |
| 5 | 往 `.gitignore` 手加一行 `apps/x/dist/` | 改 `BUILD-OUTPUTS.json` 后 `build:root:sync` |
| 6 | `entries/a/b/c/d` 四层嵌套 | 深度 ≤ 2：`entries/a` 或 `entries/a/b` |

### 校验方式

| 维度 | 守卫 | 命令 |
|---|---|---|
| 落点越界 / 未登记 / 深度 / 寄生过期 | `scripts/ci/check-build-root.js` | `npm run check:build-root` |
| 登记表自身完整性（缺 rebuild / 未纳入 build:all / 预算超限） | 同上（`inspectRegistry`） | 同上 |
| 产物被 git 跟踪 | `check-build-artifacts.js`（scope 需扩到登记表驱动） | `npm run check:build-artifacts` |
| 端到端可删除性回环 | CI 作业 `build-root-roundtrip` | `clean:apply && build:all && check:build-root --after-build` |
| 三份清单同步 | `build:root:sync` 的脏 diff 判断 | `build:root:sync --check` |

### 例外

| 类别 | 实例 | 处置 |
|---|---|---|
| **源码同名目录** | `packaging/build/`（CI 构建脚本，`.gitignore` 专门 `!` 放行）、`scripts/release/`、`services/backend/src/services/publish/`、`kernel/vendor/` | 非产物，**不入登记表**，由守卫的 `SOURCE_DIR_ALLOWLIST` 显式排除（防止规则误杀源码） |
| **机器本地 vendored 检出** | `tools/deepseek-eyes/**`（`.gitignore` 明文「stays entirely out of git」） | 登记为 `parasitic`，`hook: 'pip install -e'`，`sunset` 为空表示永久（机器本地，不参与 CI） |
| **工具强制且不可重定向** | `kernel/moonbit/_build`（`moon build` 写死）、`apps/ai-frontend/public/vendor`（必须被 Vite 服务）、`extensions/tools/*/vendor`（必须在包内被 `prepack` 打包）、`docs/19_资产/site/mermaid.min.js`（必须被文档站引用） | 登记为 `parasitic`，写 `hook` + `sunset`，计入预算 |
| **尚未迁移的存量** | 见 §9 映射表的 `status: migrating` 行 | 允许存在，报 warning，`sunset` 到期转 error |

### 版本记录

- **1.0.0 (2026-09-16)** 初版。规则 `LAYOUT-005`；配套原型 `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js`（零依赖、确定性、只读，12 场景反例矩阵实测）。

---

## 4. 产物根布局

```
entries/                         ← 仓库唯一可整树删除的产物根（与多端入口索引同址）
├── entries.json                 ← 【提交】端矩阵真源（不是产物）
├── launch.js                    ← 【提交】跨平台入口壳（不是产物）
├── README.md / README.html      ← 【提交】人读端地图（不是产物）
├── ai-frontend/                 ← apps/ai-frontend 的 Vite 产物
├── khyquant-frontend/           ← software/khyquant/frontend 的 Vite 产物
├── provider-hub/
├── backend/                     ← services/backend 的 esbuild 模块 bundle
├── flutter-android/             ← apps/khy-os-client-app 的 Flutter + Gradle 产物
├── khy-mobile/                  ← apps/khy-mobile 的 Capacitor + Gradle 产物
├── electron/                    ← electron-builder 输出（含 apps/khyos-desktop/out）
├── pip/                         ← sdist / wheel / *.egg-info
├── coverage/                    ← 全部覆盖率报告（root / backend / ai-frontend / khyquant）
├── cache/                       ← 治理脚本分析缓存
└── tmp-cov/                     ← quality-gate 覆盖率临时工作区
```

**为什么产物根落在 `entries/`（2026-09-18 迁移，原为 `_build/`）**：

1. **与「多端入口矩阵」同址**。`entries/` 本就是 `[DESIGN-ARCH-117]` 登记的端矩阵真源目录——`khy entry status` 就是「读登记表换出人话」。把产物根也放这里，「这个端怎么起、产物在哪、在不在」三件事落在同一个目录，人打开一处即可看全四端，不必在 `_build/`（产物）与 `entries/`（索引）之间来回跳。
2. **靠 `.gitignore` 的「默认忽略 + 真源白名单」区分两类内容**。`entries/` 下除 `entries.json` / `launch.js` / `README.*` 显式 `!` 放行外，其余一律不入库（`entries/*`），因此未来任何新增产物子目录自动被忽略，无需再改忽略清单。
3. **诚实记录代价**：产物根的目录名不再是罕见的 `_build`，而是常见的 `entries`——守卫的走盘（`check-build-root.js`）把**顶层** `entries` 目录本身识别为根并**停止递归**，故其内部产物子目录不做逐个磁盘审计，改由「登记表 ↔ path」判定兜底；同时产物与提交的索引文件位于同一层，靠上述白名单隔离。此权衡经用户明确确认（选项 A）。

> 注：`_` 前缀「非源码」的旧约定（`[DESIGN-LAY-002]` §3）已不适用于根名，但 `kernel/moonbit/_build` 等**工具强制**的 `_build` 子路径仍按原样作为 `parasitic` 登记，与产物根无关。

---

## 5. 登记表：一份真源，三处派生

`docs/10_规范/registry/BUILD-OUTPUTS.json`（与 `RULES-REGISTRY.json` / `FEATURE-OWNERSHIP.json` 同址，符合 `[DESIGN-LAY-002]` 对 `docs/10_规范/` 的定位）：

```json
{
  "meta": { "root": "entries", "version": "1.0.0", "parasiticBudget": 5 },
  "outputs": [
    {
      "id": "ai-frontend",
      "path": "entries/ai-frontend",
      "group": "build",
      "producer": "apps/ai-frontend/vite.config.js → build.outDir",
      "rebuild": "npm run build --prefix apps/ai-frontend",
      "inBuildAll": true,
      "status": "active",
      "legacyPath": "apps/ai-frontend/dist",
      "sunset": "2026-10-31"
    },
    {
      "id": "moonbit",
      "path": "kernel/moonbit/_build",
      "rebuild": "moon build",
      "parasitic": true,
      "hook": "moon build（工具强制路径，不可重定向）",
      "sunset": "2027-06-30"
    }
  ]
}
```

派生关系：

```
BUILD-OUTPUTS.json  ──┬─→ .gitignore        产物段（build:root:sync 生成）
                      ├─→ .dockerignore     产物段（同上）
                      └─→ clean.js TARGETS  清理登记表（同上）
```

> **`--check` 模式**：`build:root:sync --check` 只比对不写入，脏即非零退出。这样「三份清单不同步」从「靠人记得」变成「守卫会红」——与 `[DESIGN-ARCH-111]` 的「规则→门档从登记表派生」同一手法。

---

## 6. 强度梯度

**过早阻断会逼 AI 撒谎**（`[DESIGN-ARCH-113]` 的教训），所以分三档：

| 时机 | 强度 | 内容 |
|---|---|---|
| **事前** | advisory | `npm run rules:apply -- <path>` 提示「这个输出应落 `entries/`」 |
| **事中（pr）** | warning | `outside-root` / `unregistered` / `depth-exceeded` / `parasitic-no-sunset` / `legacy-path` |
| **事末（release）** | error | 登记表缺 `rebuild` / 未纳入 `build:all` / 寄生过期 / 预算超限 / 已跟踪产物 |

三条**立即 error**（不等迁移完成，因为它们是既成事故而非迁移债）：

1. 产物**已被 git 跟踪**（§1.3 的 10 个文件属此列）——由 `check-build-artifacts` 在 scope 扩到登记表驱动后报出；
2. 登记表缺 `rebuild`——不可重建的产物不允许进入产物根（由 `check-build-root` 报出）；
3. 寄生条目**已过期**（`sunset < today`）——由 `check-build-root` 报出。

---

## 7. 与既有机制的边界

| 既有件 | 它管什么 | 本规范做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-LAY-002]` LAY-4 | 「产物不得进入源码层」（**别进 git**） | 补「放哪」「删了怎么回来」「清单谁维护」 | 不重复 LAY-4；把它的守卫从路径白名单换成登记表驱动 |
| `check-build-artifacts.js` + `buildArtifactGuard.js` | 产物**已被跟踪**的判定（纯叶子，形态优秀） | 复用其 finding 形态与「不接受 AI 自称」的取向 | 不重写判定层；只把 `RULES[0].scopes` 从 `apps/khy-mobile/android/` 换成「登记表里 `entries/` 之外的路径」 |
| `scripts/maintenance/clean.js` | 「删」——手写白名单 + `PROTECTED` 双保险 | `TARGETS` 由登记表**派生** | 不推翻白名单思路；`PROTECTED_SUBTREE` / `PROTECTED_EXACT` 原样保留 |
| `.gitignore` / `.dockerignore` | 忽略规则 | 产物段由登记表派生 | 非产物段（依赖、IDE、密钥）不动 |
| `check-repo-layout.js` 的 `GENERATED_TOP_LEVEL_DIRS` | **根级** 4 个生成目录名 | **任意层级**的产物落点 | 不碰 `layer-registry`；产物根迁移为 `entries/` 后，它已是 `[DESIGN-LAY-005]` 登记的 CROSSCUTTING 源码层，不再是「生成目录」，无需在 §1.4 登记 |
| `check-runtime-placement.js` | 发布 staging 的**卫生**（sourcemap 泄漏、`.db` 泄漏） | 产物的**位置** | 不重叠：一个管「发出去干不干净」，一个管「留在哪」 |
| `[DESIGN-LAY-005]` §1.3 / §1.4 | 「有这些生成目录」「有这些根级例外」 | 「它们在哪、怎么重建、谁登记」 | 068 是**声明**，本文是**可执行约束**；`entries/` 已是 068 登记的源码层，2026-09-18 迁移后无需新增 §1.4 生成目录条目 |
| `REPO-SIZE-MANAGEMENT-PLAN`（`docs/11_报告/`） | 体积诊断与清理方案（产出即冻结的报告） | 把它的结论落成**规则 + 守卫** | 不重开体积调研；复用其「白名单而非 glob」的结论 |

**SOURCING-005 四步检索结论**（记录的是 1.0.0 初版当时的检索，彼时根名为 `_build/`）：全库检索「单一产物根 / 产物根 / BUILD_ROOT / `_build/` 作为根」→ 命中 0 处既有机制（`_build/` 仅在 `kernel/moonbit/` 与 `[DESIGN-LAY-002]` §2 的存量列举中出现）；检索「三份清单同步 / 登记表派生 gitignore」→ 0 命中。本方案不重复既有实现。

---

## 8. B-L2 三步接线清单（依 SOURCING-006，一次提交只做一步）

### 步骤 1「标记」——只登记、只 advisory，恒 exit 0　✅ 本次已落地

| # | 动作 | 产物 |
|---|---|---|
| 1 | 新增纯叶子判定层 | `scripts/lib/buildRootGuard.js` |
| 2 | 新增 CLI（**advisory，恒 exit 0**） | `scripts/ci/check-build-root.js` |
| 3 | 新增登记表（登记现状 31 条，含 23 条 `migrating` + 6 条 `parasitic`） | `docs/10_规范/registry/BUILD-OUTPUTS.json` |
| 4 | `package.json` 加别名（**必须**——`check-wiring.js` 把零接线的 `scripts/ci/*` 判 **error**） | `check:build-root` / `check:build-root:strict` / `check:build-root:clean-audit` |
| 5 | `RULES-REGISTRY.json` 补 `LAYOUT-005`（三元字段齐备，`grants` 与 `constraint` 边界配对） | 登记表 `LAYOUT-005` |
| 6 | `ssot` 首个目标带 `<!-- RULES-REGISTRY: LAYOUT-005 -->` 标记行（双向可达） | 本文第 3 行 |
| 7 | 生成规则卡 | `npm run docs:rules-cards` → `docs/10_规范/规则卡/[LAYOUT-005] 构建产物单一根.md` |
| 8 | 回写两处索引 + 生成 `.html` 孪生件 | `docs/10_规范/00_INDEX_规范-总目录.md`、`docs/00_INDEX_文档索引.md`、`docs/10_规范/[DESIGN-LAY-004] ….html` |

**验收**（本次实测，全绿）：

```bash
node scripts/ci/check-wiring.js           # 无新增 error（2 条既有 error 属 LAYOUT-004 的历史债，与本次无关）
node scripts/ci/check-gov-rules.js        # ✅ 治理规则检查通过
node scripts/ci/check-rules-registry.js   # ✅ 登记体系检查通过
npm run rules:coverage                    # ✅ check-build-root.js 已计入覆盖
node scripts/docs/verify_docs_site.js     # ✅ 全部通过（981 md / 982 html）
node scripts/ci/check-repo-layout.js --list=<每个 id>   # 逐条确认未命中本次新增文件
```

> `check:build-root` 在步骤 1 报 `1 error + 14 warning` 是**预期形状**（见 §10.1）：步骤 1 的产出是把「未知」变成「已知」，不是把红变绿。真正变绿在步骤 2/3。

### 步骤 2「迁移」——物理迁移，gate 升 `pr`，只报 warning

1. 先做 §1.3 的三条**立即 error**（`git rm --cached` 那 10 个文件 + 补 `.gitignore` 的 5 条漏项）；
2. 按 §9 映射表逐工具改输出路径（Vite → `build.outDir`，electron-builder → `directories.output`，setuptools → `--outdir`，jest → `coverageDirectory`，esbuild 脚本 → 参数）；
3. 新增 `build:all` + `build:root:sync` 两个入口（`package.json` 脚本名同此），并在**同一次提交**里把本文的裸脚本名写法改回完整命令形式；
4. 把 `clean.js` 的 `TARGETS` 换成从登记表派生；
5. gate 从 advisory 升 `pr`（warning，不拦）。

> **为什么本文现在写裸脚本名而不是 `npm run …`**：`check:layout` 的 `dangling-task` 会用
> `git grep -o -E 'npm run [a-zA-Z0-9:_-]+'` 扫**已跟踪内容**，把每个 `npm run <目标>` 拿去和
> 全部 `package.json` 的 `scripts` 对账；对不上就是 dangling。`build:all` 与 `build:root:sync`
> 是步骤 2 才创建的入口，所以步骤 1 的文档刻意只写脚本名 —— 这样步骤 1 单独提交时
> `check:layout` 是干净的。**这是本仓一个已知的隐性陷阱**：该规则走 `git grep`，新文件在
> `git add` 之前不被扫描，所以「本地跑绿了」不等于「提交后还绿」——写文档时必须手动自查
> 每个 `npm run` 目标。（同源教训见 `[DESIGN-ARCH-113]` 的接线清单。）

### 步骤 3「收口」——gate 升 error，棘轮收紧

1. `outside-root` / `unregistered` 升 error；
2. `meta.parasiticBudget` 收紧到实际值，`sunset` 到期项清理；
3. 新增 CI 作业 `build-root-roundtrip`（`clean:apply && build:all && check:build-root --after-build`）；
4. 回写 `[DESIGN-LAY-005]` §1.4 登记 `entries/`。

> ⚠️ 三步**都不需要**改 `qualityGateStages.js`，也**不需要**改 `package.json` 的 `&&` 链——门成员资格从登记表派生（`[DESIGN-ARCH-111]`）。

---

## 9. 迁移映射表（存量 24 条 → 目标）

| 现路径 | 目标 | 产者 | 重建命令 | 可重定向 | 备注 |
|---|---|---|---|---|---|
| `apps/ai-frontend/dist` | `entries/ai-frontend` | Vite | `npm run build --prefix apps/ai-frontend` | ✅ `build.outDir` | |
| `apps/ai-frontend/coverage` | `entries/coverage/ai-frontend` | Vitest | `… --coverage` | ✅ `reportsDirectory` | |
| `software/khyquant/frontend/coverage` | `entries/coverage/khyquant` | Vitest | 同上 | ✅ | |
| `apps/provider-hub/dist` | `entries/provider-hub` | Vite | `npm run build --prefix apps/provider-hub` | ✅ | |
| `apps/khy-mobile/dist` | `entries/khy-mobile` | Vite | `npx cap sync` 链路 | ✅ | |
| `apps/khy-mobile/release` | `entries/khy-mobile` | Gradle | `gradlew assembleRelease` | ⚠️ junction | |
| `apps/khy-mobile/android/build` | 同上 | Gradle | 同上 | ⚠️ | `clean.js` **漏登记** |
| `apps/khy-mobile/android/capacitor-cordova-android-plugins/build` | 同上 | Gradle | 同上 | ⚠️ | `clean.js` **漏登记** |
| `apps/khy-os-client-app/{build,release}` | `entries/flutter-android` | Flutter | `flutter build apk` | ⚠️ junction | 2.9 GB 级 |
| `apps/khy-os-client-app/android/build` | 同上 | Gradle | 同上 | ⚠️ | |
| `apps/khyos-desktop/{dist,dist-electron,out}` | `entries/electron` | electron-builder | `electron-builder` | ✅ `directories.output` | **`out/` 已被跟踪** |
| `apps/khyos-desktop/zcode-analysis/unpacked/out` | `entries/electron/zcode-analysis` | 分析工具 | 待核实 | 待核实 | `clean.js` 漏登记 |
| `dist/` `build/` `khy_os.egg-info` | `entries/pip` | setuptools | `python -m build --outdir entries/pip` | ✅ | `check:pip-packaging --dist-dir` 需同步 |
| `coverage/` `.nyc_output/` | `entries/coverage/root` | jest / c8 | `npm run cover-unit` | ✅ | |
| `.cache/` | `entries/cache` | 治理脚本 | 下次运行自动重建 | ✅ | |
| `tmp-cov/` | `entries/tmp-cov` | quality-gate | `npm run quality:gate` | ✅ | |
| `services/backend/dist` | `entries/backend` | esbuild | `node packaging/build/esbuild-modules.js` | ✅ 脚本参数 | `clean.js` 漏登记 |
| `kernel/moonbit/_build` | — | MoonBit | `moon build` | ❌ | **寄生**，工具写死 |
| `apps/ai-frontend/public/vendor` | — | esbuild | `sync-md-vendor.mjs` | ❌ | **寄生**，须被 Vite 服务 |
| `extensions/tools/khy-markdown/vendor` | — | esbuild | `ensure-vendor.mjs` | ❌ | **寄生**，须在包内 |
| `extensions/tools/khy-dsh-compat/vendor` | — | esbuild | 拓展 prepack | ❌ | **寄生** |
| `docs/19_资产/site/mermaid.min.js` | — | esbuild | `npm run docs:mermaid` | ❌ | **寄生**，须被文档站引用 |
| `tools/deepseek-eyes/deepseek_eyes.egg-info` | — | pip | `pip install -e` | ❌ | **寄生**，机器本地 |

**计数**：正式迁移 17 条，寄生 6 条 → `meta.parasiticBudget` 初值 6，收口目标 4（`docs/19_资产/site/mermaid.min.js` 与 `extensions/tools/khy-dsh-compat/vendor` 应可随文档站/拓展重构并入产物根）。

---

## 10. 验证与反例矩阵（原型实测输出）

```
$ node --check docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js            → syntax OK
$ node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --all

── clean（应放行）                             Summary: 0 error(s), 0 warning(s).
── scatter-new（新增散落产物）                 Summary: 2 error(s), 0 warning(s).
── unregistered（产物根下未登记）              Summary: 0 error(s), 1 warning(s).
── depth-exceeded（产物根下嵌套过深）          Summary: 0 error(s), 1 warning(s).
── parasitic-expired（寄生豁免过期）           Summary: 2 error(s), 0 warning(s).
── parasitic-no-hook（寄生条目缺重建钩子）     Summary: 1 error(s), 0 warning(s).
── legacy-not-removed（声明迁完但旧路径仍在）  Summary: 1 error(s), 1 warning(s).
── legacy-migrating（迁移中，应只告警）        Summary: 0 error(s), 1 warning(s).
── registry-missing-rebuild（登记表缺重建命令） Summary: 1 error(s), 0 warning(s).
── registry-not-in-build-all（未纳入一键重建） Summary: 1 error(s), 0 warning(s).
── registry-entry-outside-root（登记条目越界） Summary: 1 error(s), 0 warning(s).
── parasitic-budget（寄生条目超出预算）        Summary: 1 error(s), 0 warning(s).
```

| 项 | 方式 | 结果 |
|---|---|---|
| 判定确定性 | 纯函数，同输入同输出 | ✅ 12 场景可复现 |
| **不误伤** | `clean` 场景（全部合规） | ✅ **0 error / 0 warning**——证明不是无脑拦 |
| 源码同名目录不误杀 | `SOURCE_DIR_ALLOWLIST` 含 `packaging/build`、`scripts/release` | ✅ 真实扫描中这两条未报 finding |
| 反例逐条命中 | 见 §3 反例表，每条对应一个场景 | ✅ 全部命中 |
| 零外部依赖 | 只 require `fs` / `path` | ✅ |
| 离线可跑 | 不联网、不调模型 | ✅ |
| 语法自检 | `node --check` | ✅ syntax OK |

### 10.1 真实仓库扫描

**步骤 0 基线**（登记表尚未建立时，`--scan`）：

```
$ node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --scan
── 真实仓库扫描（24 个产物候选目录）
  [ERROR] outside-root            apps/ai-frontend/coverage
  [ERROR] outside-root            apps/khy-mobile/android/build
  [ERROR] outside-root            apps/khy-mobile/android/capacitor-cordova-android-plugins/build
  [ERROR] outside-root            apps/khy-mobile/dist
  [ERROR] outside-root            apps/khy-mobile/release
  [ERROR] outside-root            apps/khy-os-client-app/android/build
  [ERROR] outside-root            apps/khy-os-client-app/release
  [ERROR] outside-root            apps/khyos-desktop/dist
  [ERROR] outside-root            apps/khyos-desktop/out
  [ERROR] outside-root            apps/khyos-desktop/zcode-analysis/unpacked/out
  [ERROR] outside-root            apps/provider-hub/dist
  [ERROR] parasitic-unregistered  kernel/moonbit/_build
  [ERROR] outside-root            khy_os.egg-info
  [ERROR] outside-root            services/backend/dist
  [ERROR] outside-root            software/khyquant/frontend/coverage
  [ERROR] parasitic-unregistered  tools/deepseek-eyes/deepseek_eyes.egg-info
  Summary: 16 error(s), 0 warning(s).
```

这 16 条就是**步骤 2 的待办清单**，可直接复制进 PR 描述。

**步骤 1 状态**（`BUILD-OUTPUTS.json` 已登记 31 条现状后）：

```
$ node scripts/ci/check-build-root.js
模式：advisory（只报不改，恒 exit 0）　产物根：_build/　登记表：…（31 条）

── 扫描 25 个产物候选目录
  [ERROR] not-in-build-all  _build/electron/zcode-analysis
            未被 build:all 覆盖 —— 「随时能删」要求一条命令全量重建，漏一条就不成立（违反 I1）。
  [WARN ] legacy-path       apps/ai-frontend/coverage
  [WARN ] legacy-path       apps/khy-mobile/android/build
  [WARN ] legacy-path       apps/khy-mobile/android/capacitor-cordova-android-plugins/build
  [WARN ] legacy-path       apps/khy-mobile/dist
  [WARN ] legacy-path       apps/khy-mobile/release
  [WARN ] legacy-path       apps/khy-os-client-app/android/build
  [WARN ] legacy-path       apps/khy-os-client-app/release
  [WARN ] legacy-path       apps/khyos-desktop/dist
  [WARN ] legacy-path       apps/khyos-desktop/out
  [WARN ] legacy-path       apps/khyos-desktop/zcode-analysis/unpacked/out
  [WARN ] legacy-path       apps/provider-hub/dist
  [WARN ] legacy-path       khy_os.egg-info
  [WARN ] legacy-path       services/backend/dist
  [WARN ] legacy-path       software/khyquant/frontend/coverage
  Summary: 1 error(s), 14 warning(s).
```

**16 error → 1 error + 14 warning**：14 条从「未登记越界」变成「已登记、迁移中」，1 条（`zcode-analysis`）保留 error，因为它连重建命令都还没有——登记表不替它撒谎。这正是 §6 强度梯度的预期形状：**步骤 1 只把「未知」变成「已知」，不假装问题已解决**。

---

## 11. 复现方式

```bash
cd /d/Portable/khy-os
NODE="D:/WorkBuddyData-Intl/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"

# 反例矩阵（12 场景，含一条「应放行」）
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --all

# 单场景
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --scenario=scatter-new

# 自定义路径集
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --files="A:entries/x,B:apps/y/dist"

# 真实仓库现状扫描（只读）
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --scan

# clean.js 登记表体检（「随时能删」的判据：gap 必须为 0）
node docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js --audit-clean

# 三条证据的独立复核
node scripts/ci/check-build-artifacts.js                     # 证据：报绿
git ls-files 'apps/khyos-desktop/out' 'kernel/moonbit/_build' | wc -l   # 证据：10
git check-ignore -v docs/19_资产/site/mermaid.min.js              # 证据：exit 1（未被忽略）
grep -n mermaid .gitignore scripts/maintenance/clean.js      # 证据：两份清单路径不同
```

可用场景：`clean` `scatter-new` `unregistered` `depth-exceeded` `parasitic-expired` `parasitic-no-hook` `legacy-not-removed` `legacy-migrating` `registry-missing-rebuild` `registry-not-in-build-all` `registry-entry-outside-root` `parasitic-budget`

---

## 附录 A：一句话记住这条规则

| 现在 | 之后 |
|---|---|
| 产物在 6 个层级、11 种目录名 | 产物在 `entries/`，深度 ≤ 2 |
| 三份手写清单互相打架 | 一份登记表，三处派生 |
| `clean:apply` 漏 17 条 | `clean:apply` 由登记表派生，gap 必须为 0 |
| 「删了应该能重建吧」 | 没有 `rebuild` 命令就不许登记 |
| 守卫绿着放行 10 个已跟踪产物 | scope 从路径白名单换成登记表驱动 |
