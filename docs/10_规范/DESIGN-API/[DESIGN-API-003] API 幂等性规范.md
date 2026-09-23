# [DESIGN-API-003] API 幂等性规范

> **用途**：定义 khy-os API 幂等性标准，确保重复请求不产生重复副作用。
> 当前 `largeTasks.js` 和 `remoteSsh.js` 已有幂等性实现，但缺少统一规范。

---

## 1. 原则

1. **副作用操作必须幂等**：创建/更新/删除等有副作用的 API 必须支持幂等性
2. **安全操作天然幂等**：GET/HEAD/OPTIONS 无需额外处理
3. **客户端驱动**：幂等性由客户端通过 `Idempotency-Key` 头控制
4. **服务端保障**：服务端检测重复请求，返回缓存结果而非重新执行

---

## 2. 幂等性标识

### 2.1 Idempotency-Key

```
Idempotency-Key: <uuid>
```

| 属性 | 要求 |
|------|------|
| 格式 | UUID v4（`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`） |
| 长度 | 36 字符 |
| 生成 | 客户端生成，调用前预生成 |
| 有效期 | 24 小时（创建时起算） |
| 作用域 | 幂等性作用域由服务端定义，默认按 endpoint + method 隔离 |

**生成示例**：
```javascript
import { randomUUID } from 'crypto';
const idempotencyKey = randomUUID(); // '550e8400-e29b-41d4-a716-446655440000'
```

---

## 3. 适用端点

### 3.1 必须幂等的端点

| HTTP 方法 | 资源 | 幂等性要求 |
|-----------|------|----------|
| POST | `/api/v1/large-tasks` | 必须有 `Idempotency-Key` |
| POST | `/api/v1/remote-ssh/execute` | 必须有 `Idempotency-Key` |
| POST | `/api/v1/payments` | 必须有 `Idempotency-Key` |
| POST | `/api/v1/orders` | 必须有 `Idempotency-Key` |
| PUT | `/api/v1/resources/:id` | 建议有 `Idempotency-Key` |
| DELETE | `/api/v1/resources/:id` | 建议有 `Idempotency-Key` |

### 3.2 天然幂等的端点

| HTTP 方法 | 说明 |
|-----------|------|
| GET | 读取资源，无副作用 |
| HEAD | 同 GET，无响应体 |
| OPTIONS | CORS 预检，无副作用 |
| PUT (全量替换) | 同一请求重复执行结果一致 |

---

## 4. 幂等性存储

### 4.1 记录结构

```javascript
{
  scope: 'large_task',           // 幂等性作用域
  idempotency_key: 'uuid',       // 客户端提供的幂等键
  intent_hash: 'sha256',         // 请求意图哈希（可选，用于冲突检测）
  status: 'in_progress',         // in_progress | succeeded | failed | expired
  result_json: null,             // 成功时的响应结果
  error_message: null,           // 失败时的错误信息
  created_at: '2026-09-10T12:00:00.000Z',
  updated_at: '2026-09-10T12:00:00.000Z',
  expiry_at: '2026-09-11T12:00:00.000Z'  // 24h 后过期
}
```

### 4.2 作用域（Scope）

| 作用域 | 说明 | 示例 |
|--------|------|------|
| `large_task` | 大型任务创建 | `POST /api/v1/large-tasks` |
| `remote_exec` | 远程命令执行 | `POST /api/v1/remote-ssh/execute` |
| `payment` | 支付操作 | `POST /api/v1/payments` |
| `order` | 订单操作 | `POST /api/v1/orders` |

**规则**：同一作用域内，相同的 `idempotency_key` 只能有一个活跃请求。

---

## 5. 处理流程

```
客户端请求
    ↓
生成 Idempotency-Key（UUID v4）
    ↓
发送请求（带 Idempotency-Key 头）
    ↓
服务端检查幂等性记录
    ├─ 存在 + succeeded → 返回缓存结果（200 + replay: true）
    ├─ 存在 + in_progress → 返回 409（idempotency_in_progress）
    ├─ 存在 + failed → 返回缓存错误（或允许重试）
    └─ 不存在 → 创建记录（in_progress）→ 执行业务逻辑
                              ↓
                       成功 → 更新为 succeeded + 缓存结果
                       失败 → 更新为 failed + 缓存错误
```

### 5.1 请求处理

```javascript
async function handleIdempotentRequest(req, res, businessLogic) {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    // 对于必须幂等的端点，返回 400
    if (requiresIdempotency(req.path, req.method)) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT',
        '幂等操作需要提供 Idempotency-Key 请求头', { status: 400 });
    }
    return businessLogic(req, res); // 非必须幂等的端点直接执行
  }

  const scope = getScope(req.path, req.method);
  const record = await idempotencyStore.get(scope, idempotencyKey);

  if (record) {
    if (record.status === 'succeeded') {
      // 重放缓存结果
      return res.status(200).json({
        ...record.result_json,
        _meta: { replayed: true, original_request_at: record.created_at }
      });
    }
    if (record.status === 'in_progress') {
      // 检查是否过期（stale takeover）
      const ageMs = Date.now() - Date.parse(record.updated_at);
      if (ageMs > IN_PROGRESS_TTL_MS) {
        console.warn(`[idempotency] stale takeover: scope=${scope} key=${idempotencyKey} age=${ageMs}ms`);
        // 允许接管，继续执行
      } else {
        return apiResponse.fail(res, 'CONFLICT',
          '相同 Idempotency-Key 的请求正在处理中', { status: 409 });
      }
    }
    if (record.status === 'failed') {
      // 返回缓存错误（允许客户端重试）
      return res.status(record.error_status || 500).json(record.result_json);
    }
  }

  // 创建幂等性记录
  await idempotencyStore.create({
    scope,
    idempotency_key: idempotencyKey,
    intent_hash: req.headers['intent-hash'] || null,
    status: 'in_progress',
  });

  try {
    const result = await businessLogic(req, res);
    await idempotencyStore.update(scope, idempotencyKey, {
      status: 'succeeded',
      result_json: result,
    });
    return result;
  } catch (err) {
    await idempotencyStore.update(scope, idempotencyKey, {
      status: 'failed',
      result_json: { error: err.message },
      error_status: err.statusCode || 500,
    });
    throw err;
  }
}
```

---

## 6. Intent Hash（意图哈希）

### 6.1 用途

`Intent-Hash` 用于检测同一幂等键下的不同意图（防止请求篡改）。

```
Intent-Hash: sha256=<base64-encoded-hash>
```

### 6.2 生成规则

```javascript
// 对请求体进行确定性排序后计算哈希
function computeIntentHash(body) {
  const canonical = JSON.stringify(sortKeysDeep(body));
  return crypto.createHash('sha256').update(canonical).digest('base64');
}
```

### 6.3 冲突检测

| 场景 | 处理 |
|------|------|
| 相同 key + 相同 intent_hash | 返回缓存结果 |
| 相同 key + 不同 intent_hash | 返回 409（`idempotency_conflict`） |
| 相同 key + 无 intent_hash | 允许执行（不检测冲突） |

---

## 7. 过期与清理

### 7.1 TTL 规则

| 状态 | TTL | 说明 |
|------|-----|------|
| `in_progress` | 15 分钟 | 超过 TTL 视为 stale，允许接管 |
| `succeeded` | 24 小时 | 缓存结果有效期 |
| `failed` | 1 小时 | 缓存错误有效期，之后允许重试 |

### 7.2 清理策略

```javascript
// 定期清理过期记录（每小时）
async function cleanupExpiredRecords() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000); // 24h 前
  await idempotencyStore.deleteOlderThan(cutoff);
}
```

---

## 8. 响应格式

### 8.1 幂等重放

```json
{
  "success": true,
  "data": { "id": 123, "status": "pending" },
  "_meta": {
    "replayed": true,
    "original_request_at": "2026-09-10T12:00:00.000Z"
  }
}
```

### 8.2 冲突响应

```json
{
  "success": false,
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "type": "CLIENT_ERROR",
    "message": "Idempotency-Key 与历史请求意图不一致"
  }
}
```

### 8.3 响应头

```http
Idempotency-Key: uuid           # 回显客户端提供的键（用于调试）
Idempotency-Replayed: true      # 当结果为重放时出现
Idempotency-Expires: 86400      # 记录过期时间（秒）
```

---

## 9. 客户端指南

### 9.1 最佳实践

| 规则 | 说明 |
|------|------|
| 提前生成 | 发送请求前生成 UUID，不依赖服务端响应 |
| 请求间唯一 | 每个新操作使用新的 UUID |
| 重试时复用 | 网络超时重试时使用相同的 UUID |
| 不要猜测 | 不要通过重试猜测服务端是否收到 |

### 9.2 重试策略

```javascript
async function idempotentRequest(url, options, maxRetries = 3) {
  const idempotencyKey = crypto.randomUUID();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Idempotency-Key': idempotencyKey,
        },
      });

      if (response.ok) return response;

      // 409 冲突不重试（需人工处理）
      if (response.status === 409) throw new Error('Idempotency conflict');

      // 429 限流按 retryAfter 重试
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        await sleep(parseInt(retryAfter) * 1000);
        continue;
      }

      // 5xx 可重试
      if (response.status >= 500) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      return response;
    } catch (err) {
      if (err.message === 'Idempotency conflict') throw err;
      if (attempt === maxRetries - 1) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
}
```

---

## 10. 守卫

| 守卫 | 检查项 | 严重度 |
|------|--------|--------|
| `idempotency-gate` | POST 副作用端点必须验证 `Idempotency-Key` | P0 |
| `idempotency-gate` | 幂等键格式必须为 UUID v4 | P1 |
| `idempotency-gate` | 相同 key 重复请求必须返回相同结果 | P1 |
| `idempotency-gate` | intent_hash 冲突必须返回 409 | P0 |

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 API 幂等性规范 |

---

*本规范由 khy-os 平台团队维护*
