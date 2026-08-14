# Khy-OS 传承书 · 无 AI 也能维护的生存宪法

> 写给未来的维护者（也许只有你一个人，也许你不是工程师）。
>
> 这份文档不依赖任何 AI 助手就能读懂、照做。它告诉你：khyos 靠什么活着、
> 你必须会做哪几件事、每件事的**确切命令**、以及哪些红线绝不能碰。
>
> 一句话宗旨：**让 khyos 在没有原作者、没有 AI 陪伴的情况下，依然能被一个人维护、
> 随时代更新、并继续通过 pip 发布出去。**

---

## 0. 三十秒速览：khyos 靠四根支柱活着

| 支柱 | 是什么 | 没了会怎样 | 在哪 |
| --- | --- | --- | --- |
| **pip 生命线** | 唯一的下载与发布渠道（打成 wheel 上传 PyPI） | 无法分发，等于消失 | `setup.py` / `pyproject.toml` |
| **守卫免疫系统** | 提交时自动拦截「越改越差」的机器门禁 | 弱模型/手滑会慢慢腐蚀代码 | `scripts/check-*.js` + pre-commit |
| **`.ai/` 种子文档** | 机器可读的项目地图与红线，给人和 AI 看 | 新人/新 AI 看不懂结构 | `.ai/MAP.md` `.ai/GUARDS.md` |
| **`maintenance/` 双击启动器 + `khy maintain`** | 不懂命令行也能维护的图形入口 | 非技术维护者无从下手 | `maintenance/*.command` `.bat` |

**第一件该做的事**：在仓库根目录跑一次体检，它会告诉你当前缺什么、怎么补。

```bash
node services/backend/bin/khy.js maintain freshness   # 与时俱进体检（只读）
node services/backend/bin/khy.js maintain             # 维护者驾驶舱（只读）
node services/backend/bin/khy.js health               # 顶层自助诊断
```

不会敲命令？**完全不用敲命令**：双击 `maintenance/` 里名字排最前的
`维护-0-从这里开始`（macOS `.command` / Windows `windows\*.bat` / Linux `linux/*.sh`），
它会列出全部维护项让你**按编号选**。最常用的几个直达双击入口：

| 想干什么 | 双击这个 |
| --- | --- |
| 看现在健不健康 | `维护-一键健康体检` |
| 更新到最新 | `维护-更新项目到最新` |
| 升级前先备份 | `维护-备份关键数据配置` |
| 升级坏了要回滚 | `维护-回滚到最近稳定版本` |
| 依赖坏了重装 | `维护-一键重装依赖` |
| 求助前导出诊断 | `维护-导出诊断日志` |
| 换机器/版本对不上 | `维护-工具链基线漂移检查` |
| 更新/发布/回滚后快速验命脉 | `维护-快速烟雾测试更新发布回滚后` |

> 🆘 **慌乱中只想止血**？翻同目录的 **`紧急恢复卡片.md`**——一页纸，
> 每种「坏了」都给「先双击、敲不动再复制命令」两条路，命令都不经过 `khy` 简写（最抗坏）。

---

## 1. 你必须会的几件事（无 AI 生存操作）

下面这些操作覆盖了维护一个 pip 项目的全部最小闭环：**安装、体检、更新、换模型、
发布**（操作一～五），以及出事时的**备份、回滚、导出诊断、重装依赖**（操作六～八）。
每件事都给了**确切命令**和**双击入口**，照抄/双击即可。出错时先看第 4 节「红灯怎么办」。

### 操作一 · 安装 / 重装

khyos 通过 pip 分发，包名 **`khy-os`**。

```bash
pip install khy-os                 # 从 PyPI 安装最新版
pip install --upgrade khy-os       # 升级到最新版
pip install ./dist/khy_os-*.whl    # 从本地构建产物安装（见操作五）
```

安装后验证：

```bash
khy --version                      # 应打印版本号，例如 0.1.131
khy health                         # 顶层健康自检
```

### 操作二 · 体检（判断项目是否还健康、是否跟得上时代）

```bash
khy maintain freshness   # 与时俱进：运行时保期 / 模型时效 / 自维护设施 / 守卫覆盖
khy maintain             # 维护者驾驶舱：元数据 / 架构债 / 巨石预警 / 版本
khy health               # 运行时 / 安装 / 网络 / 磁盘 / 内存
```

`maintain freshness` 是这次传承新增的命令，专门回答「khyos 还跟得上时代吗」：
- **运行时保期**：你跑的 Node.js 是否已过官方支持期（过期=安全风险，红灯）。
- **模型时效**：当前钉选的首选模型是什么、退役了没（见操作四）。
- **自维护设施**：四根支柱还在不在（缺 pip 生命线=红灯）。
- **守卫覆盖**：提交门禁是否还接着各机器守卫。

每个发现都附**「→ 怎么修」**的确切命令。红灯项会让命令以非零退出——可当升级前门禁。

### 操作三 · 更新依赖 / 把项目更新到最新

```bash
git pull --ff-only                                   # 拉最新代码
npm install                                          # 安装/更新 Node 依赖
node services/backend/bin/khy.js metadata refresh    # 刷新 .ai/ 派生骨架
npm run check:small-model:safety                     # 跑提交前安全门禁
```

一键版（任一步失败即停，不带病继续）：双击
`maintenance/维护-更新项目到最新.command`，或：

```bash
node maintenance/lib/run-task.js update
```

### 操作四 · 换模型（与时俱进的核心动作）

**所有模型名只有一个真源**：`services/backend/src/constants/models.js`。
按角色/档位建了具名数组，**每个数组第一项 = 当前生效的首选模型**。
换模型只改这一个文件、这一处——绝不要把模型名硬编码回业务逻辑。

例：把主力 Opus 换成新型号——

```js
// services/backend/src/constants/models.js
const CLAUDE_OPUS_MODELS = ['claude-opus-X-Y'];   // ← 把新型号放到数组首位即可
```

改完验证（守卫会确保你没在别处漏改、也没把模型名硬编码回逻辑）：

```bash
node --test services/backend/tests/modelConstants.test.js   # 单一真源自测
npm run check:model-hardcoding                              # 防硬编码守卫
khy maintain freshness                                      # 确认模型时效转绿
```

> 为什么这么设计：模型迭代是「与时俱进」最频繁的动作。把模型名收敛到一处，
> 一个非工程师维护者也能安全地换模型，不会「改一处、漏十处」。

### 操作五 · 通过 pip 发布（唯一的对外渠道）

```bash
khy publish check     # 发布前预检（版本同步 / 纯度 / 迁移）
khy publish build     # 构建 wheel + sdist 到 dist/
khy publish pypi      # 上传到 PyPI（需 --yes 确认 + 凭据）
```

纯 pip 工具链（不经 khy 包装）：

```bash
npm run check:pip-packaging   # 构建并审计 wheel 纯度（隔离/完整/无依赖泄漏）
npm run check:version-sync    # 版本号一致性
python -m build               # 标准构建（产物落 dist/）
twine upload dist/*           # 上传 PyPI
```

> **wheel 纪律（极重要）**：`services/backend` 的代码**打进 wheel**——改了它，
> pip 用户必须**重建 wheel 重新发布**才能拿到。`services/ai-backend` 不进 wheel
> （守护进程从源码 require，editable 改立即生效）。纯 node 脚本/测试 editable 即生效。

### 操作六 · 备份关键数据/配置（更新或回滚之前先做）

更新、换模型、回滚之前，先备份一次。它会把 `~/.khyos` 与 `~/.khyquant` 下的
配置/用量文件复制到 `~/.khyos/backups/khy-backup-<时间戳>/`，并打印**确切的恢复路径**。

```bash
node maintenance/lib/ops.js backup
```

不会敲命令？双击 `maintenance/维护-备份关键数据配置.command`（或选单里选它）。

> **恢复方法（无需记路径）**：备份完成后会**直接打印一组可复制的命令**——每个备份文件一行
> `cp "<备份里的文件>" "<原位置>"`（Windows 是 `copy /Y`）。出事时把这几行逐行粘到终端执行，
> 配置就回到备份时的样子。不必再手动去找备份目录、自己拼路径。
> 备份里的 `config.json` 含 API 密钥，请妥善保管、勿外发。

> **更新/回滚前会自动备份一次**：跑 `update` 任务或 `rollback` 时，会在动作开始前
> 先自动执行一次 backup（并打印同样的恢复命令），不用你记得手动备份。
> 想关掉这层自动保护：`KHY_AUTO_BACKUP=0`。

> **只保留最新一个备份，不会无限膨胀**：每次备份完成后会自动清理旧备份，默认**只留最新一个**
> （`~/.khyos/backups/` 不会越攒越多撑爆磁盘），并打印「已清理 N 个旧备份」。想多留几个：
> `KHY_BACKUP_KEEP=3`（留最新 3 个）；想关掉自动清理、全部保留（旧行为）：`KHY_BACKUP_KEEP=0`。
> 清理只动 `khy-backup-*` 目录，备份文件夹里你自己放的其它东西绝不会被删。

### 操作七 · 回滚到最近稳定版本（升级坏了的救命操作）

升级后出问题，用这一步切回上一个「已知良好」的版本。它会：
1. 自动找到回滚目标——**优先**用 `maintenance/stable-release.json` 登记的稳定版标签；
   登记的不在了，就退回到仓库里最高的版本标签。
2. **安全检查**：工作区必须干净（没有未提交改动），否则**拒绝回滚并提示先备份/暂存**，
   绝不会偷偷丢掉你的改动。
3. 让你**输入 y 确认**后，才真正切换。没确认 = 什么都不改。

> 放心：「没确认绝不动你的代码」这条是**有自动化测试守着的**（`maintenance:test` 里会真的跑一遍
> 回滚、确认没确认时代码版本一字不变）。所以即使你手滑双击了回滚，只要不输入 y，什么都不会变。

```bash
node maintenance/lib/ops.js rollback        # 交互确认
KHY_ROLLBACK_CONFIRM=1 node maintenance/lib/ops.js rollback   # 自动确认（脚本/无人值守）
```

不会敲命令？双击 `maintenance/维护-回滚到最近稳定版本.command`。

> 回滚后跑一次 `khy health` 确认可用；想回到最新开发线：`git checkout <你原来的分支>`。
> **发布并验证一个新版本后**，不必再手改 `maintenance/stable-release.json`——
> 跑一次 `node maintenance/lib/ops.js bless`（或双击 `维护-登记最近稳定版免记忆回滚`），
> 它会把当前 `version`/`commit`/`tag`/`builtAt`/产物 sha256/发布后验证结果**自动写进**该文件，
> 回滚就能自动用它，**维护者不必记住哪个版本是好的**。

### 操作八 · 出问题先导出诊断 / 依赖坏了重装 / 快速验命脉

```bash
node maintenance/lib/ops.js diagnostics   # 把版本+git+体检汇成两份文件（人读 .md + 机读 .json，均不含密钥）
node maintenance/lib/ops.js reinstall     # 删 node_modules 后全新重装依赖（仓库根 + services/backend）
node maintenance/lib/ops.js smoke         # 快速烟雾测试：后备 CLI/版本一致/四支柱/维护清单可解析（更新/发布/回滚后跑）
node maintenance/lib/ops.js toolchain     # 工具链基线漂移检查：Node/Python/npm/pip/wheel，逐项给升/降/重装/重建建议
```

诊断会**同时**落两份：人读 `maintenance/logs/diagnostics-<时间戳>.md`（发给维护者）
与机读 `…-<时间戳>.json`（发给 AI 助手，便于解析），均不含密钥。
`smoke` 几秒钟告诉你最关键的几条命脉是否还活着，红项直接给「下一步」。
双击入口：`维护-导出诊断日志` / `维护-一键重装依赖` / `维护-快速烟雾测试更新发布回滚后`。

> **工具链基线漂移检查（`toolchain`）**：装新机器、或 CI 突然报「版本不对」时跑它。
> 它先打印**基线来源**（Node 取 `services/backend/package.json` 的 `engines.node`，
> Python 取 `pyproject.toml` 的 `requires-python`——基线只此一处，文档不另写死版本号），
> 再逐项标 `✓ 达标 / ⚠ 低于基线 / ✗ 缺失 / · 无声明基线`，每个有问题的工具都附**具体命令**
> （如 `nvm install --lts`、`npm install -g npm@latest`、`python3 -m pip install --upgrade pip`、
> 装/升 wheel 后 `khy publish build` 重建产物）。**只有项目硬性要求的工具缺失才算硬失败**
> （退出码非 0）；npm/pip/wheel 没声明基线时只报告、不报警。维护选单里有一个**独立的
> `toolchain` 巡检任务**（巡检模式 `continueOnError`，只报告不阻断）；装新机器或「跟上时代」
> 更新前，顺手跑一次看看工具链有没有漂移。

### 发布与回滚的固定链路（一条龙）

发布是一条**固定、可重复、可回退**的链路，每一环都有双击入口：

| 顺序 | 动作 | 双击入口 / 命令 |
| --- | --- | --- |
| 1 | 发布前检查 | `维护-发布前检查` ·`khy publish check` |
| 2 | 构建产物 | `维护-一键构建发布产物` ·`khy publish build` |
| 3 | 审计纯度 | `npm run check:pip-packaging` |
| 4 | 上传发布 | `khy publish pypi`（需 `--yes` + 凭据） |
| 5 | 发布后验证（**全绿即自动登记**） | `维护-发布后验证` ·`node maintenance/lib/ops.js post-verify` |
| 6 | 登记稳定版（如需手动） | `维护-登记最近稳定版免记忆回滚` ·`node maintenance/lib/ops.js bless` |
| 7 | 快速验命脉 | `维护-快速烟雾测试更新发布回滚后` ·`node maintenance/lib/ops.js smoke` |
| 8 | 出错回滚 | `维护-回滚到最近稳定版本` ·`node maintenance/lib/ops.js rollback` |

第 6 步「登记稳定版」是把回滚目标**从记忆里搬进文件**：bless 写进
`maintenance/stable-release.json` 后，第 8 步回滚自动认它，维护者不必记版本号。

> **闭环「发布即登记稳定版」**：第 5 步 `post-verify` **验证全部通过时会自动执行第 6 步 bless**，
> 把本次版本登记成回滚目标——发布后正常情况下**不必再单独跑 bless**。验证有红项则**绝不**登记
> （不会把没验过的版本记成「稳定」）。想保留手动登记、关掉这层自动：`KHY_AUTO_BLESS=0`，
> 此时 post-verify 全绿会改为打印一句手动 bless 提示。发布命令成功后也会提示下一步正是
> `node maintenance/lib/ops.js post-verify`。

### 入口冗余：每个关键能力都有两条路（主路径坏了走后备）

设计原则之一是**关键能力不止一条路**。`khy` 简写入口若损坏，后备入口直连后端、绕过简写：

| 能力 | 主路径（简写） | 后备路径（最抗坏，不经简写） |
| --- | --- | --- |
| 看版本 / 体检 | `khy --version` ·`khy health` | `node services/backend/bin/khy.js --version` ·`… health` |
| 备份 / 回滚 | 双击 `维护-…` | `node maintenance/lib/ops.js backup` ·`… rollback` |
| 导出诊断 / 重装 | 双击 `维护-…` | `node maintenance/lib/ops.js diagnostics` ·`… reinstall` |
| 发布验证 / 登记 / 烟雾 | 双击 `维护-…` | `node maintenance/lib/ops.js post-verify` ·`… bless` ·`… smoke` |
| 双击入口本身 | `maintenance/*.command` 等 | 主清单坏了自动回退 `maintenance/rescue-catalog.json` |

> 这就是为什么本传承书与 `紧急恢复卡片.md` 里的救援命令一律写成
> `node services/backend/bin/khy.js …` 或 `node maintenance/lib/ops.js …`——
> 它们不依赖 `khy` 简写是否还在 PATH 上，**简写彻底坏掉也能救回来**。

---

## 2. 守卫免疫系统：每次提交自动拦住「越改越差」

khyos 假设未来维护它的可能是能力较弱的模型或非工程师。为此把「该守的规矩」
从「人自觉」固化成**提交时的机器门禁**（git pre-commit 自动跑
`npm run check:small-model:safety`）。每个守卫都是「纯叶子逻辑库 + 薄 CLI」。

| 守卫 | 拦什么 | 自查命令 |
| --- | --- | --- |
| `check-agent-rules` | 通用反模式（裸端点、硬编码、危险写法） | `npm run check:agent-rules` |
| `check-leaf-contract` | 纯叶子契约破坏 + git 冲突标记打进发布 | `npm run check:leaf-contract` |
| `check-model-hardcoding` | 把模型名硬编码回逻辑（绕过单一真源） | `npm run check:model-hardcoding` |
| `check-change-safety` | 改动集合的安全性 | `npm run check:change-safety` |

**基线要求**：对当前代码树这些守卫应**零 error**。如果体检报告 `守卫覆盖` 变黄，
说明有守卫从 `package.json` 的 `check:small-model:safety` 串里掉了——把它串回去。

详细红线见 `.ai/GUARDS.md`（机器可读、随仓库保留）。

---

## 3. `.ai/` 与 `maintenance/`：给人和给非工程师的两套入口

- **`.ai/`**（先读这里）：`MAP.md` 是项目地图（技术栈/入口/构建命令/目录树）；
  `GUARDS.md` 是红线与无 AI 维护指南；`CONTEXT.yaml` 是机器可读契约。
  它们由 `khy metadata refresh` + git pre-commit 钩子确定性地保持最新。
- **`maintenance/`**：每个常用维护任务都生成了三平台启动器
  （`.command` / `linux/*.sh` / `windows/*.bat`）。不懂命令行的维护者**双击即维护**。
  新增维护任务：改 `maintenance/tasks.json` → 跑 `npm run maintenance:generate`。

从这里开始：双击 `maintenance/维护-0-从这里开始...` 或 `node maintenance/lib/run-task.js --menu`。

---

## 4. 红灯怎么办（最常见的几种）

| 体检/门禁报红 | 含义 | 照做 |
| --- | --- | --- |
| `运行时保期：Node X 已停止支持` | Node 过了官方 EOL，存安全风险 | `nvm install --lts && nvm use --lts` |
| `自维护设施：缺失 pip 生命线` | `setup.py` 不见了 | 从 git 历史恢复；没有它无法发布 |
| `模型时效：身份模型疑似已退役` | 钉选的模型被厂商下线 | 按操作四换 `constants/models.js` 首位 |
| `守卫覆盖：未接线的守卫` | 某守卫从提交门禁掉了 | 串回 `package.json` 的 `check:small-model:safety` |
| `check:pip-packaging` 失败 | wheel 不纯/不完整 | 看审计输出，通常是漏拷文件或依赖泄漏 |
| git 冲突标记打进发布 | `<<<<<<<` 残留在源码里 | leaf-contract 守卫会点名行号，手工解掉 |
| 更新后整个跑不起来了 | 新代码或依赖坏了 | 先 `维护-导出诊断日志` 留证；再 `维护-回滚到最近稳定版本` 切回上一个好版本 |
| 回滚提示「工作区有未提交改动」 | 你本地有没保存的改动 | 先 `维护-备份关键数据配置`，再 `git stash` 暂存，然后重跑回滚 |
| 依赖报错 / 模块找不到 | node_modules 损坏或不全 | `维护-一键重装依赖`（删干净后全新重装） |

### 出问题先看哪里（三步分诊，别一上来全仓乱翻）

1. **先体检**：双击 `维护-一键健康体检`（或 `khy health` + `khy maintain`），看红在哪一项。
2. **再缩范围**：打开 `docs/维护者/维护映射表.json`，按「现象」找到对应**板块**——
   每个板块写明了「什么时候看它 / 关键文件在哪 / 对应文档 / 最小验证命令」。
   先只跑那个板块的最小验证命令，确认问题，**不要**一上来改全仓。
3. **搞不定就留证求助**：双击 `维护-导出诊断日志`，把 `maintenance/logs/` 里这次的
   文件整个发给维护者或 AI 助手。实在恢复不了，`维护-回滚到最近稳定版本` 切回上一个好版本。

---

## 5. 绝不能碰的红线

1. **pip 是唯一发布渠道**——不要削弱 `setup.py` / 发布预检；删了它 khyos 就消失了。
2. **模型名只有一个真源**——绝不把模型名字面量硬编码回业务逻辑（守卫会拦，别绕过）。
3. **守卫只增不减**——可以加新守卫，不要为图省事把现有守卫从提交门禁里摘掉。
4. **确定性真值优先于模型猜测**——能用代码算出唯一答案的（算术/单位换算/公理定理），
   走确定性代码，不靠模型心算（见 `.ai/GUARDS.md`）。
5. **纯加法、门控默认开**——新功能用「纯叶子 + 薄接线 + `KHY_*` 门控默认开」模式，
   保证可随时回退、不破坏既有行为。

---

## 附录 A · 维护者最常用的运维/安全开关（速查）

下面这几个环境开关直接影响「更新 / 回滚 / 发布 / 备份」这条命脉，是单人维护者**真正会用到**的少数几个。
其余几百个开关都有合理默认、平时不用碰——**全量分类目录见 `docs/07_OPS_运维/[OPS-MAN-058] 环境开关与文档命名规范.md`**。

> 总原则：所有 `KHY_*` 功能门控**默认开**，关闭即**逐字节回退**到该功能接入前的历史行为——任何时候都能安全关掉某个新行为，不会把仓库改坏。

| 开关 | 默认 | 取值 | 作用 |
| --- | --- | --- | --- |
| `KHY_AUTO_BACKUP` | 开 | `0`=关 | 跑 `update` 或 `rollback` 前自动备份一次（并打印可复制恢复命令）。见操作六 |
| `KHY_BACKUP_KEEP` | `1` | 正整数 / `0`·`all`·`off`·`no` | 备份保留份数：默认只留最新 1 个；`=3` 留 3 个；`=0` 关闭清理、全部保留（旧行为）。只清理 `khy-backup-*` 目录 |
| `KHY_AUTO_BLESS` | 开 | `0`=关 | `post-verify` 全绿时自动登记稳定版（闭环「发布即登记」）；红项绝不登记。见发布链路第 5 步 |
| `KHY_ROLLBACK_CONFIRM` | 关（需交互 `y`） | `1`=自动确认 | 回滚确认闸门；脚本/无人值守用 `=1` 跳过交互。没确认绝不动代码。见操作七 |
| `KHYOS_HOME` | `~/.khyos` | 路径 | 底座数据家根（含 `backups/`）。换机器/隔离测试时指到别处 |
| `KHY_DATA_HOME` | `~/.khy` | 路径 | 应用数据家（配置 / 用量） |
| `KHY_STABLE_RELEASE_FILE` | `maintenance/stable-release.json` | 路径 | 稳定版登记主记录（一般不改，测试/迁移时用） |
| `KHY_STABLE_RELEASE_SHADOW_FILE` | `maintenance/stable-release.backup.json` | 路径 | 稳定版登记影子冗余副本；主记录损坏时回滚自动退到它 |

> 数据家目录的解析真源**只此一处**：`services/backend/src/utils/dataHome.js`（`getBaseHome()` / `getDataHome()`）。
> 所有服务都经它取家目录，绝不硬编码——这也是为什么上面两个 env seam 一改就能整体重定向。

---

## 6. 留给你的一句话

khyos 被刻意设计成「即使没有原作者、没有 AI，也能被一个人长期维护」。
四根支柱、一套自动守卫、一条体检命令、一摞双击启动器——它们的存在，
就是为了让你在任何时代都能回答三个问题：**它还健康吗？它跟得上时代吗？我怎么修？**

跑一次 `khy maintain freshness`，按「→ 怎么修」照做。这就是全部。

— 愿 khyos 与时俱进，不被淘汰。
