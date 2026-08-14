<!-- 文档分类: OPS-MAN-171 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-171] 技能包规范-manifest与prompt模板.md -->
# 技能包规范（`manifest.json` / `SKILL.md`）

> 本文说明 khy 技能包（skill package）的目录结构与字段规范，并给出可直接复制的模板。khy 支持两种等价的技能描述方式：**目录式（`manifest.json` + `prompt.md`）** 与 **单文件式（`SKILL.md` + YAML frontmatter）**。
>
> 实现依据（核实来源）：目录式加载与字段归一见 `services/backend/src/skills/index.js`（`_buildSkill`）；单文件式解析见 `services/backend/src/skills/skillLoader.js`（`parseSkillFile` / `_parseYamlSimple` / `validateSkill`）；发现优先级见两者的发现函数；落盘命名见 `services/backend/src/services/skillPackageService.js`。

---

## 一、两种技能包形态

### 形态 A：目录式（推荐，CC 对齐）

```
skill-name/
  manifest.json    # 必填：元数据（name、description、trigger…）
  prompt.md        # 可选：调用时注入的提示词模板
  handler.js       # 可选：自定义执行逻辑（优先于 prompt.md）
```

- `index.js` 只加载**含 `manifest.json`** 的子目录。
- 执行时：有 `handler.js` 走处理器；否则返回 `prompt.md`；两者都缺则报错。因此 `prompt.md` 与 `handler.js` **至少要有一个**。

### 形态 B：单文件式（遗留 / Claude Code 兼容）

```
skill-name/
  SKILL.md         # YAML frontmatter + Markdown 正文
```

- `skillLoader` 递归扫描含 `SKILL.md` 的目录，解析 frontmatter 为 `meta`，正文为 `body`。
- 该形态被转换为统一结构后并入技能目录（`manifest` 形态优先，同名不覆盖）。

> 说明：`khy skill add` 的技能定位只要目录里含 `SKILL.md` **或** `manifest.json` 即认；但要在 REPL 里作为可调用命令出现并能执行，建议至少提供 `manifest.json` + `prompt.md`（或 `handler.js`），或一个带完整 frontmatter 的 `SKILL.md`。

---

## 二、`manifest.json` 字段规范

字段命名与归一逻辑核实自 `index.js._buildSkill`（同时兼容 `snake_case` / `kebab-case` / `camelCase` 若干写法）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | **必填** | 技能唯一标识；缺失则该技能被跳过（`_buildSkill` 返回 null）。落盘目录名也优先取它。 |
| `description` | string | 建议 | 简短描述，出现在技能目录列表里。 |
| `trigger` / `command` | string | 可选 | 斜杠命令；不带 `/` 会自动补。缺省为 `/<name>`。 |
| `user_invocable` / `userInvocable` | boolean | 可选 | 是否对用户可见可调用。默认 `true`。 |
| `aliases` | string[] | 可选 | 备用触发词（如 `["/dl-video"]`）。 |
| `category` | string | 可选 | 分类，默认 `others`。 |
| `tags` | string[] | 可选 | 搜索标签。 |
| `platforms` | string[] | 可选 | 适配平台（如 `cosh`、`claude-code`、`khy-quant`）；空视为通用。 |
| `paths` | string[] | 可选 | glob 条件激活；命中 cwd/最近文件才激活。`null`/缺省 = 始终激活。 |
| `when_to_use` / `whenToUse` | string | 可选 | 「何时使用」提示，注入目录时作为 use-when 提示。 |
| `allowed-tools` / `allowed_tools` / `allowedTools` | string[] 或逗号/空格分隔字符串 | 可选 | handler 运行时的工具白名单。缺省 = 不限制。 |
| `disable-model-invocation` 等写法 | boolean | 可选 | 为真时模型不能通过 SkillTool 调用（人类 CLI 仍可）。默认 `false`。 |
| `context` | `"inline"` \| `"fork"` | 可选 | 执行上下文。非 `fork` 一律视为 `inline`。 |
| `model` | string | 可选 | 指定模型；缺省 `null`。 |

最小可用 `manifest.json`：

```json
{
  "name": "my-skill",
  "description": "One-line description shown in the skill catalog.",
  "trigger": "/my-skill",
  "user_invocable": true
}
```

---

## 三、`SKILL.md` frontmatter 规范

单文件式用 YAML frontmatter 描述元数据，正文是注入给 AI 的指令。字段核实自 `skillLoader.validateSkill` 的告警项与 `_parseYamlSimple` 的解析能力。

```markdown
---
name: linux-admin
version: 1.0.0
description: Linux system administration skill
layer: system              # system | application | domain
lifecycle: operations      # development | testing | deployment | operations | maintenance
tags: [linux, sysadmin]
platforms: [cosh, claude-code, khy-quant]
dependencies: [shell-scripting]
---

# Skill Title

... markdown body: instructions for the AI ...
```

- `validateSkill` 会对缺失 `name`/`version`/`description`/`layer`/`tags`/`platforms` 给出告警（非致命）。
- `_parseYamlSimple` 支持：标量、内联数组 `[a, b]`、块状列表（`key:` 后跟 `- item`）、布尔、数字、带引号字符串。**不支持**嵌套对象等复杂 YAML，请保持扁平。
- 无 frontmatter 时，整个文件作为正文，`name` 兜底取所在目录名。

---

## 四、`prompt.md` 与 `handler.js`

### `prompt.md`

纯 Markdown，作为提示词模板在技能被调用时注入。可在正文里描述该技能要做什么、如何使用参数（参数以字符串形式随调用传入）。

### `handler.js`（可选）

导出 `execute(args, context)` 或本身是函数，返回字符串或可序列化对象（核实自 `index.js.executeSkill`）：

```javascript
'use strict';

// args: string passed after the trigger; context: { cwd, ... }
async function execute(args, context) {
  return `handled: ${args || ''}`;
}

module.exports = { execute };
```

- 有 `handler.js` 时优先于 `prompt.md` 执行。
- 若 manifest 声明了 `allowed-tools`，handler 运行期间该白名单会被强制生效。

---

## 五、可复制模板与示范技能包

`.khy/skills/` 下提供了 3 个可直接复制修改的示范技能包（结构与 loader 实际识别格式一致）：

| 目录 | 形态 | 组成 | 用途 |
| --- | --- | --- | --- |
| `.khy/skills/example-prompt-skill/` | 目录式 | `manifest.json` + `prompt.md` | 纯提示词注入型技能的最小模板。 |
| `.khy/skills/example-handler-skill/` | 目录式 | `manifest.json` + `prompt.md` + `handler.js` | 带自定义 `handler.js` 的技能模板（本地计算、返回结构化结果）。 |
| `.khy/skills/example-legacy-skill/` | 单文件式 | `SKILL.md` | Claude Code 兼容的遗留 frontmatter 单文件模板。 |

复制其一到 `<dataHome>/skills/<你的技能名>/`，改 `name`/`trigger`/正文即可；重启 REPL 后即被自动发现。

---

## 六、相关文档

- [OPS-MAN-170] 外部技能安装-khy-skill-add —— 从仓库安装技能的命令、源格式与 FAQ。
- [OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp —— skill 命名与治理规则。
