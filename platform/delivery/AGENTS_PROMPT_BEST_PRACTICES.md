# 给其他 Agent 写 Prompt 的最佳实践

> 这份文档回答了用户的核心问题："怎么给其他 agent 提示词"

---

## 一、Prompt 的黄金结构

所有高质量 Agent Prompt 都遵循以下结构：

```
┌─────────────────────────────────────────────┐
│ 1. 角色 (Role)                               │
│    → 你是谁，做什么，边界是什么               │
├─────────────────────────────────────────────┤
│ 2. 职责 (Responsibilities)                   │
│    → 3-5 条核心职责，用 bullet list           │
├─────────────────────────────────────────────┤
│ 3. 输入格式 (Input Schema)                   │
│    → JSON Schema，明确字段类型和必填/可选      │
├─────────────────────────────────────────────┤
│ 4. 执行流程 (Execution Flow)                 │
│    → 步骤化的流程图或伪代码                   │
├─────────────────────────────────────────────┤
│ 5. 规则 (Rules)                              │
│    → 分优先级：必须遵守 / 优先执行 / 可选      │
├─────────────────────────────────────────────┤
│ 6. 输出格式 (Output Schema)                  │
│    → 固定的 JSON 返回结构                     │
├─────────────────────────────────────────────┤
│ 7. 异常处理 (Error Handling)                 │
│    → 每个可能出错的地方怎么处理               │
├─────────────────────────────────────────────┤
│ 8. 示例 (Examples)                           │
│    → 输入 → 输出的完整示例                     │
└─────────────────────────────────────────────┘
```

---

## 二、7 条核心规则

### 规则 1: 单 Agent 单职责

```
❌ 错误: "你负责 Slack、Email 和 Notion 的投递"
✅ 正确: "你是 Slack 投递 Agent，只负责将内容投递到 Slack 平台"
```

原因：单一职责让 Prompt 更短、更精确、更容易调试。

### 规则 2: 输入必须 Schema 化

```
❌ 错误: "用户会给你一些内容，你要发到某个地方"
✅ 正确:
   Input:
   {
     "channel": "string (必填) — Slack 频道 ID",
     "text": "string (必填) — 消息正文",
     "blocks": "array (可选) — Block Kit JSON"
   }
```

### 规则 3: 输出必须结构化

```
❌ 错误: "返回投递结果"
✅ 正确:
   Output:
   {
     "success": "boolean",
     "platform": "string",
     "message_ts": "string | null",
     "error": "string | null"
   }
```

### 规则 4: 规则要分优先级

用明确的标识词分层：

| 标识词 | 含义 | Agent 行为 |
|---|---|---|
| **必须** / **禁止** / **永远不要** | 违反则整个任务失败 | 严格执行 |
| **优先** / **建议** / **推荐** | 有更好的做法 | 尽量遵守 |
| **可以** / **可选** | 锦上添花 | 视情况 |

### 规则 5: 提供至少一个完整示例

```
输入:  {"channel": "#general", "text": "Hello"}
输出:  {
  "success": true,
  "platform": "slack",
  "message_ts": "1234567890.123456",
  "url": "https://..."
}
```

### 规则 6: 异常处理要枚举

列出每个可能的错误：

```
- channel_not_found: 频道不存在 → 返回 error 字段，不重试
- permission_denied: 权限不足 → 返回 error 字段，标记需要人工介入
- rate_limited: 触发限流 → 指数退避重试（最多 3 次）
- message_too_long: 消息过长 → 自动分段后重发
```

### 规则 7: Prompt 要可组合

将 Prompt 拆分为：
- **基础 Prompt** (role + responsibilities + input/output schema) — 不变
- **平台特定规则** (rules + error handling) — 按平台替换
- **示例** — 按场景替换

---

## 三、通用模板

```markdown
# {{agent_name}} Prompt

## 角色
你是 {{agent_name}}，负责 {{responsibility}}。

## 职责
- {{responsibility_1}}
- {{responsibility_2}}
- {{responsibility_3}}

## 输入格式
```json
{
  "{{field_1}}": "类型 (必填/可选) — 描述",
  "{{field_2}}": "类型 (必填/可选) — 描述"
}
```

## 执行流程
1. {{step_1}}
2. {{step_2}}
3. {{step_3}}

## 规则
### 必须遵守
- {{rule_1}}
- {{rule_2}}

### 优先执行
- {{rule_3}}

### 可选
- {{rule_4}}

## 输出格式
```json
{
  "success": "boolean",
  "{{platform}}_specific_field": "值",
  "error": "string | null"
}
```

## 异常处理
| 错误 | 处理 |
|---|---|
| {{error_1}} | {{action_1}} |
| {{error_2}} | {{action_2}} |

## 示例
输入: {{example_input}}
输出: {{example_output}}
```

---

## 四、Prompt 模板存储方案

### 方案 A: 文件系统（推荐用于团队协作）

```
platform/delivery/adapters/prompts/
├── slack.prompt.md
├── notion.prompt.md
├── markdown.prompt.md
├── webhook.prompt.md
├── email.prompt.md
└── api.prompt.md
```

优点：
- 版本控制友好（git diff 清晰）
- 非技术人员可编辑
- 支持文件模板语法

### 方案 B: 数据库（推荐用于运行时动态）

```sql
CREATE TABLE prompt_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  version     INTEGER DEFAULT 1,
  variables   TEXT,           -- JSON: {"key": "default_value"}
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

优点：
- 热更新无需重启
- 支持版本管理
- 支持 A/B 测试不同 Prompt 版本

### 方案 C: 混合方案（本项目采用）

```
文件系统（源码） ←→ 内存缓存 ←→ 运行时动态注册
     ↓                    ↓              ↓
  git 管理             5min TTL         API 热更新
```

实现见 `templates/templateRegistry.js`：
- 优先读内存缓存
- 缓存未命中读文件系统
- 文件系统未命中读内置 fallback
- 支持变量插值 `{{var}}`

---

## 五、给 Orchestrator 写 Prompt 的特殊要点

Orchestrator 是系统的"大脑"，Prompt 需要特别关注：

1. **明确它是决策者，不是执行者**
   - Orchestrator 选择适配器，但不自己投递
   - Orchestrator 调用 DiffEngine，但不自己做一致性检查

2. **决策树要清晰**
   - 什么情况继续？什么情况重试？什么情况中止？
   - 每个决策点要有明确的触发条件

3. **并发安全**
   - Orchestrator 应该处理多个任务同时投递
   - 在 Prompt 中说明并发策略

4. **可观测性**
   - 每一步都要记录日志
   - 返回完整的执行链路

---

## 六、常见陷阱与避坑

| 陷阱 | 表现 | 解决方案 |
|---|---|---|
| Prompt 太长 | Agent 忽略中间规则 | 拆分为子 Prompt，用 include 组合 |
| 规则冲突 | Agent 行为不一致 | 明确优先级，冲突时高优先级覆盖 |
| 输出格式不固定 | 下游解析失败 | 强制 JSON schema + 示例 |
| 平台差异未处理 | 同一内容不同平台结果不同 | 在 DiffEngine 中校验 |
| 超时无处理 | 请求挂起 | 每个步骤加 timeout |
| 重试风暴 | 大量重试导致限流 | 指数退避 + 最大重试次数 |

---

## 七、Prompt 评审清单

在将 Prompt 交给 Agent 之前，问自己：

- [ ] 角色是否清晰唯一？
- [ ] 输入字段是否都有类型和必填/可选标注？
- [ ] 输出格式是否固定为 JSON schema？
- [ ] 是否有至少一个输入→输出示例？
- [ ] 每个错误码都有处理策略？
- [ ] 规则是否分优先级（必须/优先/可选）？
- [ ] 是否避免了模糊词汇（"一些"、"大概"、"有时候"）？
- [ ] 是否包含了超时和重试策略？
- [ ] 是否说明了并发行为？
- [ ] 是否说明了日志要求？

---

## 八、快速参考：Agent Prompt 检查清单

```
[ ] 角色: "你是 XXX，负责 YYY"
[ ] 职责: 3-5 条 bullet list
[ ] 输入: JSON Schema with types + required/optional
[ ] 流程: 步骤化 (Step 1 → Step 2 → Step 3)
[ ] 规则: 分 必须/优先/可选 三层
[ ] 输出: 固定 JSON schema
[ ] 错误: 每个错误码有处理策略
[ ] 示例: 至少 1 个完整 input→output
[ ] 安全: 敏感信息处理规则
[ ] 超时: 每步超时时间
```
