# [DESIGN-MEM-005] 记忆系统使用指南

> 本指南提供 khy-os 记忆系统的完整使用方法，包括初始化、日常使用、维护和故障排除。

---

## 1. 系统初始化

### 1.1 首次使用

**步骤 1：了解记忆系统**
```bash
# 查看记忆系统状态
khy memory project

# 查看记忆蒸馏报告
khy memory distill
```

**步骤 2：创建初始记忆**
```bash
# 创建用户画像
/remember --type user --name "基本 profile" --desc "用户基本信息" 称呼：[你的称呼]，语言偏好：简体中文

# 创建项目记忆
/remember --type project --name "项目架构" --desc "项目技术架构" 使用的技术栈和架构约定
```

**步骤 3：配置记忆系统**
```bash
# 查看环境变量配置
echo $KHY_DISABLE_MEMORY
echo $KHY_PROACTIVE_MEMORY
echo $KHY_MEMORY_TIERS
```

### 1.2 记忆目录结构

```
.khy/
├── memory/                    # 核心记忆目录
│   ├── MEMORY.md              # 记忆索引
│   ├── .distill.json          # 蒸馏配置
│   ├── .archive/              # 归档目录
│   ├── user/                  # 用户记忆
│   ├── feedback/              # 反馈记忆
│   ├── project/               # 项目记忆
│   └── reference/             # 参考记忆
├── growth/                    # 成长数据
│   ├── agent_memory.json      # 代理记忆
│   ├── user_preferences.json  # 用户偏好
│   └── ...                    # 其他成长数据
├── skills/                    # 学习缓存
│   └── .archive/              # 归档目录
├── training/                  # 训练数据
│   ├── interaction_records.jsonl
│   └── interaction_quarantine.jsonl
└── sessions/                  # 会话数据
    └── .archive/              # 归档目录
```

---

## 2. 日常使用

### 2.1 创建记忆

**快速记忆**：
```bash
# 简单记忆
/remember 用户偏好简洁回复

# 带类型记忆
/remember --type feedback --name "回复风格" --desc "用户偏好简洁回复" 用户希望回复简洁，避免过多解释
```

**结构化记忆**：
```bash
# 用户记忆
/remember --type user --name "工作习惯" --desc "用户工作习惯" 习惯先写测试再写代码，使用 TDD 开发方式

# 项目记忆
/remember --type project --name "代码规范" --desc "项目代码规范" 使用 2 空格缩进，单引号，分号结尾

# 参考记忆
/remember --type reference --name "API 文档" --desc "关键 API 文档链接" OpenAI API: https://platform.openai.com/docs
```

### 2.2 查看记忆

**查看记忆索引**：
```bash
# 查看记忆索引
cat .khy/memory/MEMORY.md

# 查看记忆状态
khy memory project
```

**查看特定记忆**：
```bash
# 查看用户记忆
ls .khy/memory/user/

# 查看项目记忆
ls .khy/memory/project/

# 查看反馈记忆
ls .khy/memory/feedback/
```

### 2.3 更新记忆

**更新现有记忆**：
```bash
# 方法 1：使用命令覆盖
/remember --type feedback --name "回复风格" --desc "新的回复风格偏好" 更新后的内容

# 方法 2：直接编辑文件
vim .khy/memory/feedback_response-style_*.md
```

**更新记忆索引**：
```bash
# 重建记忆索引
khy memory project
```

---

## 3. 记忆管理

### 3.1 记忆蒸馏

**查看蒸馏报告**：
```bash
# 预览蒸馏
khy memory distill

# 执行蒸馏
khy memory distill --apply
```

**查看已归档记忆**：
```bash
# 查看归档列表
khy memory distill archived

# 恢复特定记忆
khy memory distill restore [filename]

# 恢复所有记忆
khy memory distill restore
```

### 3.2 记忆清空

**预览清空**：
```bash
# 查看清空预览
npm run memory:clear

# 按优先级预览
npm run memory:clear:p0  # 核心记忆
npm run memory:clear:p1  # 学习缓存
npm run memory:clear:p2  # 会话数据
```

**执行清空**：
```bash
# 执行清空
npm run memory:clear:apply

# 按优先级清空
npm run memory:clear:p0 --apply
npm run memory:clear:p1 --apply
npm run memory:clear:p2 --apply
```

### 3.3 记忆恢复

**查看可恢复记忆**：
```bash
# 列出可恢复记忆
npm run memory:restore

# 查看特定类型记忆
npm run memory:restore:type feedback
```

**恢复记忆**：
```bash
# 恢复特定文件
npm run memory:restore:file <filename>

# 恢复所有记忆
npm run memory:restore:all
```

---

## 4. 高级功能

### 4.1 环境变量配置

**记忆系统开关**：
```bash
# 禁用记忆系统
export KHY_DISABLE_MEMORY=1

# 启用记忆系统
unset KHY_DISABLE_MEMORY
```

**记忆功能配置**：
```bash
# 启用/禁用主动回忆
export KHY_PROACTIVE_MEMORY=on  # 或 off

# 启用/禁用分层模型
export KHY_MEMORY_TIERS=on  # 或 off

# 启用/禁用自动捕获
export KHY_MEMORY_TRIGGER=on  # 或 off

# 配置自动蒸馏模式
export KHY_MEMORY_DISTILL_AUTO=report  # 或 archive
```

### 4.2 记忆检索

**自动检索**：
- 系统会自动在对话中检索相关记忆
- 主动回忆会根据上下文推荐记忆
- 会话启动时会填充相关记忆

**手动检索**：
```bash
# 查看记忆索引
cat .khy/memory/MEMORY.md

# 搜索记忆内容
grep -r "关键词" .khy/memory/
```

### 4.3 记忆备份

**备份记忆**：
```bash
# 备份整个记忆目录
cp -r .khy/memory/ /backup/memory_$(date +%Y%m%d)/

# 备份成长数据
cp -r .khy/growth/ /backup/growth_$(date +%Y%m%d)/
```

**恢复备份**：
```bash
# 恢复记忆目录
cp -r /backup/memory_20260904/ .khy/memory/

# 恢复成长数据
cp -r /backup/growth_20260904/ .khy/growth/
```

---

## 5. 最佳实践

### 5.1 记忆创建

1. **及时性**：在信息新鲜时立即记录
2. **准确性**：确保记忆内容正确无误
3. **结构化**：使用标准格式和分类
4. **描述性**：提供清晰的名称和摘要

### 5.2 记忆管理

1. **定期维护**：每月检查记忆系统
2. **及时更新**：发现过时信息立即更新
3. **避免冗余**：合并相似记忆，删除重复
4. **质量保证**：运行蒸馏清理低质量记忆

### 5.3 记忆使用

1. **主动回忆**：在需要时主动检索记忆
2. **上下文关联**：将相关记忆关联起来
3. **验证准确性**：使用前验证记忆是否仍然有效
4. **反馈改进**：根据使用效果改进记忆策略

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

**问题 4：索引损坏**
```bash
# 重建记忆索引
khy memory project
```

### 6.2 紧急恢复

**步骤 1：停止记忆系统**
```bash
export KHY_DISABLE_MEMORY=1
```

**步骤 2：从备份恢复**
```bash
cp -r /backup/.khy/memory/* .khy/memory/
```

**步骤 3：重建索引**
```bash
khy memory project
```

**步骤 4：重新启用记忆系统**
```bash
unset KHY_DISABLE_MEMORY
```

---

## 7. 监控和维护

### 7.1 健康检查

```bash
# 检查记忆系统状态
khy memory project

# 查看蒸馏报告
khy memory distill

# 检查记忆目录大小
du -sh .khy/memory/
```

### 7.2 性能监控

**监控指标**：
- 记忆总数：各类型记忆文件数量
- 健康评分：蒸馏算法计算的记忆质量分数
- 老化率：过期记忆占比
- 重复率：重复记忆占比

**监控命令**：
```bash
# 查看记忆统计
find .khy/memory -name "*.md" | wc -l

# 查看各类型记忆数量
find .khy/memory/user -name "*.md" | wc -l
find .khy/memory/feedback -name "*.md" | wc -l
find .khy/memory/project -name "*.md" | wc -l
find .khy/memory/reference -name "*.md" | wc -l
```

### 7.3 定期维护

**每月维护**：
```bash
# 1. 运行记忆蒸馏
khy memory distill --apply

# 2. 检查记忆质量
khy memory project

# 3. 备份记忆
cp -r .khy/memory/ /backup/memory_$(date +%Y%m%d)/

# 4. 清理过期记忆
npm run memory:clear:p2 --apply
```

---

## 8. 相关文档

- [记忆系统标准规范](./[DESIGN-MEM-001]%20记忆系统标准规范.md)
- [记忆时机指南](./[DESIGN-MEM-002]%20记忆时机指南.md)
- [记忆模板库](./[DESIGN-MEM-003]%20记忆模板库.md)
- [记忆快速参考卡](./[DESIGN-MEM-004]%20记忆快速参考卡.md)

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，提供完整使用指南 |

---

*本指南由 khy-os 记忆系统设计团队维护*