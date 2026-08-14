# 🧪 /model 菜单测试指南

## 🚀 快速测试方法

### 方法 1：快速失败模式（推荐）

这会跳过所有耗时的初始化步骤：

```powershell
$env:KHY_MODEL_QUICK_FAIL="true"
$env:KHY_MODEL_PROBE_TIMEOUT_MS="2000"
$env:KHY_MODEL_OVERALL_TIMEOUT_MS="15000"
$env:KHY_MODEL_BUILD_TIMEOUT_MS="20000"
khy
```

然后在 CLI 中输入 `/model`

---

### 方法 2：查看卡在哪一步

正常启动，观察进度提示：

```powershell
khy
```

然后输入 `/model`，你会看到这些提示信息：
```
正在初始化网关...
正在同步 switch-center...
正在初始化网关适配器...
正在刷新适配器...
正在获取适配器状态...
检测各通道连通性（快速模式，单通道超时 4s，总超时 30s）...
```

**如果卡住了，记住最后显示的是哪一步！**

---

## 🔍 根据卡住的步骤定位问题

### 卡在 "正在初始化网关..."
**问题**：gateway 模块加载失败
**解决**：
```powershell
cd C:\khy-os\services\backend
node -e "console.log(require('./src/services/gateway/aiGateway'))"
```

### 卡在 "正在同步 switch-center..."
**问题**：网络连接问题或 switch-center 配置错误
**解决**：使用快速失败模式跳过

### 卡在 "正在初始化网关适配器..."
**问题**：某个适配器初始化超时
**解决**：禁用有问题的适配器

### 卡在 "检测各通道连通性..."
**问题**：适配器探测超时
**解决**：降低超时时间或禁用适配器

---

## ⚙️ 推荐配置

创建或编辑 `C:\khy-os\services\backend\.env`：

```bash
# 快速失败模式（跳过耗时初始化）
KHY_MODEL_QUICK_FAIL=true

# 激进的超时设置
KHY_MODEL_PROBE_TIMEOUT_MS=2000
KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS=3000
KHY_MODEL_OVERALL_TIMEOUT_MS=15000
KHY_MODEL_BUILD_TIMEOUT_MS=20000

# 禁用不使用的适配器
GATEWAY_OLLAMA_ENABLED=false
GATEWAY_OPENAI_ENABLED=false
GATEWAY_CLAUDE_ENABLED=false
GATEWAY_WINDSURF_ENABLED=false
GATEWAY_DEEPSEEK_ENABLED=false
GATEWAY_LOCALLLM_ENABLED=false

# 只启用你需要的（举例）
# GATEWAY_OPENAI_ENABLED=true
```

---

## 🛠️ 替代方案

如果 `/model` 菜单一直有问题，使用命令行替代：

### 查看所有通道状态
```bash
gateway status
```

### 直接配置网关
```bash
gateway config
```

### 手动设置首选模型
编辑 `.env` 文件：
```bash
GATEWAY_PREFERRED_ADAPTER=openai
GATEWAY_PREFERRED_MODEL=gpt-4
GATEWAY_PREFERRED_STRICT=true
```

---

## 📊 诊断命令

### 检查当前环境变量
```powershell
cd C:\khy-os\services\backend
node -e "const env = process.env; Object.keys(env).filter(k => k.includes('GATEWAY') || k.includes('KHY_MODEL')).forEach(k => console.log(k + '=' + env[k]))"
```

### 测试单个适配器
```bash
# 在 khy CLI 中
gateway test openai
gateway test claude
gateway test ollama
```

### 查看网关日志
```bash
# 在 khy CLI 中
gateway status --verbose
```

---

## ✅ 测试清单

- [ ] CLI 可以正常启动（不卡死）
- [ ] 输入 `/model` 后有进度提示
- [ ] 在 45 秒内看到模型列表或超时错误
- [ ] 可以选择模型（如果有可用适配器）
- [ ] 选择后配置正确保存到 `.env`

---

## 💡 下一步

1. 先用**快速失败模式**测试
2. 如果还是卡住，告诉我卡在哪个步骤
3. 如果完全不工作，使用 `gateway status` 替代方案
