<!-- 文档分类: DESIGN-ARCH-019 | 阶段: 设计 | 原路径: docs/03_DESIGN_设计/[DESIGN-ARCH-019] 用户输入预处理规范.md（新建） -->
# khyos 用户输入预处理规范（Input Sanitization）

> 版本 v1.0（2026-06-12）。本文定义 khyos 生态底座在**把用户输入送入模型之前**的
> 轻量预处理机制：清洗「乱输入」中的**纯噪声**（控制/零宽字符、乱码替换符、刷屏式
> 重复标点、过量空白/空行、连续重复行），以**降低 token 消耗**、提升模型对有效内容的
> 聚焦，同时**绝不修改有效信息**。
>
> 关键词 **必须 / 严禁 / 应 / 可** 按 RFC 2119 语义。

---

## 0. 目标与非目标

**目标**
- **减少 token 消耗**：过滤刷屏、重复、不可见等纯噪声字符，只保留有效信息。
- **正确处理乱输入**：在送入模型前完成清洗 / 结构化 / 矫正，避免模型为无效内容付费。
- **轻量集成**：在输入流程的单一收敛点一行接入，**不**改提示词、**不**改模型调用逻辑、
  **不**破坏任何核心业务逻辑。

**非目标**
- **不**做语义改写 / 翻译 / 摘要 / 纠错（那会改动有效信息，且需反向消耗模型 token）。
- **不**调用任何 LLM：本模块全部是**确定性字符串变换**，零模型、零网络、零外部依赖。
- **不**替代既有 `inputPurify`（表情/口头禅剥离）与 `inputPreprocessor`（股票代码/缩写
  归一）；本模块**互补**它们，只负责它们都不处理的「乱输入噪声」一层。

---

## 1. 自调查结论（接入前现状）

khyos 在用户输入到达模型前，已有两层与一处安全检查，但**均不针对「乱输入」噪声**：

| 现有环节 | 位置 | 作用 | 缺口 |
|---|---|---|---|
| `securityGuardService.analyzeInput` | `services/securityGuardService.js` | 安全/越权拦截 | 不处理噪声 |
| `khyUpgradeRuntime.inputPurify` | `services/khyUpgradeRuntime.js` | 剥离 emoji / 口头禅 / 客套 | 云端原生工具适配器下跳过；不处理重复标点/控制字符/重复行 |
| `inputPreprocessor.preprocess` | `services/inputPreprocessor.js` | 股票代码/缩写归一、trim | 仅旧 `queryEngine` 全量启用，REPL 仅部分；不处理噪声字符 |

**结论**：缺一层专门过滤「刷屏标点、控制/零宽字符、乱码替换符、过量空白/空行、
连续重复行」的轻量清洗。本规范新增 `inputSanitizer.js` 补齐，**不改**上述任一环节。

---

## 2. 处理流程

收敛点：`cli/ai.js` 的 `chat()`，在**去除指令（directive）之后、拼接多模态上下文
（promptAugment）之前**，对**用户原文**调用一次 `sanitizeForModel()`。仅作用于用户原文，
不触及后续上下文、提示词与模型调用。

```
用户原文
  └─ securityGuardService.analyzeInput   （安全拦截，既有，不改）
  └─ directiveParser.stripDirectives     （指令剥离，既有，不改）
  └─ inputSanitizer.sanitizeForModel  ◄── 本规范新增（一行接入，失败回退原文）
  └─ + multimodalInput.promptAugment     （多模态上下文拼接，既有，不改）
  └─ runtime.inputPurify                 （emoji/口头禅剥离，既有，不改）
  └─ → 模型
```

`sanitize()` 内部管线（纯函数，顺序固定，幂等）：

```
保护代码  → 清洗噪声字符 → 矫正(标点/可选字母折叠) → 结构化(空白/空行/重复行) → 还原代码
(``` 与 `…`)  (控制/零宽/         (刷屏标点折叠)        (多空格→单、行尾、       (占位符
  抽出占位符    替换符/异常空白)                          空行折叠、重复行去重)     原样放回)
```

三类处理对应任务诉求：
- **清洗**：删除控制字符（保留 `\n` `\t`）、零宽字符/BOM、`U+FFFD` 替换符；异常空白归一。
- **矫正**：折叠刷屏式重复标点（`！！！！！！！！！！` → `！！！`）；**可选**字母长串折叠。
- **结构化**：行内多空格→单空格、清行尾空白、连续空行折叠、连续重复行去重。

---

## 3. 防呆（硬约束）

| 风险 | 对策 |
|---|---|
| 改动有效信息 | **字母与数字字符级内容一律不动**；`数字串永不折叠`（避免 `10000000`→`1000`）；矫正只折叠**标点/符号**运行 |
| 破坏代码 | ``` ```围栏``` `` 与 `` `行内代码` `` 在清洗前抽出为私有区(PUA)占位符，清洗后**原样还原**，内部一字不改 |
| 处理后退化 | 结果变空 / 原文有有效内容(字母/数字/CJK)而结果全无 → **回退原文** |
| 处理异常 | 管线任何抛出 → **回退原文**；`sanitizeForModel` **永不抛**，最坏返回原字符串 |
| 误伤正常输入 | 阈值保守（标点连续 ≥4 才折叠、字母折叠默认**关**、空行上限 1）；正常输入零改动 |
| 极端开销 | 超长输入（默认 >200000 字符）跳过，原样返回 |
| 误启用 | 主开关 `KHY_INPUT_SANITIZE=0` 可整体关闭；默认开但保守 |

**核心不变量**：`sanitize` 只**删除/折叠确定性噪声**，绝不新增、改写、重排有效字符。
幂等：`sanitize(sanitize(x)) === sanitize(x)`。

---

## 4. 配置

配置来源（优先级从低到高）：`DEFAULTS` ← JSON 文件 `getDataHome()/input_sanitizer.json`
← 环境变量。任一步失败安全降级到上一层，绝不抛。

| 配置项 | 默认 | env 覆盖 | 说明 |
|---|---|---|---|
| `enabled` | `true` | `KHY_INPUT_SANITIZE` | 主开关（0/false/off 关闭） |
| `stripControlChars` | `true` | — | 删控制字符（保留 `\n` `\t`） |
| `stripZeroWidth` | `true` | — | 删零宽字符/BOM/软连字符 |
| `stripReplacementChar` | `true` | — | 删 `U+FFFD` 乱码替换符 |
| `collapseWhitespace` | `true` | — | 行内多空格/制表符→单空格 |
| `maxBlankLines` | `1` | `KHY_INPUT_SANITIZE_MAX_BLANK_LINES` | 连续空行上限 |
| `collapsePunctRun` | `true` | — | 折叠刷屏标点 |
| `maxPunctRun` | `4` | `KHY_INPUT_SANITIZE_MAX_PUNCT_RUN` | 同一标点连续 ≥ 此数才折叠 |
| `punctRunKeep` | `3` | `KHY_INPUT_SANITIZE_PUNCT_KEEP` | 折叠后保留个数 |
| `collapseLetterRuns` | `false` | `KHY_INPUT_SANITIZE_LETTER_RUNS` | 字母长串折叠（默认关，保守） |
| `maxLetterRun` / `letterRunKeep` | `8` / `3` | — | 字母折叠阈值/保留 |
| `dedupLines` | `true` | — | 连续重复行去重 |
| `maxLineRepeat` / `lineRepeatKeep` | `3` / `3` | `KHY_INPUT_SANITIZE_MAX_LINE_REPEAT` | 重复行阈值/保留 |
| `trimTrailingWs` | `true` | — | 行尾空白清除 |
| `maxInputChars` | `200000` | — | 超长跳过阈值 |

JSON 文件示例（`~/.khyquant/input_sanitizer.json`）：

```json
{ "maxPunctRun": 3, "collapseLetterRuns": true, "maxBlankLines": 0 }
```

---

## 5. 示例

| 输入（乱） | 输出（净） | 说明 |
|---|---|---|
| `帮我分析下茅台！！！！！！！！！！谢谢？？？？？？` | `帮我分析下茅台！！！谢谢？？？` | 刷屏标点折叠 |
| `成本是10000000元对吧` | `成本是10000000元对吧` | **数字永不折叠** |
| `买入\n买入\n买入\n买入\n买入` | `买入\n买入\n买入` | 连续重复行去重 |
| `第一行\n\n\n\n\n第二行` | `第一行\n\n第二行` | 空行折叠 |
| `贵<ZWSP>州<BOM>茅台` | `贵州茅台` | 零宽/BOM 清除 |
| `请   帮我   查询` | `请 帮我 查询` | 行内空白归一 |
| ``看这段\n```js\nconst x=1;;;;;;;;\n````` | （代码块原样保留） | 代码保护，内部不动 |
| `请帮我查询贵州茅台今天的收盘价。` | （不变） | 正常输入零改动 |

---

## 6. 接口

```js
const S = require('services/inputSanitizer');

// 便捷接口（接入用）：返回可直接送模型的字符串，永不抛，回退即原文。
const clean = S.sanitizeForModel(userText);                  // string
S.sanitizeForModel(userText, { onStats: (r) => log(r.stats) }); // 可观测 token 节省

// 完整接口（需要统计/原因时）：
const r = S.sanitize(userText);
// → { original, sanitized, changed, fellBack, reason,
//     stats: { beforeChars, afterChars, savedChars, beforeTokens, afterTokens, savedTokens } }

S.loadConfig(env?);  // 解析配置（DEFAULTS ← JSON ← env）
S.DEFAULTS;          // 冻结的默认配置
```

`reason` 取值：`disabled` / `empty` / `too-large` / `unchanged` / `sanitized` /
`degenerate-empty`（退化回退）/ `essential-lost`（丢失有效内容回退）/ `error:<msg>`（异常回退）。

---

## 7. 边界（只新增预处理模块）

- **新增**：`services/backend/src/services/inputSanitizer.js`、对应测试。
- **改动（仅一行接入）**：`cli/ai.js chat()` 在 directive 剥离后、promptAugment 前
  调用 `sanitizeForModel`，try/catch 回退原文。
- **零改动**：任何提示词、模型调用逻辑、`inputPurify`、`inputPreprocessor`、调度循环、业务算法。
- 集成点失败一律回退原文，**严禁**阻断主流程。

---

## 8. 落地检查清单

- [x] 纯规则、零模型、零外部依赖、幂等（§0/§3）
- [x] 数字永不折叠、有效字符不改、代码块原样保护（§3）
- [x] 任何异常/退化回退原文，`sanitizeForModel` 永不抛（§3）
- [x] 阈值保守、正常输入零改动（§3/§5）
- [x] env / JSON 可配置，主开关可整体关闭（§4）
- [x] 单点一行接入，不改提示词与模型调用逻辑（§2/§7）
- [x] token 统计可观测（§6）
- [x] 测试覆盖 清洗/矫正/结构化/代码保护/回退/幂等/配置/统计（42 用例绿）
