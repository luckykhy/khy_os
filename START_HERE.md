# ✅ Khy-OS 部署完成 - 使用指南

## 🎯 最简单的启动方式

### 方式 1：直接使用 CLI（无需 Python）

```bash
cd C:\khy-os
node services\backend\bin\khy.js
```

或使用我创建的快捷脚本：
```bash
cd C:\khy-os
.\khy-cli.bat
```

### 方式 2：启动完整服务（前后端）

**终端 1 - 后端**：
```bash
cd C:\khy-os\services\backend
npm run dev
```

**终端 2 - 前端**：
```bash
cd C:\khy-os\apps\ai-frontend
npm run dev
```

然后访问：http://localhost:3000

---

## 📋 关于 `khy` 命令

目前直接使用 `khy` 命令**不可用**，但您有以下选择：

### ✅ 已验证可用
- ✅ `node services\backend\bin\khy.js` - 直接运行 CLI
- ✅ `.\khy-cli.bat` - 我为您创建的快捷脚本
- ✅ `npm run dev` - 启动开发服务器
- ✅ `npm run cli` - 在 backend 目录下启动 CLI

### 🔧 如需全局 `khy` 命令

**选项 1：安装 Python 后使用 pip**
```bash
# 1. 安装 Python 3.8+ (勾选 Add to PATH)
# 2. 运行
cd C:\khy-os
pip install -e .
# 然后可以全局使用 khy 命令
```

**选项 2：创建 PowerShell 别名（推荐）**
```powershell
# 编辑 PowerShell 配置
notepad $PROFILE

# 添加这一行
function khy { node C:\khy-os\services\backend\bin\khy.js $args }

# 保存后重启 PowerShell
# 现在可以直接使用 khy 命令
```

---

## 📊 当前项目状态

- ✅ Git 仓库已初始化
- ✅ 后端依赖已安装（42 个包）
- ✅ 前端依赖已安装（202 个包）
- ✅ Node.js CLI 可用（v1.1.9）
- ✅ 所有源码完整（5,733 个文件）
- ⚠️ Python 未配置（如需 khy.bat 需安装）

---

## 🚀 推荐使用流程

1. **开发前后端应用**：
   ```bash
   cd C:\khy-os\services\backend && npm run dev
   cd C:\khy-os\apps\ai-frontend && npm run dev
   ```

2. **使用 CLI 工具**：
   ```bash
   cd C:\khy-os
   .\khy-cli.bat
   ```

3. **查看帮助**：
   ```bash
   node services\backend\bin\khy.js --help
   ```

---

项目已完全部署就绪，可以开始使用了！
