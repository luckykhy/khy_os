# 如何使用 khy 命令启动 Khy-OS

## ⚠️ 当前状态

直接使用 `khy` 命令目前**不可用**，原因：
1. Python 未在系统 PATH 中（khy.bat 需要 Python 3.8+）
2. 项目未全局安装（只是源码部署）

---

## ✅ 可用的启动方式

### 方式 1：直接使用 Node.js CLI（推荐，无需 Python）

```bash
cd C:\khy-os
node services\backend\bin\khy.js
```

这会直接启动 Khy-OS CLI，无需 Python！

### 方式 2：启动后端服务

```bash
cd C:\khy-os\services\backend
npm run dev
```

### 方式 3：启动前端管理界面

```bash
# 终端 1
cd C:\khy-os\services\backend
npm run dev

# 终端 2
cd C:\khy-os\apps\ai-frontend
npm run dev
```

然后访问：http://localhost:3000

### 方式 4：修复 khy.bat（需要安装 Python）

如果想使用 `.\khy.bat` 启动，需要先安装 Python：

1. **安装 Python 3.8+**：
   - 访问：https://www.python.org/downloads/
   - 下载并安装（**勾选 "Add Python to PATH"**）

2. **验证 Python**：
   ```bash
   python --version
   ```

3. **使用 khy.bat**：
   ```bash
   cd C:\khy-os
   .\khy.bat
   ```

### 方式 5：通过 pip 全局安装（需要 Python）

```bash
cd C:\khy-os
pip install -e .
```

安装后可以在任何位置使用：
```bash
khy
```

### 方式 6：通过 npm 全局安装

```bash
cd C:\khy-os\packaging\npm
npm install -g .
```

---

## 🎯 推荐方案

**如果不想安装 Python，最简单的方法是**：

### 创建便捷命令别名

#### PowerShell（推荐）

在 PowerShell 配置文件中添加别名：

```powershell
# 打开配置文件
notepad $PROFILE

# 添加以下内容
function khy { node C:\khy-os\services\backend\bin\khy.js $args }
```

保存后，重新打开 PowerShell，就可以直接使用 `khy` 命令了！

#### 或创建批处理文件到 PATH

```bash
# 创建一个新的 khy-cli.bat
cd C:\khy-os
```

我来为您创建这个文件：
