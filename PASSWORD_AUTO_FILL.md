# 密码自动填充解决方案

## 🎯 问题分析

**当前情况：**
- 后端服务未运行
- 默认管理员账号未创建
- 凭据文件不存在：`H:\.khy-project\credentials\default-admin.json`

**因此：** 无法实现完全自动登录（没有凭据可读取）

---

## ✅ 解决方案（3 选 1）

### 方案 1：启动后端服务（推荐）⭐⭐⭐⭐⭐

**一次性操作，永久有效！**

```powershell
cd C:\khy-os\services\backend
npm run dev
```

**效果：**
1. 后端自动创建默认管理员账号
2. 生成凭据文件
3. 以后 CLI 可以自动读取并登录
4. 完全自动化，无需输入任何内容

**操作步骤：**
```powershell
# 1. 打开 PowerShell 窗口 1
cd C:\khy-os\services\backend
npm run dev

# 等待看到："默认管理员已创建"

# 2. 打开 PowerShell 窗口 2
khy

# 现在会自动登录！
```

---

### 方案 2：设置环境变量（简单快速）⭐⭐⭐⭐

设置一次，每次自动使用：

```powershell
# 设置默认密码（永久）
[Environment]::SetEnvironmentVariable("KHY_DEFAULT_PASSWORD", "你的密码", "User")

# 或临时设置（当前会话）
$env:KHY_DEFAULT_PASSWORD="你的密码"
```

然后启动：
```powershell
khy
```

CLI 会自动使用环境变量中的密码尝试登录。

---

### 方案 3：修改 CLI 跳过认证（仅本地开发）⭐⭐⭐

**仅适用于本地开发环境！**

```powershell
$env:KHY_CLI_SKIP_AUTH="1"
khy
```

直接跳过登录，立即进入 CLI。

⚠️ **不推荐**：跳过认证可能导致某些功能受限。

---

## 🎯 我的建议

**推荐：方案 1（启动后端）**

**原因：**
1. ✅ 后端运行一次后，凭据永久保存
2. ✅ 以后每次 `khy` 都能自动登录
3. ✅ Web 界面也能使用
4. ✅ 所有功能完整可用

**具体步骤：**

```powershell
# 终端 1：启动后端（保持运行）
cd C:\khy-os\services\backend
npm run dev

# 等待看到类似信息：
# "✓ 默认管理员已创建"
# "✓ 凭据已保存到: H:\.khy-project\credentials\default-admin.json"

# 终端 2：测试 CLI
khy

# 现在应该自动登录了！
```

---

## 📝 技术实现说明

我会修改代码支持以下自动登录方式：

1. **从凭据文件读取**（需要后端运行过）
2. **从环境变量读取**（`KHY_DEFAULT_PASSWORD`）
3. **跳过认证模式**（`KHY_CLI_SKIP_AUTH=1`）

让我现在就实现这些功能...
