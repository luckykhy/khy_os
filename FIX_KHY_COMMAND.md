# Khy-OS 全局命令修复方案

## 当前状态
- ❌ Python 未正确安装（仅有 Windows Store 占位符）
- ✅ Node.js 已安装并可用
- ✅ 项目已完整部署

---

## 🚀 推荐修复方案（3 选 1）

### 方案 1：PowerShell 别名（最简单，推荐）⭐

**无需安装 Python，立即可用！**

#### 步骤：

1. **打开 PowerShell**（以管理员身份或普通用户都可以）

2. **创建配置文件**（如果不存在）：
```powershell
if (!(Test-Path -Path $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force
}
```

3. **编辑配置文件**：
```powershell
notepad $PROFILE
```

4. **添加以下内容**（复制粘贴）：
```powershell
# Khy-OS 全局命令
function khy {
    node C:\khy-os\services\backend\bin\khy.js $args
}

# 快捷别名
Set-Alias -Name khyos -Value khy
```

5. **保存并关闭** notepad

6. **重新加载配置**：
```powershell
. $PROFILE
```

7. **测试**：
```powershell
khy --version
khy --help
```

✅ **完成！现在可以在任何位置使用 `khy` 命令了！**

---

### 方案 2：安装真实的 Python + pip 安装

#### 步骤：

1. **下载 Python**：
   - 访问：https://www.python.org/downloads/
   - 下载最新的 Python 3.12 或 3.11

2. **安装 Python**：
   - ⚠️ **重要**：勾选 **"Add Python to PATH"**
   - 点击 "Install Now"

3. **验证安装**：
```bash
python --version
pip --version
```

4. **全局安装 Khy-OS**：
```bash
cd C:\khy-os
pip install -e .
```

5. **测试**：
```bash
khy --version
khy --help
```

✅ **完成！现在可以在任何位置使用 `khy` 命令了！**

---

### 方案 3：添加批处理到系统 PATH

#### 步骤：

1. **创建全局脚本目录**（如果不存在）：
```powershell
mkdir C:\bin
```

2. **复制启动脚本**：
```powershell
copy C:\khy-os\khy-cli.bat C:\bin\khy.bat
```

3. **添加到 PATH**：
   - 按 `Win + X` 选择"系统"
   - 点击"高级系统设置"
   - 点击"环境变量"
   - 在"用户变量"或"系统变量"中找到 `Path`
   - 点击"编辑"
   - 点击"新建"
   - 输入：`C:\bin`
   - 点击"确定"保存所有窗口

4. **重启终端并测试**：
```bash
khy --version
```

✅ **完成！现在可以在任何位置使用 `khy` 命令了！**

---

## 📊 方案对比

| 方案 | 难度 | 速度 | 推荐度 |
|------|------|------|--------|
| **PowerShell 别名** | ⭐ 简单 | ⚡ 1分钟 | ⭐⭐⭐⭐⭐ 强烈推荐 |
| **安装 Python** | ⭐⭐ 中等 | 🕐 5分钟 | ⭐⭐⭐⭐ 推荐 |
| **添加到 PATH** | ⭐⭐ 中等 | 🕐 3分钟 | ⭐⭐⭐ 可选 |

---

## ⚡ 快速修复命令（PowerShell）

如果您使用 PowerShell，直接运行这些命令：

```powershell
# 创建配置文件（如果不存在）
if (!(Test-Path -Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }

# 添加 khy 函数
Add-Content -Path $PROFILE -Value "`n# Khy-OS global command`nfunction khy { node C:\khy-os\services\backend\bin\khy.js `$args }"

# 重新加载
. $PROFILE

# 测试
khy --version
```

---

## 🎯 我的推荐

**使用方案 1（PowerShell 别名）**，因为：
- ✅ 最简单快速
- ✅ 无需安装额外软件
- ✅ 立即生效
- ✅ 不影响系统环境

---

## 📝 验证修复成功

修复后，在任何目录运行：

```bash
khy --version        # 应该显示：1.1.9
khy --help           # 显示帮助信息
khy gateway status   # 测试实际命令
```

---

需要我帮您执行哪个方案？
