# 设计模式速查卡

> 开发者日常速查表 — 场景 → 做法 → 文件位置

---

## "我要加新功能"

### 做法
1. 写纯叶子函数(零 IO、确定性、绝不抛)
2. 在 `flagRegistry.js` 注册 `KHY_XXX` flag
3. 用 `if (isFlagEnabled('KHY_XXX'))` 包裹新功能
4. 确保门关时字节回退到改动前

### 模板
```javascript
// 纯叶子
function myNewFeature(input) {
  // 只读入参,只返回结果,不碰 fs/网络/子进程
  return { ok: true, data: transform(input) };
}

// 门控
if (flagRegistry.isFlagEnabled('KHY_MY_FEATURE', process.env)) {
  result = myNewFeature(input);
}
```

### 文件
- 叶子: `services/backend/src/services/yourModule.js`
- 注册: `services/backend/src/services/flagRegistry.js`
- 检查: `npm run check:leaf-contract`

---

## "我要调外部 API"

### 做法
1. 用 `withSelfHealing(fn, { maxRetries: 1 })` 包装瞬时重试
2. 用 `retryWithBackoff` 处理需要退避的场景
3. 用断路器隔离故障服务
4. 准备 fallback(降级方案)

### 模板
```javascript
const { withSelfHealing } = require('./gateway/selfHealingWrapper');
const { retryWithBackoff } = require('./retryWithBackoff');

// 瞬时重试一次
const resilientCall = withSelfHealing(apiCall, { maxRetries: 1 });

// 带退避的重试
const result = await retryWithBackoff(apiCall, {
  maxAttempts: 3,
  onRetry: (err, attempt) => log.warn(`Retry ${attempt}: ${err.message}`),
});
```

### 文件
- 自愈: `services/backend/src/services/gateway/selfHealingWrapper.js`
- 退避: `services/backend/src/services/retryWithBackoff.js`
- 断路器: `services/backend/src/services/circuitBreaker.js`

---

## "我要处理错误"

### 做法
1. 判断: 瞬时 → 重试 | 永久 → 诚实报错
2. 返回标准错误契约 `{ ok: false, error: { code, type, message, retryable } }`
3. 用户看到可行动的诊断,不是堆栈

### 决策树
```
错误发生
  ↓
瞬时? ─── 是 → 重试(有界) → 成功 → 用户无感知
  ↓                              → 失败 → 降级/诚实报错
  否
  ↓
诚实报错 + 具体诊断 + 继续提示
```

### 模板
```javascript
const { createErrorResult } = require('./gateway/errorContract');

// 瞬时错误(可重试)
return createErrorResult('parse_error', '响应解析异常', { retryable: true });

// 永久错误(诚实报错)
return createErrorResult('permission_denied', '需要管理员权限,请联系管理员开通', { retryable: false });
```

### 文件
- 错误契约: `services/backend/src/services/gateway/errorContract.js`
- 错误分类: `services/backend/src/services/errorClassifier.js`
- 兜底守卫: `services/backend/src/services/chatErrorGuard.js`

---

## "我要加配置项"

### 做法
1. 命名: `KHY_XXX_YYY`(全大写下划线)
2. 在 `flagRegistry.js` 注册
3. 默认开(新功能)或默认关(高风险功能)
4. 使用 `isFlagEnabled` 检查

### 注册示例
```javascript
// flagRegistry.js
FLAGS: {
  KHY_MY_NEW_FEATURE: {
    mode: 'default-on',   // 默认开; 'opt-in' = 默认关
    off: 'CANON',         // 关闭词: '0', 'false', 'off', 'no'
    default: true,
    parent: 'KHY_PARENT', // 可选: 父门关则子门强制关
  },
}
```

### 使用示例
```javascript
const { isFlagEnabled } = require('./flagRegistry');
if (isFlagEnabled('KHY_MY_NEW_FEATURE', process.env)) {
  // 新功能
}
```

### 文件
- 注册: `services/backend/src/services/flagRegistry.js`
- 类型: `mode: 'default-on' | 'opt-in' | 'numeric'`

---

## "我要处理流式数据"

### 做法
1. 用 `_safeOnChunk` 包装所有消费者回调
2. 用 `safeJsonParse` 解析流式 JSON(支持修复)
3. 消费者异常不能杀死流

### 模板
```javascript
// 流处理器内
const _safeOnChunk = (chunk) => {
  try {
    if (typeof onChunk === 'function') onChunk(chunk);
  } catch { /* consumer error — swallow */ }
};

// 所有调用改用安全版本
_safeOnChunk({ type: 'text', text: delta.text });
```

### 文件
- 自愈包装: 已内嵌到 `_streamProcessor.js`, `cliToolAdapter.js`, `_anthropicSseStream.js`, `_openaiSseStream.js`
- JSON 修复: `services/backend/src/services/gateway/safeJsonParse.js`

---

## "我要写工具/命令"

### 做法
1. 工具执行结果必须包含 `success: true/false`
2. 瞬时失败自动重试(只读工具)
3. 永久失败诚实报告给模型

### 模板
```javascript
// 工具返回
return {
  success: true,
  data: result,
};

// 或失败
return {
  success: false,
  error: {
    code: 'TIMEOUT',
    message: '执行超时(30s),请简化任务或增加超时',
    retryable: true,
  },
};
```

### 文件
- 工具注册: `services/backend/src/tools/index.js`
- 失败恢复: `services/backend/src/services/toolFailureRecovery.js`

---

## 常用命令速查

```bash
# 结构检查(层级 + 语法 + 构建产物)
npm run check:structure

# 叶子契约检查
node scripts/ci/check-leaf-contract.js --changed

# 变更安全检查
node scripts/ci/check-change-safety.js --changed

# 单文件语法检查
node --check path/to/file.js

# 跑单个测试
node --test "scripts/tests/**/*.test.js"
```

---

## 设计哲学速查

| 哲学 | 一句话 | 核心文件 |
|------|--------|----------|
| 防御纵深 | 不依赖单一防护点 | chatErrorGuard.js |
| 纯叶子 | 零 IO + 确定性 + 绝不抛 | check-leaf-contract.js |
| 自愈优先 | 瞬时自愈,永久诚实 | selfHealingWrapper.js |
| 适配器网关 | 可替换 + 断路器 | aiGateway.js |
| 显式层级 | L0-L6 单向依赖 | DESIGN-ARCH-068 |
| 错误归一 | 统一形状 + 诚实措辞 | errorContract.js |
| 配置门控 | 门关即字节回退 | flagRegistry.js |
