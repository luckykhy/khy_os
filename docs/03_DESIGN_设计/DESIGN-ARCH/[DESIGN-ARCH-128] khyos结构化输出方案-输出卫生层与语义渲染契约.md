# 《khyos 结构化输出方案 — 输出卫生层与语义渲染契约》

> 文档编号：DESIGN-ARCH-128
> 主题：消除模型输出中 ANSI 残留（`1m`）与 Markdown 定界符裸上屏（`_文字_`），并建立「语义 → 样式 → 渲染」三层结构化输出契约
> 范围：`services/backend/src/cli/**`（输出清洗与渲染）+ `software/khyquant/frontend`（Web 渲染消费方）
> 关联实现：
> `src/cli/ansiSanitizer.js`（新增·单一真源）、`src/cli/modelTextNormalizer.js`、
> `src/utils/stripAnsi.js`、`src/cli/underscoreEmphasis.js`、`src/cli/markdownRenderer.js`、
> `src/services/domain/structured/typeset/*`、`src/services/outputIntegrityMonitor.js`
> 测试：`tests/ansiSanitizer.test.js`、`tests/stripAnsi.test.js`、`tests/modelTextNormalizer.test.js`、`tests/markdownEmphasis.test.js`
> 证据：`.khy/feedback/structured-output-20260922/`
> 规则依据：RUNTIME-007（修复先复现）、PROCESS-010（软著就绪·谁要的/为什么/怎么验证）、DOCS-001（文档命名与索引）

---

## 0. 问题陈述

用户在 khy CLI / 桌面端提问「曲靖天气」后，输出中出现两类不美观字符（截图见
`.khy/clipboard-img2file/screenshot_20260922_165201_904.png`）：

1. **大量裸下划线**：`_曲靖实况与预报（9月22日）_`、`_今天：_`、`_明天 (9月23日)_` —— 定界符连内容一起字面显示，强调完全丢失，整段回答被下划线噪声淹没。
2. **`1m` 等 ANSI 残留**：行首出现 `1m`，行尾出现 `0m`。

用户原话：

> khyos的输出中有大量下划线，1m等不美观，需要设计一个结构化输出方案

### 0.1 这不是两个病，是一个病

初看像「下划线渲染没做」+「ANSI 没剥干净」两件独立的事。实测证明**它们是同一个病的两个症状**，且**因果方向是反的**——不是下划线渲染缺失，而是 ANSI 残留**主动破坏**了下划线渲染。

---

## 1. 根因：剥一半的转义比不剥更糟

### 1.1 完整因果链

```
① 模型原文
   \x1b[1m_1m曲靖实况与预报（9月22日）_\x1b[0m
   └─ 模型把 ANSI 粗体码当正文吐了出来

② modelTextNormalizer.sanitize()
   [1m_1m曲靖实况与预报（9月22日）_[0m
   └─ CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
      只吃掉 0x1B(ESC) 这一个字节；紧跟的 CSI 参数 "[1m" / "[0m" 无人接管 → 残留

③ marked.parse()（前端）/ CommonMark（后端渲染）
   <p>[1m_1m曲靖实况与预报（9月22日）_[0m</p>
   └─ "["(0x5B) / "1"(0x31) / "m"(0x6D) 均非空白、非单词字符，
      使紧随的 "_" 不满足 CommonMark「左侧接（left-flanking）」条件
      → 强调不成立 → "_" 作为字面显示

④ 屏幕可见
   1m_1m曲靖实况与预报（9月22日）_0m   ← 用户截图所见
```

复现命令与原始输出全文见 `.khy/feedback/structured-output-20260922/repro-before.txt`
与 `root-cause-chain.txt`。

### 1.2 为什么「剥一半」比「完全不剥」更糟

| 处理方式 | 结果 |
|---------|------|
| **完全不剥**（保留完整 `ESC[1m`） | 渲染器（CommonMark/marked）把 `ESC[1m` 视为**不可见**控制序列，连同参数一起忽略 → 下划线**正常配对** → 输出反而干净 |
| **剥一半**（只删 0x1B，留下 `[1m`） | `[1m` 是**可见 ASCII** → 污染屏幕，且破坏下划线 flanking → 双重伤害 |

这是本方案的核心论断：**输出卫生是一个「要么整段剥净、要么整段别动」的原子操作，不存在「剥一部分」的中间态。**

### 1.3 次生病灶：`utils/stripAnsi.js` 漏剥 5/6

同源的第二个入口。该模块兜底正则 `/…\x1b\[[0-9;]*m/g` **只认纯数字/分号参数的 SGR**，实测：

| 输入 | 是否剥净 |
|------|---------|
| `ESC[0m` / `ESC[1m` / `ESC[22m`（纯数字 SGR） | ✅ |
| `ESC[38:2:255:0:0m`（冒号分隔真彩 SGR） | ❌ 漏 |
| `ESC[?25l` / `ESC[?25h`（光标私有模式） | ❌ 漏 |
| `ESC[2J`（清屏） | ❌ 漏 |
| `ESC[2A`（光标上移） | ❌ 漏 |

漏剥率 **5/6**。更隐蔽的是：该正则**只在 `strip-ansi` 包加载失败时才生效**，即「输出卫生」取决于运行时包是否可用——不可接受的偶然性。

---

## 2. 设计目标与硬约束

### 2.1 核心诉求

| # | 诉求 | 本方案如何满足 |
|---|------|----------------|
| ① | **控制序列原子剥净** | 新增 `cli/ansiSanitizer.js` 作单一真源，完整覆盖 CSI/OSC/DCS/ESC-短序列/裸控制字符；「先删整段序列、再删裸控制字符」顺序不可颠倒 |
| ② | **不依赖运行时包可用性** | 自带零依赖实现；`stripAnsi.js` 由「lazy-load 包 + 弱正则兜底」改为直接委托单一真源，消除分叉 |
| ③ | **剥净后语义不被破坏** | 只删控制序列，**不动任何可见字符**；fence 内容由调用方保护（本层不感知代码块语义） |
| ④ | **渲染层不做输入卫生** | 渲染器（markdownRenderer / marked）保持「只认干净输入」的单一职责；卫生是上游门禁 |

### 2.2 防呆规则（不可违反）

1. **顺序敏感**：`_stripInvisible` 必须**先** `stripAnsiSequences`、**再** `CONTROL_CHARS`。颠倒会把 ESC 单独吃掉、留下孤儿参数——正是本方案要消灭的 bug。
2. **剥离顺序内层也敏感**：多字节序列（OSC/CSI/DCS）必须**先于** ESC 短序列执行。否则 `ESC]` 的 `]`、`ESC[` 的 `[` 会被两字节规则先吃掉，留下 OSC/CSI 主体成为可见垃圾。
3. **纯叶子契约**：`ansiSanitizer` 零 IO、零业务 require、确定性、**绝不抛**（非字符串原样返回）。
4. **裸参契约不变**：`stripAnsi(str)` 对非字符串**照旧抛 TypeError**（被收敛的五处调用点皆假定字符串输入）；不得为「更宽容」而改成强转，那会静默改变五处既有行为。
5. **只新增、最小改**：不改 `markdownRenderer` 的渲染逻辑、不改 `underscoreEmphasis` 的 flanking 正则（已正确）、不触碰核心调度器。

---

## 3. 架构：三层结构化输出契约

本方案把「模型自由文本 → 终端可见字符」的路径明确为三层，**任何一层都不允许把标记/控制码透传到屏幕**：

```
┌─────────────────────────────────────────────────────────────────┐
│ 第 0 层：输入卫生层（本方案新增的收口）                            │
│   ansiSanitizer.stripAnsiSequences()                             │
│   · CSI / OSC / DCS / ESC-短序列 / 裸控制字符 / 零宽               │
│   · 原子剥净，绝不残留参数碎片                                     │
│   · 消费方：modelTextNormalizer._stripInvisible、utils/stripAnsi   │
├─────────────────────────────────────────────────────────────────┤
│ 第 1 层：语义层（既有）                                           │
│   模型自由文本 → 语义 AST / Markdown 标记                          │
│   · underscoreEmphasis.js：CommonMark flanking 判定                │
│   · domain/structured/typeset/contentSchema.js：语义 AST 白名单     │
│   · turnEnvelope.js：回合结构化信封                                │
├─────────────────────────────────────────────────────────────────┤
│ 第 2 层：样式层（既有·单一真源）                                   │
│   typeset/textEmphasisPolicy.js：强调/标题层级/是否字面放大         │
│   · 终端无字号概念 → 字重+高对比+层级+留白，或 DEC 双宽             │
├─────────────────────────────────────────────────────────────────┤
│ 第 3 层：渲染层（既有）                                           │
│   markdownRenderer.js（CLI/TUI）· marked + DOMPurify（Web）        │
│   · 只认干净输入的语义标记，不承担卫生职责                          │
└─────────────────────────────────────────────────────────────────┘
```

**分层收益**：下划线问题的修复落在第 0 层，因此 CLI、TUI、Web SSE 三条出口**同时**受益，无需各自打补丁。

---

## 4. 实现

### 4.1 新增 `src/cli/ansiSanitizer.js`（单一真源）

覆盖范围（对齐 ANSI X3.64 / ECMA-48）：

| 序列族 | 正则 | 说明 |
|--------|------|------|
| CSI | `ESC [ 参数 中间符 终态` | SGR 颜色/样式、光标移动、擦除、私有模式 `?25l`、冒号真彩 `38:2::r:g:b` |
| OSC | `ESC ] … (BEL \| ESC \)` | 超链接、窗口标题、剪贴板 |
| DCS/SOS/PM/APC | `ESC (P\|X\|^\|_) … (ST \| BEL)` | 设备控制串 |
| ESC 短序列 | `ESC [中间符] 终态` | `ESC#6` 双宽、`ESC( B` 字符集、`ESC 7/8` 存取光标 |
| 裸控制字符 | `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]` | 保留 `\n`(0x0A) 与 `\t`(0x09) |
| 零宽字符 | `[\u200b-\u200d\u2060\ufeff]` | 小模型偶发，会撑坏列宽计算 |

导出 `stripAnsiSequences(text)`（剥离）、`hasAnsiSequences(text)`（判定，供按需触发与观测）。

### 4.2 改造 `modelTextNormalizer._stripInvisible`

```js
// 顺序敏感：先整段删 ANSI/CSI/OSC 序列，再删不属于任何序列的裸控制字符。
const sequenceFree = _ansiSanitizer
  ? _ansiSanitizer.stripAnsiSequences(text)
  : String(text);
return sequenceFree.replace(CONTROL_CHARS, '').replace(ZERO_WIDTH, '');
```

`fail-soft`：`ansiSanitizer` 缺失时退回原行为（`CONTROL_CHARS`），绝不因新模块缺失而让清洗整体失效。

### 4.3 改造 `utils/stripAnsi.js`

body 由 `str.replace(/\x1b\[[0-9;]*m/g, '')` 改为委托 `stripAnsiSequences(str)`；
非字符串分支保留原有的 `str.replace(...)` 以维持 **抛 TypeError** 的裸参契约。
五处调用点（`aiRenderer` / `hudRenderer` / `permissionDialog` / `textMeasure` / `diffViewer`）**逐字节不变**。

---

## 5. 为什么不选另一条路

| 备选方案 | 否决理由 |
|---------|---------|
| **只扩充 `CONTROL_CHARS` 字符类** | 字符类无法表达「CSI 参数 + 终止符」这种**多字符结构**。任何把 `[0-9;\[` 塞进字符类的做法都会误伤正文里合法的方括号与数字。 |
| **只依赖 `strip-ansi` npm 包** | 该包在 `utils/stripAnsi.js` 里 lazy-load，**加载失败即静默回退**到弱正则（实测漏 5/6）。输出卫生是每次对话都走的关键路径，不能有不生效的兜底分叉。 |
| **在渲染层（markdownRenderer / marked）兜底剥 ANSI** | 渲染器职责是「把标记转成样式」。让它承担卫生职责会使 CLI/TUI/Web 三条出口各写一份，且渲染前的宽度计算已被残留字符污染（列宽算错→换行错位），属于「病已发作才治」。 |
| **改 `underscoreEmphasis` 的 flanking 正则去容忍残留参数** | 治错了部位。flanking 判定是正确的（符合 CommonMark）；放宽它会让真正的 snake_case（`getUserName_or_default`）被误斜体，引回 2026-09-05 修掉的旧病。 |
| **前端改用支持 intraword 下划线的 markdown 库** | 前端 `marked@18` 实测**已正确**渲染 `_今天_` → `<em>今天</em>`（见 `differential.md` H4 证伪）。换库是无效改动，且引入新依赖。 |

---

## 6. 验证

### 6.1 复现（修复前 / 修复后）

| 文件 | 内容 |
|------|------|
| `repro-before.txt` | 修复前逐条探针原始输出（含 5/6 漏剥计数） |
| `repro-after.txt` | 修复后同一命令输出 |

关键对比（步骤 2 清洗结果）：

```
修复前： [1m_1m曲靖实况与预报（9月22日）_[0m     ← [1m / [0m 残留
修复后： _1m曲靖实况与预报（9月22日）_           ← 整段剥净
```

（注：修复后仍存在的 `1m` 是**本来就在 `_…_` 内部**的字面文本，非残留；该下划线已被 marked 正确渲染为 `<em>1m曲靖实况与预报（9月22日）</em>`。）

### 6.2 自动化测试

| 测试 | 结果 |
|------|------|
| `tests/ansiSanitizer.test.js`（新增，21 条：CSI 全覆盖 / ESC 短序列 / OSC·DCS / 保留正文与换行 / 纯叶子契约 / 截图回归） | ✅ PASS |
| `tests/stripAnsi.test.js`（预期随修复反转：`ESC[2A` 由「保留」改为「剥离」） | ✅ PASS |
| `tests/modelTextNormalizer.test.js` | ✅ PASS |
| 回归批次（`--testPathPattern "underscore\|markdown\|modelText\|renderer\|formatter"`，14 套 / 206 条） | ✅ 206/206 PASS |

### 6.3 守卫

| 守卫 | 结果 |
|------|------|
| `check:leaf-contract`（对新增文件单查） | ✅ 无违规 |
| `check:flag-registry` | ✅ 结构完好 |
| `check-agent-feedback --evidence=.khy/feedback/structured-output-20260922` | ✅ 0 error / 0 warning |
| `node --check`（三改文件语法） | ✅ |

### 6.4 验收标准（可复现命令）

```bash
# 1) 单一真源覆盖度
node .khy/feedback/structured-output-20260922/probe.js
# 期望：ANSI 段「漏剥: 0/6」

# 2) 端到端链路
node .khy/feedback/structured-output-20260922/probe3.js
# 期望：步骤 2 输出不含 [1m / [0m；步骤 3 输出含 <em>

# 3) 测试
./node_modules/.bin/jest --config services/backend/jest.config.js --rootDir services/backend \
  tests/ansiSanitizer.test.js tests/stripAnsi.test.js
# 期望：25 passed
```

---

## 7. 影响面与回退

**改动清单**（3 文件新增/改 + 2 测试 + 1 文档，未触及 `fix-blast-radius` 的「≥4 文件或 ≥3 顶层目录」阈值）：

| 文件 | 动作 |
|------|------|
| `services/backend/src/cli/ansiSanitizer.js` | 新增（单一真源，纯叶子） |
| `services/backend/src/cli/modelTextNormalizer.js` | 改 `_stripInvisible`（序列优先） |
| `services/backend/src/utils/stripAnsi.js` | 改 body 委托单一真源 |
| `services/backend/tests/ansiSanitizer.test.js` | 新增 |
| `services/backend/tests/stripAnsi.test.js` | 改 1 条预期（随修复反转） |

**回退**：删除 `ansiSanitizer.js` 后，`modelTextNormalizer` 的 `try/catch` 与
`stripAnsi.js` 的委托点即失去依赖 —— 为使回退不依赖未提交代码，回退动作 =
`git revert` 本任务提交（提交信息将引用本文档编号与规则 ID）。三处改动均为**结构性新增**，
无数据迁移、无状态残留。

**风险**：`stripAnsi` 的剥离面由「仅纯数字 SGR」扩大为「全部控制序列」。对既有的
5 处调用点（宽度计算 / 权限弹窗 / diff 视图）而言，输入本就是自己生成的 `ESC[…m`，
新实现的剥离是其**超集**；实测 206 条相关回归全绿。

---

## 8. 与既有机制的关系

- **不与 `underscoreEmphasis` 的对抗式自愈冲突**：该机制处理「下划线**滥用**」（snake_case 密集时自动关渲染）；本方案处理「**残留参数导致合法强调无法成立**」。两者正交：前者是策略选择，后者是输入卫生。
- **复用既有分层**：`domain/structured/typeset/*` 已是「内容与样式分离」真源（见 `[DESIGN-ARCH-023]`），本方案把自己的第 0 层挂在它上游，不重复实现样式决策。
- **`outputIntegrityMonitor` 已有 `underscore-abuse` 信号**，此前注释称「渲染层已通过 adaptiveUnderscorePolicy 自动修复，此处仅记录」。本方案补上它未覆盖的那一类：**上游污染型**下划线裸露（非滥用，而是配对被破坏）。
