# 命令注册表迁移指南

> 对抗式综合方案 C 的实施文档

## 背景

`router.js` 包含 119+ 个 case 分支（3351 行），每次新增命令都需修改此文件，合并冲突概率极高。

## 目标

- 通过注册表元数据驱动命令查找
- 新增命令只需添加注册表条目 + handler 文件，无需修改 router.js
- 渐进迁移，不一次性重写所有 handler

## 架构

```
commands/
  registry.js          # 注册表模块（JS，提供 API）
  registry.json        # 注册表元数据（JSON，单一真源/文档）
  handlers/            # 每个命令的独立 handler
    system/
      version.js
      help.js
      clear.js
      exit.js
      menu.js
    ai/
      aiChat.js
    ops/
      doctor.js
      storage.js
      restore.js
      migrate.js
    dev/
      test.js
      testCoverage.js
      lint.js
      docs.js
    ...
```

## 新增命令步骤

1. 在 `commands/registry.json` 的 `commands` 中添加条目：
```json
"mycommand": {
  "description": "我的新命令",
  "category": "ops",
  "handler": "ops/mycommand",
  "lazy": true
}
```

2. 创建 handler 文件 `commands/ops/mycommand.js`：
```javascript
module.exports = async function handleMycommand(parsed, ctx) {
  // 实现命令逻辑
  return true;
};
```

3. 在 `commands/registry.js` 的 `COMMAND_REGISTRY` 中添加对应条目。

4. 无需修改 `router.js`！

## 渐进迁移策略

### 阶段 1（当前）：注册表就绪，router.js 保持不变
- 注册表模块已创建
- router.js 仍然使用 switch，但可通过注册表查询元数据
- 新命令通过注册表添加

### 阶段 2（后续 PR）：高频命令迁移
- 迁移 Top 20 高频命令到独立 handler
- 每个 handler 可独立测试
- router.js 中的 case 逐渐减少

### 阶段 3（长期）：switch → 注册表查找
- 当 80%+ 命令有独立 handler 后
- 重构 router.js 的 switch 为注册表查找
- 删除冗余 case

## 当前状态

- [x] 注册表模块创建（registry.js）
- [x] 元数据文件创建（registry.json）
- [x] handler 目录结构创建
- [ ] 高频命令 handler 实现（待后续 PR）
- [ ] router.js 重构（待阶段 3）

## 注意事项

- 保持向后兼容：现有命令行为不变
- 渐进迁移：每个命令独立迁移，随时可回滚
- 测试覆盖：每个 handler 应有独立测试
