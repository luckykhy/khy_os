# 🤖 AI 模型配置指南

## ❌ 为什么模型选择不可用？

**原因**：没有启用任何 AI 适配器

Khy-OS 支持多种 AI 服务，但需要先配置才能使用：

- OpenAI（GPT-4, GPT-3.5）
- Claude（Claude 3.5, Claude 3）
- DeepSeek（国内服务）
- Ollama（本地免费）
- LocalLLM（本地）
- Windsurf（IDE 集成）

---

## 🚀 快速配置方法

### 方法 1：启用 Ollama（本地免费，推荐）

**优点**：
- ✅ 完全免费
- ✅ 本地运行，隐私安全
- ✅ 无需 API Key
- ✅ 支持多种开源模型

**步骤**：

1. **下载安装 Ollama**
   ```
   访问: https://ollama.com/download
   下载 Windows 版本并安装
   ```

2. **下载模型**
   ```powershell
   # 下载小型模型（推荐）
   ollama pull llama3.2
   
   # 或下载更大的模型
   ollama pull llama3.2:70b
   ollama pull qwen2.5
   ```

3. **编辑配置文件**
   ```
   打开: C:\khy-os\services\backend\.env
   
   修改:
   GATEWAY_OLLAMA_ENABLED=true
   ```

4. **重启 khy**
   ```powershell
   khy
   ```

5. **选择模型**
   ```
   在 CLI 中输入: /model
   ```

---

### 方法 2：使用 OpenAI API

**前提**：需要 OpenAI API Key

**步骤**：

1. **获取 API Key**
   ```
   访问: https://platform.openai.com/api-keys
   创建一个新的 API Key
   ```

2. **编辑配置文件**
   ```
   打开: C:\khy-os\services\backend\.env
   
   添加:
   GATEWAY_OPENAI_ENABLED=true
   GATEWAY_OPENAI_API_KEY=sk-your-key-here
   ```

3. **重启 khy**
   ```powershell
   khy
   ```

4. **选择模型**
   ```
   在 CLI 中输入: /model
   ```

---

### 方法 3：使用 Claude API

**前提**：需要 Anthropic API Key

**步骤**：

1. **获取 API Key**
   ```
   访问: https://console.anthropic.com/account/keys
   创建一个新的 API Key
   ```

2. **编辑配置文件**
   ```
   打开: C:\khy-os\services\backend\.env
   
   添加:
   GATEWAY_CLAUDE_ENABLED=true
   GATEWAY_CLAUDE_API_KEY=sk-ant-your-key-here
   ```

3. **重启 khy**
   ```powershell
   khy
   ```

4. **选择模型**
   ```
   在 CLI 中输入: /model
   ```

---

## 📝 完整 .env 配置示例

### 示例 1：只用 Ollama（本地免费）

```bash
JWT_SECRET=34ff771b061323df6ff10040573a5378db4cd51eddf7c2438557e501c2b5f913

# 快速失败模式
KHY_MODEL_QUICK_FAIL=true
KHY_MODEL_PROBE_TIMEOUT_MS=2000

# 启用 Ollama
GATEWAY_OLLAMA_ENABLED=true
GATEWAY_OLLAMA_BASE_URL=http://localhost:11434

# 禁用其他
GATEWAY_OPENAI_ENABLED=false
GATEWAY_CLAUDE_ENABLED=false
GATEWAY_DEEPSEEK_ENABLED=false
```

### 示例 2：使用 OpenAI

```bash
JWT_SECRET=34ff771b061323df6ff10040573a5378db4cd51eddf7c2438557e501c2b5f913

# 快速失败模式
KHY_MODEL_QUICK_FAIL=true

# 启用 OpenAI
GATEWAY_OPENAI_ENABLED=true
GATEWAY_OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx
GATEWAY_OPENAI_BASE_URL=https://api.openai.com/v1

# 禁用其他
GATEWAY_OLLAMA_ENABLED=false
GATEWAY_CLAUDE_ENABLED=false
```

### 示例 3：同时使用多个服务

```bash
JWT_SECRET=34ff771b061323df6ff10040573a5378db4cd51eddf7c2438557e501c2b5f913

# 快速失败模式
KHY_MODEL_QUICK_FAIL=true

# 启用 Ollama（本地）
GATEWAY_OLLAMA_ENABLED=true

# 启用 OpenAI（云端）
GATEWAY_OPENAI_ENABLED=true
GATEWAY_OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx

# 启用 Claude（云端）
GATEWAY_CLAUDE_ENABLED=true
GATEWAY_CLAUDE_API_KEY=sk-ant-xxxxxxxxxxxxx
```

---

## ✅ 验证配置

### 1. 启动 khy
```powershell
khy
```

### 2. 检查网关状态
```
在 CLI 中输入: gateway status
```

你应该看到：
```
✓ ollama - 可用 (http://localhost:11434)
```

### 3. 选择模型
```
在 CLI 中输入: /model
```

现在应该能看到可用的模型列表了！

---

## 🔧 故障排查

### Ollama 相关问题

**问题：Ollama 显示不可用**

检查：
```powershell
# 1. 检查 Ollama 是否运行
ollama list

# 2. 测试连接
curl http://localhost:11434/api/tags

# 3. 重启 Ollama 服务
# Windows: 从任务管理器重启 Ollama
```

### OpenAI 相关问题

**问题：OpenAI 连接失败**

检查：
1. API Key 是否正确
2. 是否有余额
3. 网络是否可以访问 OpenAI

测试：
```powershell
curl https://api.openai.com/v1/models -H "Authorization: Bearer YOUR_API_KEY"
```

---

## 💡 推荐配置

### 个人开发者
**推荐**：Ollama（本地免费）
- 模型：llama3.2, qwen2.5
- 成本：免费
- 速度：快（本地）

### 生产环境
**推荐**：OpenAI + Claude
- OpenAI：通用任务
- Claude：代码和分析
- 成本：按需付费

### 高隐私需求
**推荐**：Ollama（本地）
- 数据不出本地
- 完全私有

---

## 📚 相关命令

```bash
# 查看网关状态
gateway status

# 选择模型
/model

# 配置网关
gateway config

# 测试适配器
gateway test ollama
gateway test openai
gateway test claude
```

---

现在根据你的需求选择一个方法配置吧！推荐先试试 Ollama（完全免费）。
