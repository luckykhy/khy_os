# [DESIGN-ARCH-062] khyos 后台常驻与按需加载生命周期边界

- 状态:定稿
- 关联代码:
  - `services/backend/src/services/serviceLifecyclePolicy.js`(纯叶子 SSoT)
  - `services/backend/src/bootstrap/prefetch.js`(deferredPrefetch 策略驱动)
  - `scripts/check-lifecycle-policy.js`(防漂移守卫)
  - `services/backend/tests/services/serviceLifecyclePolicy.test.js`(契约测试)
  - `flagRegistry.js` 主门 `KHY_LIFECYCLE_POLICY`

## 1. 问题(为什么要清这条边界)

khyos 里「有的功能需要后台常驻、有的功能只在需要时加载」。这条边界**客观存在但一直是隐式的**——它散落在:

- `bootstrap/prefetch.js#deferredPrefetch` 的硬编码 `setTimeout` 阶梯(2s/3s/4s/5s/6s/8s + `setImmediate`);
- daemon 进程(`daemonEntry.js` / `aiManagementServer.js`)内部的 start 调用点;
- 各子系统自己的 `KHY_*` 门(`KHY_CHANGE_WATCH`、`KHY_DISABLE_KEYPOOL_WATCH`、`KHY_SELF_EDIT_WATCH` …)。

没有单一真源,也没有守卫防漂移:新增一个后台服务时,**没有任何机制强制作者声明它属于哪一层、该不该常驻**。
时间一长,谁常驻、谁一次性、谁按需就只能靠读遍全部代码才能回答——这正是要清的边界。

> 勘察结论:khyos 的惰性纪律其实**很好**(~90 个 timer 都 `.unref()`、有统一
> `bootstrap/shutdown.js#addShutdownHook`、入口链高度惰性)。两个曾被怀疑的 eager 热点经读码确认
> **已处于合适位置**:①`tools/index.js` 已由 `KHY_DEFER_TOOLS` 惰性加载;②`aiGateway` 顶部 require
> 全部 17 个 adapter,但 `new AIGateway()` 在 require 时即构造、`_doInit` 对全部 adapter 跑检测——
> 所以顶部 require 改惰性是 **no-op**,延迟构造对 warmup 无效且会拖慢 first-chat。gateway 本身已在
> `+300ms warmup`(轻量)或首次 chat(完整)之后才载入,不在同步冷启动路径。
> 故本设计**不 refactor adapter**,只把「决定」显式化 + 守卫防它回退到冷路径。

## 2. 三层 tier 定义

| tier | 含义 | 需 shutdown 取消 | 例 |
|---|---|---|---|
| `resident` | 起长生命 timer / watcher / server(**常驻**) | 是 | cleanupService 周期清理、resourceGuard 内存监视、securityMonitor、daemon http/心跳、apiKeyPoolWatcher、changeWatch |
| `startup-oneshot` | 启动后跑一次即返回(**一次性**) | 否 | fileIntegrity 校验、updateNotice、projectMemoryPrune、ideAdapterRecovery、skillLearning、hardwareProfileNotice、gatewayWarmup |
| `on-demand` | 首次使用才惰性载入(**按需**),从不进同步冷启动路径 | 视资源 | aiGateway+17 adapter、tools、router handler、连通性自检、deviceApps、mcp/lsp/localLLM 子进程 |

process 维度正交:`cli-startup`(deferredPrefetch 里跑)| `daemon`(daemonEntry 独立进程)| `lazy`。

## 3. 单一真源:serviceLifecyclePolicy.js(纯叶子)

一张冻结表 `LIFECYCLE`,每个后台子系统一条:`{ id, tier, process, mode, gate, gateInverted,
delayMs, immediate, unref, shutdownHook, startSymbol, note }`。配套纯查询函数(零 IO、确定性、
fail-soft 绝不抛、返回值与冻结表隔离):

- `isPolicyEnabled(env)` — 主门 `KHY_LIFECYCLE_POLICY`(默认开,flagRegistry-first + 本地 CANON 回退)。
- `listByTier` / `listByProcess` — 分类查询(深拷贝)。
- `gateEnabled(id, env)` — 该条目 gate 是否开(禁用式 `KHY_DISABLE_*` 语义已内建)。
- `perIdOverride(id, env)` — 读约定名 `KHY_LIFECYCLE_<ID>`;仅主门开时生效。
- `isResident(id, env)` — 存在 ∧ tier=resident ∧ gate 开 ∧ 未被 per-id 覆盖关。
- `listStartupSchedule(env, mode)` — **deferredPrefetch 消费的唯一入口**。
- `describe` / `allGates` / `allIds` — 守卫与自省用。

## 4. 操作化:deferredPrefetch 由策略驱动(不只是文档)

`deferredPrefetch` 把原来每个 `setTimeout` 的 body **逐字节**搬进一个 `RUNNERS` 映射(id ↔ 策略
cli-startup 条目一一对应),主体改为:

```js
for (const entry of policy.listStartupSchedule(process.env, mode)) {
  const run = RUNNERS[entry.id];
  if (!run) continue;
  if (entry.immediate) setImmediate(run);       // 不进 timers,与原 setImmediate 语义一致
  else timers.push(setTimeout(run, entry.delayMs));
}
```

**判定与执行分离**:策略决定「跑什么 / 何时 / 是否启用」,prefetch 只持有「怎么跑」。
延迟值、emit 文案、调度顺序全部源自策略且策略值 = 改造前现值 → **零功能回归**。
轻量模式 gatewayWarmup 的 `!== 'false'` 门判定保留在 runner body 内,逐字节保留原语义。

## 5. 防漂移守卫:scripts/check-lifecycle-policy.js

纯读文件 + 正则,退出码非 0 即 fail(并入仓库既有 `check-*.js` 守卫批处理):

- **A** 主门 `KHY_LIFECYCLE_POLICY` 已在 flagRegistry 登记;
- **A2** 策略声明的每个非空 gate 在 `services/backend/src` 里可见(防拼写错误 / 引用已删 flag);
- **B** `prefetch.js` 的 `RUNNERS` 键集合 **===** 策略 cli-startup 条目 id 集合(双向;新增/删除
  prefetch 任务而不同步策略 → fail);
- **C** 策略 `daemon` 条目的 `startSymbol` 在 daemonEntry / aiManagementServer 源码可见;
- **D** on-demand 边界防回退:`aiGateway` 不得出现在 `bin/khy.js` / `cli/bootstrap.js` 顶部 require;
  `tools/index.js` 含 `KHY_DEFER_TOOLS`。

## 6. 新增后台服务的规程

1. 在 `serviceLifecyclePolicy.js` 的 `LIFECYCLE` 加一条,显式声明 `tier` / `process` /(如有门)`gate`;
2. 若是 cli-startup 任务:在 `prefetch.js` 的 `RUNNERS` 加同名 runner(守卫 B 会强制两边同步);
3. 若引入新 `KHY_*` 门:在 `flagRegistry.js` 登记;
4. 若是 daemon 常驻:填 `startSymbol`(守卫 C 会验它在源码可见);
5. 若是重子系统:确保它是 `on-demand` 且不进冷启动路径(守卫 D 兜底)。

## 7. 用户可控:per-id 覆盖与 escape hatch

- `KHY_LIFECYCLE_<ID>=off|0|false` 关闭单个 startup 服务(如 `KHY_LIFECYCLE_CLEANUPSERVICE=off`),
  仅主门开时生效(动态约定名,不逐个进 flagRegistry)。
- `KHY_LIFECYCLE_POLICY=0` 主门关 → `listStartupSchedule` 回退**全量**(忽略 per-id 覆盖)≈ 改造前
  逐字节行为,是最后的 escape hatch。

## 8. 有意排除(边界说明)

- **不 refactor aiGateway 的 17 adapter**(见 §1,顶部 require 改惰性是 no-op)——只声明为 on-demand + 守卫防回退。
- **不改各服务自身的 start/stop 实现**——只把「启动决定」提到策略;timer/unref/shutdownHook 全不动。
- **不改 daemon 进程的 start 顺序**——本次只操作化 **cli-startup 这一处控制点**(风险最小);daemon
  也策略驱动留作后续。
