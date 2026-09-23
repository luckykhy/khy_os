# 《khyos 多实例并发文件控制规范》

> 文档编号：DESIGN-ARCH-022
> 主题：多个 khyos 实例同目录运行时的文件抢夺与冲突控制
> 范围：`services/backend` 文件操作工具层
> 关联实现：`src/tools/_fileLock.js`、`src/services/toolCalling.js`、`tests/fileLock.test.js`

---

## 0. 问题陈述

khyos 没有"每实例独立工作区"的概念——所有文件工具一律以
`process.env.KHYQUANT_CWD || process.cwd()` 为根。这意味着**在同一目录下并行启动多个
khyos 实例，它们物理共享同一份文件系统**。

而所有写工具（`Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `FileOp` …）此前都是
**裸写**（`fs.writeFileSync`，无任何跨进程协调）。其中编辑族工具（Edit/MultiEdit/
NotebookEdit/ApplyPatch）是**读-改-写**：先把整文件读进内存、在内存里改、再整体写回。
两个实例同时编辑同一文件时会发生经典的 lost-update：

```
实例A 读到 v0 ──► 内存改成 v0+a ─────────────► 写回 v0+a
实例B 读到 v0 ──────────► 内存改成 v0+b ──────────────► 写回 v0+b  ← A 的修改被静默吞掉
```

> 注意：进程内已有的串行化（`toolExecutionEngine.js` 的 `partitionIntoBatches` +
> `WRITE_PATH_TOOLS`）只在**同一进程、同一批次**内把"同路径重复写"降级为串行，
> **完全不防跨进程**。本规范解决的正是跨进程这一层。

---

## 1. 设计目标与硬约束

### 1.1 核心诉求（必须满足）
| # | 诉求 | 本方案如何满足 |
|---|------|----------------|
| ① | **绝对防覆盖** | 写独占锁 + 先到先得；后到者阻塞等待，超时则抛异常交由 Agent 走冲突流程，**绝不静默覆盖**。 |
| ② | **跨平台兼容** | 零原生依赖：仅依赖 `fs.mkdirSync` 的原子性（Linux ext4/tmpfs + Windows NTFS 均保证）与 `process.kill(pid,0)` 存活探测（两 OS 通用）。pip / npm 安装环境均可用。 |
| ③ | **僵尸锁免疫** | 每个持有者落 `{pid, host, heartbeatAt}` 并跑心跳；持有进程崩溃/被强杀后，其他实例通过死 PID（同主机）或过期心跳（跨主机）探测并**原子 rename-steal 回收**，绝不永久死锁。 |

### 1.2 防呆规则（不可违反）
1. **锁超时必须设上限**（默认 30 秒），超时**抛出明确异常**（`FileLockTimeoutError`）交由 Agent 处理，**绝不无限挂起**。
2. **加锁逻辑必须包裹在文件操作的工具层**，不可侵入核心调度器（`toolUseLoop` / `toolExecutionEngine`）或业务算法（CB-SSP 等）。
3. 修改文件操作工具时，**保留原有的 diff 输出等已实现功能**（见 [DESIGN-ARCH] 红绿 diff，Goal 7）。

### 1.3 锁粒度
**单文件级**（一文件一锁），**绝不锁整个目录**——否则无关文件互相阻塞，性能塌方。
锁键 = `sha256(规范化绝对路径)` 取前 32 hex，落 `os.tmpdir()/khy-file-locks/<key>.lock/`。
Windows 上路径先 `toLowerCase()`，与其大小写不敏感文件系统行为一致（`A.txt` 与 `a.txt` 视作同锁）。

---

## 2. 锁机制设计（读共享、写独占）

### 2.1 互斥原语：目录原子创建
不依赖任何锁库。`fs.mkdirSync(lockDir)`（不带 `recursive`）在两大平台都是**原子**的：
对同一路径，并发的多个 `mkdir` 中**恰好一个成功**，其余抛 `EEXIST`。成功者即锁的持有者。

```
acquire(absPath):
  key, lockDir = lockPaths(absPath)
  loop:
    try mkdir(lockDir)               # 原子；成功=拿到锁
      写 meta.json {pid,host,token,mode,acquiredAt,heartbeatAt}
      启动心跳定时器(unref)
      return handle
    catch EEXIST:                    # 被占用
      meta = readMeta(lockDir)
      if isStale(meta): reclaimStale(lockDir); continue   # 僵尸锁→回收重试
      if now >= deadline: throw FileLockTimeoutError(holder)  # 防呆①
      sleep(jitter backoff); continue
    catch 其他FS错误:                # 权限等异常
      throw EFILELOCKUNAVAILABLE     # 装饰器据此降级为"裸跑"，绝不困住写
```

### 2.2 读共享 / 写独占
- **写**：`acquireForToolCall` 一律以 `mode:'exclusive'` 申请，写者之间严格互斥。
- **读**：读工具不在 `WRITE_TOOL_NAMES` 内，`acquireForToolCall` 直接返回 `null`（零开销裸跑），
  天然"读共享"——读不阻塞读，也不阻塞写（advisory 语义：khyos 内部协调，不阻止外部进程）。
  `meta.mode` 字段已为将来真正的"共享读锁计数"预留，当前实现以"写独占 + 读无锁"满足诉求且零性能损耗。

### 2.3 可重入（防自死锁）
进程内 `_heldLocks: Map<key, {count,token,lockDir,heartbeatTimer}>`。同一进程对**已持有**的路径
再次 `acquire` 时只做 refcount + 1（返回 `reentrant:true` 句柄），**不**再对自己的锁 `mkdir`，
避免编辑工具内部嵌套调用导致的自死锁。`release` 按 refcount 递减，归零才真正删锁目录。

---

## 3. 冲突解决策略（绝不静默覆盖）

获取失败时的处置，**默认 = 抛异常交由 Agent**（满足防呆①"超时必须抛出明确异常"）：

1. **阻塞等待 + 超时重试**：`acquire` 在 `deadline` 前持续带抖动退避重试（`POLL_MIN_MS=25` ~
   `POLL_MAX_MS=250` 随机，避免多实例惊群）。先到先得。
2. **超时抛 `FileLockTimeoutError`**：异常携带 `filePath / timeoutMs / holder{pid,host,acquiredAt}`，
   消息明确提示 Agent："Retry, write to a conflict copy, or ask the user which version to keep — do not overwrite."
   该异常经 `toolCalling.js` 既有 `ToolError` 通道结构化回传给模型。
3. **冲突副本（Agent 驱动恢复）**：提供 `conflictCopyPath(absPath, tag)` 助手，把
   `/dir/app.py` 变 `/dir/app_conflict_khy<tag>.py`。Agent（或将来的自动回退）可据此把被抢占的
   写**改道到冲突副本**而非覆盖原文件——**绝不静默覆盖**，原数据零丢失。
4. **交互式询问**：Agent 收到结构化超时异常后，可走 `AskUserQuestion` 流程让用户选保留哪个版本。

> 设计取舍：默认**不**自动生成冲突副本，而是抛异常上交决策权——因为"该重试、该另存、还是该问人"
> 是上下文相关的判断，属于 Agent 决策面而非锁层机械动作。锁层只保证**绝不覆盖**，把"怎么和解"留给上层。

---

## 4. 防死锁与僵尸锁

### 4.1 健康判定 `_isStale(meta)`
| meta 情形 | 判定 | 依据 |
|-----------|------|------|
| meta 缺失/损坏（mid-write） | **stale** | 无可信持有者 |
| PID 在**本机**已死（`ESRCH`） | **stale** | `process.kill(pid,0)` 探测 |
| PID 在**本机**存活（成功 / `EPERM`） | 不 stale | 尊重活持有者 |
| **跨主机**（`meta.host !== os.hostname()`） | 看心跳：`now - heartbeatAt > STALE_MS(15s)` 才 stale | 无法跨机探 PID，只能靠心跳新鲜度；未来时间戳（时钟偏移）按新鲜处理 |

PID 存活探测三态：`true`（存活）/ `false`（ESRCH 死）/ `null`（跨主机不可探）。未知错误**保守按存活**，
绝不误抢活锁。

### 4.2 心跳
持有者每 `HEARTBEAT_MS`（默认 5s）刷新 `meta.heartbeatAt`。定时器 `unref()`——**绝不**因为一个心跳
而让进程无法退出。`STALE_MS`（15s）= 3× 心跳，容忍偶发卡顿。

### 4.3 安全回收：原子 rename-steal
回收僵尸锁**不能直接 `rmSync`**——否则可能删掉一个刚被别的活实例重新获取的锁。改用 rename-steal：

```
reclaimStale(lockDir):
  steal = lockDir + ".stale-" + pid + "-" + randomHex
  try renameSync(lockDir, steal)   # 原子：并发回收者中只有一个成功
  catch: return false              # 别人已抢先回收/刷新 → 重新读 holder
  rmSync(steal, recursive,force)   # best-effort；残留临时目录无害
  return true
```

`rename` 的原子性保证**多个回收者中恰好一个赢**，输者拿到 `ENOENT` 重新循环、重读（此时已新鲜的）
持有者。**绝不会删掉刚被重新获取的锁**。

### 4.4 释放只删自己的锁（token 匹配）
`release` 删目录前先 `readMeta`，仅当 `meta.token === 我持有的 token` 才 `rmSync`——若我的锁
曾被当作僵尸抢走并交给了别人，我**绝不**误删那个新锁。`release` 幂等（`released` 标志）、refcount 感知。

---

## 5. 代码改造示例

### 5.1 文件工具加锁装饰器（单一执行漏斗，零侵入调度器）
挂接点选在**唯一的工具执行漏斗** `executeTool`（`src/services/toolCalling.js`），而非 12+ 个
单独写入点——它**横跨整个 `execute()`**（这对读-改-写编辑工具是正确的：锁必须罩住"读+改+写"全程），
且锁逻辑全在 `../tools/_fileLock` 模块内，**调度器一行未动**（满足防呆②）。

```js
// services/backend/src/services/toolCalling.js  （executeTool 内）
let _fileLockHandle = null;
try {
  try {
    _fileLockHandle = await require('../tools/_fileLock')
      .acquireForToolCall(permissionKey, normalizedParams);
  } catch (lockErr) {
    if (lockErr && lockErr.code === 'EFILELOCKTIMEOUT') throw lockErr; // → ToolError → Agent
    _fileLockHandle = null; // 任何其它锁故障：防呆——绝不困住写
  }

  // …原有工具分发（builtin.handler / registry.execute / compat）原样不动…
  // …原有 diff 输出（Goal 7 红绿 ±）原样保留（防呆③）…
  return structuredResult;

} finally {
  if (_fileLockHandle) {
    try { _fileLockHandle.release(); } catch { /* best-effort */ }
  }
}
```

要点：
- 非写工具 / 无单路径目标（如 `apply_patch` 的多文件 patch 文本）→ `acquireForToolCall` 返回
  `null`，**零开销裸跑**；该工具故意不纳入锁（单路径快照不成立），已文档化的取舍。
- 仅 `EFILELOCKTIMEOUT`（真冲突超时）上抛；其它锁故障（权限等）一律降级为"无锁裸跑"，
  锁子系统**绝不**让一个与真实争用无关的写失败。
- `finally` 保证任何路径（成功/异常/提前 return）都释放锁。

### 5.2 锁清理守护逻辑（僵尸回收，已内联进 acquire 重试环）
本方案**不需要独立常驻守护进程**——回收是**机会式**的、内联在每次 `acquire` 的争用重试里：
谁想拿一把僵尸锁，谁就地把它回收掉（§4.3）。这比独立 GC 守护更健壮：

- 无单点：不存在"守护进程自己也崩了"的问题；
- 无竞态删活锁：rename-steal + token 匹配双重保证；
- 零空转：没人争用的锁不必清理，争用时才回收，正是需要它的时刻。

> 运维补充：`*.stale-*` 临时目录为 best-effort 删除，极端情况下可能残留（无害）。
> 可选地由外部 cron `find $TMPDIR/khy-file-locks -name '*.stale-*' -mmin +60 -delete` 兜底，
> 但**非必需**——不影响正确性。

### 5.3 可调参数（全 env 覆盖，运维友好）
| env | 默认 | 含义 |
|-----|------|------|
| `KHY_FILE_LOCK_DIR` | `$TMPDIR/khy-file-locks` | 锁根目录（测试隔离 / 多用户分隔用） |
| `KHY_FILE_LOCK_TIMEOUT_MS` | `30000` | 防呆①硬上限 |
| `KHY_FILE_LOCK_HEARTBEAT_MS` | `5000` | 心跳间隔 |
| `KHY_FILE_LOCK_STALE_MS` | `15000` | 跨主机判过期阈值（3× 心跳） |
| `KHY_FILE_LOCK_DISABLED` | （未设） | `=1` 全局关锁（回退裸跑） |

---

## 6. 测试与验证

`services/backend/tests/fileLock.test.js`（`node:test`，18/18 绿）：

- **绝对防覆盖（核心 killer 测试）**：`child_process.fork` 启 **8 个真实独立进程**，各自对同一文件做
  读-改-写（中间 hold 40ms 放大竞态窗口）。无锁必丢更新；有锁后 **8 行全部存活**，零丢失。
- **写独占**：植入一把本进程 PID（必活）的锁 → 第二次 `acquire(timeoutMs:300)` 抛 `FileLockTimeoutError`。
- **僵尸免疫**：植入死 PID（同主机）/ 过期心跳（跨主机）锁 → 被回收并成功获取。
- **`_isStale` 真值表**：死 PID / 本进程活 / 跨主机过期 / 跨主机新鲜 / null meta 五情形。
- **可重入 + 幂等释放**：内层 release 不影响外层；重复 release 不抛。
- **装饰器门控 + 助手**：非写工具/无路径→null、`KHY_FILE_LOCK_DISABLED`、`isWriteTool`、
  `resolveTargetPath`、`conflictCopyPath`。

回归：`writeDiff.test.js` 19/19 绿（防呆③：Goal 7 红绿 diff 未受影响）；`toolCalling.js`
`node --check` + `require` 均 OK。

---

## 7. 已知边界与取舍

1. **`apply_patch` 不加锁**：其 patch 文本可跨多文件，没有单一目标路径；强行解析其 patch 体等于
   复刻它的解析器。故意 fail-soft 返回 `null`（裸跑），已文档化。
2. **advisory（协作式）语义**：锁只协调 khyos 实例之间。非 khyos 的外部进程（编辑器、`cat >`）
   不认这把锁——这是 OS 级 advisory 锁的固有边界，符合"防 khyos 自相残杀"的目标定位。
3. **真共享读锁未实装**：当前以"写独占 + 读无锁"满足诉求且零开销；`meta.mode` 已为将来读计数预留。
4. **pip / npm 生效**：本改动是 backend JS；随 `khyos.js` 类改动需重建 wheel/镜像才在 pip 环境落地
   （见 [[project_pip_multilang_distribution]] 打包纪律）。

---

## 8. 文档级操作合并层（T-008，2026-08-25 增补）

§0–§7 的悲观文件锁解决的是**跨进程 lost-update**，但它的语义是「一次只让一个人写」——
两个实例想同时编辑同一文件的**不同位置**时，后到者只能等锁或走冲突副本。本节增补的
**文档级操作合并层**把这一类「本可自动合并」的并发编辑从「排队 / 冲突副本」升级为
「按基线版本确定性合并」，同时**保留**文件锁作为降级路径——不是替换，是分层。

```
实例A 读到 v1 ──► diff_A(baseVersion=1) ──┐
                                          ├─► 服务端按 baseVersion rebase 合并 ─► v2 / v3
实例B 读到 v1 ──► diff_B(baseVersion=1) ──┘        重叠 → 结构化 MERGE_CONFLICT
                                                   不可用 → MERGE_FALLBACK → §2 文件锁
```

### 8.1 实现与分层

| 文件 | 职责 |
|------|------|
| `src/services/crdt_engine.js` | **纯叶子**：路径规范化/白名单、操作校验、OT rebase（`transformAgainst`）、重叠冲突判定、Y.Doc 收敛与快照。零 IO。 |
| `src/services/session_registry.js` | **纯叶子**：多实例会话注册、订阅集、编辑租约（申请/续期/到期释放）、快照/恢复。时钟注入，零 IO。 |
| `src/services/file_sync_bus.js` | 薄 IO 层 + 事件总线：每文件的当前内容/版本/操作历史/已处理 opId/订阅者集，全部副作用走注入端口（`readFile` / `writeFile` / `persist` / `send` / `now`）。 |
| `src/services/aiManagementServer.js` | WS 边界接线：`default:` 分支之前认领 `file_*` / `subscribe_files`，认证成功注册会话，断线立即释放租约。 |

**为什么不是纯 Yjs**：CRDT 按定义永不报冲突（它总能收敛出**某个**结果）。本任务要求
「重叠编辑返回结构化冲突、可复核、可转冲突副本」，纯 CRDT 无法满足。故采用
**自有操作协议 + OT rebase 提供冲突语义，Yjs（`Y.Doc`/`Y.Text`）作为收敛与快照基座**。
`clientID` 由 `sessionId` 经 FNV-1a 定值，保证不同实例同输入同输出。

### 8.2 操作与版本模型

客户端提交的最小操作（必须自报 `baseVersion`，服务端强校验）：

```json
{
  "type": "file_op",
  "path": "docs/a.md",
  "opId": "op-7f3c",
  "sessionId": "s-1",
  "editor": "alice",
  "baseVersion": 12,
  "operations": [{ "insert": "hello", "position": 40 }, { "delete": 3, "position": 10 }]
}
```

- **版本单调递增**且可比较；`opId` 幂等去重（重复提交返回同一版本，`duplicate: true`，不再扇出）。
- `baseVersion` 落后但仍在历史窗口内 → **自动 rebase** 后落地；已被挤出历史 → `HISTORY_EVICTED`
  并附 `file_resync_required`；`baseVersion` 超前当前版本 → `BASE_VERSION_AHEAD`，**不静默接受**。
- **绝不 last-writer-wins**。真重叠（删∩删、插在删区内、删区含插）一律返回：

```json
{
  "ok": false,
  "error": {
    "code": "MERGE_CONFLICT", "message": "文件存在重叠编辑冲突",
    "path": "docs/a.md", "baseVersion": 12, "currentVersion": 13,
    "opId": "op-7f3c", "conflictingOpIds": ["op-4a1b"],
    "conflictCopyHint": "docs/a.md_conflict_khy_alice_…"
  }
}
```
冲突时**磁盘与版本都不动**，两侧操作信息都保留，可复核或按 hint 落冲突副本（§2 路径）。

### 8.3 WebSocket 事件族（纯增量，老客户端零影响）

挂在既有 `switch (msg.type)` 的 `default:` 分支**之前**：只有总线认领的类型被拦下，
其余（`terminal_input` / `terminal_stream` / `khyos_desktop_frame` / `task_poll` / `chat` …）
照旧走原处理器并在未知时回 `Unknown message type`。

| 客户端 → 服务端 | 服务端 → 客户端 |
|---|---|
| `subscribe_files` `{paths, lastSeenVersions:{path:12}}` | `file_subscribed` `{ok, results:[{path, version, editor, increments, resync}]}` |
| `unsubscribe_files` `{paths}` | `file_unsubscribed` |
| `file_op`（§8.2） | `file_op_result` `{ok, path, opId, version, baseVersion, duplicate, warnings, status}` |
| `file_catch_up` `{path, lastSeenVersion}` | `file_catch_up_result` `{ok, increments}` 或 `file_resync_required` |
| `file_lease` `{path, action: acquire\|renew\|release}` | `file_lease_state` `{ok, lease:{sessionId, editorId, expiresAt, renewals}}` |
| `file_lock` `{path, action: enable\|disable}` | `file_lock_state` `{ok, exclusive}` |
| （扇出，无需请求） | `file_changed` `{path, version, baseVersion, opId, editor, sessionId, operations, timestamp}` |

- 扇出**逐订阅者 fail-soft**：一个 socket 送不出去只算它自己失败（`delivered: 2/3` 写进 warnings），
  不阻断其余订阅者。
- **未经校验的客户端路径绝不落盘**：路径先规范化再过白名单前缀，越界/非法直接结构化拒绝。
- 二进制文件不进文本合并器，直接 `BINARY_FILE` + `fallback: 'file_lock'`。

### 8.4 断线重连补齐

客户端重连时带 `lastSeenVersion` 回来：

1. 历史窗口内仍有缺失操作 → **只补缺失的增量**（`increments`），不重传全文；
2. 已被挤出历史 → `file_resync_required`，携带**当前版本** + 当前内容 + Y.Doc `snapshot`/`stateVector`；
3. 补齐后客户端可直接续提交；重复补齐**返回同样的增量且不改变任何状态**（不会重放操作）。

### 8.5 编辑租约（与 §2 文件锁的关系）

租约是**基于活动的超时**，不是固定时长硬 kill：心跳与成功提交都会把 `expiresAt` 往后推；
断线（`cleanupSession`）**立即**释放全部租约与订阅，不等 TTL 走完；空闲清扫（`gcSweep`）
兜底回收过期租约与空闲会话。注册表通过 `snapshot()`/`restore()` 端口落到
`<project>/.khy/file-sync/session-registry.json`，跨进程/重启后捞回，**不只活在单进程内存里**。

`file_lock` 事件族提供**显式独占**开关：开启后该文件只接受租约持有者的操作，其余实例
收到 `MERGE_FALLBACK`，语义等价于 §2 的写独占锁，供「我要整体重写这个文件」的场景使用。

### 8.6 降级路径（必须不丢数据）

下列任一情形，合并层一律返回结构化降级结果而非抛异常，调用方转 §2 文件锁 + 冲突副本：

```json
{ "ok": false, "error": {
  "code": "MERGE_FALLBACK", "message": "实时合并不可用，已进入文件锁降级路径",
  "fallback": "file_lock" } }
```

触发条件：`KHY_FILE_SYNC` 关闭、CRDT 依赖不可用、历史损坏、文档状态损坏、二进制文件、
操作不可合并、版本无法确认、权限校验失败、WS 广播失败、读写端口报错。

### 8.7 可调参数（全 env 覆盖，已登记 `flagRegistry.js`）

| env | 默认 | clamp | 含义 |
|-----|------|-------|------|
| `KHY_FILE_SYNC` | 开 | — | 总门控。`0/false/off/no` 关 → 三个入口全部 `MERGE_FALLBACK`，逐字节回退 §2 |
| `KHY_FILE_SYNC_HISTORY` | `200` | `[8, 20000]` | 每文件操作历史条数（环形），决定能容忍多长的断线 |
| `KHY_FILE_SYNC_MAX_OPS` | `200` | `[1, 5000]` | 单批操作条数上限 |
| `KHY_FILE_SYNC_MAX_INSERT` | `65536` | `[64, 4194304]` | 单条 insert 字符上限 |
| `KHY_FILE_SYNC_MAX_BATCH` | `262144` | `[256, 8388608]` | 单批合计字符上限 |
| `KHY_FILE_SYNC_MAX_DOC` | `4194304` | `[1024, 67108864]` | 单文档字符上限 |
| `KHY_FILE_SYNC_LEASE_MS` | `45000` | `[1000, 3600000]` | 编辑租约 TTL（活动续期） |
| `KHY_FILE_SYNC_IDLE_MS` | `300000` | `[10000, 86400000]` | 会话空闲回收阈值 |

后七项以 `KHY_FILE_SYNC` 为 `parent`：总门控关 → 子项一并失效（`flagRegistry` 集中施加父→子优先级）。

### 8.8 测试与验证

| 套件 | 数量 | 覆盖 |
|---|---|---|
| `src/services/__tests__/crdt_engine.test.js` | 51 | 路径/opId/baseVersion/range/超大/编码/二进制校验；rebase 与三类真重叠；同输入同输出 |
| `src/services/__tests__/session_registry.test.js` | 29 | 注册幂等与边界；订阅授权；租约申请/续期/惰性过期/抢占；断线即释放；快照恢复脏数据边界 |
| `src/services/__tests__/file_sync_bus.test.js` | 47 | 门控与降级；版本模型与幂等；扇出 fail-soft；重连补齐与逐出重同步；独占；跨实例持久化；WS 消息族向后兼容；端到端最小路径 |
| `src/services/__tests__/file_sync_wiring.test.js` | 18 | **真实 aiManagementServer 上**的接线回归：10 类老消息全部穿透；两实例端到端合并；重连补齐；断线即释放租约 |

全部时钟/磁盘/WebSocket 端口注入，无 sleep、无真实网络、不触碰生产端点。

### 8.9 已知边界

1. **注册表快照是「项目内单机」跨进程口**（`<project>/.khy/file-sync/`）：同机多进程共享事实成立，
   真正跨主机需要把 `persist` 端口换成共享存储/消息总线——端口已隔离，换实现不动判定逻辑。
2. **合并层只覆盖文本文件**：二进制、超大文档一律走 §2 文件锁，这是有意的（§8.6）。
3. **advisory 语义不变**：非 khyos 外部进程（编辑器直存、`cat >`）不参与版本模型；
   落盘后被外部改写会在下次提交时表现为内容漂移，需靠 §2 锁 + 冲突副本兜底。
4. **`y-websocket` 未采用**：3.1.0 起该包只剩客户端（服务端迁到 `@y/websocket-server`），
   而本方案的服务端已长在既有 WS 通道上，无需第二个 WS 服务器。故只保留 `yjs` 依赖。
