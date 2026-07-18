# [DESIGN-ARCH-049] 轨迹即教材 — AI 引导回放、地图模板与弱模型上下文引导

状态：已实现（G1–G10 全闭环。用户需求「轨迹在有 AI 时，子代理能真正完整复现项目成果；不够聪明的小模型
参照已有轨迹走成功率最高的路径、避免无谓探索；允许聪明的高智商大模型直接给小模型画地图模板，让小模型
或效果差的大模型照着轨迹走」）

依赖前序：
- [DESIGN-ARCH-048] khyos 轨迹回放与确定性复现（本规范是其「AI 维度」叠加层：确定性核心走不通处由 AI 补桥；
  录制 sha256 仍是唯一成功判据。048 引擎保持 model-free，本规范绝不改其确定性语义）
- [DESIGN-ARCH-047] 轨迹溯源标准（轨迹记录的上游）
- [DESIGN-ARCH-026] 系统级服务调用审批网关（补桥子代理仍走同一 `executeTool` 漏斗 + `onControlRequest`；
  绝不自动批准超录制策略的 SHELL/L2）
- `marshal/capabilityVector`（强/弱模型分级单一真源；marshal 引擎已归档，叶子 capabilityVector 仍在产）
- `selfHeal/microLoopExecutor`（`MAX_LOOP=1` 一次修复上限范式，本规范补桥镜像之）

实现位置：
- `services/backend/src/services/trajectoryGuide/`（新子系统，8 模块 + barrel；旋钮全 env、缺省安全）
  - `config.js`——env 旋钮单一真源（命名默认，全 off/保守）
  - `aiBridge.js`——**唯一触模型模块**（在引擎外）：repair 钩子工厂，per-seq 计数强制 `MAX=repairMax()`
  - `mapAuthor.js`——蒸馏轨迹为地图模板（强模型闸；确定性 qualityScore；产 map.json + SKILL.md 两格式）
  - `mapStore.js`——地图持久化（`getProjectDataDir('trajectoryGuide','maps')`，原子写，纯 FS）
  - `mapExport.js`——地图导出进技能生态（委托 `skillPackageService.importSkill`，md|folder）
  - `guideRetriever.js`——为新任务检索相关地图（复用 `learningRetrieval.buildContext` + `extraPaths`，质量分混合）
  - `guideInjector.js`——弱模型限定的「推荐路径」系统提示词块（纯函数、可每轮安全调用）
  - `index.js`——barrel
- `services/backend/src/services/trajectoryReplay/replayEngine.js`——纯增量补丁：新增私有 `_maybeRepair` +
  5 处 seam 守卫分支 + `summary.repaired` 字段（**无任何模型 import**；缺省 `opts.repair` 缺席 = 字节级 048 原引擎）
- `services/backend/src/cli/ai.js`——`makeSystemPrompt` 之后追加 `trajectoryGuideBlock`（异步预算、同步追加；缓存零污染）
- `services/backend/src/cli/handlers/replay.js`——`run` 加 `--ai` flag，仅 env/`--ai` 开时构造 `opts.repair`
- `services/backend/src/cli/handlers/guide.js`（新）+ `router.js` + `constants/commandSchema.js` + `cli/aliases.js`——`khy guide` 命令接线

验收测试（node:test；共 36 例 + 048 零回归 38 例）：
- `tests/services/trajectoryGuide/config.test.js`（5 例：默认全 off + override 解析）
- `tests/services/trajectoryReplay/g2EngineRepairSeam.test.js`（6 例：假 `opts.repair` 走 repaired + 省略钩子复现 048 全行为）
- `tests/services/trajectoryGuide/aiBridge.test.js`（5 例：紧窄 prompt + 结构化契约 + `MAX_LOOP=1` + `onControlRequest` 透传 + 抛错被捕获 + 端到端复现已删产物）
- `tests/cli/handlers/replayHandlerAi.test.js`（3 例：env on/off/`--ai` 三路 banner）
- `tests/services/trajectoryGuide/mapAuthor.test.js`（5 例：强模型蒸馏 + 弱模型拒绝 + SKILL.md 经 `parseSkillContent` 回环 + mapStore 存读 + qualityScore 可复现）
- `tests/services/trajectoryGuide/mapExport.test.js`（3 例：md/folder 两格式落技能根 + 未知 mapId 报错）
- `tests/services/trajectoryGuide/guideRetriever.test.js`（4 例：RAG 关→null + 无地图→null + 相关地图被检出且质量分混合 + id 还原）
- `tests/services/trajectoryGuide/guideInjector.test.js`（5 例：注入关→null + 强模型→null + 弱模型命中→推荐路径块 + 弱模型无地图→null + 预算截断）
- `tests/cli/handlers/guideHandler.test.js`（6 例：强模型蒸馏持久化 + 弱模型拒绝 + list 显示 + export 入技能 + 未知 mapId/子命令友好报错）

---

## 1. 问题：轨迹「可确定性复现」≠「能用 AI 完整复现」且「弱模型能照着走」

[DESIGN-ARCH-048] 已让一条轨迹在「相对静止环境」假设下**不靠任何 AI** 确定性重放工具步骤、复现产物。
但确定性回放有三类天然边界，恰是 AI 维度该补的地方：

| 确定性边界 | 048 行为 | 本规范叠加 |
| --- | --- | --- |
| NETWORK_AI 步（含真模型推理） | 恒跳过、标「不可确定性复现」 | 有 AI 时由子代理接手真正复现成果 |
| 未预批准的 SHELL 步 | 默认跳过 | 有 AI 时子代理在同一审批闸下尝试 |
| 产物哈希分歧 / 前置失配 | 立即停机 | 有 AI 时子代理补桥一次，再以录制 sha256 复检 |
| 弱模型为新任务从零探索 | 不涉及（048 无模型） | 检索既有成功轨迹，注入「推荐路径」省去无谓试错 |
| 强模型经验无法传给弱模型 | 不涉及 | 强模型蒸馏轨迹为「地图模板」，弱模型照着走 |

**三个耦合能力**（用户原话拆解）：
- **A. AI 辅助复现**：有 AI 时，子代理在确定性走不通处接手，把成果真正完整复现。
- **B. 弱模型引导**：弱/小模型参照既有成功轨迹走「成功率最高路径」，避免「想一堆还走差结果」。
- **C. 地图模板**：强模型把一条轨迹蒸馏成地图模板，导出进技能生态，供弱模型/效果差的大模型照着走。

---

## 2. 三项锁定决策（用户拍板）

### 2.1 AI 介入边界 =「补桥但守红线」

- AI **只在确定性走不通处补桥**；正常 FILE 步仍由 048 确定性核重放，AI 绝不插手。
- 录制产物 **sha256 恒为唯一成功判据**：补桥后成功仅由 `_verifyArtifacts(step)` 判定；
  子代理**绝不**为凑哈希改任何文件或改 `artifacts[].sha256`，必须真正执行录制操作。
- **最多修一次**（镜像 selfHeal `MAX_LOOP=1`）：`aiBridge` per-`step.seq` 计数 + 引擎每 seam 至多调一次。
- **红线全保留**：补桥子代理走同一 `executeTool` 漏斗 + `onControlRequest`；越权（超录制策略 SHELL / L2 / 宪法红线）即返红线 halt。

### 2.2 地图模板格式 =「两者都要」

- 内部 **map.json**：`{id, sessionId, task, steps:[{seq,name,tier,intent,artifacts}], qualityScore, env, createdBy, createdTier}`，
  供 guideRetriever / guideInjector 消费。
- 可导出 **SKILL.md**：frontmatter（`name/description/tags/version/entry_point`）+ 推荐路径正文，
  可被 `skillLoader.parseSkillContent` 回读，经 `skillPackageService.importSkill` 入技能目录。

### 2.3 弱模型引导强度 =「上下文引导」

- 注入「推荐路径」块，措辞为**强力建议、不硬锁**（「You MAY follow … guidance, not a constraint」）。
- env 默认关（`KHY_TRAJ_GUIDE_INJECT` off）→ 系统提示词 `sp` 字节不变，零回归。
- 内部再限 `strength==='weak'`：强模型不消费地图（消费地图本就是给弱模型的）。

---

## 3. 引擎增量补丁（`replayEngine.replay` — 缺省 byte-identical，048 零回归）

新增私有助手 `_maybeRepair(step, opts, kind)`（文件内，**不新增任何 import**；模型只经注入的 `opts.repair` 闭包进入）：

```js
async function _maybeRepair(step, opts, kind) {
  if (typeof opts.repair !== 'function') return null;   // 零回归闸：无钩子即 048 原引擎
  let r;
  try { r = await opts.repair(step, { kind }); }
  catch (e) { return { decision: 'halt', reason: `repair error: ${e && e.message}` }; }
  if (!r || r.attempted === false) return null;          // 桥放弃 → 落原确定性路径
  const v = _verifyArtifacts(step);                      // sha256 仍是唯一 oracle
  if (v.ok) return { decision: 'repaired' };
  return { decision: 'halt', reason: r.reason || '产物哈希分歧（修复后仍不一致）', detail: v.detail };
}
```

在 **5 处**非完成 seam 各插一段 `typeof opts.repair === 'function'` 守卫下的前置分支（原 halt/skip 块原样保留在下方）：
NETWORK_AI 跳过（`kind:'network_ai'`）、未批准 SHELL 跳过（`'shell'`）、前置分歧（`'precondition'`）、
执行失败 catch（`'exec'`）、产物校验失配（`'post-verify'`）。`repaired` 时 `rec.action='repaired'`、
`rec.reason='AI 桥接复现（哈希校验通过）'`、`summary.replayed`+`summary.repaired`+`restored` 各递增；
`halt` 时 `rec.action='halted'`、`status='diverged'`、`divergedAt` 语义与 048 一致。

**接线**：CLI（`handlers/replay.js run`）仅当 `--ai` 或 `config.isAiReplayEnabled()` 才构造
`opts.repair = aiBridge.createRepairHook({...})`，否则 `undefined` = 纯 048 引擎。

---

## 4. AI 补桥子代理（`aiBridge.js`，唯一触模型模块，在引擎外）

`createRepairHook(opts) → async repair(step, ctx)`：
- 闭包内 `attemptsBySeq` per-`step.seq` 计数，强制 `MAX=repairMax()`（缺省 1）；超额返 `{attempted:false, reason:'repair budget exhausted'}`。
- 构造**紧窄**子代理目标（`_buildRepairPrompt`）：点名目标文件 `step.artifacts[].path` + 必需 sha256；
  明文「**不得仅为凑哈希改任何文件**（do NOT …），须真正执行录制操作；录制哈希是唯一成功判据（sole success criterion）」。
- `tool.execute({prompt, subagent_type:'verify', preferred_model:repairModel(), timeout}, {traceContext:{onControlRequest}})`，
  `onControlRequest` 经 `traceContext` 下钻子壳审批（红线在此闸内执行）。
- 返回 `{attempted, ok?, reason, agent?}`；**绝不**自己写录制文件 / 改 sha256，校验交还引擎；
  AgentTool 抛错被捕获为 `{attempted:true, ok:false, reason:'repair agent error: …'}`，绝不向引擎外传播。

---

## 5. 地图模板：蒸馏 → 持久化 → 导出（能力 C）

- **蒸馏**（`mapAuthor.authorMap(bundle, {modelId, task})`）：闸
  `if (config.mapAuthorMinStrength()==='strong' && assess(modelId).strength!=='strong') throw MAP_AUTHOR_FORBIDDEN`——
  仅强模型可作者地图。蒸馏本身**确定性、无模型调用**（模型角色 = 授权 + 可选后续增强）：
  - `_stepIntent`：按分档 + 产物 basename 生成短意图（`create index.js` / `run: npm install` / `… (network/AI — guidance only)`）。
  - `_qualityScore`：`0.6*FILE占比 + 0.3*产物加成 + 0.1*(1-NET占比)`，**无时钟无随机**，同轨迹⇒同分（检索排名可复现）。
  - `_mapId`：`map-<sessionId>-<sha256(steps前12)>`，由内容派生（无时钟）。
- **持久化**（`mapStore`）：`getProjectDataDir('trajectoryGuide','maps')/<id>.map.json`，原子 tmp+rename，纯 FS。
- **导出**（`mapExport.exportAsSkill(mapId, {format})`）：从存储地图重渲 SKILL.md → 暂存 → 委托
  `skillPackageService.importSkill`（md|folder），落用户技能根；未知 mapId → `MAP_NOT_FOUND`。

---

## 6. 弱模型上下文引导（能力 B）

- **检索**（`guideRetriever.findGuide(query, {allowVector})`）：复用 `learningRetrieval.buildContext`，
  以 `extraPaths=listMaps().map(pathFor)` 把地图喂进语料；继承既有混合（词法 + 可选向量）排名与 `RAG_ENABLED` 闸。
  retrieval 分与存储 qualityScore **混合**：`blended = retrievalScore * (0.5 + 0.5*quality)`（质量分作 [0.5,1] 乘性先验，
  绝不从噪音中拔高）。RAG 关 / 无相关 → `null`（非错误）。
- **注入**（`guideInjector.buildGuideBlock({userMessage, modelId})`）：三重闸——
  `isGuideInjectEnabled()` + `assess(modelId).strength==='weak'` + 检索命中——任一不满足返 `null`。
  命中则按 `guideChars()` 预算渲「# Recommended Path (from a past successful trajectory)」块。
- **接线**（`cli/ai.js`）：在 `makeSystemPrompt` 返回**之后**异步预算 `trajectoryGuideBlock`，同步追加到 `sp`；
  builder 是同步 IIFE，故预算在外层 async scope 完成、IIFE 内只追加，sha256 提示词缓存零污染；关 → `sp` 字节不变。

---

## 7. CLI 面

```
khy replay run [session|dir] --ai             # 开 AI 修桥（等价 KHY_TRAJ_AI_REPLAY=on 单次）
khy guide map [session] [--model=<强模型ID>]  # 强模型蒸馏轨迹 → map.json（+qualityScore）
khy guide export <mapId> [--format=md|folder] # map → SKILL.md 入技能生态
khy guide list                                # 列已蒸馏 map（task + qualityScore，按质量分降序）
```

裸别名：`回放`/`hf` → `replay run`；`地图`/`dt` → `guide map`。

---

## 8. 六防呆红线

1. **引擎保持 model-free**：`replayEngine.js` 不新增任何模型 / AgentTool import；模型只经注入的 `opts.repair` 闭包进入。
2. **sha256 恒为唯一 oracle**：补桥后成功仅由 `_verifyArtifacts`（录制 sha256）判定；桥**绝不**为凑哈希写录制文件或改 `artifacts[].sha256`。
3. **一步只修一次**：`aiBridge` per-seq 计数 + 引擎每 seam 至多调一次 repair（镜像 selfHeal `MAX_LOOP=1`），repaired 步不再入修。
4. **红线不放松**：补桥子代理仍走同一 `executeTool` 漏斗 + `onControlRequest`；绝不自动批准超录制策略的 SHELL/L2，越权即返红线 halt。
5. **缺省零回归**：`opts.repair` 缺席 = 纯 048 引擎；`KHY_TRAJ_*` 默认全 off；提示词注入在 builder 之后、缓存零污染。
6. **状态透明**：每次补桥/跳过/停机 push `rec`+`onStep`（新 `action:'repaired'`、`reason`），CLI/`--json` 可见 AI 介入点。

---

## 9. env 旋钮（`config.js` 单一真源，命名默认）

| 旋钮 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_TRAJ_AI_REPLAY` | off | 是否启用 AI 补桥（等价 `khy replay run --ai`） |
| `KHY_TRAJ_GUIDE_INJECT` | off | 是否向弱模型注入「推荐路径」系统提示词块 |
| `KHY_TRAJ_REPAIR_MAX` | 1 | 单步补桥上限（镜像 `MAX_LOOP=1`） |
| `KHY_TRAJ_REPAIR_TIMEOUT_MS` | 120000 | 单次补桥子代理超时 |
| `KHY_TRAJ_REPAIR_MODEL` | （空） | 补桥子代理首选模型（空 = 子代理默认） |
| `KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH` | strong | 蒸馏地图所需最低模型强度 |
| `KHY_TRAJ_GUIDE_CHARS` | 1200 | 注入块字符预算 |

复用既有：`KHY_LEARN_RAG`（检索总闸，guideRetriever 经 `learningRetrieval.RAG_ENABLED` 间接受其控制）。

---

## 10. 与 048/047 的关系

- **047**（溯源）→ **048**（确定性可回放）→ **049**（AI 维度叠加）三层递进：能看见 → 不靠 AI 复现 → 有 AI 时完整复现 + 弱模型照着走。
- 049 对 048 **纯增量、缺省 byte-identical**：删除 trajectoryGuide 子系统 + 还原引擎 5 处守卫分支即回到 048，无残留耦合。
- 引擎确定性语义 / sha256 唯一判据 / 文件锁 / 审批闸全由 048/026/022 提供，049 **绝不放松**，只在其边界外补 AI 桥。
