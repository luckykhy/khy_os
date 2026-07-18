> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `envSymbiosis（与已在产 platformUtils 平行重造）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-039] Khyos 环境共生——环境感知与原生亲和架构

> 架构与设计规范 · 遵循 [MGMT-STD-001] · 关联 [DESIGN-ARCH-038] 双轨淬火 Bug 升维、[DESIGN-ARCH-037] 自举创世闭环自愈、[DESIGN-ARCH-025] 元规划约束注入

## 1. 目标与定位

粉碎「一次编写、处处运行（实则处处平庸）」的跨平台妥协。Khyos 不抹平差异，而是**核心意图统一、执行路径分裂**：在每个环境长出截然不同却极度锋利的能力形态，把「兼容性阵痛」强制淬火成「环境特异性特长」。一处运行，即为该环境之王。

落为零侵入纯子系统 `src/services/envSymbiosis/`，复用 [DESIGN-ARCH-038]/[DESIGN-ARCH-037] 的 `evoRequirement`/`evoLedger` 需求真源（不改其定形），新增环境维度。

### 1.1 自调查（抹杀差异 vs 环境共生）

| 维度 | 传统跨平台（抹杀差异） | 环境共生（本架构） |
|---|---|---|
| 架构目标 | 统一抽象层，牺牲特性换兼容 | 核心意图统一、**执行路径分裂**，榨干平台特性 |
| 工具调用 | Polyfill 抹平，低效易碎 | **原生亲和路由**：Win 调 COM、macOS 调 AppleScript、鸿蒙调元服务 |
| 兼容性报错 | 视为 Bug，修补回统一层 | 视为进化原石，触发「兼容性即特长」淬火，为该环境单独长器官 |
| 系统表现 | 处处二等公民 | 每个系统一等公民，触及系统底层极限 |

## 2. Meta-Plan（分层架构）

| 层 | 职责 | 模块 | 状态铁律 |
|---|---|---|---|
| 顶层 统一意图层 | 平台无关意图入口 `dispatch(intent)` | `EnvSymbiosis` | 无状态、跨平台一致（防呆④） |
| 中层 环境感知 + 原生路由 | 刺探指纹 → 选最锋利原生路径 | `EnvFingerprintScanner` / `NativeAffinityRouter` | 先验证指纹再执行（防呆③）；绝不 Polyfill（防呆①） |
| 底层 平台特异性执行 | 各环境原生工具落地 | （交调用方执行；本子系统只派发与淬火，零侵入） | 差异只在工具/执行路径 |
| 闭环 兼容性即特长淬火 | 阻断/翻车 → 环境特异性需求 | `CompatibilityQuencher` / `SpecialtyBreaker` | 需求必带 env_scope（防呆②）；翻车即熔断（防呆⑤） |

## 3. 架构蓝图（环境共生闭环）

```
                       平台无关意图  dispatch(intent)
                                  │
                                  ▼  [防呆③ 先刺探]
                  EnvFingerprintScanner.scan
                  ├─ 内核指纹 Win32/XNU/Linux/Android/ArkTS
                  ├─ 能力清单 root/cgroup/COM/WMI/无障碍/软总线…
                  └─ 资源画像 server/desktop/mobile + 电量 + 网络
                                  │  fingerprint{platform, recognized, capabilities}
                                  ▼
                  NativeAffinityRouter.route(intent, fingerprint)
                  ├─ 命中原生器官 ─────────────────► NATIVE   交底层原生执行
                  ├─ 指纹缺/未识别 ─────────────────► NO_FINGERPRINT  拒绝盲调（防呆③）
                  ├─ 特长已熔断 ───────────────────► DEGRADED_SAFE  通用安全（防呆⑤）
                  └─ 器官空洞（表中缺位） ──────────► ORGAN_VOID
                                  │ 绝不 Polyfill（防呆①）
                                  ▼
                  CompatibilityQuencher.quenchOrganVoid
                  → 器官新生 EvoRequirement（env_scope=该环境, L1）   [防呆②]
                                  │
        执行期翻车 reportFault ──► SpecialtyBreaker.fuse（首次）
                  → CompatibilityQuencher.quenchRollback
                  → 特长回滚 EvoRequirement（env_scope, rollback=true, L1）  [防呆⑤]
                                  ▼
                  需求池（evoLedger 不可变哈希链；env_scope 钉死环境，不污染全局）
```

## 4. 骨架实现（核心模块）

| 模块 | 职责 |
|---|---|
| `platformIds.js` | 单一真源：`PLATFORM` 五身份 + `KERNEL_SIGNATURES` 内核指纹 + `NATIVE_TOPOLOGY` 长板拓扑（§3.2）+ `AFFINITY_TABLE` 原生亲和表（§3.3）。差异收口于此，禁散落底层 |
| `EnvFingerprintScanner` | 刺探内核指纹/能力清单/资源画像；探针注入式（CI 上模拟任意环境）；未识别 → unknown，绝不臆造 |
| `NativeAffinityRouter` | 纯函数表驱动 `route`：NATIVE / NO_FINGERPRINT（防呆③）/ ORGAN_VOID（防呆①）/ DEGRADED_SAFE（防呆⑤）；同输入同结果（防呆④） |
| `CompatibilityQuencher` | 兼容阻断/翻车 → 带 `env_scope` 的 EvoRequirement；铸后装饰 env_scope（防呆②）；why 校准锁 L1 |
| `SpecialtyBreaker` | 原生特长翻车即熔断（幂等计数），按 `platform::specialty` 分桶；只读供路由查询 |
| `EnvSymbiosis` | 门面：刺探→路由→淬火→落账本；无状态核心（防呆④） |

### 4.1 §3.3 原生亲和路由（节选）

| 意图 | Linux | macOS | Windows | Android | HarmonyOS |
|---|---|---|---|---|---|
| `open_url` | `xdg-open` | `open` | `start` | `Intent.ACTION_VIEW` | `Ability.startAbility` |
| `monitor_process` | `eBPF`(/proc 兜底) | `sysctl` | `WMI` | `/proc 解析` | `HiDumper/分布式` |

### 4.2 EvoRequirement 的环境特异性扩展（防呆②）

```json
{
  "id": "evo_…",
  "level": "L1",
  "env_scope": "HarmonyOS",
  "envSpecific": true,
  "specialty": "read_sensors@HarmonyOS",
  "attribution": { "kind": "compatibility-block", "why": "…能力拓扑空洞…须长出新原生工具…" },
  "proposedModules": ["HarmonyOS-read_sensors-原生器官", "HarmonyOS:分布式软总线设备发现"]
}
```

## 5. 场景验证（§4）：意图「监控系统进程」

| 环境 | 原生亲和路由选择 | 兼容性问题 → 淬火 |
|---|---|---|
| Linux | eBPF 内核级监控（/proc 兜底） | — |
| Windows | WMI(Win32_Process) | — |
| macOS | sysctl(KERN_PROC) | — |
| Android | /proc 解析 | 缺 `read_sensors` → 淬火出 `env_scope=Android` 传感器直读器官 |
| HarmonyOS | HiDumper/分布式任务管理 | — |

反例闭环：同一 `read_sensors` 意图在 Android 与 Linux 各自淬出 `env_scope` 互不相同的需求，**绝不互相污染、绝不外溢全局架构**（防呆②）。

## 6. 防呆规则与硬边界（§5）

| # | 铁律 | 落实点 |
|---|---|---|
| ① | 底层禁用统一 Polyfill，平台差异必经路由分发到各自原生实现 | `AFFINITY_TABLE` 单源；缺位即 `ORGAN_VOID` 淬火，绝无统一兜底 API |
| ② | EvoRequirement 必含 `env_scope`，仅为特定环境进化、不污染全局 | `CompatibilityQuencher._decorate` 强制装饰；无 env_scope 即抛 |
| ③ | 无环境指纹禁止盲调平台特异性 API，先验证再执行 | `dispatch` 先 `scan`；`route` 未识别指纹 → `NO_FINGERPRINT` |
| ④ | 核心状态机无状态、跨平台一致，仅工具/执行路径允许差异 | `route` 纯函数表驱动；熔断态按 env_scope 分桶、不参与路由计算 |
| ⑤ | 原生特长引发安全降级/崩溃即熔断、降级通用安全、报特长回滚需求 | `SpecialtyBreaker.fuse` + `quenchRollback`；路由命中熔断 → `DEGRADED_SAFE` |

## 7. 验证

`tests/services/envSymbiosis/envSymbiosis.test.js` 28 绿：指纹识别 5 环境 + 未知降级 + 探针抛错不崩；路由 open_url 五分裂 + monitor_process + 四防呆；淬火 env_scope/L1 锁定/回滚/拒铸；熔断幂等；门面 routed/quenched/blocked/degraded + 哈希链 + 跨实例一致；监控进程多环境场景表 + 互不污染反例。邻近 evoEngine/dualTrackForge 65 绿零回归。

零侵入：自成纯子系统，不接管 `executeTool`；可由后续 PR 将真实工具调用接入路由器、把 `reportFault` 挂到执行层崩溃信号上。
