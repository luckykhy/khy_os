# [DESIGN-ARCH-140] khy 启动卡顿定位与首帧前置方案

> **隶属**：TUI 设计族（总纲 `[DESIGN-ARCH-122]`）；与 `[DESIGN-ARCH-115]`（启动板块）、`[DESIGN-ARCH-134]`（启动屏视觉）同族。
> **状态**：提案（未接线） · **日期**：2026-09-23 · **编号**：[DESIGN-ARCH-140] · **落点目录**：`docs/03_DESIGN_设计/`
> **证据基准**：2026-09-23 实测。方法 = node-pty 真 PTY 跑 `bin/khy.js`（`STARTUP_PROFILE=1`），逐块记录输出时间戳；另跑一组**无 git** 的对照。所有耗时均为本机（D:\Portable 便携盘）实测，非估算。

---

## 0. 一句话

启动动画**不是慢，是排在整条链的最末端**：Ink 首帧要等 python 启动器 + node 模块图 + init + 认证 + setup + replSession 八件预热全部做完才挂载 —— 实测 **5.8 秒**（有 git）/ **21 秒**（无 git）里用户只能看到一条会被擦掉的 stderr 瞬时行；之后 **gateway 8 秒看门狗**又把动画多挂 8 秒。治法是把 Ink 首帧提到 `main()` 入口，让其余一切变成节拍表上的拍 —— 这正是 `[DESIGN-ARCH-115]` S2/D4 只落了一半的那一半。

---

## 1. 启动链实测

```
khy.bat → python -m khy_platform（cli.py:2436 main）
  ├ check_node()                       cli.py:2586（有缓存快路径）
  ├ ensure_bootstrapped()              cli.py:2654，_run_with_spinner("正在初始化运行环境")
  │    ├ 6 项并行修复                  _bootstrap.py:753-763（ThreadPoolExecutor）
  │    └ _maybe_prebuild_khyos_kernel  _bootstrap.py:543 → _pid_alive → tasklist spawn
  └ subprocess.run([node, khy.js])     cli.py:2790 ← 阻塞直到 REPL 退出
node bin/khy.js main()                 khy.js:1353
  ├ bootPhaseLine（stderr 瞬时行）      khy.js:1365-1378
  ├ init()                             khy.js:1414-1418
  ├ ensureAuthenticated()              khy.js:1963 → 打印「登录  shelltest」khy.js:688
  ├ setup({mode:'khy'})                khy.js:1969
  └ startRepl()                        khy.js:1981
       └ replSession 预热（Ink 预加载 + App 预 require + workspace trust + git init
          + 任务清理 + checklist + 源码自愈 + onboarding + skill sync）
            → startInkApp() → BootScreen 首帧      ← 动画在这里才开始
```

**两组 PTY 实测时间线**（`STARTUP_PROFILE=1`，cwd=`D:\Portable`）：

| 时刻 | 有 git（贴近用户机器） | 无 git（对照） |
| --- | --- | --- |
| 0.19–0.59s | 阶段行 + 「登录 shelltest」+ Startup Profile | 同左 |
| 2.67s | git init 提示 | —— |
| **5.83s** | **BootScreen 首帧**（4/6 · 4.4s） | —— |
| **20.86s** | —— | **BootScreen 首帧**（4/6 · 16s） |
| ~9s | 欢迎横幅 + 输入框 | —— |
| ~18.9s | `⚠ gateway.init timed out after 8s` | —— |
| **51.10s** | —— | 欢迎横幅 + 输入框 |

**Startup Profile（node 进程内部时钟）**：`entry 0 → init:start 96ms → init:done 121ms → setup:start 130ms → setup:done 139ms`。

> **khy.js:1957-1960 的注释已过时**：它写「认证 + setup 同步 require redis/sequelize/database/aiGateway，暖机 ≈5s、冷启动数十秒」。实测 `mode:'khy'` 下 `setup.js` **跳过 DB 与迁移**（`setup.js:7`、`:54` 只在 `khyquant` 分支），全程 **9ms**。真正的等待全在 `startRepl` 的预热与 ink 预加载。

---

## 2. 病灶清单（E1–E6）

| # | 病灶 | 证据 | 用户可见后果 |
| --- | --- | --- | --- |
| **E1** | **动画排在链尾**：BootScreen 首帧前要跑完 python 启动器 + node 模块图 + init + 认证 + setup + 八件预热 | 上表：动画首帧 5.83s；`startRepl` 的预热全在 `startInkApp()` 之前（`[DESIGN-ARCH-115]` §3.2 实测顺序） | **前 5.8 秒屏幕上只有一条会被任何输出擦掉的 stderr 行** —— 这就是「卡住、动画不出来」的直接原因 |
| **E2** | **gateway 8s 看门狗把动画多挂 8 秒** | 实测 `⚠ gateway.init timed out after 8s`；`App.js:46-48` `GATEWAY_DEGRADE_MS` | 动画出现后还要再等 ~3-8 秒才见到输入框（无网关/无代理环境恒触发） |
| **E3** | **git 检测失败路径放大 3-4 倍** | 对照实验：无 git 时动画 5.83→20.86s、横幅 9→51s；`gitExecutableDetector.js:136-155` 逐候选路径探测，每次 spawn ~300ms | 无 git / git 不在 PATH 的机器上启动时间不可接受；且失败信息只在链尾才打印 |
| **E4** | **内核预构建状态机残留 + 每 boot 两次 `tasklist`** | `D:/WorkBuddyData/.khyos/cache/.khy_kernel_prebuilt = building pid=47052 attempt=2`（09:15），`kernel-build.log = ✗ 当前环境不支持交互终端`；`_pid_alive` = `tasklist` spawn **实测 306ms/次**（`_bootstrap.py:323`） | 每次启动白付 ~0.6s；6h 退避到期后还会再 spawn 一次**注定失败**的构建（本机无工具链），再留 11s+ 的日志与残留 |
| **E5** | **`khy` 在任意 cwd 会把该目录 git init** | 实测 stderr：`已将当前目录初始化为 Git 仓库：D:\Portable（方便提交 / 回滚 / 管理）。如不需要：KHY_AUTO_GIT_INIT=off` | 用户在 `D:\Portable` 敲 `khy`，结果**便携盘根目录被建成了 git 仓库** —— 副作用超出预期 |
| **E6** | **进程地板** | 实测：python 裸启 298ms、`import khy_platform.cli` 344ms、node 裸启 242ms、`require(bin/khy.js)` 全图 600ms、`import('ink')` 冷启 797ms | 即使全部串行优化，仍有 ~1.5-1.7s 是跨进程 + 模块加载的物理地板 |

---

## 3. 修复方案

### 3.1 P0 —— 首帧前置（治「卡住」的手感，预期 5.8s → <1.5s）

**动作**：`main()` 入口先挂 BootScreen，其余全部变成节拍。

- `startRepl` 拆成两段：`mountBootScreen()`（只 require `inkRuntime` + BootScreen 骨架，零业务依赖）与 `continueBoot()`（现有预热作为节拍回调）。
- `replSession.js:332-638` 的每一步改调 `beats.start/done/fail` —— 节拍真源早已就位（`[DESIGN-ARCH-134]` 已接），缺的只是**把重活搬进节拍里**。
- BootScreen 在 `init()` 之前挂载 ⇒ 挂载路径**不得读 env** —— 这恰好与 BootScreen 的纯渲染纪律一致（`[DESIGN-ARCH-134]` §3.4 已立）。
- `KHY_BOOT_SCREEN=0` 语义保持：关 → 直接走今天的旧路径（逐字节回退）。

**为什么这是「完成既有设计」而不是新设计**：`[DESIGN-ARCH-115]` §4.2 规则 1「每拍必须有真实工作负载」、§5 S2「C 区首帧即存在」、D4「pre-mount 八件事用户看不到」—— 节拍真源和渲染器都已经落地，**唯独最重的预热没有进节拍**。本方案就是把 S2/D4 补完。

**取舍**：挂载提前意味着首帧时 `.env` 未加载、认证未完成 —— 界面上只能显示「拍名」，不能显示「已登录 shelltest」这类结果（结果在各自拍 done 时才有）。这与 134 号方案「不塞假数据」的纪律一致。

### 3.2 P1 —— 三块已量化的等待

| 方案 | 动作 | 预期效果 | 取舍 |
| --- | --- | --- | --- |
| **gateway 看门狗 8s → 2s + 后台重试** | `GATEWAY_DEGRADE_MS` 降为 2000，超时降级后**后台继续探测**，成功则静默恢复（绝不重印横幅） | 横幅出现 ~9s → **~3s** | 慢网关用户会先看到「⚠ 网关降级」黄标，几秒后自动消失；需保证恢复不触发重绘抖动（走 H10 单槽） |
| **git 检测收敛** | `gitExecutableDetector` 一次 spawn 定案 + 结果缓存（进程内 + `~/.khy/cache/git-path.json`，记录版本与探测时刻，失效即重探）；失败**立刻**给指引并跳过后续 git 步骤 | 无 git 机器 **-15~40s**；有 git 机器 -0.3~0.6s | 磁盘缓存要处理 git 升级换路径：记录版本号，不匹配即重探一次 |
| **内核预构建残留治理** | ① 用户侧立即（见 §4）；② 代码侧：面包屑 `errorType=not-a-tty` 的失败**不再重试**（直接写 `gave-up`，`_decide_kernel_prebuild_action` 的状态机已支持该终态）；`_pid_alive` 两次 `tasklist` 合并为一次批量探测或进程内缓存 | 每次 **-0.6s**；消除未来某次启动的 11s 失败重试与残留 | 关闭自动构建会让首次 `khy os` 变慢 —— 但本机没有编译工具链，本来也构建不出来（日志为证） |
| **E5 收敛：git init 只在项目目录做** | `KHY_AUTO_GIT_INIT` 默认值改为「仅当 cwd 在仓库/项目内」，便携盘根目录这类非项目 cwd 不动；或首次询问 | 避免把 `D:\Portable` 建成仓库 | 改默认值属行为变化，需维护者拍板（本文只登记） |

### 3.3 P2 —— 地板（收益递减，可选项）

| 方案 | 预期 | 取舍 |
| --- | --- | --- |
| `import('ink')` 与 `init()` 并行（现在串行） | -0.5s | 几乎零风险，收益也最小 |
| 常驻 daemon + `khy attach`（复用 `backend_runtime.json` 机制） | 进程地板 1.5s → ~0.2s | 要管守护进程生命周期、崩溃恢复、版本切换，复杂度最高；与「便携盘冷读」叠加后收益不稳定 |

**不建议做**：把预热挪进后台线程/worker —— 它们大多直接摸文件系统与 DB，搬进 worker 只是把阻塞换个地方；真正该做的是**让用户看得见**（P0），而不是让它们更快。

---

## 4. 用户侧立即处置（不改代码，今天就生效）

```powershell
# 1) 关掉注定失败的内核自动构建（本机无工具链，日志已证）
setx KHY_KERNEL_AUTOBUILD 0
# 2) 清掉 09:15 留下的残留（锁 + 状态标记）
Remove-Item -LiteralPath "D:\WorkBuddyData\.khyos\cache\.kernel-prebuild.lock" -Force
Remove-Item -LiteralPath "D:\WorkBuddyData\.khyos\cache\.khy_kernel_prebuilt" -Force
# 3) 若不需要在 D:\Portable 做 git 仓库
Remove-Item -LiteralPath "D:\Portable\.git" -Recurse -Force   # ← 危险，先确认里面没有你自己的提交
#    或者只关掉这个行为
setx KHY_AUTO_GIT_INIT off
```

> ⚠️ 第 3 步删除 `.git` 前先确认：那里面是否已经有你自己的提交（`git -C D:\Portable log --oneline`）。若是 `khy` 今天 2.67s 时自动建的，删掉无损失。

---

## 5. 诚实边界

| 边界 | 说明 |
| --- | --- |
| **26 秒 vs 5.8 秒的差距不能全归因于 git** | 无 git 对照跑里，git 检测失败只是其中一项；`replSession` 的其余预热（任务清理/checklist/源码自愈/onboarding/skill sync）同样在链尾且无独立计时。P0 落地后它们会各自变成一拍，那时才有分项数据 |
| **便携盘冷读未建模** | 本机 `D:\Portable` 是便携盘；本提案的所有实测都在**暖缓存**下完成。用户报「卡住」的那次很可能是冷启动，耗时可能是本表的 2-5 倍。这只能靠 P0（先给动画）缓解，不能靠优化消除 |
| **`reg.exe` 出现在链上** | 沙箱把 `reg.exe` 拦了（安全策略），两次 PTY 跑都在收尾阶段被拦。它属于哪个环节、耗时多少，本提案给不出数（待核实 3） |
| **没有实测用户那次卡死的完整时长** | 截图只有「登录 shelltest」一行，与实测的静默窗口一致，但无法反推那次到底等了多久 |
| **不新增 env** | 所有开关用可选参数与既有 `KHY_*`（`KHY_BOOT_SCREEN`/`KHY_AUTO_GIT_INIT`/`KHY_KERNEL_AUTOBUILD` 已存在）；`check:tui-gates` 实测 226 > 上限 220，禁止净增 |

---

## 6. 反模式（这条路别走）

1. ❌ **用 spinner/进度条把 5.8 秒「装」得没那么久**。`bootPhaseLine` 已经是瞬时行，它的问题不是不好看，而是**会被任何输出擦掉**（`bootPhaseLine.js:108-178` 的让位机制）—— 用户看到的正是「擦掉之后的长静默」。治本是把首帧提前，不是美化等待。
2. ❌ **为了动画提前而把 BootScreen 做成独立 React 根 / alt-screen**。违反 `[DESIGN-ARCH-102]` P1（Gemini CLI 上线 alt-mode 一周内回滚的前车之鉴）与 P8「一条路径胜过两条」—— P0 的挂载提前复用**同一个** App 树与节拍真源，不开第三条根路径。
3. ❌ **把 `setup()` 当优化重点**。`khy.js:1957-1960` 的注释说它 5s，实测 9ms —— 注释驱动优化会浪费一轮。优化前先跑 `STARTUP_PROFILE=1` 看真数。
4. ❌ **给 gateway 加重试次数/超时上限来「修」8 秒**。它是**看门狗**（降级而非完成，`[DESIGN-ARCH-115]` 规则 3：超时只用于降级）；正确做法是缩短降级阈值 + 后台重试，绝不能让它变成「等满 8 秒才算就绪」。
5. ❌ **在 git 检测里加更多候选路径**。E3 的病根是**逐路径串行 spawn**，加候选只会更慢；正确方向是「一次定案 + 缓存 + 失败早退」。
6. ❌ **用 `-n` 之类的新 env 开关做本次回滚**。门预算棘轮 226/220 已 FAIL；回滚靠 `KHY_BOOT_SCREEN=0`（已存在）与 git revert。

---

## 7. 验收（可机器验证）

| # | 判据 | 怎么测 |
| --- | --- | --- |
| 1 | 回车 → BootScreen 首帧字节 **≤ 1.5s**（有 git、暖缓存） | node-pty 时间戳探针（本提案的 `pty_probe.js` 手法） |
| 2 | 动画期每一拍都有真实工作，无时长驱动空壳拍 | 扩 `startupBeatsWiring.test.js`：禁止 `setTimeout(*, N)` 触发 `beats.done` |
| 3 | gateway 降级后恢复**不重印横幅**、不抖动 | H2 门（零 `ESC[2J`）+ P2 判据（A 区字节计数不变） |
| 4 | git 缺失时启动时间与有 git 时差值 **≤ 1s** | 两次 PTY 对照 |
| 5 | 零新增 `KHY_*` | `node scripts/ci/check-tui-gates.js` 计数仍为 226 |
| 6 | 既有启动套件零回归 | `node --test services/backend/tests/cli/startupBeats.test.js tests/cli/tui/startupBeatsWiring.test.js` = 17 + 8 全绿 |

---

## 8. 待核实项

| # | 事项 | 影响 |
| --- | --- | --- |
| 1 | `replSession.js:332-638` 八件预热**逐项**耗时（现在只有总和） | 决定 P0 之后还剩哪几拍值得单独优化；P0 落地后节拍表天然给出分项数据 |
| 2 | 便携盘**冷缓存**下的整链耗时 | 决定 P2 的 daemon 是否值得做；需一次冷启实测（重启后首跑） |
| 3 | `reg.exe` 由哪个环节调用、耗时多少 | 沙箱黑名单拦下，本机未测；若在热路径上且 ~100ms 级，并入 P1 的 spawn 收敛 |
| 4 | `D:\Portable\.git` 是不是今天 2.67s 那次自动建的 | 决定 §4 第 3 步能不能直接删；`git -C D:\Portable log --oneline` 一看便知 |
| 5 | 用户那次卡死是否伴随 `KHY_KERNEL_AUTOBUILD` 的重试 spawn | 若是，15:15 之后每次启动都会白付 11s；按 §4 处置后消失 |

---

## 9. 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-09-23 | 初版。给出完整启动链与两组 PTY 实测时间线（有 git 5.83s 动画 / 无 git 20.86s 动画）；登记 E1–E6（链尾动画、gateway 8s、git 失败路径、内核预构建残留 + 306ms/次的 tasklist、任意 cwd 自动 git init、1.5s 进程地板）；方案 = P0 首帧前置（完成 115 号的 S2/D4）+ P1 四项 + P2 两项；含用户侧立即处置、6 条反模式、7 条验收与 5 项待核实 |
