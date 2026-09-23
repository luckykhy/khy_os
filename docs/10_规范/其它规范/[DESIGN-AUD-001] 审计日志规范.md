# [DESIGN-AUD-001] 审计日志规范

<!-- RULES-REGISTRY: AUD-001 -->

> **用途**：定义 khy-os 项目的审计日志标准，用于安全事件追踪和合规。
> LOG-001 定义了普通日志，本文档定义不可篡改的审计日志。

---

## 1. 原则

1. **不可篡改**：审计日志一旦写入不可修改/删除
2. **完整性**：每条记录包含 Who/When/What/Where/Result
3. **不可旁路**：无论操作成功与否都必须记录
4. **保留期限**：审计日志最少保留 1 年

---

## 2. 审计事件分类

| 类别 | 前缀 | 示例 |
|------|------|------|
| 认证 | `AUTH_` | `AUTH_LOGIN_SUCCESS`、`AUTH_LOGIN_FAILED` |
| 授权 | `PERM_` | `PERM_DENIED`、`PERM_ROLE_CHANGED` |
| 数据 | `DATA_` | `DATA_CREATED`、`DATA_DELETED`、`DATA_EXPORTED` |
| 配置 | `CONFIG_` | `CONFIG_CHANGED`、`FLAG_TOGGLED` |
| 系统 | `SYS_` | `SYS_STARTUP`、`SYS_SHUTDOWN`、`SYS_ERROR` |

---

## 3. 审计日志格式

```json
{
  "auditId": "audit-uuid",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "category": "AUTH",
  "event": "AUTH_LOGIN_SUCCESS",
  "actor": {
    "type": "user",
    "id": "user-123",
    "username": "zhangsan",
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0"
  },
  "target": {
    "type": "resource",
    "id": "strategy-456",
    "name": "Mean Reversion"
  },
  "action": "login",
  "result": "success",
  "changes": null,
  "metadata": {
    "requestId": "req-uuid",
    "traceId": "trace-uuid"
  }
}
```

---

## 4. 五字段

| 字段 | 必选 | 说明 |
|------|------|------|
| `actor` | ✅ | 谁（用户 ID / 系统 / 服务账号） |
| `action` | ✅ | 做了什么（动词） |
| `target` | ✅ | 对什么（资源类型 + ID） |
| `timestamp` | ✅ | 何时（ISO 8601） |
| `result` | ✅ | 结果（success / failure / denied） |

---

## 5. 必须审计的事件

| 事件 | 级别 |
|------|------|
| 登录成功/失败 | INFO |
| 登出 | INFO |
| 密码修改 | INFO |
| 权限变更 | INFO |
| 数据创建/修改/删除 | INFO |
| 数据导出 | INFO |
| 配置变更 | INFO |
| 权限被拒绝 | WARN |
| 多次登录失败 | WARN |
| 批量删除 | WARN |
| 系统启动/关闭 | INFO |

---

## 6. 不可篡改保证

```javascript
// 审计日志使用独立文件，不可写
const auditLogger = winston.createLogger({
  transports: [
    new DailyRotateFile({
      filename: 'logs/audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '365d',    // 保留 1 年
      immutable: true       // 文件只读
    })
  ]
});

// 文件系统级别只读
// chattr +i logs/audit-*.log（Linux）
// icacls 移除写权限（Windows）
```

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义审计日志规范 |

---

*本规范由 khy-os 平台团队维护*
