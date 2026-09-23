# DESIGN-ARCH-059 能力即代码（capability-as-code）

> **核心判断**：Khyos 的「学习」不能过度依赖助手记忆，更应该以**代码**实现。
> 每次「教 Khyos 做一件事」，若只落成助手私有记忆，则只有助手可见、不随产品分发、
> 无测试会过期、还会让 `MEMORY.md` 膨胀。能力应沉淀为**可执行模块 + 测试 + 自动发现**，
> 经 canonical 3-tree 入仓、随 wheel/npm 分发给**所有用户**。
>
> 本文档把「一条能力如何落地为代码」固化为可复制的编写约定。
> 关键设计结论：**不新建第 5 套并行注册表**。现有工具注册表（`defineTool` +
> `tools/index.js` 自动发现）已把**一份描述符**扇出到 **CLI + agent + MCP** 三个面；
> 唯一缺口是「测试作为一等公民」。因此本机制 = 在现有工具注册表上加一层
> **薄约定 + 元数据 + 一个用户可见的 `khy capability` 视图**，而非重写。

---

## 一、动机与非目标

### 动机
- **可分发**：能力随 wheel/npm 进入每个用户的安装，而非只活在某次会话的助手记忆里。
- **可验证**：每条能力自带同位 node:test，回归会跑、不会悄悄过期。
- **可发现**：`khy capability list/show` 让用户（与未来的自己）看到「学过哪些能力、测试在哪、是否还在」。
- **不膨胀记忆**：`MEMORY.md` 有体积上限（24.4KB）。能力入代码后，对应的「能力型记忆」应当删除，
  避免与仓库重复（见记忆 `feedback_learning_as_code`）。

### 非目标（后续演进）
- 能力的**动态创建**：已有 `metaToolEngine` + `CreateToolTool`，本约定不与其重叠。
- `khy capability verify` **真跑测试**：v1 仅做「测试文件存在性」检查；跑 `node --test` 留 v1.1。

---

## 二、什么是「一条能力」

一条能力 = 以下五件套，全部经 canonical 树入仓：

| # | 组成 | 位置约定 | 说明 |
|---|---|---|---|
| 1 | **共享核心**（single source of truth） | `services/backend/src/cli/handlers/<域>.js` | 真正干活的纯函数，结构化返回、**绝不抛栈**；带 DI seam（注入 spawn / findPython 便于无依赖测试） |
| 2 | **`defineTool` 描述符 + `capability` 块** | `services/backend/src/tools/<name>.js` | agent / MCP 面的入口；`execute()` 委派共享核心 |
| 3 | **CLI handler 包装** | 复用同一 `handlers/<域>.js` | `khy <域> <子命令>` 命令；与工具共享同一核心 |
| 4 | **同位 node:test** | `services/backend/tests/<name>.test.js` | 契约测试（纯 JS）+ 注入 spawn 的编排断言 +（若依赖外部库）库探活门控的 e2e |
| 5 | **（若需第三方库）依赖归属** | `pyproject.toml` 的 extra | 例如 `doc` extra 补 `python-docx`；运行时**惰性导入 + needsDep 兜底** |

---

## 三、机制层（Part A）：薄约定，非新注册表

### 3.1 `defineTool` 的 `capability` 元数据块

`services/backend/src/tools/_baseTool.js`：`defineTool` 内部构造**显式对象字面量、不 spread config**
（未知字段会被静默丢弃）。因此 `capability` 必须像 `_pendingCommands` 一样**显式附加**，
且必须在 `Object.freeze(tool)` **之前**：

```js
// ── Capability-as-code metadata (optional) ───────────────────────
if (config.capability && typeof config.capability === 'object') {
  tool.capability = Object.freeze({ ...config.capability });
}
return Object.freeze(tool);
```

字段约定：

```js
capability: {
  summary:     '一句话能力说明（用户可见）',
  learnedFrom: '<时间> 来源/教学场景',
  tests:       ['tests/<name>.test.js'],        // 相对 backend 包根
  surfaces:    ['cli', 'agent', 'mcp'],          // 该能力暴露的面
}
```

**安全性**：`toFunctionDef()` 只输出白名单 `{name, description, parameters, aliases?}`，
`capability` **永不泄漏给模型**。元数据为普通可枚举属性，便于注册表过滤。

### 3.2 薄门面 `services/backend/src/services/capabilityRegistry.js`

无 spawn、无 DI、无测试运行器，仅查询既有工具注册表：

- `listCapabilities()` → 过滤带 `.capability` 的工具，返回 `[{name, summary, learnedFrom, surfaces, tests}]`，按名称排序。
- `describeCapability(name)` → 在上基础上对每个声明的 `tests` 路径做 `fs.existsSync`，
  附 `testsResolved`（`{path, absPath, exists}`）与 `testsPresent`（全部存在）。未找到返回 `null`。
- 导出 `PACKAGE_ROOT`（= `services/backend`）。

### 3.3 用户可见视图 `khy capability list|show`

- `commandSchema`：`ROUTER_COMMANDS` 加 `'capability'`；`ROUTER_SUB_COMMANDS` 加 `capability:['list','show']`。
- `router.js`：`case 'capability'` → `cli/handlers/capability.js` `handleCapability(parsed)`。
- `list`（缺省）打印能力表（能力 / 说明 / 可用面 / 带测试）；`show <name>` 列出测试路径与「存在:是/否」。

这是「自动发现 + 测试可定位」对用户的可见保证。

---

## 四、首个实例（Part B）：Word 标题字号/颜色

把上述约定走通的第一条真实能力。来源：用户教学「把 Word 文档的标题/表题改成指定字号与颜色」。

| 组成 | 落点 |
|---|---|
| 共享核心 | `cli/handlers/doc.js` `runTitleStyle(opts, deps={})` — 路径解析 + 输入/输出双路径 `validateNoPathTraversal` 封禁 + spawn `docHelper.py title-style` + 结构化返回 |
| Python 核心 | `services/docHelper.py` `title-style` 子命令 — 惰性 `from docx import Document; from docx.shared import Pt, RGBColor`，缺依赖返 `{needsDep:true, hint:'pip install khy-os[doc]'}` |
| 工具描述符 | `tools/docTitleStyle.js` `defineTool`（`filesystem`/`medium`/非只读，`isEnabled` 探 python），`execute()` 调 `runTitleStyle` |
| CLI | `khy doc title <in.docx> [--match 文字] [--style 样式] [--size pt] [--color hex]` |
| 测试 | `tests/docTitleStyle.test.js`（16 断言）+ `tests/capabilityRegistry.test.js` |
| 依赖 | `pyproject.toml` `doc` extra 补 `python-docx>=1.1.0` |

### 关键实现要点（踩坑沉淀）
- **定位**：按精确文本 `match` **或**按段落样式 `style`；样式集含本地化中文名
  `标题`/`标题 1`/`标题 2`/`题注`（用户多为中文文档）。
- **多 run 标题**：Word 常把标题文字拆成多个 run，须遍历**全部 run** 设
  `run.font.size = Pt(...)`、`run.font.color.rgb = RGBColor.from_string(hex)`（6 位 hex、无 `#`）。
- **不覆盖源**：`output` 缺省 → 同级 `*.styled.docx`。
- **写路径封禁**：输入/输出双路径经 `validateNoPathTraversal`（限项目树 `KHYQUANT_CWD` 或用户家/桌面等可信根）。
- **已知限制**：表题自动编号 `图 1`/`表 1` 由 SEQ 域生成，普通 run 改不到，只改字面 run。

---

## 四之二、第二个实例：统一格式转换（convertFile）

复制同一约定走通的第二条能力——验证「能力即代码」可复制，而非一次性脚手架。
来源：用户教学「教 Khyos 正确做格式转换，比如图片转 PDF 或转可编辑的 txt」。**这条学习
从未存过记忆，直接落成代码 + 测试 + 自动发现**，正是本 DESIGN 的初衷示范。

| 组成 | 落点 |
|---|---|
| 共享核心 | `cli/handlers/convert.js` `runConvert(opts, deps={})` — 输入归一（单文件/逗号分隔多文件/目录枚举按名排序）+ 源/目标判定 + 路由表 + 输出路径 `validateNoPathTraversal`/`validateNotUNCPath` 封禁 + spawn 子命令 + 结构化返回 |
| Python 核心 | `services/docHelper.py` 新增 `img2pdf`/`pdf2txt`/`docx2txt`/`txt2docx` 四子命令（惰性导入 Pillow/pypdf/python-docx，缺依赖返 `{needsDep:true}`） |
| 工具描述符 | `tools/convertFile.js` `defineTool`（`filesystem`/`medium`/非只读，`isEnabled` 探 python），`execute()` 调 `runConvert` |
| CLI | `khy convert <文件\|图片,图片,…\|目录> [--output 路径] [--to pdf\|txt\|docx]`（位置参数 input，无固定子命令） |
| 测试 | `tests/convertFile.test.js`（18 用例：契约 3 + 注入 spawn 路由 11 + python 门控 e2e 4） |
| 依赖 | `pyproject.toml` `doc` extra 补 `pypdf>=4.0.0`（PDF 文本层提取） |

**转换矩阵（源 → 目标）**：

| 源\目标 | pdf | txt | docx |
|---|---|---|---|
| image | ✓ 单张/多图合并 | ✓ OCR | — |
| pdf | — | ✓ 文本层提取 | ✓ pdf2docx |
| docx | — | ✓ 段落文本 | — |
| txt | — | — | ✓ 逐行段落 |

### 关键实现要点（踩坑沉淀）
- **PNG alpha/调色板存 PDF 报错** → 存前一律 `Image.convert("RGB")`。
- **多图合并** → 首张 `first.save(out, "PDF", save_all=True, append_images=others)`；目录/多图按
  文件名 `localeCompare` 排序，输出名 `*.merged.pdf` 不覆盖源。
- **扫描件 PDF 无文本层** → `pdf2txt` 提取为空时返 `{success:false, hint:'疑似扫描件，改用图片→TXT(OCR)'}`，不假装成功。
- **图片→TXT 复用既有 `ocr`** → docHelper 的 `ocr` 只回文本不落盘，由 Node 侧把（多图拼接的）文本写 `.txt`。
- **大文本走 argv** → `txt2docx` 从**文件**读，不把内容塞命令行。
- **格式判定优先级** → `--to` 显式 > 输出扩展名 > 按源默认（image→pdf / pdf→txt / docx→txt / txt→docx）。
- **写路径封禁** → 仅封**输出**路径（读路径按既有工具惯例不封，扩展名已门控）；`bin/khy.js` 启动会把
  `KHYQUANT_CWD` 重置为 backend 目录，故 CLI 写目标须落项目树或用户家/桌面/文档/下载等可信根。

---

## 四之三、第三个实例：角色扮演（adoptRole）

走通同一约定的第三条能力，也是**首个行为型实例**——前两条都在转换**文件**，这条转换的是
**agent 自己怎么回应**。来源：用户教学「教 Khyos **正确**根据提示词扮演角色，比如『你现在是一位
资深律师』」。它证明「能力即代码」不止适用于文件工具，**行为/提示词层的能力同样照此约定落地**：
核心是 **JS 服务 + 系统提示词段注入**，无 Python、无文件转换。

| 组成 | 落点 |
|---|---|
| 行为核心 | `services/roleService.js` —— `synthesizeRole`（命中预设套模板 / 否则自由合成，尾部恒附 `SAFETY_FOOTER`）、`detectRoleIntent`（保守正则识别 set/clear，跳过疑问句/闲聊）、会话级活动角色存储 + `roleStamp()`、`persistRole`/`unpersistRole`（写/清 persona.md 受管栅栏区） |
| 共享核心 + CLI | `cli/handlers/role.js` `runRole(opts, deps)` —— 工具/CLI/斜杠/自动识别共用；`handleRole(parsed)` 为 `khy role` 入口 |
| 工具描述符 | `tools/adoptRole.js` `defineTool`（`system`/`low`/非只读/并发安全，纯 JS 默认 enabled），`execute()` 调 `runRole` |
| 提示词注入 | `constants/prompts.js` `getRoleSection(cwd)`（紧接 `getPersonaSection` 后）+ 动态段（persona **之后**，cacheKey 折 `roleStamp()`）；`khyUpgradeRuntime.js` 顶层 prompt cacheKey 同样折入 `roleStamp` |
| 对话自动识别 | `cli/repl.js` 在每轮发送前（**仅交互式 CLI**）跑 `detectRoleIntent`→`runRole`，并打印一行透明提示；`KHY_ROLE_AUTODETECT=0` 关 |
| 会话清理 | `cli/ai.js` `clearHistory()` 单一收口调 `clearActiveRole()`（`/new`/`/reset`/`/clear`/双 Ctrl+C 临时角色不残留） |
| CLI/斜杠 | `commandSchema` `ROUTER_COMMANDS` 加 `'role'`；`router.js` `case 'role'`；`repl.js` extras 加 `/role` |
| 测试 | `tests/roleService.test.js`（24 用例：检测/合成/安全/存储/共核/工具契约/段注入） |
| 依赖 | 无（纯 JS） |

### 「正确扮演」的安全分层（本能力的内核）
- **优先级**：角色段在硬禁令 / 项目规则 / persona 红线**之下**。段头（`# role (temporary)`）重申：
  角色仅塑造表达/措辞/专业视角，**绝不**覆盖上方边界，冲突一律以上方为准。
- **不可协商安全页脚**：每个合成角色块尾部固定追加 `SAFETY_FOOTER`（不泄密钥/不绕人工确认/不替用户做不可逆决策/角色非越权理由）。
- **越权拒绝**：`REFUSAL_PATTERNS` 把「忽略所有规则 / 开发者模式 / 越狱 / DAN / no restrictions / ignore (all|previous) rules」类提示**直接拒绝**，不合成为角色。
- **注入扫描 fail-closed**：自由/持久化文本走 `instructionFileService.scanForPromptInjection`（命中即拒）；扫描器不可用时自由角色也拒绝，预设（可信）放行。
- **临时 vs 持久**：默认**仅本次对话**（进程内单例存储）；唯有用户显式 `--save`/「保存角色」才写入 persona.md
  的**受管栅栏区**（`<!-- khy:role:start -->…<!-- khy:role:end -->`，幂等替换，不与手写内容纠缠）。
- **多租户隔离**：活动角色存储与对话自动识别**仅交互式 CLI 单进程单用户启用**；多租户 web 守护进程不跑自动识别、存储恒空，web 用户经各自 persona 持久（见风险表）。
- **透明**：每次采纳/退出都打印一行明示（符合工具透明要求，不黑箱扮演）。

### 关键实现要点（踩坑沉淀）
- **进程内单例 + 同轮生效**：活动角色是模块单例；REPL 在 `makeSystemPrompt` 之前设角色，`getRoleSection`
  当轮即读到——「你现在是律师，帮我看这份合同」一句话同轮就以律师身份回应。
- **缓存即时失效**：`roleStamp()`（set/clear 自增序号，空时 `'none'`）折入段 cacheKey 与顶层 prompt cacheKey，
  采纳/退出角色立刻使旧提示词缓存失效。
- **检测保守**：仅祈使设角色句式命中，疑问句（`你是谁?`/`你现在是什么模型？`）与普通闲聊一律不触发，避免误扮演。
- **DI 可测**：`persistRole(role, cwd, {writeFile, readFile, existsSync, mkdir, dest})` 注入文件副作用，
  栅栏区幂等替换断言无需碰真实 persona.md。
- **scan 显式优先**：`synthesizeRole(prompt, {scan})` 用 `'scan' in opts` 区分「未提供」与「显式 null」，
  使「扫描器不可用」分支可测。

---

## 五、编写新能力的清单（复制即用）

1. 在 `cli/handlers/<域>.js` 写共享核心：纯函数、结构化返回、`deps={}` 注入外部副作用、绝不抛栈。
2. 在 `tools/<name>.js` `defineTool`，`execute()` 委派共享核心，并加 `capability` 块（含 `tests`）。
3. 若需顶层 CLI 命令：`commandSchema` 加 token + 子命令，`router.js` 加 `case`，handler 复用同一核心。
   （注意：若工具已通过顶层路由暴露 CLI，**不要**再在 `defineTool` 里加 `_pendingCommands`，避免重复。）
4. 写同位 `tests/<name>.test.js`：契约 + 注入 spawn 的编排（无外部依赖）+ 外部库探活门控的 e2e。
5. 若依赖第三方库：`pyproject.toml` 对应 extra 补依赖；运行时惰性导入 + `needsDep` 兜底。
6. 跑 `node --test tests/<name>.test.js tests/capabilityRegistry.test.js` + 相关回归。
7. **能力落地后**：删除对应的「能力型记忆」及其 `MEMORY.md` 索引行（遵循 `feedback_learning_as_code`）。
8. 重建 wheel 传播到 bundled 镜像。

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| CI 无 python-docx | e2e 用 `import docx` 探活门控 skip；契约/编排测试纯 JS（注入 spawn），不依赖 python |
| `defineTool` 静默丢字段 | `capability` 显式附加，且必须在 `Object.freeze` 之前 |
| 元数据泄漏给模型 | `toFunctionDef()` 白名单输出，`capability` 不在其中 |
| 任意写 | 输入/输出双路径 `validateNoPathTraversal`；缺省输出走 `*.styled.docx` 不覆盖源 |
| 中文文档样式名 | 样式集含本地化中文名 + 提供精确文本 `match` 选择器 |
| 两个测试运行器混用 | `jest.config.js` 按 `require('node:test')` 标记自动忽略 node:test 套件，两运行器干净分离 |

---

## 七、3-tree 铁律

仅改 canonical：`services/backend/src/...`、`platform/khy_platform/...`、`pyproject.toml`、`docs/...`。
`platform/khy_os/bundled/...` 由 `setup.py BuildWithBundle` **生成**，不手改。
重建 wheel 传播：`KHY_OFFLINE_BUILD=1 bash scripts/release/build-platform-wheel.sh`。
