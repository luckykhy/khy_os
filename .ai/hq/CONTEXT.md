# CONTEXT.md — khy-os 架构速查（AI 上下文注入素材）

> 用途：在本项目内工作的 AI，先读此文件即可获得指挥 khy-os 所需的领域知识，
> 不必每次扫描整个 khy-os 仓库。提示词模板中的「工程红线」块与本文件保持同步。
> 本文件是**摘要**；与 `khy-os/AGENTS.md` 冲突时以后者为准。
>
> **本文件所在目录 `.ai/hq/` 是任务/Bug 状态真源**（2026-09-17 由指挥部 khy-os-hq
> 吸收而来）。操作命令是 `khy hq …`（`status` / `next` / `verify` / `bug` / `task`），
> 背景见 `docs/03_DESIGN_设计/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md`。
> **不要手改本目录下的 JSON** —— 走 `khy hq` 命令，状态机与校验都在命令里。

---

## 一、项目定位

**Khy-OS** = AI 平台操作系统，PyPI（`pip install khy-os`）+ npm（`@khy-os/khy-os`）双渠道分发。
**khyquant**（量化交易终端，`software/khyquant/`）是运行在基座上的内置默认应用，不是项目本身。

## 二、分层结构

| 层 | 路径 | 职责 |
|----|------|------|
| L0 kernel | `kernel/` | 手写 C 内核：抢占调度、按需分页、COW fork、信号、管道、ELF+PE 双格式加载器，QEMU 可引导 |
| L1 platform | `platform/khy_platform/` | Python 轻量启动器，检测环境拉起 Node.js |
| L2 services | `services/backend/src/` | 全部业务逻辑（CLI、AI 网关、服务、Web API）|
| L3 apps | `apps/ai-frontend/` | AI 平台管理 UI（Vue 3 + Vite）|
| L4 software | `software/khyquant/` | 内置量化交易终端（含独立前端）|

调用链：`User → khy 命令 → Python cli.py → Node.js services/backend/bin/khy.js`
分派到 CLI Layer (`src/cli/`) / Service Layer (`src/services/`) / Web API (`src/routes/`)。

## 三、关键入口点

| 组件 | 文件 |
|------|------|
| CLI 路由器 | `services/backend/src/cli/router.js`（大 switch 分派）|
| 别名表 | `services/backend/src/cli/aliases.js`（中文/拼音→英文命令）|
| REPL 循环 | `services/backend/src/cli/repl.js` |
| AI 网关 | `services/backend/src/services/gateway/aiGateway.js` + `adapters/*.js` |
| 审计日志 | `services/backend/src/services/auditLog.js` |
| Token 统计 | `services/backend/src/services/tokenUsageService.js`（人民币计价）|
| 训练 / 回测 | `modelTrainingService.js` / `backtestEngine.js` |

新增 CLI 命令三步：别名表 → handler → router switch。
新增 AI 适配器两步：实现 `generate(prompt, options) → {text, tokenUsage, model}` → 注册进 adapters 数组。

## 四、工程红线（提示词模板同步引用，违反即返工）

1. **零硬编码**：源码不得出现字面量 IP、端口、绝对路径、生产域名（`khyquant.top/.com/.cn`）。
   端点一律来自 `constants/serviceDefaults.js` 或 env 覆盖；env 回退行不豁免生产域名检查。
   dev server 端口被占必须自动探测下一可用端口，不得 EADDRINUSE 崩溃。
2. **状态透明**：面向用户的状态/日志必须「动作 + 目标 + 进度」三维；
   禁止单独使用「正在工作 / 处理中 / Loading / Connecting / 尝试连接 / 请稍候 / Processing」。
   （UI 枚举标签、i18n 键、正则常量属数据不算违规。）
3. **基于活动的超时**：长任务不许固定时长硬 kill；用空闲重置计时器（工具结果/AI 回复/
   流式分块等重置 lastActivity）。短 IO fetch ≤30s 与认证握手超时例外。
4. **终端渲染**：与回滚输出共存的 CLI **禁用 ANSI 滚动区** `\x1B[n;mr`；
   用保存光标 `\x1B7` + 定位末行 + `\x1B[K` + 恢复 `\x1B8` 模式。全屏备用缓冲区（`\x1B[?1049h`）例外。
5. **代码风格**：JS 2 空格缩进、单引号、分号；camelCase(JS)/snake_case(Python)；
   面向用户字符串中文；代码注释英文；优先编辑现有文件而非新建。
6. **fail-soft 分层**：叶子函数返回 `{ok:false, error}` 不抛异常；
   「纯叶子（零 IO 可单测）+ 薄 IO 层 + IoC port」模式；CommonJS + `'use strict'`。
7. **版本双轨制**：主轨道 4 源（`pyproject.toml` / `packaging/npm/package.json` /
   `services/backend/package.json` / `packaging/modules/modules.json`）组内必须一致；
   ai-backend 轨道 2 源（`services/ai-backend/package.json` / `platform/packages/shared/package.json`）。
   **绝不手改 `platform/khy_platform/__init__.py`**。

## 五、验证命令清单

```bash
cd services/backend            # 后端改动后
node scripts/ci/check-agent-rules.js --changed   # 工程红线自动检查（根目录运行）
npm run check:layout                             # 顶层目录层级规范（L0-L6）
npx eslint src/ --max-warnings 0                 # lint
npx jest                                         # 单测
node scripts/ci/check-version-sync.js            # 版本一致性
khy doctor                                       # 系统健康总检
```

## 六、AI 助手须知（源自 AGENTS.md）

- 先读 `.ai/MAP.md`（骨架导航）、`.ai/CONTEXT.yaml`（机器可读契约）、`.ai/GUARDS.md`（红线）
- 快速校验单文件：`node -e "require('./services/backend/src/...')"`
- 用户配置数据在 `~/.khyquant/`（config.json 含 API key，已 gitignore，绝不提交）
- 切勿提交 `.env`、凭据、`node_modules/`

## 七、域（domain）与 khy-os 的对应关系

| domain | 覆盖范围 |
|--------|---------|
| cli | `services/backend/src/cli/`：REPL、路由、TUI 渲染、handler |
| gateway | `services/gateway/`：多供应商适配器、熔断、故障转移 |
| services | `services/` 其余：审计、token 统计、IM 通道(channels)、训练、回测 |
| kernel | `kernel/`：C 内核与 MoonBit 部分 |
| frontend | `apps/ai-frontend/` Vue3 应用 |
| khyquant | `software/khyquant/` 交易终端全栈 |
| platform | `platform/khy_platform/` Python 启动器与 @khy/shared |
| packaging | `packaging/`、pyproject、发布脚本、CI |
| cross | 跨域/仓库级任务（如全仓文档一致性、全仓检查） |

---

## 八、多机同步状态（速查，日期敏感，以最新为准）

> 多机判断标准：**每台机器本地 `HEAD == 共享 origin/main`**，则各机互相同步。
> 同步方向**按仓库各自的新旧**定：落后→`pull`，领先→`push`（验证后），分叉→以远程为准 + 本地 rebase 重放，绝不 force。
>
> **本仓库单仓自洽**（2026-09-17 起）：指挥部 khy-os-hq 的能力已吸收进本仓库，
> 数据真源在 `.ai/hq/`，命令面是 `khy hq`。**只剩一个仓库要同步** —— 原来
> 「先拉 HQ、再拉 khy-os」的双仓编排已不存在。

### 六步会话协议（单仓版）

```bash
# ⓪ 开工
git pull --ff-only                    # 只拉一个仓库
khy hq status                         # 看局面（含本机占用与他机占用）

# ① 领取任务
khy hq next                           # 按 PROCESS-102 五档瀑布自动选取 → 渲染自包含提示词
                                      # --json 出口 action: prompt|health|ask|idle|blocked；health=G0 验收债、ask=G4 平局待你定

# ② 执行（在本仓库内），③ 回填
khy hq task set T-002 done --note "..."
khy hq bug set BUG-001 pending_verify --root-cause "..." --fix "..."

# ④ 收工门禁
npm run check:structure

# ⑤ 推送
git add -A && git commit -m "..." && git push
```

### 租约（多机不撞车的机制）

`khy hq next` 领取条目时会写 `claimed_by / claimed_at / lease_expires`（120 分钟）。
**他机持有存活租约的条目会被本机跳过**，这是「两台机器几乎同时跑 `next` 也不会挑中同一条」
的结构性保障。机器掉线不致死锁：租约到期后条目自动重新可领。
收到 `action: blocked` 即表示该条目已被他机占用，不要硬做。

> 顺带根除一个隐患：此前 `tools/deepseek-eyes` 作为嵌套 git link 令 worktree 永久脏，
> 导致双机 autopull 的 `--clean-only`（要求**两仓都干净**）永不触发、任务闭环永不关闭。
> **改单仓判定后，这个故障模式从结构上不可能再发生。**

### 2026-09-17 现状

- khy-os：HEAD 落后工作区较多（大量未提交），基于 `git ls-files` 的读数一律偏小；
  判断「是否同步」请以 `git fetch && git status -sb` 的实际结果为准。
- 指挥部 khy-os-hq：**双轨期只读可用，不再写入**。数据已 1:1 迁入 `.ai/hq/`
  （4 个 JSON/MD + 19 个提示词，字节一致）。走顺 2 周后 `git clone --mirror` 归档并废弃远端。

---

## 九、khy-os 的「自动更新」分两件事（勿混）

**① 系统代码本身的升级 = 按需，不静默自装**
- 触发：用户敲 `khy update`（`cli/routerDispatchOps.js` 的 `case 'update'`），或 AI agent 调工具 `tools/khyUpdate.js` → 委托 `services/khySelfUpdateService.js`。
- `checkUpdate()`：只读、绝不抛。同包比对（查「实际安装的包」PyPI 最新版 vs 本地版），PyPI 不可达返回 `indeterminate`，不谎报已最新。
- `applyUpdate()`：变更操作、标 high risk 走审批。命令为静态白名单 `pip install --upgrade <candidate>`（包名不取自模型输入→无注入）；**渠道共存**顺带 `npm install -g @khy-os/khy-os@latest`（防 pip/npm 双渠道下「一个旧、PATH 遮蔽以为升了」）；`pipFailurePolicy` 分类失败→代理直连重试、WinError 32 文件占用重试（等待+`--force-reinstall`）。返回结构化 `{success,changed,from,to,channels}`。
- 门控：`KHY_SELF_UPDATE`（默认开）、`KHY_MULTI_CHANNEL_SYNC`（默认开，关则只升 pip）。
- 启动只横幅提示最新版（`versionService.checkForUpdateAll()`），**不自动装**。
- 版本真源：双轨 4 源 + ai-backend 2 源；`khy doctor` / `check-version-sync.js` 校验；绝不手改 `platform/khy_platform/__init__.py`。**何时 bump、推哪里、什么自动触发**见 `[DESIGN-SEMVER-002]`（规则 `PROCESS-005`）。

**② 定时「自动」的部分 = 多机仓库自动同步（不是重装代码）**
- **已改单仓版**（2026-09-17）。原双仓 `sync.py --push-only --push-khyos --clean-only` 已随
  HQ 吸收而删除 —— 它存在的唯一理由是「协调两个仓库的 pull/push 顺序」，单仓后失去意义。
- 新形态：在 khy-os 仓库内 `git fetch --quiet` → 判定方向 → `--ff-only` 拉取 →
  推送**已提交**内容。**不再需要 `--clean-only` 的「两仓都干净」双条件。**
- `--push-only` 的纪律保留：只推已提交、绝不 `git add -A` 新建提交（避免把运行时脏文件扫进提交）。

---

## 十、通道选择判定（五通道决策矩阵速查）

> 单一真源：khy-os `docs/03_DESIGN_设计/[DESIGN-ARCH-071] 通道选择决策矩阵.md`
> （首屏压缩版在 khy-os `AGENTS.md` 架构速查「通道选择判定」节，两处同改）。
> 对 khy-os 做任何「一次读取/一次操作」前按序自问，**首个命中即停**：

1. 信息只在第三方 GUI 画面 / 需视觉验证？→ **看屏幕**（CH-5：`desktopControl` 总闸 `KHY_DESKTOP_CONTROL` + safetyGate 审批，最后手段）
2. 要改变系统状态？→ **禁止直写状态文件**，走服务直调/CLI/Web API 正门（校验、审计、FSM 在门内）
3. 只读 + schema 稳定 + 文件即真相？→ **直接读状态文件**（CH-1，仅只读豁免；数据目录由 `src/utils/dataHome.js` 解析）
4. 与 backend 同一 Node 进程？→ **服务层直调**（CH-2，require 服务模块，fail-soft `{ok,error}` 契约）
5. 否则按调用方分流：人/脚本/CI/跨语言 → **CLI**（CH-3）；前端/远程/并发/流式 → **Web API**（CH-4，端点经 `serviceDefaults.js`/env/`ai_manage_runtime.json` 运行时发现，不可达降级 CLI）

原则：**结构化优先、只读才直读、写必走正门、视觉只兜底。**
