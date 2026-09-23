# [DESIGN-SKILL-001] Skill 编写规范

<!-- RULES-REGISTRY: SKILL-001 -->

> **定位**：本文件回答一个问题——**写一个 khy Skill 时，`manifest.json` 的字段填什么、
> `prompt.md` 怎么组织、什么时候该拆成多个文件**。它是 Skill **作者侧**的书写约束。
>
> **边界**（与相邻规范谁管什么）：
> - 本文件管**怎么写**（内容与字段形态）；`[DESIGN-TOOL-002]` 管**什么是核/什么是拓展**（收纳边界）；
>   `[DESIGN-ARCH-116]` 管**运行时契约**（`@khy-plugin-sdk` 的加载与调用时序）。
> - 本文件**不重复** `FILE-FORMAT-PROTOCOL` 的通用格式规定（LF / 标题层级 / 代码块语言），
>   只补 Skill 特有的约束。
>
> **规则 ID**：`SKILL-001`。登记见 `docs/10_规范/registry/RULES-REGISTRY.json`。
> **上游依据**：`[DESIGN-ARCH-121]` §K-09（对黄佳《Claude Code 实战：Harness 工程之道》
> ch03 §3.4 的借鉴与 khyos 本地化）。

---

## 1. 红线

| # | 必须 / 禁止 | 判据 |
| --- | --- | --- |
| SK-1 | **description 必须四段式**，且触发短语必须落在**前 60 字符**内 | 见 §2 模板；`scripts/ci/check-skill-triggers.js` |
| SK-2 | description **不得超过 1024 字符** | 实测本仓 43 个 manifest，最长 485（`interview-me`），平均 167 |
| SK-3 | **必须写 `when_to_use`**；不写即视为未完成 | 实测 **16/43** 已填，缺口 27 个 |
| SK-4 | `when_to_use` **不得超过 120 字符** | 渲染层在此截断（`skills/index.js` 的 `hintLen`） |
| SK-5 | 任务型 Skill **必须**显式声明 `disableModelInvocation` | 缺省会被注入目录、挤占预算 |
| SK-6 | 需要工具的 Skill **必须**写 `allowed-tools`，**禁止**留空表示「全部允许」 | 最小权限；留空 = 无限权限 |
| SK-7 | `allowed-tools` 的 Bash 项**必须**用前缀形式，且用 `:*` 而非 ` *` | 见 §3 语法差异（**这是实测踩过的坑**） |
| SK-8 | 触发短语**必须**是可命中的具体词，禁止 `help` / `assist` / `general` 等空泛词 | 评审 checklist |
| SK-9 | 细则**必须**下沉 `reference/`，禁止把全文塞进 `prompt.md` | 渐进式披露；见 §4 |

---

## 2. description 四段式（khyos 本地化版）

书侧（ch03 §3.4.2）用三段式 `What / When / Not For`。khyos **多一段且提到最前**，
原因是实测的渲染预算极紧——见 §5。

```json
{
  "description": "<触发短语前置> <What> <When> <Not For>",
  "when_to_use": "<≤120 字符的简短触发语>"
}
```

| 段 | 作用 | 写法要求 | 长度建议 |
| --- | --- | --- | --- |
| 0. **触发短语前置** | khyos 特有。触发信号必须在**前 60 字符**内出现 | 用用户真会说出口的词，不用类名 | ≤60 |
| 1. What | 这技能做什么 | 一句话，动词开头 | 60–120 |
| 2. When | 什么时候用 | 多个 `Use when ...` 短句 | 80–200 |
| 3. Not For | 什么时候**不**用（防误触发） | `Not for ...`，点名相邻技能 | 40–100 |

**反例 → 正例**

| ❌ 反例 | 问题 | ✅ 正例 |
| --- | --- | --- |
| `"Helps with skills."` | 空泛词、无触发信号、无 When | `"创作和修改 khy Skill：写 manifest.json、组织 prompt.md、配 allowed-tools。Use when 用户要新建/改一个 skill。Not for 插件系统契约（见 ARCH-116）。"` |
| `"A comprehensive guide to ..."` | What 段冗长，触发短语被推到 200 字符外 | `"<触发词>。..."` |

---

## 3. `allowed-tools` 的语法差异（**实测踩过的坑，勿混用**）

khyos 有**两套**互不相通的写法，混用会**静默失效**：

| 载体 | 语法 | 真源 |
| --- | --- | --- |
| **Skill 的 `allowed-tools`** | `Bash(npm run test:*)` —— 前缀 + `:*` | `toolCalling.js:212` `_checkActiveSkillPolicy` |
| **权限的 `patternRules`** | `{ toolName:"Bash", pattern:"npm run *" }` —— glob | `permissionStore.js` `_patternRules` |

> ⚠️ **另有一条实测陷阱**：Skill 的 `allowed-tools` 闸门**仅对 handler 技能生效**——
> 激活点在 `if (skill.handlerPath && fs.existsSync(skill.handlerPath))` 块内。
> 实测本仓 **0/43** 技能有 handler，故**现阶段该字段配了也不会被强制**。
> 这不是「不用配」，而是「配了是给未来留契约」——按 SK-6 仍必须配。

**前缀必须用 `:*` 的理由**：`Bash(git *)` 里的 ` *` 是 **glob 单星**，
而 `Bash(git:*)` 是**前缀标记**。两者在 `patternMatcher` 与 Skill 闸门里语义不同，
写错后既不报错也不生效。**统一写 `:*`。**

---

## 4. 渐进式披露：三档按需加载

书的做法（ch03 §3.4.3）：`description` → `SKILL.md` 正文 → `reference/` 按需，
声称省 50%–98% Token。khyos 的对应物：

| 档 | 书的载体 | khyos 载体 | 何时进上下文 |
| --- | --- | --- | --- |
| 1 | `description` 字段 | `manifest.json` 的 `description` + `when_to_use` | **总是**（目录清单） |
| 2 | `SKILL.md` 正文 | `prompt.md` | 技能被激活时 |
| 3 | `reference/*.md` | `reference/*.md` | 模型显式读取时 |

**约束**：`reference/` 里每个文件**必须有独立标题**且**可被单独读懂**——
因为模型可能只读其中一份。禁止跨文件用「见上文」。

---

## 5. description 预算机制（**这是 SK-1 到 SK-4 的根本原因**）

khyos 的技能目录清单有**字符预算**：

```text
charBudget = clamp(1% × contextWindowTokens × 4, 500, 8000)     constants/prompts.js:2119-2125
  128K 上下文 → 5120 字符          KHY_SKILL_CATALOG_CHARS 可覆盖
```

`formatSkillListing()`（`services/backend/src/skills/index.js`）的降档逻辑：

1. 首渲染用 `descLen = 250`（`:278`）
2. 总和 ≤ 预算 → 直接返回
3. 超预算 → 按 `availableForDescs / 技能数` **统一压缩每个 description**（`:293`）

> 📌 **2026-09-18 实测**：43 技能 / 5120 预算下，`maxDescLen` 被压到 **62** 字符。
> 而**触发短语必须在前 60 字符内**（SK-1）——两者几乎相等**不是巧合**，
> 正是因为预算压缩到 62，触发信号一旦不在前 60 就**必被截掉**，技能从此检索不到。
>
> **同时实测到并行修订**：`overhead` 的计算已加入 `hintLen()`，把 `when_to_use`
> 的长度也计入预算（此前漏算，导致一批填充了 `when_to_use` 的技能静默溢出预算）。
> → 这使 SK-4 的 120 字符上限成为**硬约束**。

**收益测算**（移出任务型技能可释放的 desc 空间）：

| 移出数量 | 5 | 10 | 15 |
| --- | --- | --- | --- |
| `maxDescLen` | 78 | 100 | 131 |

→ **任务型技能改 `disableModelInvocation: true` 是当前性价比最高的动作**（SK-5）。

---

## 6. 校验（守卫）

| 红线 | 守卫 | 状态 |
| --- | --- | --- |
| SK-1 / SK-2 / SK-3 / SK-4 / SK-8 | `scripts/ci/check-skill-triggers.js` | **待建**（`[DESIGN-ARCH-121]` §K-08） |
| SK-5 / SK-6 / SK-7 | 无自动守卫，评审 checklist | 待工具化 |
| SK-9 | 无自动守卫 | 待工具化 |

> ⚠️ **`check-skill-triggers.js` 属概率性检查（触发命中靠语义判断），
> 建议不进三守卫，只做独立脚本**——否则会给门禁带来不稳定的红。

---

## 7. 版本历史

| 日期 | 变更 |
| --- | --- |
| 2026-09-18 | 首版。依据 `[DESIGN-ARCH-121]` §K-09，把书的 description 三段式本地化为四段式（触发短语提到最前），并补入 khyos 特有的预算机制实测数据（`maxDescLen = 62`）。`allowed-tools` 双语法差异与「仅 handler 技能生效」的实测陷阱一并写入 §3。 |
