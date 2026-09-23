# [DESIGN-OUT-001] 输出结构规范

> 本文档定义 khy-os 项目的输出结构标准，包括构建输出、日志、配置等。

---

## 1. 输出概述

### 1.1 设计原则

1. **分离原则**：源代码与输出分离
2. **可预测**：输出位置可预测
3. **可清理**：输出可以安全清理
4. **安全性**：敏感信息不泄露

### 1.2 输出分类

| 类别 | 说明 | 位置 |
|------|------|------|
| 构建输出 | 编译/打包产物 | `dist/`, `build/` |
| 日志文件 | 运行时日志 | `logs/`, `.khy/logs/` |
| 临时文件 | 临时数据 | `_tmp/`, `.tmp/` |
| 缓存文件 | 缓存数据 | `.cache/`, `node_modules/.cache/` |

---

## 2. 构建输出结构

### 2.1 前端构建输出

```
apps/ai-frontend/dist/
├── assets/
│   ├── index-*.js
│   ├── index-*.css
│   └── vendor-*.js
├── index.html
└── favicon.ico
```

### 2.2 后端构建输出

```
services/backend/dist/
├── index.js
├── routes/
├── services/
└── utils/
```

### 2.3 Python 构建输出

```
khy_os.egg-info/
├── PKG-INFO
├── SOURCES.txt
├── dependency_links.txt
└── top_level.txt
```

---

## 3. 日志文件结构

### 3.1 日志目录

```
logs/
├── access.log          # 访问日志
├── error.log           # 错误日志
├── combined.log        # 综合日志
└── security.log        # 安全日志
```

### 3.2 日志文件命名

**格式**：`{type}-{date}.log`

**示例**：
```
access-2026-09-04.log
error-2026-09-04.log
combined-2026-09-04.log
```

### 3.3 日志轮转

| 类型 | 轮转频率 | 保留时间 |
|------|---------|---------|
| access | 每日 | 30 天 |
| error | 每日 | 30 天 |
| combined | 每日 | 14 天 |
| security | 每日 | 90 天 |

---

## 4. 运行时数据

### 4.1 .khy 目录

```
.khy/
├── config.json         # 用户配置
├── token_usage.json    # Token 用量
├── conversations/      # 对话记录
├── training_data/      # 训练数据
├── models/             # 模型文件
├── memory/             # 记忆文件
├── growth/             # 成长数据
├── sessions.db         # 会话数据库
├── logs/               # 日志目录
│   ├── app.log
│   └── security.log
├── checkpoints/        # 检查点
└── sync/               # 同步队列
```

### 4.2 数据保护

| 数据类型 | 位置 | Gitignore | 备份 |
|---------|------|-----------|------|
| 用户配置 | `.khy/config.json` | ✅ | ✅ |
| 数据库 | `.khy/sessions.db` | ✅ | ✅ |
| 日志 | `.khy/logs/` | ✅ | ❌ |
| 记忆 | `.khy/memory/` | ✅ | ✅ |
| 模型 | `.khy/models/` | ✅ | ❌ |

---

## 5. 临时文件

### 5.1 临时文件位置

| 类型 | 位置 | 清理策略 |
|------|------|---------|
| 构建缓存 | `node_modules/.cache/` | 构建时清理 |
| 临时扫描 | `_tmp_scan*.js` | 立即清理 |
| 测试数据 | `test-*.db` | 测试后清理 |
| 导出文件 | `exports/` | 定期清理 |

### 5.2 临时文件命名

**格式**：`{_tmp_|}{name}.{ext}`

**示例**：
```
_tmp_scan.js
test-wal-recovery.db
export_20260904.csv
```

---

## 6. .gitignore 配置

### 6.1 必须忽略的文件

```gitignore
# 构建输出
dist/
build/
*.egg-info/

# 依赖
node_modules/

# 日志
logs/
*.log

# 运行时数据
.khy/
.khyos/

# 临时文件
_tmp/
*.tmp
tmp_*

# 测试数据库
test-*.db
test-*.db-shm
test-*.db-wal

# 环境配置
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
```

---

## 7. 构建产物管理

### 7.1 构建命令

```bash
# 前端构建
npm run build

# 后端构建
cd services/backend && npm run build

# Python 构建
python -m build
```

### 7.2 产物验证

```bash
# 验证构建产物
ls -la dist/

# 验证文件完整性
sha256sum dist/*
```

---

## 8. 发布产物

### 8.1 发布结构

```
release/
├── khy-os-1.0.0/
│   ├── bin/              # 可执行文件
│   ├── lib/              # 库文件
│   ├── docs/             # 文档
│   └── config/           # 配置文件
└── khy-os-1.0.0.tar.gz   # 打包文件
```

### 8.2 发布检查清单

- [ ] 版本号已更新
- [ ] 变更日志已更新
- [ ] 所有测试通过
- [ ] 构建成功
- [ ] 文档已更新

---

## 9. 磁盘空间管理

### 9.1 空间预算

| 类型 | 预算 | 说明 |
|------|------|------|
| 源代码 | < 500MB | 包含所有源文件 |
| 构建输出 | < 200MB | 构建产物 |
| 依赖 | < 500MB | node_modules 等 |
| 日志 | < 100MB | 日志文件 |
| 运行时数据 | < 500MB | .khy 等 |

### 9.2 清理策略

```bash
# 清理构建产物
npm run clean

# 清理日志
find logs -name "*.log.*" -mtime +7 -delete

# 清理临时文件
find . -name "_tmp*" -delete
```

---

## 10. 安全注意事项

### 10.1 敏感数据

**禁止提交到版本控制**：
- `.env` 文件
- API Key
- 私钥
- 密码
- 数据库连接字符串

### 10.2 日志安全

**日志中禁止包含**：
- 密码
- Token
- API Key
- 个人信息

### 10.3 构建安全

**构建产物中禁止包含**：
- 源代码映射（生产环境）
- 调试信息
- 测试数据

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义输出结构规范 |

---

*本规范由 khy-os 平台团队维护*