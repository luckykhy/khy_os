# 《khyos 文档排版与格式控制规范》

> 文档编号：DESIGN-ARCH-023
> 主题：解决 agent 写论文/报告时无法精确控制字体、颜色、页面、换页等格式的问题
> 范围：`services/backend` 文档生成工具层 + 样式模板层
> 关联实现：
> `src/services/typeset/contentSchema.js`、`src/services/typeset/markdownToAst.js`、
> `src/services/typeset/styleTemplates.js`、`src/templates/docstyles/*.json`、
> `src/services/docTypeset.py`、`src/tools/renderDocument.js`、`src/agents/constraints.js`
> 测试：`tests/services/typeset/*.test.js`、`tests/tools/renderDocument.test.js`

---

## 0. 问题陈述

khyos 原有的文档生成路径（`src/tools/createDocument.js` → `src/services/docHelper.py`
的 `text2docx`）是**内容生成与格式排版彻底耦合**的反面教材：它把模型给出的文本
**按换行符一段段裸塞进 docx**，没有任何字体/字号/页边距/行距/换页控制。要让产物"像一篇
论文"，唯一办法就是让模型自己在文本里写排版代码——`\textbf`、`\vspace`、docx 的
`w:rPr` XML、HTML `<font>` 标签……

这正是格式错乱的根源：**模型对"格式代码"的输出是不确定的**。同一个排版意图，模型这次写
`\textbf{}`、下次写 `**`、再下次写 `<b>`；字号一会儿"三号"一会儿"16pt"一会儿忘了写；
中文字体设了 `font.name` 却漏了 `eastAsia` 导致整篇中文回退默认字体。**只要把格式决策权
留在模型手里，排版就无法稳定复现。**

本规范的解法：**把格式决策权从模型手里彻底收走**，建立"内容与样式分离"架构——
模型只产出**语义结构**，程序按**样式模板**确定性地排版。

> 注意：本方案**只新增**排版工具与模板，**不触碰** `createDocument` 老路径，也**不修改**
> 核心调度器（`toolUseLoop` / `toolExecutionEngine`）与任何无关业务逻辑（防呆④）。

---

## 1. 设计目标与硬约束

### 1.1 核心诉求（必须满足）
| # | 诉求 | 本方案如何满足 |
|---|------|----------------|
| ① | **模型只管语义，不管样式** | 模型只输出语义 AST（标题/段落/列表/表格…）或 Markdown；任何底层排版代码在 `contentSchema.validateDocument()` 处**被拒绝**，强制回到结构化路径。 |
| ② | **模板驱动** | 所有格式需求都落为 `src/templates/docstyles/*.json` 的配置项（页面/段落/字体/换页），由 `docTypeset.py` 确定性执行，**不存在"模型记格式"**。 |
| ③ | **原子化排版 API** | `docTypeset.py` 封装 `_set_run_font` / `_apply_paragraph_format` / `_set_page` / `_add_page_number` 等原子原语，内部处理 docx 底层细节；**模型永远拼不到排版字符串**。 |

### 1.2 防呆规则（不可违反）
1. **拦截任何底层排版代码**（LaTeX 命令、LaTeX 宏、HTML/XML 标签含 docx `w:` 标签、内联
   CSS、RTF 控制字）——一经发现即**拒绝并提示走结构化输入**，绝不静默渲染或让其污染文档。
   唯一例外：`code` 代码块的**正文**，它被原样渲染进等宽样式、**永不被解释**，故对其豁免扫描。
2. **渲染引擎必须处理中文**：`docTypeset.py` 在 `_set_run_font` 中**每一个 run 都同时**设置
   `w:rFonts/@w:eastAsia`；写后校验阶段再次核查，**对漏设 eastAsia 的 run 直接打补丁补上**
   （python-docx 只设 `font.name` 而不设 eastAsia 时，中文会静默回退，这是必踩的坑）。
3. **换页是确定性 API**：换页**只**来自结构化的 `{type:"pagebreak"}` 块、Markdown 的
   `[[newpage]]` / `<<<pagebreak>>>` 哨兵行，或模板的"H1 前自动换页"策略——**绝不依赖**
   模型在正文里插入空行/换行符占位（空行、`---` 水平线一律**不**触发换页）。
4. **只新增、不修改核心**：本规范仅新增排版工具与模板；唯一对既有文件的改动是在
   `src/agents/constraints.js` 的 `HARD_PROHIBITIONS` 增加一条"禁止手写排版代码、改用
   renderDocument"的红线——这是禁令单一真源，属于本目标范畴，非核心调度器/无关业务。

---

## 2. 架构：内容与样式分离

```
模型  ──► 语义内容（Markdown 或 文档 AST）              只有语义，零格式代码
          │
renderDocument 工具（src/tools/renderDocument.js）
          │  1) _toAst：Markdown→AST 或解析 AST JSON
          │  2) validateDocument：防呆拦截任何排版代码  ← 模型若夹带 \textbf/<b> 在此被拒
          │  3) resolveTemplate：选定样式模板(+覆盖)
          │  4) 路径展开与封禁（限定项目/家目录子树）
          │  5) 写临时 payload JSON，交给渲染器
          ▼
docTypeset.py（确定性渲染器，python-docx）
          │  按模板把 AST 逐块映射为 docx 底层对象
          │  （H1→"黑体三号居中+前置换页"，正文→"宋体小四 1.5 倍行距首行缩进 2 字符"…）
          │  写后必验：反解 docx，核查 A4/eastAsia/标题字号，不合即就地打补丁
          ▼
最终 .docx（格式由模板决定，确定性可复现）
```

**三层职责**
- **语义层**（`contentSchema.js` / `markdownToAst.js`）：定义模型唯一被允许输出的 AST；把
  Markdown 确定性地解析成 AST；在此拦截一切排版代码。
- **样式层**（`styleTemplates.js` / `docstyles/*.json`）：格式的**唯一**决策处——页面、段落、
  逐层级字体/字号/加粗/对齐、换页策略。模板是纯数据，用户可覆盖。
- **渲染层**（`docTypeset.py`）：把 AST × 模板确定性地落成 docx，并写后校验+打补丁。

---

## 3. 语义内容 Schema（模型唯一被允许的输出）

闭合的块文法（`contentSchema.js` 的 `BLOCK_TYPES`）：

| 块类型 | 形状 | 说明 |
|--------|------|------|
| `heading` | `{level:1..6, text}` | 标题，层级映射模板 `fonts.heading{N}` |
| `paragraph` | `{text}` 或 `{runs:[{text,bold?,italic?}]}` | 正文；强调是**语义 run 标记**，非格式代码 |
| `list` | `{ordered:bool, items:[string]}` | 有序/无序列表 |
| `table` | `{header?:[string], rows:[[string]]}` | 表格 |
| `quote` | `{text}` | 引文 |
| `code` | `{text, lang?}` | 代码（等宽，正文豁免排版扫描） |
| `pagebreak` | `{}` | **唯一**的显式换页方式（防呆③） |
| `figure` | `{path?, caption?}` | 图片+题注 |
| `reference` | `{entries:[string]}` | 参考文献（GB/T 7714 / IEEE 编号悬挂缩进） |

**防呆拦截**（`FORMAT_CODE_PATTERNS`）：在任何文本片段中检测并拒绝
LaTeX 命令（`\textbf|\vspace|\newpage|\section|…`）、LaTeX 宏（`\word{`）、HTML/XML 标签
（`<b>`/`<font>`/`<w:rPr>`…，要求标签名紧跟 `<`，使 `a < b` 这类不等式不被误判）、
内联 CSS（`style="…font/color…"`）、RTF 控制字。`code` 块正文豁免。

> 强调（`**bold**` / `*italic*`）映射为 run 的 `bold/italic` **语义标记**，由模板用自己的
> 强调字体渲染——它表达"这里是重点"，不是"用某字体某字号"，因此**不是格式代码**。

---

## 4. 样式模板系统（格式的唯一真源）

模板是 `src/templates/docstyles/` 下的纯 JSON，结构：

```jsonc
{
  "name": "gbt7714", "label": "…", "description": "…",
  "page":      { "size": "A4", "margins": {top,bottom,left,right,unit}, "header": {...}, "footer": { "pageNumber": true } },
  "paragraph": { "lineSpacing": 1.5, "lineSpacingRule": "multiple", "spaceBefore": 0, "spaceAfter": 0, "firstLineIndentChars": 2 },
  "fonts": {
    "default":  { "ascii", "eastAsia", "size", "sizeLabel", "bold", "color" },
    "title":    { …, "align": "center" },
    "heading1": { …, "align": "center", "pageBreakBefore": true },   // 一级标题前自动换页
    "heading2..4", "quote", "code", "caption", "reference", "list", "tableCell"
  },
  "pagination": { "pageBreakBeforeHeading1": true },
  "list": { "indentChars": 2 },
  "table": { "style": "Table Grid", "headerBold": true }
}
```

**内置三基线**
| 模板 | 用途 | 关键映射 |
|------|------|----------|
| `default` | 通用 A4 | 完整基线，所有 font 键齐备（其它模板叠加其上继承） |
| `gbt7714` | 国标中文学术 | H1 黑体三号(16pt)居中**前置换页**；正文宋体小四(12pt) 1.5 倍行距首行缩进 2 字符；参考文献宋体五号悬挂缩进 |
| `ieee` | IEEE 英文 | Times New Roman 正文，标题 Times 加粗分级，紧凑行距（双栏需后处理，本基线单栏近似） |

**解析与覆盖**（`resolveTemplate(spec, overrides)`）：`spec` 可为内置名 / 绝对路径 JSON /
内联对象；非 default 模板一律**叠加在 default 之上**以继承完整基线；`overrides` 再深合并，
用户可只改一个键（如 `{paragraph:{lineSpacing:2}}`）而无需重述基线。

中文字号→磅值对照：二号 22 / 三号 16 / 小三 13 / 四号 14 / 小四 12 / 五号 10.5。

---

## 5. 确定性渲染管线（python-docx）

`docTypeset.py` 的**原子排版原语**（模型永远碰不到，内部封装底层 XML）：

| 原语 | 职责 |
|------|------|
| `_set_run_font(run, spec, default)` | 设 `font.name` + `rFonts` 的 ascii/hAnsi/cs/**eastAsia** + 字号(Pt)/加粗/斜体/小型大写/颜色。**每个 run 必盖 eastAsia**（防呆②） |
| `_apply_paragraph_format(p, spec, base)` | 对齐、行距(multiple/exact)、段前段后、首行缩进(Pt(size×chars))、`page_break_before` |
| `_apply_left_indent_chars` / `_apply_hanging_indent_chars` | 左缩进 / 悬挂缩进（按"N 字符"≈N×字号磅值近似 CJK 字宽） |
| `_set_page(section, page)` | A4(210×297mm 的 EMU) / Letter 尺寸 + 页边距(Cm) + 页眉页脚距离 |
| `_add_page_number(p)` | 插入 `PAGE` 域 |

**块渲染器**：`_render_heading`（按 `pagination.pageBreakBeforeHeading1` 且非首块时自动前置
换页）、`_render_paragraph`（按 run 的 bold/italic）、`_render_list`（手动 `•`/`N.` 前缀）、
`_render_quote`、`_render_code`（逐行一段、等宽、不缩进）、`_render_table`（Table Grid、表头
加粗）、`_render_figure`（路径存在则 `add_picture` + 题注）、`_render_reference`（编号悬挂缩进）。

`_render_document(ast, template, output_path)` 设页面 → 可选标题 → 逐块渲染（用 `seen_content`
追踪首个内容块以正确实施"H1 前换页"）→ 保存。

**渲染时序**（一次 `renderDocument` 调用的完整路径）：

```
模型            renderDocument.js              docTypeset.py            磁盘
 │  content+template   │                            │                    │
 ├────────────────────►│ _toAst                     │                    │
 │                     ├─ validateDocument 防呆 ──┐  │                    │
 │                     │   含排版代码？ ──是──► 拒绝(success:false,hint)  │
 │                     │   ▼否                    │  │                    │
 │                     ├─ resolveTemplate(模板+overrides)                 │
 │                     ├─ 路径展开+封禁(项目/家目录子树)                  │
 │                     ├─ 写临时 payload.json {ast,template,output} ──────┼──►│
 │                     ├─ findPython + spawn ──────►│ render(payload)     │
 │                     │      (滑动空闲超时)         ├─ _set_page A4       │
 │                     │                            ├─ 逐块渲染(原子原语) │
 │                     │                            ├─ save ──────────────┼──►│ .docx
 │                     │                            ├─ _verify_and_patch ─┼──►│ 反解
 │                     │                            │   A4? eastAsia? H1? │   │
 │                     │                            │   不合→打补丁→重存 ─┼──►│ .docx'
 │                     │◄── JSON{success,validation,patched} ────────────┤   │
 │◄── success+validation│ 清理临时 payload(finally)                      │   │
```

关键不变量：**排版代码在第二步即被拦，永远到不了渲染器**；**渲染器内的校验闭环保证产物
合规，不确定性不外溢回模型**。

---

## 6. 格式校验闭环（写后必验，绝不退回模型）

`_verify_and_patch(output_path, template)` 在保存后**反向解析** docx，逐项核查并**就地打补丁**：

| 校验项 | 不合时的修复 |
|--------|--------------|
| 页面尺寸是否 A4（EMU 容差 36000=1mm） | 直接改 section 的 `page_width/height` |
| **每个有文本的 run 是否都设了 eastAsia** | 缺失则用 XML 补上 `w:rFonts/@w:eastAsia`（防呆②的兜底） |
| H1 字号是否符合模板 | 抽检不符则修正 |

返回 `{pageSizeA4, eastAsiaApplied, headingSizeOk, patched:[…]}`，有补丁则重新保存。
**任何不合都在引擎内修复，绝不把文件退回模型重写**（防呆：消除二次不确定性）。

---

## 7. 工具入口与边界

`src/tools/renderDocument.js`（扁平 `defineTool`，自动被 `src/tools/index.js` 发现）：
- 入参：`content`（必填，语义 Markdown 或 AST JSON）、`outputPath`（必填）、`template`（可选，
  `default|gbt7714|ieee` 或绝对路径）、`title`（可选）、`overrides`（可选模板补丁）。
- 流程：`_toAst`（防呆拦截）→ `resolveTemplate` → 路径展开+封禁（限项目 CWD / 家目录子树，
  与 createDocument 一致；展开后再封禁一次，因 `validateInput` 只见到原始路径）→ 写临时
  payload → `findPython` → `_runTypeset`（滑动空闲超时，有输出即重置）→ 附 `template` 来源
  → finally 清理临时文件。
- `isEnabled()`：需 python3/python 在位且 `docTypeset.py` 存在，否则该工具不挂载。

**约束注入**：`constraints.js` 的 `HARD_PROHIBITIONS` 增红线——禁止为排版手写
LaTeX/docx-XML/HTML/CSS/RTF，要产出正式 Word/论文必须调 `renderDocument` 给语义内容+模板；
换页用 `[[newpage]]` 或 `{type:"pagebreak"}`，绝不用空行。

**边界（防呆④）**：不改 `createDocument` 老路径、不改核心调度器、不改无关业务逻辑；
仅在工具层与模板层新增，外加上述一条禁令红线。

---

## 8. 测试与验证

| 测试文件 | 覆盖 |
|----------|------|
| `tests/services/typeset/contentSchema.test.js` | 块文法校验；防呆拦截 LaTeX/HTML/docx-XML/内联 CSS/RTF；不等式 `a < b` 不误判；code 块正文豁免 |
| `tests/services/typeset/markdownToAst.test.js` | 标题/段落/列表/引文/代码/表格解析；`[[newpage]]`/`<<<pagebreak>>>` 换页；水平线/空行**不**换页；强调→语义 run |
| `tests/services/typeset/styleTemplates.test.js` | 三模板发现；gbt7714 国标签名；未知模板报错列出内置；内联模板继承 default 基线；overrides 深合并 |
| `tests/tools/renderDocument.test.js` | 工具契约；防呆拒绝 LaTeX/HTML；未知模板列可选项；路径封禁拒写 `/etc`；**端到端**（有 python-docx 时）渲染真 .docx 并反解断言 A4 + 标题在位 + **每个中文 run 的 eastAsia 全覆盖** |

合计 **60/60** 通过（含端到端渲染断言 `pageSizeA4=true` 与 `missing_eastAsia=0`）。

---

## 9. 与既有规范的关系

- 复用 `createDocument` 的子进程/路径封禁范式（`findPython`、`validateNoPathTraversal`、
  展开后再封禁），但**另起**确定性管线，不改老路径。
- 与 [DESIGN-ARCH-022]（多实例并发文件控制）正交：`renderDocument` 走工具层写入，天然受
  其单文件锁保护，无需额外协调。
- 禁令进入 `constraints.js` 单一真源，与"内置 agent 禁令单一真源"一脉相承。

---

## 10. 模板解析与覆盖语义（走查）

`resolveTemplate(spec, overrides)` 的确定性合并是"任何格式需求 = 模板配置项"得以成立的关键。

**输入三态**：
- 内置名（`"gbt7714"`）→ 命中 `_loadBuiltins()` 缓存。
- 绝对路径 / 含分隔符的路径（`"/home/me/x.json"`）→ 读文件解析。
- 内联对象（`{name, fonts:{…}}`）→ 直接用。

**两段式合并**（保证部分模板也能拿到完整基线）：
```
base = (内置名命中 default) ? default
                            : deepMerge(default, 选中模板)   // 选中模板叠加在 default 上
final = overrides ? deepMerge(base, overrides) : base        // 用户覆盖再叠加
```
`_deepMerge` 规则：对象递归合并，**数组与标量整体替换**。

**为什么先叠 default**：用户/文件模板可能只写了 `fonts.heading1`，没写 `fonts.code` /
`page.margins`。先叠在 default 之上，渲染器就一定能取到每个 font key 与页面参数，**不会因
模板不全而 KeyError**。`styleTemplates.test.js` 的 `inline partial template inherits the full
default baseline` 正是守此不变量。

**走查例**：`resolveTemplate("gbt7714", {paragraph:{lineSpacing:2}})`
1. `gbt7714` 非 default → `base = deepMerge(default, gbt7714)`：得到国标全字段。
2. `overrides` 非空 → `final = deepMerge(base, {paragraph:{lineSpacing:2}})`：仅 `lineSpacing`
   变 2，`firstLineIndentChars:2`、H1 字号 16 等**全部保留**。

---

## 11. 边界用例与失败模式

| 情形 | 行为 | 依据 |
|------|------|------|
| 内容夹带 `\textbf` / `<b>` / `<w:rPr>` / 内联 CSS / RTF | 渲染前 `success:false` + hint，**绝不渲染** | 防呆① |
| 不等式散文 `a < b 与 x > y` | **不**误判为标签，正常渲染 | HTML 正则要求标签名紧跟 `<` |
| code 块正文含 `\textbf{}` / `<b>` | **豁免**扫描，原样进等宽样式，永不解释 | `validateBlock` 对 `type==='code'` 跳过扫描 |
| 多个空行 / `---` 水平线 | **不**换页（空行=段落分隔，水平线被忽略） | 防呆③ |
| 自定义模板漏某 font 的 `eastAsia` | 渲染时该 run 漏设 → **写后校验补丁补上** | `_verify_and_patch` |
| 页面被某种原因写成非 A4 | 写后校验直接改回 A4 | `_verify_and_patch` |
| 未知模板名 | `success:false` + `availableTemplates` 列表 | `resolveTemplate` |
| 输出路径越界（如 `/etc`、`/tmp`） | 拒写 | `validateNoPathTraversal`（展开后再封禁） |
| 内容 > 4MB | 拒绝 | `MAX_CONTENT_SIZE` |
| 渲染器久无输出 | 60s 滑动空闲超时杀子进程 | `_runTypeset` arm() |
| python / python-docx 缺失 | 工具 `isEnabled()` 假，不挂载 | `_checkEnabled` |
| 块数 > 20000 | 拒绝 | `MAX_BLOCKS` |

---

## 12. 从 `createDocument` 迁移建议

两者**并存**，按需选择：

| 维度 | `createDocument`（旧） | `renderDocument`（新） |
|------|----------------------|------------------------|
| 定位 | 文本→docx 直存，无样式 | 精确排版（论文/正式报告） |
| 输入 | 纯文本 | 语义 Markdown / AST |
| 格式控制 | 无（按行裸塞） | 模板驱动，确定性 |
| 中文 | 不保证 | eastAsia 强制+校验 |
| 换页 | 无 | 确定性 API |

**迁移要点**：
1. 把原先靠"模型在文本里写格式"的用法，改为**纯语义内容 + 选模板**；格式诉求转成模板键值
   或 `overrides`，不要再往内容里塞任何排版代码。
2. 需要的特殊格式若内置模板未覆盖，**新增/自定义一份 JSON 模板**（叠加在 default 上只写差异），
   而非在调用处拼字符串。
3. 老路径不动：仅"随手转个 docx、不在意排版"的场景继续用 `createDocument`。

> 不做强制替换——`createDocument` 仍有其轻量场景价值，本规范只为"需要精确排版"的需求提供
> 确定性通道。
