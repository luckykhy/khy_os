# 🌉 Khy-OS IDE 桥接模式指南

## ✨ 什么是 IDE 桥接模式？

Khy-OS 可以**桥接**到你正在使用的 IDE（Claude Code、Cursor、Windsurf 等），直接使用 IDE 中的 AI 配额和模型，**无需额外的 API Key**！

---

## 🎯 支持的 IDE

| IDE | 适配器 | 自动检测 | 优势 |
|-----|--------|----------|------|
| **Claude Code** | claudeAdapter | ✅ | 直接使用 Claude Code CLI |
| **Cursor** | cursorAdapter | ✅ | 自动检测 Cursor token |
| **Windsurf** | windsurfAdapter | ✅ | 自动检测 Windsurf token |
| **VS Code** | vscodeAdapter | ✅ | 使用 Copilot 配额 |

---

## 🚀 快速启用（推荐）

### ⭐ 方法 1：使用 Claude Code 桥接

**前提**：你正在使用 Claude Code（当前会话就是！）

**步骤**：

1. **配置已完成！**
   ```
   .env 文件已自动设置：
   GATEWAY_CLAUDE_ENABLED=true
   ```

2. **重启 khy**
   ```powershell
   khy
   ```

3. **测试连接**
   ```
   在 CLI 中输入: gateway test claude
   ```

4. **查看可用模型**
   ```
   在 CLI 中输入: /model
   ```

**工作原理**：
- Khy-OS 会自动检测 `claude` CLI 命令
- 直接调用 Claude Code CLI 进行对话
- 使用你的 Claude Code 账号配额
- 无需额外配置 API Key

---

### 方法 2：使用 Cursor 桥接

**前提**：你安装了 Cursor IDE

**步骤**：

1. **启用 Cursor 适配器**
   ```
   编辑: C:\khy-os\services\backend\.env
   
   设置为:
   GATEWAY_CURSOR_ENABLED=true
   ```

2. **重启 khy**
   ```powershell
   khy
   ```

3. **测试连接**
   ```
   在 CLI 中输入: gateway test cursor
   ```

**工作原理**：
- 自动检测 Cursor 的 token 文件
- 使用 Cursor 的 API 端点
- 共享 Cursor 的配额

---

### 方法 3：使用 Windsurf 桥接

**前提**：你安装了 Windsurf IDE

**步骤**：

1. **启用 Windsurf 适配器**
   ```
   编辑: C:\khy-os\services\backend\.env
   
   设置为:
   GATEWAY_WINDSURF_ENABLED=true
   ```

2. **重启 khy**
   ```powershell
   khy
   ```

3. **测试连接**
   ```
   在 CLI 中输入: gateway test windsurf
   ```

**工作原理**：
- 自动检测 Windsurf 的 token
- 使用 Windsurf 的 API（Codeium）
- 包括 Windsurf Cascade 模型

---

## 📋 完整配置示例

### 示例 1：只用 Claude Code（推荐）

```bash
# .env 配置

JWT_SECRET=34ff771b061323df6ff10040573a5378db4cd51eddf7c2438557e501c2b5f913

# 快速失败模式
KHY_MODEL_QUICK_FAIL=true
KHY_MODEL_PROBE_TIMEOUT_MS=2000

# 启用 Claude Code 桥接
GATEWAY_CLAUDE_ENABLED=true

# 禁用其他
GATEWAY_CURSOR_ENABLED=false
GATEWAY_WINDSURF_ENABLED=false
GATEWAY_OPENAI_ENABLED=false
GATEWAY_OLLAMA_ENABLED=false
```

### 示例 2：同时使用多个 IDE

```bash
# 启用多个 IDE 桥接
GATEWAY_CLAUDE_ENABLED=true    # Claude Code
GATEWAY_CURSOR_ENABLED=true    # Cursor
GATEWAY_WINDSURF_ENABLED=true  # Windsurf

# /model 菜单会显示所有可用的模型
```

---

## ✅ 验证桥接是否成功

### 1. 检查网关状态

```bash
# 在 khy CLI 中
gateway status
```

**预期输出**：
```
✓ claude - 可用 (CLI bridge)
  模型: claude-3.5-sonnet, claude-3-opus
```

### 2. 测试单个适配器

```bash
gateway test claude
```

**预期输出**：
```
✓ 连通性: 成功 (123ms)
✓ 生成测试: 成功
模型响应: Hello! I'm Claude...
```

### 3. 查看可用模型

```bash
/model
```

**预期输出**：
```
选择模型（上下方向键选择，回车确认）:

  ● Claude 3.5 Sonnet (claude)
    Claude 3 Opus (claude)
    Claude 3 Haiku (claude)
    ────────────
    返回
```

---

## 🔍 故障排查

### Claude Code 桥接问题

**问题 1：找不到 claude 命令**

```powershell
# 检查 claude CLI 是否安装
where claude

# 或手动测试
claude --version
```

**解决方案**：
- 确保 Claude Code 已安装
- 确保 `claude` 命令在 PATH 中
- 在 Claude Code 中至少运行过一次对话

---

**问题 2：claude 命令存在但桥接失败**

```bash
# 在 khy CLI 中查看详细错误
gateway test claude --verbose
```

**可能原因**：
- Claude Code 未登录
- Token 过期
- 网络问题

**解决方案**：
```powershell
# 重新登录 Claude Code
claude auth login
```

---

### Cursor 桥接问题

**问题：找不到 Cursor token**

**Token 位置**：
- Windows: `%APPDATA%\Cursor\User\globalStorage\`
- macOS: `~/Library/Application Support/Cursor/`
- Linux: `~/.config/Cursor/`

**解决方案**：
1. 打开 Cursor IDE
2. 确保已登录
3. 尝试使用一次 AI 功能
4. 重启 khy

---

### Windsurf 桥接问题

**问题：找不到 Windsurf token**

**解决方案**：
1. 打开 Windsurf IDE
2. 确保已登录 Codeium
3. 使用一次 Cascade 功能
4. 重启 khy

---

## 💡 使用建议

### 推荐配置

**个人开发**：
- 主力：Claude Code 桥接（免费额度）
- 备用：Ollama（本地免费）

**团队开发**：
- Claude Code 桥接（每个成员用自己的账号）
- Cursor 桥接（如果团队用 Cursor）

**生产环境**：
- OpenAI API（稳定可靠）
- Claude API（代码任务）

### 优先级建议

当启用多个适配器时，建议设置首选：

```bash
# 设置首选适配器
GATEWAY_PREFERRED_ADAPTER=claude

# 设置首选模型
GATEWAY_PREFERRED_MODEL=claude-3.5-sonnet

# 严格模式（只使用首选，不回退）
GATEWAY_PREFERRED_STRICT=true
```

---

## 📊 对比：桥接 vs API

| 特性 | IDE 桥接 | API 直连 |
|------|----------|----------|
| **配置难度** | 简单（自动检测） | 中等（需要 API Key） |
| **费用** | 免费（用 IDE 配额） | 付费（按使用量） |
| **速度** | 取决于 IDE | 直连更快 |
| **稳定性** | 取决于 IDE | 更稳定 |
| **模型选择** | 受限于 IDE | 完整访问 |

---

## 🎉 现在开始使用

**你的环境**：正在使用 Claude Code

**推荐配置**：已自动启用 Claude Code 桥接

**下一步**：

```powershell
# 1. 重启 khy
khy

# 2. 检查状态
gateway status

# 3. 选择模型
/model

# 4. 开始使用！
你好
```

现在 Khy-OS 会通过 Claude Code 桥接来处理你的请求，使用你的 Claude 配额！
