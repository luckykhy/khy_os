# [DESIGN-PERF-003] TUI 启动阻塞治理方案

> **状态**：提案（未接线） · **日期**：2026-09-22 · **编号**：[DESIGN-PERF-003] · **落点目录**：`docs/03_DESIGN_设计/DESIGN-PERF/`
> **适用层**：`services/backend`（`khy` 交互入口 → Ink TUI）
> **本文作者准则**（沿用 `[DESIGN-PERF-002]`）：**不动现状代码 / 不动测试 / 不动配置**。产物是「实测证据 + 可实施计划 + 验收指标」。
> **证据基准**：全部 `文件:行号` 与数字为 **2026-09-22 本机实测**（仓库 `D:\Portable\khy-os`，Windows 10.0.26200，Node v22.18.0）。凡推测项显式标注「**【推测】**」。
> **关联**：[DESIGN-PERF-002] khy-cli 交互流畅度修复方案 v1（同族上游） · [DESIGN-ARCH-115] TUI 启动板块设计（启动板块结构真源） · [DESIGN-ARCH-102] Khy TUI 统一规则手册（H1–H10，冲突以它为准） · `services/backend/src/cli/tui/AGENTS.md`（§0.2 渲染安全 / §0.3 性能底线 / §4.1 启动阶段） · [DESIGN-PROCESS-002] 新机制落地阶段（`PROCESS-006`/`PROCESS-008`）

---

## 零、一句话结论

**khy TUI 启动慢的根因不是「加载不够懒」，恰恰相反——这个仓库的懒加载已经做得很彻底，而那些懒加载正落在被阻塞的首帧渲染里。**

实测：真实 TTY 下首个字节 297–1558ms，**Ink 进备用屏 8.8–11.5s，BootScreen 首帧 10.9–15.9s**；其中 `render()` 是**同步**调用，单次阻塞事件循环 **2.0–16.3s**（run 间方差极大，见 §3.1），**且阻塞并不随 `render()` 返回而结束**——有一次实测全部节拍在 3822ms 就已终态，但事件循环直到 **21202ms** 才重新跑定时器回调（即之后又连续被钉住约 17.4s）。CPU 归因显示阻塞窗口内 74.6% 花在 **Node 模块解析/编译** 与 **同步文件系统 IO**，空闲仅 3.7%。

> 对照 `tui/AGENTS.md` §0.3「冷启动 <100ms」「禁止同步阻塞事件循环超过 16ms」——现状是超预算 **100~160 倍**、超阻塞上限 **300~1000 倍**。

**所以本方案的方向不是「更懒」，而是反向的**：**把同步 IO 从渲染期清出去。**

> ### ⚠ v2 更正：初版的第一条建议已被实测证伪
> 初版（v1）本节写的是「**① 把加载挪到既有的异步预热窗口（更早）**；② 把同步 IO 从渲染期清出去」。
> **实施阶段用交错 A/B 证伪了 ①**：`setImmediate` 里的**同步阻塞工作仍然阻塞事件循环**，落在挂载前只会**推迟挂载**，不减少总墙钟。实测「有预热」相对「无预热」把首帧时间从均值 5013ms 拉到 **7975ms**（详见 §6.0 与 `.khy/feedback/DESIGN-PERF-003-startup-unblock/differential.md` 候选 C）。
>
> **正确的判据是**：一份同步工作要么**不在关键路径上**，要么**被消除**；「换个位置放」不算优化。
> 同理，把模块顶层探测改成**惰性**（候选 B）也只是把阻塞推后到交互窗口，实测直接打破了 TUI 套件里一条绿测试，已回滚。
>
> 本文档下面所有涉及「前移/预热」的表述，**一律以本条为准**。

---

## 一、问题陈述

### 1.1 症状

用户感知：`khy` 启动后要等十秒量级才看见界面、才能打字。这不是「某一处慢」，而是**两段各约 7 秒的整屏停顿**夹在启动链里。

### 1.2 与既有文档的关系（不是重复劳动）

| 文档 | 已覆盖 | 本文的增量 |
|---|---|---|
| `[DESIGN-PERF-002]`（2026-08-31 定稿） | 阶段 A 打 bundle / 阶段 B `KHY_FAST_STARTUP` 默认开 / **阶段 C 顶层 require 瘦身** / 阶段 D 首 token 解耦 | 实测证明「只把顶层 require 变懒」**不足以**修好启动：成本会平移到首帧。本文给出**平移到哪里、怎么不平移** |
| `[DESIGN-ARCH-115]`（2026-09-16 提案） | 启动板块节拍表、D1（1.5s 硬超时绑架就绪）已修、`startupBeats.js` 已落地 | 本文测的是**节拍表之下的执行成本**：节拍表已经正确，但它显示「渲染引擎」这一拍时，那一拍本身在阻塞 4.7–16.3s |

**结论**：本文不推翻任何既有设计，是给它们补上**实测的成本账**与**正确的优化方向**。

---

## 二、测量方法（可复现）

三个探针**已入仓** `_产物/`（沿用 `tui/AGENTS.md` §0.9.6 记录的「探针脚本落 `_产物/`」惯例，与既有 `_产物/touch-cost-probe.js` 同级）：

| 探针 | 落点 | 手法 | 回答什么 |
|---|---|---|---|
| **P1 端到端** | `_产物/tui-startup-probe-e2e.js` | `node-pty@1.1.0`（仓库根 `node_modules` 已有）起**真实 ConPTY**，spawn `services/backend/bin/khy.cmd`，逐 chunk 打时间戳，按里程碑字符串定位 | 用户真实感知时间线 |
| **P2 分层** | `_产物/tui-startup-probe-require.js` | 直接 `require` TUI 图，`Module._load` 钩子记**自耗时**（exclusive），区分 repo / node_modules | 加载成本与最重模块 |
| **P3 归因** | `_产物/tui-startup-probe-render.js` | 无头 `render(<App/>)` + 假 TTY（抄 `tests/tui/liveFrameGeometry.test.js` 的 `fakeStdout/fakeStdin` 手法），可配 `--cpu-prof` | 阻塞期到底在跑什么 |
| **P3 分析** | `_产物/tui-startup-probe-profile.js` | 把 `.cpuprofile` 归成桶表 + 自耗时榜 + 指定函数的**祖先调用链** | 「哪一行在阻塞」 |

**P3 的三条硬前置**（`tui/AGENTS.md` §0.9.6 规定，缺一条结论即不可信，本文已遵守）：
① 走仓库自己的 `inkRuntime`（`registerJsx()` → `await loadInk()` → `ir.get()`），不裸 `import('ink')`；
② `FORCE_COLOR` 在任何 chalk/ink 相关模块被 require **之前**设置；
③ 同时改 **真实** `process.stdout.rows/columns`（App 从 `process.stdout` 取尺寸，不从渲染流取）。

**复现命令**：

```
# P1：端到端（默认 12s，可传毫秒；STARTUP_PROFILE=1 可同时拿到 pre-mount 检查点）
STARTUP_PROFILE=1 node _产物/tui-startup-probe-e2e.js 20000

# P2：分层（自耗时 + 最重模块榜）
node _产物/tui-startup-probe-require.js

# P3：归因（渲染 + 节拍链；再分析 profile）
node --cpu-prof --cpu-prof-dir="%TEMP%/khyprof" _产物/tui-startup-probe-render.js
node _产物/tui-startup-probe-profile.js "%TEMP%/khyprof/<file>.cpuprofile" --chains listPersistedSessions,spawnSync,wrapSafe
```

三探针均从**仓库根**运行即可（内部按 `__dirname/..` 推导仓库根、按绝对路径解析 `node-pty` / `react`，不依赖 cwd）。

### 2.1 环境与不确定性（诚实边界）

1. **本机未安装 git**（`where git` 无结果，`C:\Program Files\Git` 不存在）。启动链会在 TUI 之前打印 `未检测到 git`（`gitExecutableDetector.js:142`）。**装 git 的机器这一段路径成本会不同**，故本文区间含此因素。
2. **run 间方差大**：同一探针连续运行的差异可达 2–3 倍（见 §3.1）。原因是同步文件 IO 命中率随 OS 文件缓存变化。故本文给**区间**，不给单点值。
3. **V8 编译缓存实测无效**：开关 `module.enableCompileCache()` 前后为 1524–1933ms vs 1310–1700ms，**在噪声内**。故本方案**不把它当收益项**（详见 §十）。

---

## 三、实测结果

### 3.1 端到端时间线（P1，真实 TTY，120×30）

| 里程碑 | run1（冷） | run2（热） | run3（热） |
|---|---|---|---|
| 第一个字节 | 1558ms | 425ms | 297ms |
| `正在加载 khy 运行时...`（`bin/khy.js:60`） | 2213ms | 611ms | ≤297ms 后 |
| 5 步阶段行走完（`✓ 就绪 (5/5)`） | 4144ms | 1914ms | ~1661ms |
| **Ink 进备用屏（`\x1b[?1049h`）** | 11476ms | 8759ms | 9219ms |
| **BootScreen 首帧可见** | >12000ms 未出现 | 15867ms | 10947ms |

结构读法（三 run 一致）：**~1.9s 走完环境/认证/5 步阶段行 → 约 7s 静默停顿 → 进备用屏 → 再 1.7–7.1s 才出首帧。**

**跨 run 观测区间（含后续复测，务必按区间引用而非单点）**：

| 里程碑 | 观测区间（多次实测） |
|---|---|
| 第一个字节 | **297–1558ms** |
| `bin/khy.js:60` 加载行 | 506–2213ms |
| 5 步阶段行走完 | 1575–4144ms |
| Ink 进备用屏 | **3853–11476ms** |
| BootScreen 首帧 | **5588–15867ms** |

**方差来源（按影响排序）**：① OS 文件缓存命中率（同步 IO 主导，故最敏感）；② 磁盘/CPU 同期负载；③ 会话与状态文件数量（见 B1）；④ 该机器未装 git，git 探测路径每次都要走失败分支。**【推测】** 装有 git 且磁盘空闲的机器会稳定落在区间下沿。方向性结论（「两段各数秒的整屏阻塞、由同步 IO 与首次模块解析主导」）在全部 run 中一致，不随区间浮动改变。

> 注意 `bin/khy.js:60` 只是文件第 60 行，冷启时它在 **2213ms** 才执行——即「cmd.exe 派生 + node 自身启动 + `bin/khy.js` 顶层 require 图」合计约 2.2s（冷）/ 0.6s（热）。

**`render()` 的单次同步阻塞（P3 实测，四次）**：`16303ms` / `4684ms` / `1961ms`（另有一次 6869ms 出现在带 `--cpu-prof` 的运行中，采样开销已含在内）。**方差接近 8 倍**，这正是「同步文件 IO + 全新模块首次解析」的特征：命中 OS 文件缓存的程度决定耗时。

**阻塞不止于 `render()`**：某次 P3 运行中，六拍全部终态发生在 **3822ms**，但 20ms 轮询直到 **21202ms** 才被调度——中间约 **17.4s 定时器零回调**，即事件循环被连续钉死（`render()` 在 3314ms 已返回）。说明首帧之后仍有整段同步工作（同源的懒 require + 同步 IO）。该数字为**观测项**，具体归属需按 L3 守卫落地后按调用点分类。

> 口径提醒：`[DESIGN-PERF-002]` §5.1 把「冷启 2-3s」作为基线，`[DESIGN-ARCH-115]` 记「整屏阻塞 ≥1.9s」。两次实测口径都**小于**本文，原因是它们量的是「pre-mount 阶段行 / 节拍表切换」，而本文量的是**真实 TTY 下到 BootScreen 首帧**（含 `render()` 的同步阻塞）。三个数字不矛盾，但**不可互换引用**。

### 3.2 分层成本（P2）

| 层 | 实测 | 说明 |
|---|---|---|
| `node bin/khy.js --version` | **447ms** | node 启动 + CLI 解析下限 |
| `services/backend/bin/khy.cmd --version` | **655ms** | 经 cmd 包装 |
| `python -m khy_platform --version` | **1198ms** | Python 启动器层 |
| ↳ 其中 bare `python -c` | 176ms | 解释器冷启 |
| ↳ 其中 `import khy_platform` | +186ms | 导入成本 |
| `import('ink')`（ESM） | **676 / 787 / 770 / 972 / 1159 / 1251 / 1382 / 1442 / 1517ms** | 波动最大，单点最重 |
| `require(App)` 图 | **285–724ms**，**199–208** 个 CJS 模块 | 其中 repo 一方自耗时 419ms / node_modules 62ms |

**Python 层净付约 750ms**（1198 − 447）。TUI 路径没有必须经过 Python 的理由——**【推测】** 走 node 直连可省这笔，但需先确认 `cli.py` 在交互路径上承担了什么（认证/引导/端口探测），故列为 L4 待评估项而非直接结论。

### 3.3 CPU 归因（P3，阻塞窗口 8185ms）

按自耗时分支：

| 桶 | 自耗时 | 占比 |
|---|---|---|
| node internals（模块解析/编译/stat） | 3487ms | **42.6%** |
| 其它原生/未归因（`readFileUtf8`/`lstat`/`open`） | 2618ms | **32.0%** |
| repo `services/` | 998ms | 12.2% |
| node_modules | 611ms | 7.5% |
| **idle（事件循环空闲）** | **300ms** | **3.7%** |
| GC | 91ms | 1.1% |

单函数 top：

| 自耗时 | 函数 | 性质 |
|---|---|---|
| 1043ms | `wrapSafe`（`node:internal/modules/cjs/loader:1578`） | CJS 编译包装 |
| 844ms | `readFileUtf8` | 同步读文件 |
| 591ms | `internalModuleStat` | 模块解析时 stat |
| 563ms | `readFileSync`（`node:fs:434`） | 同步读文件 |
| **554ms** | **`listPersistedSessions`**（`sessionPersistence.js:835`） | 同步扫会话目录 |
| 537ms | `getNearestParentPackageJSON` | 模块解析向上找 package.json |
| 265ms | `spawnSync`（`node:internal/child_process:1105`） | 同步派生子进程（**⚠ 此值被欠采样，见下方更正**） |
| 251ms | `lstat` | 同步 stat |

> **⚠ v2 更正：`spawnSync` 的真实量级远大于上表。** v1 的 profile 只捕捉到 `localLLMService` 模块顶层那一次探测（265ms），**漏掉了最大的那份**：渲染期逐适配器的 CLI 可用性探测，自耗时实测 **1806–2196ms**，是复测 profile 里的**第一大项**（占 34.5–42.8%）。完整调用链见 §4 的 B4。
>
> 复测（L2a 落地后、L1b 已回滚）的桶分布：node internals 3130ms(59.8%) / 原生未归因 1025ms(19.6%) / node_modules 476ms(9.1%) / **idle 仅 301ms(5.8%)**。**idle 始终只有个位数百分比**，即事件循环全程被占——这正是「不是 CPU 密集、而是同步 IO 把循环钉死」的判据。

**读法**：74.6% 是「模块机制 + 同步文件系统」，空闲只有 3.7%。这不是 CPU 密集，是**同步 IO 把事件循环钉死了**。

---

## 四、根因：四条阻塞点（含调用链）

### B1 · 首帧渲染期同步扫会话目录（554ms，且随会话数单调劣化）

调用链（CPU profile 直接证据）：

```
listPersistedSessions        @ services/backend/src/services/sessionPersistence.js:835
 ├─ getCurrentSessionId      @ services/backend/src/services/domain/session/session/sessionForestService.js:68
 │   ├─ _seedOnce           @ services/backend/src/cli/sessionColorState.js:25
 │   │   └─ getSessionColor @ services/backend/src/cli/App 侧调用点 App.js:4582   ← 渲染期
 │   └─ _resolveTodoFile    @ services/backend/src/tools/TodoWriteTool/index.js:22
 │       └─ snapshot        @ services/backend/src/tools/_taskStore.js:365
 │           └─ _readMergedTaskLines @ services/backend/src/cli/tui/ink-components/appHostHelpers.js:32
 │               └─ App      @ services/backend/src/cli/tui/ink-components/App.js:5994  ← 渲染期（第二次扫）
```

**机制**：`listPersistedSessions` 在 `sessionPersistence.js:845-882` **逐个 `readFileSync` + `JSON.parse` 每个会话文件**，然后才在 `:884-885` 排序并 `slice(0, limit)`。**`limit:50` 不约束 IO** —— 成本是 O(全部文件)。

**本机数据**：`.khy/sessions` = **547 个 JSON / 10.84MB**（`.khy` 全域 2397 个 JSON / 18.78MB / 693 目录）。

**后果**：**启动时间随会话累积单调变慢**——这正是「越用越慢」的机制。且 `getCurrentSessionId` 被上面两条路径**各调一次**，同一份扫描付两遍。

### B2 · mount effect 里同步 require 网关 → 触发模块顶层 `spawnSync`

```
spawnSync                     @ node:internal/child_process:1105   (265ms)
 └─ resolvePythonLauncher     @ services/backend/src/services/localLLMService.js:608
     └─ (anon) @ localLLMService.js:1                  ← ★ 模块**顶层**就执行
         └─ require localLLMAdapter.js:1
             └─ require aiGateway.js:1
                 └─ refreshFooter @ App.js:805        ← ★ useEffect 里 require
                     └─ App.js:4151                   ← mount 被动 effect
```

**机制**：`App.js:805-808` 的 `refreshFooter` 在 effect 内 `require('../../../services/gateway/aiGateway')`；该图拉进 `localLLMAdapter` → `localLLMService`，而 `localLLMService` **在模块体里**就调 `resolvePythonLauncher()`，后者 `spawnSync('python', ['--version'])`。

**后果**：为了画一行页脚，付掉**一次子进程派生 + 整条网关模块图的解析编译**，且发生在 mount 被动 effect（紧随首帧），用户直接看到卡顿。

### B3 · 模块解析/编译本身落在渲染窗口内

`wrapSafe` 1043ms + `internalModuleStat` 591ms + `getNearestParentPackageJSON` 537ms + `compileSourceTextModule` 196ms ≈ **2.4s** 属于「为此刻才第一次 require 的模块做解析与编译」。

注：`useQueryBridge.js:695`（在 `listOnTimeout` 里）require `toolUseLoop` 亦属此类；**该条已在 `replSession.js:361-365` 预热**，真实路径下代价较小，此处仅记录不作为主因。

### B4 · 渲染体里逐适配器派生进程探测 CLI（实测最大单点，v2 新增）

**这是本文档 v1 遗漏、复测才暴露的最大阻塞点。**

调用链（CPU profile 直接证据）：

```
spawnSync                                          @ node:internal/child_process:1105   (1806–2196ms)
 └─ spawnSync                                      @ node:child_process:856
     └─ _probeSync                                 @ gateway/adapters/_commandAvailability.js:45
         └─ isAvailable / check                    @ gateway/adapters/_commandAvailability.js:87/141
             └─ commandExists                      @ gateway/adapters/cliToolAdapter.js:282
                 └─ detect                          @ gateway/adapters/cliToolAdapter.js:347
                     └─ getStatus                   @ gateway/adapters/cliToolAdapter.js:1522
                         └─ getStatus               @ gateway/aiGatewayModelMethods.js:331
                             └─ getBannerData       @ cli/bannerDataService.js:27
                                 └─ WelcomeBanner   @ tui/ink-components/WelcomeBanner.js:58   ← ★ 渲染体
```

**机制**：`WelcomeBanner` 在**组件渲染体内**调用 `getBannerData()`；该函数经 `aiGateway.getStatus()` **逐个适配器**探测其 CLI 是否可用（`claude --version`、`codex`、`warp`、剪贴板中继……），每次一个 `spawnSync`。而 `getBannerData()` **自身不做 memo**，`WelcomeBanner` 又是 `React.memo` 组件——props 一变就重渲、重渲就重新探测全部适配器。

**量级**：`spawnSync` 自耗时 **1806–2196ms**，复测 profile 的**第一大项**（占 34.5–42.8%）。

**为什么 v1 漏了它**：v1 那份 profile 是冷启首轮，采样把这段时间算在了别的帧/别的桶里（当时 `spawnSync` 只报 265ms，对应的是 B2 的模块顶层那一次）。**教训**：单次采样无法给「同一函数的多条调用链」分别定量，必须按**祖先链**聚合——这正是 `_产物/tui-startup-probe-profile.js --chains` 存在的原因。

**未在本轮修复**：正解是让横幅的状态行**异步落值**（首帧先画不含网关状态、就绪后补），或让 `getStatus()` 走缓存/异步。前者触及帧高账本与 live 预算这一高敏区（`AGENTS.md` §0.9.2），需单独评审。

---

## 五、关键判断：为什么不能照字面加「懒加载」

这一节是本方案与直觉分歧最大、也最需要写清楚的地方。

### 5.1 懒加载在这个仓库已经做得很彻底

- `tui/AGENTS.md` §4.2 明文规定用 `React.lazy` / 条件 require，并**禁止**「启动时加载所有模块」；
- `[DESIGN-PERF-002]` 阶段 C 已把「顶层 require 瘦身」列为主计划；
- `replSession.js:382-419` 已提前 fire `loadInk()`、`setImmediate` 预 require `App`、预热 `toolUseLoop` / git / geo；
- `App.js` / `useQueryBridge.js` 的多数重模块已是 try-require / 懒 getter。

### 5.2 于是懒加载把成本平移到了首帧

顶层 require 变少 ≠ 总成本变少。原来在「进程启动、用户看不见」时加载的东西，改成「首帧渲染、用户正盯着」时加载——**同一笔钱，挪到了最贵的时刻**，并且因为渲染是同步的，它还会**阻塞整条事件循环**，连 spinner 都转不动。

**这条判断可被本方案的实测直接验证**：profile 里 idle 只占 3.7–5.8%，而模块机制 + 同步 IO 占约 75–80% —— 如果真是「加载太多」，正确的解法是**减少加载**；但 `import('ink')` 是**不可省**的（不装 ink 无法画屏），`App` 图也是**不可省**的。**能省的只有「同步性」与「在不在关键路径上」。**

### 5.3 结论：方向反过来

| 直觉方案 | 实际效果 | 正确做法 |
|---|---|---|
| 更懒（`React.lazy`、更多 try-require） | ❌ 把成本推进渲染窗口 | **不在关键路径上**：让该工作不参与首帧（异步落值 / 缓存 / 消除） |
| ~~**更早**：挪进 `replSession.js` 既有异步预热窗口~~ | ❌ **已证伪**（§6.0 ①）：同步工作换个位置仍是同步工作，只**推迟挂载** | 见上：位置无关紧要 |
| 零加载（首帧不加载任何模块） | ❌ 物理不可能：ink 不装载就画不出 | **首帧零 IO**：模块可已备好，但首帧不 touch 磁盘、不派生进程 |
| 换更快加载器 / 打包 | ⚠️ 有效但重（`[DESIGN-PERF-002]` 阶段 A） | 与本文正交，**不应混在一次提交** |

---

## 六、方案（L0–L4）与实施状态

> **本节已按实测更新（v2）。** 每层标注 `已落地` / `已证伪` / `待办`。被测否掉的两条路见 §6.0 —— **那两条是本节最有价值的部分**。

### 6.1 状态总览

| 层 | 内容 | 状态 | 依据 |
|---|---|---|---|
| L0 | 首帧零 IO（验收基线） | 守住 | 首帧已由 `startupBeats` / `BootScreen` 承担 |
| **L1** | **加载/预热前移** | **已证伪，未采纳** | 首帧均值 5013 → **7975ms**（§6.0 ①） |
| **L1b** | `localLLMService` 顶层探测改惰性 | **已实现 → 已回滚** | 打破 TUI 套件一条**原本是绿**的测试（§6.0 ②） |
| **L2a** | `listPersistedSessions` 解析缓存 | **✅ 已落地** | 重复调用 5206ms → **17ms**；输出逐字段相同 |
| L2b | 合并两次 `getCurrentSessionId` | **被 L2a 吸收** | 缓存使第二次近乎免费，无需改调用方 |
| L2c | `_readMergedTaskLines` 移出首帧 | 待办 | 需动帧高账本，单独评审 |
| **B4** | 横幅逐适配器探测移出渲染 | 待办（**最大单点**） | 1806–2196ms，见 §4 B4 |
| L3 | 渲染期同步 IO 守卫 | 待办 | 见下 |
| L4 | 进程层（Python 层 / `khy.bat`） | 待办 | 见下、§十 |

### 6.0 两条被实测否掉的路

**① 「把工作搬进异步预热窗口」不成立。** 交错 A/B（`KHY_PROBE_SKIP_PREWARM` 临时开关，各 2 轮，测后已从源码移除）：

| 组 | alt-screen | 首帧 | 首帧−alt-screen |
|---|---|---|---|
| A1 无预热 | 5450ms | 7140ms | 1690ms |
| B1 有预热 | 8083ms | 8432ms | 349ms |
| A2 无预热 | 2377ms | 2885ms | 508ms |
| B2 有预热 | 7178ms | 7517ms | 339ms |

预热**确实**把「挂载后到首帧」的间隔从 1690 / 508ms 压到 349 / 339ms —— 但把**挂载本身**推迟 2.5–4.7s，**首帧总时间反而变差**（均值 5013 → 7975ms）。
机制：`setImmediate` 里的同步工作**仍然阻塞事件循环**，落在挂载前就是纯加法。

> **判据**：一份同步工作要么**不在关键路径上**，要么**被消除**；**「换个位置放」不算优化。**

**② 「把模块顶层阻塞探测改成惰性」也只是推后。** 该改动（L1b）实测把模块加载期 `spawnSync` 调用数从非 0 降到 **0**、加载耗时 28ms —— 但随即打破了 TUI 套件里一条**原本是绿**的测试（`ccOverlayFit`「80×24：正在打字时按 `?` 只打问号，不呼出帮助菜单」）。
机制：被推迟的阻塞探针落进了**交互窗口**，而该测试用固定 `wait(300)`，于是按键处理时序被改变、`?` 在 `a` 尚未登记时被处理 → 帮助菜单被呼出。**已回滚。**

> 两次否掉都指向同一条纪律：**对「阻塞式同步工作」，位置无关紧要，只有「在不在关键路径上」要紧。**

### L0 · 首帧零 IO（守住，不新增行为）

**目标**：首帧（BootScreen 节拍表）不 `require` 重模块、不读盘、不派生进程。

**现状**：`startupBeats` + `BootScreen` 已把「首帧画什么」做对了（`[DESIGN-ARCH-115]` §4/§5 已落地）。**本层不是新功能，是给 L2a 之后的验收立基线**，并把 B1/B2/B3/B4 四类回潮卡在门口（见 L3）。

**预期收益**：0ms（它是基线） · **风险**：无 · **回退**：无需

### L1 · ~~加载前移~~（已证伪，见 §6.0 ①②）

原方案主张「把 B2/B3 的首次 require 挪进 `replSession.js:401-419` 的预热窗口」。**实测否掉**：该窗口里的同步工作仍阻塞事件循环，只推迟挂载。

保留其中**唯一未被否掉**的一条，但它也**不是**「前移」而是「移出路径」：`localLLMService.js` 模块顶层的 `spawnSync` 探测终归不该在启动链上 —— 正解是让它**异步化**（或在真正需要本地 LLM 时才同步探测），**不是**改成惰性（§6.0 ② 已证伪惰性版）。该项**待办**。

### L2 · 去阻塞（部分落地）

#### L2a · `listPersistedSessions` 解析缓存 —— ✅ 已落地

**落点**：`services/backend/src/services/sessionPersistence.js`（`listPersistedSessions` 及其新增的 `_buildSessionMeta` / `_readSessionMetaCached`）。

**做法**：把「调用即重读全部快照」改为**按文件缓存解析结果**，键为 `(mtimeMs, size)`；命中则只 `statSync`。快照文件的列表驱动淘汰，故删除/清理后条目自动失效。**未新增任何 `KHY_*` 门控**（H7 + 现状 226/220 已超标）。

**输出等价性**：`mtimeMs`/`size` 变动的文件必重读；消失的文件必淘汰；每次调用返回**新对象**（与原实现一致，调用方可安全改写）。理论陈旧窗口仅剩「同一 mtime 刻度内被改写成同样大小」。

**实测**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 同进程内第 2 次调用 | 约 276ms（与第 1 次同量级） | **17ms** |
| 第 3 次调用 | 约 276ms | **14ms** |
| 三次调用结果 | — | `JSON.stringify` 逐字节相同 |
| profile 内 `listPersistedSessions` 自耗时 | **554ms**（当时最大 repo 单函数） | 跌出榜首（`_readSessionMetaCached` 68ms） |
| profile 内 `readFileSync` 自耗时 | 563ms | 107ms |

**回退**：单文件 revert。

#### L2b · 合并两次 `getCurrentSessionId` —— 被 L2a 吸收

原计划改两处调用方（`sessionColorState.js:25` 与 `TodoWriteTool/index.js:22`）。L2a 落地后第二次解析已近乎免费，**改调用方的收益不足以抵其风险**，故不单独施工。

#### L2c · `_readMergedTaskLines` 移出首帧 —— 待办

需要把渲染体内的一次读取改为 state + effect。**不做**的理由：该读取结果进入 `_liveBudget.capTaskLines` 的高度账本（`App.js:5986-6010`），而帧高 ≤ `rows−1` 是 `AGENTS.md` §0.9.2 的硬约束、有属性测试覆盖。**改动它等于改帧几何，须单独一轮并带帧高回归测试。**

#### L2d · B4 横幅探测移出渲染 —— 待办（**优先级最高**）

`WelcomeBanner.js:58` 在渲染体调 `getBannerData()` → 逐适配器 `spawnSync`（1806–2196ms）。
**正解**：横幅状态行**异步落值**（首帧先画不含网关状态的值，就绪后补一行），或让 `gateway.getStatus()` 结果带短 TTL 缓存。
**不做**的理由与 L2c 同类（帧高账本），但它量级最大（占 profile 34.5–42.8%），建议优先排期。

### L3 · 把既有硬约束变成机器可校验（防回潮）

**背景**：`tui/AGENTS.md` §0.2 写着「❌ 禁止同步阻塞事件循环超过 16ms」，**但目前没有任何检查器执行它**——这正是 B1/B2 能长期存在而无人报警的原因。

**做法**：把本文 P3 的探针思路做成一条**渲染期同步代价守卫**：在渲染窗口内命中 `readFileSync` / `spawnSync` / 首次 `require` 即记录（finding）。

**门控纪律（硬约束，不可放宽）**：

- **净新增 `KHY_*` 门控 = 0**。依据 `[DESIGN-ARCH-102]` H7 与 `[DESIGN-ARCH-115]` §7。
- 现状更严峻：实测 `npm run check:tui-gates` = **FAIL，226 unique KHY_\* tokens（上限 220）**。本方案**不得使其上升**。
- 复用 `[DESIGN-ARCH-111]` 的 `scripts/ruleguard/` 绑定层：新规则只需改 `RULES-REGISTRY.json`（补 `gate` + `exec` + `paths`），门自动纳入——**不在 YAML / `&&` 链里硬编码**。

**落地阶段**：按 `PROCESS-008` / `[DESIGN-PROCESS-002]` §2，新拦截型机制**必须从 S1「观察者」起步**（只记录、不拦截、执行器恒 exit 0），毕业看样本量不看时间（≥200 条相关事件且无解释不了的样本）。**且阶段是门的属性**：升档只改执行器的 `STAGE` 常量与登记表 `severity`，不改判定逻辑。

> 一旦落地，须按 `PROCESS-008` 在 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 登记 `stage`/`previousStage`/`samples.observed`/`rollback`/`executorStage`。**本文阶段尚未落地，故不预先登记**（登记一个不存在的机制会让 `check-rollout-stage.js` 的 `rollout-stage-authority-drift` 变成假绿）。

**预期收益**：0ms（它是防回潮） · **风险**：低（S1 不阻断） · **回退**：`severity` 置 `advisory` 或删登记项

### L4 · 进程层（另一笔独立的钱，需单独评估）

| 项 | 实测/事实 | 动作 |
|---|---|---|
| Python 启动器层净付 ~750ms | `python -m khy_platform --version` 1198ms vs `node bin/khy.js --version` 447ms | **【推测】** 评估 TUI 路径直连 node；须先确认 `cli.py` 在交互路径的职责（引导/认证/端口探测） |
| 根 `khy.bat` 不可用 | **LF-only 换行（176 个裸 LF，0 个 CRLF）**，cmd.exe 解析错乱：把自己的注释行当命令执行（实测报错 `'ina'` / `'"http_proxy="'` / `'portable'` / `'D_DIR!'`），**且无任何输出** | 转 CRLF。**这是 bug 而非性能项**（见 §十） |

---

## 七、验收指标与验证状态

### 7.1 性能指标

| 指标 | 基线（2026-09-22 实测） | 目标 | 当前状态 |
|---|---|---|---|
| 同进程第 2 次会话列表扫描 | 约 276ms（与第 1 次同量级） | 近乎免费 | **✅ 17ms（L2a 已落地）** |
| `listPersistedSessions` 的 profile 自耗时 | **554ms（榜首）** | 跌出榜首 | **✅ 已跌出榜首（L2a）** |
| 首字节 | 297–1558ms | 不变 | — |
| Ink 进备用屏 | 2377–11476ms | < 2500ms | **未达标** |
| BootScreen 首帧 | 2885–15867ms | < 3000ms | **未达标** |
| `render()` 同步阻塞 | 917–16303ms | < 100ms | **未达标** |
| 阻塞尾巴（`render()` 返回后定时器被饿死时长） | 最长观测 17400ms | — | 观测项 |
| 阻塞窗口内 idle 占比 | 3.7–5.8% | — | 观测项（越低说明越被钉死） |
| 启动耗时 vs 会话数 | 正相关（547 文件 / 10.84MB） | 无相关 | 部分改善：同进程内已无相关；跨进程首次扫描仍在 |

> **⚠ 口径更正（v2）**：v1 的目标列是对「L1+L2 之后」的**推测**，且已证明其**推导方式有误**——它假设「把工作前移即可省时」，而 A/B 显示前移只是**推迟**（§6.0 ①）。
> **可靠的判据只剩两条**：① 某函数**是否还在 profile 自耗时榜首**；② 该项工作**是否还在关键路径上**。
> 墙钟总量受 OS 文件缓存与磁盘负载支配，**单次端到端对比不可作判据**。
> **本轮端到端总量：未能证明有可靠改善**（方差盖过效应）。如实记录，不做粉饰。

### 7.2 验收方式（可执行）

1. **微观判据（可靠）**：`listPersistedSessions` 连续三次调用，第 2/3 次应远小于第 1 次，且三次结果 `JSON.stringify` 逐字节相同。
2. **归因判据（可靠）**：`node --cpu-prof` + `_产物/tui-startup-probe-profile.js --chains <函数名>`，断言目标函数**不在**自耗时榜首。
3. **端到端（参考，方差大）**：`_产物/tui-startup-probe-e2e.js` 取多次的**区间**，不取单点。
4. **A/B 判据（验证任何「前移/预热」类改动的唯一正确方式）**：必须**交错跑**（A,B,A,B…），且**以「首帧绝对时间」为准**——只看「挂载后到首帧的间隔」会被「挂载已被推迟」骗过（§6.0 ① 的教训）。
5. **门不上升**：`npm run check:tui-gates`（**不得高于 226**）、`npm run check:node-syntax`、`node scripts/ci/check-agent-rules.js <改动文件>`、`npm run --workspace services/backend test:tui`（**须 46/46 套件全绿**——本轮正是这条拦下了 L1b）。

---

## 八、不做什么（明确范围外）

- **不重写 Ink / React 架构**：`[DESIGN-PERF-002]` §六 已排除，理由不变。
- **不砍功能**（启动期 5 步阶段行、节拍表、预热、自愈、桥接）：它们是产品决策，本方案只改**时机与同步性**。
- **不做视觉改动**：用户没抱怨视觉。
- **不新增 `KHY_*` 门控**：H7 + 现状 226/220 已超标。
- **不在本文方案内打 bundle**：`[DESIGN-PERF-002]` 阶段 A 已有完整计划；bundle 是「更快加载器」，与本文「正确的加载时机」正交，两者不冲突但**不应混在一次提交**。
- **不主张 V8 编译缓存有收益**：实测无（§十）。

---

## 九、落地路线与**执行结果**

| 阶段 | 内容 | 对应阻塞点 | 风险 | 结果 |
|---|---|---|---|---|
| P0 | L2a 会话列表解析缓存 | B1 | 中 | **✅ 已落地** — 重复扫描 5206→17ms；`test:tui` 46/46 绿 |
| ~~P0~~ | ~~L1 加载前移（预热 aiGateway/横幅/任务链）~~ | B2、B3、B4 | — | **❌ A/B 证伪，未采纳**（§6.0 ①） |
| ~~P0~~ | ~~L1b `localLLMService` 顶层探测惰性化~~ | B2 | — | **❌ 打破一条绿测试，已回滚**（§6.0 ②） |
| **P0（推荐下一轮）** | **L2d 横幅逐适配器探测移出渲染** | **B4（最大单点，1806–2196ms）** | 中高（须动帧高账本） | 待办 |
| P1 | L2c `_readMergedTaskLines` 移出首帧 | B1 残余 | 中高（须动帧高账本） | 待办 |
| P1 | L3 渲染期同步 IO 守卫（S1 观察者起步） | 防回潮 | 低 | 待办 |
| P2 | L4 Python 层评估 + `khy.bat` CRLF 修复 | 进程层 | 中 | 待办 |

> **执行纪律（本轮教训，建议写进后续同类工作）**：
> 1. 任何「前移 / 预热」类改动**必须先做交错 A/B，且以「首帧绝对时间」为准**——只看「挂载后到首帧的间隔」会被「挂载被推迟」骗过。
> 2. 任何改动**必须先跑 `npm run --workspace services/backend test:tui` 并全绿**。
>
> 本轮这两条分别否掉了 L1 与 L1b。它们在纸面上都「显然有益」，实测都是**负收益**。

> **登记义务**（按 `[DESIGN-LAY-005]` §4）：本轮对**运行时代码**只改**既有文件**（`sessionPersistence.js` 一处），故无 `packaging/modules/modules.json` 登记动作。若 L3 落地新增执行器脚本，须按其所在层级补登记。
>
> 本次为**可复现性**新增 4 个**开发期探针**到 `_产物/`（`tui-startup-probe-e2e.js` / `-require.js` / `-render.js` / `-profile.js`）：它们不打进任何产物、不被 `services/` 引用，属 `tui/AGENTS.md` §0.9.6 已确立的探针落点惯例，故不登记 `modules.json`。全部按 `__dirname/..` 推导仓库根，**不含绝对路径字面量**（守 `RUNTIME-001`）。

---

## 十、附带发现（独立于本方案，建议单独立项）

1. **根 `khy.bat` 已损坏（bug）**：`khy.bat` 为 **LF-only 换行**（0 CRLF / 176 裸 LF）。cmd.exe 解析错乱——实测 `khy.bat --version` 把自己的注释行当命令执行（输出 `'ina'`（来自注释里的 "China"）、`'"http_proxy="'`、`'portable'`、`'D_DIR!'`）并**不产出任何输出**。能正常工作的是 `services/backend/bin/khy.cmd`（实测 655ms，输出 `1.1.15`）。
   ⇒ 若用户经 `khy.bat` 启动，症状是「起不来」而非「慢」。修复 = 转 CRLF（并建议加一条换行符守卫）。
2. **`[DESIGN-PERF-002]` §八 已过期**：该节称 `enableCompileCache()` 在 `bin/khy.js:53`「已开」，但当前代码里它是**被注释掉的**（`bin/khy.js:52-55`，注释原文「Disabled: compile cache causes stale bytecode issues during development」）。建议订正该文档，避免后续按错误前提做决策。
3. **V8 编译缓存实测无收益**：开关对比 1524–1933ms（开）vs 1310–1700ms（关），差异在噪声内。**若将来重新启用，须先有可复现的收益证据**，否则它只是给启动加了一次缓存目录 I/O。
4. **`[DESIGN-ARCH-115]` 的门控计数已变动**：该文记 `check:tui-gates` = 216（上限 212），实测今日为 **226（上限 220）**。两份数字都应指向同一次实测。
5. **`ccOverlayFit` 是启动期改动的有效哨兵**（正面发现）：本轮 L1b 被它拦下。该测试用固定 `wait(300)` 断言「打字中按 `?` 不呼出帮助菜单」，因此对**交互窗口内的阻塞**异常敏感——任何把阻塞工作推进交互窗口的改动都会在这里翻红。建议后续启动期改动都先看它。

---

## 十一、变更记录

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| v1 | 2026-09-22 | 实测调研产出 | 初稿。三探针（真实 ConPTY 端到端 / `Module._load` 分层 / `--cpu-prof` 归因）实测；登记 B1–B3 三条阻塞点及调用链；确立「懒加载已过度、方向应反向」的判断；给出 L0–L4 方案、验收指标、S1 阶段与净新增门控 = 0 纪律；附带登记 `khy.bat` LF 损坏等四项发现 |
| **v2** | 2026-09-22 | 实施 + 复测 | **实施阶段的三处更正与结果**：<br>① **新增 §4 B4** —— 横幅渲染体逐适配器 `spawnSync` 探测（1806–2196ms），是**最大单点**；v1 因单次采样欠采样而漏登，§3.3 已加更正（`spawnSync` 真实量级 34.5–42.8%）。<br>② **§6.0 新增** —— 交错 A/B 证伪「把工作搬进异步预热窗口」（首帧均值 5013→7975ms），并把「顶层阻塞探测改惰性」证伪（打破一条绿测试）。两条路都已回滚。<br>③ **L2a 已落地** —— `listPersistedSessions` 解析缓存：重复调用 5206→17ms、输出逐字段相同、门控净新增 0、`test:tui` 46/46 绿。<br>④ §7 验收改为「以 profile 榜首 + 是否在关键路径」为可靠判据，并**如实登记端到端总量未证明有改善**；§9 补执行结果与两条执行纪律。<br>⑤ §十 新增第 5 条：`ccOverlayFit` 对交互窗口阻塞敏感，可作启动期改动的哨兵。 |
