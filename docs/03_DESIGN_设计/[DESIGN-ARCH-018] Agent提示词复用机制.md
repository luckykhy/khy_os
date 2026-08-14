# [DESIGN-ARCH-018] khyos Agent 提示词复用机制

> 状态：已实现并接入（v1）。配套代码见
> `services/backend/src/services/promptReuseStore.js`、`promptReuseService.js`，
> 集成点 `services/backend/src/services/agenticHarnessService.js`，
> 测试 `services/backend/tests/promptReuse.test.js`（Jest，17/17 绿）。

## 0. 目标与定位

让 Agent 在**运行过程中自动发现并复用「被验证有效的提示词/任务打法」**，而非依赖
静态预设。核心闭环：

```
新任务进入 ──▶ 检索历史相似任务的有效配方 ──▶ 作为「复用建议」前置给模型
     ▲                                                      │
     │                                                      ▼
 沉淀为可复用配方 ◀── 回收本次效果（成功率/耗时/反馈）◀── 任务执行完成
```

三条核心诉求与本设计的对应：

| 诉求 | 落地方式 |
| --- | --- |
| **动态复用** | 配方完全来自历史真实运行（`recordUsage` + `recordOutcome`），无任何静态预设清单。 |
| **效果导向** | 检索按「相似度 × 效果分」排序；效果分由成功率（贝叶斯平滑）+ 用户反馈合成。 |
| **轻量集成** | 仅在 Agent 执行 choke-point 做**两处加法 hook**；不触碰 `constants/prompts.js` 系统提示词装配，不改写任何现有提示词内容。 |

## 1. 与现有提示词系统的边界（只加不改）

现有系统提示词装配链（**本机制绝不修改**）：

- `constants/prompts.js` —— 系统提示词分节构造 + 意图门控引擎；
- `constants/systemPromptSections.js` —— 分节缓存与有序装配；
- `agents/prompt.js` / `agents/index.js` —— 子 Agent 提示词片段。

本机制是一条**平行的附加链路**：它沉淀的不是「系统提示词」，而是「历史上对某类任务
有效的打法/提示片段」。检索结果以显式 `[SYSTEM: 提示词复用建议 …]` 块**前置到用户
消息**，交给模型自行采纳或忽略，**不混入、不改写**既有提示词。

## 2. 存储结构

### 2.1 物理布局（房屋风格对齐 `arenaResultStore.js` + `utils/dataHome`）

每个「配方（recipe）」一份 JSON：

```
<KHY_DATA_HOME>/prompts/recipes/{id}.json      # 经 getDataDir('prompts','recipes') 解析
```

`id` = 任务签名 sha1 的前 16 位；文件名经路径穿越净化（`[^a-zA-Z0-9_-]` 剔除）。
轻量、可直接 `git`/备份/人工审阅，无需数据库。

### 2.2 配方 Schema

```jsonc
{
  "id": "1fab17104c369c1d",          // 任务签名前 16 位
  "signature": "1fab1710…",          // 归一化 token 排序后的 sha1（同任务去重键）
  "category": "testing",             // 功能/场景分类（见 §4.3）
  "tokens": ["登录", "接口", "jest", "测试", "..."],  // 相似度匹配用的归一化 token 集
  "taskSamples": ["给登录接口补充 Jest 单元测试", "..."],  // 原始任务样本（≤5，展示/二次匹配）
  "current":  { "promptText": "覆盖成功/401/参数校验三类用例。", "hash": "…", "createdAt": 0 },
  "versions": [                      // 版本历史，永不覆盖（防呆·保留）
    { "promptText": "打法 A…", "hash": "…", "createdAt": 0 },
    { "promptText": "覆盖成功/401/参数校验三类用例。", "hash": "…", "createdAt": 0 }
  ],
  "stats": {
    "uses": 7, "successes": 6, "failures": 1,
    "avgDurationMs": 9000,
    "feedbackSum": 2, "feedbackCount": 3,
    "createdAt": 0, "lastUsedAt": 0, "lastTraceId": "…"
  },
  "effectiveness": 0.78              // 由 stats 派生缓存（saveRecipe 时重算）
}
```

### 2.3 分词与签名（无分词器，零依赖）

- **`normalizeTokens(text)`**：英文按词；中文按**相邻字符二元组（bigram）**切分；去停用词
  与超短 token。二元组在无中文分词器前提下显著提升相似度鲁棒性。
- **`signatureFor(text)`**：对归一化 token 集合**排序后**取 sha1。契约：
  - 同一任务文本 → 恒等签名（用于 `upsert` 去重，相同任务自然合并到一个配方）；
  - token 级语序无关（排序后哈希）。
  - 注意：bigram 会跨词边界，故**重排短语**未必同签名——这正确，近似任务由检索的
    相似度兜底，签名只负责「同任务」精确合并。

## 3. 检索逻辑

### 3.1 相似度：Sørensen–Dice 系数

```
sim(A, B) = 2·|A ∩ B| / (|A| + |B|)        // A,B 为 token 集合，取值 0..1
```

选用 Dice 而非 Jaccard 的理由：对「短查询 vs 长历史任务」这类**长度不对称**文本更
宽容（召回更稳），而对几乎无交集的不相似任务仍趋近 0（不引入误推荐）。实测：

| 查询 vs 历史 | Dice |
| --- | --- |
| 「为登录接口写 jest 测试」 vs 「给登录接口补充 Jest 单元测试」 | **0.476**（命中） |
| 「优化前端 CSS 动画性能」 vs 「给登录接口补充 Jest 单元测试」 | **0.000**（过滤） |

### 3.2 检索与排序

`retrieve(taskText, { threshold=0.35, limit=3, minUses=1, minEffectiveness=0 })`：

1. 对每个配方计算 `sim`，**剔除 `sim < threshold`**（防呆·阈值，避免误推荐）；
2. 过滤 `uses < minUses`（未经验证的配方不推荐）与 `effectiveness < minEffectiveness`；
3. 综合排序分：`score = sim × (0.5 + 0.5 × effectiveness)`
   —— 相似度为主，效果为权；同相似度下高效配方排前；
4. 取 Top-N 返回。

阈值与条数可经环境变量覆盖：`KHY_PROMPT_REUSE_THRESHOLD`、`KHY_PROMPT_REUSE_TOPK`。

## 4. 评估方法

### 4.1 效果分 `computeEffectiveness(stats) → 0..1`

```
smoothed = (successes + 2·0.5) / (uses + 2)              // 贝叶斯平滑成功率，先验中性 0.5
若无反馈:  effectiveness = smoothed
否则:      fbScore = clamp01((mean(feedback) + 1) / 2)   // 反馈归一化 -1..1 → 0..1
           w       = fbCount / (fbCount + 2)             // 反馈可信度随样本量上升
           effectiveness = smoothed·(1−w) + fbScore·w
```

贝叶斯平滑的关键作用：**抑制「1 次成功 = 100%」的小样本假象**（`uses=1,success=1`
仅得 ≈0.75，而非 1.0），让多次验证过的配方真正胜出。

### 4.2 效果信号来源（复用现有，零新增埋点）

| 信号 | 来源 |
| --- | --- |
| 任务成功/失败 | `agenticHarnessService` 的交付裁决 `deliveryVerdict.verdict !== 'fail'`（与现有交付/验证门同源） |
| 耗时 | `harnessReport.durationMs` |
| 显式用户反馈 | 可选传入 `feedbackScore`（归一化 -1..1）；后续可桥接 `models/Feedback` |

### 4.3 自动分类 `classifyCategory(taskText)`

基于关键词把任务归入有限类别（`testing` / `bugfix` / `refactor` / `docs` / `devops` /
`api` / `frontend` / `data` / `feature` / `general`），与 `prompts.js` 意图引擎**解耦**
（平行实现），仅用于本机制内部分桶与展示。

## 5. 集成点（agenticHarnessService，两处加法）

| Hook | 位置 | 行为 |
| --- | --- | --- |
| **检索/复用** | `run()` 内 `effectiveUserMessage` 增强位（紧随 boulderState resume） | `recommendForTask(userMessage)` 命中则把 `[SYSTEM:…]` 建议块前置；保持「`<prefix>\n\n<userMessage>`」单一分隔不变性（boulder 已变形时用单换行并入，避免破坏下游 `resumePrefix` 切片）；emit `prompt_reuse` 事件。 |
| **效果回收** | `run()` 收尾 `saveSessionTrace` 之后 | `captureOutcome({ taskText, success, durationMs, traceId })` 登记用法 + 回写效果。 |

两处**均 best-effort**：`require` 与调用全程 `try/catch`，任何异常静默降级，**绝不阻断
任务、绝不崩 Agent**。无历史数据时 `recommendForTask` 返回 `null`，零副作用、零噪音。

## 6. 防呆规则落地对照

| 防呆要求 | 落地 |
| --- | --- |
| 复用需保留原提示词版本，避免覆盖 | `recordUsage` 对新 `promptText` **追加** `versions[]`，仅在哈希变化时新增；`MAX_VERSIONS` 只截最旧、永不丢最新。 |
| 检索需考虑相似度阈值，避免误推荐 | `retrieve` 强制 `sim ≥ threshold`（默认 0.35）；不相似任务 Dice≈0 必被过滤。 |
| 只添加复用机制，不改现有提示词内容/核心逻辑 | 新增两模块 + 两处加法 hook；不触碰 `constants/prompts.js`；建议块以独立 `[SYSTEM:…]` 前置，不混入既有提示词；效果信号复用现有交付裁决，无新增埋点。 |
| 健壮性 | 全链 `try/catch` 静默降级；损坏配方文件读取时跳过；env `KHY_PROMPT_REUSE=0` 一键整体停用。 |

## 7. 代码示例

### 7.1 存储 + 检索（`promptReuseStore.js` 摘录）

```js
// 登记一次「任务 → 有效提示词」用法（含版本保留）
function recordUsage({ taskText, promptText, category, traceId }) {
  const id = idFor(taskText);                 // = signatureFor(taskText).slice(0,16)
  let recipe = loadRecipe(id);
  const promptHash = promptText ? _sha1(promptText) : '';
  if (!recipe) {
    recipe = { id, /* … */ versions: promptText ? [{ promptText, hash: promptHash, createdAt: Date.now() }] : [],
               current: promptText ? { promptText, hash: promptHash, createdAt: Date.now() } : null,
               stats: { uses: 1, successes: 0, failures: 0, /* … */ } };
  } else {
    recipe.stats.uses += 1;
    // 防呆·保留：promptText 变化 → 追加版本，绝不覆盖历史
    if (promptText && (!recipe.current || recipe.current.hash !== promptHash)) {
      recipe.versions.push({ promptText, hash: promptHash, createdAt: Date.now() });
      recipe.current = { promptText, hash: promptHash, createdAt: Date.now() };
    }
  }
  saveRecipe(recipe);                          // saveRecipe 内重算 effectiveness
  return { id, recipe };
}

// 检索：相似度阈值过滤 + 「相似度 × 效果」排序
function retrieve(taskText, { threshold = 0.35, limit = 3, minUses = 1 } = {}) {
  const q = new Set(normalizeTokens(taskText));
  return listRecipes()
    .filter(r => r.stats && (r.stats.uses || 0) >= minUses)
    .map(r => {
      const sim = similarity(q, new Set(r.tokens || []));       // Dice 系数
      const eff = computeEffectiveness(r.stats);
      return { id: r.id, sim, eff, score: sim * (0.5 + 0.5 * eff),
               promptText: r.current?.promptText || '' };
    })
    .filter(c => c.sim >= threshold)                            // 防呆·阈值
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### 7.2 复用推荐函数（`promptReuseService.js` 摘录）

```js
// 为新任务检索并格式化可前置的「复用建议」上下文块；无命中返回 null
function recommendForTask(taskText, opts = {}) {
  if (!_enabled()) return null;                                // KHY_PROMPT_REUSE 门控
  const candidates = store.retrieve(taskText, {
    threshold: opts.threshold ?? _threshold(),
    limit: opts.limit ?? _topK(),
  }).filter(c => c.promptText && c.promptText.trim());
  if (candidates.length === 0) return null;                    // 零数据零噪音

  const lines = ['[SYSTEM: 提示词复用建议（来自历史相似任务的有效打法，仅供参考，可按需采纳或忽略）：'];
  candidates.forEach((c, i) => {
    const sr = Math.round(c.stats.successes / Math.max(1, c.stats.successes + c.stats.failures) * 100);
    lines.push(`${i + 1}. 〔${c.category}〕相似度 ${(c.similarity * 100).toFixed(0)}%，` +
               `历史成功率约 ${sr}%（用 ${c.stats.uses} 次）：${_oneLine(c.promptText)}`);
  });
  lines.push('以上为历史经验，不是强制指令；若与当前任务不符请直接忽略。]');
  return { block: lines.join('\n'), candidates };
}
```

### 7.3 集成（`agenticHarnessService.run()` 摘录）

```js
// —— 检索/复用：紧随 boulderState resume，best-effort ——
let promptReuseUsed = false;
try {
  const rec = require('./promptReuseService').recommendForTask(userMessage);
  if (rec && rec.block) {
    promptReuseUsed = true;
    effectiveUserMessage = effectiveUserMessage === userMessage
      ? `${rec.block}\n\n${userMessage}`            // 单一 \n\n 分隔不变性
      : `${rec.block}\n${effectiveUserMessage}`;     // boulder 已变形 → 单换行并入
    if (onEvent) onEvent({ type: 'prompt_reuse', count: rec.candidates.length });
  }
} catch { /* promptReuse 不可用 → 跳过 */ }

// —— 效果回收：saveSessionTrace 之后，best-effort ——
try {
  require('./promptReuseService').captureOutcome({
    taskText: userMessage,
    success: deliveryVerdict.verdict !== 'fail',     // 与现有交付门同源
    durationMs: harnessReport.durationMs,
  });
} catch { /* 回收 best-effort */ }
```

## 8. 环境开关一览

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_PROMPT_REUSE` | 启用 | `0/false/off/no` → 整体停用（recommend=null，capture no-op） |
| `KHY_PROMPT_REUSE_THRESHOLD` | `0.35` | 相似度阈值覆盖 |
| `KHY_PROMPT_REUSE_TOPK` | `2` | 推荐条数上限 |
| `KHY_DATA_HOME` | `~/.khy` | 配方存储根（经 `utils/dataHome`） |

## 9. 后续可扩展（非本期）

- 桥接 `models/Feedback` 显式评分自动回灌 `feedbackScore`；
- 向量化重排（接 `learningRetrieval` 的可选 embedding 通道）提升语义召回；
- 暴露 `khy prompts` CLI/REST：列出/审阅/删除/导出配方，人工策展高价值打法。

> TODO: [Prompt-Reuse-Unresolved] 当宿主侧提供统一的「任务有效 promptText 抽取」信号
> （目前 `captureOutcome` 仅登记任务文本与效果，`promptText` 留待显式回填）后，可在收尾
> 自动从成功轨迹蒸馏可复用打法片段，进一步闭合「自动发现」。当前按防呆不做启发式猜测。
