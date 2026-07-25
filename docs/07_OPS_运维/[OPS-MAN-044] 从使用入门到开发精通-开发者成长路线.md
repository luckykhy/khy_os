# [OPS-MAN-044] 从使用入门到开发精通：khy 开发者成长路线

> 目的：接续 **[OPS-MAN-043] 新手成长路线**（那条把你带到"会用 khy"），本文把你从
> **"会用 khy"** 一路带到 **"能开发、能扩展、能维护 khy"**——即从**使用入门**到**开发精通**。
> 每一级仍只回答三件事：**这一步要达到什么 → 抄哪条命令 → 你由此学会了什么、深入读哪篇**。
> 本文是**开发者导航阶梯**，深度细节交给 `CONTRIBUTING.md`、`.ai/` 种子文档与 [OPS-MAN-013] 开发者指南——
> 这里负责给你**正确的顺序与最短路径**，不重复它们。
> 全文命令均以仓库实测为准（root `package.json` / `services/backend/package.json` scripts、`scripts/`、CLI 路由），非杜撰。
>
> 📖 **美观阅读版**：本文另有同目录同名的 **`.html`** / **`.pdf`**，以及与 [OPS-MAN-043] 的**合订本**；
> 由 `npm run docs:pdf:onboarding` 生成（实现见下方 D6「把文档导出为美观 HTML/PDF」）。

---

## 0. 两条阶梯如何衔接

```
[OPS-MAN-043] 使用阶梯                    [OPS-MAN-044] 开发阶梯（本文）
─────────────────────────              ─────────────────────────────
阶段0 装完体检                            D0 拿到可读源码 + 看懂地图
阶段1 配 AI                              D1 搭 editable 开发环境
阶段2 日常对话/编程        ──衔接──►       D2 走通主链路 + 跑测试
阶段3 进阶(learn/wf/agent)               D3 第一次改代码（改 CLI 命令）
阶段4 高手(内核/远程/还原)                D4 扩展能力（网关适配器/工具/前端）
                                        D5 深入内核
                                        D6 精通：可维护性 + 发布纪律
```

> 分界线：**用 khy 干你的活** = 使用；**改 khy 本身、给它加能力、维护它的质量** = 开发。
> 你不必学完全部——挑你要改的那一块，沿对应那一级深入即可。

**开发者最短上手路径（5 条命令摸到全貌）：**

```bash
khy restore                         # 1) 把装进来的加密源码还原成可读源码树
python3 scripts/dev-install.py      # 2) editable 安装：改 canonical 即生效
node scripts/ci/print-maintainer-map.js   # 3) 打印"改 X 去哪"的维护映射
npm run check:version-sync          # 4) 跑最小仓库检查
khy doctor                          # 5) 改启动/路由/网络/打包前先体检
```

---

## D0 · 拿到可读源码 + 看懂地图

开发的第一步不是写代码，而是**让自己能读到源码、并看懂仓库地图**。pip/npm 装进来的是加密快照，
先还原成可读源码树；然后读三件套地图，避免一上来就在 6000+ 文件里迷路。

| 你要达到 | 抄这条命令 / 读这个 | 说明 |
| --- | --- | --- |
| 还原可读源码 | `khy restore` | 把发布时**与工作树字节一致**的源码解密、校验 sha256 后还原（默认无需密码）。也可直接 `git clone` 仓库。 |
| 看仓库骨架 | 读 `.ai/MAP.md` | "顶层目录职责"+"我要改 X → 去哪"速查表+核心入口点+构建运行。**开发前必读**。 |
| 看调用链/符号 | 读 `.ai/CONTEXT.yaml` | 机器可读契约：stack、entry_points、谁调用谁、每文件符号表。 |
| 看红线 | 读 `.ai/GUARDS.md` + `AGENTS.md` | 哪些**绝不能碰**、哪些是派生件不可手改（如 `bundled/`、`MANIFEST.in`）。 |
| 看产品/运行边界 | 读 `README.md` | 产品全貌与运行时边界。 |

> `.ai/` 三件套（MAP→CONTEXT→GUARDS）是为"低算力/无记忆"读者设计的，人也最该先读。
> `SKELETON.auto.md` 是机器派生层，由 `khy metadata refresh` 维护，别手改。

✅ **你学会了**：khy 不是黑箱——源码可字节还原，且自带"去哪找代码"的地图。
➡️ **深入读**：[OPS-MAN-038] AI元数据-.ai-种子文档-用法指南、[OPS-MAN-037] pip安装后-完整还原与全功能开启指南。

---

## D1 · 搭 editable 开发环境

让"改源码 → 立刻生效"成立，不必每次重装。

| 你要达到 | 抄这条命令 | 说明 |
| --- | --- | --- |
| editable 安装 | `python3 scripts/dev-install.py` | 等价的 editable 安装：改 canonical 源码即生效（详见 [OPS-MAN-013] §3.3 "editable 安装与重构韧性"）。 |
| 装 Node 依赖 | `npm --prefix services/backend install` | 后端是业务代码主体（Node ≥ 20）。 |
| 装可选本地守闸 | `npm run hooks:install` | 安装仓库管理的 `pre-commit` 钩子（来自 `.githooks/`），提交前自动跑门禁。 |

✅ **你学会了**：khy 的开发循环是"改 canonical → 即生效"，`bundled/` 副本只在发布时由构建重建。
➡️ **深入读**：[OPS-MAN-013] khy-os-开发者指南 §2-§4（环境要求、初始化、开发启动方式）、[OPS-MAN-028] 环境要求。

---

## D2 · 走通主链路 + 跑测试

改代码前，先在脑子里跑通"一条命令是怎么从 pip 壳走到 handler 的"，并确认你能跑测试。

**核心运行链路（命令类 bug 从这里顺藤摸瓜，别从随机 service 文件起手）：**

```
platform/khy_platform/cli.py        # pip 壳：查 Node≥20 → 定位 bin/khy.js → subprocess
 └─ services/backend/bin/khy.js      # Node 入口
     └─ services/backend/src/cli/repl.js
         └─ services/backend/src/cli/router.js     # 大 switch 分发
             └─ services/backend/src/cli/handlers/<area>.js
```

| 你要达到 | 抄这条命令 | 说明 |
| --- | --- | --- |
| 打印维护映射 | `node scripts/ci/print-maintainer-map.js` | 比盲目 `rg` 更快：给出各维护区的入口文件、常见症状、最小验证命令。`--list-areas` 看分区、`--area cli-routing` 看某区。 |
| 最小仓库检查 | `npm run check:version-sync && npm run check:node-syntax && npm run check:python-syntax` | First-30-Minutes 的最小集。 |
| 改动安全门禁 | `node scripts/check-agent-rules.js --changed` | 按改动文件检查是否触红线。 |
| 启动前体检 | `khy doctor` | 改启动/路由/网络/打包前先跑。 |

✅ **你学会了**：khy 的执行主链很短（5 跳），且有"维护映射"替你定位入口——不靠猜。
➡️ **深入读**：`CONTRIBUTING.md` 的 "Core Runtime Chain" 与 "Maintainer Map"、[OPS-MAN-013] §7 质量检查与测试。

---

## D3 · 第一次改代码：改一个 CLI 命令

最小、最安全的"改 khy 本身"练习。按固定顺序改 4 个文件，再跑该区的最小验证。

**改/加 CLI 命令的顺序（来自 `CONTRIBUTING.md` Change Recipes）：**

```
1) services/backend/src/constants/commandSchema.js  # 命令 schema（子命令 SSOT）
2) services/backend/src/cli/aliases.js          # 别名
3) services/backend/src/cli/handlers/<area>.js  # 实现
4) services/backend/src/cli/router.js           # 接到大 switch
```

最小验证：

```bash
npm run test:maintainer:cli-routing
node -e "require('./services/backend/src/cli/router')"
```

✅ **你学会了**：khy 的命令是"schema→alias→handler→router"四件套，且每个维护区都有**专属最小测试**。
➡️ **深入读**：[OPS-MAN-013] §5 CLI 命令开发规范（4 步）、`CONTRIBUTING.md` "Add or fix a CLI command"。

---

## D4 · 扩展能力：网关适配器 / 工具 / 前端

把 khy 接到新模型、给它加工具、改管理页——这是开发者最常做的"加能力"。

| 我想加 | 入口顺序 | 最小验证 |
| --- | --- | --- |
| AI 网关适配器（接新模型） | `gateway/adapters/<adapter>.js` → `gateway/aiGateway.js` → 相关 protocol/proxy 助手 | `npm run test:maintainer:gateway` |
| 修代理/守护/端口漂移 | `daemonManager.js` → `gateway/proxyServer.js` → `utils/proxyBaseUrl.js` → `constants/serviceDefaults.js` | `npm run test:maintainer:runtime` |
| 改前端 | 先认清是哪块：交易 UI `software/khyquant/frontend/` 还是 AI 管理 UI `apps/ai-frontend/`(+`services/ai-backend/`) | 对应前端构建/测试 |
| 接生态应用 | 经 `pyproject [project.entry-points."khyos.apps"]` 暴露 `KhyApp` 工厂；`khy app list` 列出、`khy app start <name>` 启动（子命令实现见 `cli/handlers/app.js`：`install`/`start`/`stop`/`run`/`list`） | 见 DESIGN-ARCH-011 应用接入标准 |

> 适配器路径均在 `services/backend/src/services/gateway/`；模型→适配器的路由在 `modelRouter.js`，级联+熔断在 `aiGateway.js`。

✅ **你学会了**：扩展点是有边界的——网关、工具、两套前端、生态应用各有入口与专属测试，不要"反射式两边都改"。
➡️ **深入读**：[OPS-MAN-013] §6 AI 适配器开发规范、[OPS-MAN-012] 应用接入指南、[OPS-MAN-007] cli-万能接入-集成指南、[OPS-MAN-032] 网关-自定义provider配置。

---

## D5 · 深入内核

khy 底下是一台**手写 x86_64 C 内核**。到这一级你开始改/构建真内核。

| 你要达到 | 抄这条命令 | 说明 |
| --- | --- | --- |
| 构建内核 ISO | `khy os build` | 等价于 `make -C kernel iso`（`nasm -f elf64` + freestanding `gcc` + `ld -T linker.ld`）。产物 `kernel/build/khy-os-kernel.iso`。 |
| 跑内核 | `khy os` | QEMU 启动；需主机 `qemu-system-x86_64`。 |
| 内核体检 | `khy os doctor` | 体检构建/运行工具链与 QEMU。 |

**读内核从这里起**：引导 `kernel/boot/boot.asm` `_start` → C 入口 `kernel/src/main.c:124 kernel_main`；
`.ai/MAP.md` 的"启动初始化流程"列出了 `kmain` 内 25 步真实调用顺序与模块依赖图。

✅ **你学会了**：khy 是从引导扇区往上自建的真内核，构建/运行/读码都有确定入口。
➡️ **深入读**：`.ai/MAP.md`（启动流程+模块依赖图）、[OPS-MAN-036] khyos跨平台构建-Windows支持方案、`kernel/Makefile`。

---

## D6 · 精通：可维护性纪律 + 发布

"精通"不是会写更多代码，而是**改动不破坏可维护性、且能干净发布**。这是 khy 开发者的终点段。

| 纪律 | 抄这条命令 / 读这个 | 说明 |
| --- | --- | --- |
| 不造"上帝组件" | `npm --prefix services/backend run arch:god` | 单文件硬上限 **2500 行**；超额会被门禁拦。拆分范式=抽纯叶子模块 + 原文件同名别名 re-export 保契约。 |
| 刷新 .ai 元数据 | `khy metadata refresh` | 改了结构后让三件套/`SKELETON.auto.md` 与代码同步（确定性，不覆盖手写三件套）。 |
| 维护体检 | `npm run maintainer:check` / `node scripts/ci/print-maintainer-map.js --check` | 验证维护映射与代码一致。 |
| 守红线 | 读 `.ai/GUARDS.md` + `AGENTS.md` | 派生件（`bundled/`、`MANIFEST.in` 由 `pip_packaging_rules.py` 生成）**绝不手改**。 |
| 干净发布 | `bash scripts/release/publish-dual.sh <版本> --tag --push -y` | 双渠道（PyPI + npm）+ 纯净度审计 + 打 tag。见 [OPS-MAN-042]。 |

> 改打包行为时：`scripts/release/pip_packaging_rules.py` 是单一真源；`MANIFEST.in` 自它生成，不要手改。
> 验证：`npm run check:version-sync && npm run check:manifest-sync && bash scripts/release/build-and-audit-pip-purity.sh`。

### 把文档导出为美观 HTML/PDF

markdown 文档可一键导出**屏幕阅读用 HTML**（浮动目录 + 排版美化）与**打印/分享用 PDF**，
零新增依赖：复用仓库已 vendored 的 `markdown-it` 渲染、系统 `google-chrome` 的 `--print-to-pdf`、
Noto Sans/Serif CJK 字体（中文不变豆腐块）。转换器是 `scripts/docs/md-to-pdf.js`。

| 你要做 | 抄这条命令 | 说明 |
| --- | --- | --- |
| 生成成长路线套件 | `npm run docs:pdf:onboarding` | 一次产出 043 / 044 各自的 `.html`+`.pdf`，再加一本**合订本**。预设源在脚本顶部 `ONBOARDING_DOCS`。 |
| 转任意 md | `npm run docs:pdf -- "<某文档>.md"` | 同目录产出同名 `.html`+`.pdf`。`--html-only` 只出网页、`--pdf-only` 只出 PDF。 |
| 合并多篇为一本 | `node scripts/docs/md-to-pdf.js --combined "<标题>" "<basename>" a.md b.md` | 多篇按分页合成一份 HTML/PDF。 |

> 缺 chrome 时会给出真实指引（装 `google-chrome` 或设 `KHY_DOCS_CHROME`，或加 `--html-only`），**不**静默失败。
> 生成物是**派生件**：随时可由源 markdown 重建，markdown 才是单一真源。

✅ **你学会了**：khy 的"精通"= 一文件一职责的架构纪律 + 元数据/红线/审计 + 机械化双渠道发布。
➡️ **深入读**：[OPS-MAN-042] 发布手册-pip与npm-无AI照做、[OPS-MAN-022] pip-安装布局参考、[OPS-MAN-040] Git入门、`CONTRIBUTING.md` Guardrails / Handoff Format。

---

## 一页速查（开发者版）

| 我想…… | 命令 |
| --- | --- |
| 拿到可读源码 | `khy restore` |
| editable 开发安装 | `python3 scripts/dev-install.py` |
| 打印"改 X 去哪" | `node scripts/ci/print-maintainer-map.js` |
| 最小仓库检查 | `npm run check:version-sync` |
| 改动安全门禁 | `node scripts/check-agent-rules.js --changed` |
| CLI 命令区测试 | `npm run test:maintainer:cli-routing` |
| 网关适配器测试 | `npm run test:maintainer:gateway` |
| 全维护区测试 | `npm run test:maintainer:all` |
| 上帝组件体检 | `npm --prefix services/backend run arch:god` |
| 刷新 .ai 元数据 | `khy metadata refresh` |
| 构建内核 | `khy os build` |
| 双渠道发布 | `bash scripts/release/publish-dual.sh <版本> --tag --push -y` |

---

## 关联

- 上一阶梯（使用入门）：[OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单。
- 开发者深度参考：[OPS-MAN-013] khy-os-开发者指南（结构/环境/CLI 与适配器规范/测试/发布全展开）。
- 工程红线与变更配方：仓库根 `CONTRIBUTING.md` + `AGENTS.md` + `.ai/GUARDS.md`。
- 仓库骨架与导航：`.ai/MAP.md` + `.ai/CONTEXT.yaml`。
- 文档总入口：`docs/00_INDEX_文档索引.md`。
