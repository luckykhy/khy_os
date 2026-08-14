<!-- 文档分类: OPS-MAN-170 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-170] 外部技能安装-khy-skill-add.md -->
# 外部技能安装（`khy skill add`）

> `khy skill add <源>` 从 GitHub 等仓库把一个技能（skill）拉取并落盘到 khy 的技能目录，对齐 `npx skills add <repo>` 的体验。khy 原生就认识 `SKILL.md` / `manifest.json` 并在 `<dataHome>/skills` 下自动发现，本命令补上「从仓库拉取」这一步。
>
> 实现依据（核实来源）：源写法解析见 `services/backend/src/skills/skillSourceSpec.js`；拉取/落盘 IO 见 `services/backend/src/services/skillInstallService.js`；落盘复制见 `services/backend/src/services/skillPackageService.js`；自动发现与加载见 `services/backend/src/skills/skillLoader.js` 与 `services/backend/src/skills/index.js`。

---

## 一、命令与流程

```bash
khy skill add <源> [--skill <名称|子路径>]
```

安装的内部流程（`addFromSource`）：

1. **门控检查**：`KHY_SKILL_ADD` 关闭时直接拒绝（详见第五节 FAQ）。
2. **源解析**：`skillSourceSpec.parseSource` 把各种源写法归一成 `{ url, ref, host, owner, repo, subdir, kind }`（纯字符串解析，零 IO）。
3. **浅克隆**：`git clone --depth 1 --no-tags` 到系统临时目录；带 `ref` 时先 `--branch <ref>`，若 ref 是 commit sha 则回退为全量克隆 + `checkout`。
4. **定位技能目录**：在克隆树里找到含 `SKILL.md` 或 `manifest.json` 的目录（规则见第三节）。
5. **落盘**：`skillPackageService.importSkill` 把该目录复制到 `<dataHome>/skills/<name>`（loader 能发现的位置）。
6. **清理**：删除临时克隆目录。

失败会抛出带中文提示的错误（例如 git 克隆失败、找不到技能、多个技能需 `--skill` 指定等）。

---

## 二、支持的源格式

以下写法均由 `skillSourceSpec.parseSource` 实际解析（核实自该文件的分支逻辑）：

| 写法 | 示例 | 说明 |
| --- | --- | --- |
| `owner/repo` 短写 | `khy skill add acme/my-skill` | 默认 host 为 `github.com`，归一为 `https://github.com/acme/my-skill.git` |
| `owner/repo#ref` | `khy skill add acme/my-skill#v1.2.0` | `#` 后为 ref（分支 / tag / commit sha） |
| `owner/repo/子/目录` | `khy skill add acme/pack/skills/foo` | 第 3 段起作为仓库内子目录（相当于隐式 `--skill`） |
| 完整 HTTPS URL | `khy skill add https://github.com/acme/my-skill` | 自动补 `.git` |
| 带 `.git` 的 URL | `khy skill add https://github.com/acme/my-skill.git` | 原样识别 |
| GitHub `tree` 深链 | `khy skill add https://github.com/acme/pack/tree/main/skills/foo` | 拆出 `ref=main` 与子目录 `skills/foo` |
| SSH 短写 | `khy skill add git@github.com:acme/my-skill.git` | `kind=ssh`，原样透传 URL |
| 任意 `http(s)` / `git` / `ssh` 协议 URL | `khy skill add https://gitlab.com/acme/my-skill.git` | 尽力解析 `host/owner/repo`，`url` 透传 |

**解析约束（来自源码校验）**：

- `owner` 与 `repo` 只允许「字母数字开头 + 字母数字 `.` `_` `-`」的单段，含非法字符会被拒绝。
- `ref` 只允许 `A-Za-z0-9._/-`。
- 子目录会经 `normalizeSubdir` 归一：拒绝绝对路径、盘符（如 `C:`）、`..` 遍历；反斜杠会转成 `/`。

---

## 三、`--skill` 与仓库内技能定位

技能目录的定位规则（核实自 `skillInstallService._locateSkillDir`）：

1. **显式子目录**（`--skill <名称|子路径>`，或 URL/短写里带出的子目录）：
   - 只认这个子目录；不存在、不是目录、或目录里没有 `SKILL.md`/`manifest.json` 都会报错。
   - 有越界保护：子路径不能逃出克隆根目录。
2. **无子目录时**：
   - 克隆根目录本身含 `SKILL.md`/`manifest.json` → 直接用根（单技能仓库）。
   - 否则在常见容器目录 `skill/` `skills/` `.skills/` 下扫描第一个含技能文件的命名子目录。
   - 若扫描到**多个**技能，会报错并要求用 `--skill <名称>` 指定其中一个。
   - 一个都没找到 → 提示「若在子目录，请用 `--skill <路径>` 指定」。

```bash
# 仓库根就是一个技能
khy skill add acme/single-skill

# 仓库里多个技能，选其中一个
khy skill add acme/skill-collection --skill translator

# 用 GitHub tree 深链直接定位子目录（等价于 --skill）
khy skill add https://github.com/acme/skill-collection/tree/main/skills/translator
```

---

## 四、落盘位置、自动发现与调用

### 落盘位置

安装后技能被复制到 `<dataHome>/skills/<name>/`：

- `<dataHome>` 为便携感知的数据根，非便携安装等价于 `~/.khy`。
- `<name>` 优先取 `manifest.json` 的 `name`，其次取 `SKILL.md` frontmatter 的 `name`，最后兜底用目录名（核实自 `skillPackageService._folderSkillName`）。
- 复制走 `_copyTreeSafe`，对每个条目做路径逃逸校验（防 path-traversal）。

### 自动发现

khy 启动时按优先级链发现技能（核实自 `skillLoader.discoverSkillsDeep` 与 `index.js discoverAllSkills`，「首个匹配胜出」）：

1. 项目级：`<项目>/.khy/skills/`，其次遗留 `<项目>/.khyquant/skills/`
2. 用户级：`<dataHome>/skills/`、`~/.khy/skills/`，其次遗留 `~/.khyquant/skills/`
3. 内置：`services/backend/src/skills/`
4. Claude Code 桥接（门控 `KHY_CC_SKILL_BRIDGE`，默认开）：追加在最后，保证 khy 原生 `SKILL.md` 始终优先。

`index.js` 走 `manifest.json` 为主的加载；`skillLoader` 兜底加载遗留的 `SKILL.md` 格式，两者合并（manifest 优先）。

### 在 REPL 调用

- 用户可调用的技能（`user_invocable: true`）会以 `trigger`（如 `/my-skill`）出现在 REPL 的技能目录里，可直接用斜杠命令触发；也支持 `aliases` 里的别名。
- 执行逻辑（核实自 `index.js executeSkill`）：
  - 有 `handler.js` 且导出 `execute(args, context)` 或本身是函数 → 走自定义处理器，返回其结果。
  - 否则 → 返回 `prompt.md` 内容作为提示词注入（AI 驱动执行）。
  - 二者都没有 → 报错「没有 prompt.md 也没有 handler.js」。

---

## 五、常见问题（FAQ）

**Q1：提示「`khy skill add` 未启用」怎么办？**
该命令由 `KHY_SKILL_ADD` 门控（核实自 `skillSourceSpec.isSkillAddEnabled`）。默认为开启（default-on），但 `0/false/off/no` 会关闭；若接入 flagRegistry 则以注册表判定为准。设置环境变量开启：

```bash
# PowerShell
$env:KHY_SKILL_ADD = "1"
# bash
export KHY_SKILL_ADD=1
```

**Q2：私有仓库怎么安装？**
本命令直接调用系统 `git clone`，不注入任何凭据。安装私有仓库前请先配好 git 凭据：

- SSH：用 `git@github.com:owner/repo.git` 写法，并确保本机 SSH key 已加入账户。
- HTTPS：先配好 credential helper / token（凭据不由 khy 保存）。

**Q3：仓库里有多个技能，安装报「含多个 skill」错误？**
用 `--skill <名称>` 指定其中一个，或用 GitHub `tree` 深链精确定位子目录（见第三节）。

**Q4：`--skill` 报「非法子路径」？**
子路径不允许绝对路径、盘符（`C:`）或 `..` 遍历。请用相对的、仓库内的正常路径，例如 `skills/translator`。

**Q5：拉的是某个 tag 或 commit？**
用 `owner/repo#ref` 或 `.../tree/<ref>/...`。`ref` 是分支/tag 时走 `--branch` 浅克隆；是 commit sha 时会自动回退为全量克隆再 `checkout`。

**Q6：安装后怎么确认可用？**
到 `<dataHome>/skills/<name>/` 确认文件已落盘，重启 REPL 后在技能目录里应能看到它的 `trigger`。

---

## 六、相关文档

- [OPS-MAN-171] 技能包规范-manifest与prompt模板 —— `SKILL.md` / `manifest.json` 字段规范与可复制模板。
- [OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp —— skill 命名与治理规则。
- [OPS-MAN-058] 环境开关与文档命名规范 —— `KHY_SKILL_ADD` 等环境开关的统一说明。
