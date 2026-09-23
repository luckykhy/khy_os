# [DESIGN-IR-001] 事件响应规范

<!-- RULES-REGISTRY: IR-001 -->

> **用途**：定义 khy-os 平台安全事件和运营故障的响应流程、分级标准、Escalation Matrix。
> 当前 SECURITY.md 有模糊的响应 SLA（3 工作日确认、10 工作日评估），但无正式的分级、Escalation、Runbook。

---

## 1. 原则

1. **分级先行**：所有事件首先分类定级，再决定响应速度
2. **单一入口**：事件通过统一通道报告和追踪
3. **自动升级**：超时未响应自动升级到下一级
4. **复盘闭环**：每个 P0/P1 事件必须有 Postmortem
5. **透明度**：用户可见的事件状态更新（适当时机）

---

## 2. 事件分级

### 2.1 严重度等级

| 等级 | 定义 | 响应时间 | 升级时限 | 示例 |
|------|------|----------|----------|------|
| **P0 - 紧急** | 服务完全不可用，或数据泄露 | ≤ 15 分钟 | 30 分钟无人 → 升级 | 生产数据库泄露、AI 网关全量故障 |
| **P1 - 高危** | 核心功能降级，影响大多数用户 | ≤ 1 小时 | 2 小时无人 → 升级 | API 50% 错误率、支付失败 |
| **P2 - 中危** | 非核心功能故障，或局部影响 | ≤ 4 小时 | 8 小时无人 → 升级 | 前端样式异常、非关键服务超时 |
| **P3 - 低危** | 信息性事件，不影响功能 | ≤ 24 小时 | 不升级 | 配置变更记录、非关键告警 |

### 2.2 定级矩阵

| 影响面 | 数据安全 | 定级 |
|--------|----------|------|
| 全量不可用 | 有泄露风险 | P0 |
| 全量不可用 | 无泄露风险 | P1 |
| 部分用户不可用 | 有泄露风险 | P0 |
| 部分用户不可用 | 无泄露风险 | P1 |
| 非核心功能故障 | — | P2 |
| 仅内部影响 | — | P3 |

---

## 3. 事件生命周期

```
Detection（检测）
    ↓
Triage（分流）→ 定级 + 指派
    ↓
Mitigation（缓解）→ 止损优先，不追求完美修复
    ↓
Resolution（修复）→ 根因修复 + 验证
    ↓
Communication（通报）→ 用户通知
    ↓
Postmortem（复盘）→ 5 Whys + Action Items
    ↓
Close（关闭）→ Action Items 跟踪到完成
```

### 3.1 Detection（检测）

| 检测方式 | 来源 | 示例 |
|----------|------|------|
| 自动告警 | MONITOR-001 / OBS-001 | 错误率 > 50% |
| 用户报告 | GitHub Issue / 邮件 | "API 返回 500" |
| 巡检发现 | 人工检查 | 备份失败 |
| 安全扫描 | CodeQL / Dependabot | 高危漏洞 |

### 3.2 Triage（分流）

分流人员必须在 **15 分钟内** 完成以下动作：
1. 确认事件真实性（排除误报）
2. 定级（P0/P1/P2/P3）
3. 指派 Incident Commander（事件指挥官）
4. 建立事件频道（Slack / 钉钉专用频道）

### 3.3 Mitigation（缓解）

**首要目标：止损，不是修复。**
- 回滚最近变更
- 启用降级模式（GW-002 定义的 P0→P1→P2 降级链）
- 限流保护（RL-001）
- 隔离故障节点

### 3.4 Resolution（修复）

修复完成后：
1. 验证修复效果（错误率恢复正常）
2. 确认数据完整性（无残留损坏）
3. 逐步恢复全量流量

### 3.5 Postmortem（复盘）

每个 P0/P1 事件必须在 **5 个工作日内** 完成 Postmortem。

---

## 4. Escalation Matrix（升级矩阵）

### 4.1 On-call 轮值

| 角色 | 职责 | 联系方式 |
|------|------|----------|
| **Incident Commander** | 事件总指挥，做决策 | 轮值手机 / Slack @channel |
| **On-call Engineer** | 第一响应人，执行修复 | 轮值手机 / Slack DM |
| **Domain Expert** | 特定领域专家（AI 网关 / DB / 前端） | 按需唤醒 |
| **Communication Lead** | 用户通报 | 维护者邮箱 |

### 4.2 升级路径

```
P0: On-call → 15min 无响应 → Incident Commander → 30min 无响应 → 维护者（全部）
P1: On-call → 2h 无响应 → Incident Commander → 4h 无响应 → 维护者
P2: On-call → 8h 无响应 → Incident Commander
P3: 不升级
```

### 4.3 升级触发条件

- 超时未响应（按上表时限）
- 当前 On-call 确认无法处理
- 影响面超出预期（P2 → P1 升级）
- 发现数据泄露（任何 → P0 升级）

---

## 5. 事件频道规范

### 5.1 频道命名

```
# incident-p0-<YYYYMMDD>-<简短描述>    ← P0 专用（所有人可见）
# incident-p1-<YYYYMMDD>-<简短描述>    ← P1 专用
```

### 5.2 频道内容

```
[自动] 事件创建模板
├── 事件编号：INC-2026-001
├── 严重度：P0
├── 影响：AI 网关 100% 错误
├── Incident Commander：@xxx
├── 开始时间：2026-09-10 12:00 UTC
├── 时间线（自动追加）
│   ├── 12:00 告警触发
│   ├── 12:05 On-call 确认
│   ├── 12:15 定位根因
│   └── 12:30 修复验证通过
└── 状态：Mitigating → Resolved → Closed
```

---

## 6. 通报模板

### 6.1 内部通报

```markdown
## [事件通报] INC-2026-001

**严重度**：P0
**状态**：Mitigating → Resolved → Closed
**影响时间**：12:00 - 12:45（45 分钟）
**影响范围**：全部用户无法使用 AI 对话

### 时间线
- 12:00 监控告警：AI 网关错误率 > 95%
- 12:05 On-call 确认并接管
- 12:15 定位根因：Ollama 服务 OOM
- 12:20 重启 Ollama 服务
- 12:30 错误率恢复正常
- 12:45 全面验证通过，事件关闭

### 根因
Ollama 服务因模型内存泄漏导致 OOM 崩溃。

### Action Items
- [ ] 增加 Ollama 内存监控告警（P2，负责人：@xxx，截止：2026-09-17）
- [ ] 配置 Ollama 自动重启策略（P2，负责人：@xxx，截止：2026-09-17）
```

### 6.2 用户通报

```markdown
## [服务公告] AI 对话服务短暂中断

**时间**：2026-09-10 12:00 - 12:45（北京时间）
**影响**：AI 对话功能短暂不可用
**状态**：已恢复

我们注意到 AI 对话服务在 12:00-12:45 期间出现短暂中断，
原因是后端模型服务出现异常。问题已于 12:45 完全恢复。

对于造成的不便，我们深表歉意。

如有问题，请联系 support@khyquant.top。
```

---

## 7. Postmortem 模板

```markdown
# Postmortem: INC-2026-001

## 概述
| 字段 | 值 |
|------|-----|
| 事件编号 | INC-2026-001 |
| 严重度 | P0 |
| 发生时间 | 2026-09-10 12:00 UTC |
| 持续时间 | 45 分钟 |
| 影响范围 | 全部用户 |
| 作者 | @xxx |
| 日期 | 2026-09-11 |

## 影响
- 用户无法使用 AI 对话功能
- 预计影响约 1000+ 活跃用户
- 无数据丢失

## 时间线
| 时间 (UTC) | 事件 |
|------------|------|
| 12:00 | 监控告警触发 |
| 12:05 | On-call 确认 |
| ... | ... |

## 根因分析（5 Whys）
1. Why：Ollama 服务崩溃 → 内存耗尽
2. Why：模型加载后内存泄漏 → 未设置内存上限
3. Why：→ 配置缺失
4. Why：→ 部署文档未包含此项
5. Why：→ 部署 Checklist 不完整

## 行动项
| # | 行动项 | 优先级 | 负责人 | 截止日期 | 状态 |
|---|--------|--------|--------|----------|------|
| 1 | 增加 Ollama 内存上限配置 | P1 | @xxx | 2026-09-12 | Open |
| 2 | 更新部署 Checklist | P2 | @xxx | 2026-09-15 | Open |

## 经验教训
- 内存监控应覆盖所有后端服务
- 自动重启策略可减少 MTTR
```

---

## 8. 事件追踪

### 8.1 事件记录

```javascript
{
  incidentId: 'INC-2026-001',
  severity: 'P0',
  title: 'AI 网关全量故障',
  status: 'resolved',           // detected | triaging | mitigating | resolved | closed
  detectionSource: 'monitoring', // monitoring | user_report | inspection | security_scan
  detectedAt: '2026-09-10T12:00:00.000Z',
  resolvedAt: '2026-09-10T12:45:00.000Z',
  commander: 'user-123',
  timeline: [
    { time: '2026-09-10T12:00:00.000Z', event: 'Alert triggered: error_rate > 95%' },
    { time: '2026-09-10T12:05:00.000Z', event: 'On-call acknowledged' },
  ],
  impact: {
    usersAffected: 1000,
    servicesAffected: ['ai-gateway', 'ollama'],
    dataLoss: false
  },
  postmortem: 'https://docs/khy-os/postmortems/INC-2026-001.md',
  actionItems: [
    { id: 'AI-001', description: 'Add Ollama memory alert', status: 'open', assignee: 'user-456' }
  ]
}
```

---

## 9. 关键指标

| 指标 | 目标 | 说明 |
|------|------|------|
| MTTR（平均修复时间） | P0 < 1h / P1 < 4h | 从检测到修复 |
| MTTD（平均检测时间） | < 5 分钟 | 从发生到检测 |
| MTTA（平均确认时间） | P0 < 15min / P1 < 1h | 从告警到人工确认 |
| 事件复盘率 | 100% P0/P1 | 必须完成 Postmortem |
| Action Item 完成率 | > 80% | 复盘行动项按时完成 |

---

## 10. 守卫

| 守卫 | 检查项 | 严重度 |
|------|--------|--------|
| `incident-gate` | P0/P1 事件必须有 Incident Commander | P0 |
| `incident-gate` | P0 事件响应时间 ≤ 15 分钟 | P0 |
| `incident-gate` | P0/P1 事件必须有 Postmortem | P1 |
| `incident-gate` | 安全事件必须记录（不可删除） | P0 |
| `incident-gate` | Postmortem Action Items 必须有截止日期 | P2 |

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义事件响应规范 |

---

*本规范由 khy-os 平台团队维护*
