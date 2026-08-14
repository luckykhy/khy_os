# Khy-OS 密码自动填充完整指南

## ✅ 已实现的功能

我已经修改了代码，支持**完全自动登录**！

### 自动登录方式（按优先级）：

1. **从凭据文件读取**（最优）
   - 文件位置：`H:\.khy-project\credentials\default-admin.json`
   - 自动读取用户名和密码
   - 完全自动，无需输入

2. **从环境变量读取**
   - 设置 `KHY_DEFAULT_PASSWORD` 环境变量
   - 用户名自动检测，密码从环境变量读取
   - 适合临时使用

3. **手动输入**（回退方案）
   - 用户名自动预填充
   - 需要手动输入密码

---

## 🎯 **一次性设置（推荐）**

### **第一步：生成凭据文件**

**双击运行这个文件：**
```
📄 first-time-setup.bat
```

**或者在 PowerShell 中：**
```powershell
cd C:\khy-os
.\first-time-setup.bat
```

**效果：**
- 创建默认管理员账号
- 生成凭据文件
- 以后每次 `khy` 都自动登录

---

### **第二步：测试自动登录**

```powershell
khy
```

**现在应该显示：**
```
检测到凭据文件，尝试自动登录...
✓ 自动登录成功! 欢迎回来, mfplg075
```

**完全自动，无需任何输入！** 🎉

---

## 🔧 **替代方案：使用环境变量**

如果不想运行 setup，可以设置环境变量：

### **临时设置（当前会话）：**
```powershell
$env:KHY_DEFAULT_PASSWORD="你的密码"
khy
```

### **永久设置（所有会话）：**
```powershell
[Environment]::SetEnvironmentVariable("KHY_DEFAULT_PASSWORD", "你的密码", "User")

# 重启 PowerShell 后
khy
```

---

## 📋 **工作流程对比**

### **设置前（需要输入）：**
```
khy
用户名: (mfplg075) █  ← 按 Enter
密码: ********        ← 手动输入
```

### **设置后（完全自动）：**
```
khy
检测到凭据文件，尝试自动登录...
✓ 自动登录成功! 欢迎回来, mfplg075

> █  ← 直接进入 CLI！
```

---

## 🌍 **跨电脑使用**

将项目复制到新电脑后：

1. **配置全局命令**：`portable-setup.bat`
2. **生成凭据**：`first-time-setup.bat`
3. **开始使用**：`khy`（自动登录）

---

## 🎯 **推荐操作流程**

```powershell
# 1. 一次性设置（只需运行一次）
cd C:\khy-os
.\first-time-setup.bat

# 等待完成...

# 2. 测试自动登录
khy

# 应该自动登录了！
```

---

## ⚙️ **技术说明**

### 代码修改：

1. **自动检测凭据文件**
   - 路径：`dataHome/credentials/default-admin.json`
   - 自动读取并尝试登录

2. **支持环境变量**
   - `KHY_DEFAULT_PASSWORD`
   - 与系统用户名结合自动登录

3. **智能回退**
   - 自动登录失败 → 显示登录表单
   - 用户名已预填充
   - 用户体验不受影响

---

## 🎉 **现在请执行**

**双击运行：**
```
📄 C:\khy-os\first-time-setup.bat
```

**然后测试：**
```powershell
khy
```

**期待看到自动登录成功！** 🚀
