# DESIGN-ARCH-058 细粒度权限策略中间件 + 记忆主动化引擎 + 记忆定期蒸馏

> 三个相互独立、与主循环解耦的子系统：
> - **模块一**：配置驱动的细粒度权限控制中间件（真正的调用前拦截器）。
> - **模块二**：记忆主动化引擎（真正注入系统提示词的动态注入器）。
> - **模块三**：记忆定期蒸馏器（明白哪些该忘记、哪些该记住；忘记=可恢复归档）。
>
> 三者均遵循「未配置即零行为变更、失败安全（fail-closed / fail-soft）、只增不减保护」三原则，
> 默认开关存在但不破坏任何既有路径。**绝不静默删除用户数据**：蒸馏的「忘记」一律为
> 可逆归档（移动至 `.archive/` 并记录清单），周期运行默认仅报告、不改盘。

---

## 一、目录结构

```
services/backend/src/
  services/
    permissionPolicy/          # 模块一：权限策略中间件
      config.js                #   策略文件加载/保存/脚手架（<dataHome>/permissions.json）
      matchers.js              #   纯分类与匹配（detectCategory / glob / path / url / 敏感操作）
      index.js                 #   evaluate() 评估器 + 管理助手（admin helpers）
    memoryEngine/              # 模块二：记忆主动化引擎
      scoring.js               #   关键词 × 时间衰减 × 类型过滤 的排序
      index.js                 #   主动检索 + 提示词框定 + addStructuredMemory
  memdir/                      # 既有记忆基座（被模块二复用）
    memdir.js                  #   新增导出 _tokenizeForRecall / _overlapCount（单一真源）

接入点（已改造）：
  services/backend/src/services/toolCalling.js   # requestPermission 漏斗接入模块一
  services/backend/src/tools/executeCode.js      # 执行超时受策略上限收紧
  services/backend/src/cli/ai.js                 # 系统提示词装配接入模块二
  services/backend/src/cli/router.js             # /permissions 与 /remember --type
  services/backend/src/constants/commandSchema.js# /permissions 路由 + permissions 命令白名单

测试：
  services/backend/tests/services/permissionPolicy/permissionPolicy.test.js  # 19 例
  services/backend/tests/services/memoryEngine/memoryEngine.test.js          # 12 例
```

---

## 二、模块一：细粒度权限控制中间件

### 2.1 配置文件 `<dataHome>/permissions.json`

通过 `utils/dataHome.getDataHome()` 解析（默认 `~/.khy`，可由 `KHY_DATA_HOME` /
`.location.json` 指针覆盖）。**与既有的 profile 式 `~/.khyquant/permissions.json`
（permissionStore）是两个独立命名空间**，互不影响。

```jsonc
{
  "version": 1,
  "defaultPolicy": "confirm",         // 全局默认：auto | confirm | deny
  "tools": { "shellCommand": "deny" },// 逐工具覆盖（按名，支持别名/规范化匹配）
  "filesystem": {
    "pathWhitelist":   ["/work/**"],  // 所有文件操作通用
    "readWhitelist":   [],            // 进一步按动词限制
    "writeWhitelist":  [],
    "deleteWhitelist": []
  },
  "network":  { "urlWhitelist": ["*.github.com", "https://api.example.com/*"] },
  "codeExecution": {
    "allowedLanguages": ["javascript", "python"],
    "limits": { "cpuSeconds": 0, "memoryMb": 0, "timeoutMs": 0 }  // 0 = 不额外限制
  },
  "sensitiveOperations": {
    "requireConfirm": ["git push", "git reset --hard", "deploy", "rm -rf", "drop table", "批量删除"]
  }
}
```

- **文件不存在 ⇒ 中间件完全无操作**，现有权限流程 100% 不变（用户写文件后才生效）。
- 文件损坏 ⇒ 降级为「无策略」，在评估层 fail-closed（只会增加保护）。
- 杀手开关：`KHY_PERMISSION_POLICY=off`。

### 2.2 评估契约 `evaluate(toolName, params, ctx)`

返回 `{ decision, category, reason, matched, limits }` 或 `null`（无策略 ⇒ 调用方按原流程继续）。

判定顺序（每一步只增不减保护）：

1. **敏感操作** 命中 `sensitiveOperations.requireConfirm` ⇒ 强制 `confirm`（除非已是 `deny`，deny 更严）。
2. **deny** 直接阻断。
3. **代码执行语言闸门**：配置了 `allowedLanguages` 且语言不在列表 ⇒ `deny`；否则按基础策略并附带 `limits`。
4. **白名单类（文件/网络）**：`auto` 模式下「白名单内放行 / 白名单外拒绝」；无白名单时 `auto` 不施加限制（放行）。
5. **其余类（shell/git/other）**：按基础策略；`auto` 即放行。

### 2.3 接入 `toolCalling.requestPermission`（真正的前置拦截器）

接入点位于 preflight 之后、permissionStore 之前：

```
EXEC_APPROVED → criticalGate（不可绕过红线）→ plan-mode deny → preflight
   → 【策略中间件 evaluate】
       deny     → 立即拒绝（fail-closed）
       confirm  → 置 policyConfirm 标志（抑制后续 acceptEdits/bypass/已批准 的自动放行）
       auto     → 置 policyAutoAllow 标志
   → permissionStore（显式 deny 仍优先）
   → 【policyAutoAllow && !criticalGate ⇒ 放行】
   → safe/low 自动放行（受 !policyConfirm 约束）
   → acceptEdits / bypass（受 !criticalGate && !policyConfirm 约束）
   → 已批准（受 !criticalGate && !policyConfirm 约束）
   → 交互式确认
```

关键不变量：
- 策略**永不放松**关键红线（`criticalGate`）——白名单 `auto` 仍要过红线。
- 策略 `confirm` **强制弹窗**，即使处于 acceptEdits/bypass/已批准也不静默放行。
- 代码执行超时上限只会**收紧**（`min(默认, 策略 timeoutMs)`），绝不放宽（`executeCode.js` fail-soft 接入）。

### 2.4 `/permissions` 命令

```
/permissions                                  查看当前策略
/permissions init                             生成保守默认策略文件
/permissions default <auto|confirm|deny>      设置全局默认
/permissions tool <名称> <策略|clear>         逐工具覆盖 / 清除
/permissions allow-path <glob> [read|write|delete]   加入路径白名单
/permissions allow-url <pattern>              加入 URL/域名白名单
```

---

## 三、模块二：记忆主动化引擎

### 3.1 排序 `scoring.rankMemories(query, opts)`

在 memdir 关键词重叠基线上叠加两路信号：

- **时间衰减**：`recencyMultiplier = 0.5 ^ (ageDays / halfLife)`，半衰期 `KHY_MEMORY_HALFLIFE_DAYS`（默认 30 天）。
- **类型过滤**：按 `user|feedback|project|reference` 限定候选集。

综合得分 `= 关键词重叠分 × 时间衰减`，复用 memdir 的 `_tokenizeForRecall` / `_overlapCount`（单一真源，不重复造分词器）。

### 3.2 主动框定与注入

`buildProactiveSystemSection(userMessage)` 在系统提示词装配阶段（`ai.js`）追加一段
`[PROACTIVE_MEMORY]` 上下文：指示模型在确有帮助时，于回应开头**自然主动提及**
（「我记得你之前提到过…」「你偏好…，这次要不要也用同样的方式？」），并按记忆类型给出导语
（用户画像 / 协作偏好 / 项目背景 / 外部资源）。受字符预算约束，与当前请求无关则忽略。

- 杀手开关：`KHY_PROACTIVE_MEMORY=off`（仅关主动框定层）/ `KHY_DISABLE_MEMORY=1`（关全部召回）。
- 旋钮：`KHY_MEMORY_PROACTIVE_LIMIT`（默认 3）、`KHY_MEMORY_PROACTIVE_CHARS`（默认 900）。
- fail-soft：任何异常都不破坏提示词装配。

### 3.3 `/remember --type` 结构化记忆

```
/remember --type <user|feedback|project|reference> --name "标题" [--desc "摘要"] <内容>
```

经 `addStructuredMemory` 写入带 frontmatter 的记忆文件并刷新 `MEMORY.md` 索引。
**文件名采用 `_safeFilename`**：在 ASCII slug 基础上追加名称的 sha1 短哈希，
解决 memdir 默认 slug 对纯中文名折叠为 `<type>_.md` 造成的覆盖冲突。
（无 `--type` 时退化为原 `/remember` 快速追加到 khy.md。）

---

## 三·五、模块三：记忆定期蒸馏器

文件：`services/backend/src/services/memoryEngine/distiller.js`
测试：`services/backend/tests/services/memoryEngine/distiller.test.js`（16 例）

随时间推移，记忆库会沉积**空记忆、近似重复、陈旧**条目，稀释主动召回的信噪比。
蒸馏器透明、可逆地决定「该留什么、该忘什么」。

### 3.5.1 分析 `analyze({nowMs})` —— 纯函数，不改盘

产出计划 `{ keep, forget, merge, stats }`，每条决定附 `reason`：

| reason | 判定 | 旋钮（默认） |
| --- | --- | --- |
| `empty` | 正文短于阈值 | `KHY_MEMORY_MIN_BODY_CHARS`（12） |
| `duplicate` | 同类型 token Jaccard ≥ 阈值，保留价值更高者 | `KHY_MEMORY_DUP_THRESHOLD`（0.82） |
| `stale` | 超过**按类型**保鲜期（user≫feedback≈reference≫project） | `KHY_MEMORY_STALE_DAYS_{USER 3650/FEEDBACK 540/REFERENCE 365/PROJECT 180}` |

价值分（透明用途）= `durability(type) × recency × richness`，用于在近似重复组中挑选幸存者并解释保留决定。
分词复用 memdir `_tokenizeForRecall`（单一真源）。

### 3.5.2 归档式「忘记」（可恢复，绝不硬删）

- `applyPlan(plan)`：把 forget 集**移动**至 `<memoryDir>/.archive/`，写 `manifest.json`
  （记录原名/归档名/reason/detail/类型/时间戳），并从 `MEMORY.md` 索引剔除被归档项。
  `listMemories()` 非递归 ⇒ 归档目录不会被重新扫描。
- `restore({filename?})`：全部或按文件名恢复；目标已存在则**跳过以免覆盖**（防呆）。
- `listArchived()`：读取清单。

### 3.5.3 周期闸门与编排

- `.distill.json` 记录 `lastRunMs`；`intervalElapsed(nowMs)` 按
  `KHY_MEMORY_DISTILL_INTERVAL_DAYS`（默认 7）判定是否到期。
- `distill({apply, nowMs})`：分析 +（可选）归档 + 盖运行戳。
- `maybeDistill({nowMs, force})`：周期入口，**fail-soft**。模式由
  `KHY_MEMORY_DISTILL_AUTO` 控制：`off` 关闭 / `report`（**默认**，仅分析盖戳、不改盘）/
  `archive`（自动归档，仍可恢复）。

### 3.5.4 接入

- `cli/ai.js` 系统提示词装配：在主动记忆块之后调用 `maybeDistill()`（默认 report-only，
  到期才跑一次）；若有可忘记项，追加一行 `[MEMORY_DISTILLATION]` 提示，让助手可**主动、简短地**
  建议用户运行 `/memory distill`（呼应模块二的「主动提及」理念）。fail-soft，绝不破坏装配。
- `cli/router.js` `/memory distill` 子命令：
  ```
  /memory distill                 分析并报告（dry-run，不改动任何记忆）
  /memory distill --apply         归档建议忘记的记忆（可恢复）
  /memory distill archived        列出已归档记忆
  /memory distill restore [文件]  恢复一条（或全部）已归档记忆
  ```

---

## 四、验证

```
$ jest tests/services/permissionPolicy            → 19 passed
$ jest tests/services/memoryEngine/memoryEngine   → 12 passed
$ jest tests/services/memoryEngine/distiller      → 16 passed（模块三）
$ jest tests/services/memoryEngine memdir memory  → 58 passed（含模块二、三）
$ jest commandSchema router                        → cli/router 绿（contextRouter 为既有无关失败）
$ jest tools/ permission syscallGateway toolCalling → 201 passed（零回归）
```

端到端冒烟：`khy permissions init`、`khy remember --type feedback ...` 均按预期落盘，
两条不同中文标题得到两个互不冲突的文件名。

---

## 五、设计红线对齐

- **解耦**：两模块均为独立子系统，主循环仅在单点接入（`requestPermission` / 系统提示词装配）。
- **只增不减保护**：权限层只能 deny / 强制 confirm，绝不放松 `criticalGate`。
- **零硬编码**：所有阈值/开关均 env 可调。
- **状态透明**：`/permissions` 显式呈现当前策略；`[PROACTIVE_MEMORY]` 块明示记忆来源与「可能过时需核对」。
- **失败安全**：策略读失败 fail-closed；记忆失败 fail-soft，绝不阻断主流程。
