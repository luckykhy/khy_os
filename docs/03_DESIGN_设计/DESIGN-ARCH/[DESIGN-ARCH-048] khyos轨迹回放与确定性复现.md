# [DESIGN-ARCH-048] khyos 轨迹回放与确定性复现 — 回放账本、内容寻址复现包与分档重放引擎

状态：已实现（PHASE 1–5 全闭环；P6 文档收尾。用户需求「在相对静止环境假设下，把轨迹导出后载入回放功能，
即使产物被删、即使无 AI 沿轨迹走，也能重放工具步骤、确定性复现成果，并以此进一步规范 khyos 轨迹格式」）

依赖前序：
- [DESIGN-ARCH-047] 轨迹溯源标准（轨迹记录的上游；本规范是其「可回放」延伸。047 只存在于代码注释中无文档时由本任务补口为首个文档化补充，现已成文）
- [DESIGN-ARCH-026] khyos 系统级服务调用审批网关（回放经同一权限闸 + L0/L1/L2 分级；回放对档内合格步以 host 控制通道作非交互但策略化应答）
- [DESIGN-ARCH-022] 多实例跨进程文件锁（回放经 executeTool 漏斗，文件锁全程保留）

实现位置：
- `services/backend/src/services/trajectoryReplay/`（新核子系统，6 纯模块 + barrel）
  - `replayLedger.js`——回放账本读写（sidecar `*.replay-ledger.jsonl`，镜像 traceChain 原子/路径）+ 会话级内容仓（内容寻址）
  - `tierRegistry.js`——回放分档单一真源（`TIER{FILE,SHELL,NETWORK_AI}` frozen；`normalize`/`classify`/`effectiveTier`，未知→SHELL 最保守）
  - `artifactHash.js`——`sha256Hex` 薄封装 + params/result 规范哈希（全 fail-soft）
  - `envFingerprint.js`——环境指纹 `capture`/`compare`（os/node/cwd/toolchain/manifestHash，缺项→null）
  - `replayBundle.js`——自包含回放包 `exportBundle`/`readBundle`/`verifyBundle`（manifest + ledger + env + 内容仓 + 可选链）
  - `replayEngine.js`——分档重放引擎 `replay(bundle,opts)`（环境闸 → 分档 → 前置防呆 → 漏斗重放 → 产物校验 → 分歧即停）
  - `index.js`——barrel
- `services/backend/src/services/toolUseLoop.js`——并行批与顺序两处 `_finalizeWriteDiff` 后各加 best-effort `recordToolTurn`（result 后执行，绝不改 result/模型可见内容）
- `services/backend/src/services/toolCalling.js`——`_runDepHealing` 加一行 `if (traceContext?.replay) return null;`（回放旁路依赖自愈这一非确定性副作用；normal run 无此标志，零回归）
- `services/backend/src/services/sessionPersistence.js`——新增公开 `jsonlPathFor(sessionId, projectDir)`（供账本同目录定位）
- `services/backend/src/cli/handlers/replay.js`（新）+ `router.js` + `constants/commandSchema.js` + `cli/aliases.js`——`khy replay` 命令接线

验收测试（node:test；共 32 例 + 回归零回归）：
- `tests/services/trajectoryReplay/p1Ledger.test.js`（9 例：条目格式 + seq 单调 + 坏路径不抛 + classify 三档/未知→SHELL + artifactHash≡sha256Hex）
- `tests/services/trajectoryReplay/p2EnvFingerprint.test.js`（7 例：必需键齐 + 同指纹 match + 改 node 版本 1 diff + 慢探测不挂死）
- `tests/services/trajectoryReplay/p3Bundle.test.js`（6 例：导出含 manifest+ledger+blob + verifyBundle ok + 篡改 blob 报错 + NETWORK_AI 计 skipped）
- `tests/services/trajectoryReplay/p4Engine.test.js`（8 例：还原已删文件 + 哈希失配 diverged + NETWORK_AI 恒跳 + SHELL 预批准/确认 + env 失配拒绝/--force + 前置防呆不毁未录数据 + 幂等跳过）
- `tests/services/trajectoryReplay/e2eReplay.test.js`（2 例：经真漏斗 record→export→delete→replay 全链复现 + 篡改记录哈希 diverged@0）
- `tests/cli/handlers/replayHandler.test.js`（6 例：schema 含 replay + 未知子命令不崩 + list/export 友好兜底 + CLI 端到端复现已删产物 + 篡改包停机显式）

---

## 1. 问题：轨迹「可溯源」≠「可复现」

[DESIGN-ARCH-047] 已让每条轨迹条目带 `_khyTrace` 信封（谁产的 / 可信级别 / 是否本地验证）+ 防篡改哈希链——
轨迹**可溯源、可审计**。但「我看得见这条轨迹做了什么」与「我能不靠 AI 把这条轨迹的成果重新做出来」是两回事。

经对代码核实的复现阻碍：

| 阻碍 | 现状 | 后果 |
| --- | --- | --- |
| 结构化结果被丢弃 | `workflowExecutor.runGraph` 的 toolCall 节点 `extractText(await executeTool(...))` 只留正文 | 无 params/产物哈希可回放 |
| 自动注入工具 params 为空 | `toolUseLoop` 自动注入工具存 `input:{}`，NL 文本循环只存正文 | transcript 不足以确定性回放 |
| 无环境基线 | `envSymbiosis` 已归档删除（DESIGN-ARCH-039 orphan） | 无法判定「相对静止环境」假设是否成立 |
| 删除的产物无字节 | 轨迹只引用路径 | 产物被删后无从还原 |

**目标产出**：一套「可回放」的轨迹标准——录制侧产出完整保真**回放账本**（含产物哈希 + 内容寻址字节仓），
导出为**自包含回放包**，由**分档重放引擎**在「相对静止环境」假设下不靠任何 AI 确定性重放工具步骤、
复现成果，每步校验、分歧即停。

---

## 2. 标准化轨迹格式（本规范核心交付物）

### 2.1 回放账本条目（`*.replay-ledger.jsonl`，与 JSONL transcript 同目录、append-only）

账本是录制侧的**真源**，只存**哈希**以保持热路径轻量；复现已删文件所需的**字节**进会话级内容仓（内容寻址）。

```js
{
  v: 1, seq: 0, at: <epochMs>,
  name: "write_file", normName: "writefile", tier: "FILE",   // FILE|SHELL|NETWORK_AI（frozen）
  params: { /* 完整未截断 */ }, paramsHash: "sha256…",
  result: { success: true, exitCode: 0, outputHash: "sha256…", denied: false },
  writeDiff: { filePath: "/abs", beforeHash: "sha256|null", afterHash: "sha256|null" }, // 非文件变更=null
  artifacts: [ { path: "/abs", sha256: "…", op: "create|modify|delete" } ]
}
```

### 2.2 回放包 manifest（自包含可移植复现单元）

目录 `getProjectDataDir('trajectory_replay', <sessionId>)/<sessionId>.replaybundle/`：
`manifest.json` + `ledger.jsonl` + `env.json` + `content/<sha256>`（FILE 产物 after 字节，内容寻址去重）+ `chain.json`（可选，溯源链副本）。

```js
manifest = {
  v: 1, kind: "khyos-replay-bundle", sessionId, createdAt, producer: "khyos",
  env: <EnvFingerprint>,
  steps: [ <LedgerEntry…按 seq> ],
  contentManifest: { "<sha256>": { bytes: N } },
  summary: { total, byTier: { FILE, SHELL, NETWORK_AI }, artifacts },
  integrity: { ledgerHash: "sha256(ledger.jsonl)", chainStatus: {…} }
}
```

---

## 3. 回放分档模型（`tierRegistry.js` 单一真源，frozen）

用户锁定「智能分档」——按工具的**确定性可复现性**分三档，旋钮全走 env，绝不硬编码：

| 档 | 成员（种子） | 回放策略 | 理由 |
| --- | --- | --- | --- |
| `FILE` | write_file / edit_file / multi_edit / notebook_edit / 删除… | **自动重放** | 文件操作在静止环境下确定性 |
| `SHELL` | shell/bash/exec/run_command… | **仅预批准或确认**（`--shell-allow=PATTERN`，复用 `execApproval.matchCommandPattern`；否则跳过） | 壳命令副作用面广，须人控 |
| `NETWORK_AI` | web_search/web_fetch/agent/task/subagent… | **恒跳过**，标「不可确定性复现」 | 网络/模型非确定，复现无意义 |

**未知工具→SHELL**（最保守，绝不自动当 FILE 重放）。

---

## 4. 回放协议（`replayEngine.replay`，线性 fail-fast）

1. **环境闸（防呆⑤）**：`compare(manifest.env, capture())`；失配且非 `--force` → `status:'env-mismatch'` 并列全部 diff，绝不「差不多」静默续跑。
2. **按 seq 迭代**：NETWORK_AI → 跳过标注；SHELL → 仅预批准/确认放行，否则跳过；FILE → 自动。
3. **前置防呆（防呆⑥）**：删/覆盖前先验目标当前哈希 == `beforeHash`；已达终态 → 跳过（幂等）；前态分歧 → **HALT**（绝不毁未录数据）。
4. **经唯一漏斗重放**：`executeTool(name, params, {sessionId, source:'replay', replay:true, onControlRequest})`——file lock / 路径归一 / registry validate 全部保留。
5. **每步产物校验（防呆③）**：重算 sha256 比对 `artifacts[].sha256`；任一分歧 **立即 HALT**，返回 `status:'diverged'` + `divergedAt` + `{path,expected,actual}`。
6. **活跃度超时**：每步受 `KHY_REPLAY_STEP_TIMEOUT_MS`（默认 120000）兜底，挂死的工具不拖死回放。

报告：`ReplayReport{ status, envDiffs, steps[{seq,name,tier,action,verify,reason}], divergedAt, summary{replayed,skipped,halted,restored} }`。
`status ∈ {completed, env-mismatch, diverged, error}`。

### 4.1 权限闸协作（不可伪造、绝不全局放松）

回放不绕过 [DESIGN-ARCH-026] 审批网关。网关在 `requestPermission` 之前独立运行、独立于 `EXEC_APPROVED` 评估，
故引擎对**档内已批准重放**的步骤以 host 控制通道 `onControlRequest` 作**非交互但策略化**应答（approve + 供 L2
确认词，词走 `KHY_REPLAY_L2_CONFIRM` 默认 `YES`）；同时按合格步逐次盖不可伪造的 `EXEC_APPROVED` Symbol。
该应答仅对引擎决定重放的步骤触发（FILE 恒、SHELL 仅预批准/确认）——NETWORK_AI 在到闸前已跳过——因此严格
受限于用户锁定的回放策略，绝非全局放宽。

---

## 5. 六防呆红线

1. **热路径只增不破**：账本/内容录制 best-effort try/catch、result 后执行，绝不改 result/模型可见内容/破坏消息写入。
2. **AI 永不入回放环**：NETWORK_AI 档恒跳过、永不执行、显式标「不可确定性复现」；引擎不 import 任何模型路径。
3. **分歧即停**：任一每步哈希失配立即 HALT 带 seq+path+expected/actual，绝不静默续跑或「尽力修」。
4. **越权不复现**：`EXEC_APPROVED` 仅对档内合格步逐次盖；SHELL 无预批准/确认在到闸前即跳过；file lock 保留。
5. **环境失配显式**：默认拒绝 + 列全 diff，仅显式 `--force` 继续，无「差不多」静默。
6. **不毁未录数据**：删/覆盖前验前态 == beforeHash，前态分歧 HALT；每步活跃度超时兜底。

---

## 6. CLI

```
khy replay list                列出可回放会话（账本条数 + 分档摘要）
khy replay export [session]    导出会话为自包含回放包（缺省=最近一条）
khy replay verify [session|dir] 校验回放包完整性（账本哈希 + 内容 blob）
khy replay run [session|dir] [--force] [--shell-allow=PATTERN] [--from-seq=N]
                               确定性回放并复现产物；环境失配/分歧红色显式
```

裸别名：`回放` / `hf` → `replay run`。与只读的 `khy trace`（DESIGN-ARCH-047）正交：trace 看「发生了什么」，replay 做「重新发生」。

---

## 7. 环境旋钮（零硬编码）

| env | 默认 | 作用 |
| --- | --- | --- |
| `KHY_REPLAY_CAPTURE_CONTENT` | on | 录制时把 FILE after 字节写会话内容仓（已删文件仍可复现） |
| `KHY_REPLAY_FINGERPRINT_TOOLS` | `node` | 环境指纹探测的工具表 |
| `KHY_REPLAY_PROBE_TIMEOUT_MS` | 3000 | 单个指纹探测活跃度超时 |
| `KHY_REPLAY_STEP_TIMEOUT_MS` | 120000 | 单步回放活跃度超时 |
| `KHY_REPLAY_SHELL_ALLOW` | （空） | 预批准 SHELL 命令模式（逗号/换行分隔） |
| `KHY_REPLAY_L2_CONFIRM` | `YES` | 回放对 L2 红线步骤的确认词 |

---

## 8. 与 [DESIGN-ARCH-047] 的关系

047（溯源）与 048（回放）是同一份轨迹的两个正交维度：047 给每条记录盖溯源信封 + 防篡改链，让轨迹**可信、可审计、人机双读**；
048 在其上增设回放账本（含产物哈希 + 内容仓）让轨迹**可确定性复现**。048 的回放包可选携带 047 的链副本（`chain.json`），
回放前可一并核验来源真伪——溯源是回放的信任根，回放是溯源的能力延伸。
