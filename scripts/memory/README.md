# 记忆系统管理脚本

本目录包含 khy-os 记忆系统的管理脚本，用于清空、恢复和维护记忆数据。

## 脚本列表

### 1. clear-memory.js - 记忆清空脚本

安全清空记忆系统，所有操作可恢复。

**用法:**

```bash
# 预览模式（dry-run）- 查看将要执行的操作
node scripts/memory/clear-memory.js

# 执行清空
node scripts/memory/clear-memory.js --apply

# 只清理 P0 优先级（核心记忆文件）
node scripts/memory/clear-memory.js --level=p0

# 只清理 P1 优先级（学习缓存和训练数据）
node scripts/memory/clear-memory.js --level=p1

# 只清理 P2 优先级（会话数据）
node scripts/memory/clear-memory.js --level=p2
```

**清理优先级:**

- **P0**: 核心记忆文件（`.khy/memory/*.md`）、成长数据（`.khy/growth/*.json`）
- **P1**: 学习缓存（`.khy/skills/learn-*.md`）、训练数据（`.khy/training/*.jsonl`）
- **P2**: 会话数据（`.khy/sessions/`）、用户画像（`.khy/profile.json`）

**安全特性:**

- 默认为预览模式，不执行实际操作
- 所有删除操作都是归档而非硬删除
- 归档文件可随时恢复

### 2. restore-memory.js - 记忆恢复脚本

从归档中恢复记忆文件。

**用法:**

```bash
# 列出所有可恢复的记忆
node scripts/memory/restore-memory.js

# 恢复指定文件
node scripts/memory/restore-memory.js --file <filename>

# 恢复所有归档记忆
node scripts/memory/restore-memory.js --all

# 恢复指定类型的记忆
node scripts/memory/restore-memory.js --type feedback
```

**恢复来源:**

- 核心记忆归档: `.khy/memory/.archive/`
- 学习缓存归档: `.khy/skills/.archive/`
- 会话数据归档: `.khy/sessions/.archive/`

## npm 脚本命令

在项目根目录可以使用以下 npm 脚本：

```bash
# 记忆清空（预览）
npm run memory:clear

# 记忆清空（执行）
npm run memory:clear:apply

# 只清理 P0 优先级
npm run memory:clear:p0

# 只清理 P1 优先级
npm run memory:clear:p1

# 只清理 P2 优先级
npm run memory:clear:p2

# 列出可恢复的记忆
npm run memory:restore

# 恢复所有归档记忆
npm run memory:restore:all

# 恢复指定文件
npm run memory:restore:file <filename>

# 恢复指定类型的记忆
npm run memory:restore:type <type>
```

## 记忆系统架构

### 存储位置

| 位置 | 用途 | 文件类型 |
|------|------|---------|
| `.khy/memory/` | 核心记忆文件 | `.md`（frontmatter 格式） |
| `.khy/memory/MEMORY.md` | 索引入口 | Markdown |
| `.khy/growth/` | 成长/学习数据 | `.json` |
| `.khy/skills/` | 学习缓存 | `.md` |
| `.khy/training/` | 训练数据 | `.jsonl` |
| `.khy/sessions.db` | 会话数据库 | SQLite |
| `.khyos/` | 侧记忆系统 | `.json` |

### 记忆分类

| 类型 | 说明 | 默认保留层级 | 保鲜天数 |
|------|------|-------------|---------|
| `user` | 用户身份、核心偏好 | permanent | 3650 |
| `feedback` | 反馈偏好、交互风格 | cross_session | 540 |
| `reference` | 外部资源、参考资料 | cross_session | 365 |
| `project` | 项目背景、上下文 | cross_session | 180 |

### 生命周期状态机

```
active → recent → archived → dream → compressed → pruned
                                                    ↓
                                              可恢复到 active
```

## 故障排除

### 常见问题

**Q: 误删了记忆怎么办？**
A: 使用恢复命令：
```bash
# 查看可恢复的记忆
npm run memory:restore

# 恢复所有记忆
npm run memory:restore:all
```

**Q: 如何只清空特定类型的记忆？**
A: 使用类型过滤：
```bash
# 只清空反馈类型的记忆
npm run memory:clear:apply --type feedback
```

**Q: 清空后如何验证系统正常？**
A: 运行健康检查：
```bash
khy memory project
khy memory distill
```

**Q: 如何备份记忆？**
A: 记忆文件位于 `.khy/memory/` 目录，直接备份该目录即可。

## 最佳实践

1. **定期维护**: 每月运行一次蒸馏，清理过期记忆
2. **备份优先**: 清空前确保有完整备份
3. **分批清理**: 按优先级分批清理，避免一次性清空所有
4. **验证恢复**: 清空后测试关键功能是否正常
5. **文档记录**: 记录清空原因和恢复方法

## 相关文档

- [记忆系统标准规范](../../docs/03_DESIGN_设计/[DESIGN-MEM-001]%20记忆系统标准规范.md)
- [记忆蒸馏规则](../../services/backend/src/services/domain/memory/memoryEngine/distiller.js)
- [记忆分层模型](../../services/backend/src/services/memoryTier.js)

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KHY_DISABLE_MEMORY` | off | 全局记忆开关 |
| `KHY_MEMORY_DIR` | - | 自定义记忆目录 |
| `KHY_PROACTIVE_MEMORY` | on | 主动回忆层 |
| `KHY_MEMORY_TIERS` | on | 分层模型 |
| `KHY_MEMORY_TRIGGER` | on | 自动捕获 |
| `KHY_PROACTIVE_CAPTURE` | on | 主动捕获子层 |
| `KHY_MEMORY_STALENESS` | on | 过期判定 |
| `KHY_MEMORY_DISTILL_AUTO` | report | 自动蒸馏模式 |
| `KHY_MEMORY_SESSION_PRIME` | on | 会话启动填充 |
| `KHY_PROJECT_MEMORY` | on | 项目级记忆 |

---

*本脚本由 khy-os 记忆系统设计团队维护*