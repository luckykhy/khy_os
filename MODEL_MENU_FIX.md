# 🔧 /model 菜单卡死问题分析与解决

## 🔍 问题根源

`/model` 菜单卡死的原因：

1. **探测所有 AI 适配器**：第 233 行开始探测所有启用的通道
2. **超时时间过长**：
   - 默认探测超时：8 秒（可配置为 4-25 秒）
   - 生成探测超时：25 秒
   - 如果有 3 个适配器，总计可能需要 75 秒
3. **网络连接问题**：适配器无法连接时会一直等待直到超时
4. **同步等待**：`Promise.all(testPromises)` 在第 267 行同步等待所有探测完成

---

## ✅ 临时解决方案

### 方案 1：使用环境变量加速（推荐）

在使用 `khy` 命令前设置更短的超时：

```powershell
$env:KHY_MODEL_PROBE_TIMEOUT_MS="2000"
$env:KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS="3000"
khy
```

然后输入 `/model`，探测时间会从 25 秒缩短到 3 秒。

### 方案 2：禁用不需要的适配器

编辑 `.env` 文件，禁用不使用的 AI 适配器：

```bash
# 只启用需要的适配器
GATEWAY_OLLAMA_ENABLED=false
GATEWAY_OPENAI_ENABLED=false
GATEWAY_CLAUDE_ENABLED=false
GATEWAY_WINDSURF_ENABLED=false
```

### 方案 3：使用 gateway status 查看通道状态

不使用 `/model` 菜单，改用命令：

```bash
# 查看所有通道状态（更快）
gateway status

# 直接设置模型（不需要探测）
gateway config
```

---

## 🚀 永久修复方案

修改 `gatewayModelChoices.js` 添加整体超时保护：

```javascript
// 在 buildGatewayModelChoices 函数开始处添加
const OVERALL_TIMEOUT_MS = 30000; // 整体超时 30 秒
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('模型探测超时')), OVERALL_TIMEOUT_MS)
);

try {
  await Promise.race([
    Promise.all(testPromises),
    timeoutPromise
  ]);
} catch (err) {
  onError('部分通道探测超时，显示当前可用结果');
  // 继续使用已完成的探测结果
}
```

---

## 📋 排查步骤

### 1. 检查哪些适配器已启用

```bash
cd C:\khy-os\services\backend
node -e "console.log(Object.entries(process.env).filter(([k]) => k.includes('GATEWAY')).map(([k,v]) => k + '=' + v).join('\n'))"
```

### 2. 手动测试单个适配器

```bash
# 在 khy REPL 中
gateway test ollama
gateway test openai
gateway test claude
```

### 3. 查看网关配置

```bash
# 在 khy REPL 中
gateway status
```

---

## 💡 推荐配置

在 `C:\khy-os\services\backend\.env` 添加：

```bash
# 快速探测配置
KHY_MODEL_PROBE_TIMEOUT_MS=2000
KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS=3000

# 禁用不使用的适配器
GATEWAY_OLLAMA_ENABLED=false
GATEWAY_OPENAI_ENABLED=false
GATEWAY_CLAUDE_ENABLED=false
```

---

## 🎯 现在可以做什么

1. **快速测试**：运行 `$env:KHY_MODEL_PROBE_TIMEOUT_MS="2000"; khy` 然后尝试 `/model`
2. **检查配置**：查看 `.env` 文件，禁用不需要的适配器
3. **使用替代命令**：用 `gateway status` 和 `gateway config` 代替 `/model`

哪种方案最适合你？
