# 前端代码清理工具

本目录包含 khy-os 前端代码的清理和规范化工具。

## 工具列表

### 1. cleanup-console.js - Console 清理工具

清理前端代码中的 `console.log/warn/error/info/debug` 语句。

**用法:**

```bash
# 预览模式（dry-run）- 查看将要执行的操作
node scripts/frontend/cleanup-console.js

# 执行清理（包装在 DEV 检查中）
node scripts/frontend/cleanup-console.js --apply

# 完全移除 console 语句
node scripts/frontend/cleanup-console.js --remove

# 处理单个文件
node scripts/frontend/cleanup-console.js --file path/to/file.js
```

**清理策略:**

- **包装模式（默认）**: 将 console 语句包装在 `import.meta.env.DEV` 检查中
  ```javascript
  // 原代码
  console.log('debug info');
  
  // 清理后
  if (import.meta.env.DEV) { console.log('debug info'); }
  ```

- **移除模式**: 完全删除 console 语句
  ```javascript
  // 原代码
  console.log('debug info');
  
  // 清理后
  // （行被删除）
  ```

**保留规则:**

以下 console 语句不会被处理:
- `console.error` - 错误日志通常需要保留
- `console.warn` - 警告日志通常需要保留
- 包含 `// keep` 注释的语句
- 包含 `// @console-keep` 注释的语句
- 已经被 `import.meta.env.DEV` 或 `process.env.NODE_ENV` 保护的语句

**npm 脚本:**

```bash
# 预览清理
npm run frontend:cleanup-console

# 执行清理
npm run frontend:cleanup-console:apply

# 完全移除
npm run frontend:cleanup-console:remove
```

## 处理范围

默认处理以下目录:
- `software/khyquant/frontend/src`
- `apps/ai-frontend/src`
- `apps/khy-mobile/src`

处理文件类型:
- `.js` - JavaScript 文件
- `.vue` - Vue 单文件组件
- `.ts` - TypeScript 文件

排除目录:
- `node_modules`
- `dist`
- `.git`
- `__tests__`
- `tests`

## 最佳实践

### 1. 开发环境日志

在开发环境中，可以使用 console 输出调试信息:

```javascript
if (import.meta.env.DEV) {
  console.log('调试信息:', data);
}
```

### 2. 生产环境日志

在生产环境中，应该使用专业的日志服务:

```javascript
// 使用 Sentry、LogRocket 等服务
import * as Sentry from '@sentry/vue';

try {
  // 业务逻辑
} catch (error) {
  Sentry.captureException(error);
}
```

### 3. 保留重要日志

对于需要保留的日志，使用注释标记:

```javascript
// @console-keep - 这是重要的业务日志
console.log('用户登录成功:', userId);
```

## 注意事项

1. **备份代码**: 在执行清理前，建议先提交当前代码到版本控制
2. **预览模式**: 先使用预览模式查看变更，确认无误后再执行
3. **测试验证**: 清理后运行测试，确保功能正常
4. **代码审查**: 清理后的代码应该进行代码审查

## 相关规范

- [前端页面规范](../../docs/03_DESIGN_设计/[DESIGN-FE-001]%20前端页面规范.md)
- [前端组件库规范](../../docs/03_DESIGN_设计/[DESIGN-FE-002]%20前端组件库规范.md)
- [前端快速参考卡](../../docs/03_DESIGN_设计/[DESIGN-FE-003]%20前端快速参考卡.md)

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，提供 console 清理工具 |
| 1.1.0 | 2026-09-04 | 新增 var 声明修复工具 |

---

*本工具由 khy-os 前端团队维护*