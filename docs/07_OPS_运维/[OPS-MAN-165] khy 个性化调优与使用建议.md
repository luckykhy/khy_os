# [OPS-MAN-165] khy 个性化调优与使用建议

> 这份文档面向**本机唯一使用者/维护者**。它把「你这段时间用 khy 的真实习惯」映射到 khy
> **真实存在的可调旋钮**上，给出当前实测值、本次做过的微调，以及日常使用建议。
>
> 原则：只写 khy 里**真的能调**的东西。凡是查证不存在的开关（见文末「勘误」），一律不写、不臆造，
> 免得你照着一个不存在的 `KHY_*` 去改，白折腾。

---

## 一、先说结论：这次微调改了什么

| 项 | 改动前 | 改动后 | 为什么 | 如何还原 |
|----|--------|--------|--------|----------|
| 权限档（permission profile） | `normal` | `acceptEdits` | 你的习惯是「少打断 + 四红线必确认」，`acceptEdits` 正是这个甜点档 | 在 REPL 里按 `Shift+Tab` 循环回去，或 `security profile normal` |

**只改了这一处 live 配置。** 其余旋钮（本地模型预热、模型路由、网关）当前值都已合理，本次**不动**——B3 外科手术式，不顺手改。

> 落盘位置：`~/.khyquant/permissions.json`（在你的 home 目录，不在仓库里，属于「活配置」，不进任何提交）。

---

## 二、你的使用画像（观察到的习惯）

这些是从你的实际操作里读出来的信号，不是猜的：

- **`/goal` 是你的主力工作方式**：技能使用统计里 `goal` 已被调用 **162 次**，远超其它——你习惯「给可验证的成功标准 → 让它自循环到绿 → 才回报」（阿布 Loop Engineering B2）。
- **全自动、少打断，但四红线每条必确认**：删/批量覆盖文件、发布推送、外网、密钥——这四类你要求每次都停下来点头。
- **按任务分模型路由**：不同活派不同模型（见下文网关配置）。
- **面向工程的详细回答**：要「为什么 / 取舍」，不要糊弄。
- **中文交流**：Khy-OS 仓库是中文允许域，散文用中文，代码标识符/路径仍按英文规范。
- **本地模型 + 云模型混用**：本地跑 runner，云端走网关中转。

---

## 三、khy 的可调面（真实旋钮 + 当前实测值）

### 3.1 权限档：`permissionStore`（6 档）

档位是 khy 权限系统的总开关，源码 `services/backend/src/services/permissionStore.js`。**当前 = `acceptEdits`。**

| 档位 | 行为 | 适合 |
|------|------|------|
| `strict` | 什么都问 | 极度谨慎、审计场景 |
| `normal` | 安全/只读工具自动放行，其余问 | 默认、保守 |
| **`acceptEdits`** | normal + **非破坏性文件编辑自动放行** | **你现在这档：少打断，编辑不拦** |
| `auto` | 更激进的自动放行 | 信任度高、连续作业 |
| `dontAsk` | yolo 的反面：未显式允许的一律拒 | 白名单收敛 |
| `yolo` | 全部自动放行（= `--dangerous`） | 不建议日常用 |

**关键安全事实**：四红线不是靠档位守的。它们由一层**不可绕过的 critical gate**（`criticalGate` / `isUnbypassableGate`）强制，**与档位无关、始终生效**——哪怕切到 `yolo`，删文件/推送/外网/密钥这类关键操作仍会被拦下二次确认。所以 `acceptEdits` 是安全的：它只多放行「非破坏性文件编辑」，动不了红线。

```text
一次工具调用的判定顺序（简化）：
  yolo 档            → 直接放行
  不可绕过的关键门    → 命中即强制确认（四红线在这里，档位管不着）
  dontAsk 档         → 未显式允许 → 拒
  strict 档          → 问
  normal/acceptEdits + 安全/只读 → 放行
  acceptEdits + 非破坏性文件编辑  → 放行   ← 本次微调打开的甜点
  破坏性工具（非 yolo）           → 必须显式批准
```

**怎么切**：
- REPL 里 `Shift+Tab` 循环档位（会持久化）；
- 或命令 `security profile <strict|normal|acceptEdits|yolo>`。

### 3.2 模型路由与网关：`services/backend/.env`

按任务分模型的真身在这里（0 个 `KHY_` 行，全是网关/代理键）：

```text
GATEWAY_PREFERRED_ADAPTER = codex          # 首选适配器
GATEWAY_PREFERRED_MODEL   = gpt-5.3-codex-review
GATEWAY_PREFERRED_STRICT  = true           # 严格锁首选，不静默回退
RELAY_API_MODELS          = claude-opus-4-8 # 中转 API 暴露的模型
PROXY_MODEL_ROUTE_MAP     = { ... }         # 逐模型 → target 的路由表
GATEWAY_API_POOL_SERVICE_MAP / *_DEFAULT_MODEL_MAP  # 池服务映射
```

`PROXY_MODEL_ROUTE_MAP` 里每个模型名映射到 `api:<service>:<model>` 或 `relay_api:<model>`，并带 `strict:true`——这就是「按任务/按模型分渠道」的落地方式。想加一个模型路由，就往这张表里加一条。

### 3.3 本地模型预热 / 超时 / 探针：仓库根 `.env`（16 个 `KHY_` 行）

这些是**本地 runner 的性能旋钮**，全部真实存在、已登记，当前值合理：

```text
# 预热：只热一次，等待窗口
KHY_LOCAL_WARMUP_ONCE            = true
KHY_LOCAL_WARMUP_WAIT_MS         = 6000
KHY_OLLAMA_WARMUP_WAIT_MS        = 4000

# token 上限（冷/热/ollama）与是否解除上限
KHY_LOCAL_COLD_MAX_TOKENS        = 768
KHY_LOCAL_WARM_MAX_TOKENS        = 1536
KHY_OLLAMA_MAX_TOKENS            = 1536
KHY_LOCAL_DISABLE_TOKEN_CAP      = false

# 各类超时（热挂载/健康/启动/加载）
KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS   = 700
KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS = 800
KHY_LOCAL_RUNNER_START_TIMEOUT_MS  = 10000
KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS   = 90000

# 模型探针去抖（少打无谓探针）
KHY_MODEL_PROBE_DEBOUNCE            = true
KHY_MODEL_PROBE_DEBOUNCE_MAX_RETRIES = 4
KHY_MODEL_PROBE_DEBOUNCE_DELAY_MS    = 1200

# 池事件自动导入（当前都关，避免意外拉入来源）
KHY_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE     = false
KHY_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE = false
```

**调优提示**（按需，本次未动）：
- 本地机器强、想让本地模型答得更长 → 调高 `KHY_LOCAL_WARM_MAX_TOKENS`；
- 冷启动老超时 → 调高 `KHY_LOCAL_RUNNER_START_TIMEOUT_MS`；
- 大模型加载慢被判死 → 调高 `KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS`；
- 探针日志太吵 → `KHY_MODEL_PROBE_DEBOUNCE_DELAY_MS` 调大。

> 所有 `KHY_*` 的权威清单与默认值在 `services/backend/src/services/flagRegistry.js`（SSOT）。改开关前先在那里查一眼它是否存在、默认是什么。

---

## 四、习惯 → 旋钮映射表

| 你的习惯 | 对应的 khy 真实旋钮 | 现状 |
|----------|--------------------|------|
| 少打断，编辑不拦 | 权限档 `acceptEdits` | ✅ 本次已切 |
| 四红线每条必确认 | 不可绕过的 critical gate（与档位无关） | ✅ 天然强制 |
| `/goal` 目标驱动 | `/goal` 技能 + B2 纪律（章程） | ✅ 已是主力（162 次） |
| 按任务分模型 | `GATEWAY_PREFERRED_MODEL` / `PROXY_MODEL_ROUTE_MAP` | ✅ 已配置 |
| 本地模型混用 | 根 `.env` 的 16 个 `KHY_LOCAL_*` / `KHY_OLLAMA_*` | ✅ 已调 |
| 详细回答 | 交流约定（非配置项） | — 靠对话习惯维持 |

---

## 五、日常使用建议

### 5.1 用 `/goal` 的正确姿势（你的主力）

- **每步带 verify**：给 khy 目标时，尽量给「可验证的成功标准」（如「X 测全绿」「`node --check` 通过」）。没有验证标准，它会先补一条再动手。
- **让它自循环到绿**：不通过验证不该说「修好了」——这是 B2 的铁律，也是你已经在用的。
- **多步先列 plan**：复杂任务先看它列的步骤计划，每步都该挂一个验证命令。

### 5.2 四红线（务必心里有数）

删/批量覆盖文件 · 发布/推送 · 外网/外部服务 · 密钥/凭据——这四类**永远会停下来问你**，与权限档无关。看到确认提示别习惯性直接放行，尤其是：
- `git push` / `git reset --hard`（属敏感操作，强制二次确认）；
- 任何写外网、动 `.env` 真凭据的动作。

### 5.3 权限档随场景切换

- 平时：`acceptEdits`（现档，少打断）；
- 审计/接手陌生仓库、想每步都看清：`Shift+Tab` 切 `strict` 或 `normal`；
- **别用 `yolo` 当日常**——它会自动放行 L1（外网/推送/密钥）级操作，正好踩你的红线。

### 5.4 模型选择

- 复杂工程/审查类：走网关首选 `gpt-5.3-codex-review` / `claude-opus-4-8`；
- 轻量本地活：本地 runner（受 `KHY_LOCAL_*` token 上限约束，别指望它答很长）；
- 要加新模型：往 `PROXY_MODEL_ROUTE_MAP` 加一条路由，别硬编码。

### 5.5 上下文与恢复

- khy 会持久化会话；崩溃/断电后损坏的快照有修复兜底（session-file-repair），能救的会救回来；
- 长任务被上下文压缩后会自动带摘要续跑，不用你手动接力。

---

## 六、还原与排错

| 想做什么 | 怎么做 |
|----------|--------|
| 权限档还原成 normal | `Shift+Tab` 循环，或 `security profile normal` |
| 查某个 `KHY_*` 是否存在/默认值 | 看 `services/backend/src/services/flagRegistry.js` |
| 本地模型冷启动老失败 | 调高 `KHY_LOCAL_RUNNER_START_TIMEOUT_MS` / `_LOAD_TIMEOUT_MS` |
| 网关锁死首选模型不回退 | `GATEWAY_PREFERRED_STRICT=true` 是故意的；想允许回退才设 false |
| 确认权限档当前值 | 看 `~/.khyquant/permissions.json` 的 `profile` 字段 |

---

## 七、勘误：一个曾被误记的「习惯固化」说法

历史笔记里曾写过「已把 `KHY_PERMISSION_MODE` / `KHY_SEARCH_MODE` / `KHY_FULL_TUI` / `KHY_SELF_HEAL` / `KHY_COGNITIVE_SNAPSHOT` 等使用画像开关固化进 `.env`」。**经实测核对：这些开关在 `flagRegistry.js` 里并不存在，任何 `.env` 里也没有这些行。** 也就是说，khy **没有**用「一堆使用画像 `KHY_*` 开关」来固化习惯这回事——真正能调的是上面第三节列的那些。

这条勘误本身就是一条使用建议：**改任何 `KHY_*` 前，先去 `flagRegistry.js` 确认它真实存在**，别照着过期记忆去设一个幽灵开关。

---

**变更记录**：本次 = 权限档 `normal → acceptEdits`（live，可一键还原）+ 本文档。未 commit、未 push、未发布。
