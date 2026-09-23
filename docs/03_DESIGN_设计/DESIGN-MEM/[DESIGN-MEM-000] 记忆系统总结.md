# [DESIGN-MEM-000] 记忆系统总结

> 本文档总结 khy-os 记忆系统的清理和规范制定工作。

---

## 1. 工作概述

### 1.1 背景

khy-os 记忆系统存在大量垃圾记忆，需要：
1. 清空现有记忆系统
2. 制定标准记忆规范
3. 建立记忆管理机制

### 1.2 目标

- **清理**：安全清空所有记忆数据
- **规范**：制定标准记忆格式和分类
- **管理**：建立记忆生命周期管理机制
- **文档**：提供完整的使用指南

---

## 2. 完成工作

### 2.1 记忆系统分析

**分析内容**：
- 识别了 6 大类存储区域
- 分析了记忆文件格式和结构
- 确认了所有记忆存储位置

**关键发现**：
- 核心记忆：`.khy/memory/` 目录
- 成长数据：`.khy/growth/` 目录
- 学习缓存：`.khy/skills/` 目录
- 训练数据：`.khy/training/` 目录
- 会话数据：`.khy/sessions/` 目录
- 侧记忆：`.khyos/` 目录

### 2.2 记忆清空

**清空操作**：
- 归档核心记忆文件（2 个）
- 重置 MEMORY.md 为模板
- 重置成长数据文件（10 个）
- 归档学习缓存文件（65 个）
- 清空训练数据文件（2 个）
- 清理会话数据文件（20 个）
- 重置 profile.json

**安全特性**：
- 所有删除操作都是归档而非硬删除
- 支持按优先级分层清理
- 提供完整的恢复机制

### 2.3 标准规范制定

**规范文档**：
1. **[DESIGN-MEM-001] 记忆系统标准规范.md**
   - 记忆分类体系
   - 文件格式规范
   - 生命周期管理
   - 清空与恢复流程

2. **[DESIGN-MEM-002] 记忆时机指南.md**
   - 最佳记忆时机
   - 记忆触发机制
   - 记忆类型选择
   - 质量保证机制

3. **[DESIGN-MEM-003] 记忆模板库.md**
   - 用户画像模板
   - 项目背景模板
   - 反馈偏好模板
   - 技术决策模板

4. **[DESIGN-MEM-004] 记忆快速参考卡.md**
   - 记忆时机速查
   - 命令速查
   - 模板速查
   - 常见问题解答

5. **[DESIGN-MEM-005] 记忆系统使用指南.md**
   - 系统初始化
   - 日常使用
   - 记忆管理
   - 故障排除

### 2.4 工具脚本

**脚本文件**：
1. **scripts/memory/clear-memory.js**
   - 安全清空记忆系统
   - 支持预览模式
   - 按优先级分层清理

2. **scripts/memory/restore-memory.js**
   - 从归档中恢复记忆
   - 支持按文件/类型恢复
   - 提供完整恢复机制

3. **scripts/memory/README.md**
   - 脚本使用说明
   - 命令参考
   - 故障排除

**npm 脚本**：
```bash
npm run memory:clear          # 预览清空
npm run memory:clear:apply    # 执行清空
npm run memory:clear:p0       # 清理核心记忆
npm run memory:clear:p1       # 清理学习缓存
npm run memory:clear:p2       # 清理会话数据
npm run memory:restore        # 列出可恢复记忆
npm run memory:restore:all    # 恢复所有记忆
```

---

## 3. 记忆系统架构

### 3.1 分层模型

| 层级 | 名称 | 说明 | 持久化 |
|------|------|------|--------|
| Layer 1 | `short_term` | 会话内记忆 | ❌ 不落盘 |
| Layer 2 | `cross_session` | 跨会话持久记忆 | ✅ 落盘 |
| Layer 3 | `permanent` | 永久记忆 | ✅ 落盘 |

### 3.2 语义类型

| 类型 | 说明 | 保鲜天数 | 典型内容 |
|------|------|---------|----------|
| `user` | 用户身份、核心偏好 | 3650 | 用户姓名、语言偏好 |
| `feedback` | 反馈偏好、交互风格 | 540 | 回复风格、错误处理 |
| `reference` | 外部资源、参考资料 | 365 | API 文档、工具配置 |
| `project` | 项目背景、上下文 | 180 | 架构设计、代码规范 |

### 3.3 生命周期

```
创建 → 活跃 → 老化 → 归档 → 恢复
  ↑                              ↓
  └──────────────────────────────┘
```

---

## 4. 使用指南

### 4.1 快速开始

**步骤 1：查看记忆系统状态**
```bash
khy memory project
```

**步骤 2：创建初始记忆**
```bash
/remember --type user --name "基本 profile" --desc "用户基本信息" 称呼：[你的称呼]
```

**步骤 3：配置记忆系统**
```bash
# 查看环境变量
echo $KHY_DISABLE_MEMORY
echo $KHY_PROACTIVE_MEMORY
```

### 4.2 日常使用

**创建记忆**：
```bash
# 快速记忆
/remember 用户偏好简洁回复

# 结构化记忆
/remember --type feedback --name "回复风格" --desc "用户偏好简洁回复" 用户希望回复简洁
```

**管理记忆**：
```bash
# 查看记忆状态
khy memory project

# 运行记忆蒸馏
khy memory distill --apply

# 清理过期记忆
npm run memory:clear:p2 --apply
```

### 4.3 维护建议

**每月维护**：
1. 运行记忆蒸馏清理过期记忆
2. 检查记忆质量指标
3. 备份重要记忆
4. 更新过时记忆

**每季度维护**：
1. 审查记忆分类体系
2. 更新记忆模板
3. 优化记忆检索算法
4. 清理冗余记忆

---

## 5. 质量保证

### 5.1 记忆质量指标

- **准确性**：记忆内容是否正确
- **时效性**：记忆是否仍然相关
- **完整性**：记忆是否包含足够信息
- **唯一性**：记忆是否与其他记忆重复

### 5.2 质量检查命令

```bash
# 检查记忆系统健康状态
khy memory project

# 运行记忆蒸馏
khy memory distill

# 查看蒸馏报告
khy memory distill --apply
```

### 5.3 质量改进

1. **定期审查**：每月检查记忆质量
2. **及时更新**：发现过时记忆立即更新
3. **避免冗余**：合并相似记忆，删除重复
4. **结构化存储**：使用标准格式，便于检索

---

## 6. 故障排除

### 6.1 常见问题

**问题 1：记忆丢失**
```bash
# 检查归档目录
ls .khy/memory/.archive/

# 恢复记忆
npm run memory:restore:all
```

**问题 2：记忆重复**
```bash
# 运行记忆蒸馏
khy memory distill --apply
```

**问题 3：记忆过期**
```bash
# 检查记忆保鲜期
cat .khy/memory/.distill.json

# 更新过期记忆
/remember --type project --name "项目架构" --desc "更新后的架构" 新的架构内容
```

### 6.2 紧急恢复

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

## 7. 相关文档

### 7.1 规范文档

- [DESIGN-MEM-001] 记忆系统标准规范.md
- [DESIGN-MEM-002] 记忆时机指南.md
- [DESIGN-MEM-003] 记忆模板库.md
- [DESIGN-MEM-004] 记忆快速参考卡.md
- [DESIGN-MEM-005] 记忆系统使用指南.md

### 7.2 工具脚本

- scripts/memory/clear-memory.js
- scripts/memory/restore-memory.js
- scripts/memory/README.md

### 7.3 环境变量

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

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，完成记忆系统清理和规范制定 |

---

## 9. 后续计划

### 9.1 短期计划（1 个月内）

- [ ] 收集用户使用反馈
- [ ] 优化记忆检索算法
- [ ] 完善记忆模板库
- [ ] 添加记忆质量监控

### 9.2 中期计划（3 个月内）

- [ ] 实现智能记忆推荐
- [ ] 添加记忆关联分析
- [ ] 优化记忆存储结构
- [ ] 实现记忆跨设备同步

### 9.3 长期计划（6 个月内）

- [ ] 实现记忆语义搜索
- [ ] 添加记忆可视化
- [ ] 优化记忆生命周期管理
- [ ] 实现记忆自动化管理

---

*本总结由 khy-os 记忆系统设计团队维护*