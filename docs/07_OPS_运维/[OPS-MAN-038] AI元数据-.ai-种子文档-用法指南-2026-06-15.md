# AI 元数据（`.ai/` 种子文档）用法指南

> 面向使用者与维护者的学习文档。
> 对应实现：`services/backend/src/services/projectMetadataService.js`、`metadataPointers.js`、`metadataHook.js`，
> CLI 入口 `services/backend/src/cli/handlers/metadata.js`（`khy metadata …`）。
> 设计规范：`docs/03_DESIGN_设计/` 中 DESIGN-ARCH 元数据相关条目。

---

## 1. 一句话定位

`.ai/` 是 khy 给**每个项目**自动生成的一套「种子文档」，目标只有一个：

> **即便有一天没有 AI 可用，人类或低算力模型也能据此快速理解并安全维护这个项目。**

它不是给 AI「喂切片」的向量库，而是给任何读者（人或模型）的一张**导航地图 + 一份红线清单**。
核心理念与「用会思考的 Agent，而不是会检索的 RAG」一脉相承：
**不预先把代码切碎，而是提供坐标，让读者按需展开去读真实代码。**

---

## 2. 三件套（机器自有模式）

生成在项目根目录 `.ai/` 下：

| 文件 | 角色 | 内容来源 | 读它来回答 |
|---|---|---|---|
| `MAP.md` | **骨架与导航** | 确定性扫描 | 「去哪找代码？」目录职责、入口点、技术栈、构建/运行/测试命令、目录树、关键文件符号速览 |
| `CONTEXT.yaml` | **契约与符号** | manifest + 正则 | 「谁调用谁？有哪些符号？」机器可读的栈/入口/构建/依赖/逐文件符号清单 |
| `GUARDS.md` | **红线与无-AI 维护指南** | 探测事实 + 通用红线 + 人工占位 | 「哪些不能碰？」改动前必读的约束、如何在没有 AI 的情况下维护 |

辅助文件：

- `.metahash.json` —— 内容指纹 + 归属类型（`auto` / `skeleton`），是「随变化更新」的判定依据。
- `SKELETON.auto.md` —— **仅当三件套是人工撰写时**才出现的机器派生层（见 §5）。

> 阅读顺序建议：`MAP.md`（去哪找）→ `CONTEXT.yaml`（谁调用谁）→ `GUARDS.md`（哪些不能碰）。

---

## 3. 它是怎么生成的（确定性地板 + 可选模型增强）

这套系统最关键的工程原则是 **「确定性地板」**：

- **完全不依赖任何模型/网络**即可生成 —— 这是「万一 AI 用不了」时的硬保证。
- 生成过程是纯 Node stdlib（`fs`/`path`），零第三方依赖，可在任何 khy 派生环境运行。
- **可选模型增强**（`opts.enhance` + `KHY_META_MODEL_ENHANCE=1`）只做语义润色，
  失败时**静默降级**回确定性产物，绝不阻塞、绝不抛错打断调用它的任务。

生成流水线（`_collectContext` → 渲染）：

1. **BFS 扫描目录树**（`_scanTree`）：深度/文件数双上限，跳过 `node_modules`/`.git`/`dist` 等噪音目录，
   目录内稳定排序保证产物**可复现**（无时间戳、无随机数）。
2. **技术栈探测**（`_detectStack`）：基于 `package.json` / `pyproject.toml` / `Cargo.toml` / `Makefile`…
   推断语言、入口点、安装/构建/运行/测试命令、主要依赖、配置文件。
3. **轻量符号抽取**（`_extractSymbols`）：按语言用正则抽函数/类/结构体**声明签名**（不解析 AST），
   按顶层模块**轮询配额**挑文件（`_selectSymbolFiles`），保证大型 monorepo 里每个主要模块都被代表。
4. **渲染**三件套 + 计算指纹 + 写 `.metahash.json` + 给各 AI 工具入口文件回链（§6）。

---

## 4. 它怎么「随项目变化自动更新」（不靠 AI）

这是整套设计的精髓 —— **内容指纹（fingerprint）**：

- `_computeFingerprint` 只对**结构事实**取 SHA-256：文件清单+大小、栈、入口、构建命令、依赖、符号、
  以及全量源文件的 `path|size` 列表。**不含任何时间戳/随机数**。
- 因此：**项目结构不变 → 指纹不变 → 不重写文件**（git 噪音最小化）；
  **结构一变 → 指纹翻转 → 可被无-AI 的机制确定性地检测到「该刷新了」。**
- `TOOL_VERSION`（当前 `khy-metadata/3`）并入哈希：模板逻辑升级时，旧产物自动判定为 stale。

`refreshProjectMetadata` 按 `.ai/MAP.md` 的**归属**分三种情形处理（绝不误伤人工文档）：

| 情形 | `MAP.md` 状态 | 行为 |
|---|---|---|
| 1. 缺失 | 不存在 | 首次生成完整三件套 |
| 2. 机器自有 | 带 `khy-metadata:auto` 标记 | 比对指纹：变了覆盖三件套，没变跳过 |
| 3. 人工撰写 | 无标记 | **绝不碰三件套**，只刷新派生层 `SKELETON.auto.md` |

> 判定归属看一行 HTML 注释标记 `<!-- khy-metadata:auto … -->`。
> **删掉这行标记 = 宣告人工接管**，此后 refresh 永不覆盖该文件。

---

## 5. 人工撰写 + 机器派生骨架（本仓库就是这种）

本仓库 `Khy-OS` 自己的 `.ai/MAP.md`、`GUARDS.md` 是**人工精写的**（内核种子文档，含手核实的红线，
如「串口不是 IRQ 驱动」「syscall 号是 ABI 不可重排」等），所以它们**不带** auto 标记、永不被覆盖。

与此同时，机器会维护一个 `SKELETON.auto.md`（派生骨架层），随代码漂移自动刷新「可机械推导的事实」。
这就实现了**两全**：

- 人工文档负责**意图与红线**（机器推不出来的知识）。
- 机器派生层负责**随代码变化的结构事实**（人工维护易过时的部分）。

`.metahash.json` 里 `kind: skeleton` 即标记当前是这种「人工 + 派生」并存模式。

---

## 6. 让其它 AI 工具默认读到 `.ai/`

`metadataPointers.linkAgentPointers` 会向 6 个约定入口文件**幂等注入**一段指针块，
把 Claude Code / Codex / Copilot / Cursor / Windsurf / Cline 等都引导到 `.ai/`：

- `AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、`.cursor/rules/*.mdc`、`.windsurfrules`、`.clinerules`

幂等意味着：已链接则返回空、不会每次提交都产生噪音。手动触发：`khy metadata link`。

---

## 7. CLI 速查（`khy metadata`，别名 `meta` / `maintain`）

```bash
khy metadata                 # = gen：对当前目录生成，已存在则跳过
khy metadata gen [--force] [path]      # 生成（--force 覆盖已有）
khy metadata refresh [--force] [path]  # 随变化就地更新（非破坏；人工 .ai/ 只刷新派生骨架）
khy metadata check [path]    # 缺失或 stale 时退出非零 —— 用作 CI / 提交前门禁
khy metadata show [path]     # 打印各文件存在状态 + 归属 + 是否最新
khy metadata link [path]     # 让 AI 入口文件指向 .ai/
khy metadata hook <install|uninstall|status> [path]  # 装/卸 git pre-commit 自动刷新钩子
```

**推荐工作流**：

```bash
khy metadata gen             # 首次：补齐三件套
khy metadata hook install    # 装钩子：此后每次 git commit 自动 refresh 并 git add .ai/，无需 AI
```

- `hook install` 检测到已有**非 khy** 的 pre-commit 钩子时**不覆盖**，而是打印片段让你手工合并。
- `check` 退出码为 1 时适合卡在 CI：保证元数据不与代码脱节。

---

## 8. 环境变量（全部有界、有安全默认）

| 变量 | 默认 | 作用 |
|---|---|---|
| `KHY_META_ENABLED` | `true` | agent 运行后是否自动补元数据（`maybeGenerateAfterRun`） |
| `KHY_META_MIN_FILES` | `3` | agent 写入多少新文件才判定「生成了项目」并触发元数据 |
| `KHY_META_MAX_DEPTH` | `6` | 扫描最大深度（monorepo 友好） |
| `KHY_META_MAX_FILES` | `4000` | 扫描文件数上限 |
| `KHY_META_MAX_SYMBOL_FILES` | `120` | 参与符号抽取的源文件数上限 |
| `KHY_META_MAX_SYMBOLS_PER_FILE` | `30` | 每文件抽取符号数上限 |
| `KHY_META_MAX_FILE_BYTES` | `256KiB` | 单文件读取上限（超出跳过） |
| `KHY_META_MAX_TREE_ENTRIES` | `200` | 目录树渲染条目上限 |
| `KHY_META_MODEL_ENHANCE` | `false` | 是否启用可选模型语义增强（失败自动降级） |
| `KHY_META_POINTER_TARGETS` | （内置 6 个） | 覆盖要回链的 AI 入口文件清单 |

---

## 9. 设计上值得学习的几点

1. **确定性地板 + 可选增强**：核心能力零模型零网络也能跑，模型只做锦上添花且失败即降级。
   这是「AI 辅助但不依赖 AI」的范本 —— 与本项目 `/learn` 三模式、依赖自愈等子系统同构。
2. **内容指纹驱动更新**：用纯结构哈希（无时间戳）作为「该不该刷新」的确定性信号，
   既能最小化 git 噪音，又能让 git 钩子这种无脑机制可靠地触发更新。
3. **归属标记保护人工产物**：一行注释标记区分「机器自有」与「人工接管」，
   机器永不覆盖人工知识，却仍能维护可机械推导的派生层 —— 人机各司其职。
4. **全程有界 + fail-soft**：所有阈值走 env 有上限，任何异常被吞成结构化结果，
   绝不抛错打断生成它的宿主任务。这是「基础设施级代码」的纪律。
5. **导航而非切片**：`.ai/` 给的是坐标（去哪 grep、从哪个入口进），不是预切的相似度片段。
   读者据此**按需展开真实代码**，逻辑关联不被破坏 —— 正是 Agent 范式优于 RAG 的体现。

---

## 10. 快速上手清单

```bash
# 1. 看看当前项目的元数据状态
khy metadata show

# 2. 没有就生成
khy metadata gen

# 3. 装钩子，让它随提交自动保鲜
khy metadata hook install

# 4. 改完代码后（若没装钩子）手动刷新
khy metadata refresh

# 5. CI 里加一道门禁
khy metadata check    # 退出码非零即代表元数据过期/缺失
```

读三件套时记住一句话：
**`MAP` 告诉你「在哪」，`CONTEXT` 告诉你「连着谁」，`GUARDS` 告诉你「别碰啥」。**
