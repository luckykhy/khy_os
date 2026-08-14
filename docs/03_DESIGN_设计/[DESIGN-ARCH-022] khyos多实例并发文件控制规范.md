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
