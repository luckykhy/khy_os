# Khy-OS 便携式使用指南

## 🎯 跨电脑快速部署方案

### 方案 1：使用便携式安装脚本（推荐）

当您将项目复制到新电脑后：

1. **双击运行**：`portable-setup.bat`
2. **重启 PowerShell**
3. **测试**：`khy --version`

✅ 脚本会自动检测当前项目位置并配置全局命令！

---

### 方案 2：不配置全局命令，直接使用

将 `khy.bat` 文件复制到任何位置：

```bash
# 在项目目录
.\khy.bat

# 或复制到桌面、U盘等任何位置双击使用
```

---

## 🚀 启动完整服务（包含自动登录）

### 问题：为什么 CLI 没有自动登录？

**原因**：CLI 是轻量模式，不启动完整后端服务。

**解决方案**：使用以下启动方式

### 启动方式 1：后端服务（API + 认证）

```bash
.\start-backend.bat
```

或手动：
```bash
cd services\backend
npm run dev
```

### 启动方式 2：完整系统（后端 + 前端）

```bash
.\start-all.bat
```

这会自动打开两个窗口：
- Backend: http://localhost:5000
- Frontend: http://localhost:3000

然后访问前端即可使用完整功能！

---

## 📋 命令对比

| 命令 | 用途 | 是否需要后端 | 是否自动登录 |
|------|------|------------|------------|
| `khy` / `.\khy.bat` | CLI 模式 | ❌ 否 | ❌ 否 |
| `.\start-backend.bat` | 启动后端 | ✅ 是 | ✅ 是 |
| `.\start-all.bat` | 完整系统 | ✅ 是 | ✅ 是 |

---

## 🔧 跨电脑部署流程

### 第一次部署到新电脑：

1. **复制整个项目文件夹**到新电脑
2. **安装 Node.js**（如果新电脑没有）
3. **双击运行**：`portable-setup.bat`
4. **重启 PowerShell**
5. **测试**：`khy --version`

### 后续使用：

- 只用 CLI：直接运行 `khy`
- 完整功能：运行 `.\start-all.bat`

---

## 💡 最佳实践

### 日常使用 CLI：
```bash
khy gateway status
khy ai "你好"
```

### 需要 Web 界面：
```bash
.\start-all.bat
# 然后访问 http://localhost:3000
```

### 快速测试：
```bash
.\khy.bat --help
```

---

现在您有了完整的便携式解决方案！
