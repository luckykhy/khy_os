# [DESIGN-MEM-001] 记忆系统标准规范

> 本文档定义 khy-os 记忆系统的标准规范，包括记忆分类、文件格式、生命周期管理、清空与恢复流程。

---

## 1. 记忆分类体系

### 1.1 语义类型（Semantic Types）

| 类型 | 说明 | 默认保留层级 | 保鲜天数 | 典型内容 |
|------|------|-------------|---------|----------|
| `user` | 用户身份、核心偏好 | permanent | 3650 | 用户姓名、语言偏好、工作习惯 |
| `feedback` | 反馈偏好、交互风格 | cross_session | 540 | 回复风格偏好、错误反馈模式 |
| `reference` | 外部资源、参考资料 | cross_session | 365 | 文档链接、API 参考、知识库 |
| `project` | 项目背景、上下文 | cross_session | 180 | 项目架构、技术栈、开发约定 |

### 1.2 保留层级（Retention Tiers）

| 层级 | 名称 | 说明 | 持久化 |
|------|------|------|--------|
| Layer 1 | `short_term` | 会话内记忆，会话结束即遗忘 | ❌ 不落盘 |
| Layer 2 | `cross_session` | 跨会话持久记忆，按保鲜期自然老化 | ✅ 落盘 |
| Layer 3 | `permanent` | 永久记忆，永不自动遗忘 | ✅ 落盘 |

---

## 2. 记忆文件格式规范

### 2.1 文件命名规则

```
<type>_<name>_<hash>.md
```

- `type`: 语义类型（user/feedback/project/reference）
- `name`: 记忆名称（URL-safe，不超过 50 字符）
- `hash`: 8 位 UUID 前缀（防冲突）

**示例**: `feedback_system------_dd1d67bf.md`

### 2.2 文件内容格式

```yaml
---
name: <记忆标题>                    # 必填，唯一标识
description: <一行摘要>              # 必填，用于召回匹配
type: <user|feedback|project|reference>  # 语义类型
tier: <short_term|cross_session|permanent>  # 保留层级
updated: <ISO-8601>                 # 最后更新时间
---

<记忆正文内容>
```

### 2.3 内容质量要求

- **最小长度**: 正文 ≥ 12 字符（`KHY_MEMORY_MIN_BODY_CHARS`）
- **去重阈值**: Jaccard 相似度 ≥ 0.82 视为重复（`KHY_MEMORY_DUP_THRESHOLD`）
- **结构化**: 优先使用列表、表格等结构化格式
- **语言**: 面向用户的字符串使用中文，代码注释使用英文

---

## 3. 记忆生命周期管理

### 3.1 生命周期状态机

```
active → recent → archived → dream → compressed → pruned
                                                    ↓
                                              可恢复到 active
```

### 3.2 三阶段"做梦"记忆巩固

| 阶段 | 触发时机 | 主要任务 | 相似度阈值 |
|------|---------|----------|-----------|
| Light | 每 6 小时 | 快速去重 | 0.9 |
| Deep | 每日凌晨 3 点 | 分析合成，健康评分 | 0.35（低于自动恢复） |
| REM | 每周日凌晨 5 点 | 跨记忆模式提取 | - |

### 3.3 蒸馏规则（Distillation Rules）

1. **空记忆**: 正文 < 12 字符 → 归档
2. **重复**: token Jaccard ≥ 0.82 的近重复 → 归档较弱者
3. **过期**: 超过类型保鲜天数 → 归档（user 类几乎不过期）

---

## 4. 记忆存储位置

### 4.1 核心记忆目录

| 位置 | 用途 | 文件类型 |
|------|------|---------|
| `.khy/memory/` | 核心记忆文件 | `.md`（frontmatter 格式） |
| `.khy/memory/MEMORY.md` | 索引入口 | Markdown |
| `.khy/growth/` | 成长/学习数据 | `.json` |
| `.khy/skills/` | 学习缓存 | `.md` |
| `.khy/training/` | 训练数据 | `.jsonl` |
| `.khy/sessions.db` | 会话数据库 | SQLite |
| `.khyos/` | 侧记忆系统 | `.json` |

### 4.2 环境变量控制

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

## 5. 记忆清空规范

### 5.1 清空原则

- **安全第一**: 所有清空操作必须可恢复
- **归档而非删除**: "忘记" = 归档到 `.archive/` 目录
- **Dry-run 默认**: 不加 `--apply` 仅生成报告
- **分层清理**: 按优先级分层清理，避免误删重要记忆

### 5.2 清空优先级

| 优先级 | 位置 | 操作 | 说明 |
|--------|------|------|------|
| **P0** | `.khy/memory/*.md` | 归档到 `.archive/` | 核心记忆文件 |
| **P0** | `.khy/memory/MEMORY.md` | 重置为模板 | 索引入口 |
| **P0** | `.khy/growth/agent_memory.json` | 重置为初始结构 | 最大记忆体 |
| **P1** | `.khy/growth/*.json`（其余） | 重置为初始值 | 知识/偏好/习惯/技能 |
| **P1** | `.khy/skills/learn-*.md` | 归档 | 学习缓存 |
| **P1** | `.khy/training/*.jsonl` | 清空 | 训练交互记录 |
| **P2** | `.khy/sessions.db` | 可选清理 | 会话数据库 |
| **P2** | `.khy/sessions/` | 清理 replay/trace 文件 | 会话回放数据 |
| **P2** | `.khy/profile.json` | 重置 | 用户画像 |
| **P3** | `.khy/.khyquant_history` | 清空 | 命令历史 |
| **P3** | `.khyos/` 相关文件 | 可选清理 | ilink/taste 数据 |

### 5.3 清空脚本设计

```javascript
// scripts/memory/clear-memory.js
const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.resolve('.khy/memory');
const ARCHIVE_DIR = path.join(MEMORY_DIR, '.archive');
const GROWTH_DIR = path.resolve('.khy/growth');

// 1. 归档核心记忆文件
function archiveMemoryFiles() {
  // 确保归档目录存在
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  
  // 归档所有 .md 文件（除 MEMORY.md）
  const files = fs.readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  
  for (const file of files) {
    const src = path.join(MEMORY_DIR, file);
    const dest = path.join(ARCHIVE_DIR, file);
    fs.renameSync(src, dest);
  }
  
  return files.length;
}

// 2. 重置 MEMORY.md 为模板
function resetMemoryIndex() {
  const template = `# 记忆索引

> 本文件由记忆系统自动维护，记录所有持久化记忆的索引。

## 记忆列表

*暂无记忆*

---
*最后更新: ${new Date().toISOString()}*
`;
  
  fs.writeFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), template);
}

// 3. 重置成长数据
function resetGrowthData() {
  const initialStructures = {
    'agent_memory.json': {
      version: 1,
      sharedContext: {
        currentMarketRegime: 'unknown',
        recentSignals: [],
        crossAgentInsights: [],
        lastUpdated: null,
        responseStyles: []
      }
    },
    'agent_specialization.json': { domains: [], updated: null },
    'analysis_patterns.json': { patterns: [], updated: null },
    'habits.json': { habits: [], updated: null },
    'knowledge.json': { items: [], updated: null },
    'skills_learned.json': { skills: [], updated: null },
    'skill_usage.json': { usage: [], updated: null },
    'strategy_performance.json': { strategies: [], updated: null },
    'user_knowledge_base.json': { items: [], updated: null },
    'user_preferences.json': { preferences: [], updated: null }
  };
  
  for (const [file, structure] of Object.entries(initialStructures)) {
    const filePath = path.join(GROWTH_DIR, file);
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(structure, null, 2));
    }
  }
}

// 主函数
function clearMemory(options = {}) {
  const { dryRun = true, level = 'all' } = options;
  
  console.log(`\n🧹 记忆清空${dryRun ? '预览' : '执行'}\n`);
  
  if (dryRun) {
    console.log('将执行以下操作:');
    console.log('1. 归档 .khy/memory/*.md 文件');
    console.log('2. 重置 MEMORY.md 为模板');
    console.log('3. 重置 .khy/growth/*.json 为初始结构');
    console.log('\n使用 --apply 参数执行实际操作');
    return;
  }
  
  // 执行清空
  const archivedCount = archiveMemoryFiles();
  console.log(`✓ 已归档 ${archivedCount} 个记忆文件`);
  
  resetMemoryIndex();
  console.log('✓ 已重置 MEMORY.md');
  
  resetGrowthData();
  console.log('✓ 已重置成长数据');
  
  console.log('\n✅ 记忆清空完成');
  console.log('恢复命令: /memory distill restore');
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  clearMemory({ dryRun });
}

module.exports = { clearMemory, archiveMemoryFiles, resetMemoryIndex, resetGrowthData };
```

---

## 6. 标准记忆模板

### 6.1 用户画像模板

```yaml
---
name: user-profile-basic
description: 用户基本信息与核心偏好
type: user
tier: permanent
updated: 2026-09-04T00:00:00.000Z
---

## 基本信息
- 称呼: [用户称呼]
- 语言偏好: 简体中文
- 时区: [用户时区]

## 工作习惯
- 活跃时段: [常用时间段]
- 交互风格: [简洁/详细]
- 反馈偏好: [直接/委婉]

## 技术背景
- 主要语言: [编程语言]
- 框架偏好: [技术栈]
- 工具链: [常用工具]
```

### 6.2 项目背景模板

```yaml
---
name: project-context-{project-name}
description: {项目名称} 的技术架构与开发约定
type: project
tier: cross_session
updated: 2026-09-04T00:00:00.000Z
---

## 项目概览
- 名称: {项目名称}
- 类型: [Web/CLI/库/服务]
- 技术栈: [主要技术]

## 架构约定
- 目录结构: [规范链接]
- 命名规范: [约定]
- 测试要求: [覆盖率/框架]

## 开发流程
- 分支策略: [Git Flow/Trunk]
- 代码审查: [要求]
- 部署流程: [CI/CD]
```

### 6.3 反馈偏好模板

```yaml
---
name: feedback-style-{场景}
description: {场景} 下的交互风格偏好
type: feedback
tier: cross_session
updated: 2026-09-04T00:00:00.000Z
---

## 场景
- 触发条件: [具体场景]
- 期望行为: [AI 应该怎么做]

## 偏好设置
- 详细程度: [简洁/详细]
- 格式偏好: [列表/段落/代码]
- 语言风格: [正式/随意]

## 示例
- 好的回复: [示例]
- 不好的回复: [示例]
```

---

## 7. 验证与监控

### 7.1 健康检查命令

```bash
# 检查记忆系统状态
khy memory project

# 查看蒸馏报告
khy memory distill

# 查看已归档记忆
khy memory distill archived

# 恢复误删记忆
khy memory distill restore [filename]
```

### 7.2 监控指标

- **记忆总数**: 各类型记忆文件数量
- **健康评分**: 蒸馏算法计算的记忆质量分数
- **老化率**: 过期记忆占比
- **重复率**: 重复记忆占比

---

## 8. 最佳实践

### 8.1 记忆写入

1. **明确类型**: 根据内容选择正确的语义类型
2. **简洁描述**: description 字段用于召回匹配，应简洁准确
3. **避免重复**: 写入前检查是否已存在相似记忆
4. **定期维护**: 每月运行一次蒸馏，清理过期记忆

### 8.2 记忆清空

1. **备份优先**: 清空前确保有完整备份
2. **分批清理**: 按优先级分批清理，避免一次性清空所有
3. **验证恢复**: 清空后测试关键功能是否正常
4. **文档记录**: 记录清空原因和恢复方法

### 8.3 记忆恢复

1. **精准恢复**: 优先恢复特定文件，而非全部恢复
2. **验证内容**: 恢复后检查记忆内容是否仍然有效
3. **更新时间**: 恢复后更新 `updated` 时间戳

---

## 9. 故障排除

### 9.1 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 记忆丢失 | 误删或蒸馏过度 | 使用 `/memory distill restore` 恢复 |
| 记忆重复 | 自动捕获重复写入 | 运行蒸馏去重 |
| 记忆过期 | 超过保鲜期 | 检查类型设置，调整保鲜天数 |
| 索引损坏 | MEMORY.md 文件损坏 | 重置为模板 |

### 9.2 紧急恢复

```bash
# 1. 停止记忆系统
export KHY_DISABLE_MEMORY=1

# 2. 从备份恢复
cp -r /backup/.khy/memory/* .khy/memory/

# 3. 重建索引
khy memory project

# 4. 重新启用记忆系统
unset KHY_DISABLE_MEMORY
```

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义标准记忆规范 |

---

*本规范由 khy-os 记忆系统设计团队维护*