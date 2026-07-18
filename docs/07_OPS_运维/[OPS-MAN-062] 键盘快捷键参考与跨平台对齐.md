<!-- 文档分类: OPS-MAN-062 | 阶段: 运维 | 主题: 键盘快捷键跨平台参考与 khyos 对齐 -->
# [OPS-MAN-062] 键盘快捷键参考 · Windows / Linux 跨平台与 khyos 对齐

> **参考手册** · 面向刚上手的用户，说明 Claude Code 交互模式在不同系统下的键盘快捷键差异，并对照 khyos 自身 TUI 已对齐 / 仍有差异的键位。
>
> **一句话定位**：Claude Code 的键位在 Windows 与 Linux 上**大体一致**，差异集中在**换行**（Shift+Enter 需终端支持）与**贴图片**（Ctrl+V vs Alt+V）两处；khyos 的交互式 TUI **已 ~90% 对齐 CC**，本轮又补齐了 `\`+Enter 续行与 Ctrl+R 反向历史搜索。
>
> **关联规范**：键位真源是代码里的 `src/services/keybindings/keybindingCatalog.js`（驱动 `/keybindings` 命令与 `?` 帮助浮层）。本文与它保持一致，避免两处漂移。

---

## 0. 这是什么

这是一份**跨平台键盘快捷键参考**，回答两个问题：

1. Claude Code 交互模式下常用键都是什么，Windows 和 Linux 上有什么差异。
2. khyos 自己的交互式 CLI（`khy chat` 的 Ink TUI）**对齐到了哪些**，哪些**刻意不同或暂无**。

**适用范围**：交互式提示输入框（你敲命令 / 提问的那一行）。不涉及非交互脚本、`khy run <task>` 一次性调用。

**SSOT 指针（重要）**：键位的**唯一真源**是代码里的 `keybindingCatalog.js`。随时可以：

- 在 TUI 里敲 `/keybindings` 查看**完整**分组键位表；
- 在**空输入框**按 `?` 弹出精简的快捷键浮层。

本文档是**给人读的解释与跨平台差异说明**；当两者出现分歧，以 `/keybindings` 的实时输出为准。

---

## 1. 最先记住的几个

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送消息 |
| `\` + `Enter` | 行尾反斜杠续行：删掉反斜杠、换行而不发送（见 §2） |
| `Esc` | 中断当前回合 / 取消计划评审 |
| `Esc` `Esc`（连按两次） | 清空输入框 / 回溯上一步 |
| `Ctrl + C` | 忙时中断当前回合；空闲时连按两次退出 |
| `Ctrl + D` | 有文本时向后删除；空行时连按两次退出 |
| `Shift + Tab` | 切换权限模式（循环 4 档） |

这七个覆盖 90% 的日常操作。其余键都是「锦上添花」，用到再查。

---

## 2. 换行：Windows 与 Linux 差异

想在一条消息里换行（写多行 prompt）而不发送，有几种办法，**可用性因终端而异**：

| 方式 | Windows | Linux | 说明 |
| --- | --- | --- | --- |
| `\` + `Enter` | ✅ 通用 | ✅ 通用 | **最稳妥的兜底**：任何终端都work。行尾打一个反斜杠再回车。 |
| `Shift + Enter` | ⚠️ Windows Terminal 原生支持；VS Code / Cursor 内置终端需先跑 `/terminal-setup` | ⚠️ 多数现代终端支持，少数需配置 | 终端要把 Shift+Enter 作为独立序列上报才生效。 |
| `Alt + Enter` | ⚠️ 视终端 | ⚠️ 视终端 | 备选；不如 `\`+Enter 通用。 |
| `Ctrl + Enter` | ⚠️ 视终端 | ⚠️ 视终端 | 备选。 |

**建议**：拿不准时统一用 `\` + `Enter`——它在所有系统、所有终端下都可靠。

> **VS Code / Cursor 用户**：如果 `Shift+Enter` 直接发送而不是换行，在 TUI 里跑一次 `/terminal-setup` 配置终端集成。

---

## 3. 历史导航

| 键 | 作用 | 跨平台 |
| --- | --- | --- |
| `↑` / `↓` | 单行时浏览历史命令；多行时在缓冲内上下移动 | 一致 |
| `Ctrl + R` | 反向增量搜索历史命令（见下） | 一致 |

**Ctrl+R 反向搜索**（类似 bash 的 `reverse-i-search`）：

1. 按 `Ctrl + R` 打开搜索行，开始打字即增量匹配（大小写不敏感子串）。
2. 命中按**最新→最旧**排序，先选中最新的一条。
3. 再按一次 `Ctrl + R` 跳到**更旧**的一条匹配（到最旧一条停住，不回绕）。
4. `Enter` 或 `Tab`：把选中的历史命令**灌入输入框**（可继续编辑）。
5. `Esc` / `Ctrl + C`：取消，输入框保持原样。

> **历史范围的诚实说明**：Claude Code 按 **project 目录** 分别记历史；khyos 用**全局单文件**（`~/.khyquant_history`）。所以 khyos 的 ↑/↓ 与 Ctrl+R 会看到跨目录的所有历史，这是刻意的取舍（见 §9）。

---

## 4. 四个输入前缀

在**空输入框行首**敲这些字符会切换输入模式：

| 前缀 | 模式 | 作用 |
| --- | --- | --- |
| `!` | bash 模式 | 直接运行 shell 命令 |
| `#` | 记忆模式 | 把这行写入记忆（下次对话生效） |
| `/` | 命令模式 | 斜杠命令菜单（`/model`、`/vim`、`/keybindings` …） |
| `@` | 文件引用 | 引用文件路径（带补全） |

外加 `?`：在空输入框显示 / 隐藏快捷键浮层。

---

## 5. 行内光标移动（emacs 风格）

| 键 | 作用 |
| --- | --- |
| `Ctrl + A` / `Ctrl + E` | 移到行首 / 行尾 |
| `Ctrl + B` / `Ctrl + F` | 左移 / 右移一个字符 |
| `Ctrl + K` / `Ctrl + U` | 删除到行尾 / 行首 |
| `Ctrl + W` | 删除前一个词 |
| `Ctrl + Y` | 粘回（yank）上次删除的内容 |
| `Alt + B` / `Alt + F` | 按词左移 / 右移 |
| `Alt + D` | 删除后一个词 |
| `Meta + Backspace` | 删除前一个词 |

> **Alt 键的坑**：`Alt + B/F/D` 要求终端把 `Alt` 当作 `Meta` 上报。**Linux 终端默认可用**；**macOS 上**多数终端需在设置里勾选「Use Option as Meta key」。Windows Terminal 一般可用。

---

## 6. 进阶键

| 键 | 作用 | khyos 现状 |
| --- | --- | --- |
| `Ctrl + O` | 展开 / 折叠过程组与工具输出 | ✅ 已对齐（语义与 CC 的「切换 transcript」略有不同，见 §9） |
| `Ctrl + T` | 显示 / 隐藏任务清单面板 | ✅ 已对齐 |
| `Ctrl + L` | 清屏（清除已提交的对话记录） | ✅ 已对齐 |
| `Ctrl + G` | CC：打开外部编辑器编辑当前输入 | ⚠️ khyos 暂无（诚实标注，见 §9） |
| 消息排队 | 忙时继续键入，回合结束后按序发送 | ✅ 支持 |

---

## 7. Vim 模式

在 TUI 里跑 `/vim` 开启模态编辑：

- `Esc` 回 NORMAL，`i` 进 INSERT，`v` 进 VISUAL；
- `h` / `j` / `k` / `l` 移动；
- `dd`（删行）、`cw`（改词）、`u`（撤销）等常用算子；
- **不支持** `Ctrl + V` 块选（与 CC 一致的取舍）。

底部状态行显示 `-- NORMAL --` / `-- INSERT --`。

---

## 8. 贴图片：Windows vs Linux

| 系统 | 键 | 说明 |
| --- | --- | --- |
| Linux / macOS | `Ctrl + V` | 把剪贴板图片暂存到下一回合 |
| Windows / WSL | `Alt + V` | Windows 上 `Ctrl + V` 是终端自身的粘贴键、到不了应用，故改用 `Alt + V`（在 Ink 里表现为 `Meta + v`） |

> **最稳妥的办法**：不确定时，直接**在 prompt 里写图片文件路径**（配合 `@` 补全），跨平台零歧义。

---

## 9. khyos 对齐现状（诚实两栏）

khyos 的默认交互界面是 **Ink(React) TUI**，代码里明确对齐 Claude Code 的 `keybindings/defaultBindings.ts`。下面如实分两栏。

### ① 已对齐 CC 的键位

- 行编辑：`Ctrl + A/E/B/F/K/U/W/Y`
- 按词：`Alt + B/F/D`、`Meta + Backspace`
- 换行：`Shift / Alt / Ctrl + Enter`、**`\` + Enter**（本轮新增）
- 历史：`↑` / `↓`、**`Ctrl + R` 反向搜索**（本轮新增）
- 权限模式：`Shift + Tab` 四档循环
- 前缀入口：`!` / `#` / `/` / `@` / `?`
- 退出 / 中断：`Ctrl + C`、`Ctrl + D` 双击，`Esc` / `Esc·Esc`
- 视图：`Ctrl + L`、`Ctrl + O`、`Ctrl + T`
- Chat chord：`Meta + P`（模型选择器）/ `Meta + O`（fast）/ `Meta + T`（thinking）

### ② 仍有差异 / khy 刻意不同

- **`Ctrl + O` 语义**：CC 是「切换 transcript 视图」，khy 是「展开 / 折叠过程组与工具输出」——khy 的是既有合理功能，不为对齐而破坏它。
- **历史范围**：CC 按 project 目录分别记；khy 用**全局单文件** `~/.khyquant_history`。
- **暂无（deferred）**：`Ctrl + G` 外部编辑器、`Ctrl + _` undo、`Meta + Y` yank-pop、`Ctrl + S` stash——khy 无对应底层能力，**造出来是假功能**，故刻意不做（见代码 `chatChords.js` 的诚实红线）。

> 随时用 `/keybindings` 看完整实时键位表，或在空输入框按 `?` 弹浮层。

---

## 10. 自定义与查看

- **查看**：TUI 里 `/keybindings`（完整分组表）或空输入框 `?`（精简浮层）。
- **门控**：本轮两个新键位可用环境变量关闭（默认开，关则逐字节回退历史行为）：
  - `KHY_BACKSLASH_NEWLINE=0` → 关闭 `\`+Enter 续行；
  - `KHY_HISTORY_REVERSE_SEARCH=0` → 关闭 `Ctrl+R` 反向搜索。

> **诚实说明**：khyos **没有** `~/.claude/keybindings.json` 式的重映射引擎——键位由 `keybindingCatalog.js` 这一 SSOT 声明式驱动，不支持逐键重绑。这是与 CC 不同的取舍（理由见 `keybindingCatalog.js` 注释）：khy 选择「一份真源 + 门控整体开关」而非「完整可重映射引擎」，以避免维护半成品的重绑层。
