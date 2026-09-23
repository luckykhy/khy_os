# [DESIGN-FF-001] Feature Flag 功能开关规范

<!-- RULES-REGISTRY: FF-001 -->

> **用途**：定义 khy-os 项目的功能开关（Feature Flag）标准，实现安全、可回滚、可审计的功能灰度发布。
> 当前无统一 Feature Flag 机制。

---

## 1. 原则

1. **默认关闭**：新功能默认 `false`，渐进开启
2. **可回滚**：关闭开关立即生效，无需回滚代码
3. **可审计**：开关变更有日志、有时间、有操作人
4. **自动清理**：功能稳定后及时移除开关（最长 3 个月）

---

## 2. 开关分级

| 级别 | 范围 | 说明 |
|------|------|------|
| `global` | 全量用户 | 功能完全启用/关闭 |
| `percentage` | 百分比 | 按用户哈希灰度（10% → 50% → 100%） |
| `whitelist` | 白名单 | 指定用户/角色可见 |
| `cohort` | 分群 | 按属性分组（注册日期、地域等） |

---

## 3. 开关命名

```
{domain}.{feature}.{variant}
```

| 示例 | 说明 |
|------|------|
| `ai.streaming.enabled` | AI 流式对话开关 |
| `frontend.newLayout` | 前端新布局 |
| `gateway.circuitBreaker` | 网关熔断器 |

---

## 4. 生命周期

```
创建（off）→ 灰度（gradual）→ 全量（on）→ 移除（delete）
```

| 阶段 | 时长 | 要求 |
|------|------|------|
| 创建 | — | 默认 off，必须有移除计划 |
| 灰度 | 7–14 天 | 从 10% → 50% → 100% |
| 全量 | 7 天 | on 状态稳定运行 |
| 移除 | — | 代码清理，开关删除 |

**最长存活 3 个月**，过期自动升级为 FIXME。

---

## 5. 实现

### 5.1 配置存储

```javascript
// config/featureFlags.js
const flags = {
  'ai.streaming.enabled': {
    enabled: true,
    rollout: { type: 'percentage', value: 100 },
    createdAt: '2026-09-10',
    expiresAt: '2026-12-10',
    owner: 'gateway-team'
  }
};

function isEnabled(flagName, userId) {
  const flag = flags[flagName];
  if (!flag || !flag.enabled) return false;
  
  switch (flag.rollout.type) {
    case 'global':
      return true;
    case 'percentage':
      return hashUserId(userId) % 100 < flag.rollout.value;
    case 'whitelist':
      return flag.rollout.users.includes(userId);
    case 'cohort':
      return checkCohort(userId, flag.rollout.cohorts);
  }
}
```

### 5.2 使用

```javascript
if (isEnabled('ai.streaming.enabled', req.user.id)) {
  return streamResponse(req, res);
}
return returnJsonResponse(req, res);
```

---

## 6. 审计

```javascript
// 每次开关变更记录
function setFlag(name, value, actor) {
  logger.info('Feature flag changed', {
    flag: name,
    oldValue: flags[name]?.enabled,
    newValue: value,
    actor,
    timestamp: new Date().toISOString()
  });
  
  flags[name].enabled = value;
}
```

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Feature Flag 规范 |

---

*本规范由 khy-os 平台团队维护*
